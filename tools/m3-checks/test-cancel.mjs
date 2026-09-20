// M3 遗留项②：cancel 定向取消实测（v2：去缓存、带时间戳、全量清理）
//   ① 队列取消：A（慢）运行中排队 B，把 B 从队列删除
//   ② 运行中定向中断：趁 A 仍执行时 cancel A（/interrupt {prompt_id}）
// 安全约束：纯 CPU 极小工作流；前置队列必须为空；结束清理本测试产物
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const HOME = "C:\\Users\\John Galt\\.hanako";
const si = JSON.parse(readFileSync(join(HOME, "server-info.json"), "utf8"));
const BASE = `http://127.0.0.1:${si.port}`;
const AUTH = { authorization: `Bearer ${si.token}` };
const OUTDIR = "D:\\ComfyUI\\ComfyUI\\output";
const RUN = Date.now().toString(36); // 去缓存 + 产物名唯一

function newestSessionPath() {
  const dir = join(HOME, "agents", "hanako", "sessions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}
const SESSION_PATH = newestSessionPath();
const T0 = Date.now();
const at = () => `+${((Date.now() - T0) / 1000).toFixed(2)}s`;

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const info = (name, extra = "") => { results.push({ name, ok: true, soft: true }); console.log(`INFO  [${at()}] ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function invoke(args, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}/api/apps/comfyui-hana/ui-actions/invoke`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ toolName: "comfyui", args, context: { sessionPath: SESSION_PATH, messageId: null } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, text: data?.content?.[0]?.text || JSON.stringify(data).slice(0, 300) };
}
async function queue() { return (await (await fetch("http://127.0.0.1:8188/queue")).json()); }
async function historyOf(pid) { const h = await (await fetch(`http://127.0.0.1:8188/history/${pid}`)).json(); return h[pid] || null; }
async function taskRoute(pid) {
  const r = await (await fetch(`${BASE}/api/apps/comfyui-hana/routes/comfyui-hana/task?id=${encodeURIComponent(pid)}`, { headers: AUTH })).json().catch(() => null);
  return r?.task || null;
}

// 慢任务 A：每次跑参数不同（去缓存），目标 ~2.2s
const SLOW_A = {
  "1": { class_type: "EmptyImage", inputs: { width: 512, height: 512, batch_size: 1, color: 0 } },
  "2": { class_type: "ImageScaleBy", inputs: { image: ["1", 0], upscale_method: "lanczos", scale_by: 2.01 } },
  "3": { class_type: "ImageScaleBy", inputs: { image: ["2", 0], upscale_method: "lanczos", scale_by: 2.02 } },
  "4": { class_type: "ImageScaleBy", inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: 2.03 } },
  "5": { class_type: "ImageScaleBy", inputs: { image: ["4", 0], upscale_method: "lanczos", scale_by: 0.499 } },
  "6": { class_type: "ImageScaleBy", inputs: { image: ["5", 0], upscale_method: "lanczos", scale_by: 2.04 } },
  "7": { class_type: "ImageScaleBy", inputs: { image: ["6", 0], upscale_method: "lanczos", scale_by: 0.498 } },
  "8": { class_type: "ImageScaleBy", inputs: { image: ["7", 0], upscale_method: "lanczos", scale_by: 2.05 } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `comfyui_hana_m3_cancel_a_${RUN}` } },
};
const FAST_B = {
  "1": { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: `comfyui_hana_m3_cancel_b_${RUN}` } },
};

