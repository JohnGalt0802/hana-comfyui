// 聚焦诊断 3：循环复刻 e2e 节奏，抓“事件缺失”失败现场（打印 wsEvents 计数）
import { spawn } from "node:child_process";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneRun(idx) {
  const PORT = 39350 + idx;
  const CLIENT_ID = `m2-focus3-${idx}-${Math.random().toString(16).slice(2, 8)}`;
  const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--client-id", CLIENT_ID], { stdio: ["ignore", "pipe", "pipe"] });
  let rlog = "";
  relay.stdout.on("data", (c) => { rlog += c.toString("utf8"); });
  relay.stderr.on("data", (c) => { rlog += c.toString("utf8"); });
  const base = `http://127.0.0.1:${PORT}`;
  const jget = async (p) => (await (await fetch(`${base}${p}`)).json());

  while (!rlog.includes("COMFY_RELAY_READY")) await sleep(80);
  let up = false;
  for (let i = 0; i < 25 && !up; i++) {
    await sleep(120);
    try { const st = await jget("/_relay/status"); up = st?.events?.connected && st?.events?.lastEventAt != null; } catch {}
  }
  const wf = { "1": { class_type: "EmptyImage", inputs: { width: 32, height: 32, batch_size: 1, color: 0 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: `comfyui_hana_focus3_${idx}` } } };
  const sub = await (await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }) })).json();
  let rec = null;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const p = await jget(`/_relay/prompts/${encodeURIComponent(sub.prompt_id)}`);
    if (p?.found) { rec = p.record; if (rec.state === "completed" || rec.state === "error") break; }
  }
  const st = await jget("/_relay/status");
  await sleep(200);
  const st2 = await jget("/_relay/status");
  console.log(`run#${idx} connected_at_submit=${up} rec=${rec ? JSON.stringify({ state: rec.state, events: (rec.events || []).map((e) => e.type) }) : "null"}`);
  console.log(`   wsEvents(after completion)= ${JSON.stringify(st2.events)}`);
  relay.kill("SIGKILL");
  await sleep(300);
  // 等旧连接彻底关闭再跑下一轮（避免同名/时序干扰）
}

async function main() {
  for (let i = 1; i <= 4; i++) await oneRun(i);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
