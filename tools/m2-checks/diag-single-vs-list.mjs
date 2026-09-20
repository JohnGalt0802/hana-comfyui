// 聚焦诊断 4：单 id 端点 vs 列表端点（同一记录）
import { spawn } from "node:child_process";
const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39360;
const CLIENT_ID = `m2-focus4-${Math.random().toString(16).slice(2, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--client-id", CLIENT_ID], { stdio: ["ignore", "pipe", "pipe"] });
let rlog = "";
relay.stdout.on("data", (c) => { rlog += c.toString("utf8"); });
relay.stderr.on("data", (c) => { rlog += c.toString("utf8"); });

async function main() {
  while (!rlog.includes("COMFY_RELAY_READY")) await sleep(80);
  let up = false;
  for (let i = 0; i < 25 && !up; i++) { await sleep(120); const st = await (await fetch(`http://127.0.0.1:${PORT}/_relay/status`)).json(); up = st?.events?.connected && st?.events?.lastEventAt != null; }
  const wf = { "1": { class_type: "EmptyImage", inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "comfyui_hana_focus4" } } };
  const sub = await (await fetch(`http://127.0.0.1:${PORT}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }) })).json();
  const pid = sub.prompt_id;
  await sleep(1000);
  const singleUrl = `http://127.0.0.1:${PORT}/_relay/prompts/${encodeURIComponent(pid)}`;
  console.log("single URL:", singleUrl.replace(pid, pid.slice(0, 8) + "…"));
  const singleRes = await fetch(singleUrl);
  const singleText = await singleRes.text();
  console.log("single status:", singleRes.status, "body(前 200):", singleText.slice(0, 200));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/_relay/prompts`)).json();
  const inList = [...(list.active || []), ...(list.recent || [])].find((r) => r.promptId === pid);
  console.log("list 命中:", inList ? JSON.stringify({ state: inList.state, events: (inList.events || []).map((e) => e.type) }) : "null");
  relay.kill("SIGKILL");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
