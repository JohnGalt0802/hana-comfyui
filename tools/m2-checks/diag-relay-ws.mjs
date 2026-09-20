// 聚焦诊断：中继的 /ws 订阅到底看到了什么
import { spawn } from "node:child_process";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39341;
const CLIENT_ID = "m2-focus";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--client-id", CLIENT_ID], { stdio: ["ignore", "pipe", "pipe"] });
let rlog = "";
relay.stdout.on("data", (c) => { rlog += c.toString("utf8"); });
relay.stderr.on("data", (c) => { rlog += c.toString("utf8"); });

async function main() {
  while (!rlog.includes("COMFY_RELAY_READY") && rlog.length < 1e6) { if (rlog.includes("COMFY_RELAY_READY")) break; await sleep(100); }
  await sleep(1200);

  const st1 = await (await fetch(`http://127.0.0.1:${PORT}/_relay/status`)).json();
  console.log("status.events =", JSON.stringify(st1.events));
  const p1 = await (await fetch(`http://127.0.0.1:${PORT}/_relay/prompts`)).json();
  console.log("prompts.ws =", JSON.stringify(p1.ws));

  const wf = { "1": { class_type: "EmptyImage", inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "comfyui_hana_focus" } } };
  const sub = await (await fetch(`http://127.0.0.1:${PORT}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }) })).json();
  console.log("submitted:", sub.prompt_id);

  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const p = await (await fetch(`http://127.0.0.1:${PORT}/_relay/prompts`)).json();
    const rec = [...(p.active || []), ...(p.recent || [])].find((r) => r.promptId === sub.prompt_id);
    console.log(`t+${(i + 1) * 500}ms ws=${p.ws.connected} lastEventAt=${p.ws.lastEventAt} tracked=${p.tracked} rec=${rec ? JSON.stringify({ state: rec.state, events: (rec.events || []).map((e) => e.type) }) : "null"}`);
    if (rec && (rec.state === "completed" || rec.state === "error")) break;
  }
  const st2 = await (await fetch(`http://127.0.0.1:${PORT}/_relay/status`)).json();
  console.log("status.events(after) =", JSON.stringify(st2.events));
  console.log("---- relay log ----");
  console.log(rlog.split("\n").filter((l) => /ws|events|订阅|WS/i.test(l)).slice(0, 20).join("\n"));
  relay.kill("SIGKILL");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
