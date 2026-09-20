// 宿主段 V2：经宿主代理路径连 ComfyUI /ws，期望收到 status 消息后正常关闭。
// 用原生握手以携带 Authorization: Bearer（Node 全局 WebSocket 不支持自定义头）。
// 用法: node ws-proxy-test.mjs [--path <代理路径含 /ws>] [--label <标签>]
//   默认从 server-info.json 读 port/token，并从 boot-state 计算代理路径。
import net from "node:net";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const INFO = "C:\\Users\\John Galt\\.hanako\\server-info.json";
const si = JSON.parse(readFileSync(INFO, "utf8"));
const host = "127.0.0.1";
const port = si.port;
const token = si.token;

const args = process.argv.slice(2);
const argVal = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const label = argVal("--label", "proxy");

async function getBootState() {
  const res = await fetch(`http://${host}:${port}/api/apps/comfyui-hana/routes/comfyui-hana/boot-state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
}

function parseFrames(buf) {
  // 解析服务端→客户端帧（未掩码）；返回 [{opcode, payload, total}]
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, hlen = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); hlen = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; const big = buf.readBigUInt64BE(off + 2); if (big > 1048576n) throw new Error("frame too big"); len = Number(big); hlen = 10; }
    let mask = null;
    if (masked) { if (off + hlen + 4 > buf.length) break; mask = buf.subarray(off + hlen, off + hlen + 4); hlen += 4; }
    if (off + hlen + len > buf.length) break;
    let payload = buf.subarray(off + hlen, off + hlen + len);
    if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
    frames.push({ fin, opcode, payload, total: hlen + len });
    off += hlen + len;
  }
  return { frames, consumed: off };
}

function maskedFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(payload);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  return Buffer.concat([header, mask, data]);
}

async function main() {
  let path = argVal("--path");
  if (!path) {
    const boot = await getBootState();
    if (!boot.proxyPrefix) { console.log("FAIL: boot-state 无 proxyPrefix:", JSON.stringify(boot)); process.exit(1); }
    path = `${boot.proxyPrefix}ws`;
    console.log(`boot-state: phase=${boot.phase} service=${JSON.stringify(boot.service)} proxyPrefix=${boot.proxyPrefix}`);
  }
  console.log(`[${label}] 连接 ws://${host}:${port}${path}`);

  const key = crypto.randomBytes(16).toString("base64");
  const head =
    `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`;

  const start = Date.now();
  const result = await new Promise((resolve) => {
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    let handshake = false;
    let statusMsg = null;
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} resolve({ ok: false, why: "timeout(10s)" }); }, 10000);
    sock.on("connect", () => sock.write(head));
    sock.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, why: "socket error: " + e.message }); });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ ok: !!statusMsg, why: statusMsg ? `status in ${Date.now() - start}ms` : "closed without status", status: statusMsg });
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshake) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const headText = buf.subarray(0, idx + 4).toString("latin1");
        buf = buf.subarray(idx + 4);
        const statusLine = headText.split("\r\n", 1)[0];
        console.log(`[${label}] 握手响应: ${statusLine}`);
        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          console.log(`[${label}] 非 101，响应头:\n${headText.slice(0, 600)}`);
          try { sock.destroy(); } catch {}
          return;
        }
        handshake = true;
      }
      try {
        const { frames } = parseFrames(buf);
        for (const f of frames) {
          if (f.opcode === 1) {
            const text = f.payload.toString("utf8");
            console.log(`[${label}] 文本消息(${f.payload.length}B): ${text.slice(0, 220)}`);
            try { const j = JSON.parse(text); if (j.type === "status" && !statusMsg) { statusMsg = j; } } catch {}
          } else if (f.opcode === 2) {
            console.log(`[${label}] 二进制消息(${f.payload.length}B)`);
          } else if (f.opcode === 8) {
            console.log(`[${label}] 收到 close 帧`);
            try { sock.end(); } catch {}
          }
        }
        if (statusMsg && sock.writable) {
          // 正常关闭：发 close 帧（1000）
          const closePayload = Buffer.alloc(2); closePayload.writeUInt16BE(1000, 0);
          sock.write(maskedFrame(8, closePayload));
          setTimeout(() => { try { sock.destroy(); } catch {} }, 300);
        }
      } catch (e) {
        console.log(`[${label}] 帧解析失败: ${e.message}`);
      }
    });
  });

  if (result.ok) { console.log(`PASS [${label}]：收到 status 消息（${result.why}）`); process.exit(0); }
  console.log(`FAIL [${label}]：${result.why}`); process.exit(1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
