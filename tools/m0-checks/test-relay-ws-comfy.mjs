// M0 中继本地实测 · 经中继连真实 ComfyUI /ws，期望收到 status 消息后正常关闭
// 用法：node test-relay-ws-comfy.mjs <relayPort> [--direct]
import { spawn } from "node:child_process";

const port = Number(process.argv[2] || 39241);
const direct = process.argv.includes("--direct");
const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(url, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const log = [];
    const timer = setTimeout(() => {
      log.push("TIMEOUT(10s) waiting for status message");
      try { ws.close(); } catch {}
      resolve({ ok: false, log });
    }, 10000);
    ws.addEventListener("open", () => log.push("open"));
    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "(binary blob)";
      let type = "?";
      try { type = JSON.parse(data).type; } catch {}
      log.push(`message type=${type} len=${String(data).length}`);
      if (type === "status") {
        clearTimeout(timer);
        log.push(`status payload ≈ ${String(data).slice(0, 160)}`);
        ws.close(1000, "done");
        resolve({ ok: true, log });
      }
    });
    ws.addEventListener("close", (ev) => { log.push(`closed code=${ev.code} clean=${ev.wasClean}`); });
    ws.addEventListener("error", (e) => { log.push(`error ${e && e.message ? e.message : e}`); });
  });
}

async function main() {
  let relay = null;
  let base;
  if (direct) {
    base = "ws://127.0.0.1:8188/ws";
  } else {
    relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(port), "--backend", "127.0.0.1:8188"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    relay.stdout.on("data", (c) => { out += c.toString("utf8"); });
    relay.stderr.on("data", (c) => { out += c.toString("utf8"); });
    const t0 = Date.now();
    while (!out.includes("COMFY_RELAY_READY") && Date.now() - t0 < 8000) await sleep(100);
    if (!out.includes("COMFY_RELAY_READY")) { console.log("relay NOT READY"); process.exit(2); }
    base = `ws://127.0.0.1:${port}/ws`;
  }
  console.log(`connecting ${base}${direct ? " (direct)" : ""}`);
  const r = await once(base, direct ? "direct" : "relay");
  for (const line of r.log) console.log("  ·", line);
  if (!direct) {
    await sleep(400);
    relay.kill("SIGKILL");
  }
  console.log(r.ok ? (direct ? "DIRECT PASS：8188 /ws 可收到 status" : "RELAY PASS：经中继 /ws 收到 status 消息并关闭") : "FAIL");
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