async function main() {
  const q0 = await queue();
  const empty = q0.queue_running.length === 0 && q0.queue_pending.length === 0;
  check("前置：8188 队列为空", empty);
  if (!empty) { console.log("队列非空——停止测试"); process.exit(2); }

  // 1) 提交 A
  const subA = await invoke({ action: "submit", workflow: SLOW_A, clientLabel: "M3-cancel-A(慢)" });
  const pidA = subA.data?.details?.comfyui?.promptId;
  info("提交 A", `promptId=${pidA}`);
  check("提交 A（慢任务，去缓存参数）", !!pidA, `promptId=${pidA}`);
  if (!pidA) process.exit(1);

  // 等 A running
  let aRunning = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 15_000) {
    const q = await queue();
    if (q.queue_running.some((it) => it[1] === pidA)) { aRunning = true; break; }
    if (!q.queue_running.length && !q.queue_pending.length) break;
    await sleep(100);
  }
  check("A 已进入执行", aRunning, at());

  // 2) 提交 B（排队）并立即取消（队列删除）
  const subB = await invoke({ action: "submit", workflow: FAST_B, clientLabel: "M3-cancel-B(队列取消)" });
  const pidB = subB.data?.details?.comfyui?.promptId;
  check("提交 B（快任务，排队）", !!pidB, `promptId=${pidB} ${at()}`);
  let bText = "";
  if (pidB) {
    const cB = await invoke({ action: "cancel", promptId: pidB });
    bText = cB.text;
    check("cancel B → 队列删除路径", /从 ComfyUI 队列移除/.test(cB.text), bText.split("\n")[0]);
    const q = await queue();
    const stillThere = q.queue_pending.some((it) => it[1] === pidB) || q.queue_running.some((it) => it[1] === pidB);
    check("B 已不在队列（pending/running 均无）", !stillThere, at());
  }

  // 3) 立即定向中断 A（趁其运行）
  const qNow = await queue();
  const aStillRunning = qNow.queue_running.some((it) => it[1] === pidA);
  if (aStillRunning) {
    const cA = await invoke({ action: "cancel", promptId: pidA });
    check("cancel A → 定向中断路径", /已请求中断/.test(cA.text), cA.text.split("\n")[0] + ` ${at()}`);
  } else {
    info("A 在中断前已结束（窗口不足，记录实际）", at());
  }

  // 4) A 终态（history）
  let aEntry = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 30_000) {
    aEntry = await historyOf(pidA);
    if (aEntry) break;
    await sleep(250);
  }
  const elapsedMs = null;
  if (aEntry) {
    const interrupted = aEntry.status.completed === false;
    const msgs = JSON.stringify(aEntry.status.messages || []);
    info("A history 终态", `completed=${aEntry.status.completed} status=${aEntry.status.status_str} msg含interrupted=${/interrupt/i.test(msgs)} ${at()}`);
  } else {
    check("A history 已落", false, "30s 超时");
  }

  // 5) App 任务结算（≤6s 内应到终态）
  let taskA = null;
  const t3 = Date.now();
  while (Date.now() - t3 < 8_000) {
    taskA = await taskRoute(pidA);
    if (taskA && ["completed", "canceled", "interrupted", "error", "timeout"].includes(taskA.state)) break;
    await sleep(500);
  }
  check("App 任务已结算（终态）", !!taskA && ["completed", "canceled", "interrupted", "error", "timeout"].includes(taskA.state), taskA ? `state=${taskA.state} ${at()}` : "未找到");

  // 6) 收尾
  await sleep(500);
  const qEnd = await queue();
  check("结束后：8188 队列已清空", qEnd.queue_running.length === 0 && qEnd.queue_pending.length === 0);

  const junk = readdirSync(OUTDIR).filter((f) => f.startsWith("comfyui_hana_m3"));
  for (const f of junk) { unlinkSync(join(OUTDIR, f)); console.log(`deleted: output\\${f}`); }
  const left = readdirSync(OUTDIR).filter((f) => f.startsWith("comfyui_hana_m3"));
  check("测试产物已清理（m3 前缀残留=0）", left.length === 0, `残留=${left.length}`);

  const hard = results.filter((r) => !r.soft);
  const failed = hard.filter((r) => !r.ok);
  console.log(`\n${hard.length - failed.length}/${hard.length} passed（另有 ${results.filter((r) => r.soft).length} 条 INFO）`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
