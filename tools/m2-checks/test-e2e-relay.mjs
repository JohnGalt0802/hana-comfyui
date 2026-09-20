// M2 端到端（中继级）：极小纯 CPU 工作流 submit → 进度事件跟踪 → 完成 → 产物落盘
// 用法: node test-e2e-relay.mjs [--port 39321]
// 前置：8188 队列必须为空（否则拒绝运行）；不启动/停止任何用户服务。
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = Number((process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 0) || 39331);
const KEY = "m2-e2e-key-0123456789abcdef";
const CLIENT_ID = `m2-e2e-${Math.random().toString(16).slice(2, 10)}`; // 每次跑唯一（避免同名 sid 快速重连的旧连接清理竞态）
const OUTDIR = "D:\\HanakoWorks\\ComfyUI\\tools\\m2-checks\\logs";
mkdirSync(OUTDIR, { recursive: true });

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => `http://127.0.0.1:${PORT}`;

async function direct(path) {
  const r = await fetch(`http://127.0.0.1:8188${path}`);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function relayGet(path) {
  const r = await fetch(`${base()}${path}`);
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function relayPost(path, body) {
  const r = await fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-comfy-relay-key": KEY }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}

function startRelay() {
  const child = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--control-key", KEY, "--client-id", CLIENT_ID], { stdio: ["ignore", "pipe", "pipe"] });
  child.__log = "";
  child.stdout.on("data", (c) => { child.__log += c.toString("utf8"); });
  child.stderr.on("data", (c) => { child.__log += c.toString("utf8"); });
  return child;
}

const WORKFLOW = {
  "1": { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "comfyui_hana_m2" } },
};

async function main() {
  // 0) 前置：队列必须为空
  const q0 = await direct("/queue");
  const q0empty = Array.isArray(q0.data?.queue_running) && q0.data.queue_running.length === 0 &&
                  Array.isArray(q0.data?.queue_pending) && q0.data.queue_pending.length === 0;
  check("前置：8188 队列为空", q0empty, `running=${q0.data?.queue_running?.length} pending=${q0.data?.queue_pending?.length}`);
  if (!q0empty) { console.log("队列非空——拒绝提交（不做任何事）"); process.exit(2); }

  const relay = startRelay();
  const t0 = Date.now();
  while (!relay.__log.includes("COMFY_RELAY_READY") && Date.now() - t0 < 8000) await sleep(100);
  check("中继就绪", relay.__log.includes("COMFY_RELAY_READY"));
  // 等 /ws 事件订阅真正连上并已收到至少一条广播（避免竞态：订阅未就绪时提交会漏事件）
  let wsUp = false;
  for (let i = 0; i < 25 && !wsUp; i++) {
    await sleep(200);
    try {
      const st = await relayGet("/_relay/status");
      wsUp = st.data?.events?.connected === true && st.data?.events?.lastEventAt != null;
    } catch { /* 再试 */ }
  }
  check("事件订阅已连接（提交前，且已收到广播）", wsUp);

  // 1) 提交（经中继 → 8188）
  const submitRes = await relayPost("/prompt", { prompt: WORKFLOW, client_id: CLIENT_ID });
  const promptId = submitRes.data?.prompt_id;
  check("提交成功（prompt_id）", submitRes.status === 200 && typeof promptId === "string", `prompt_id=${promptId}`);
  if (!promptId) { relay.kill("SIGKILL"); process.exit(1); }

  // 2) 跟踪：事件缓存 + history，直到完成
  let final = null;
  let sawEvents = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const ev = await relayGet(`/_relay/prompts/${encodeURIComponent(promptId)}`);
    if (ev.data?.found) {
      const r = ev.data.record;
      if (!sawEvents || (r.events || []).length > (sawEvents.events || []).length) sawEvents = r;
      if (r.state === "completed" || r.state === "error" || r.state === "interrupted") { final = { kind: r.state, rec: r }; break; }
    }
    const h = await relayGet(`/_relay/history?id=${encodeURIComponent(promptId)}`);
    const entry = Array.isArray(h.data?.entries) ? h.data.entries[0] : null;
    if (entry && (entry.completed || entry.status === "error")) { final = { kind: entry.completed ? "completed" : "error", rec: sawEvents, entry }; break; }
    await sleep(400);
  }
  check("任务在 180s 内抵达终态", !!final, final ? `state=${final.kind}` : "超时");
  if (final) {
    // 终态后给事件缓存最多 3s 补齐（竞态：极快/全缓存任务可能 history 先完成，随后事件才落缓存）
    for (let i = 0; i < 10 && !(sawEvents && (sawEvents.events || []).length >= 2); i++) {
      await sleep(300);
      const evG = await relayGet(`/_relay/prompts/${encodeURIComponent(promptId)}`);
      if (evG.data?.found) {
        const r = evG.data.record;
        if (!sawEvents || (r.events || []).length > (sawEvents.events || []).length) sawEvents = r;
      }
    }
    if (!(sawEvents && (sawEvents.events || []).length >= 2)) {
      // 失败现场转储（诊断用，不影响结果）
      const stDump = await relayGet("/_relay/status");
      const pDump = await relayGet("/_relay/prompts");
      console.log("  [诊断] status.events =", JSON.stringify(stDump.data?.events || null));
      console.log("  [诊断] prompts.active =", JSON.stringify((pDump.data?.active || []).map((r) => ({ id: r.promptId.slice(0, 8), st: r.state, ev: (r.events || []).length }))));
      console.log("  [诊断] prompts.recent =", JSON.stringify((pDump.data?.recent || []).map((r) => ({ id: r.promptId.slice(0, 8), st: r.state, ev: (r.events || []).length }))));
      console.log("  [诊断] relay 日志尾部：");
      console.log(relay.__log.trim().split("\n").slice(-8).map((l) => "    " + l).join("\n"));
    }
    check("事件缓存捕获执行事件", !!sawEvents && (sawEvents.events || []).length >= 2,
      `events=${(sawEvents?.events || []).map((e) => e.type).join(",")}`);
    // 无论事件路径还是 history 路径收尾，都从 history 验证产物（权威）
    const hFinal = await relayGet(`/_relay/history?id=${encodeURIComponent(promptId)}`);
    const entry = Array.isArray(hFinal.data?.entries) ? hFinal.data.entries[0] : null;
    const outputs = (entry?.outputs) || [];
    check("history 产出产物记录", outputs.length >= 1 && /comfyui_hana_m2/.test(outputs[0]?.filename || ""), JSON.stringify(outputs[0] || null));
    if (outputs[0]) {
      const p = `D:\\ComfyUI\\ComfyUI\\output\\${outputs[0].subfolder ? outputs[0].subfolder + "\\" : ""}${outputs[0].filename}`;
      const st = await relayPost("/_relay/fs/stat", { path: p });
      check("产物文件真实落盘（size>0）", st.data?.stat?.exists === true && st.data.stat.size > 0, `${p} (${st.data?.stat?.size} B)`);
      console.log(`产物路径：${p}`);
    }
  }

  // 3) 完成后队列回到空
  await sleep(500);
  const q1 = await direct("/queue");
  const q1empty = Array.isArray(q1.data?.queue_running) && q1.data.queue_running.length === 0 &&
                  Array.isArray(q1.data?.queue_pending) && q1.data.queue_pending.length === 0;
  check("完成后：8188 队列已清空", q1empty, `running=${q1.data?.queue_running?.length} pending=${q1.data?.queue_pending?.length}`);

  relay.kill("SIGKILL");
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
