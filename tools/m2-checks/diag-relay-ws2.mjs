// 聚焦诊断 2：连接后立刻提交（复刻 e2e 节奏），观察事件是否到达
import { spawn } from "node:child_process";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39342;
const CLIENT_ID = `m2-focus2-${Math.random().toString(16).slice(2, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--client-id", CLIENT_ID], { stdio: ["ignore", "pipe", "pipe"] });
let rlog = "";
relay.stdout.on("data", (c) => { rlog += c.toString("utf8"); });
relay.stderr.on("data", (c) => { rlog += c.toString("utf8"); });

async function main() {
  while (!rlog.includes("COMFY_RELAY_READY")) await sleep(100);
  // 与 e2e 相同：轮询 status 直到 connected
  let up = false;
  for (let i = 0; i < 25 && !up; i++) {
    await sleep(200);
    const st = await (await fetch(`http://127.0.0.1:${PORT}/_relay/status`)).json();
    up = st?.events?.connected === true;
  }
  console.log("connected =", up, "（clientId =", CLIENT_ID, "）");
  // 立刻提交
  const wf = { "1": { class_type: "EmptyImage", inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "comfyui_hana_focus2" } } };
  const sub = await (await fetch(`http://127.0.0.1:${PORT}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }) })).json();
  console.log("submitted:", sub.prompt_id);
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    const p = await (await fetch(`http://127.0.0.1:${PORT}/_relay/prompts`)).json();
    const rec = [...(p.active || []), ...(p.recent || [])].find((r) => r.promptId === sub.prompt_id);
    console.log(`t+${(i + 1) * 400}ms ws=${p.ws.connected} lastEventAt=${p.ws.lastEventAt} rec=${rec ? JSON.stringify({ state: rec.state, events: (rec.events || []).map((e) => e.type) }) : "null"}`);
  }
  console.log("---- relay log（全部） ----");
  console.log(rlog.trim().split("\n").slice(0, 30).join("\n"));
  relay.kill("SIGKILL");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
