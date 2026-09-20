// M2 宿主段实测：经 ui-actions/invoke（按钮通道）驱动 comfyui 工具全动作
// 用法: node host-stage.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const HOME = "C:\\Users\\John Galt\\.hanako";
const si = JSON.parse(readFileSync(join(HOME, "server-info.json"), "utf8"));
const BASE = `http://127.0.0.1:${si.port}`;
const AUTH = { authorization: `Bearer ${si.token}` };

// 找一个真实会话路径（invoke 需要）
function newestSessionPath() {
  const dir = join(HOME, "agents", "hanako", "sessions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}
const SESSION_PATH = newestSessionPath();

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function invoke(args, timeoutMs = 120_000) {
  const res = await fetch(`${BASE}/api/apps/comfyui-hana/ui-actions/invoke`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ toolName: "comfyui", args, context: { sessionPath: SESSION_PATH, messageId: null } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const textOf = (r) => (r.data?.content?.[0]?.text) || r.data?.error || JSON.stringify(r.data).slice(0, 400);
async function getRoute(path) {
  const res = await fetch(`${BASE}${path}`, { headers: AUTH });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function postRoute(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const MIN_WF = {
  "1": { class_type: "EmptyImage", inputs: { width: 48, height: 48, batch_size: 1, color: 0 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "comfyui_hana_m2_host" } },
};
const UI_WF = {
  last_node_id: 2, last_link_id: 1, version: 0.4,
  nodes: [
    { id: 1, type: "EmptyImage", mode: 0, inputs: [], widgets_values: [48, 48, 1, 0], title: "空图" },
    { id: 2, type: "SaveImage", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }], widgets_values: ["comfyui_hana_m2_host_ui"] },
  ],
  links: [[1, 1, 0, 2, 0, "IMAGE"]],
};

async function main() {
  console.log(`会话路径：${SESSION_PATH}`);

  // 0) 队列前置检查（直连 8188）
  const q0 = await (await fetch("http://127.0.0.1:8188/queue")).json();
  const qEmpty = q0.queue_running.length === 0 && q0.queue_pending.length === 0;
  check("前置：8188 队列为空", qEmpty);
  if (!qEmpty) { console.log("队列非空——停止测试"); process.exit(2); }

  // 1) status
  const st = await invoke({ action: "status" });
  const stOk = st.status === 200 && /中继/.test(textOf(st)) && /后端/.test(textOf(st));
  check("status（按钮通道）", stOk, `HTTP ${st.status}；${textOf(st).split("\n")[1] || ""}`);
  console.log("  status 文本：\n" + textOf(st).split("\n").map((l) => "    " + l).join("\n"));

  // 2) submit（API 格式）
  const sub = await invoke({ action: "submit", workflow: MIN_WF, clientLabel: "M2 宿主测试-A" });
  const pid = sub.data?.details?.comfyui?.promptId;
  check("submit（API 格式）", sub.status === 200 && typeof pid === "string", `promptId=${pid}`);
  console.log("  submit 文本：\n" + textOf(sub).split("\n").map((l) => "    " + l).join("\n"));
  const card = sub.data?.details?.card;
  check("submit 返回任务卡引用", !!card && /task\.html\?pid=/.test(card.route || ""), card ? card.route : "无");
  if (!pid) { process.exit(1); }

  // 3) 任务卡路由轮询（模拟卡片行为）
  let taskStates = [];
  let taskDone = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const tr = await getRoute(`/api/apps/comfyui-hana/routes/comfyui-hana/task?id=${encodeURIComponent(pid)}`);
    const t = tr.data?.task;
    if (t) {
      if (!taskStates.length || taskStates[taskStates.length - 1] !== t.state) taskStates.push(t.state);
      if (["completed", "error", "interrupted", "canceled", "timeout"].includes(t.state)) { taskDone = t; break; }
    }
    await sleep(1200);
  }
  check("任务卡路由：任务完成", !!taskDone && taskDone.state === "completed", `states=${taskStates.join("→")}`);
  if (taskDone) {
    check("任务卡路由：产物含 viewPath 与 filePath", (taskDone.outputs || []).some((o) => o.viewPath && o.filePath && existsSync(o.filePath)), JSON.stringify((taskDone.outputs || [])[0] || null));
  }

  // 4) result
  const resr = await invoke({ action: "result", promptId: pid });
  const resOut = resr.data?.details?.comfyui?.outputs || [];
  check("result 取产物（含本地路径）", resr.status === 200 && resOut.length >= 1 && resOut[0].filePath && existsSync(resOut[0].filePath), resOut[0]?.filePath || "无");
  console.log("  result 文本：\n" + textOf(resr).split("\n").map((l) => "    " + l).join("\n"));

  // 5) query（单任务 + 列表）
  const q1 = await invoke({ action: "query", promptId: pid });
  check("query（promptId）", /状态/.test(textOf(q1)), textOf(q1).split("\n")[1] || "");
  const q2 = await invoke({ action: "query", list: true });
  check("query（列表）", /任务/.test(textOf(q2)), "");
  console.log("  query 列表文本：\n" + textOf(q2).split("\n").slice(0, 8).map((l) => "    " + l).join("\n"));

  // 6) workflows：列表 + 取不存在
  const w1 = await invoke({ action: "workflows" });
  check("workflows 列表", w1.status === 200 && /userdata\/workflows/.test(textOf(w1)), textOf(w1).split("\n")[0]);
  const w2 = await invoke({ action: "workflows", name: "不存在的模板.json" });
  check("workflows 取不存在 → 明确报错", /找不到/.test(textOf(w2)), textOf(w2).slice(0, 120));

  // 7) submit {template} 不存在 → 明确报错
  const t1 = await invoke({ action: "submit", workflow: { template: "不存在.json" } });
  check("submit {template} 不存在 → 明确报错", /找不到|userdata/.test(textOf(t1)), textOf(t1).slice(0, 140));

  // 8) submit UI 格式（转换器 E2E）
  const sub2 = await invoke({ action: "submit", workflow: UI_WF, clientLabel: "M2 宿主测试-B(UI格式)" });
  const pid2 = sub2.data?.details?.comfyui?.promptId;
  check("submit（UI 格式→API 转换）", sub2.status === 200 && typeof pid2 === "string", `promptId=${pid2}`);
  if (pid2) {
    let done2 = null;
    const t1s = Date.now();
    while (Date.now() - t1s < 120_000) {
      const tr = await getRoute(`/api/apps/comfyui-hana/routes/comfyui-hana/task?id=${encodeURIComponent(pid2)}`);
      const t = tr.data?.task;
      if (t && ["completed", "error"].includes(t.state)) { done2 = t; break; }
      await sleep(1200);
    }
    check("UI 格式任务完成", !!done2 && done2.state === "completed", done2 ? done2.state : "timeout");
  }

  // 9) upload（用本仓占位图）
  const upPath = "D:\\HanakoWorks\\ComfyUI\\app\\assets\\icon.png";
  const up = await invoke({ action: "upload", path: upPath });
  const upName = up.data?.details?.comfyui?.name;
  check("upload（图片上传）", up.status === 200 && typeof upName === "string" && upName.length > 0, `name=${upName}`);
  console.log("  upload 文本：" + textOf(up).replace(/\n/g, " / "));

  // 10) cancel 不存在 → 明确语义
  const c1 = await invoke({ action: "cancel", promptId: "00000000-0000-0000-0000-000000000000" });
  check("cancel 不存在 → 明确语义", /不在/.test(textOf(c1)), textOf(c1).slice(0, 120));

  // 11) 完成后队列空
  await sleep(800);
  const qz = await (await fetch("http://127.0.0.1:8188/queue")).json();
  check("完成后：8188 队列已清空", qz.queue_running.length === 0 && qz.queue_pending.length === 0);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
