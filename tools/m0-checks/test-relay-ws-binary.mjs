// M0 中继本地实测 · WS 升级反代"二进制安全 + 头尾缓冲"确定性测试
// 1) 假后端：接受连接 → 回 101（与"早到负载"同一段写出）→ 之后原样回显字节
// 2) 中继 standalone → 假后端
// 3) 裸 TCP 客户端连中继 /ws：验证 101、早到负载完整、二进制双向原样
import net from "node:net";
import { spawn } from "node:child_process";

const FAKE_PORT = 39231;
const RELAY_PORT = 39232;
const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
// 含非法 UTF-8 序列与"像 WS 帧头"的字节：任何按 utf8/按帧解析的实现都会损坏它
const JUNK = Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x8a, 0x00, 0x01, 0x02, 0xc3, 0x28, 0x7f, 0x80]);
const BINARY = Buffer.from([0x81, 0x80, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x10, 0x20, 0xf0, 0x9f, 0x98, 0x80]);

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok, extra }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };

function startFake() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        sock.off("data", onData);
        // 101 与早到负载同段写出（压测中继的"响应头之后同一段里的尾字节"缓冲逻辑）
        sock.write(Buffer.concat([
          Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\nX-Fake: 1\r\n\r\n"),
          JUNK,
        ]));
        sock.on("data", (c) => sock.write(c)); // 原样回显
      };
      sock.on("data", onData);
      sock.on("error", () => {});
    });
    srv.once("error", reject);
    srv.listen(FAKE_PORT, "127.0.0.1", () => resolve(srv));
  });
}

function waitReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("relay ready timeout; out=" + out)), timeoutMs);
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
      if (out.includes("COMFY_RELAY_READY")) { clearTimeout(t); resolve(out); }
    });
    child.stderr.on("data", (c) => { out += c.toString("utf8"); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fake = await startFake();
  console.log(`fake backend listening on ${FAKE_PORT}`);

  const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(RELAY_PORT), "--backend", `127.0.0.1:${FAKE_PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let relayOut = "";
  relay.stdout.on("data", (c) => { relayOut += c.toString("utf8"); });
  relay.stderr.on("data", (c) => { relayOut += c.toString("utf8"); });
  await waitReady(relay, 8000);
  console.log("relay ready");

  const client = net.connect(RELAY_PORT, "127.0.0.1");
  let recv = Buffer.alloc(0);
  let phase = "head";
  let headBytes = Buffer.alloc(0);
  let payload = Buffer.alloc(0);

  const doneClient = new Promise((resolve) => {
    client.on("data", (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      if (phase === "head") {
        const i = recv.indexOf("\r\n\r\n");
        if (i >= 0) {
          headBytes = recv.subarray(0, i + 4);
          payload = recv.subarray(i + 4);
          recv = Buffer.alloc(0);
          phase = "payload";
        }
      } else {
        payload = Buffer.concat([payload, chunk]);
      }
      if (phase === "payload" && payload.length >= JUNK.length + BINARY.length) {
        phase = "done";
        resolve();
      }
    });
    client.on("error", () => resolve());
    setTimeout(resolve, 6000);
  });

  client.write(
    "GET /ws HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
  );
  // 握手就绪后发二进制；服务端回显后即完成
  await sleep(600);
  client.write(BINARY);
  await doneClient;

  const statusLine = headBytes.toString("latin1").split("\r\n", 1)[0];
  check("WS 101 状态行透传", /^HTTP\/1\.1 101/.test(statusLine), statusLine);
  check("101 响应头透传（Upgrade/Sec-WebSocket-Accept）", /upgrade: websocket/i.test(headBytes.toString("latin1")) && /sec-websocket-accept: fake/i.test(headBytes.toString("latin1")));
  const early = payload.subarray(0, JUNK.length);
  check("握手同段'早到负载'字节原样", early.equals(JUNK), `got=${early.toString("hex")} want=${JUNK.toString("hex")}`);
  const echo = payload.subarray(JUNK.length, JUNK.length + BINARY.length);
  check("客户端→后端→客户端二进制往返原样", echo.equals(BINARY), `got=${echo.toString("hex")} want=${BINARY.toString("hex")}`);
  check("中继日志记录了 WS 建立", relayOut.includes("WS /ws 已建立"));

  client.destroy();
  relay.kill("SIGKILL");
  fake.close();
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
