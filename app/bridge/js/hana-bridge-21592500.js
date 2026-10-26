// js/hana-bridge.js — Hana-ComfyUI 桥 · 前端扩展（P1 只读）
//
// 由 ComfyUI 通过 WEB_DIRECTORY 加载，跑在 ComfyUI 自己的源（127.0.0.1:8188）下。
// 这是工作区 iframe 直连 8188（跨源）之后，壳页与中继唯一够得着画布的入口。
//
// 只读阶段暴露 4 个 op：canvas.get / canvas.summary / canvas.prompt / exec.running，
// 外加 api.probe（自检，用于把"推断"变"实测"）。
// 原则：不做任意 JS 执行，只暴露固定 op 表；每次调用都是只读，零副作用。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LOG_TAG = "[hana.bridge]";
const EVT_CALL = "hana_bridge.call";
const PATH_HELLO = "/hana_bridge/hello";
const PATH_RESULT = "/hana_bridge/result";

// 构建标识（诊断口径；2026-09-28 起取代此前的陈旧占位标签，与桥文件名/构建日期对齐——
// api.probe.bridgeBuild / window.__hanaBridge.build 同源）。
const BUILD_TAG = "2026-10-26 hana-bridge-21592500";

const WIDGET_VALUE_MAX = 160;

function clip(s) {
  return s.length > WIDGET_VALUE_MAX ? s.slice(0, WIDGET_VALUE_MAX) + "…" : s;
}

// 注意：新版前端把节点包在响应式 Proxy 里——node.pos 的 constructor.name 是 Float64Array，
// 但 ArrayBuffer.isView() 返回 false（isView 检查内部槽，Proxy 不转发），Array.isArray 同理不可靠。
// 所以只按「能取到两个数字」判，不依赖类型内省。
function toXY(v) {
  if (!v) return null;
  const x = v[0];
  const y = v[1];
  if (typeof x === "number" && typeof y === "number") return [Math.round(x), Math.round(y)];
  if (typeof v.x === "number" && typeof v.y === "number") return [Math.round(v.x), Math.round(v.y)];
  return null;
}

function nodeSummary(n) {
  const widgets = {};
  for (const w of n.widgets || []) {
    const v = w && w.value;
    if (v === undefined || v === null) continue;
    widgets[w.name] = clip(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    mode: n.mode === undefined ? null : n.mode,
    pos: toXY(n.pos),
    size: toXY(n.size),
    inputs: (n.inputs || []).map((i) => i.name),
    outputs: (n.outputs || []).map((o) => o.name),
    widgets,
  };
}

function nodeList(graph) {
  if (graph && Array.isArray(graph._nodes)) return graph._nodes.filter(Boolean);
  if (graph && Array.isArray(graph.nodes)) return graph.nodes.filter(Boolean);
  return [];
}

function findNode(id) {
  const g = app.graph;
  if (g && typeof g.getNodeById === "function") {
    const n = g.getNodeById(Number(id)) || g.getNodeById(id);
    if (n) return n;
  }
  return nodeList(g).find((n) => String(n.id) === String(id)) || null;
}

function graphSummary() {
  const g = app.graph;
  const nodes = nodeList(g);
  // 连线直接从 graph.links 取：比逐节点读 inputs[].link 更直接，
  // 也避开新版前端对 input.link 的 deprecation 警告。
  const links = [];
  const lm = g && g.links;
  if (lm && typeof lm.forEach === "function") {
    lm.forEach((l) => {
      if (!l) return;
      links.push({
        id: l.id,
        from: { node: l.origin_id, slot: l.origin_slot },
        to: { node: l.target_id, slot: l.target_slot },
      });
    });
  }
  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    nodes: nodes.map(nodeSummary),
    links,
  };
}

// ── 变更感知（P2）───────────────────────────────────────────────────────
// 新版 @comfyorg/litegraph 没留可用的变更事件（探查：graph 上只有 onTrigger /
// onConfigure / onConnectionChange，LGraph 原型没有任何 on* 事件），所以不用事件驱动，
// 改用轮询签名比对：定期算一次轻量签名，变了就记一条并递增 revision。
// 间隔 1.5s：口径修正（2026-09-26）—— 对话不是持续态，不需要 500ms 那么密。
// 签名刻意**不含节点位置**——拖动节点不该算“画布变化”，否则噪声太大。
const CHANGE_POLL_MS = 1500;
const CHANGE_KEEP = 50;
let graphRevision = 0;
let lastSignature = null;
// N1修（2026-10-12）：工作流名基线，事件路径与轮询兜底**共用同一判据**（谁先到谁更新，另一方不再重复动作）。
// 只在 historyOnWorkflowSwitch() 内读写（setup 里先建一次基线），别处不再各记一份。
let lastWorkflowName = null;
// 改名迁移判据基线（2026-10-14）：名字变化时比对图签名 —— 同签名 = 改名（保存/另存）→ 迁移旧名历史；
// 不同签名 = 打开另一张图 → 不迁移。只在本函数内读写。
let lastWorkflowGraphSig = null;
let changes = [];

// ── 变更来源标记（P6，2026-10-08）─────────────────────────────────────────
// 甲案口径：变更记录追加 source = "user"（默认：人在画布上的操作）/ "agent"（本桥写 op
// 执行期间）/ "system"（装载 / 重配置的异步窗口内）。只增字段，不改 rev 递增语义
// （app 侧 settle 的强证据依赖它）；工具层过滤留待后续，本期只做桥侧标记。
let changeSource = "user";

// ── 提交来源（2026-10-14）─────────────────────────────────────────────────
// 与 changeSource（画布变更来源）分开 —— 本标志标记「谁发起了这次运行」，只服务提交历史上报。
// canvas.queue（Agent 工具执行）置 "agent"；用户点运行 / Ctrl+Enter 走前端原生 → 保持 "user"。
let historyCommitSource = "user";

// 系统窗：从装载发起（loadGraphData）到 promise settle（或兜底超时）之前，变更记 "system"。
// 兜底给足（大图 configure 可能远超 6s 回传口径；60s 仅防「promise 永不落地」）。
// 单窗语义：新窗接管旧窗（旧窗 done 即失效，不会越权复位）。
const SYSTEM_WINDOW_MAX_MS = 60_000;
let activeSystemWindow = null;
function beginSystemWindow() {
  if (activeSystemWindow) activeSystemWindow.done();
  const win = {
    active: true,
    timer: null,
    done: () => {
      if (!win.active) return;
      win.active = false;
      if (win.timer) { clearTimeout(win.timer); win.timer = null; }
      if (activeSystemWindow === win) activeSystemWindow = null;
      changeSource = "user";
    },
  };
  activeSystemWindow = win;
  changeSource = "system";
  return win;
}
function armSystemWindow(win, promise) {
  win.timer = setTimeout(win.done, SYSTEM_WINDOW_MAX_MS);
  if (promise && typeof promise.then === "function") promise.then(win.done, win.done);
}

// P2（2026-10-08）：另存并切换链的限时预算——/call 回传上限 6s（HANA_BRIDGE_TIMEOUT
// 可调），取 5s 留裕量；超预算返回 pending，由 app 层落定校验后报成功。
const SAVE_CHAIN_BUDGET_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 当前活动工作流对象：优先「实测存在的服务」workflowService（app.extensionManager.workflow），
// 兼容旧版 app.workflowManager。取不到 → null。
// 背景（2026-09-28 实测）：前端 1.53.6 已无 app.workflowManager（全包 0 命中），
// 旧读法恒返 null → 页面身份恒「(未命名)」、定向路由失效。
function activeWorkflowObj() {
  try {
    const svc = app && app.extensionManager && app.extensionManager.workflow;
    if (svc && svc.activeWorkflow) return svc.activeWorkflow;
  } catch { /* 忽略 */ }
  try {
    const wm = app && app.workflowManager;
    if (wm && wm.activeWorkflow) return wm.activeWorkflow;
  } catch { /* 忽略 */ }
  return null;
}

// 工作流是否「已修改未保存」：isModified 两种形态都兼容——v1.55.14 源码核对为布尔 getter
// （ComfyWorkflow._isModified；setter 同源）；旧版前端（2026-09-28 实测）为函数 isModified()。
function workflowDirty(wf) {
  try {
    if (!wf) return false;
    const m = wf.isModified;
    if (typeof m === "boolean") return m;
    if (typeof m === "function") return !!wf.isModified();
  } catch { /* 忽略 */ }
  return false;
}

// ── P3-b（2026-10-21，issue #2）：多页面定向的「判定可见化」──────────────────────
// 桥 js 侧看不到别的页面开着什么（没有 _frontends 表，aw 永远是本页的活动工作流），
// 能做的唯一判断是「这条指令是不是发给本页的」——靠 api.clientId（= /ws 的 sid）自比。
// 注意：这两个函数只产出「标注」，不改变脏保护的拦/放口径（口径仍是 dirty && force!==true）。
// 理由：异页 sid 放行是错的——py 侧 sid 无命中/歧义时会退化为广播，此时本页才是执行目标，
// 放行就等于丢掉用户未保存的编辑。

// 判定这条指令是否发给本页。
// 返回 true=是本页 / false=不是本页 / "unknown"=本页 clientId 取不到；无 sid → null。
function sidTargetsSelf(rawSid) {
  const sid = rawSid == null ? "" : String(rawSid).trim();
  if (!sid) return null;
  let me = null;
  try {
    const v = api && api.clientId;
    if (typeof v === "string" && v.trim()) me = v.trim();
  } catch { /* 忽略 */ }
  if (!me) return "unknown";
  if (sid === me) return true;
  if (me.startsWith(sid)) return true; // py 侧允许 8 位短 sid 前缀定向
  return false;
}

// 计算脏检查走哪个分支（仅用于标注/日志，不参与拦/放判断）。
function dirtyGateBranch(force, hasSid, targetsSelf) {
  if (force === true) return "skipped-force";
  if (!hasSid) return "enforced-no-sid";
  if (targetsSelf === true) return "enforced-active-page";
  if (targetsSelf === "unknown") return "enforced-sid-unknown";
  return "enforced-sid-not-self";
}

// 工作流是否为「临时页」（从未落盘、无真实文件路径）：v1.55.14 源码核对为布尔 getter
// （UserFile.isTemporary，size===-1；saveAs 成功后才拿到真实 size）；兼容函数形式。取不到/异常 → false。
function workflowTemporary(wf) {
  try {
    if (!wf) return false;
    const t = wf.isTemporary;
    if (typeof t === "boolean") return t;
    if (typeof t === "function") return !!wf.isTemporary();
  } catch { /* 忽略 */ }
  return false;
}

// 当前页面的「身份」：它打开的是哪个工作流。
// 多页面路由靠它：一个页面对应一个工作流名（对应一个 json 文件）。
function currentWorkflowInfo() {
  try {
    const wf = activeWorkflowObj();
    if (!wf) return { name: "(未命名)", path: null, modified: null };
    const name = String(wf.filename || wf.name || "").trim() || "(未命名)";
    return {
      name,
      path: wf.path || null,
      modified: workflowDirty(wf),
    };
  } catch {
    return { name: "(未命名)", path: null, modified: null };
  }
}

// 当前画布的身份 id（工作流 JSON 顶层 uuid；loadGraphData 会带进 app.graph.id）。
// 取不到 → null（调用方回退按名键，向后兼容）。
function currentWorkflowId() {
  try {
    const gid = app && app.graph && app.graph.id;
    if (typeof gid === "string" && gid.trim()) return gid.trim();
  } catch { /* 忽略 */ }
  try {
    const s = activeWorkflowObj() && activeWorkflowObj().activeState;
    const sid = s && s.id;
    if (typeof sid === "string" && sid.trim()) return sid.trim();
  } catch { /* 忽略 */ }
  return null;
}

// 当前画布是否临时（未落盘、无真实文件路径）。
function currentWorkflowTemporary() {
  try { return workflowTemporary(activeWorkflowObj()); } catch { return false; }
}

// 当前画布相对路径（临时画布 → null）。用于后端 identity（区分同 id 的不同正式文件）。
function currentWorkflowPath() {
  try {
    const wf = activeWorkflowObj();
    const p = wf && wf.path;
    return (typeof p === "string" && p.trim()) ? p.trim() : null;
  } catch { return null; }
}

// 2026-10-24：一次性捕获「工作流身份」快照（name/id/path/temporary 同时取，同步无 await）。
// 为什么必须捕获：提交链路是「抓图 → await 原生 queuePrompt → 上报」，上报时若再用
// current*() 现取身份，而用户在 await 期间切了画布，就会「图归 A、名字归 B」，把快照写进
// 另一张画布的历史（2026-10-24 串台事故：Qwen 图落进 moss-image-SFT综合）。
function captureWorkflowIdentity() {
  let name = null, id = null, path = null, temporary = false;
  try { name = currentWorkflowInfo().name; } catch { name = null; }
  try { id = currentWorkflowId(); } catch { id = null; }
  try { path = currentWorkflowPath(); } catch { path = null; }
  try { temporary = currentWorkflowTemporary() === true; } catch { temporary = false; }
  return { name, id, path, temporary };
}

// 给 history 类请求体/查询补 workflowId + workflowPath + workflowTemporary
// （与既有 workflow 名并存；后端优先用 id/identity 判键，缺省回退名）。
// identity：可选，传入 captureWorkflowIdentity() 的结果 → 用捕获值，不再现取。
function withWorkflowId(payload, identity) {
  const id = identity ? identity.id : currentWorkflowId();
  if (!id) return payload;
  const out = Object.assign({}, payload, { workflowId: id });
  const p = identity ? identity.path : currentWorkflowPath();
  if (p) out.workflowPath = p;
  out.workflowTemporary = identity ? identity.temporary === true : currentWorkflowTemporary();
  return out;
}

// 给 GET query 串追加 &workflowId= / &workflowPath= / &workflowTemporary=（取不到 id → 原样返回）。
function withWorkflowIdQs(qs) {
  const id = currentWorkflowId();
  if (!id) return qs;
  let s = qs + "&workflowId=" + encodeURIComponent(id);
  const p = currentWorkflowPath();
  if (p) s += "&workflowPath=" + encodeURIComponent(p);
  s += "&workflowTemporary=" + (currentWorkflowTemporary() ? "1" : "0");
  return s;
}

// 本页「全量已打开工作流」列表（2026-10-13，A 档 S1）。
// 背景：桥此前只读 activeWorkflow → 同页其它标签（Tab）是结构性盲区。前端 Tab 条
// 本身就是遍历 svc.openWorkflows 渲染（GraphView-CDjciZjE.js: S=N(()=>i.openWorkflows.map(...))）。
// 数据源 = app.extensionManager.workflow.openWorkflows（Pinia `workflow` store，数组；setup store
// 的 ref/computed 在 store 实例上已解包 → 直接是数组）。每项：
//   name  = filename || name（名字链同 currentWorkflowInfo，取不到 → "(未命名)"）
//   path  = wf.path（Copilot pageKey / 定向主键）
//   key   = wf.key（前端 Tab 身份；同名多开时与 path 一起用于区分）
//   active= 该项 === activeWorkflow
//   dirty = workflowDirty(wf)（兼容 getter / 函数两种形态）
// 取不到（无 store / 非数组 / 抛错）→ 空数组（消费侧如实当「不知道」，不猜）。
// 只读：不写任何状态。
function openWorkflowsInfo() {
  try {
    const svc = app && app.extensionManager && app.extensionManager.workflow;
    if (!svc || !Array.isArray(svc.openWorkflows)) return [];
    const aw = svc.activeWorkflow || null;
    return svc.openWorkflows.map((wf) => ({
      name: String((wf && (wf.filename || wf.name)) || "").trim() || "(未命名)",
      path: (wf && wf.path) || null,
      key: (wf && wf.key) || null,
      active: !!wf && wf === aw,
      dirty: workflowDirty(wf),
    }));
  } catch { /* 忽略 */ }
  return [];
}

// ── D1：画布执行 + 副驾驶（canvas.queue / canvas.duplicate / canvas.visual 与开关 UI）──
// 契约：docs/共驾接口契约-20260929.md（op 名 / 字段名 / 三动作语义冻结）；
// 实现依据：_temp/d1-copilot-探查-20260929/ E1·E2（前端 v1.53.6 实证）。
// 边界：只新增 op 与 UI；既有 op 行为不动。

// 前端 hashUtil.ts（platform/workflow/persistence/base）的逐行等效：fnv1a → 8 位 hex。
// 注意：本文件上方的 fnv1a() 是浮点乘法变体（与前端 Math.imul 版结果不同，仅用于本桥内部图签名）；
// copilot 的 localStorage 键必须用下面这个精确版才能与前端惯例对齐。
function fnv1aU32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashPathKey(str) {
  return fnv1aU32(String(str)).toString(16).padStart(8, "0");
}

// 副本工作流的独立身份 id（原生 duplicateWorkflow 用 generateUUID()；以 crypto.randomUUID 为主）
function newUuid() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* 忽略 */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// /queue 差集定位用：读出在队 / 在跑任务的 prompt_id 集合。
// item 结构＝(number, prompt_id, …)（截 5 项）；响应＝{queue_running, queue_pending}（E1 §2-b 实锤）。
async function queuePromptIds() {
  const res = await api.fetchApi("/queue");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const q = (await res.json()) || {};
  const ids = new Set();
  const eat = (arr) => {
    for (const item of arr || []) {
      if (Array.isArray(item) && item.length > 1 && item[1]) ids.add(String(item[1]));
    }
  };
  eat(q.queue_running);
  eat(q.queue_pending);
  return ids;
}

// —— copilot 开关（按页存储；唯一写方＝本 UI；app 侧只读）——
// localStorage 键：hana.copilot.v1:<ws>:<hashPath(pageKey)>（镜像前端 Draft.v2 的键结构）
const COPILOT_LS_PREFIX = "hana.copilot.v1:";
const COPILOT_TOGGLE_ID = "hana-copilot-toggle";
const COPILOT_STYLE_ID = "hana-copilot-style";

// 前端 storageKeys.ts :: getWorkspaceId 的等效（非云＝personal；云读 sessionStorage）
function copilotWorkspaceId() {
  try {
    const raw = sessionStorage.getItem("Comfy.Workspace.Current");
    if (!raw) return "personal";
    const ws = JSON.parse(raw);
    if (!ws || ws.type === "personal" || !ws.id) return "personal";
    return String(ws.id);
  } catch {
    return "personal";
  }
}

// pageKey = activeWorkflow.path（fallback：key → name）；取不到返回 null
function copilotPageKey() {
  try {
    const wf = activeWorkflowObj();
    if (!wf) return null;
    const p = wf.path ? String(wf.path).trim() : "";
    if (p) return p;
    const k = wf.key ? String(wf.key).trim() : "";
    if (k) return k;
    const n = String(wf.filename || wf.name || "").trim();
    return n || null;
  } catch {
    return null;
  }
}

function copilotLsKey(pageKey) {
  return COPILOT_LS_PREFIX + copilotWorkspaceId() + ":" + hashPathKey(pageKey);
}

// 读当前页 copilot 状态（刷新后保留：数据源即 localStorage）
function copilotReadState() {
  const pageKey = copilotPageKey();
  if (!pageKey) return { enabled: false, pageKey: null, updatedAt: 0 };
  let enabled = false;
  let updatedAt = 0;
  try {
    const raw = localStorage.getItem(copilotLsKey(pageKey));
    if (raw) {
      const rec = JSON.parse(raw);
      enabled = !!(rec && rec.enabled);
      updatedAt = rec && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
    }
  } catch { /* 读不到按默认关 */ }
  return { enabled, pageKey, updatedAt };
}

function copilotWriteState(enabled) {
  const pageKey = copilotPageKey();
  if (!pageKey) return { enabled: false, pageKey: null, updatedAt: 0 };
  const rec = { enabled: !!enabled, updatedAt: Date.now() };
  try {
    localStorage.setItem(copilotLsKey(pageKey), JSON.stringify(rec));
  } catch (err) {
    console.warn(LOG_TAG, "copilot 状态写入失败", err);
  }
  return { enabled: rec.enabled, pageKey, updatedAt: rec.updatedAt };
}

// 上报口径（字段冻结：enabled / pageKey? / updatedAt）
function copilotStateForPush() {
  const cur = copilotReadState();
  const out = { enabled: !!cur.enabled, updatedAt: Number(cur.updatedAt) || 0 };
  if (cur.pageKey) out.pageKey = cur.pageKey;
  return out;
}

let copilotEl = null;
let copilotPageKeyLast; // 会话内上次页键；undefined=尚未初始化（首轮 pollGraph 落定）

function copilotStyleEnsure() {
  if (document.getElementById(COPILOT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COPILOT_STYLE_ID;
  style.textContent = `
#${COPILOT_TOGGLE_ID} {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 0 4px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
#${COPILOT_TOGGLE_ID}:hover { background: rgba(127,127,127,.15); }
#${COPILOT_TOGGLE_ID} .hana-copilot-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor; opacity: .35; flex: none;
}
#${COPILOT_TOGGLE_ID}[data-enabled="true"] {
  border-color: rgba(255,215,0,.85);
  background: rgba(255,215,0,.12);
  color: #FFD700;
}
#${COPILOT_TOGGLE_ID}[data-enabled="true"] .hana-copilot-dot { opacity: 1; background: #FFD700; }
`;
  document.head.appendChild(style);
}

function copilotUiRender() {
  if (!copilotEl) return;
  const cur = copilotReadState();
  copilotEl.dataset.enabled = cur.enabled ? "true" : "false";
  copilotEl.title = cur.enabled
    ? "小花副驾驶：开（agent 与本画布共编）— 点击关闭"
    : "小花副驾驶：关（agent 动作先复制副本，不碰本画布）— 点击开启";
  const label = copilotEl.querySelector(".hana-copilot-label");
  if (label) label.textContent = cur.enabled ? "副驾驶·开" : "副驾驶·关";
}

// 切换即写即报：localStorage 写入 + UI 刷新 + 立刻推一次 state（不等防抖）
function copilotToggle() {
  const cur = copilotReadState();
  copilotWriteState(!cur.enabled);
  copilotUiRender();
  void pushStateSnapshot();
}

// 开关 UI 挂点（方案 B · DOM 注入）：app.menu.element＝官方为 custom scripts 保留的元素槽，
// 前端会把它搬入画布区顶栏 [data-testid="legacy-topbar-container"]（E2 §3）。
function copilotUiEnsure() {
  const host = app && app.menu && app.menu.element;
  if (!host) return null;
  copilotStyleEnsure();
  if (!copilotEl) {
    copilotEl = document.createElement("button");
    copilotEl.id = COPILOT_TOGGLE_ID;
    copilotEl.type = "button";
    const dot = document.createElement("span");
    dot.className = "hana-copilot-dot";
    const label = document.createElement("span");
    label.className = "hana-copilot-label";
    copilotEl.append(dot, label);
    copilotEl.addEventListener("click", (ev) => {
      try {
        ev.preventDefault();
        ev.stopPropagation();
        copilotToggle();
      } catch (err) {
        console.warn(LOG_TAG, "copilot 切换失败", err);
      }
    });
  }
  const dup = host.querySelector(":scope > #" + COPILOT_TOGGLE_ID);
  if (dup && dup !== copilotEl) dup.remove();
  if (copilotEl.parentElement !== host) host.appendChild(copilotEl);
  copilotUiRender();
  return copilotEl;
}

// —— 编辑可视化：lock / highlight / clear（契约 §3.2；防呆实现）——
const COPILOT_STROKE_KEY = "hana.copilot";
const COPILOT_GOLD = "#FFD700";
const COPILOT_FILM_ID = "hana-copilot-film";

const copilotVisual = {
  readOnlyTouched: false, // read_only 是否被本桥改过（还原时只还原自己改的）
  prevReadOnly: undefined, // 改动前的原值
  markedNodeIds: [], // 已黄标的节点 id
  markedLinks: [], // 已黄标的连线：[{ id, prevColor }]
  markedLinkIdSet: new Set(), // 供连线渲染包裹层 O(1) 查询
};
let linkPatchAdapter = null; // 已被包裹的 linkRenderer 实例

function filmRemove() {
  const el = document.getElementById(COPILOT_FILM_ID);
  if (el && el.parentElement) el.parentElement.removeChild(el);
}

// 锁膜：append 进 #graph-canvas-container（E2 §2：最后=最上；个别面板有 z-index，显式抬到 9999）。
// pointer-events:auto 吃指针事件 → 阻断误操作；键盘挡不住（已知边界，命令层自判）。
function filmApply(note) {
  filmRemove();
  const container =
    document.getElementById("graph-canvas-container") ||
    (app && app.canvasContainer) ||
    null;
  if (!container) {
    console.warn(LOG_TAG, "找不到画布容器：lock 膜未挂上（read_only 仍已置位）");
    return false;
  }
  const film = document.createElement("div");
  film.id = COPILOT_FILM_ID;
  film.style.cssText =
    "position:absolute; inset:0; z-index:9999; background:rgba(0,0,0,.35);" +
    "display:flex; flex-direction:column; align-items:center; justify-content:center;" +
    "gap:6px; pointer-events:auto; cursor:progress;";
  const main = document.createElement("div");
  main.textContent = "小花正在操作…";
  main.style.cssText =
    "color:#FFD700; font-size:14px; font-weight:600; text-shadow:0 1px 2px rgba(0,0,0,.6);";
  film.appendChild(main);
  if (note) {
    const sub = document.createElement("div");
    sub.textContent = String(note);
    sub.style.cssText = "color:#ddd; font-size:12px; text-shadow:0 1px 2px rgba(0,0,0,.6);";
    film.appendChild(sub);
  }
  container.appendChild(film);
  return true;
}

function visualLockReadOnly() {
  if (copilotVisual.readOnlyTouched) return;
  const canvas = app && app.canvas;
  if (!canvas) return;
  copilotVisual.prevReadOnly = canvas.read_only;
  copilotVisual.readOnlyTouched = true;
  canvas.read_only = true;
}

function visualRestoreReadOnly() {
  if (!copilotVisual.readOnlyTouched) return;
  copilotVisual.readOnlyTouched = false;
  const canvas = app && app.canvas;
  if (canvas) canvas.read_only = copilotVisual.prevReadOnly;
  copilotVisual.prevReadOnly = undefined;
}

// 连线（edge）黄标：v1.53.6 的连线没有 strokeStyles 等价钩子（E2 §1 只管节点），
// 渲染链为 LGraphCanvas.renderLink → canvas.linkRenderer.renderLinkDirect(ctx,…,color,…)。
// 对渲染适配器做一次透明包裹：目标连线 color 覆盖为 #FFD700、线宽不低于 3。
// 包裹层绝不抛错；标记集为空时零开销；graph 切换时适配器会重建，下一次 highlight 自动重挂。
function ensureLinkRenderPatch() {
  const canvas = app && app.canvas;
  const adapter = canvas && canvas.linkRenderer;
  if (!adapter || typeof adapter.renderLinkDirect !== "function") return false;
  if (adapter === linkPatchAdapter) return true;
  const orig = adapter.renderLinkDirect;
  adapter.renderLinkDirect = function (
    ctx, a, b, link, skip_border, flow, color, start_dir, end_dir, context, extras
  ) {
    try {
      if (
        link &&
        copilotVisual.markedLinkIdSet.size > 0 &&
        copilotVisual.markedLinkIdSet.has(String(link.id))
      ) {
        color = COPILOT_GOLD;
        if (context && typeof context === "object" && (Number(context.connectionWidth) || 0) < 3) {
          context = { ...context, connectionWidth: 3 };
        }
      }
    } catch { /* 包裹层不抛 */ }
    return orig.call(this, ctx, a, b, link, skip_border, flow, color, start_dir, end_dir, context, extras);
  };
  linkPatchAdapter = adapter;
  return true;
}

function uninstallLinkRenderPatch() {
  if (!linkPatchAdapter) return;
  try {
    delete linkPatchAdapter.renderLinkDirect; // 还原为原型方法（透明）
  } catch { /* 忽略 */ }
  linkPatchAdapter = null;
}

// 全撤标记（节点 strokeStyles 项 / 连线颜色 / 渲染包裹）；返回是否有实际改动（决定是否重绘）
function visualClearMarks() {
  let touched = false;
  for (const id of copilotVisual.markedNodeIds) {
    const n = findNode(id);
    if (n && n.strokeStyles && COPILOT_STROKE_KEY in n.strokeStyles) {
      delete n.strokeStyles[COPILOT_STROKE_KEY];
      touched = true;
    }
  }
  copilotVisual.markedNodeIds = [];
  const lm = app.graph && app.graph.links;
  for (const rec of copilotVisual.markedLinks) {
    try {
      const l = lm && typeof lm.get === "function" ? lm.get(rec.id) : null;
      if (l) {
        // 还原（setter 约定："" → null，即恢复「未设自定义色」）
        l.color = rec.prevColor === undefined || rec.prevColor === null ? "" : rec.prevColor;
        touched = true;
      }
    } catch { /* 忽略 */ }
  }
  copilotVisual.markedLinks = [];
  copilotVisual.markedLinkIdSet = new Set();
  uninstallLinkRenderPatch();
  return touched;
}

// 找 from→to 的连线（任意槽位；一对节点间可能有多条）
function linksBetween(fromId, toId) {
  const out = [];
  const lm = app.graph && app.graph.links;
  if (lm && typeof lm.forEach === "function") {
    lm.forEach((l) => {
      if (!l) return;
      if (String(l.origin_id) === String(fromId) && String(l.target_id) === String(toId)) out.push(l);
    });
  }
  return out;
}

// agent 自己写入的 undo 栈（存 before 值）。
// 为何需要：实测新版前端的 ChangeTracker 不记录「外部对 graph 的直接修改」
// （graph.onBeforeChange / canvas.onBeforeChange 都不存在，Comfy.Undo 对这类改动无效），
// 所以 agent 的改动要能撤销，得自己记一份。最多保留 20 步。
let writeStack = [];

// 逆操作栈：每个写 op 自带一个「怎么撤回去」的闭包。
// 为何不用快照式撤销：整图快照会把人在此期间对别处的改动一起回滚，也不便宜；
// 逆操作只回退 agent 自己那一步，精确且支持连续撤销。
function withChange(fn) {
  app.graph.beforeChange();
  try {
    fn();
  } finally {
    app.graph.afterChange();
  }
}

// P4：patch 事务执行期间，逆操作收集进批内局部列表（不落全局栈，绕开 20 条上限）；
// 批次成功后由事务压 1 条复合逆操作，失败时直接用局部列表逆序回滚。
let patchCollector = null; // null | (label, undo) => void
let patchInFlight = false; // 同页并发 patch 锁

function pushUndo(label, undo) {
  if (patchCollector) {
    patchCollector(label, undo);
    return;
  }
  writeStack.push({ label, undo, at: new Date().toISOString() });
  if (writeStack.length > 20) writeStack.shift();
}

// slot 可以是索引，也可以是名字（名字优先，纯数字字符串按索引）
function slotIndex(slots, which) {
  const arr = slots || [];
  if (typeof which === "number") return which >= 0 && which < arr.length ? which : -1;
  const s = String(which == null ? "" : which).trim();
  if (!s) return -1;
  for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].name === s) return i;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < arr.length ? n : -1;
}

function liteGraph() {
  if (typeof window.LiteGraph !== "undefined") return window.LiteGraph;
  if (typeof LiteGraph !== "undefined") return LiteGraph;
  return null;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function graphSignature() {
  const g = app.graph;
  const nodes = nodeList(g);
  const perNode = {};
  const types = {};
  for (const n of nodes) {
    let w = "";
    for (const x of n.widgets || []) {
      const v = x && x.value;
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      w += (x.name || "?") + "=" + s + ";";
    }
    perNode[n.id] = fnv1a(`${n.type}:${n.mode === undefined ? 0 : n.mode}:${n.title || ""}:${w}`);
    types[n.id] = n.type;
  }
  let linkCount = 0;
  const lm = g && g.links;
  if (lm && typeof lm.forEach === "function") lm.forEach(() => { linkCount += 1; });
  const hash = fnv1a(Object.keys(perNode).map((k) => k + perNode[k]).join("|") + "#" + linkCount);
  return { nodeCount: nodes.length, linkCount, hash, perNode, types };
}

function pollGraph() {
  const sig = graphSignature();
  // N1修（2026-10-12）：换工作流的判据统一到 historyOnWorkflowSwitch（与事件路径同一入口、同一基线）。
  // 该入口内部比对 lastWorkflowName 并负责更新 → 这里不再自己算 wfChanged，避免两套逻辑。
  // 返回 true = 确换了工作流（名字变了）；false = 同名（进子图 / 回跳装载）/ 基线未建立。
  let wfChanged = false;
  try {
    wfChanged = historyOnWorkflowSwitch();
  } catch (err) {
    console.warn(LOG_TAG, "N1 换工作流处理失败（不影响画布）", err);
  }
  // 工作流身份也算一种变化：切了/重命名了工作流，页面就该重报一次
  if ((lastSignature && sig.hash !== lastSignature.hash) || wfChanged) {
    graphRevision += 1;
    // 按节点算差异：agent 不只该知道“变了”，还该知道“哪个节点变了”
    const changed = [];
    for (const id of Object.keys(sig.perNode)) {
      if (!(id in lastSignature.perNode)) changed.push({ id, type: sig.types[id], kind: "added" });
      else if (sig.perNode[id] !== lastSignature.perNode[id]) changed.push({ id, type: sig.types[id], kind: "changed" });
    }
    for (const id of Object.keys(lastSignature.perNode)) {
      if (!(id in sig.perNode)) changed.push({ id, type: lastSignature.types[id], kind: "removed" });
    }
    changes.push({
      rev: graphRevision,
      at: new Date().toISOString(),
      source: changeSource, // P6（2026-10-08）：user / agent / system
      nodes: sig.nodeCount,
      links: sig.linkCount,
      deltaNodes: sig.nodeCount - lastSignature.nodeCount,
      deltaLinks: sig.linkCount - lastSignature.linkCount,
      changed: changed.slice(0, 20),
    });
    if (changes.length > CHANGE_KEEP) changes = changes.slice(-CHANGE_KEEP);
    scheduleStatePush();
  }
  // copilot：页键（工作流）变化＝切了「这块布」→ 开关 UI 与上报跟着走；
  // 挂点晚到 / 被重建时补挂（页键未变则不额外上报）。
  const copilotKey = copilotPageKey();
  if (copilotKey !== copilotPageKeyLast) {
    copilotPageKeyLast = copilotKey;
    copilotUiEnsure();
    scheduleStatePush();
  } else if (!copilotEl || !copilotEl.isConnected) {
    copilotUiEnsure();
  }
  // N1 兜底（2026-10-12）：工作流切换 —— 用**本已有**的轮询做名字比对，不新开定时器。
  // 主路径见 installHistoryGraphSwitchListener（canvas 元素上的 litegraph:set-graph 监听）；
  // 该监听会随 canvas 元素重建而丢失（延迟重试只覆盖启动后 6s）→ 这里用轮询名比对兜底。
  // N1修：判据与动作已上移到函数头部的 historyOnWorkflowSwitch()（统一入口），此处不再重复。
  lastSignature = sig;
  return sig;
}

// ── 状态快照推送（口径修正：对话不是持续态，变化后推一次就够）───────────────
// 把摘要缓到 ComfyUI 侧，agent 随时拿得到「手边快照」，不依赖「此刻页面在线」。
// 变化后 debounce，避免连续拖动时刷屏。
const STATE_DEBOUNCE_MS = 1500;
let statePushTimer = null;

function scheduleStatePush() {
  if (statePushTimer) clearTimeout(statePushTimer);
  statePushTimer = setTimeout(() => {
    statePushTimer = null;
    void pushStateSnapshot();
  }, STATE_DEBOUNCE_MS);
}

async function pushStateSnapshot() {
  try {
    await postJson("/hana_bridge/state", {
      at: new Date().toISOString(),
      ts: Date.now(),
      revision: graphRevision,
      sid: api.clientId || null,
      workflow: currentWorkflowInfo(),
      // A 档 S1（2026-10-13）：随 state 一并上报本页全量打开工作流。
      // 为何走 state 而非桥内 pages：canvas.pages 由 py 侧产出（bridge/__init__.py L378
      // _pages_payload → L266），桥只推 state（本函数）。故 openWorkflows 从这里进去。
      openWorkflows: openWorkflowsInfo(),
      summary: graphSummary(),
      copilot: copilotStateForPush(),
    });
  } catch (err) {
    console.warn(LOG_TAG, "状态推送失败", err);
  }
}

// ── 意图级写：patch 事务（P4）────────────────────────────────────────────
// 一次提交多条编辑：顺序执行（每条执行成功后立即 verify，默认开）→ save（仅限最后）→
// 成功压 1 条复合逆操作；任一步失败/verify 失败 → 逆序回滚批内改动（批内局部逆操作，不碰全局 20 条上限）。
// 契约要点：
//   · edits 白名单：addNode / setWidget / connect / disconnect / setNodeMode / removeNode / save；
//     每条恰一个 key；save 仅限最后一条；undo / loadWorkflowFile / openWorkflow / organize 明确拒绝。
//   · as/$：as 仅 addNode（重名拒绝）；$ 只在 nodeId / fromNode / toNode 解析；未定义 $ 报错并回滚。
//   · connect 以 graph.links 出现目标连线为唯一成功判据（封 §23③ 静默失败），失败重试 1 次。
//   · verify 即时化（2026-09-28 修正）：对着「该 edit 执行完的瞬间」核验，不再按批次终态——
//     否则 disconnect→同槽 re-connect、同槽多次 setWidget、[setWidget,removeNode] 会被误判回滚。
//   · collector 窗口收窄（2026-09-28 修正）：批内逆操作收集只覆盖主 edits 段；verify/save/回滚段
//     摘除收集器（patchCollector=null），期间到达的其它写 op 走正常全局栈，不被本批吸收。
//   · 逆操作按 id 重寻节点（2026-09-28 修正）：setWidget / connect 的逆操作执行时重寻，不写旧对象。
//   · 事务结果在 data 层（ok 字段）；解析/结构预检失败才 throw（通道层错误）。
//   · 超时注记：前端等待默认 6s（HANA_BRIDGE_TIMEOUT 可调）——大批量注意 6s 约束；
//     超时（504）≠ 未生效，重试前先对账 rev。v0 不设条数硬限。
//   · 并发：模块级 in-flight 锁，同页并发 patch 直接拒绝（明确报错）。
const PATCH_ALLOWED = ["addNode", "setWidget", "connect", "disconnect", "setNodeMode", "removeNode", "moveNode", "setNodeSize", "save"];
const PATCH_FORBIDDEN = ["undo", "loadWorkflowFile", "openWorkflow", "organize"];
const PATCH_REF_FIELDS = ["nodeId", "fromNode", "toNode"];

// 解析 + 结构预检（两种模式共用；失败 → throw，属通道层错误）
function parsePatchEdits(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("patch 需要 edits（非空编辑数组，如 [{\"setWidget\":{…}}]）");
  }
  const list = [];
  raw.forEach((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`edits[${i}] 必须是对象（恰一个 key）`);
    const keys = Object.keys(e);
    if (keys.length !== 1) {
      throw new Error(`edits[${i}] 必须恰好一个 key（收到 ${keys.length} 个：${keys.join(", ") || "无"}）`);
    }
    const key = keys[0];
    if (PATCH_FORBIDDEN.includes(key)) {
      throw new Error(`edits[${i}]：patch 明确拒绝 "${key}"（可用：${PATCH_ALLOWED.join(" / ")}）`);
    }
    if (!PATCH_ALLOWED.includes(key)) {
      throw new Error(`edits[${i}] 未知 edit："${key}"（可用：${PATCH_ALLOWED.join(" / ")}）`);
    }
    let val = e[key];
    if (val === undefined || val === null) val = {};
    if (typeof val !== "object" || Array.isArray(val)) throw new Error(`edits[${i}].${key} 必须是对象`);
    if (key === "save" && i !== raw.length - 1) {
      throw new Error(`save 只能作为最后一条 edit（现在第 ${i + 1}/${raw.length} 条）`);
    }
    if (key !== "addNode" && val.as !== undefined && val.as !== null) {
      throw new Error(`edits[${i}]：as 仅 addNode 支持`);
    }
    for (const f of PATCH_REF_FIELDS) {
      if (typeof val[f] === "string" && val[f].startsWith("$") && !val[f].slice(1)) {
        throw new Error(`edits[${i}]：非法引用 "${val[f]}"（$ 后需有名称）`);
      }
    }
    list.push({ index: i, key, args: val, raw: e });
  });
  return list;
}

// $ 引用解析（仅 nodeId / fromNode / toNode 三个字段；未定义 → 抛错触发回滚）
function resolvePatchRef(value, symbols) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!(name in symbols)) {
    throw new Error(`未定义的引用 "${value}"（需先有 {"addNode":{…,"as":"${name}"}} 定义）`);
  }
  return symbols[name];
}

// 值宽松相等（verify 用）：标量按 String 比，对象按 JSON 比
function eqLoose(x, y) {
  if (x === y) return true;
  if (x === null || y === null || x === undefined || y === undefined) return false;
  if (typeof x === "object" || typeof y === "object") {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch { return false; }
  }
  return String(x) === String(y);
}

// 目标连线是否已在 graph.links 中（connect 的唯一成功判据；§23③ 静默失败也用它兜底）
function linkLanded(fromId, toId, toSlotIdx) {
  const lm = app.graph && app.graph.links;
  let found = false;
  if (lm && typeof lm.forEach === "function") {
    lm.forEach((l) => {
      if (!l) return;
      if (
        String(l.origin_id) === String(fromId) &&
        String(l.target_id) === String(toId) &&
        Number(l.target_slot) === Number(toSlotIdx)
      ) found = true;
    });
  }
  return found;
}

function patchConnectLanded(resolved) {
  const from = findNode(resolved.fromNode);
  const to = findNode(resolved.toNode);
  if (!from || !to) return false;
  const inIdx = slotIndex(to.inputs, resolved.toSlot);
  if (inIdx < 0) return false;
  return linkLanded(from.id, to.id, inIdx);
}

// 类型启发式（dryRun 用）：相同 / 含 * / 数组放宽 / 缺类型 → 视为兼容；权威判定在 connect 结果。
function patchTypesCompatible(outType, inType) {
  if (Array.isArray(outType) || Array.isArray(inType)) return true;
  const a = outType == null ? "" : String(outType);
  const b = inType == null ? "" : String(inType);
  if (!a || !b) return true;
  if (a === "*" || b === "*") return true;
  return a === b;
}

// 执行单条 edit（顺序调现成 handler，一行不重写）；返回 {payload, resolved}
async function runPatchEdit(item, symbols) {
  const resolved = {};
  for (const k of Object.keys(item.args)) resolved[k] = item.args[k];
  for (const f of PATCH_REF_FIELDS) {
    if (resolved[f] !== undefined) resolved[f] = resolvePatchRef(resolved[f], symbols);
  }
  if (item.key === "addNode") {
    const asName = resolved.as;
    if (asName !== undefined && asName !== null && String(asName) in symbols) {
      throw new Error(`as 重名："${String(asName)}"（同批已有同名定义）`);
    }
    const callArgs = { ...resolved };
    delete callArgs.as;
    const payload = await OPS["canvas.addNode"](callArgs);
    if (asName !== undefined && asName !== null) symbols[String(asName)] = payload.nodeId;
    return { payload, resolved: callArgs };
  }
  if (item.key === "connect") {
    let payload = await OPS["canvas.connect"](resolved);
    if (!patchConnectLanded(resolved)) {
      payload = await OPS["canvas.connect"](resolved); // §23③：静默失败重试 1 次
      if (!patchConnectLanded(resolved)) {
        throw new Error(`连线未生效：links 中未出现 #${resolved.fromNode} → #${resolved.toNode} 的目标连线（已重试 1 次）`);
      }
    }
    return { payload, resolved };
  }
  const payload = await OPS["canvas." + item.key](resolved);
  return { payload, resolved };
}

// verify：逐 edit 后置条件（值读回 / links 存在或缺失 / 存在或不存在 / mode / saved）
function verifyPatchResult(item, resolved, result) {
  if (item.key === "setWidget") {
    const node = findNode(resolved.nodeId);
    if (!node) return `#${resolved.nodeId} 不见了`;
    const w = (node.widgets || []).find((x) => x.name === resolved.name);
    if (!w) return `#${resolved.nodeId} 的 ${resolved.name} 不存在`;
    if (!eqLoose(w.value, resolved.value)) {
      return `#${resolved.nodeId}.${resolved.name} 值未生效（期望 ${clip(String(resolved.value))}，实为 ${clip(String(w.value))}）`;
    }
    return null;
  }
  if (item.key === "connect") {
    if (!patchConnectLanded(resolved)) return `#${resolved.fromNode} → #${resolved.toNode} 的目标连线不在 links 中`;
    return null;
  }
  if (item.key === "disconnect") {
    const node = findNode(resolved.nodeId);
    if (!node) return `#${resolved.nodeId} 不见了`;
    const ii = slotIndex(node.inputs, resolved.slot);
    if (ii < 0) return `输入槽 ${resolved.slot} 不存在了`;
    const inp = node.inputs[ii];
    if (inp && inp.link != null) return `输入 ${resolved.slot} 仍有连线（link=${inp.link}）`;
    return null;
  }
  if (item.key === "addNode") {
    const nid = result && result.nodeId;
    if (nid === undefined || nid === null || !findNode(nid)) return `新节点 #${nid} 不在图里`;
    return null;
  }
  if (item.key === "removeNode") {
    if (findNode(resolved.nodeId)) return `#${resolved.nodeId} 仍在图中`;
    return null;
  }
  if (item.key === "moveNode") {
    // 校验每个目标节点真的落在期望坐标（容差 0.5，前端可能取整）
    const rows = Array.isArray(resolved.nodes) && resolved.nodes.length
      ? resolved.nodes
      : [[resolved.nodeId, Array.isArray(resolved.pos) ? resolved.pos[0] : resolved.x,
                          Array.isArray(resolved.pos) ? resolved.pos[1] : resolved.y]];
    for (const row of rows) {
      const n = findNode(row[0]);
      if (!n) return "#" + row[0] + " 不见了";
      const ex = Number(row[1]), ey = Number(row[2]);
      if (Math.abs(n.pos[0] - ex) > 0.5 || Math.abs(n.pos[1] - ey) > 0.5) {
        return "#" + row[0] + " 坐标未生效（期望 " + ex + "," + ey +
               "，实为 " + n.pos[0] + "," + n.pos[1] + "）";
      }
    }
    return null;
  }
  if (item.key === "setNodeSize") {
    const n = findNode(resolved.nodeId);
    if (!n) return "#" + resolved.nodeId + " 不见了";
    if (resolved.collapsed === true && !(n.flags && n.flags.collapsed)) {
      return "#" + resolved.nodeId + " 未折叠";
    }
    if (Array.isArray(resolved.size) && resolved.size.length === 2) {
      const ex = Number(resolved.size[0]), ey = Number(resolved.size[1]);
      const aw = n.size && n.size[0], ah = n.size && n.size[1];
      if (Math.abs(aw - ex) > 1 || Math.abs(ah - ey) > 1) {
        return "#" + resolved.nodeId + " 尺寸未生效（期望 " + ex + "x" + ey + "，实为 " + aw + "x" + ah + "）";
      }
    }
    return null;
  }
  if (item.key === "setNodeMode") {
    const node = findNode(resolved.nodeId);
    if (!node) return `#${resolved.nodeId} 不见了`;
    if (Number(node.mode) !== Number(resolved.mode)) {
      return `#${resolved.nodeId} 的 mode 未生效（期望 ${resolved.mode}，实为 ${node.mode}）`;
    }
    return null;
  }
  if (item.key === "save") {
    if (!result || !result.saved) return "save 未返回 saved";
    return null;
  }
  return null;
}

// patch 事务主体：执行（逐条即时 verify）→ save → 压 1 条复合逆操作；失败 → 逆序回滚（局部逆操作）
async function runPatchTransaction(list, opts) {
  const verifyOn = !opts || opts.verify !== false;
  patchInFlight = true;
  const localUndos = [];
  let cur = null;
  patchCollector = (label, undo) => {
    localUndos.push({ label, undo, index: cur ? cur.index : null, edit: cur ? cur.raw : null });
  };
  try {
    const executed = [];
    const symbols = Object.create(null); // as 名 → nodeId
    const saveIdx = list[list.length - 1].key === "save" ? list.length - 1 : -1;
    const mainCount = saveIdx >= 0 ? saveIdx : list.length;

    const rollback = async () => {
      const rolledBack = [];
      const rollbackErrors = [];
      for (const u of localUndos.slice().reverse()) {
        try {
          await u.undo();
          rolledBack.push({ index: u.index, edit: u.edit, ok: true });
        } catch (e) {
          const msg = String((e && e.message) || e);
          rolledBack.push({ index: u.index, edit: u.edit, ok: false, error: msg });
          rollbackErrors.push({ index: u.index, error: msg });
        }
      }
      pollGraph();
      return { rolledBack, rollbackErrors };
    };
    const failWith = async (item, err, prefix) => {
      patchCollector = null; // 回滚段不吸收逆操作（collector 窗口只在主 edits 段）
      const { rolledBack, rollbackErrors } = await rollback();
      return {
        ok: false,
        failedAt: {
          index: item.index,
          edit: item.raw,
          error: `${prefix ? prefix + "：" : ""}${String((err && err.message) || err)}`,
        },
        rolledBack,
        rollbackErrors,
        rev: graphRevision,
      };
    };

    // 1) 主 edits 顺序执行（save 除外）；verify 即时化：每条 edit 执行成功后立即核验（对着执行瞬间）
    for (let i = 0; i < mainCount; i++) {
      cur = list[i];
      try {
        const r = await runPatchEdit(cur, symbols);
        executed.push({ item: cur, resolved: r.resolved, result: r.payload });
        if (verifyOn) {
          const detail = verifyPatchResult(cur, r.resolved, r.payload);
          if (detail) return await failWith(cur, new Error(detail), "verify 未通过");
        }
      } catch (err) {
        return await failWith(cur, err);
      }
    }
    // 2) 主 edits 段结束：摘除逆操作收集器（verify/save/回滚段到达的其它写 op 不再被本批吸收）
    patchCollector = null;
    // 3) save（仅限最后一条；前序全成功 + verify 通过后才执行；save 后立即核验 saved）
    let saveResult = null;
    if (saveIdx >= 0) {
      cur = list[saveIdx];
      try {
        const r = await runPatchEdit(cur, symbols);
        saveResult = r.payload;
        executed.push({ item: cur, resolved: r.resolved, result: r.payload });
        if (verifyOn && (!saveResult || !saveResult.saved)) {
          return await failWith(cur, new Error("save 未返回 saved"), "verify 未通过");
        }
      } catch (err) {
        return await failWith(cur, err);
      }
    }
    // 4) 成功：收摊批内收集，压 1 条复合逆操作（一次 patch = 一步撤销；内部逆序调全部子逆操作）
    const undoLabel = `patch(${list.length} edits)`;
    const batchUndos = localUndos.slice();
    patchCollector = null;
    pushUndo(undoLabel, () => {
      const errs = [];
      withChange(() => {
        for (const u of batchUndos.slice().reverse()) {
          try {
            u.undo();
          } catch (e) {
            errs.push(`${u.label}：${(e && e.message) || e}`);
          }
        }
      });
      pollGraph();
      if (errs.length) throw new Error("复合撤销未全部成功：" + errs.join("；"));
    });
    const out = {
      ok: true,
      op: "canvas.patch",
      count: executed.length,
      results: executed.map((rec) => ({ index: rec.item.index, edit: rec.item.raw, ok: true, result: rec.result })),
    };
    if (saveResult) out.saved = saveResult;
    out.undoLabel = undoLabel;
    out.rev = graphRevision;
    return out;
  } finally {
    patchCollector = null;
    patchInFlight = false;
  }
}

// dryRun：零图变更预检（addNode 用不落图的「干节点」做真实校验，供后续 $ 引用）。
// valid=false 只代表预检发现问题，不保证真实执行必然失败（类型兼容是启发式；
// 也不模拟同批删除对后续引用的影响——真实执行时按序判定、失败即回滚）。
function runPatchDryRun(list) {
  const symbols = Object.create(null); // as 名 → {kind:"dry", node}
  const checks = [];
  let valid = true;
  for (const item of list) {
    const issues = [];
    const key = item.key;
    const a = { ...item.args };
    // 引用解析：$ → 已登记符号（干节点）；字面量 → 查真实图
    for (const f of PATCH_REF_FIELDS) {
      if (a[f] === undefined) continue;
      if (typeof a[f] === "string" && a[f].startsWith("$")) {
        const nm = a[f].slice(1);
        const hit = nm in symbols ? symbols[nm] : null;
        if (!hit) issues.push(`未定义的引用 "${a[f]}"`);
        a[f] = { kind: "sym", node: hit ? hit.node : null, label: a[f], bad: !hit };
      } else {
        const node = findNode(a[f]);
        if (!node) issues.push(`找不到节点：#${a[f]}`);
        a[f] = { kind: "real", node, label: a[f] };
      }
    }
    const take = (slot) => {
      if (!slot) return null;
      if (!slot.node && slot.kind === "sym" && !slot.bad) {
        issues.push(`引用 "${slot.label}" 指向的节点不可用（同批 addNode 预检未通过）`);
      }
      return slot.node;
    };

    if (key === "addNode") {
      const type = String(a.type || "").trim();
      if (!type) issues.push("缺少 type");
      let dry = null;
      if (type) {
        const LG = liteGraph();
        if (!LG || typeof LG.createNode !== "function") issues.push("当前前端没有 LiteGraph.createNode");
        else {
          dry = LG.createNode(type);
          if (!dry) issues.push(`未知节点类型：${type}`);
        }
      }
      if (a.as !== undefined && a.as !== null) {
        const nm = String(a.as);
        if (nm in symbols) issues.push(`as 重名："${nm}"`);
        symbols[nm] = { kind: "dry", node: dry };
      }
    } else if (key === "setWidget") {
      if (a.nodeId === undefined) issues.push("缺少 nodeId");
      const node = take(a.nodeId);
      if (node) {
        if (!a.name) issues.push("缺少 name");
        else if (!(node.widgets || []).some((w) => w.name === a.name)) {
          issues.push(`节点 #${node.id} 没有名为 ${a.name} 的参数`);
        }
      }
    } else if (key === "connect") {
      if (a.fromNode === undefined || a.toNode === undefined) issues.push("缺少 fromNode / toNode");
      const from = take(a.fromNode);
      const to = take(a.toNode);
      if (from) {
        const oi = slotIndex(from.outputs, a.fromSlot);
        if (oi < 0) {
          issues.push(`输出槽不存在：${a.fromSlot}（可用：${(from.outputs || []).map((o) => o.name).join(", ")}）`);
        } else if (to) {
          const ii = slotIndex(to.inputs, a.toSlot);
          if (ii < 0) {
            issues.push(`输入槽不存在：${a.toSlot}（可用：${(to.inputs || []).map((i) => i.name).join(", ")}）`);
          } else {
            const ot = (from.outputs || [])[oi] && from.outputs[oi].type;
            const it = (to.inputs || [])[ii] && to.inputs[ii].type;
            if (!patchTypesCompatible(ot, it)) {
              issues.push(`类型可能不兼容（${String(ot)} → ${String(it)}；启发式，真实判定以 connect 结果为准）`);
            }
          }
        }
      }
    } else if (key === "disconnect") {
      if (a.nodeId === undefined) issues.push("缺少 nodeId");
      const node = take(a.nodeId);
      if (node) {
        const ii = slotIndex(node.inputs, a.slot);
        if (ii < 0) {
          issues.push(`输入槽不存在：${a.slot}（可用：${(node.inputs || []).map((i) => i.name).join(", ")}）`);
        } else if (!node.inputs[ii] || node.inputs[ii].link == null) {
          issues.push(`输入 ${a.slot} 本来就没有连线`);
        }
      }
    } else if (key === "moveNode") {
      const rows = Array.isArray(a.nodes) && a.nodes.length
        ? a.nodes
        : [[a.nodeId, Array.isArray(a.pos) ? a.pos[0] : a.x, Array.isArray(a.pos) ? a.pos[1] : a.y]];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 3) { issues.push("nodes 每项须为 [nodeId, x, y]"); continue; }
        const node = take(row[0]);
        if (!node) continue;
        if (!Number.isFinite(Number(row[1])) || !Number.isFinite(Number(row[2]))) {
          issues.push("节点 " + row[0] + " 坐标非有限数字");
        }
      }
    } else if (key === "setNodeSize") {
      if (a.nodeId === undefined) issues.push("缺少 nodeId");
      const node = take(a.nodeId);
      if (node) {
        if (Array.isArray(a.size)) {
          if (a.size.length !== 2 || !a.size.every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) {
            issues.push("size 需为 [w,h] 两个正数");
          }
        }
        if (a.collapsed !== undefined && typeof a.collapsed !== "boolean") {
          issues.push("collapsed 需为布尔");
        }
      }
    } else if (key === "setNodeMode") {
      if (a.nodeId === undefined) issues.push("缺少 nodeId");
      const node = take(a.nodeId);
      if (node) {
        const m = Number(a.mode);
        if (![0, 2, 4].includes(m)) issues.push("mode 必须是 0 / 2 / 4");
      }
    } else if (key === "removeNode") {
      if (a.nodeId === undefined) issues.push("缺少 nodeId");
      else take(a.nodeId);
    } else if (key === "save") {
      const wf = activeWorkflowObj();
      const rawName = String(a.name || (wf && (wf.filename || wf.name)) || "").trim();
      if (!rawName) issues.push("无法确定工作流名（传 name，或先在前端打开/保存过一张工作流）");
    }

    const ok = issues.length === 0;
    if (!ok) valid = false;
    checks.push({ index: item.index, edit: item.raw, ok, issues });
  }
  return { ok: true, dryRun: true, checks, valid };
}

// ── handoff「新开页装载」支撑（修订 1，2026-10-09）──────────────────────────
// 用户主动移交（外开窗口「放入 hui 画布」）的接住动作 = 把移交快照装载为一张【新】页，
// 不触碰当前活动页（无 dirty 检查、不覆盖任何现有画布）。机制 = duplicate 新页序列的同款复用
// （读文件 → createNewTemporary → loadGraphData(state, true, true, wf)），但不复制当前画布。
//
// 为什么独立 op（canvas.loadWorkflowNewPage）而非 loadWorkflowFile + newPage:true（任务书候选 A 评估结论）：
//   · 旧版桥对不认识的参数是「静默忽略」→ 老路径（覆盖当前页）照走，形成「新 app + 未刷新页面」
//     组合下的破坏性降级；独立 op 名在旧桥侧 = unknown op → 干净失败（零副作用），对部署次序天然安全。
//   · 独立 op 不登记 WRITE_OPS：本动作口径＝「用户主动移交」（按钮 + 开卡），不走 agent 写闸门
//     （含 copilot 写拦截的豁免，逐条说明见下方 WRITE_OPS 注释块旁）。
//
// 幂等（「同一移交只接一次」的第二道闸；第一道 = app 侧 take 互斥 + 标记清除）：
//   回执超时（>6s 前端回传上限）或网络抖动会引发 app 侧重试；同一文件在去重窗口内的重复请求
//   直接复用首开的页身份，不重建第二页。
const NEW_PAGE_DEDUP_MS = 600_000; // 10 分钟：远大于卡侧 60s 短窗轮询 + 重试窗口
let lastNewPageLoad = null; // { file, at, page, key, nodeCount, failed }

// ── live 分组支撑（缺口 #5，2026-10-13）───────────────────────────────────────
// 与文件版（app/lib/canvas-edit.mjs 的 addGroup/setGroup/removeGroup）同语义：
//   自动 bounds = 节点 pos/size 外接矩形外扩 GROUP_PAD；无 nodeIds 无 bounds → [0,0,200,100]。
const GROUP_PAD = 20;              // addGroup/setGroup 自动 bounding 的外扩边距（与文件版一致）
const GROUP_DEFAULT_BOUNDS = [0, 0, 200, 100]; // 既无 bounds 又无 nodeIds 时的默认框（与文件版一致）

// LGraphGroup 构造器取法（逐个探明，按可用性回退；2026-10-13 源码核对 comfyui_frontend 1.55.14）：
//  · 前端 `useGlobalLitegraph()`（GraphView 内）显式 `window.LGraphGroup = <class LGraphGroup>`（源码确证）→ 首选。
//  · LiteGraph 命名空间只读镜像：`window.LiteGraph.LGraphGroup`（settingStore 内 `LGraphGroup=Xu`）→ 次选。
//  · 活图上已有组时：取其实例原型的 constructor → 末选（无组时拿不到）。
// 为什么必须真类、不能用「纯对象 {title,bounding}」直接 push（已探明，勿再试）：
//  前端序列化走 `_groups.map(g=>g.serialize())`（serialiseStoredGroups）——纯对象无 serialize() 会抛；
//  且 `graph.add(e)` 只有 `e instanceof LGraphGroup` 才走分组分支，否则按节点处理。故纯对象不可行。
function lgraphGroupCtor() {
  if (typeof window.LGraphGroup === "function") return window.LGraphGroup;
  const LG = liteGraph();
  if (LG && typeof LG.LGraphGroup === "function") return LG.LGraphGroup;
  try {
    const g = app && app.graph;
    const list = g && (Array.isArray(g.groups) ? g.groups : (Array.isArray(g._groups) ? g._groups : null));
    if (list && list.length) {
      const proto = list[list.length - 1] && Object.getPrototypeOf(list[list.length - 1]);
      if (proto && typeof proto.constructor === "function") return proto.constructor;
    }
  } catch { /* 拿不到就算了，返回 null 由调用方报错 */ }
  return null;
}

// 活图分组列表（新前端 graph.groups 是 _groups 的 getter；旧版兼容 _groups）
// 注：命名避开 historyBlockNameOf 内的同名局部变量 liveGroups（自行阴面子坑）。
function liveGroupList(graph) {
  const g = graph || (app && app.graph);
  if (!g) return [];
  if (Array.isArray(g.groups)) return g.groups;
  if (Array.isArray(g._groups)) return g._groups;
  return [];
}

// 显式 bounds 校验（4 个有限数字，文案对齐 canvas-edit.mjs 的 assertBoundsArray）
function asBounds4(v, label) {
  if (!Array.isArray(v) || v.length !== 4 || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
    throw new Error(`${label} 需要四个数字的数组 [x, y, w, h]`);
  }
  return v.map(Number);
}

// 组矩形读法沿用 historyGroupRect（运行时 _bounding/_pos+_size，序列化 bounding，字段依据见其注释）
function liveGroupRect(group) {
  return historyGroupRect(group);
}

// 写回组矩形：运行时用 g.setBounds(x,y,w,h)（新前端；内部同步 layout store + 重绘），
// 退而写 g.bounds（Rectangle）。两者都不可用 → 如实报错（不静默）。
function applyGroupBounds(group, b) {
  if (typeof group.setBounds === "function") {
    group.setBounds(b[0], b[1], b[2], b[3]);
    return;
  }
  if (group.bounds && typeof group.bounds.set === "function") {
    group.bounds.set([b[0], b[1], b[2], b[3]]);
    return;
  }
  throw new Error("该前端不支持设置分组矩形（LGraphGroup.setBounds / bounds 均不可用）");
}

// 由节点集算外接矩形（外扩 GROUP_PAD）。口径对齐 canvas-edit.mjs 的 boundsForNodes。
function liveBoundsForNodes(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("nodeIds 需为非空数组（节点 id 列表）");
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const id of nodeIds) {
    const n = findNode(id);
    if (!n) throw new Error(`找不到节点：#${id}`);
    const p = n.pos;
    if (!p || typeof p[0] !== "number" || typeof p[1] !== "number") {
      throw new Error(`节点 #${n.id} 缺 pos，无法计算 bounds`);
    }
    const s = n.size;
    const w = s && typeof s[0] === "number" ? s[0] : 0;
    const h = s && typeof s[1] === "number" ? s[1] : 0;
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0] + w); maxY = Math.max(maxY, p[1] + h);
  }
  return [minX - GROUP_PAD, minY - GROUP_PAD, (maxX - minX) + GROUP_PAD * 2, (maxY - minY) + GROUP_PAD * 2];
}

// 定位活图分组：index（groups 数组下标、0 基）优先；否则 title（trim 两端同口径，坑 #49）。
// 越界 / 未命中 / 多重命中均如实报错，文案对齐 canvas-edit.mjs 的 locateGroup。
function locateLiveGroup(a) {
  const groups = liveGroupList(app.graph);
  const hasIdx = a.index !== undefined && a.index !== null;
  const hasTitle = a.title !== undefined && a.title !== null && String(a.title).trim() !== "";
  if (!hasIdx && !hasTitle) throw new Error("需要 index（groups 数组下标，0 基）或 title（现有组标题）定位");
  if (hasIdx) {
    const i = Number(a.index);
    if (!Number.isInteger(i) || i < 0) throw new Error("index 需为 ≥0 的整数（groups 数组下标，0 基）");
    if (i >= groups.length) throw new Error(`组 index ${i} 越界（现有 ${groups.length} 个组，0 基下标 0..${Math.max(0, groups.length - 1)}）`);
    return i;
  }
  const wanted = String(a.title).trim();
  const hits = [];
  groups.forEach((g, i) => { if (g && String(g.title == null ? "" : g.title).trim() === wanted) hits.push(i); });
  if (!hits.length) throw new Error(`没有标题为「${wanted}」的组（现有：${groups.map((g) => (g && g.title) || "").filter(Boolean).join(" / ") || "无"}）`);
  if (hits.length > 1) throw new Error(`标题「${wanted}」有 ${hits.length} 个组，无法唯一定位；请改用 index`);
  return hits[0];
}

const OPS = {
  // 全量 UI 格式（等价 Ctrl+S 写出的结构）
  "canvas.get": () => app.graph.toJSON(),

  // 精简结构（给 agent 读；全量序列化容易把上下文撑爆）
  "canvas.summary": () => graphSummary(),

  // 可提交形态（等价点 Queue 时前端构造的 prompt 对象）
  "canvas.prompt": async () => {
    const r = await app.graphToPrompt();
    return {
      output: (r && r.output) || null,
      workflowNodeCount: r && r.workflow && Array.isArray(r.workflow.nodes) ? r.workflow.nodes.length : null,
    };
  },

  // 当前执行到哪个节点
  "exec.running": () => {
    const aw = activeWorkflowObj();
    return {
      runningNodeId: typeof app.runningNodeId === "number" ? app.runningNodeId : null,
      activeWorkflow: aw ? String(aw.filename || aw.name || "").trim() || null : null,
    };
  },

  // 调用前端扩展的已注册命令（如 node-organizer.organize 自动排版）
  // 这让我们不必自己算坐标：把命令表交给前端扩展自己执行。
  "canvas.organize": async (args) => {
    const id = (args && args.command) || "node-organizer.organize";
    const em = app && app.extensionManager;
    const cmd = em && em.command;
    // 实测（09-23）：命令表是 { commands, execute }，执行入口叫 execute，不是 executeCommand
    const run = cmd && (cmd.execute || cmd.executeCommand);
    if (typeof run !== "function") {
      return { error: "no_command_api", keys: cmd ? Object.keys(cmd) : null };
    }
    await run.call(cmd, id);
    return { command: id, nodeCount: nodeList(app && app.graph).length };
  },

  // 列出当前注册的命令（找可调命令的 id 用）
  "canvas.commands": () => {
    const em = app && app.extensionManager;
    const cmds = (em && em.command && em.command.commands) || null;
    let ids = [];
    try {
      if (cmds && typeof cmds[Symbol.iterator] === "function") {
        ids = [...cmds].map((c) => (c && c.id) || null).filter(Boolean);
      } else if (cmds && typeof cmds === "object") {
        ids = Object.keys(cmds);
      }
    } catch (err) {
      return { error: String(err) };
    }
    return { count: ids.length, ids: ids.slice(0, 200) };
  },

  // 探 command 表的真实形状（找执行入口叫什么名字）
  "canvas.commandShape": () => {
    const em = app && app.extensionManager;
    const cmd = em && em.command;
    if (!cmd) return { hasExtensionManager: !!em, hasCommand: false };
    const proto = Object.getPrototypeOf(cmd) || {};
    return {
      hasCommand: true,
      ownKeys: Object.keys(cmd).slice(0, 40),
      protoMethods: Object.getOwnPropertyNames(proto).slice(0, 60),
      fnKeys: Object.keys(cmd).filter((k) => typeof cmd[k] === "function"),
      hasExecuteCommand: typeof cmd.executeCommand === "function",
    };
  },

  // 自检：一次性报出关键 API 的存在性（P0 核验用，转"推断"为"实测"）
  "api.probe": () => ({
    bridgeBuild: BUILD_TAG,
    opsCount: Object.keys(OPS).length,
    opsHasDiag: typeof OPS["api.diag"] === "function",
    hasApp: !!app,
    hasGraph: !!(app && app.graph),
    hasToJSON: !!(app && app.graph && typeof app.graph.toJSON === "function"),
    hasGraphToPrompt: typeof app.graphToPrompt === "function",
    hasLiteGraph: typeof window.LiteGraph !== "undefined" || typeof LiteGraph !== "undefined",
    hasClientId: !!api.clientId,
    hasExtensionManager: !!(app && app.extensionManager),
    hasQueuePromptCapture: queuePromptCaptureInstalled,
    nodeCount: nodeList(app && app.graph).length,
    href: location.href,
  }),

  // 接口形状探查：把活动工作流 / 命令表的真实形状报出来，
  // 目的是把"打开工作流该调哪个 API"从推断变实测。只读，不改任何状态。
  "api.diag": () => {
    const out = { href: location.href };
    // 活动工作流取值（名字链，2026-09-28 修正）：实测服务 = extensionManager.workflow；
    // 旧 app.workflowManager 在前端 1.53.6 已不存在（保留一个兼容位标记）。
    const awv = activeWorkflowObj();
    out.activeWorkflowValues = awv
      ? { name: awv.name ?? null, filename: awv.filename ?? null, path: awv.path ?? null, key: awv.key ?? null, dirty: workflowDirty(awv) }
      : null;
    out.legacyWorkflowManager = !!(app && app.workflowManager);
    const em = app && app.extensionManager;
    if (em) {
      out.extensionManager = { ownKeys: Object.keys(em).slice(0, 40) };
      // 工作流服务：打开/保存工作流的真正入口很可能在这里
      try {
        const svc = em.workflow;
        if (svc) {
          out.workflowService = {
            ownKeys: Object.keys(svc).slice(0, 60),
            protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(svc) || {}).slice(0, 80),
            activeWorkflowKeys: svc.activeWorkflow ? Object.keys(svc.activeWorkflow).slice(0, 40) : null,
          };
          const aw = svc.activeWorkflow;
          if (aw) {
            const ap = Object.getPrototypeOf(aw) || {};
            out.workflowService.activeWorkflowMethods = Object.getOwnPropertyNames(ap).slice(0, 60);
          }
          // A 档 S2（2026-10-13）切标签原语探查（只读）：把 svc 上所有名字里带
          // activate / select / setActive / setActiveWorkflow / switch 的方法列出来。
          // 已知候选（前端源码实测）：svc.openWorkflow(wfOrPath) —— 它是「完整装载」
          // （queueWorkflowLoad → loadGraphData），不是轻量切 Tab；isActive / isOpen 只判不切。
          const proto = Object.getPrototypeOf(svc) || {};
          const names = []
            .concat(Object.getOwnPropertyNames(svc), Object.getOwnPropertyNames(proto))
            .filter((k) => typeof k === "string");
          out.workflowService.activateLike = names.filter((k) => /activate|select|setactive|switch|toggle/i.test(k));
          out.workflowService.fnNames = names.filter((k) => { try { return typeof svc[k] === "function"; } catch { return false; } }).slice(0, 60);
          out.workflowService.hasOpenWorkflows = Array.isArray(svc.openWorkflows);
          out.workflowService.openWorkflowsCount = Array.isArray(svc.openWorkflows) ? svc.openWorkflows.length : null;
          out.openWorkflows = openWorkflowsInfo();
        }
      } catch (e) { out.workflowServiceErr = String(e); }
      const cmd = em.command;
      if (cmd) {
        out.command = { ownKeys: Object.keys(cmd).slice(0, 40) };
        // 尽力把命令 id 列表捞出来，只保留与 workflow/open/load 相关的
        const collect = (src) => {
          try {
            let ids = [];
            if (src instanceof Map) ids = [...src.keys()];
            else if (Array.isArray(src)) ids = src.map((x) => (typeof x === "string" ? x : x && (x.id || x.commandId)));
            else if (src && typeof src === "object") ids = Object.keys(src);
            return ids.filter((k) => typeof k === "string" && /workflow|open|load|tab/i.test(k)).slice(0, 60);
          } catch { return null; }
        };
        out.command.commands = collect(cmd.commands);
        out.command.registry = collect(cmd.registry || cmd._commands || cmd.store);
      }
    }
    return out;
  },

  // 变更感知（P2）：只问“变没变”，轻量
  "canvas.revision": () => {
    const sig = pollGraph();
    return {
      revision: graphRevision,
      changeCount: changes.length,
      nodes: sig.nodeCount,
      links: sig.linkCount,
      lastChangeAt: changes.length ? changes[changes.length - 1].at : null,
    };
  },

  // 变更列表（P2）：最近若干条；可传 { since: <rev> } 只取更新的
  "canvas.events": (args) => {
    const since = Number(args && args.since);
    pollGraph();
    const list = Number.isFinite(since) ? changes.filter((c) => c.rev > since) : changes.slice(-20);
    return { revision: graphRevision, total: changes.length, changes: list };
  },

  // 打开工作流（共驾核心：agent 主动把某个工作流推到前台，人在画布上看得见）
  //
  // 入参：{ name | path, force }
  //   name  工作流名（不含 .json 也可）
  //   path  相对 user/default/ 的路径（如 workflows/xxx.json）
  //   force true 时即使当前图有未保存改动也切换（默认拒绝，避免静默丢掉人的编辑）
  // 返回（P1 起，2026-10-08）：完整装载快返——{ opened:true, pending:true, matched, activeBefore, activeAfter(期望), nodeCount, note }；
  //   失败 { opened:false, blocked:"dirty"|"not_found", … }；由 app 层按 nodeCount / activeAfter 落定校验后报成功。
  // 直接按文件路径加载工作流（绕过前端工作流列表）。
  // 为何需要：前端的工作流列表在启动时加载并可能本地缓存，agent 之后新增的
  // 工作流文件不在列表里，openWorkflow 会 not_found。这条路读文件内容直接进画布。
  "canvas.loadWorkflowFile": async (args) => {
    const a = args || {};
    const file = String(a.file || a.path || "").trim();
    if (!file) throw new Error("需要 file（相对 user/default/ 的路径，如 workflows/xxx.json）");
    const aw = activeWorkflowObj();
    let dirty = false;
    try { dirty = workflowDirty(aw); } catch { dirty = false; }
    if (dirty && a.force !== true) {
      return { loaded: false, blocked: "dirty", activeBefore: aw ? (aw.filename || aw.name) : null };
    }
    const rel = file.replace(/^\\+/, "").replace(/\\\\/g, "/");
    const res = await api.fetchApi("/api/userdata/" + encodeURIComponent(rel), { cache: "no-store" });
    if (!res.ok) throw new Error("读取工作流文件失败：HTTP " + res.status + "（" + rel + "）");
    const graph = await res.json();
    if (!graph || typeof graph !== "object") throw new Error("工作流文件不是合法 JSON 对象");
    if (typeof app.loadGraphData !== "function") throw new Error("前端没有 app.loadGraphData");
    // 身份保持（2026-10-08，补验坐实后修复）：传「装载前活动页对象 aw」为 loadGraphData 第 4 参——
    // 上游 v1.55.14：afterLoadNewGraph → activateLoadedWorkflow 对「对象」走 store.openWorkflow(aw)，
    // 保持 aw 为活动页；对 null 则走 createNewTemporary → 活动页变「Unsaved Workflow」，submit settle
    // 的落点断言（期待副本页名）必失败。aw 取不到时退化为旧单参行为（如实兜底）。
    // 不 await：loadGraphData 会等整图渲染完，节点多时远超前端 6s 回传上限。
    // 发起后立即回报，加载在后台继续。
    // P6（2026-10-08）：装载窗口期间的变更记 source="system"（promise settle 或兜底超时后复位）。
    const sysWin = beginSystemWindow();
    const loadP = Promise.resolve(
      aw
        ? app.loadGraphData(graph, true, true, aw, { checkForRerouteMigration: false, deferWarnings: false })
        : app.loadGraphData(graph),
    ).catch((e) => {
      console.warn(LOG_TAG, "loadGraphData 失败", e);
    });
    armSystemWindow(sysWin, loadP);
    return {
      loaded: true,
      file: rel,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : null,
      note: "已发起加载（异步），画布稍后刷新",
    };
  },

  // 移交快照的「新开页装载」（修订 1，2026-10-09；用户主动移交专用，机制/口径说明见 OPS 表前注释块）。
  // 入参：{ file }（相对 user/default/ 的路径，如 workflows/_handoff-<ts>.json）
  // 回执：{ loaded:true, newPage:true, page, key, nodeCount }；去重命中时追加 dedup:true。
  // await 语义：与 duplicate 一致，等 loadGraphData 完成（新页就绪/激活）才回执——「接住」即落定；
  //   超大图超过前端 6s 回传上限时由 app 侧重试 + 上方去重窗口兜底（重试不重建第二页）。
  "canvas.loadWorkflowNewPage": async (args) => {
    const a = args || {};
    const file = String(a.file || a.path || "").trim();
    if (!file) throw new Error("需要 file（相对 user/default/ 的路径，如 workflows/_handoff-<ts>.json）");
    const rel = file.replace(/^\\+/, "").replace(/\\\\/g, "/");
    // ① 幂等去重：同文件的近期重复请求（回执超时后的重试）不重建页
    const prev = lastNewPageLoad;
    if (prev && prev.file === rel && !prev.failed && Date.now() - prev.at < NEW_PAGE_DEDUP_MS) {
      return {
        loaded: true, newPage: true, dedup: true, file: rel,
        page: prev.page || null, key: prev.key || null, nodeCount: prev.nodeCount != null ? prev.nodeCount : null,
        note: "同一移交近期已开页装载，未重复开页（幂等）",
      };
    }
    // ② 读文件（与 canvas.loadWorkflowFile 同源的 userdata 读链）
    const res = await api.fetchApi("/api/userdata/" + encodeURIComponent(rel), { cache: "no-store" });
    if (!res.ok) throw new Error("读取工作流文件失败：HTTP " + res.status + "（" + rel + "）");
    const graph = await res.json();
    if (!graph || typeof graph !== "object") throw new Error("工作流文件不是合法 JSON 对象");
    if (typeof app.loadGraphData !== "function") throw new Error("前端没有 app.loadGraphData");
    const store = app && app.extensionManager && app.extensionManager.workflow;
    if (!store || typeof store.createNewTemporary !== "function") {
      throw new Error("前端没有 workflow store（app.extensionManager.workflow.createNewTemporary）");
    }
    // ③ 新开页（duplicate 同机制）：独立身份 id + 原文件名注册临时页（size=-1，未落盘；用户可在画布内自行另存）
    const state = JSON.parse(JSON.stringify(graph));
    state.id = newUuid(); // 独立身份（对齐原生 duplicateWorkflow；避免与来源页 id 关联歧义）
    const base = rel.split("/").pop().replace(/\.json$/i, "").trim() || "workflow";
    const wf = store.createNewTemporary(base + ".json", state); // 同步注册，path/key 立刻可读
    if (!wf || !wf.path) throw new Error("createNewTemporary 未返回工作流对象");
    const nodeCount = Array.isArray(state.nodes) ? state.nodes.length : null;
    // ④ 落账先于装载：回执超时后的重试据此去重（页已建才需要去重；未建成的错误路径不落账）
    const rec = { file: rel, at: Date.now(), page: wf.path, key: wf.key || null, nodeCount, failed: false };
    lastNewPageLoad = rec;
    // ⑤ 装载并激活新页（第 4 参传新页对象 wf → 活动页切为新页；装载期变更记 "system"）
    const sysWin = beginSystemWindow();
    const loadP = Promise.resolve(
      app.loadGraphData(state, true, true, wf, { checkForRerouteMigration: false, deferWarnings: false }),
    ).catch((e) => {
      rec.failed = true;
      console.warn(LOG_TAG, "新开页装载 loadGraphData 失败", e);
    });
    armSystemWindow(sysWin, loadP);
    await loadP;
    return {
      loaded: true, newPage: true, file: rel,
      page: wf.path, key: wf.key || null, nodeCount,
      note: "已新开一页并装载（不触碰原活动页）",
    };
  },

  "canvas.openWorkflow": async (args) => {
    const a = args || {};
    const target = String(a.path || a.name || "").trim();
    if (!target) throw new Error("需要 name 或 path");
    const svc = app.extensionManager && app.extensionManager.workflow;
    if (!svc) {
      throw new Error("前端没有 workflow store（app.extensionManager.workflow 不可用，版本不支持）");
    }
    // 先刷新工作流列表：前端列表在启动时加载，agent 之后新增的文件不在其中
    for (const m of ["syncWorkflows", "loadWorkflows"]) {
      try {
        if (typeof svc[m] === "function") { await svc[m](); break; }
      } catch { /* 刷新失败不阻断，下面按现有列表匹配 */ }
    }

    const aw = svc.activeWorkflow || null;
    const before = aw ? (aw.filename || aw.path || aw.name || null) : null;
    // 未保存保护：默认不抢掉人正在改的图。
    // 质检①（2026-10-08）：原判定只认 function 形式；v1.55.14 的 isModified 为布尔 getter
    // （ComfyWorkflow._isModified）→ function 判定恒 false、保护实际失效。改用 workflowDirty()
    // （兼容 getter / 函数两种形态；loadWorkflowFile 侧同点已走 workflowDirty，不受影响）。
    // P3-b（2026-10-21，issue #2）：先算 branch 用于「标注 + 日志」（这条指令到底是不是发给本页的）；
    // 拦/放口径与原来严格等价：原来 ⟺ dirty && force!==true，现 ⟺ dirty && branch!=="skipped-force"
    // （branch 只在 force===true 时取 skipped-force）。异页 sid 放行是错的：py 侧 sid 无命中/歧义时
    // 退化为广播，此时本页就是执行目标，放行等于丢掉用户未保存的编辑。
    const rawSid = a.sid;
    const hasSid = rawSid != null && String(rawSid).trim() !== "";
    const gateBranch = dirtyGateBranch(a.force === true, hasSid, hasSid ? sidTargetsSelf(rawSid) : null);
    let dirty = false;
    try { dirty = workflowDirty(aw); } catch { dirty = false; }
    const sidLog = hasSid ? String(rawSid).trim().slice(0, 8) : "(none)";
    const pageLog = before || "(未命名)";
    if (dirty && gateBranch !== "skipped-force") {
      console.info(LOG_TAG + " openWorkflow 脏保护拦截 sid=" + sidLog + " branch=" + gateBranch + " page=" + pageLog);
      return { opened: false, blocked: "dirty", activeBefore: before, dirtyCheck: gateBranch };
    }
    console.info(LOG_TAG + " openWorkflow 脏保护放行 sid=" + sidLog + " branch=" + gateBranch + " page=" + pageLog);

    // 在已保存的工作流里找目标（按 path 精确、按文件名/去扩展名的名字宽松）
    const list = (() => {
      try {
        const l = svc.workflows;
        if (Array.isArray(l)) return l;
        if (l && typeof l[Symbol.iterator] === "function") return [...l];
        if (l && typeof l === "object") return Object.values(l);
      } catch { /* 忽略 */ }
      return [];
    })();
    // 名匹配对齐 openWorkflowsInfo（2026-10-13）：候选名一律 trim 首尾空白——磁盘名可带尾空格
    //（如 "xxx (00012) .json"），上报端 trim 而比对端不 trim 会「列得出却打不开」。（与下方
    // canvas.activateWorkflow 同一口径。）
    const norm = (s) => String(s || "").trim().replace(/\\/g, "/").toLowerCase();
    const tNorm = norm(target);
    const tNoExt = tNorm.replace(/\.json$/, "");
    let hit = null;
    for (const w of list) {
      if (!w) continue;
      const p = norm(w.path);
      const f = norm(w.filename);
      const n = norm(w.name);
      if (tNorm === p || tNorm === f || tNorm === n) { hit = w; break; }
      if (tNoExt === p.replace(/\.json$/, "") || tNoExt === f.replace(/\.json$/, "") || tNoExt === n) { hit = w; break; }
    }
    if (!hit) {
      // 交回可选的候选名，便于上层解释「没找到」而不是静默失败
      return {
        opened: false,
        blocked: "not_found",
        activeBefore: before,
        candidates: list.slice(0, 40).map((w) => w && (w.path || w.filename || w.name)).filter(Boolean),
      };
    }

    // P1 修复（2026-10-08）：原实现只调 store 版 svc.openWorkflow(hit)——它只做「激活」
    // （push path → load → activeWorkflow.value 赋值），从不调 app.loadGraphData 触发画布重绘，
    // 留下「页面名 ≠ 画布内容」的半状态且无失败信号。这里改为完整装载，对齐 v1.55.14
    // workflowService.openWorkflow 的真实序列（settingStore 打包产物核对）：
    //   if (!hit.isLoaded) await hit.load(); → loadGraphData(clone(activeState), true, true, hit, …)
    // 因 /call 回传上限 6s（bridge/__init__.py CALL_TIMEOUT_SEC），不等待重绘完成：
    // 返回 pending:true + nodeCount + activeAfter（期望值），由 app 层落定校验后才报成功。
    const wasLoaded = !!hit.isLoaded;
    if (!wasLoaded) await hit.load();
    // 活动页的直接写入（如 agent 写 op）可能尚未进 changeTracker：先刷齐再读 activeState，
    // 否则 force 重载可能吞掉这批改动。非活动页为 no-op（isActiveTracker 守卫）。
    try { hit.changeTracker?.prepareForSave?.(); } catch { /* 刷不动时不阻断（按现有 activeState 装载） */ }
    const st = JSON.parse(JSON.stringify(hit.activeState));
    if (!st || typeof st !== "object") throw new Error("取不到 activeState（无法装载）");
    const nodeCount = Array.isArray(st.nodes) ? st.nodes.length : null;
    const expectAfter = hit.filename || hit.name || hit.path || null;
    // P6（2026-10-08）：装载窗口期间的变更记 source="system"（promise settle 或兜底超时后复位）。
    const sysWin = beginSystemWindow();
    const loadP = Promise.resolve(app.loadGraphData(st, true, true, hit, {
      checkForRerouteMigration: false,
      deferWarnings: false,
      skipAssetScans: wasLoaded && a.force !== true, // 对齐前端：已加载且非 force 时跳过资产扫描
    })).catch((e) => {
      console.warn(LOG_TAG, "openWorkflow loadGraphData 失败", e);
    });
    armSystemWindow(sysWin, loadP);
    return {
      opened: true,
      pending: true, // 快返：装载在页面内继续，app 层按 nodeCount / activeAfter 落定校验
      matched: (hit && (hit.path || hit.filename || hit.name)) || null,
      activeBefore: before,
      activeAfter: expectAfter,
      nodeCount,
      dirtyCheck: gateBranch,
      note: "已发起完整装载（异步）：装载完成后画布刷新并激活该工作流，调用方按 nodeCount / activeAfter 落定校验确认",
    };
  },

  // canvas.activateWorkflow（2026-10-13，A 档 S2）：把「已打开」的目标工作流切成前台（切标签）。
  // 与 canvas.openWorkflow 的区别：openWorkflow ＝「打开」（未打开时装载/新开 + dirty 保护，会拦）；
  // 本 op ＝「切标签」——不带 dirty 保护、不做列表匹配、只切「已打开」的标签，但同样走完整装载。
  // 语义边界：仅切「已打开」的标签；目标未打开 → 如实报错（不偷偷去打开，那属 openWorkflow 语义）。
  // 快返：不 await 重绘，立即回报由调用方落定校验 activeAfter / nodeCount。
  "canvas.activateWorkflow": async (args) => {
    const a = args || {};
    // 定向字段兼容：workflow 是工具层 / 中继传入的定向字段（与 app 侧指引、py 侧定向同源），
    // 此 op 兼容它——否则按指引用 workflow="<名>" 调用时 target 为空、直接抛错。
    const target = String(a.path || a.name || a.workflow || "").trim();
    if (!target) throw new Error("需要 name、path 或 workflow");
    const svc = app.extensionManager && app.extensionManager.workflow;
    if (!svc) {
      throw new Error("前端没有 workflow store（app.extensionManager.workflow 不可用，版本不支持）");
    }
    // 名匹配对齐 openWorkflowsInfo（2026-10-13）：候选名一律 trim 首尾空白——磁盘名可带尾空格
    //（如 "Qwen21 t2i 质量版 (00012) .json"），上报端已 trim、比对端不 trim 会「列得出却切不过去」。
    const norm = (s) => String(s || "").trim().replace(/\\/g, "/").toLowerCase();
    const tNorm = norm(target);
    const tNoExt = tNorm.replace(/\.json$/, "");
    // 目标解析：path 优先（getWorkflowByPath），拿不到再在 openWorkflows 里按 name/path 宽松匹配
    // （去 .json、大小写不敏感）。
    let hit = null;
    if (a.path) {
      try {
        if (typeof svc.getWorkflowByPath === "function") hit = svc.getWorkflowByPath(target) || null;
      } catch { hit = null; }
    }
    if (!hit) {
      const open = Array.isArray(svc.openWorkflows) ? svc.openWorkflows : [];
      for (const w of open) {
        if (!w) continue;
        if (tNorm === norm(w.path) || tNorm === norm(w.filename) || tNorm === norm(w.name)) { hit = w; break; }
        if (tNoExt === norm(w.path).replace(/\.json$/, "") || tNoExt === norm(w.filename).replace(/\.json$/, "") || tNoExt === norm(w.name)) { hit = w; break; }
      }
    }
    if (!hit) {
      throw new Error(`未打开的工作流：${target}（activateWorkflow 只切已打开的标签）`);
    }
    const aw = svc.activeWorkflow || null;
    const activeBefore = aw ? (aw.filename || aw.path || aw.name || null) : null;
    const activeAfter = hit.filename || hit.name || hit.path || null;
    const path = hit.path || null;
    // 已是 active：直接回报，不重复触发切标签
    if (aw && aw === hit) {
      return { activated: true, alreadyActive: true, activeAfter, path };
    }
    if (typeof app.loadGraphData !== "function") {
      throw new Error("前端没有 app.loadGraphData（版本不支持切标签装载）");
    }
    // 切标签＝完整装载（对齐前端「手点 Tab」的 workflowService.openWorkflow）：
    // 只改 activeWorkflow 指向会留「页名≠画布内容」半状态（P1 老坑，见本文件 canvas.openWorkflow 注释）。
    // 快返：loadGraphData 会等整图渲染，超前端 6s 回传上限 → 不 await，立即回报由调用方落定校验。
    const wasLoaded = !!hit.isLoaded;
    if (!wasLoaded) await hit.load();
    try { hit.changeTracker?.prepareForSave?.(); } catch { /* 刷不动不阻断 */ }
    const st = JSON.parse(JSON.stringify(hit.activeState));
    if (!st || typeof st !== "object") throw new Error("取不到 activeState（无法装载目标标签）");
    const nodeCount = Array.isArray(st.nodes) ? st.nodes.length : null;
    const sysWin = beginSystemWindow();
    const loadP = Promise.resolve(
      app.loadGraphData(st, true, true, hit, { checkForRerouteMigration: false, deferWarnings: false, skipAssetScans: wasLoaded }),
    ).catch((e) => { console.warn(LOG_TAG, "activateWorkflow loadGraphData 失败", e); });
    armSystemWindow(sysWin, loadP);
    return {
      activated: true, pending: true, // 快返：装载在页面内继续
      activeBefore, activeAfter, path, nodeCount,
      note: "已切到该标签（完整装载，画布稍后刷新）；调用方按 activeAfter / nodeCount 落定校验",
    };
  },

  // ── D1：画布执行 + 可视化（需 App 侧授权开闸；契约字段冻结）──────────────

  // 执行当前画布（等效点 Queue；front=true 等效 QueuePromptFront——前端以 number=-1 走 body.front）。
  // 快返：只提交不等执行。prompt_id 优先靠猴补 api.queuePrompt 捕获（E1 §2-a），
  // 捕获不到再用 /queue 前后差集兜底（E1 §2-b，仅取唯一新增项、不猜）。
  "canvas.queue": async (args) => {
    const a = args || {};
    const front = a.front === true;
    if (typeof app.queuePrompt !== "function") {
      throw new Error("前端没有 app.queuePrompt（版本不支持）");
    }
    let beforeIds = null;
    try {
      beforeIds = await queuePromptIds();
    } catch { beforeIds = null; }

    const orig = api.queuePrompt;
    let cap = null;
    let capErr = null;
    api.queuePrompt = async function (...callArgs) {
      try {
        const res = await orig.apply(this, callArgs);
        cap = res || null;
        return res;
      } catch (err) {
        capErr = err;
        throw err;
      }
    };
    // 提交来源（2026-10-14）：本次运行由 Agent 工具发起 → 置 "agent"，供常驻包装上报时读取。
    // 时序自证：orig = api.queuePrompt（= setup 装的常驻包装）→ 临时替换为捕获包装 →
    // app.queuePrompt → 捕获包装调 orig（常驻包装）→ 常驻包装读 historyCommitSource（此刻="agent"）
    // 上报 → 才回到本 finally 复位。故上报发生在复位之前 ✅。
    const prevCommitSource = historyCommitSource;   // 保存现场（防嵌套）
    historyCommitSource = "agent";
    try {
      await app.queuePrompt(front ? -1 : 0, 1);
    } finally {
      api.queuePrompt = orig;
      historyCommitSource = prevCommitSource;       // 还原
    }
    if (capErr) {
      throw new Error("提交被拒：" + String(capErr).slice(0, 400));
    }
    if (cap && cap.prompt_id) {
      return { queued: true, promptId: cap.prompt_id, number: cap.number, via: "app.queuePrompt" };
    }
    // 未捕获（如 processingQueue 忙时立即返回）：/queue 差集定位
    let fallbackId = null;
    if (beforeIds) {
      try {
        const afterIds = await queuePromptIds();
        const added = [...afterIds].filter((id) => !beforeIds.has(id));
        if (added.length === 1) fallbackId = added[0];
      } catch { /* 兜底失败不阻断 */ }
    }
    const out = { queued: true, via: "app.queuePrompt" };
    if (fallbackId) out.promptId = fallbackId;
    return out;
  },

  // 以当前画布为基础复制为新页（E1 §1 最小等效序列；原生 duplicateWorkflow 的逐行等效）。
  // 原布零改动：只读 activeState（含未保存改动）写进副本；副本页同步注册后立刻返回 path/key。
  "canvas.duplicate": async () => {
    const store = app && app.extensionManager && app.extensionManager.workflow;
    if (!store || typeof store.createNewTemporary !== "function") {
      throw new Error("前端没有 workflow store（app.extensionManager.workflow.createNewTemporary）");
    }
    const src = store.activeWorkflow;
    if (!src) throw new Error("没有活动工作流（activeWorkflow 为空）");
    await src.load(); // 已加载秒返
    const state = JSON.parse(JSON.stringify(src.activeState));
    if (!state || typeof state !== "object") {
      throw new Error("取不到 activeState（无法读取当前画布数据）");
    }
    state.id = newUuid();
    let base = String(src.filename || src.name || "").trim();
    base = base.replace(/\.json$/i, "").replace(/\s*\(\d+\)$/, "").trim();
    if (!base) base = "workflow";
    const wf = store.createNewTemporary(base + " (Copy).json", state); // 同步注册，path/key 立刻可读
    if (!wf || !wf.path) throw new Error("createNewTemporary 未返回工作流对象");
    if (typeof app.loadGraphData !== "function") throw new Error("前端没有 app.loadGraphData");
    // P6（2026-10-08）：装载窗口期间的变更记 source="system"（settle 或兜底超时后复位）；
    // await 语义保持原样（先按 await 实现，耗时见验收记录）。
    const sysWin = beginSystemWindow();
    const dupP = app.loadGraphData(state, true, true, wf);
    armSystemWindow(sysWin, dupP);
    await dupP;
    return { ok: true, page: wf.path, key: wf.key };
  },

  // 编辑可视化：lock / highlight / clear（契约 §3.2 三动作语义，防呆照做）。
  // lock      = 撤旧高亮 → 灰膜 +「小花正在操作…」+ read_only 置位（记录原值）
  // highlight = 先撤锁与旧高亮 → 节点 strokeStyles 黄标 + 连线黄标 → 重绘
  // clear     = 全撤（删膜 / 只还原自己改的 read_only / 删标记 / 重绘）
  // nodes: string[]；edges: [fromId,toId][]；无法定位的条目跳过并在返回里列出。
  "canvas.visual": (args) => {
    const a = args || {};
    const action = String(a.action || "").trim();
    if (action !== "lock" && action !== "highlight" && action !== "clear") {
      throw new Error("action 必须是 lock / highlight / clear");
    }
    if (action === "lock") {
      visualClearMarks(); // 撤旧高亮
      filmApply(typeof a.note === "string" && a.note ? a.note : "");
      visualLockReadOnly();
      app.graph.setDirtyCanvas(true, true);
      return { ok: true };
    }
    if (action === "clear") {
      filmRemove();
      visualRestoreReadOnly();
      visualClearMarks();
      app.graph.setDirtyCanvas(true, true);
      return { ok: true };
    }
    // highlight：先撤锁与旧高亮（契约）
    filmRemove();
    visualRestoreReadOnly();
    visualClearMarks();

    const missedNodes = [];
    const seenNodeIds = new Set();
    let nodeCount = 0;
    for (const raw of Array.isArray(a.nodes) ? a.nodes : []) {
      const id = raw === undefined || raw === null ? "" : String(raw).trim();
      const n = id ? findNode(id) : null;
      if (!n) {
        missedNodes.push(raw === undefined ? null : raw);
        continue;
      }
      if (seenNodeIds.has(String(n.id))) continue;
      seenNodeIds.add(String(n.id));
      if (!n.strokeStyles || typeof n.strokeStyles !== "object") n.strokeStyles = {};
      n.strokeStyles[COPILOT_STROKE_KEY] = () => ({ color: COPILOT_GOLD, lineWidth: 3, padding: 8 });
      copilotVisual.markedNodeIds.push(n.id);
      nodeCount += 1;
    }

    const missedEdges = [];
    let edgeLinkCount = 0;
    for (const pair of Array.isArray(a.edges) ? a.edges : []) {
      if (!Array.isArray(pair) || pair.length < 2) {
        missedEdges.push(pair === undefined ? null : pair);
        continue;
      }
      const hits = linksBetween(pair[0], pair[1]);
      if (!hits.length) {
        missedEdges.push([pair[0], pair[1]]);
        continue;
      }
      for (const l of hits) {
        if (copilotVisual.markedLinkIdSet.has(String(l.id))) continue;
        let prev = undefined;
        try { prev = l.color; } catch { prev = undefined; }
        copilotVisual.markedLinks.push({ id: l.id, prevColor: prev });
        copilotVisual.markedLinkIdSet.add(String(l.id));
        try { l.color = COPILOT_GOLD; } catch { /* 忽略 */ }
        edgeLinkCount += 1;
      }
    }
    if (copilotVisual.markedLinkIdSet.size > 0 && !ensureLinkRenderPatch()) {
      console.warn(LOG_TAG, "linkRenderer 不可用：连线黄标降级（节点黄标不受影响）");
    }
    app.graph.setDirtyCanvas(true, true);
    return { ok: true, nodes: nodeCount, edges: edgeLinkCount, missedNodes, missedEdges };
  },

  // 副驾驶开关（v2，2026-10-08）：Agent 按授权开启 / 关闭「当前活动页」的副驾驶（进入 / 退出驾驶位）。
  // 写方从「仅前端 UI」扩为「UI 与 Agent 双写方、均即时上报」（契约 §2 同批修订）。
  // 复用 copilotWriteState（localStorage 按页写）+ copilotUiRender（顶栏按钮刷新）+
  // pushStateSnapshot（即时上报，不等防抖）。返回 {enabled, pageKey, updatedAt}。
  // 拦截口径：本 op 豁免于写拦截（否则鸡生蛋——未开的布永远开不了）；开启权限由 app 层
  // 「允许 Agent 开启画布副驾驶」总闸管辖（桥读不到设置——该边界如实：桥侧对总闸无感知）。
  "canvas.copilot": (args) => {
    const a = args || {};
    if (a.enabled === undefined || a.enabled === null) {
      throw new Error("需要 enabled（true=开启 / false=关闭）");
    }
    const want = a.enabled === true;
    if (!copilotPageKey()) {
      throw new Error("没有活动工作流页（pageKey 不可得）：先在前端打开一张工作流");
    }
    const res = copilotWriteState(want);
    if (res.enabled !== want) {
      throw new Error("copilot 状态写入未生效（localStorage 不可写？）");
    }
    copilotUiRender();
    void pushStateSnapshot(); // 即时上报：开关语义要即时可查（不等下一次 pollGraph 防抖）
    return { enabled: res.enabled, pageKey: res.pageKey, updatedAt: res.updatedAt };
  },

  // ── 写入（P3；需 App 侧的授权开关打开）───────────────────────────────
  // 所有改图都包在 graph.beforeChange() / afterChange() 里：这是 LiteGraph 的变更记账，
  // 人的 Ctrl+Z（app.canvas.undo()）能像撤销自己操作一样撤销 agent 的改动。
  "canvas.setWidget": (args) => {
    const a = args || {};
    if (a.nodeId === undefined || a.nodeId === null || !a.name) throw new Error("需要 nodeId 与 name");
    const node = findNode(a.nodeId);
    if (!node) throw new Error("找不到节点：" + a.nodeId);
    const w = (node.widgets || []).find((x) => x.name === a.name);
    if (!w) throw new Error(`节点 #${a.nodeId} 没有名为 ${a.name} 的参数`);
    const before = w.value;
    app.graph.beforeChange();
    try {
      w.value = a.value;
      if (typeof w.callback === "function") {
        // 回调只为了触发联动 / 重绘；它报错不应把写入判成失败
        try { w.callback(a.value, app.canvas, node, [0, 0], null); } catch { /* 忽略 */ }
      }
    } finally {
      app.graph.afterChange();
    }
    pollGraph();
    const restore = before;
    const nodeId = node.id;
    pushUndo(`setWidget #${nodeId}.${a.name}`, () => {
      // 按 id 重寻节点（2026-09-28 修正）：节点可能被同批 removeNode 删除又被其逆操作重建，
      // 直接写旧对象会静默写空（历史病灶）；这里对着「现在的图」写，找不到则如实抛错。
      const n2 = findNode(nodeId);
      if (!n2) throw new Error(`#${nodeId} 已不在图中，无法回退 ${a.name}`);
      const w2 = (n2.widgets || []).find((x) => x.name === a.name);
      if (!w2) throw new Error(`#${nodeId} 的 ${a.name} 已不存在，无法回退`);
      withChange(() => {
        w2.value = restore;
        if (typeof w2.callback === "function") {
          try { w2.callback(restore, app.canvas, n2, [0, 0], null); } catch { /* 忽略 */ }
        }
      });
      pollGraph();
    });
    return {
      nodeId: node.id,
      type: node.type,
      name: a.name,
      before: clip(String(before)),
      after: clip(String(w.value)),
    };
  },

  // ── 结构写入（P3 扩展；需授权）──────────────────────────────────────
  // 加/删节点、连线、断线、mute/bypass。每个写 op 都把自己的逆操作压栈。
  "canvas.addNode": (args) => {
    const a = args || {};
    const type = String(a.type || "").trim();
    if (!type) throw new Error("需要 type（节点类型，如 KSampler）");
    const LG = liteGraph();
    if (!LG || typeof LG.createNode !== "function") throw new Error("当前前端没有 LiteGraph.createNode");
    const node = LG.createNode(type);
    if (!node) throw new Error(`未知节点类型：${type}（可用 op=workflows 或 /object_info 查可用类型）`);
    withChange(() => {
      if (Array.isArray(a.pos) && a.pos.length === 2) node.pos = a.pos.slice();
      if (a.title) node.title = String(a.title);
      app.graph.add(node);
    });
    pollGraph();
    pushUndo(`addNode #${node.id} ${type}`, () => {
      withChange(() => app.graph.removeNode(node));
      pollGraph();
    });
    return {
      nodeId: node.id,
      type: node.type,
      title: node.title,
      inputs: (node.inputs || []).map((i) => i.name),
      outputs: (node.outputs || []).map((o) => o.name),
      widgets: (node.widgets || []).map((w) => w.name),
    };
  },

  // moveNode：移动一个或多个节点到指定坐标。设计取舍：
  //   · 支持 nodes:[[id,x,y],...] 批量（排布场景一次改几十个，逐个调太慢）
  //   · 逆操作记录每个节点原坐标，undo 一次复原全部
  //   · 不自动撑分组框（框与节点是两件事，避免隐式副作用）
  "canvas.moveNode": (args) => {
    const a = args || {};
    let list = [];
    if (Array.isArray(a.nodes) && a.nodes.length) {
      for (const row of a.nodes) {
        if (!Array.isArray(row) || row.length < 3) {
          throw new Error("nodes \u6bcf\u9879\u987b\u4e3a [nodeId, x, y]");
        }
        const id = row[0];
        const x = Number(row[1]);
        const y = Number(row[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("\u8282\u70b9 " + id + " \u7684\u5750\u6807\u4e0d\u662f\u6709\u9650\u6570\u5b57");
        }
        list.push({ id, x, y });
      }
    } else {
      const id = a.nodeId;
      let x, y;
      if (Array.isArray(a.pos) && a.pos.length === 2) {
        x = Number(a.pos[0]); y = Number(a.pos[1]);
      } else {
        x = Number(a.x); y = Number(a.y);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("moveNode \u9700\u8981 pos:[x,y]\uff08\u6216 x/y\uff09\uff0c\u6216\u6279\u91cf nodes:[[id,x,y],...]");
      }
      list.push({ id, x, y });
    }

    for (const it of list) {
      if (!findNode(it.id)) throw new Error("\u627e\u4e0d\u5230\u8282\u70b9\uff1a" + it.id);
    }

    const before = list.map((it) => {
      const n = findNode(it.id);
      return { id: n.id, x: n.pos[0], y: n.pos[1] };
    });

    withChange(() => {
      for (const it of list) {
        const n = findNode(it.id);
        n.pos = [it.x, it.y];
      }
    });
    pollGraph();

    pushUndo("moveNode " + list.length + " \u4e2a\u8282\u70b9", () => {
      withChange(() => {
        for (const b of before) {
          const n = findNode(b.id);
          if (n) n.pos = [b.x, b.y];
        }
      });
      pollGraph();
    });

    // 可选：按「标题编号前缀」重建分组框（fitGroups:true）。
    // 为什么不能只"扩框"：moveNode 只动节点，旧框原地不动 → 框与节点的对应关系已经错了
    //（实测 outline：「③ 画布」框住 #5、「② 提示词」框住 #13/#15）。
    // 所以这里不信任旧框，按标题前缀重新指定成员并用 setGroup 重算 bounds。
    let fitted = 0;
    if (a.fitGroups === true) {
      const NUMERALS = "\u2460\u2461\u2462\u2463\u2464\u2465\u2466\u2467\u2468\u2469";
      const groups = liveGroupList(app.graph);
      const dist = new Map();   // 前缀 -> [节点 id]
      for (const it of list) {
        const n = findNode(it.id);
        if (!n) continue;
        const t = String(n.title || "").trim();
        const p = t && NUMERALS.indexOf(t[0]) >= 0 ? t[0] : "note";
        if (!dist.has(p)) dist.set(p, []);
        dist.get(p).push(n.id);
      }
      for (const [p, ids] of dist) {
        if (p === "note" && ids.length > 6) continue;   // 无编号主干太多，不套框
        // 找同名/同前缀的现有组
        let target = -1;
        for (let gi = 0; gi < groups.length; gi++) {
          const gt = String(groups[gi].title || "").trim();
          if (p !== "note" && gt && gt[0] === p) { target = gi; break; }
          if (p === "note" && (gt.startsWith("\u4f7f\u7528") || gt.startsWith("\u8bf4\u660e"))) { target = gi; break; }
        }
        const bounds = liveBoundsForNodes(ids);
        if (!bounds) continue;
        if (target >= 0) {
          const g = groups[target];
          withChange(() => applyGroupBounds(g, bounds));
          try { if (typeof g.recomputeInsideNodes === "function") g.recomputeInsideNodes(); } catch {}
          fitted++;
        } else {
          // 没有对应组：新建。构造器必须走 lgraphGroupCtor()——
          // 实测 LiteGraph.LGraphGroup 在部分前端拿不到，而 graph.add(e) 只认
          // e instanceof LGraphGroup，纯对象会被当成节点。
          try {
            const Ctor = lgraphGroupCtor();
            if (Ctor) {
              const g = new Ctor();
              g.title = p === "note" ? "\u4f7f\u7528\u8bf4\u660e" : p;
              g.color = "#3f789e";
              withChange(() => {
                applyGroupBounds(g, bounds);
                app.graph.add(g);
              });
              fitted++;
            }
          } catch { /* 建组失败不阻断移动 */ }
        }
      }
      if (fitted) pollGraph();
    }

    return {
      moved: list.length,
      nodes: list.map((it) => ({ id: it.id, pos: [it.x, it.y] })),
      groupsFitted: fitted,
    };
  },

  "canvas.removeNode": (args) => {
    const a = args || {};
    const node = findNode(a.nodeId);
    if (!node) throw new Error("找不到节点：" + a.nodeId);
    const graph = app.graph;
    // 先记完整序列化 + 它参与的连线，保证可回退（删是最重的操作）
    const snap = typeof node.serialize === "function" ? node.serialize() : null;
    const incoming = [];
    for (let si = 0; si < (node.inputs || []).length; si++) {
      const inp = node.inputs[si];
      if (inp && inp.link != null) {
        const l = graph.links && typeof graph.links.get === "function" ? graph.links.get(inp.link) : null;
        if (l) incoming.push({ origin_id: l.origin_id, origin_slot: l.origin_slot, target_slot: si });
      }
    }
    // 出线也得记：删除节点时它的出线会一并消失，不记就恢复不回来
    const outgoing = [];
    for (let so = 0; so < (node.outputs || []).length; so++) {
      const outs = (node.outputs[so] && node.outputs[so].links) || [];
      for (const lid of outs) {
        const l = graph.links && typeof graph.links.get === "function" ? graph.links.get(lid) : null;
        if (l) outgoing.push({ origin_slot: so, target_id: l.target_id, target_slot: l.target_slot });
      }
    }
    const removedId = node.id;
    const removedType = node.type;
    withChange(() => graph.removeNode(node));
    pollGraph();
    pushUndo(`removeNode #${removedId} ${removedType}`, () => {
      if (!snap) throw new Error("该节点不支持序列化，无法恢复");
      const LG = liteGraph();
      const n2 = LG && typeof LG.createNode === "function" ? LG.createNode(removedType) : null;
      if (!n2) throw new Error("恢复失败：无法重建 " + removedType);
      if (typeof n2.configure === "function") n2.configure(snap);
      withChange(() => graph.add(n2));
      for (const l of incoming) {
        const src = graph.getNodeById(l.origin_id);
        if (src && typeof src.connect === "function") {
          try { src.connect(l.origin_slot, n2, l.target_slot); } catch { /* 单个连线恢复失败不阻断 */ }
        }
      }
      for (const l of outgoing) {
        const tgt = graph.getNodeById(l.target_id);
        if (tgt && typeof n2.connect === "function") {
          try { n2.connect(l.origin_slot, tgt, l.target_slot); } catch { /* 同上 */ }
        }
      }
      pollGraph();
    });
    return { removed: removedId, type: removedType, incomingLinks: incoming.length, outgoingLinks: outgoing.length };
  },

  "canvas.connect": (args) => {
    const a = args || {};
    const from = findNode(a.fromNode);
    const to = findNode(a.toNode);
    if (!from || !to) throw new Error("找不到 fromNode 或 toNode");
    const outIdx = slotIndex(from.outputs, a.fromSlot);
    const inIdx = slotIndex(to.inputs, a.toSlot);
    if (outIdx < 0) throw new Error(`输出槽不存在：${a.fromSlot}（可用：${(from.outputs || []).map((o) => o.name).join(", ")}）`);
    if (inIdx < 0) throw new Error(`输入槽不存在：${a.toSlot}（可用：${(to.inputs || []).map((i) => i.name).join(", ")}）`);
    if (typeof from.connect !== "function") throw new Error("该节点不支持 connect");
    const graph = app.graph;
    // 直替保护（2026-09-28 修正）：目标槽已有连线时先记录——connect 会把它顶掉；
    // 逆操作负责「删新线 + 恢复旧线」，否则被替换的原连线不可恢复。
    const prevInp = to.inputs[inIdx];
    const replacedId = prevInp && prevInp.link != null ? prevInp.link : null;
    let prevRec = null;
    if (replacedId != null) {
      const pl = graph.links && typeof graph.links.get === "function" ? graph.links.get(replacedId) : null;
      if (pl) prevRec = { origin_id: pl.origin_id, origin_slot: pl.origin_slot, target_slot: inIdx };
    }
    let link = null;
    withChange(() => { link = from.connect(outIdx, to, inIdx); });
    pollGraph();
    const linkId = link && link.id != null ? link.id : null;
    pushUndo(`connect #${from.id} → #${to.id}`, () => {
      const errs = [];
      withChange(() => {
        if (linkId != null) {
          try { graph.removeLink(linkId); } catch (e) { errs.push(String((e && e.message) || e)); }
        }
        if (prevRec) {
          const src = graph.getNodeById(prevRec.origin_id);
          const tgt = findNode(to.id);
          if (src && tgt && typeof src.connect === "function") {
            try { src.connect(prevRec.origin_slot, tgt, prevRec.target_slot); } catch (e) { errs.push(String((e && e.message) || e)); }
          } else {
            errs.push(`原连线恢复失败：节点不可用（from=#${prevRec.origin_id}，to=#${to.id}）`);
          }
        }
      });
      pollGraph();
      if (errs.length) throw new Error("connect 逆操作未全部成功：" + errs.join("；"));
    });
    return { from: from.id, to: to.id, outSlot: outIdx, inSlot: inIdx, linkId, replaced: replacedId };
  },

  "canvas.disconnect": (args) => {
    const a = args || {};
    const node = findNode(a.nodeId);
    if (!node) throw new Error("找不到节点：" + a.nodeId);
    const inIdx = slotIndex(node.inputs, a.slot);
    if (inIdx < 0) throw new Error(`输入槽不存在：${a.slot}（可用：${(node.inputs || []).map((i) => i.name).join(", ")}）`);
    const inp = node.inputs[inIdx];
    const linkId = inp && inp.link != null ? inp.link : null;
    if (linkId == null) throw new Error(`输入 ${a.slot} 本来就没有连线`);
    const graph = app.graph;
    const l = graph.links && typeof graph.links.get === "function" ? graph.links.get(linkId) : null;
    const rec = l ? { origin_id: l.origin_id, origin_slot: l.origin_slot, target_slot: inIdx } : null;
    withChange(() => graph.removeLink(linkId));
    pollGraph();
    pushUndo(`disconnect #${node.id}.${inp.name || a.slot}`, () => {
      if (!rec) return;
      const src = graph.getNodeById(rec.origin_id);
      if (src && typeof src.connect === "function") {
        withChange(() => {
          try { src.connect(rec.origin_slot, node, rec.target_slot); } catch { /* 忽略 */ }
        });
        pollGraph();
      }
    });
    return { nodeId: node.id, slot: inp.name, linkId };
  },

  "canvas.setNodeMode": (args) => {
    const a = args || {};
    const node = findNode(a.nodeId);
    if (!node) throw new Error("找不到节点：" + a.nodeId);
    const mode = Number(a.mode);
    if (![0, 2, 4].includes(mode)) throw new Error("mode 必须是 0（正常）/ 2（mute）/ 4（bypass）");
    const before = node.mode;
    withChange(() => { node.mode = mode; });
    pollGraph();
    pushUndo(`setNodeMode #${node.id}`, () => {
      withChange(() => { node.mode = before; });
      pollGraph();
    });
    return {
      nodeId: node.id,
      mode,
      label: mode === 2 ? "mute" : mode === 4 ? "bypass" : "正常",
      before,
    };
  },

  // setNodeSize：设置节点尺寸，并可选折叠。
  // 为什么要折叠：纯功能节点（VAE 解码、各种 Loader、shift 位移）没有值得读的内容，
  // 展开状态白占画布面积（实测 VAE 解码 320x180，折叠后 300x32，省 82%）。
  "canvas.setNodeSize": (args) => {
    const a = args || {};
    const node = findNode(a.nodeId);
    if (!node) throw new Error("找不到节点：" + a.nodeId);
    const wantCollapse = a.collapsed === true;

    let w = null, h = null;
    if (Array.isArray(a.size) && a.size.length === 2) {
      w = Number(a.size[0]); h = Number(a.size[1]);
    } else {
      if (a.width !== undefined) w = Number(a.width);
      if (a.height !== undefined) h = Number(a.height);
    }
    if (w !== null && (!Number.isFinite(w) || w <= 0)) throw new Error("width 需为正数");
    if (h !== null && (!Number.isFinite(h) || h <= 0)) throw new Error("height 需为正数");
    if (w === null && h === null && !wantCollapse) {
      throw new Error("setNodeSize 需要 size:[w,h]（或 width/height），或 collapsed:true");
    }

    const before = {
      size: Array.isArray(node.size) ? [node.size[0], node.size[1]] : null,
      collapsed: !!(node.flags && node.flags.collapsed),
    };

    withChange(() => {
      if (w !== null && h !== null) {
        node.size = [w, h];
      } else {
        const cur = Array.isArray(node.size) ? node.size : [300, 100];
        node.size = [w !== null ? w : cur[0], h !== null ? h : cur[1]];
      }
      if (wantCollapse || a.collapsed === false) {
        node.flags = node.flags || {};
        node.flags.collapsed = wantCollapse;
      }
    });
    pollGraph();

    pushUndo("setNodeSize #" + node.id, () => {
      const cur = findNode(node.id);
      if (!cur) return;
      withChange(() => {
        if (before.size) cur.size = [before.size[0], before.size[1]];
        cur.flags = cur.flags || {};
        cur.flags.collapsed = before.collapsed;
      });
      pollGraph();
    });

    return {
      nodeId: node.id,
      size: [node.size[0], node.size[1]],
      collapsed: !!(node.flags && node.flags.collapsed),
      before,
    };
  },

  // ── live 分组（缺口 #5，2026-10-13；与 file 版 canvas-edit.mjs 同语义）──────────
  // 归属口径：ComfyUI 归组靠「节点 pos 落在 group 边界内」（graphBlocks 同口径），
  // 故自动 bounds 必须真框住 nodeIds（内含 GROUP_PAD 外扩）；显式 bounds 由调用方自担是否正确。
  "canvas.addGroup": (args) => {
    const a = args || {};
    if (typeof a.title !== "string" || !a.title.trim()) throw new Error("需要 title（非空字符串）");
    const title = a.title.trim();
    const hasBounds = a.bounds !== undefined && a.bounds !== null;
    const hasIds = Array.isArray(a.nodeIds);
    if (hasIds && a.nodeIds.length === 0) throw new Error("nodeIds 需为非空数组（节点 id 列表）");
    let bounds;
    if (hasBounds) {
      bounds = asBounds4(a.bounds, "bounds");
      if (hasIds) for (const id of a.nodeIds) { if (!findNode(id)) throw new Error(`找不到节点：#${id}`); }
    } else if (hasIds) {
      bounds = liveBoundsForNodes(a.nodeIds);
    } else {
      bounds = GROUP_DEFAULT_BOUNDS.slice();
    }
    const Ctor = lgraphGroupCtor();
    if (!Ctor) throw new Error("当前前端拿不到 LGraphGroup 构造器（window.LGraphGroup / LiteGraph.LGraphGroup 均不可用）");
    const graph = app.graph;
    const g = new Ctor(title);
    // 显式 bounds 先设，再入图（graph.add 会 mintGroupId + attachGroupLayout，用当前 pos/size 建 layout）
    applyGroupBounds(g, bounds);
    if (a.color !== undefined && a.color !== null && String(a.color).trim()) g.color = String(a.color);
    withChange(() => graph.add(g));
    // 显式归属（若前端支持；拿不到就靠 bounds 内含判据，见上方口径注释）
    try { if (typeof g.recomputeInsideNodes === "function") g.recomputeInsideNodes(); } catch { /* 归属非必需，失败不阻断 */ }
    pollGraph();
    pushUndo(`addGroup「${title}」`, () => {
      withChange(() => {
        if (typeof graph.remove === "function") graph.remove(g);
        else {
          const arr = liveGroupList(graph);
          const i = arr.indexOf(g);
          if (i >= 0) arr.splice(i, 1);
        }
      });
      pollGraph();
    });
    const groups = liveGroupList(graph);
    const index = groups.indexOf(g);
    const rect = liveGroupRect(g) || bounds;
    // 实际框住的节点数（pos 落在框内，含边界），供调用方核对归属是否如预期
    let nodeCount = hasIds ? a.nodeIds.length : 0;
    if (!hasIds) {
      for (const n of nodeList(graph)) {
        const p = n && n.pos;
        if (p && typeof p[0] === "number" && typeof p[1] === "number"
          && p[0] >= rect[0] && p[0] <= rect[0] + rect[2] && p[1] >= rect[1] && p[1] <= rect[1] + rect[3]) nodeCount += 1;
      }
    }
    return { ok: true, index, title, bounds: rect, nodeCount };
  },

  "canvas.setGroup": (args) => {
    const a = args || {};
    const gi = locateLiveGroup(a);
    const g = liveGroupList(app.graph)[gi];
    const hasTitle = a.title !== undefined && a.title !== null;
    const hasIds = Array.isArray(a.nodeIds);
    const hasBounds = a.bounds !== undefined && a.bounds !== null;
    if (hasIds && a.nodeIds.length === 0) throw new Error("nodeIds 需为非空数组（节点 id 列表）");
    if (!hasTitle && !hasIds && !hasBounds) {
      throw new Error("setGroup 没有可变更内容：需给 title（改名）/ nodeIds（重算 bounds）/ bounds（显式矩形）至少一项");
    }
    const beforeTitle = g.title;
    const beforeBounds = liveGroupRect(g);
    let nextTitle = beforeTitle;
    let nextBounds = beforeBounds;
    if (hasTitle) {
      if (typeof a.title !== "string" || !a.title.trim()) throw new Error("title 需为非空字符串");
      nextTitle = a.title.trim();
    }
    if (hasBounds) nextBounds = asBounds4(a.bounds, "bounds");
    else if (hasIds) nextBounds = liveBoundsForNodes(a.nodeIds);
    withChange(() => {
      if (hasTitle) g.title = nextTitle;
      if (nextBounds) applyGroupBounds(g, nextBounds);
    });
    try { if (hasIds && typeof g.recomputeInsideNodes === "function") g.recomputeInsideNodes(); } catch { /* 同上 */ }
    pollGraph();
    pushUndo(`setGroup #${gi}「${beforeTitle}」`, () => {
      const cur = liveGroupList(app.graph)[gi];
      if (!cur) throw new Error(`组 index ${gi} 已不在图中，无法回退`);
      withChange(() => {
        cur.title = beforeTitle;
        if (beforeBounds) applyGroupBounds(cur, beforeBounds);
      });
      pollGraph();
    });
    return { ok: true, index: gi, title: g.title, bounds: liveGroupRect(g) || nextBounds, changed: { title: hasTitle, bounds: hasBounds || hasIds } };
  },

  "canvas.removeGroup": (args) => {
    const a = args || {};
    const graph = app.graph;
    const gi = locateLiveGroup(a);
    const g = liveGroupList(graph)[gi];
    const snap = {
      title: g && g.title != null ? String(g.title) : "",
      bounds: liveGroupRect(g) || GROUP_DEFAULT_BOUNDS.slice(),
      color: g ? g.color : undefined,
      flags: g && g.flags ? JSON.parse(JSON.stringify(g.flags)) : undefined,
    };
    withChange(() => {
      if (typeof graph.remove === "function") graph.remove(g);
      else {
        const arr = liveGroupList(graph);
        const i = arr.indexOf(g);
        if (i < 0) throw new Error(`组 index ${gi} 已不在图中`);
        arr.splice(i, 1);
      }
    });
    pollGraph();
    pushUndo(`removeGroup「${snap.title}」`, () => {
      const Ctor = lgraphGroupCtor();
      if (!Ctor) throw new Error("恢复失败：拿不到 LGraphGroup 构造器");
      const g2 = new Ctor(snap.title);
      applyGroupBounds(g2, snap.bounds);
      if (snap.color != null) g2.color = snap.color;
      if (snap.flags) g2.flags = snap.flags;
      withChange(() => graph.add(g2));
      try { if (typeof g2.recomputeInsideNodes === "function") g2.recomputeInsideNodes(); } catch { /* 同上 */ }
      pollGraph();
    });
    return { ok: true, index: gi, title: snap.title, bounds: snap.bounds, removed: true };
  },

  // 落盘（P2 修复，2026-10-08）：改走前端正规保存链，目标语义＝真保存——
  //   ① 同名保存：保留 .bak 步骤 → wf.changeTracker.prepareForSave() 刷齐 → svc.saveWorkflow(wf)
  //      （store 版 → wf.save() 全链：写盘 + changeTracker.reset + isModified=false + 清 draft）；
  //   ② 另存并切换（name=新名）：按 isTemporary 分叉（2026-10-14，方案 §4）——
  //      临时画布 → svc.renameWorkflow(wf, newPath) + svc.saveWorkflow(wf)（**保 id**，历史自动跟随）；
  //      已存文件 → svc.saveAs(wf, newPath)（换新 id，= 用户决策①「分家」）→ adopted.load() →
  //      app.loadGraphData(clone(activeState), true, true, adopted) → svc.saveWorkflow(adopted)；
  //      目标文件已存在先明确报错（不写任何文件）；
  //   ③ 另存链含重绘，可能超 /call 6s 回传上限 → 限时等待（同 P1 pending 口径），
  //      未按预算完成时返回 pending:true，由 app 层落定校验（节点数/落点/文件落盘）后报成功。
  // 备份语义（2026-09-28；P2 保留）：.bak.json = 「覆盖前的磁盘旧文件」——先读旧文件、写到 .bak，
  // 再走保存链；磁盘上没有旧文件时不写 .bak（backup=null）。备份失败不阻断主保存。
  "canvas.save": async (args) => {
    const a = args || {};
    const wf = activeWorkflowObj();
    if (!wf) throw new Error("没有活动工作流：先在前端打开/保存过一张工作流");
    const svc = app && app.extensionManager && app.extensionManager.workflow;
    if (!svc || typeof svc.saveWorkflow !== "function" || typeof svc.saveAs !== "function") {
      throw new Error("前端没有 workflow store（saveWorkflow / saveAs 不可用，版本不支持）");
    }
    const curName = String(wf.filename || wf.name || "").trim();
    const raw = String(a.name || curName || "").trim();
    if (!raw) throw new Error("无法确定工作流名：传 {name}，或先在前端打开/保存过一张工作流");
    // 质检②（2026-10-08）：临时页（Unsaved Workflow，无文件路径）且未传 name → 显式报错。
    // 旧行为：把「Unsaved Workflow.json」当真实文件直接落盘（静默写出非预期文件；已有同名时报 409）；
    // 若经上游服务链（saveWorkflowAs → promptSave）则是弹窗等人输入的面。统一要求显式传 name
    // （走另存并切换链，新建 workflows/<name>.json），消除静默落盘 / 等待面。
    if (!String(a.name || "").trim() && workflowTemporary(wf)) {
      throw new Error(
        `当前页是临时工作流「${wf.filename || wf.name || "Unsaved Workflow"}」（无文件路径）：保存需显式传 name=<工作流名>（将新建 workflows/<name>.json 并切换）`,
      );
    }
    const clean = raw.replace(/\.json$/i, "");
    const curClean = curName.replace(/\.json$/i, "");
    // 读磁盘旧文件（用于 .bak 与「目标已存在」预检）；失败/不存在返回 null。
    // 路径要带 workflows/ 前缀：/api/userdata/<file> 的 <file> 是相对 user/default/ 的，
    // 不带前缀会写到 user/default/ 根下（实测踩过）。
    const readOld = async (file) => {
      try {
        const old = await api.fetchApi(`/api/userdata/${encodeURIComponent(file)}`, { cache: "no-store" });
        return old.ok ? await old.text() : null;
      } catch { return null; }
    };

    if (clean !== curClean) {
      // ── ② 另存并切换 ─────────────────────────────────────────────
      const newPath = `workflows/${clean}.json`;
      if ((await readOld(newPath)) != null) {
        throw new Error(`另存目标已存在：${newPath}（请换一个名字；本次未写任何文件）`);
      }
      if (!wf.isLoaded) await wf.load();
      try { wf.changeTracker?.prepareForSave?.(); } catch { /* 刷不动时按现有 activeState 继续 */ }
      if (!wf.activeState) throw new Error("取不到当前图内容（activeState 为空），无法另存");
      // 2026-10-14（方案 §4）：保存路径对齐前端语义。
      //   临时画布（无文件路径）保存为正式名 → rename 链，**保 id**（历史自动跟随，修用户报的 bug）。
      //   已存文件另存新名 → 维持 saveAs → 换新 id（= 用户决策①「分家」）。
      // renameWorkflow 按版本可能不存在 → 特性探测（typeof），拿不到回退原 saveAs 链，并在返回标 note。
      const renameWorkflowFn = typeof svc.renameWorkflow === "function" ? svc.renameWorkflow : null;
      if (workflowTemporary(wf) && renameWorkflowFn) {
        // rename 链：原地改名保 id（同 wf 对象、不重绘不切页），改名后落盘。
        let renamed = false;
        let renameFailed = null;
        try {
          await renameWorkflowFn.call(svc, wf, newPath);
          await svc.saveWorkflow(wf);
          renamed = true;
        } catch (e) {
          renameFailed = e;
          console.warn(LOG_TAG, "临时画布 rename 保存链失败", e);
        }
        if (renameFailed) {
          throw new Error(`临时画布改名保存失败：${(renameFailed && renameFailed.message) || renameFailed}`);
        }
        const rNodeCount = Array.isArray(wf.activeState && wf.activeState.nodes) ? wf.activeState.nodes.length : null;
        const rAfter = wf.filename || wf.name || wf.path || null;
        return {
          saved: wf.path || newPath,
          savedAs: true,
          renamed: true,
          idKept: true,
          switched: renamed,
          pending: false,
          nodes: rNodeCount,
          nodeCount: rNodeCount,
          backup: null,
          activeBefore: curName || null,
          activeAfter: rAfter,
          note: "临时画布保存为正式名（保留身份 id）：历史自动跟随",
        };
      }
      const renameFallback = workflowTemporary(wf) && !renameWorkflowFn;
      if (renameFallback) {
        console.warn(LOG_TAG, "svc.renameWorkflow 不可用（版本不支持）→ 临时画布保存回退 saveAs 链（将换新 id）");
      }
      const adopted = svc.saveAs(wf, newPath);
      if (!adopted) throw new Error("saveAs 未返回新工作流（版本不支持？）");
      await adopted.load();
      const st = JSON.parse(JSON.stringify(adopted.activeState));
      if (!st || typeof st !== "object") throw new Error("另存副本取不到 activeState");
      const nodeCount = Array.isArray(st.nodes) ? st.nodes.length : null;
      const expectAfter = adopted.filename || adopted.name || adopted.path || null;
      // 重绘 + 落盘（完整链）可能超过 /call 6s 回传上限 → 限时等待；未完成返回 pending，
      // 由 app 层按 nodeCount / activeAfter 落定校验（并核对文件落盘）后再报成功（同 P1 口径）。
      let done = false;
      let failed = null;
      const chain = (async () => {
        try {
          // P6（2026-10-08）：装载窗口期间的变更记 source="system"（settle 或兜底超时后复位）。
          const sysWin = beginSystemWindow();
          const loadP = app.loadGraphData(st, true, true, adopted, {
            checkForRerouteMigration: false,
            deferWarnings: false,
            skipAssetScans: true, // 对齐前端：副本已加载（非 force）时跳过资产扫描
          });
          armSystemWindow(sysWin, loadP);
          await loadP;
          await svc.saveWorkflow(adopted);
          done = true;
        } catch (e) {
          failed = e;
          console.warn(LOG_TAG, "另存并切换链失败", e);
        }
      })();
      await Promise.race([chain, sleep(SAVE_CHAIN_BUDGET_MS)]);
      if (failed) throw new Error(`另存并切换失败：${(failed && failed.message) || failed}`);
      // 2026-10-14：另存改名 → 把旧名（curName）的历史迁移到新名（expectAfter）。
      // fire-and-forget；后端未就绪/404 静默失败，不阻断保存。① 同名保存链不在此分支，不调用。
      reportHistoryMigrate(curName, expectAfter);
      return {
        saved: newPath,
        savedAs: true,
        switched: done,
        pending: !done,
        nodes: nodeCount,
        nodeCount,
        backup: null,
        activeBefore: curName || null,
        activeAfter: expectAfter,
        note: (renameFallback ? "（临时画布但 renameWorkflow 不可用，已回退 saveAs：将换新 id）" : "") + (done ? "另存并切换与落盘已完成" : "另存链已发起（异步）：重绘/落盘稍后完成，按落定校验确认"),
      };
    }

    // ── ① 同名保存（前端正规保存链）─────────────────────────────
    let backup = null;
    {
      const file = `workflows/${clean}.json`;
      const oldBody = await readOld(file);
      if (oldBody != null) {
        try {
          const res = await api.fetchApi(`/api/userdata/${encodeURIComponent(`workflows/${clean}.bak.json`)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: oldBody,
          });
          if (res.ok) backup = `workflows/${clean}.bak.json`;
        } catch { /* 备份失败不阻断主保存 */ }
      }
    }
    if (!wf.isLoaded) await wf.load();
    try { wf.changeTracker?.prepareForSave?.(); } catch { /* 刷不动时按现有 activeState 继续 */ }
    if (!wf.activeState) throw new Error("取不到当前图内容（activeState 为空），无法保存");
    await svc.saveWorkflow(wf); // 全链：写盘 + changeTracker.reset + 清 dirty + 清 draft
    const st = wf.activeState;
    return {
      saved: wf.path || `workflows/${clean}.json`,
      savedAs: false,
      backup,
      nodes: Array.isArray(st && st.nodes) ? st.nodes.length : nodeList(app.graph).length,
      dirtyCleared: !workflowDirty(wf),
    };
  },

  // 撤销最后一步。先试官方命令（与人的 Ctrl+Z 同一条路），再按 agent 自己的逆操作栈回退。
  // 实测：新版 @comfyorg/litegraph 已移除 LGraphCanvas.undo，撤销由 ChangeTracker + 命令系统接管，
  // 而它**不记录外部对 graph 的直接修改**——所以真正生效的是下面这个栈（精确回退 agent 那一步，
  // 不会动人在此期间的改动）。
  "canvas.undo": async () => {
    let via = null;
    const cmd = app.extensionManager && app.extensionManager.command;
    if (cmd && typeof cmd.execute === "function") {
      try { await cmd.execute("Comfy.Undo"); via = "Comfy.Undo"; } catch { /* 忽略 */ }
    } else if (app.canvas && typeof app.canvas.undo === "function") {
      app.canvas.undo();
      via = "canvas.undo";
    }
    pollGraph();
    const last = writeStack.pop();
    if (!last) {
      return { ok: true, via, note: "已执行撤销，未发现 agent 的待回退改动" };
    }
    try {
      await last.undo();
    } catch (err) {
      writeStack.push(last); // 没撤成，放回栈里，不吞错
      throw new Error(`撤销「${last.label}」失败：${(err && err.message) || err}`);
    }
    pollGraph();
    return { ok: true, via: "agent-rewind", undone: last.label, at: last.at, stackLeft: writeStack.length };
  },

  // 意图级写：多编辑一次提交（事务契约见上方「patch 事务」注释块）。
  // 事务失败不抛出：以 data 层 {ok:false,…} 正常返回（通道层保持 ok）。
  "canvas.patch": async (args) => {
    const a = args || {};
    if (patchInFlight) throw new Error("已有 patch 在执行中：同页并发 patch 已拒绝（请等前一次结束再试）");
    const list = parsePatchEdits(a.edits);
    if (a.dryRun === true) return runPatchDryRun(list);
    return runPatchTransaction(list, { verify: a.verify !== false });
  },
};

// ── 壳页协同（修订 1.2，2026-10-09）：向 parent 壳页宣告本实例身份 ─────────────
// 背景：验收环境 iframe 为跨源直连（auto 首选 direct；http://127.0.0.1:8188），壳页读不到
// iframe 内容（comfyWin() 属性读取被跨源拦），而「放入 hui 画布」的定向直发需要知道
// 「本壳 iframe 里这个实例的 clientId」。postMessage 是该跨源条件下唯一可用通道。
// 用途：壳页把 clientId 随 handoff/peek 上报给 App 服务端（定向目标记录）；同时供诊断。
// 数据仅 {clientId, href, build}（非敏感）；targetOrigin="*" 系跨源必要设定（壳页 origin
// 不可预知：宿主代理路径或 127.0.0.1:8188 直连）；壳页侧按 event.source===自家 iframe 校验。
function announceToShell() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "hana.bridge.announce", clientId: api.clientId || null, href: location.href, build: BUILD_TAG },
        "*",
      );
    }
  } catch (err) { console.warn(LOG_TAG, "壳页宣告失败", err); }
}

// 壳页可按需主动问询（自愈：壳页 reload/缓存丢失时不必等下一次自动宣告）。
// 只响应「来自 parent」的查询，回推与自动宣告同形的消息。
window.addEventListener("message", (e) => {
  try {
    const d = e && e.data;
    if (!d || typeof d !== "object" || d.type !== "hana.bridge.whoami") return;
    if (!window.parent || window.parent === window || e.source !== window.parent) return;
    announceToShell();
  } catch { /* 响应失败静默 */ }
});

// 诊断出口（只读）：用于确认“当前页面加载的是哪一版脚本、当前 revision 多少”。
// 只暴露版本与计数，不做任何写操作、也不抛出内部对象。
window.__hanaBridge = {
  version: "p4.0",
  build: BUILD_TAG,
  ops: Object.keys(OPS),
  state: () => ({
    version: "p4.0",
    revision: graphRevision,
    lastChangeAt: changes.length ? changes[changes.length - 1].at : null,
    nodes: lastSignature ? lastSignature.nodeCount : null,
    links: lastSignature ? lastSignature.linkCount : null,
  }),
};

async function postJson(path, body) {
  return api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

// 改名迁移历史目录（2026-10-14）：fire-and-forget；后端未就绪/404 静默失败，不影响保存。
function reportHistoryMigrate(from, to) {
  try {
    if (!from || !to || from === to) return;
    void postJson("/hana_bridge/history-migrate", { from, to }).catch(() => {});
  } catch { /* 忽略 */ }
}

// ── P1-A2（2026-10-11）：api.queuePrompt 常驻包装（画布提交历史 · 捕获点）────────
// 旧口径只在 canvas.queue op 内「临时」替换 api.queuePrompt（第 1546 行存原函数、第 1549 行替换、
// 第 1562 行还原），用完即还 → 只有 agent 触发那一次能捕获，用户点「运行」/Ctrl+Enter 抓不到。
// 本包装改在扩展 setup() 里安装一次、不再还原，覆盖任何经前端 api.queuePrompt 的提交
// （按钮 onClick → 命令 Comfy.QueuePrompt → app.queuePrompt → api.queuePrompt → POST /prompt，
//  代码确证：全部前端来源都汇于此，且前端不会重写该方法）。
// 边界（硬性）：只读包装 —— 不改返回值、不改调用时机；上报失败绝不影响原生提交（整段吞掉 + console.warn）。
// P1-C2（2026-10-11）：上报目标改道桥 Python 后端（同源可达，随 8188 相对路径走）。
// 端点 /hana_bridge/history-commit 由 P1-C1 并行实现（Python 端直接落盘）；未就绪时静默失败。
const HISTORY_COMMIT_PATH = "/hana_bridge/history-commit";
let queuePromptCaptureInstalled = false;

// 2026-10-24：提交 → 出图产物的身份接力。
// 出图产物回填（reportHistoryImages）发生在 execution_success，距提交数秒到数分钟；
// 那时现取工作流名，切了画布就会解析到另一张画布的目录 → 按 promptId 查不到 → 404 丢缩略图
//（不会写错历史，但图挂不上）；而且它重试 8 次、每次重新现取，等于 8 次都可能落在错的画布上。
// 修法与提交一致：提交那一刻把身份记下来，回填时按 promptId 取回。
const commitIdentityByPromptId = new Map(); // promptId → { identity, at }
const COMMIT_IDENTITY_TTL_MS = 10 * 60 * 1000;

function rememberCommitIdentity(promptId, identity) {
  if (!promptId || !identity) return;
  const now = Date.now();
  // 顺带清理过期项（批量出图时可能长期不触发清理，这里每次写入扫一遍）
  for (const [k, v] of commitIdentityByPromptId) {
    if (now - v.at > COMMIT_IDENTITY_TTL_MS) commitIdentityByPromptId.delete(k);
  }
  commitIdentityByPromptId.set(promptId, { identity, at: now });
}

function commitIdentityOf(promptId) {
  const hit = promptId ? commitIdentityByPromptId.get(promptId) : null;
  return hit ? hit.identity : null;
}

// 安装常驻包装（幂等）。在 setup() 里调用一次。
function installQueuePromptCapture() {
  if (queuePromptCaptureInstalled) return;
  if (typeof api.queuePrompt !== "function") {
    console.warn(LOG_TAG, "常驻提交捕获跳过：api.queuePrompt 不存在（前端版本不支持）");
    return;
  }
  const orig = api.queuePrompt;
  api.queuePrompt = async function (...callArgs) {
    // 抓图：调用原函数「之前」，抓当前画布 UI 格式 JSON。
    // 复用桥里已有的序列化路径 —— canvas.get op 就是 app.graph.toJSON()（第 1171 行），不另写一套。
    // 2026-10-24：图与身份（identity）在同一同步块里抓，中间无 await；source 也一并快照。
    let graph = null;
    let identity = null;
    const sourceSnap = historyCommitSource;
    try {
      if (app && app.graph && typeof app.graph.toJSON === "function") {
        graph = app.graph.toJSON();
        identity = captureWorkflowIdentity();
      }
    } catch (err) {
      console.warn(LOG_TAG, "提交前抓画布失败（不影响提交）", err);
    }
    // 只读：原样透传返回值与抛错时机。
    const r = await orig.apply(this, callArgs);
    // 上报在原生提交之后、fire-and-forget；任何失败都不回抛（否则会污染原生提交链路）。
    try {
      const promptId = r && r.prompt_id ? r.prompt_id : null;
      // 口径修正（P1-C2）：抓图失败时不上报 —— graph 为 null/undefined/无 nodes 的空对象一律跳过
      // （空快照无意义，还白占一个 seq）。
      const hasGraph = graph && graph.nodes && Object.keys(graph.nodes).length > 0;
      if (promptId && hasGraph) {
        // P2-F2：抓图后、上报前算「块归属」（每个 group 含哪些节点）；计算失败只降级
        // （blocks=null → 上报不带该字段），绝不影响原生提交链路。
        let blocks = null;
        try {
          blocks = graphBlocks(graph);
        } catch (err) {
          console.warn(LOG_TAG, "提交快照块归属计算失败（不影响上报）", err);
        }
        // 2026-10-24：记下 promptId → 身份，供出图产物回填时取回（见 commitIdentityOf）
        rememberCommitIdentity(promptId, identity);
        void reportHistoryCommit({ graph, promptId, blocks, source: sourceSnap, identity });
      }
    } catch (err) {
      console.warn(LOG_TAG, "提交历史上报失败（不影响提交）", err);
    }
    return r;
  };
  queuePromptCaptureInstalled = true;
}

// HEAD 由后端 .head.json 持有，前端不落 localStorage（2026-10-23；原 hana.history.head.v1:* 写入已清）。

// pageKey = activeWorkflow.path（fallback：key → name）；取不到返回 null（同 copilotPageKey 口径）
function historyPageKey() {
  try {
    const wf = activeWorkflowObj();
    if (!wf) return null;
    const p = wf.path ? String(wf.path).trim() : "";
    if (p) return p;
    const k = wf.key ? String(wf.key).trim() : "";
    if (k) return k;
    const n = String(wf.filename || wf.name || "").trim();
    return n || null;
  } catch {
    return null;
  }
}

// 上报一次提交（契约字段冻结，勿改字段名）：POST /hana_bridge/history-commit
// ⚠️ P1-C2：目标改道桥 Python 后端（同源）；端点由 P1-C1 并行实现，未就绪时静默失败。
// P5b：增 source / kind（可选参，默认 "user" / "run"，为 P8 agent 通道预留）与可选 parent
//      （不传 → body 不带该字段，后端自己定）。读响应判 merged：
//      未合并 / 合并 → HEAD 均由后端 .head.json 维护，前端不跟。
//
// 2026-10-23 修（HEAD 移交后端持久化，见 docs/方案-修复提交图泳道与HEAD-20261023.md §3.3）：
//   父节点不再由前端决定。用户提交路径不往 body 写 parent，后端按 <history_dir>/.head.json 定链；
//   调用方显式传 parent（agent 通道等）才原样透传。
async function reportHistoryCommit({ graph, promptId, blocks, source = "user", kind = "run", parent = null, identity = null }) {
  try {
    // 2026-10-24：身份优先用调用方在「抓图那一刻」捕获的快照（identity），缺省才现取。
    // 现取等于在 await 之后取，提交期间切画布就会把快照写进另一张画布的历史。
    let workflow = null;
    try {
      workflow = identity && identity.name ? identity.name : currentWorkflowInfo().name;
    } catch {
      workflow = null;
    }
    const at = new Date().toISOString();
    const body = {
      workflow,
      promptId,
      graph: graph || {},
      at,
      source: source || "user",
      kind: kind || "run",
    };
    // P5b → 2026-10-23：parent 交给后端（.head.json）。
    // 仅当调用方显式给了 parent（agent 通道等）才透传；用户提交路径不带该字段。
    if (parent != null) body.parent = parent;
    // P2-F2：块归属（[{name, source:"group"|"role", nodeIds:[…]}]）随快照上报；
    // 仅在算出数组时携带 —— null / 计算失败 → 不带字段（Python 端快照同样省略，读回 null）。
    if (Array.isArray(blocks)) body.blocks = blocks;
    const resp = await postJson(HISTORY_COMMIT_PATH, withWorkflowId(body, identity));
    // P5b：读响应判合并。HEAD 不论合并与否都由后端 .head.json 维护，前端只负责刷新提交树。
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (data && data.ok === true && data.merged !== true && data.seq != null) {
      historyTreeRefresh(); // P7-树（2026-10-12）：新提交落地 → 刷新底部提交树（展开着重渲染；收起着只更新计数）
    }
  } catch (err) {
    // 端点由 P1-C1 实现，未就绪时静默失败。
    console.warn(LOG_TAG, "提交历史上报失败（端点由 P1-C1 实现，未就绪时静默失败）", err);
  }
}

// ── P4 修（2026-10-11）：出图产物回填（捕获点见 方案-画布提交历史-P4修-P6.md §五）──────
// 背景：P4 缩略图旧口径走 GET /history/{promptId}（ComfyUI 内存态，重启即空）→ 修法是把
// 产物「文件名」在出图后持久化到后端 sidecar（POST /hana_bridge/history-attach-images，
// 端点由 A 方实现，未就绪时静默失败）。桥只上报文件名，不存字节、不重算 sig。
// 边界（硬性）：只读事件 + fire-and-forget 上报；异常一律 try/catch 吞掉 + console.warn，
// 绝不影响画布与执行链路。
const HISTORY_ATTACH_PATH = "/hana_bridge/history-attach-images";
let outputCaptureInstalled = false;
// 暂存：promptId → images[]（executed 逐节点累积，execution_success 时上报并清空）
const pendingImages = new Map();

// 安装出图捕获（幂等）。在 setup() 里调用一次。
function installOutputCapture() {
  if (outputCaptureInstalled) return;
  // 逐节点事件：e.detail.output 里各值是产物数组（如 { images:[{filename,subfolder,type}] }）
  api.addEventListener("executed", (e) => {
    try {
      const d = e && e.detail;
      if (!d || typeof d.prompt_id !== "string") return;
      const out = d.output && typeof d.output === "object" ? d.output : null;
      if (!out) return;
      const arr = pendingImages.get(d.prompt_id) || [];
      for (const v of Object.values(out)) {
        if (!Array.isArray(v)) continue;
        for (const item of v) {
          if (item && typeof item === "object" && typeof item.filename === "string") {
            arr.push({
              filename: item.filename,
              subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
              type: typeof item.type === "string" ? item.type : "output",
            });
          }
        }
      }
      pendingImages.set(d.prompt_id, arr);
    } catch (err) {
      console.warn(LOG_TAG, "P4 出图产物捕获失败（不影响执行）", err);
    }
  });
  // 一次运行结束：上报并清暂存。后端按 filename+subfolder+type 去重合并（重复上报无害）。
  //
  // 2026-10-22 修（预览图一直不出现的真因）：
  //   当前 ComfyUI 版本（8f04fd6e）不再逐节点发送 `executed` 事件 ——
  //   execution.py 里 add_message 的事件只剩 execution_start / execution_cached /
  //   execution_error / execution_interrupted / execution_success，
  //   UI 产物改为存进 history_result，**需要客户端去 GET /history/{promptId} 拿**。
  //   所以上面的 `executed` 监听永远收不到东西 → pendingImages 恒为空 →
  //   images.length 为 0 → reportHistoryImages 从不被调 → sidecar 从不生成 → 预览永远出不来。
  //
  // 兜底：execution_success 时若 pending 为空，直接查 /history/{promptId} 抽 images。
  //   `executed` 监听保留：旧版 ComfyUI / 某些自定义节点仍会发，两条路互补。
  api.addEventListener("execution_success", (e) => {
    try {
      const d = e && e.detail;
      const pid = d && typeof d.prompt_id === "string" ? d.prompt_id : null;
      if (!pid) return;
      const images = pendingImages.get(pid) || [];
      pendingImages.delete(pid);
      if (images.length) {
        void reportHistoryImages(pid, images);
      } else {
        // 新版本路径：没有 executed 事件 → 去 history 取
        void fetchHistoryImages(pid);
      }
    } catch (err) {
      console.warn(LOG_TAG, "P4 出图产物上报失败（不影响执行）", err);
    }
  });
  // 出错/中断/取消也清暂存（防泄漏）
  ["execution_error", "execution_interrupted"].forEach((evt) => {
    api.addEventListener(evt, (e) => {
      try {
        const d = e && e.detail;
        const pid = d && typeof d.prompt_id === "string" ? d.prompt_id : null;
        if (pid) pendingImages.delete(pid);
      } catch { /* 清理失败静默 */ }
    });
  });
  outputCaptureInstalled = true;
}

// 2026-10-22 新增：从 /history/{promptId} 抽产物文件名。
// 适用当前 ComfyUI（不再发 executed 事件，UI 产物存进 history_result）。
// 注意：/history 是内存态，只在本轮运行后一段时间内可取；拿到就立即上报到 sidecar。
// 时序：execution_success 是 add_message 在前、history_result 赋值在后（execution.py L827 vs L834），
//      所以收到事件的那一刻 history 可能还没写上 → 带重试。
async function fetchHistoryImages(promptId, attempt) {
  const n = attempt || 0;
  try {
    const resp = await api.fetchApi("/history/" + encodeURIComponent(promptId), { method: "GET" });
    if (!resp.ok) return;
    const data = await resp.json();
    const rec = data && data[promptId];
    if (!rec || !rec.outputs) {
      if (n < 6) setTimeout(() => { void fetchHistoryImages(promptId, n + 1); }, 500);
      return;
    }
    const images = [];
    for (const nid of Object.keys(rec.outputs)) {
      const o = rec.outputs[nid];
      if (!o || !Array.isArray(o.images)) continue;
      for (const item of o.images) {
        if (item && typeof item.filename === "string") {
          images.push({
            filename: item.filename,
            subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
            type: typeof item.type === "string" ? item.type : "output",
          });
        }
      }
    }
    if (images.length) void reportHistoryImages(promptId, images);
    else if (n < 6) setTimeout(() => { void fetchHistoryImages(promptId, n + 1); }, 500);
  } catch (err) {
    if (n < 6) { setTimeout(() => { void fetchHistoryImages(promptId, n + 1); }, 500); return; }
    console.warn(LOG_TAG, "P4 history 回查失败（不影响画布）", err);
  }
}

// 上报一次出图产物（契约字段冻结，勿改字段名）：POST /hana_bridge/history-attach-images// ⚠️ 端点在索引里按 promptId 找 entry → 写/合并 sidecar；未就绪时静默失败。
async function reportHistoryImages(promptId, images, attempt) {
  const n = attempt || 0;
  try {
    // 2026-10-24：身份优先用提交时记下的那一份（见 rememberCommitIdentity）。
    const identity = commitIdentityOf(promptId);
    let workflow = null;
    try {
      workflow = identity && identity.name ? identity.name : currentWorkflowInfo().name;
    } catch { workflow = null; }
    const resp = await postJson(HISTORY_ATTACH_PATH, withWorkflowId({
      workflow, promptId, images, at: new Date().toISOString(),
    }, identity));
    // 2026-10-22 修：上报成功后必须通知两处 UI 重读，否则新图不会及时出现在
    // 「提交历史框」和「提交树」的提交节点上 —— 它们只在「打开 / 新提交 / 展开」时 fetch，
    // 而上报发生在出图完成后，早过了提交那一刻。
    // 2026-10-22 诊断加强：端点返回什么必须看得见 —— 它静默失败（404）过，
    // 而那正是「图出来了但没绑上」的真正现场。
    let ok = false;
    let errText = "";
    try {
      const j = await resp.json();
      ok = !!(j && j.ok === true);
      errText = j && j.error ? String(j.error) : "";
      if (!ok) console.warn(LOG_TAG, "[P4] attach 失败 pid=" + promptId.slice(0, 8) + " resp=" + JSON.stringify(j).slice(0, 200));
    } catch {
      console.warn(LOG_TAG, "[P4] attach 响应非 JSON pid=" + promptId.slice(0, 8) + " status=" + (resp && resp.status));
    }
    if (ok) {
      scheduleHistoryImagesRefresh();
      return;
    }
    // 2026-10-22：404 = 索引里还没这条 promptId（提交上报晚于图片回查）→ 重试。
    // 这是批量出图时的常态：一次多张图几乎同时完成，而提交只在上传时写一次。
    if (/没有 promptId|404/i.test(errText) && n < 8) {
      setTimeout(() => { void reportHistoryImages(promptId, images, n + 1); }, 700);
    }
  } catch (err) {
    console.warn(LOG_TAG, "P4 出图产物回填失败（不影响画布）", err);
  }
}

// 2026-10-22 兜底：定期扫 /history，把「有图但 sidecar 里没绑上」的补上。
//
// 为什么需要：execution_success 事件在批量出图 / 快速连续提交时不可靠
// （实测 seq671、seq674 有图有索引但没 sidecar，而手动 POST attach 立刻 200）。
// 依赖事件总是有漏网。这个扫描只读两份数据（/history + history-list）做差集，
// 幂等：已绑上的不重复写，后端 attach 本身也去重。
//
// 成本：每 12s 一次，两个 GET；页面隐藏（document.hidden）时跳过。
const HISTORY_SYNC_MS = 12000;
let historySyncBusy = false;
let historySyncTimer = null;

async function syncOrphanImages() {
  if (historySyncBusy) return;
  if (typeof document !== "undefined" && document.hidden) return;
  historySyncBusy = true;
  try {
    // ① 当前工作流的提交列表（已含 images）
    let wf = null;
    try { wf = currentWorkflowInfo().name; } catch { wf = null; }
    if (!wf) return;
    const lr = await api.fetchApi(HISTORY_LIST_PATH + withWorkflowIdQs("?workflow=" + encodeURIComponent(wf)), { method: "GET" });
    if (!lr.ok) return;
    const ld = await lr.json();
    if (!ld || ld.ok !== true) return;
    const entries = Array.isArray(ld.entries) ? ld.entries : [];
    // 已绑上图的 promptId 集合（runs 项已瘦身：只有 promptId + imageCount，无 images / at）
    const bound = new Set();
    for (const e of entries) {
      const runs = Array.isArray(e.runs) ? e.runs : [];
      for (const r of runs) {
        if (r && r.promptId && Number(r.imageCount) > 0) bound.add(String(r.promptId));
      }
    }
    // ② /history 里最近的运行
    const hr = await api.fetchApi("/history", { method: "GET" });
    if (!hr.ok) return;
    const hd = await hr.json();
    const pids = hd && typeof hd === "object" ? Object.keys(hd) : [];
    for (const pid of pids) {
      if (bound.has(pid)) continue;
      const rec = hd[pid];
      if (!rec || !rec.outputs) continue;
      const imgs = [];
      for (const nid of Object.keys(rec.outputs)) {
        const o = rec.outputs[nid];
        if (!o || !Array.isArray(o.images)) continue;
        for (const item of o.images) {
          if (item && typeof item.filename === "string") {
            imgs.push({
              filename: item.filename,
              subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
              type: typeof item.type === "string" ? item.type : "output",
            });
          }
        }
      }
      if (!imgs.length) continue;
      void reportHistoryImages(pid, imgs);
    }
  } catch { /* 兜底不动主链 */ }
  finally { historySyncBusy = false; }
}

function installOrphanImageSync() {
  if (historySyncTimer) return;
  historySyncTimer = setInterval(() => { void syncOrphanImages(); }, HISTORY_SYNC_MS);
}

// 出图后延迟重读两处 UI（幂等合并：同一轮多次出图只刷一次）。
// 延迟 400ms：避开「sidecar 刚写、缩略图后端刚就绪」的极端时序。
let historyImagesRefreshTimer = null;
function scheduleHistoryImagesRefresh() {
  if (historyImagesRefreshTimer) return;
  historyImagesRefreshTimer = setTimeout(() => {
    historyImagesRefreshTimer = null;
    try {
      // 提交树：展开着才重取（收起着下次展开会自己 fetch）
      if (historyTreeEl && historyTreeEl.classList.contains("htr-open")) void historyTreeRefresh();
    } catch { /* 不影响主链 */ }
    try {
      // 提交历史框：开着才重读
      if (typeof historyBarReloadIfOpen === "function") historyBarReloadIfOpen();
    } catch { /* 不影响主链 */ }
  }, 400);
}

// ── P2-F2（2026-10-11）：提交快照的块归属 blocks ──────────────────────────────
// graphBlocks(graph)：对「UI 格式 JSON」算块归属 → [{name, source:"group"|"role", nodeIds:[…]}]。
// 归组口径移植自 app/lib/canvas-outline.mjs（group 优先，其余节点统一归唯一「其他」块），
// 纯函数零依赖 —— CSP 'self' 下桥全局脚本不能 import ESM，只能复制而非引用；**改动需同步两侧**。
// 口径：① graph.groups 非空时，节点 pos=[x,y] 落在某 group.bounding=[x,y,w,h] 内（含边界）
// → 归该组，落多个组取第一个；无 pos / 不入任何组 → ② 不再按节点类型分类，全部归入唯一的
// 「其他」块（source:"role"）。
// 块名去重沿用同款：重名加 #2 递增直到唯一；空 title 用「组{i}」（i 为 groups 序号、从 1 起），
// 与「其他」块名同池查重。与 outline 的差异：不产 summary/blockEdges/issues；块排序与 outline
// 一致（按块内最小 node id 升序，nodeIds 亦升序）。
// 边界：graph 非对象/null → 返回 null（调用方整字段省略，Python 快照读回 null）；
//       空 groups → 全部节点进「其他」块；空节点图 → []（合法零块；但提交通道有 hasGraph
//       拦截，空节点图本就不上报，[] 只会出现在直连 Python 的请求里）。
//       空 group（bounding 内无节点）不成块，同 outline。
function graphBlocks(graph) {
  if (graph === null || typeof graph !== "object") return null;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const groups = Array.isArray(graph.groups) ? graph.groups : [];
  const ROLE_FALLBACK = "其他";
  // ① group 归属：pos 点在 bounding 内（含边界）；命中即 break（落多组取第一个）
  const groupOfNode = new Map(); // node obj → group index
  if (groups.length) {
    for (const node of rawNodes) {
      if (!node || typeof node !== "object") continue;
      const pos = node.pos;
      if (!Array.isArray(pos) || typeof pos[0] !== "number" || typeof pos[1] !== "number") continue;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const b = g && Array.isArray(g.bounding) ? g.bounding : null;
        if (!b || b.length < 4 || b.slice(0, 4).some((v) => typeof v !== "number")) continue;
        if (pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3]) {
          groupOfNode.set(node, gi);
          break;
        }
      }
    }
  }
  // 分桶：group 优先；未归组 → 全部进唯一「其他」桶（不再按节点类型分类）
  const groupBuckets = new Map(); // group index → node[]
  const otherNodes = [];
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const gi = groupOfNode.get(node);
    if (gi !== undefined) {
      if (!groupBuckets.has(gi)) groupBuckets.set(gi, []);
      groupBuckets.get(gi).push(node);
      continue;
    }
    otherNodes.push(node);
  }
  // 块名分配（groups 顺序）+ 重名去重「#k」（k 从 2 起；空标题组名与「其他」块名同池检查）
  const usedNames = new Set();
  const dedupName = (base) => {
    let name = base;
    let k = 2;
    while (usedNames.has(name)) {
      name = `${base}#${k}`;
      k += 1;
    }
    usedNames.add(name);
    return name;
  };
  const rawBlocks = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const nodes = groupBuckets.get(gi);
    if (!nodes) continue; // 空 group 不成块（同 outline）
    const g = groups[gi] || {};
    const title = typeof g.title === "string" ? g.title.trim() : "";
    // color 兜底（2026-10-21）：toJSON() 出来的 group 不一定带 color，
    // 而历史内条必须按「提交当时的框色」渲染。serialized 没有就回活图 group 对象取。
    let gcolor = (typeof g.color === "string" && g.color) ? g.color : null;
    if (!gcolor) {
      try {
        const liveGroups = (app && app.graph && Array.isArray(app.graph.groups)) ? app.graph.groups : [];
        const lg = liveGroups[gi];
        if (lg && typeof lg.color === "string" && lg.color) gcolor = lg.color;
      } catch { /* 取不到就算了，宁可无色也不串色 */ }
    }
    rawBlocks.push({ name: dedupName(title || `组${gi + 1}`), source: "group", color: gcolor, nodes });
  }
  if (otherNodes.length) {
    rawBlocks.push({ name: dedupName(ROLE_FALLBACK), source: "role", nodes: otherNodes });
  }
  // 排序对齐 outline：块按块内最小 node id 升序
  const idNum = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const cmpIds = (a, b) => {
    const an = idNum(a);
    const bn = idNum(b);
    if (an !== null && bn !== null) return an - bn;
    const as = String(a);
    const bs = String(b);
    return as < bs ? -1 : as > bs ? 1 : 0;
  };
  const minId = (ids) => ids.reduce((m, id) => (cmpIds(id, m) < 0 ? id : m), ids[0]);
  rawBlocks.sort((a, b) => cmpIds(minId(a.nodes.map((n) => (n && typeof n === "object" ? n.id : null))), minId(b.nodes.map((n) => (n && typeof n === "object" ? n.id : null)))));
  return rawBlocks.map((b) => ({
    name: b.name,
    source: b.source,
    color: b.color,
    nodeIds: b.nodes.map((n) => (n && typeof n === "object" ? n.id : null)).sort(cmpIds),
  }));
}

// ── P2-F1（2026-10-11）：画布提交历史 · 点击 group 弹出提交历史工具栏（UI 层）──────
// 落点依据：docs/调研-画布提交历史-P2落点.md（结论＝并入主桥单文件，不建新 js，双载红线）。
// 做法：包裹 LGraphCanvas.prototype.processMouseDown（rgthree 同款先例），点击时
// convertEventToCanvasOffset 反算画布坐标 → getGroupOnPos 命中 group → 弹出；点空白/✕ 收起。
// 边界（硬性）：
//  · 包裹只读透传：不改原生行为、不改返回值/抛错时机/this；钩子自身异常只 warn；
//  · 幂等安装：哨兵防 setup() 重跑重复包裹（同名扩展生命周期可能跑两遍）；
//  · 数据只在弹层打开时 fetch 一次（不缓存不轮询）；失败弹层内显错行，不抛异常；
//  · 弹层 z-index 10001（> 锁膜 filmApply 的 9999）；本体 pointer-events:auto，不做 inset
//    全屏遮罩（避免吞画布交互，同锁膜经验）；坐标全程 CSS px（getBoundingClientRect 与
//    convertOffsetToCanvas 同单位），不乘 DPR。
// 明确不做（待商榷，勿实现）：按块归属过滤、浅色主题、设置开关。（回滚已由 P3-G1 落地，见下方专块。）
const HISTORY_LIST_PATH = "/hana_bridge/history-list"; // fetchApi 自动加 /api 前缀 → /api/hana_bridge/history-list（已实测等价）
// 2026-10-23：回跳后把后端 HEAD（<history_dir>/.head.json）设到回跳目标 seq（方案 §3.2 端点）。
const HISTORY_HEAD_SET_PATH = "/hana_bridge/history-head-set";
const HISTORY_BAR_ID = "hana-history-bar";
const HISTORY_BAR_STYLE_ID = "hana-history-bar-style";
const HISTORY_LIGHTBOX_ID = "hana-history-lightbox"; // P4：点缩略图看原图的全屏浮层
const HISTORY_CONFIRM_ID = "hana-history-bar-confirm"; // P6-1：双击刻度的回跳确认框
const HISTORY_TICK_DBL_MS = 240; // P6-1：单击/双击消歧窗口（240ms 内二次点击算双击）
// P6-2（2026-10-12）：弹层跟随画布 —— 缩放钳制区间（zoom out 到很小也不缩没，保证可读）
const HISTORY_BAR_MIN_SCALE = 0.55;
const HISTORY_BAR_MAX_SCALE = 1.6;

let historyBarEl = null; // 弹层单例：null=收起
let historyBarRequestId = 0; // 竞态哨兵：切换/收起后递增，在途旧响应作废
// P2-F1b-3 安装哨兵（拆分为「原型 / 实例 / 元素 / 事件」四层，各自幂等、可分别重入）
let historyGroupProtoWrapped = false; // ① 原型包装幂等哨兵（全局只做一次）
const historyGroupInstanceWrapped = new WeakSet(); // 实例自持 processMouseDown 覆盖时已就地再包（幂等）
const historyGroupBoundCanvases = new WeakSet(); // ② 已重绑 _mousedown_callback 的 canvas 实例（幂等）
const historyGroupBoundElements = new WeakSet(); // ③ 已挂 capture 监听的 canvas 元素（幂等）
const historyGroupHookSeenEvents = new WeakSet(); // 同一事件多入口去重（实例回调 + capture 监听会收到同一 Event）
// P3-G1：回跳态（卡片点选 / 最近提交基线 / 二次确认状态机）
let historyBarSelection = null; // 卡片点选的提交 {file, seq}（file 为空时按 seq 定位）
let historyBarLatestEntry = null; // 最近一次提交条目（未提交比对基线；historyBarLoad 渲染时回填）
let historyRollback = { armed: false, timer: null, busy: false };
// P5b：存档动作状态（防重入）+ 当前弹层锚定的 group（存档后刷新弹层用）
let historySaveBusy = false;
let historyBarGroup = null;
// 2026-10-15 缺口二（无 bundle 框时点节点开历史框）：当前弹层的「角色块视角」状态位。
// 与 historyBarGroup 互斥：group 视角恒 null；角色块视角（无框点节点开出）记该角色块名 —— 供过滤与标题用。
let historyBarRoleName = null;
// P6-1：横轴三态交互状态（单击/双击消歧、缩略图浮层延迟关）
let historyTickClickTimer = null; // 非空 = 已收到第一次单击，正在等消歧窗口结束
let historyTreeClickTimer = null; // 树节点单击/双击消歧（同框口径）
let historyTreeShotsTick = null; // 2026-10-13 第2a：当前树预览浮层所属节点（同节点再点 → 关）
let historyBarShotsTick = null; // 2026-10-13 第2a：当前框预览浮层所属刻度（同刻度再点 → 关；点别的 → 切换）
// P6-2：弹层跟随画布的 rAF 循环句柄 + 上一帧视图态（scale/offset）——变了才写 style
let historyBarRafId = null;
let historyBarFollowPrev = null;

function historyBarStyleEnsure() {
  if (document.getElementById(HISTORY_BAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HISTORY_BAR_STYLE_ID;
  style.textContent = `
/* 2026-10-15：中性色全部走变量，跟随 ComfyUI 明暗（:root=浅色默认，:root.dark-theme=深色覆盖）。
   语义色（谁提交 --hhb-c/--htr-c、HEAD 橙点 #e8c268、旧数据标记点、框色 --hnode-bc）不在此列。 */
:root {
  --hhb-panel1: rgba(252,250,246,.96);
  --hhb-panel2: rgba(243,240,234,.97);
  --hhb-fg: #2c302d;
  --hhb-fg-strong: #1b1f1d;
  --hhb-sub: #5b6570;
  --hhb-faint: #8a939c;
  --hhb-icon: #6b7480;
  --hhb-times: #6b7680;
  --hhb-line: rgba(0,0,0,.14);
  --hhb-inset-hi: rgba(255,255,255,.75);
  --hhb-inset-line: rgba(0,0,0,.05);
  --hhb-shadow-lg: rgba(60,50,40,.18);
  --hhb-shadow-sm: rgba(60,50,40,.12);
  --hhb-shadow-xl: rgba(60,50,40,.22);
  --hhb-cf-bg: rgba(252,250,246,.99);
  --hhb-tick-bg: rgba(0,0,0,.03);
  --hhb-tick-shadow: rgba(60,50,40,.14);
  --hhb-tick-shadow-h: rgba(60,50,40,.2);
  --hhb-tick-shadow-b: rgba(60,50,40,.17);
  --hhb-badge-fg: #fbfcfd;
  --hhb-badge-bg: #3c444f;
  --hhb-badge-shadow: rgba(60,50,40,.2);
  --hhb-sel-ring: rgba(40,46,54,.85);
  --hhb-fade: rgba(246,243,238,.95);
  --hhb-bubble-bg: rgba(252,250,246,.99);
  --hhb-bubble-fg: #2c302d;
  --hhb-bubble-line: rgba(0,0,0,.14);
  --hhb-bubble-shadow: rgba(60,50,40,.2);
  --hhb-thumb-bg: #e7e4de;
  --hhb-thumb-fg: #6b7078;
  --hhb-dot: #6f7680;
  --hhb-legacy-fg: #8b9096;
  --hhb-btn-bg: rgba(0,0,0,.05);
  --hhb-btn-bg-h: rgba(0,0,0,.1);
  --hhb-btn-bg-cf: rgba(0,0,0,.05);
  --hhb-btn-line: rgba(0,0,0,.16);
  --hhb-btn-fg: #2c302d;
  --hhb-accent-bg: rgba(90,140,190,.14);
  --hhb-accent-bg-h: rgba(90,140,190,.26);
  --hhb-accent-line: rgba(90,140,190,.5);
  --hhb-accent-fg: #2b5578;
  --hhb-accent-bg-strong: rgba(90,140,190,.16);
  --hhb-accent-bg-strong-h: rgba(90,140,190,.28);
  --hhb-accent-line-strong: rgba(90,140,190,.6);
  --hhb-danger-bg: rgba(196,104,104,.16);
  --hhb-danger-line: rgba(196,104,104,.7);
  --hhb-danger-fg: #8f3a3a;
  --hhb-ok: #3f7a2a;
  --hhb-warn: #8a5a12;
  --hhb-err: #b0332f;
  --hhb-lb-scrim: rgba(250,248,244,.9);
  --hhb-lb-fg: #3a4048;
  --hhb-lb-img-bg: #e7e4de;
  --hhb-lb-img-shadow: rgba(60,50,40,.25);
  --hhb-lb-nav-bg: rgba(238,235,229,.88);
  --hhb-lb-nav-bg-h: rgba(226,222,216,.96);
}
:root.dark-theme {
  --hhb-panel1: rgba(38,44,54,.94);
  --hhb-panel2: rgba(27,32,40,.95);
  --hhb-fg: #fff;
  --hhb-fg-strong: #fff;
  --hhb-sub: #9fb3c8;
  --hhb-faint: #6f8194;
  --hhb-icon: #cfd8e3;
  --hhb-times: #8fa3b8;
  --hhb-line: rgba(255,255,255,.22);
  --hhb-inset-hi: rgba(255,255,255,.075);
  --hhb-inset-line: rgba(255,255,255,.05);
  --hhb-shadow-lg: rgba(0,0,0,.5);
  --hhb-shadow-sm: rgba(0,0,0,.4);
  --hhb-shadow-xl: rgba(0,0,0,.55);
  --hhb-cf-bg: rgba(28,32,39,.98);
  --hhb-tick-bg: rgba(255,255,255,.025);
  --hhb-tick-shadow: rgba(0,0,0,.45);
  --hhb-tick-shadow-h: rgba(0,0,0,.55);
  --hhb-tick-shadow-b: rgba(0,0,0,.5);
  --hhb-badge-fg: #0d1014;
  --hhb-badge-bg: #dfe8f2;
  --hhb-badge-shadow: rgba(0,0,0,.5);
  --hhb-sel-ring: rgba(255,255,255,.9);
  --hhb-fade: rgba(31,37,46,.95);
  --hhb-bubble-bg: rgba(18,22,28,.98);
  --hhb-bubble-fg: #e6edf5;
  --hhb-bubble-line: rgba(255,255,255,.22);
  --hhb-bubble-shadow: rgba(0,0,0,.5);
  --hhb-thumb-bg: #3a414b;
  --hhb-thumb-fg: #aab4c0;
  --hhb-dot: #9aa0a8;
  --hhb-legacy-fg: #9aa0a8;
  --hhb-btn-bg: rgba(255,255,255,.07);
  --hhb-btn-bg-h: rgba(255,255,255,.14);
  --hhb-btn-bg-cf: rgba(255,255,255,.08);
  --hhb-btn-line: rgba(255,255,255,.24);
  --hhb-btn-fg: #dfe7ef;
  --hhb-accent-bg: rgba(127,178,217,.15);
  --hhb-accent-bg-h: rgba(127,178,217,.28);
  --hhb-accent-line: rgba(127,178,217,.5);
  --hhb-accent-fg: #cfe4f5;
  --hhb-accent-bg-strong: rgba(127,178,217,.18);
  --hhb-accent-bg-strong-h: rgba(127,178,217,.3);
  --hhb-accent-line-strong: rgba(127,178,217,.6);
  --hhb-danger-bg: rgba(232,160,160,.18);
  --hhb-danger-line: rgba(232,160,160,.75);
  --hhb-danger-fg: #f3c6c6;
  --hhb-ok: #b8e0a0;
  --hhb-warn: #e8c268;
  --hhb-err: #e8a0a0;
  --hhb-lb-scrim: rgba(0,0,0,.82);
  --hhb-lb-fg: #cfd8e3;
  --hhb-lb-img-bg: #222;
  --hhb-lb-img-shadow: rgba(0,0,0,.6);
  --hhb-lb-nav-bg: rgba(18,22,28,.72);
  --hhb-lb-nav-bg-h: rgba(38,44,54,.92);
}
#${HISTORY_BAR_ID} {
  position: fixed; z-index: 10001;
  background: linear-gradient(180deg, var(--hhb-panel1) 0%, var(--hhb-panel2) 100%);
  color: var(--hhb-fg);
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 var(--hhb-inset-hi),
    inset 0 0 0 1px var(--hhb-inset-line),
    0 10px 30px var(--hhb-shadow-lg),
    0 2px 6px var(--hhb-shadow-sm);
  backdrop-filter: blur(6px);
  padding: 7px 10px 8px; font-size: 12px; line-height: 1.4;
  pointer-events: auto; user-select: none;
  max-width: min(760px, calc(100vw - 16px));
}
#${HISTORY_BAR_ID} .hhb-title { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-wf { font-weight:600; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${HISTORY_BAR_ID} .hhb-count { color:var(--hhb-sub); }
#${HISTORY_BAR_ID} .hhb-x { margin-left:auto; background:transparent; border:0; color:var(--hhb-icon); font-size:14px; cursor:pointer; padding:0 4px; line-height:1; }
#${HISTORY_BAR_ID} .hhb-x:hover { color:var(--hhb-fg-strong); }
#${HISTORY_BAR_ID} .hhb-build { color:var(--hhb-faint); font-size:10px; margin-left:2px; }
/* P6-1 横轴骨架：刻度（左旧右新）。2026-10-12 按用户要求移除轴线（降低视觉噪音，空态不再裸奔一条横线） */
#${HISTORY_BAR_ID} .hhb-axiswrap { position: relative; }
#${HISTORY_BAR_ID} .hhb-axis {
  position: relative; display: flex; align-items: center; gap: 10px;
  min-width: 280px; min-height: 30px; padding: 3px 2px;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
}
#${HISTORY_BAR_ID} .hhb-axis::-webkit-scrollbar { display: none; }
#${HISTORY_BAR_ID} .hhb-fade { position: absolute; top: 0; bottom: 0; width: 18px; pointer-events: none; z-index: 2; opacity: 0; transition: opacity .2s; }
#${HISTORY_BAR_ID} .hhb-fade.l { left: 0; background: linear-gradient(90deg, var(--hhb-fade), transparent); }
#${HISTORY_BAR_ID} .hhb-fade.r { right: 0; background: linear-gradient(270deg, var(--hhb-fade), transparent); }
#${HISTORY_BAR_ID} .hhb-fade.hhb-fade-on { opacity: 1; }
/* 刻度（统一母题）：外框 = 线型(操作)+色(谁)；内条堆 = 本次碰过的画布框（框色，见 .hnode-bar） */
#${HISTORY_BAR_ID} .hhb-tick {
  flex: none; position: relative; width: var(--hhb-tw, 9px); height: 27px; padding: 2px 0; margin: 0; /* 3a修（2026-10-13）：横向 padding 1px→0，内条贴外框内侧，消除「色块挤占」造成的框粗细错觉 */
  box-sizing: border-box; display: flex; flex-direction: column;
  border: 2px solid color-mix(in oklab, var(--hhb-c, #5aa0d8) 60%, transparent); border-style: solid; border-radius: 4.5px; /* 3a修：统一 2px（原 明2.5/密1.5） */ /* 第8条（2026-10-13）：border-color 半透明 → 发光描边（原实色 = 实心框观感） */
  background: var(--hhb-tick-bg); cursor: pointer;
  /* 第8条（2026-10-13）：常态外光晕加强（固定 10px / 65%，与树同口径） */
  box-shadow: 0 1.5px 4px var(--hhb-tick-shadow), 0 0 10px color-mix(in oklab, var(--hhb-c, #5aa0d8) 65%, transparent);
  transition: transform .14s, box-shadow .14s, filter .14s;
}
/* 密档降级：列宽小时只收内边距；3a修：不再改 border-width（否则与明档跳变 1px） */
#${HISTORY_BAR_ID} .hhb-tick[data-tight] { padding: 1px 0; border-radius: 3px; }
#${HISTORY_BAR_ID} .hhb-tick:hover {
  transform: translateY(-1.5px); filter: brightness(1.12);
  box-shadow: 0 1.5px 4px var(--hhb-tick-shadow-h), 0 0 12px color-mix(in oklab, var(--hhb-c, #5aa0d8) 80%, transparent);
}
/* 合并加粗：3a修（2026-10-13）3.5→2.5px（保留合并可辨，收窄与单次 2px 的差距）；密档不再另行降级（统一 2.5px） */
#${HISTORY_BAR_ID} .hhb-tick.hhb-tick-bulge { width: var(--hhb-tw-bulge, calc(var(--hhb-tw, 9px) + 10px)); border-width: 2.5px; box-shadow: 0 1.5px 4px var(--hhb-tick-shadow-b), 0 0 12px color-mix(in oklab, var(--hhb-c, #5aa0d8) 85%, transparent); } /* 第8条：合并光晕更亮 */
#${HISTORY_BAR_ID} .hhb-tick .hhb-runs {
  display: none; /* P8：×N 默认隐藏，滑过节点才显示（定位不变） */
  position: absolute; top: -5px; right: -6px; font-size: 8.5px; font-weight: 700;
  color: var(--hhb-badge-fg); background: var(--hhb-badge-bg); border-radius: 5px; padding: 0 3px; line-height: 11px;
  box-shadow: 0 1px 3px var(--hhb-badge-shadow); pointer-events: none;
}
#${HISTORY_BAR_ID} .hhb-tick:hover .hhb-runs { display: inline-block; }
/* 2026-10-15 缺口一：变动符号（节点 ＋n/－n、连线 ⇄n）—— 常显小徽标，挂刻度下方（×N 占上方） */
#${HISTORY_BAR_ID} .hhb-delta {
  position: absolute; top: auto; bottom: -6px; left: -6px; font-size: 8.5px; font-weight: 700; line-height: 11px;
  color: var(--hhb-badge-fg); background: var(--hhb-badge-bg); border-radius: 5px; padding: 0 3px;
  box-shadow: 0 1px 3px var(--hhb-badge-shadow); pointer-events: none; white-space: nowrap;
}
#${HISTORY_BAR_ID} .hhb-tick-sel { box-shadow: 0 0 0 2px var(--hhb-sel-ring); }
#${HISTORY_BAR_ID} .hhb-tick[data-legacy] { opacity: .55; }
#${HISTORY_BAR_ID} .hhb-tick[data-legacy]::after {
  content: ""; position: absolute; top: -3px; right: -3px;
  width: 4px; height: 4px; border-radius: 50%; background: #e8c268;
}
#${HISTORY_BAR_ID} .hhb-times { display:flex; justify-content:space-between; gap:12px; margin-top:3px; color:var(--hhb-times); font-size:11px; }
#${HISTORY_BAR_ID} .hhb-times span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 悬停气泡（锚在刻度上方；越界落到刻度下方）。pointer-events:none → 不挡刻度 hover */
#${HISTORY_BAR_ID} .hhb-bubble {
  position:absolute; z-index:3; max-width:280px; pointer-events:none;
  background:var(--hhb-bubble-bg); color:var(--hhb-bubble-fg);
  border:1px solid var(--hhb-bubble-line); border-radius:8px;
  box-shadow:0 6px 20px var(--hhb-bubble-shadow); padding:5px 8px; font-size:11px; line-height:1.45;
}
#${HISTORY_BAR_ID} .hhb-bub-time { color:var(--hhb-sub); }
#${HISTORY_BAR_ID} .hhb-bub-legacy { color:var(--hhb-legacy-fg); font-size:10px; }
/* 单击刻度的缩略图浮层（2026-10-13 第2a：由弹层内固定行改为浮层；浮在被点刻度上方；同刻度再点关） */
#${HISTORY_BAR_ID} .hhb-shots {
  position:absolute; z-index:6; display:none;
  pointer-events:auto; /* 必须收回指针事件，否则图不可点/不可滚 */
  /* 与树 .htr-shots 同口径：同款面板皮肤（渐变底 + 内描边 + 阴影 + 内边距/圆角） */
  width:auto; max-width: min(760px, 92vw); /* 浮层限宽（同树 .htr-shots），不铺满以免遮画布 */
  background: linear-gradient(180deg, var(--hhb-panel1) 0%, var(--hhb-panel2) 100%);
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 var(--hhb-inset-hi),
    inset 0 0 0 1px var(--hhb-inset-line),
    0 10px 30px var(--hhb-shadow-lg),
    0 2px 6px var(--hhb-shadow-sm);
  backdrop-filter: blur(6px);
  padding:7px 10px 8px;
}
#${HISTORY_BAR_ID} .hhb-shots-on { display:block; }
#${HISTORY_BAR_ID} .hhb-shots-ph { color:var(--hhb-sub); font-size:11px; padding:4px 2px; }
#${HISTORY_BAR_ID} .hhb-thumb { width:100%; border-radius:8px; background:var(--hhb-thumb-bg); color:var(--hhb-thumb-fg); display:flex; align-items:center; justify-content:center; font-size:12px; overflow:hidden; }
#${HISTORY_BAR_ID} .hhb-thumb-has { background:transparent; }
#${HISTORY_BAR_ID} .hhb-thumb-multi { width:100%; }
#${HISTORY_BAR_ID} .hhb-thumb-img { width:100%; height:auto; max-height:220px; object-fit:contain; border-radius:8px; display:block; cursor:zoom-in; background:var(--hhb-thumb-bg); }
#${HISTORY_BAR_ID} .hhb-shots .hhb-thumb-img.single { width:100%; max-width:720px; height:auto; max-height:340px; object-fit:contain; } /* 浮层内单图自适应（同树 .htr-shots-img.single） */
#${HISTORY_BAR_ID} .hhb-shots .hhb-thumb-img.multi { flex:none; width:240px; height:auto; max-height:340px; object-fit:contain; } /* 浮层内多图小条（同树 .htr-shots-img.multi） */
#${HISTORY_BAR_ID} .hhb-thumb-strip { display:flex; gap:4px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; padding-bottom:2px; max-width:100%; }
#${HISTORY_BAR_ID} .hhb-thumb-strip::-webkit-scrollbar { display:none; }
#${HISTORY_BAR_ID} .hhb-seq { font-weight:600; }
#${HISTORY_BAR_ID} .hhb-row { display:flex; align-items:center; gap:4px; color:var(--hhb-sub); font-size:11px; }
#${HISTORY_BAR_ID} .hhb-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--hhb-dot); }
#${HISTORY_BAR_ID} .hhb-dot[data-src="user"] { background:#7fb2d9; }
#${HISTORY_BAR_ID} .hhb-dot[data-src="agent"] { background:#c9a0e8; }
#${HISTORY_BAR_ID} .hhb-foot { display:flex; align-items:center; gap:8px; margin-top:7px; }
#${HISTORY_BAR_ID} .hhb-roll { background:var(--hhb-accent-bg); border:1px solid var(--hhb-accent-line); color:var(--hhb-accent-fg); border-radius:7px; padding:3px 10px; cursor:pointer; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-roll:hover { background:var(--hhb-accent-bg-h); }
#${HISTORY_BAR_ID} .hhb-roll-armed { background:var(--hhb-danger-bg); border-color:var(--hhb-danger-line); color:var(--hhb-danger-fg); }
#${HISTORY_BAR_ID} .hhb-save { background:var(--hhb-btn-bg); border:1px solid var(--hhb-btn-line); color:var(--hhb-btn-fg); border-radius:7px; padding:3px 10px; cursor:pointer; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-save:hover { background:var(--hhb-btn-bg-h); }
#${HISTORY_BAR_ID} .hhb-save[disabled] { opacity:.55; cursor:default; }
#${HISTORY_BAR_ID} .hhb-topmsg { color:var(--hhb-ok); font-size:12px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-msg { color:var(--hhb-warn); font-size:11px; }
#${HISTORY_BAR_ID} .hhb-msg:empty { display:none; }
#${HISTORY_BAR_ID} .hhb-empty, #${HISTORY_BAR_ID} .hhb-err { color:var(--hhb-sub); padding:6px 2px; }
#${HISTORY_BAR_ID} .hhb-err { color:var(--hhb-err); }
#${HISTORY_LIGHTBOX_ID} {
  position:fixed; inset:0; z-index:10050; background:var(--hhb-lb-scrim);
  /* flex 只用来摆底部文字；图片走 absolute + transform（见下方 img 规则） */
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
  cursor:zoom-out; pointer-events:auto;
  overflow:hidden;
}
/* 2026-10-21：图片改 absolute 定位，不再受 max-width/max-height 限制。
   原因和 task 卡 lightbox 那次一样：flex 会先按**原图尺寸**排版 img，
   超容器时产生负偏移，再叠 transform 的 translate 就是两套偏移。
   absolute 于 (0,0) 后，translate 就等于图的真实左上角，
   与 hlTx/hlTy 严格一致，refit 的居中计算才准。 */
#${HISTORY_LIGHTBOX_ID} img {
  position:absolute; left:0; top:0;
  max-width:none; max-height:none;
  transform-origin:0 0;
  will-change:transform;
  border-radius:8px;
  box-shadow:0 10px 40px var(--hhb-lb-img-shadow);
  background:var(--hhb-lb-img-bg);
  user-select:none; -webkit-user-drag:none;
}
/* 底部文字/页码固定到底部（图已 absolute 不参与 flex 布局，
   若仍用 flex 居中会因为容器只剩文字而浮到中间，盖在图上）*/
#${HISTORY_LIGHTBOX_ID} .hhb-lb-cap,
#${HISTORY_LIGHTBOX_ID} .hhb-lb-page {
  position:absolute; left:50%; transform:translateX(-50%);
  z-index:1; pointer-events:none; text-align:center;
}
#${HISTORY_LIGHTBOX_ID} .hhb-lb-cap { bottom:38px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-page { bottom:16px; }
/* 旧 img 规则已由上方 absolute 版取代（2026-10-21） */
#${HISTORY_LIGHTBOX_ID} .hhb-lb-cap { color:var(--hhb-lb-fg); font-size:12px; max-width:90vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-page { color:var(--hhb-lb-fg); font-size:12px; font-variant-numeric:tabular-nums; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-x { position:absolute; top:10px; right:14px; background:transparent; border:0; color:var(--hhb-lb-fg); font-size:20px; cursor:pointer; line-height:1; padding:0 4px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-x:hover { color:var(--hhb-fg-strong); }
/* 2b（2026-10-13）：同提交内多图左右翻页（单图 [hidden] 隐藏） */
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav { position:absolute; top:50%; transform:translateY(-50%); width:38px; height:38px; border-radius:50%; background:var(--hhb-lb-nav-bg); border:1px solid var(--hhb-line); color:var(--hhb-bubble-fg); font-size:22px; line-height:1; cursor:pointer; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav:hover { background:var(--hhb-lb-nav-bg-h); }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-prev { left:14px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-next { right:14px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav[hidden] { display:none; }
#${HISTORY_CONFIRM_ID} {
  position: fixed; z-index: 10003; min-width: 220px; max-width: min(420px, calc(100vw - 16px));
  background: var(--hhb-cf-bg); color: var(--hhb-fg);
  border: 1px solid var(--hhb-line); border-radius: 11px;
  box-shadow: 0 12px 36px var(--hhb-shadow-xl); padding: 12px 14px; font-size: 13px;
  pointer-events: auto; user-select: none;
}
#${HISTORY_CONFIRM_ID} .hhb-cf-text { margin-bottom: 10px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-warn { color:var(--hhb-err); font-size:12px; margin:-4px 0 10px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-warn:empty { display:none; }
#${HISTORY_CONFIRM_ID} .hhb-cf-row { display:flex; justify-content:flex-end; gap:8px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-btn { background:var(--hhb-btn-bg-cf); border:1px solid var(--hhb-line); color:var(--hhb-btn-fg); border-radius:7px; padding:4px 12px; cursor:pointer; font-size:12px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-ok { background:var(--hhb-accent-bg-strong); border-color:var(--hhb-accent-line-strong); color:var(--hhb-accent-fg); }
#${HISTORY_CONFIRM_ID} .hhb-cf-ok:hover { background:var(--hhb-accent-bg-strong-h); }
`;
  document.head.appendChild(style);
  historyNodeStyleEnsure(); // 统一母题内条堆（两视图共用）
}

// 收起弹层（幂等）：递增竞态哨兵作废在途 fetch 响应
function historyBarClose() {
  historyBarRequestId++;
  historyBarFollowStop(); // P6-2：收起 → 停 rAF 循环（防泄漏），清上一帧视图态
  historyTickStateClear(); // P6-1：收起 → 三态残留（消歧定时器 / 浮层 / 确认框）一并清掉
  historyRollbackStateReset(); // P3-G1：收起 → 二次确认状态复位（规格 4）
  historyBarSelection = null;
  historyBarLatestEntry = null;
  if (historyBarEl) historyBarEl.style.transform = ""; // P6-2：复位跟随 transform（可选，避免残留）
  if (historyBarEl && historyBarEl.parentElement) {
    historyBarEl.parentElement.removeChild(historyBarEl);
  }
  historyBarEl = null;
  historyBarGroup = null;
  historyBarRoleName = null; // 缺口二：收起 → 角色块视角一并清
}

// 弹层内提示行（替代 alert）
function historyBarTip(msg, isError) {
  if (!historyBarEl) return;
  const tip = historyBarEl.querySelector(".hhb-msg");
  if (tip) {
    tip.textContent = msg;
    tip.style.color = isError ? "#e8a0a0" : "#e8c268";
  }
}

// 时间显示：ISO UTC → 本地 MM-DD HH:mm；解析失败原样显示
function historyFmtTime(at) {
  const t = Date.parse(at);
  if (!isFinite(t)) return String(at || "");
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// LGraphGroup 的矩形取法（按实际存在的字段取值，不猜）。
// 依据两层：
//  [A] 真机运行时实测（2026-10-11，新前端 comfyui_frontend_package 1.55.14 —— 活动实例形态）：
//      g.bounding    → **undefined**（桥旧代码读的就是它，永远取不到 → 弹层根本不弹的根因）
//      g._bounding   → ✅ 有值，如 [520,-90,396.9,708]（数组，含 _pos/_size 子对象）
//      g._pos / g._size → ✅ 有（{0:x,1:y} 形态）
//      g.getBounding() / g.isPointInside(x,y) → ✅ 方法存在
//      序列化后（落盘 JSON）字段才叫 bounding: [520,-90,396.9,708]
//  [B] 源码核对（同包 static/assets/settingStore-X9ZV_dAu.js，offset≈290672 `Xu=class LGraphGroup`）：
//      类体声明 bounds / _pos / _size / _bounding，get boundingRect()/pos()/size() 存在，
//      无 `get bounding`；bounding 仅是 configure() 入参、serialize() 输出名。
// 故读取顺序（按运行时存在性）：boundingRect → _bounding（运行时首选）→ _pos+_size → bounding（旧版/序列化）。
// 注：运行时实例与序列化对象的字段名互斥 —— 运行时只有 _bounding/_pos/_size，无 bounding；
// 序列化 JSON 只有 bounding，无 _bounding/_pos/_size。故后两项的先后对实际取值无影响，
// 此处按命中链优先级（_bounding 先于 bounding）排列。
function historyGroupRect(group) {
  if (!group) return null;
  let b = null;
  if (group.boundingRect) b = group.boundingRect;
  else if (group._bounding) b = group._bounding;
  if (b && b[2] != null && b[3] != null) return [b[0], b[1], b[2], b[3]];
  const p = group._pos || group.pos;
  const s = group._size || group.size;
  if (p && s) return [p[0], p[1], s[0], s[1]];
  if (group.bounding) {
    const bb = group.bounding;
    if (bb[2] != null && bb[3] != null) return [bb[0], bb[1], bb[2], bb[3]];
  }
  return null;
}

// group 几何中心 → 屏幕坐标（CSS px）。graph 坐标 → 画布元素 px 用 convertOffsetToCanvas
// （convertEventToCanvasOffset 的逆变换，同单位不乘 DPR）；缺失时手写同式逆变换兜底。
function historyGroupCenterScreen(group) {
  const canvas = app && app.canvas;
  const el = canvas && (canvas.canvas || canvas.canvasEl || null);
  if (!canvas || !el || !group) return null;
  const b = historyGroupRect(group); // 字段依据见 historyGroupRect 注释
  if (!b) return null;
  let p = null;
  try {
    p = canvas.convertOffsetToCanvas([b[0] + b[2] / 2, b[1] + b[3] / 2]);
  } catch {
    p = null;
  }
  if (!p) {
    const ds = canvas.ds || canvas;
    const scale = (ds && ds.scale) || 1;
    const ox = (ds && ds.offset && ds.offset[0]) || 0;
    const oy = (ds && ds.offset && ds.offset[1]) || 0;
    p = [(b[0] + b[2] / 2 - ox) / scale, (b[1] + b[3] / 2 - oy) / scale];
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.left + p[0], y: rect.top + p[1] };
}

// P6-1：group 框矩形**顶部**中心 → 屏幕坐标（CSS px）。与 historyGroupCenterScreen 同式，
// 只是纵向取 b[1]（框顶）而非几何中心；供「弹层底边贴近框顶」的锚定用。
function historyGroupTopScreen(group) {
  const canvas = app && app.canvas;
  const el = canvas && (canvas.canvas || canvas.canvasEl || null);
  if (!canvas || !el || !group) return null;
  const b = historyGroupRect(group); // 字段依据见 historyGroupRect 注释
  if (!b) return null;
  const cx = b[0] + b[2] / 2;
  const cy = b[1];
  let p = null;
  try {
    p = canvas.convertOffsetToCanvas([cx, cy]);
  } catch {
    p = null;
  }
  if (!p) {
    const ds = canvas.ds || canvas;
    const scale = (ds && ds.scale) || 1;
    const ox = (ds && ds.offset && ds.offset[0]) || 0;
    const oy = (ds && ds.offset && ds.offset[1]) || 0;
    p = [(cx - ox) / scale, (cy - oy) / scale];
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.left + p[0], y: rect.top + p[1] };
}

function historyCanvasEl() {
  const canvas = app && app.canvas;
  return (canvas && (canvas.canvas || canvas.canvasEl || null)) || null;
}

// P6-3（2026-10-12）：选择工具栏避让 —— ComfyUI 选中框/节点时会在其上方浮出「选择工具栏」
// （.selection-toolbox，fixed 定位，悬在框顶上方）。弹层原本贴框顶，会被它压住；
// 取工具栏顶边屏幕 Y，弹层改贴它上方。取不到 / 不可见 → 返回 null（回退贴框顶，行为不变）。
function historySelectionToolboxTop() {
  try {
    const el = document.querySelector(".selection-toolbox");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return r.top;
  } catch {
    return null;
  }
}

// 弹层水平钳制：优先钳在画布元素左右边界内（再兜一层视口 8px 边距）。
// 画布比弹层还窄 → 退回「贴画布左边」，此时右侧可能溢出（见记录-存疑项）。
function historyBarClampLeft(left, bw) {
  const vw = window.innerWidth;
  let lo = 8;
  let hi = vw - bw - 8;
  const el = historyCanvasEl();
  if (el && typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    if (r && r.width > 0) {
      lo = Math.max(lo, r.left + 4);
      hi = Math.min(hi, r.right - bw - 4);
    }
  }
  if (hi < lo) return Math.max(4, lo);
  return Math.max(lo, Math.min(left, hi));
}

// ── P6-2（2026-10-12）：弹层跟随画布 ──────────────────────────────────────
// 弹层仍挂 body + position:fixed，但不再「打开时算一次位置」：改用 rAF 循环读画布视图态
// （app.canvas.ds.scale / ds.offset），与上一帧比对，**变了才重算锚点与 transform**（避免无谓重排），
// 没变只续帧。效果＝弹层像画布里的模块：zoom in 变大、zoom out 变小、拖画布跟着走。
// 只在弹层打开时跑；关闭 / 元素被移除即停（不留悬挂 rAF）。
function historyBarFollowStop() {
  if (historyBarRafId !== null) {
    cancelAnimationFrame(historyBarRafId);
    historyBarRafId = null;
  }
  historyBarFollowPrev = null;
}

// 当前跟随缩放系数（与 historyBarFollowApply 同源）：无画布/异常 → 1。
// 给「弹层内部按屏幕坐标定位的元素」用（弹层自身带 scale，内部偏移须除以 k 才不被二次缩放）。
function historyBarFollowK() {
  const canvas = app && app.canvas;
  const ds = canvas && canvas.ds;
  const scale = ds && typeof ds.scale === "number" && ds.scale > 0 ? ds.scale : 1;
  return Math.max(HISTORY_BAR_MIN_SCALE, Math.min(HISTORY_BAR_MAX_SCALE, scale));
}

// 单帧应用：锚点（框顶中心屏幕坐标）+ 缩放（clamp(ds.scale, MIN, MAX)）。
// 视图态未变 → 直接返回（不写 style，不触发重排/重绘）。
function historyBarFollowApply() {
  const bar = historyBarEl;
  if (!bar) return false;
  const canvas = app && app.canvas;
  const ds = canvas && canvas.ds;
  if (!ds) return false;
  const scale = typeof ds.scale === "number" && ds.scale > 0 ? ds.scale : 1;
  const off = ds.offset || [];
  const ox = typeof off[0] === "number" ? off[0] : 0;
  const oy = typeof off[1] === "number" ? off[1] : 0;
  const prev = historyBarFollowPrev;
  const tb = historySelectionToolboxTop(); // P6-3：选择工具栏顶边（避让锚点；无则 null）
  if (prev && prev.scale === scale && prev.ox === ox && prev.oy === oy && prev.tb === tb) return true; // 视图态未变：跳过写入
  historyBarFollowPrev = { scale, ox, oy, tb };

  // 缩放：clamp 到 [MIN, MAX]（下限保证 zoom out 到很小也不缩没）
  const k = Math.max(HISTORY_BAR_MIN_SCALE, Math.min(HISTORY_BAR_MAX_SCALE, scale));
  // 锚点：框顶中心（屏幕 CSS px，复用 historyGroupTopScreen）；取不到框 → 回退视口中心
  const anchor = historyGroupTopScreen(historyBarGroup);
  const ax = anchor ? anchor.x : window.innerWidth / 2;
  let ay = anchor ? anchor.y : window.innerHeight / 2;
  // P6-3：选择工具栏悬在框顶上方时，弹层再上移，底边贴工具栏顶（避让，避免压住工具栏）
  if (tb != null && tb < ay) ay = tb - 8;
  // 水平钳制：跟随模式按「缩放后的可视宽度」算（transform 不改布局宽度，故取 offsetWidth * k）
  const bw = bar.offsetWidth || 0;
  const visW = bw * k;
  const left = visW > 0 ? historyBarClampLeft(ax - visW / 2, visW) + visW / 2 : ax;

  bar.style.transformOrigin = "50% 100%"; // 底边中心对准框顶
  bar.style.transform = "translate(-50%, -100%) scale(" + k + ")"; // translate 已含对齐 → left/top 直接给锚点
  bar.style.left = Math.round(left) + "px";
  bar.style.top = Math.round(ay) + "px";
  return true;
}

function historyBarFollowTick() {
  const bar = historyBarEl;
  if (!bar || !bar.isConnected) {
    historyBarFollowStop(); // 弹层已被移除 → 不留悬挂 rAF
    return;
  }
  historyBarFollowApply();
  historyBarRafId = requestAnimationFrame(historyBarFollowTick);
}

// 启动跟随：先停旧循环（切换框时防叠加）→ 立即应用一帧（避免首帧错位）→ 续帧。
function historyBarFollowStart() {
  historyBarFollowStop();
  historyBarFollowApply();
  historyBarRafId = requestAnimationFrame(historyBarFollowTick);
}

// 头部第一段取「分组框名」（P6-1：头文案由工作流名改为框名）。
function historyGroupName(group) {
  if (!group) return "(未命名)";
  const n = group.title != null ? group.title : group.name;
  const s = n == null ? "" : String(n);
  return s || "分组";
}

// ── P7（2026-10-12）框视角：按「碰过当前框」过滤提交刻度 ──────────────────────
// 旧数据判据：entry.blockNames 不是数组（null / 字段缺失 / 异常值）→ 无法判定归属 → 视为旧数据（保留 + 标注）。
function historyTickIsLegacy(ent) {
  return !(ent && Array.isArray(ent.blockNames));
}

// 取「当前框」在 graphBlocks 块名口径下的名字（供框视角过滤比对）。
// 与 graphBlocks 同源：只对「bounding 内有自己首个归属节点」的 group 命名（空 group 不成块；节点落多组取第一个），
// 名 = title.trim() || `组{i+1}`（i 为 graph.groups 序号、从 1 起），重名按出现序 `#2`/`#3` 递增去重。
// 角色块名在 group 名之后才进池（后进者改名），故 group 名不受角色名影响 —— 此处无需模拟角色桶。
// 返回 null = 无法判定（无 graph / 框不在图里 / 该框不成块 / 活图与序列化组数或标题对不上）
// → 调用方退化为「不过滤」（宁多勿漏），并 console.warn。
function historyBlockNameOf(group) {
  if (!group) return null;
  let liveGroups = null;
  let json = null;
  try {
    const g = app && app.graph ? app.graph : null;
    liveGroups = g && Array.isArray(g._groups) ? g._groups : null;
    if (g && typeof g.toJSON === "function") json = g.toJSON();
  } catch (err) {
    console.warn(LOG_TAG, "提交历史框视角：读取活图失败，退化为不过滤", err);
    return null;
  }
  if (!liveGroups || !liveGroups.length || !json) return null;
  const idx = liveGroups.indexOf(group);
  if (idx < 0) return null; // 框不在活图分组里 → 判不了
  const groups = Array.isArray(json.groups) ? json.groups : [];
  const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
  if (groups.length !== liveGroups.length) return null; // 组数对不上：口径不同源
  // 组数一致再对一次标题（两边都有 title 才比），对不上同样退化 —— 防序列化顺序错位
  const lt = group && typeof group.title === "string" ? group.title.trim() : "";
  const jt = groups[idx] && typeof groups[idx].title === "string" ? groups[idx].title.trim() : "";
  if (lt && jt && lt !== jt) return null;
  // 归属：同 graphBlocks（节点 pos 落在 bounding 内、含边界；落多组取第一个）
  const owner = new Map(); // node → group index（首个命中）
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const pos = node.pos;
    if (!Array.isArray(pos) || typeof pos[0] !== "number" || typeof pos[1] !== "number") continue;
    for (let gi = 0; gi < groups.length; gi++) {
      const b = groups[gi] && Array.isArray(groups[gi].bounding) ? groups[gi].bounding : null;
      if (!b || b.length < 4 || b.slice(0, 4).some((v) => typeof v !== "number")) continue;
      if (pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3]) {
        owner.set(node, gi);
        break;
      }
    }
  }
  // 命名：只对「有归属节点」的组命名，按组序进池去重（同 graphBlocks）
  const used = new Set();
  let name = null;
  for (let gi = 0; gi < groups.length; gi++) {
    let has = false;
    for (const gi2 of owner.values()) {
      if (gi2 === gi) {
        has = true;
        break;
      }
    }
    if (!has) continue; // 空 group 不成块（不占名）
    const g = groups[gi] || {};
    const base = typeof g.title === "string" && g.title.trim() ? g.title.trim() : `组${gi + 1}`;
    let cur = base;
    let k = 2;
    while (used.has(cur)) {
      cur = `${base}#${k}`;
      k += 1;
    }
    used.add(cur);
    if (gi === idx) {
      name = cur;
      break;
    }
  }
  return name;
}

// 构建号短串（契约 §2.4）：BUILD_TAG 尾部数字串，如 "2026-10-11 hana-bridge-11225527" → "11225527"。
function historyBuildShort() {
  const m = String(BUILD_TAG || "").match(/(\d{5,})\s*$/);
  return m ? m[1] : String(BUILD_TAG || "");
}

// 序号显示：#003（不足三位左补 0；缺 seq → #?）。
function historySeqLabel(ent) {
  return String(ent && ent.seq != null ? ent.seq : "?").padStart(3, "0");
}

// P6-1 三态残留清理（弹层收起 / 重开时调）。
function historyTickStateClear() {
  if (historyTickClickTimer) {
    clearTimeout(historyTickClickTimer);
    historyTickClickTimer = null;
  }
  historyBarShotsHide(); // 第2a：浮层（同刻度再点关，已无定时器）
  historyRollbackConfirmClose();
}

// P6-1 双击确认框：关（幂等）。
function historyRollbackConfirmClose() {
  const el = document.getElementById(HISTORY_CONFIRM_ID);
  if (el) {
    try { el.__offOutside?.(); } catch { /* 解绑失败不影响关闭 */ }
    try { el.__offEsc?.(); } catch { /* 解绑失败不影响关闭 */ }
    el.__offOutside = null;
    el.__offEsc = null;
    if (el.parentElement) el.parentElement.removeChild(el);
  }
}

// ── P4 修（P6-2）：出图缩略图（历史条卡片）────────────────────────────────────
// 数据源＝ `history-list` 每条 entry 已合并好的 `images`（后端读 sidecar 拼出，见方案 §2.2）；
// **不再 fetch `/history/{promptId}`** —— 那是 ComfyUI 内存态，重启即空（P4 真实根因）。
// 口径对齐 App 侧 viewPathOf（app/index.js:640）：/view?filename=..&subfolder=..&type=..
// （subfolder 可能为空串，仍带上）；缩略图 = 同 URL 再加 &preview=webp;75 ——
// ComfyUI 后端 /view 的 preview 分支就地转 webp（实测返回 image/webp），无需自写编码。
// 入参形态：[{filename,subfolder,type}]（缺/非法项跳过）；空数组 → 空清单（调用方保留 seq 占位）。
function historyImagesToUrls(images) {
  const out = [];
  const list = Array.isArray(images) ? images : [];
  for (const im of list) {
    if (!im || !im.filename) continue;
    const qs =
      "filename=" + encodeURIComponent(im.filename) +
      "&subfolder=" + encodeURIComponent(im.subfolder || "") +
      "&type=" + encodeURIComponent(im.type || "output");
    out.push({
      thumbUrl: historyThumbUrl(im, 720, 72), // 缩图端点：480/720px webp（显示尺寸不变、分辨率降）
      thumbFallbackUrl: historyViewUrl(qs + "&preview=webp;75"), // 端点未生效（404）时回退旧口径
      fullUrl: historyThumbUrl(im, 1600, 80), // lightbox：1600px 足够高清，省 2.7MB→~200KB
      fullFallbackUrl: historyViewUrl(qs), // 回退原图
      label: String(im.filename),
    });
  }
  return out;
}

// 取图 URL：优先走前端 api.apiURL（自动补 api_base + /api 前缀，与桥其他 fetch 同口径）；
// 缺失时退回相对路径 /view?…（8188 同源页内可解析）。
function historyViewUrl(qs) {
  const p = "/view?" + qs;
  try {
    if (api && typeof api.apiURL === "function") return api.apiURL(p);
  } catch {
    /* 退回相对路径 */
  }
  return p;
}

// 缩图端点 URL（桥内 py 端点，降分辨率 + 长缓存）；api.apiURL 补前缀，与 historyViewUrl 同口径。
function historyThumbUrl(im, w, q) {
  const p = "/hana_bridge/thumb?filename=" + encodeURIComponent(im.filename) +
    "&subfolder=" + encodeURIComponent(im.subfolder || "") +
    "&type=" + encodeURIComponent(im.type || "output") +
    "&w=" + (w | 0) + "&q=" + (q | 0);
  try { if (api && typeof api.apiURL === "function") return api.apiURL(p); } catch { /* 退回相对路径 */ }
  return p;
}

// 全屏浮层看原图（点任意处或 ✕ 关闭）。样式与历史条弹层同族（深色、圆角，z-index 更高）。
// 2b（2026-10-13）：可选 opts={list:[{fullUrl,label}], index} → 同提交内多图左右翻页（箭头 + ←/→ 键；单图隐藏箭头）。
let historyLightboxItems = null; // 当前全屏多图清单（仅长度 ≥2 时非 null）
let historyLightboxIndex = 0;
let historyLightboxKeyBound = false; // 键盘监听只绑一次（以浮层是否存在为开关）
let historyLightboxWheelAt = 0; // 滚轮翻页节流时间戳（防触控板惯性连翻）
// 缩放/平移状态（2026-10-21）：点图放大↔缩回、滚轮缩放、放大态可拖。
// 每次 openLightbox / 换图都重新 fit，所以不需持久化。
let hlScale = 1, hlFit = 1, hlTx = 0, hlTy = 0;
function historyLightboxShowAt(i) {
  const box = document.getElementById(HISTORY_LIGHTBOX_ID);
  const list = historyLightboxItems;
  if (!box || !list || !list.length) return;
  const n = list.length;
  const idx = ((i % n) + n) % n; // 循环翻页
  historyLightboxIndex = idx;
  const it = list[idx] || {};
  const img = box.querySelector("img");
  const cap = box.querySelector(".hhb-lb-cap");
  if (img) {
    img.onerror = () => {
      if (!img.dataset.fb) { img.dataset.fb = "1"; img.src = it.fullFallbackUrl || it.fullUrl; return; }
      img.style.visibility = ""; // 备用图也挂了 → 别把浮层永久留成空白
    };
    // 翻页重置缩放（2026-10-21）：上一张的 scale/translate 对新图无意义，
    // 先清掉 inline transform 与状态，等新图 load 后由 refit 重新居中。
    //
    // 2026-10-23 修（用户报：滚轮切换时会先瞬间放大一下再切）：
    // img.src 换新后、新图解码完成前，浏览器会继续显示上一帧（旧图）；
    // 而这一帧的 transform 已被清空 → 旧图以原始尺寸铺开，看着就是“先放大”。
    // 处理：新图就绪（refit 完成）前整张隐藏，彻底消掉中间那一帧。
    img.style.visibility = "hidden";
    img.style.transform = "";
    img.style.cursor = "zoom-in";
    hlScale = 1; hlFit = 1; hlTx = 0; hlTy = 0;
    img.src = it.fullUrl || "";
    img.alt = it.label ? String(it.label) : "";
  }
  if (cap) cap.textContent = it.label ? String(it.label) : "";
  const pageEl = box.querySelector(".hhb-lb-page");
  if (pageEl) pageEl.textContent = (list && list.length > 1) ? (idx + 1) + " / " + list.length : "";
}
function historyLightboxKey(e) {
  if (!document.getElementById(HISTORY_LIGHTBOX_ID)) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    historyLightboxShowAt(historyLightboxIndex - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    historyLightboxShowAt(historyLightboxIndex + 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    historyLightboxClose();
  }
}
function historyOpenLightbox(fullUrl, caption, opts) {
  if (!fullUrl) return;
  historyLightboxClose();
  historyBarStyleEnsure();
  const list = opts && Array.isArray(opts.list) ? opts.list.filter((x) => x && x.fullUrl) : null;
  historyLightboxItems = list && list.length > 1 ? list : null;
  const want = opts && opts.index != null ? Number(opts.index) : 0;
  historyLightboxIndex =
    historyLightboxItems && isFinite(want) && want >= 0 && want < historyLightboxItems.length ? want : 0;
  const cur = historyLightboxItems ? historyLightboxItems[historyLightboxIndex] : { fullUrl, label: caption };
  const box = document.createElement("div");
  box.id = HISTORY_LIGHTBOX_ID;
  const img = document.createElement("img");
  // 缩图端点未生效（404/500）→ 一次性回退原图（dataset.fb 防死循环）
  img.onerror = () => { if (img.dataset.fb) return; img.dataset.fb = "1"; img.src = cur.fullFallbackUrl || cur.fullUrl; };
  img.src = cur.fullUrl;
  img.alt = cur.label ? String(cur.label) : "";
  const cap = document.createElement("div");
  cap.className = "hhb-lb-cap";
  cap.textContent = cur.label ? String(cur.label) : "";
  const pageEl = document.createElement("div");
  pageEl.className = "hhb-lb-page";
  if (historyLightboxItems) pageEl.textContent = (historyLightboxIndex + 1) + " / " + historyLightboxItems.length;
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "hhb-lb-nav hhb-lb-prev";
  prev.textContent = "‹";
  prev.title = "上一张（←）";
  prev.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyLightboxShowAt(historyLightboxIndex - 1);
  });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "hhb-lb-nav hhb-lb-next";
  next.textContent = "›";
  next.title = "下一张（→）";
  next.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyLightboxShowAt(historyLightboxIndex + 1);
  });
  if (!historyLightboxItems) { prev.hidden = true; next.hidden = true; } // 单图：隐藏箭头
  const x = document.createElement("button");
  x.type = "button";
  x.className = "hhb-lb-x";
  x.textContent = "✕";
  x.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyLightboxClose();
  });
  box.append(img, cap, pageEl, prev, next, x);

  // 单击交互（2026-10-21 用户定）：
  //   点图片 → 放大 ↔ 缩回（**不关闭**）
  //   点图片以外（遮罩 / 标题 / 留白）→ 仅关闭大图
  // 与拖动共存：按下到抬起位移 ≤5px 才算单击，超过当作拖拽平移。
  const LB_SLOP = 5;
  let press = null;
  const atFit = () => Math.abs(hlScale - hlFit) <= hlFit * 0.02 + 1e-6;
  // 光标（2026-10-21 用户定）：不用小手，用放大/缩小图标。
  // 还能放大时 zoom-in，已在放大态时 zoom-out（再点就是缩回）。
  // 提前声明：applyLb 会调它，不能放到 applyLb 后面（TDZ）。
  let syncCursor = () => {};
  const applyLb = () => {
    img.style.transform = `translate(${hlTx}px, ${hlTy}px) scale(${hlScale})`;
    img.style.transformOrigin = "0 0";
    syncCursor();
  };
  // 以视口坐标 (cx,cy) 为锚点缩放（推导：tx' = cx - (cx-tx)·k）
  const zoomAt = (next, cx, cy) => {
    const s2 = Math.max(0.05, Math.min(8, next));
    if (!(hlScale > 0) || Math.abs(s2 - hlScale) < 1e-9) return;
    const k = s2 / hlScale;
    hlTx = cx - (cx - hlTx) * k;
    hlTy = cy - (cy - hlTy) * k;
    hlScale = s2;
    applyLb();
  };
  const refit = () => {
    const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    const vw = window.innerWidth, vh = window.innerHeight;
    const fit = Math.min(1, (vw * 0.92) / nw, (vh * 0.84) / nh);
    hlFit = fit; hlScale = fit;
    hlTx = (vw - nw * fit) / 2;
    hlTy = (vh - nh * fit) / 2;
    applyLb();
    img.style.visibility = ""; // 新图已就绪且按 fit 摆好，此刻才显示（配合翻页隐藏）
  };
  img.addEventListener("load", refit);
  if (img.complete && img.naturalWidth) refit();
  img.draggable = false;
  // 光标实现（在 applyLb/atFit 就绪后绑定，applyLb 里调 syncCursor 自动跟随状态）
  syncCursor = () => {
    img.style.cursor = atFit() ? "zoom-in" : "zoom-out";
  };
  syncCursor();

  img.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) { press = null; return; }
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0, tx: hlTx, ty: hlTy };
  });
  img.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    const d = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (d > press.moved) press.moved = d;
    // 超过阈值就进入拖拽：只改平移，不改缩放
    if (press.moved > LB_SLOP) {
      hlTx = press.tx + (e.clientX - press.x);
      hlTy = press.ty + (e.clientY - press.y);
      applyLb();
    }
  });
  img.addEventListener("pointerup", (e) => {
    if (!press || e.pointerId !== press.id) { press = null; return; }
    const wasClick = press.moved <= LB_SLOP;
    const cx = e.clientX, cy = e.clientY;
    press = null;
    if (!wasClick) return;                                   // 拖过了，不算单击
    if (atFit()) zoomAt(Math.max(hlFit * 2, 1), cx, cy);     // 放大：至少到 1:1
    else refit();                                            // 缩回并重新居中
  });
  img.addEventListener("pointercancel", () => { press = null; });

  // 点图片以外才关闭（图片自己的单击已在上方消费）
  box.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.target === img) return;                           // 点图：不关
    historyLightboxClose();
  });
  // 滚轮：切图（2026-10-21 用户定：滚轮用于翻图，不用于缩放）。
  // 单图不拦，否则浮层会把页面滚动锁死；多图保留 220ms 节流防触控板惯性连翻。
  box.addEventListener(
    "wheel",
    (ev) => {
      if (!historyLightboxItems || historyLightboxItems.length < 2) return; // 单图不拦
      ev.preventDefault();
      const d = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
      if (!d) return;
      const now = Date.now();
      if (now - historyLightboxWheelAt < 220) return;
      historyLightboxWheelAt = now;
      historyLightboxShowAt(historyLightboxIndex + (d > 0 ? 1 : -1));
    },
    { passive: false }
  );
  document.body.appendChild(box);
  if (!historyLightboxKeyBound) {
    document.addEventListener("keydown", historyLightboxKey);
    historyLightboxKeyBound = true;
  }
}

function historyLightboxClose() {
  const el = document.getElementById(HISTORY_LIGHTBOX_ID);
  if (el && el.parentElement) el.parentElement.removeChild(el);
  historyLightboxItems = null;
  historyLightboxIndex = 0;
}

// 回填缩略图（数据源＝ list 条目已合并好的 images，纯本地渲染，无 fetch）。
// 竞态：reqId 过期（弹层已收起 / 已切到别的框）→ 丢弃，不写 DOM。
function historyFillThumb(reqId, thumb, images) {
  const imgs = historyImagesToUrls(images);
  if (reqId !== historyBarRequestId) return; // 弹层已切 / 已收起：作废
  if (!imgs.length) return; // 无图 → 保留 seq 占位
  if (!thumb || !thumb.isConnected) return;
  thumb.textContent = "";
  thumb.classList.add("hhb-thumb-has");
  const makeImg = (it) => {
    const img = document.createElement("img");
    img.className = "hhb-thumb-img";
    img.src = it.thumbUrl;
    img.alt = it.label;
    // 缩图端点未生效（404/500）→ 一次性回退旧口径 preview=webp;75（dataset.fb 防死循环）
    img.onerror = () => { if (img.dataset.fb) return; img.dataset.fb = "1"; img.src = it.thumbFallbackUrl || it.thumbUrl; };
    // 弹层「点开即看」：缩略图用 eager（lazy 会让点开的图延迟出现；同源小 webp 无性能顾虑）
    img.loading = "eager";
    img.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // 点图只开原图，不触发卡片选中
      historyOpenLightbox(it.fullUrl, it.label);
    });
    return img;
  };
  if (imgs.length === 1) {
    thumb.appendChild(makeImg(imgs[0]));
    return;
  }
  // 多图（batch / 多输出节点）：横向小条，溢出横向滚动
  thumb.classList.add("hhb-thumb-multi");
  const strip = document.createElement("div");
  strip.className = "hhb-thumb-strip";
  for (const it of imgs) strip.appendChild(makeImg(it));
  thumb.appendChild(strip);
}

// ── P6-1：横轴三态交互（悬停气泡 / 单击缩略图 / 双击确认）────────────────────
// 消歧：任一 tick 被点、且距上一次点击未超 HISTORY_TICK_DBL_MS → 判为双击
// （由 historyBarTickClick 内唯一一个定时器实现：非空即表示「已收到第一次单击」）。

// 变更节点名（悬停气泡正文）：主读 P5a 的 ent.delta.changed[].title；
// 退化为 delta.added/removed 的 title；delta 缺失（P5b 前恒为 null）→ 退化为该提交触及的块名
// （ent.blocks[].title/name，P5a 完整版块表）；再不行 → "#编号"。
function historyTickChangedNames(ent) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const v = s == null ? "" : String(s).trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const d = ent && ent.delta && typeof ent.delta === "object" ? ent.delta : null;
  if (d) {
    for (const c of Array.isArray(d.changed) ? d.changed : []) push(c && c.title);
    if (out.length) return out;
    for (const c of Array.isArray(d.added) ? d.added : []) push(c && c.title);
    for (const c of Array.isArray(d.removed) ? d.removed : []) push(c && c.title);
    if (out.length) return out;
    return ["无节点变更"];
  }
  // delta 缺失：退化到块名
  const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : [];
  for (const b of bl) {
    if (b && typeof b === "object") push(b.title != null ? b.title : b.name);
  }
  if (out.length) return out;
  push("#" + historySeqLabel(ent));
  return out;
}

// 2026-10-26：字段名 → 中文标签（悬停气泡「改动」行的括号内容）。
// 未知名字原样输出；widget_N 位置参数 → 「参数N」。
const HISTORY_FIELD_LABELS = {
  mode: "状态", type: "类型", title: "名字",
  steps: "步数", cfg: "CFG", denoise: "降噪", seed: "种子", noise_seed: "种子",
  sampler_name: "采样器", scheduler: "调度器", text: "文本",
  width: "宽", height: "高", batch_size: "批次数", length: "长度",
  strength: "强度", strength_model: "模型强度", strength_clip: "CLIP 强度",
  lora_name: "LoRA", ckpt_name: "模型", vae_name: "VAE", clip_name: "CLIP",
  clip_name1: "CLIP1", clip_name2: "CLIP2", clip_name3: "CLIP3", model_name: "模型",
  prompt: "提示词", negative: "反向提示",
  // 2026-10-26（任务 B）：补 ComfyUI 常见 widget 名。此前 control_after_generate / image / mask /
  // filename_prefix 等一律原样露出英文原名，气泡里可读性差。未命中的仍原样输出（不发明中文）。
  control_after_generate: "生成后控制", filename_prefix: "文件名前缀",
  image: "图像", mask: "遮罩", grow_mask_by: "遮罩扩展",
  upscale_method: "放大算法", scale_by: "缩放倍数", megapixels: "百万像素",
  weight: "权重", start_at_step: "起始步", end_at_step: "结束步",
  return_with_leftover_noise: "保留残余噪声", add_noise: "加噪", noise_type: "噪声类型",
  shift: "位移", sampler: "采样器", sigmas: "噪声表",
  vae: "vae", clip: "clip", model: "模型",
};
// 2026-10-26（任务 B）：标签过长（> 12 字符）截断，避免括号内容把气泡撑爆。
// 只截显示，不改映射表（原名本来就 >12 的同样截）。
const HISTORY_FIELD_LABEL_MAX = 12;
function historyFieldLabel(f) {
  const k = String(f == null ? "" : f).trim();
  if (!k) return "";
  let out = HISTORY_FIELD_LABELS[k];
  if (!out) {
    const m = /^widget_(\d+)$/.exec(k);
    out = m ? "参数" + Number(m[1]) : k;
  }
  return out.length > HISTORY_FIELD_LABEL_MAX ? out.slice(0, HISTORY_FIELD_LABEL_MAX) + "…" : out;
}

// ── 2026-10-15 缺口一：提交变动符号（刻度 / 树节点共用）────────────────────────
// 语义：节点增删 → 「＋n」/「－n」；连线有变 → 「⇄n」；可组合（如「＋2 ⇄1」）。
// 数据源 ent.delta（方案 §五 契约）：changed/added/removed（节点维度）+ links{added,removed}（连线维度）。
// 退化：无 delta / 无任何变动 → 返回 ""（调用方不渲染）；旧条目无 delta.links → 不显示连线符号（自然退化，不报错）。
function historyDeltaSymbolText(ent) {
  const d = ent && ent.delta && typeof ent.delta === "object" ? ent.delta : null;
  if (!d) return "";
  const cnt = (v) => (Array.isArray(v) ? v.length : 0);
  const addN = cnt(d.added);
  const rmN = cnt(d.removed);
  const lk = d.links && typeof d.links === "object" ? d.links : null; // 旧数据无此字段 → null
  const lkN = lk ? cnt(lk.added) + cnt(lk.removed) : 0;
  const parts = [];
  if (addN) parts.push("＋" + addN);
  if (rmN) parts.push("－" + rmN);
  if (lkN) parts.push("⇄" + lkN);
  return parts.join(" ");
}

// 色相分「谁」：agent → 暖紫；否则（user/unknown）→ 冷色。写成内联 CSS 变量（不新增样式规则）。
function historyTickColor(source) {
  return String(source || "") === "agent" ? "#b189e0" : "#5aa0d8";
}

// 外框线型分「操作」：save → dashed；run/其余 → solid（写成内联 CSS 变量）。
function historyTickBorderStyle(kind) {
  return String(kind || "") === "save" ? "dashed" : "solid";
}

// 内条默认色（框已不在画布 / 取不到色）——低存在感中性灰。
const HNODE_BAR_DIM = "rgba(255,255,255,.16)";

// 活图块清单（graphBlocks 口径：group 优先、其余节点统一归唯一「其他」块）。
// 取不到活图（无画布 / 无 toJSON / 异常）→ null（调用方各自退化）。取图路径沿用原 historyLiveBlockColors 的 g.toJSON()。
function historyLiveBlocks() {
  try {
    const g = app && app.graph ? app.graph : null;
    if (!g || typeof g.toJSON !== "function") return null;
    const blocks = graphBlocks(g.toJSON());
    return Array.isArray(blocks) ? blocks : null;
  } catch { return null; }
}

// 活图「框名 → 框色」映射（内条取色源 = 画布 bundle 框色）。
// 框名口径与内条渲染完全同源（都走 graphBlocks，source === "group"）；取不到活图/无框 → 空 Map。
// blocksIn：可选，已算好的活图块清单（省一次 toJSON）；不传则自取。
function historyLiveBlockColors(blocksIn) {
  const m = new Map();
  const blocks = Array.isArray(blocksIn) ? blocksIn : historyLiveBlocks();
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.source === "group" && typeof b.color === "string" && b.color) m.set(b.name, b.color);
  }
  return m;
}

// 统一母题样式（两视图共用，一次性注入）：外框由各视图自己画（线型=操作、色=谁），内条堆用此公共类。
function historyNodeStyleEnsure() {
  const ID = "hana-history-node-style";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
/* 2026-10-15：中性灰底跟随明暗（内条的语义色 --hnode-bc 不动）。 */
:root { --hnode-dim: rgba(0,0,0,.22); }
:root.dark-theme { --hnode-dim: rgba(255,255,255,.16); }
/* 2026-10-23：gap / 条最小高随档位走变量；2026-10-26（方案变更）：条保持正常粗细，
   --hnode-gap / --hnode-barmin 继续用档位原值（由 historyTreeShellTier 给出）；
   塞不下改由「节点高按 maxBlocks 自适应长高」解决（historyTreeAdaptSize）。
   overflow:hidden 仅作最后兜底。 */
.hnode-bars { display:flex; flex-direction:column; gap:var(--hnode-gap, 1.5px); align-items:stretch; justify-content:center; flex:1 1 auto; min-height:0; overflow:hidden; }
.hnode-bar { display:block; flex:1 1 0; min-height:var(--hnode-barmin, 2px); border-radius:2px; background:var(--hnode-dim, ${HNODE_BAR_DIM}); } /* 3b（2026-10-13）：内条圆角 1px→2px */
.hnode-bar.hnode-bar-on { background:var(--hnode-bc, #5aa0d8); filter:brightness(1.08); } /* 3a修（2026-10-13）：去掉内条 5px 光晕 + 降亮度 1.15→1.08，外框始终是视觉主线（原亮条盖过外框） */
`;
  document.head.appendChild(style);
}

// 内条堆（统一母题）：全局框各一根；「碰过」的框 → 该框真色（亮），未碰 → 中性灰。
// barNames=全局框名（singleBar 时传 [null] 退化为单根）；hitSet=碰过的框名 Set（null=旧数据全灰）；
// colorMap=框名→框色。
// 单条历史条目自己的内条视图：槽位 = 该提交时的 blocks 顺序，颜色 = 该提交时存的框色。
// 为什么必须这样（2026-10-20 用户指出）：内条原来按「当前活图块清单」建槽，
// 靠块名去点亮。提交之后一旦改框色 / 删框 / 改名，旧提交的内条颜色和槽位就跟不上，
// 表现为「已提交的节点颜色变了 / 条数不对」。历史必须只读历史。
// 旧条目没有 blocks 或没有 color → 回退活图（保持老行为的可用性）。
function historyBarsSpecFor(ent, liveNames, liveColorMap, singleBar) {
  const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : null;
  if (singleBar || !bl || bl.length === 0) {
    return { names: liveNames, colorMap: liveColorMap, singleBar: !!singleBar, fromHistory: false };
  }
  const names = [];
  const cmap = new Map();
  let anyColor = false;
  for (const b of bl) {
    if (!b || typeof b !== "object") continue;
    const nm = b.name == null ? "" : String(b.name);
    names.push(nm);
    if (b.source === "group" && typeof b.color === "string" && b.color) {
      cmap.set(nm, b.color);
      anyColor = true;
    }
  }
  // 边界：有历史 blocks 但一个颜色都没存（本修复之前写的旧条目）。
  // 此时**不能回落到活图取色**（那正是「改了框色旧节点跟着变」的病根），
  // 而是让缺色的条用中性暗色 —— 宁可一致地朴素，也不可错位地鲜艳。
  if (!anyColor) {
    return { names, colorMap: cmap, singleBar: false, fromHistory: true,
             hitSet: Array.isArray(ent.blockNames) ? new Set(ent.blockNames.map(String)) : new Set(names) };
  }
  if (names.length === 0) {
    return { names: liveNames, colorMap: liveColorMap, singleBar: !!singleBar, fromHistory: false };
  }
  // 命中集合：该条目 blockNames（由桥侧按 delta 算好）；无则退回「全部亮」
  const hit = Array.isArray(ent.blockNames)
    ? new Set(ent.blockNames.map((x) => String(x)))
    : new Set(names);
  return { names, colorMap: cmap, singleBar: false, fromHistory: true, hitSet: hit };
}

function historyBarsBuild(barNames, hitSet, colorMap, singleBar) {
  const bars = document.createElement("div");
  bars.className = "hnode-bars";
  const names = singleBar ? [null] : (Array.isArray(barNames) ? barNames : []);
  for (const nm of names) {
    const bar = document.createElement("i");
    bar.className = "hnode-bar";
    let on = false;
    let col = HNODE_BAR_DIM;
    if (singleBar) {
      on = hitSet !== null; // 无框退化：有效提交 → 亮；旧数据 → 灰
    } else if (nm != null) {
      on = hitSet ? hitSet.has(nm) : false;
      if (on) col = (colorMap && colorMap.get(nm)) || HNODE_BAR_DIM;
    }
    if (on) { bar.classList.add("hnode-bar-on"); bar.style.setProperty("--hnode-bc", col); }
    bars.appendChild(bar);
  }
  return bars;
}

// 造一根刻度（button；外框=线型(操作)+色(谁)；内条堆=本次碰过的画布框，色取画布框色）。
function historyBarTickMake(reqId, ent, ctx) {
  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "hhb-tick";
  const seq = historySeqLabel(ent);
  const src = String((ent && ent.source) || "unknown");
  const kind = String((ent && ent.kind) || "run");
  tick.style.setProperty("--hhb-c", historyTickColor(src)); // 外框色 = 谁
  tick.style.borderStyle = historyTickBorderStyle(kind); // 外框线型 = 操作（run 实线 / save 虚线）
  tick.dataset.src = src;
  tick.dataset.kind = kind;
  if (ctx && ctx.colW && ctx.colW < 14) tick.dataset.tight = "1"; // 密档降级
  // 内条堆（统一母题）：全局框各一根；碰过的框 → 画布框色（亮），未碰 → 灰；旧数据全灰。
  const legacyTick = historyTickIsLegacy(ent);
  const hitSet = legacyTick ? null : new Set((Array.isArray(ent && ent.blockNames) ? ent.blockNames : []).map((x) => String(x)));
  // 优先用「该提交自己的」块顺序与框色（历史只读历史）；旧数据回退活图
  const _specA = historyBarsSpecFor(ent, ctx && ctx.allBlocks, ctx && ctx.colorMap, !!(ctx && ctx.singleBar));
  const bars = historyBarsBuild(_specA.names, _specA.fromHistory ? _specA.hitSet : hitSet,
                                _specA.colorMap, _specA.singleBar);
  tick.appendChild(bars);
  // 合并提交（runs.length > 1）：刻度加粗（.hhb-tick-bulge）；列宽足够（colW >= 10）时再叠 ×N 徽标。
  const runs = ent && Array.isArray(ent.runs) ? ent.runs : [];
  const runsN = runs.length;
  if (runsN > 1) tick.classList.add("hhb-tick-bulge");
  if (runsN > 1 && ctx && ctx.colW >= 10) {
    const badge = document.createElement("span");
    badge.className = "hhb-runs";
    badge.textContent = "×" + runsN;
    tick.appendChild(badge);
  }
  // 2026-10-15 缺口一：变动符号（节点 ＋n/－n + 连线 ⇄n）—— 挂刻度左上角（×N 占右上，互不打架）。
  const deltaTxt = historyDeltaSymbolText(ent);
  if (deltaTxt) {
    const delta = document.createElement("span");
    delta.className = "hhb-delta";
    delta.textContent = deltaTxt;
    tick.appendChild(delta);
  }
  // P7：旧数据（无法细分到框）→ 打标记（淡化 + 右上小点；样式见 .hhb-tick[data-legacy]）
  if (legacyTick) tick.dataset.legacy = "1";
  tick.title = ""; // 用自绘气泡，不用原生 tooltip
  tick.addEventListener("mouseenter", () => historyBarBubbleShow(tick, ent));
  tick.addEventListener("mouseleave", () => historyBarBubbleHide());
  tick.addEventListener("click", (ev) => historyBarTickClick(ev, tick, ent, ctx));
  return tick;
}

// 单击/双击消歧入口（240ms）；双击走「选中 + 确认框 → historyRollbackExecute」。
function historyBarTickClick(ev, tick, ent, ctx) {
  ev.preventDefault();
  ev.stopPropagation();
  if (historyTickClickTimer) {
    // 消歧窗口内二次点击 = 双击
    clearTimeout(historyTickClickTimer);
    historyTickClickTimer = null;
    historyTickSelect(tick, ent, ctx);
    historyBarShotsHide(); // 双击 = 回跳，收起单击可能已展开的缩略图浮层
    historyRollbackConfirmOpen(tick, ent);
    return;
  }
  historyTickClickTimer = setTimeout(() => {
    historyTickClickTimer = null;
    historyTickSelect(tick, ent, ctx);
    historyBarShotsToggle(tick, ent); // 单击：展开该提交的缩略图浮层（第2a：同刻度再点关）
  }, HISTORY_TICK_DBL_MS);
}

// 选中某刻（模拟选中该提交）：写 historyBarSelection（供 historyRollbackClick/Execute 读）+ 高亮。
function historyTickSelect(tick, ent, ctx) {
  if (historyRollback.busy) return;
  const file = ent && ent.file ? String(ent.file) : null;
  const seq = ent && ent.seq != null ? ent.seq : null;
  const prev = historyBarSelection;
  const axis = ctx && ctx.axis ? ctx.axis : null;
  historyRollbackBtnReset();
  historyBarSelection = { file, seq };
  if (axis) axis.querySelectorAll(".hhb-tick.hhb-tick-sel").forEach((t) => t.classList.remove("hhb-tick-sel"));
  if (tick) tick.classList.add("hhb-tick-sel");
  if (prev && prev.file === file && prev.seq === seq) return;
  historyBarTip("已选 #" + historySeqLabel(ent) + "，点「回到这一版」或双击刻度执行", false);
}

// ── 悬停气泡（同主题：时间 + 变更节点名）────────────────────────────
function historyBarBubbleShow(tick, ent) {
  if (!historyBarEl || !tick) return;
  historyBarBubbleHide();
  const b = document.createElement("div");
  b.className = "hhb-bubble";
  const t = document.createElement("div");
  t.className = "hhb-bub-time";
  t.textContent = "#" + historySeqLabel(ent) + " · " + historyFmtTime(ent && ent.at);
  const names = document.createElement("div");
  names.className = "hhb-bub-names";
  names.textContent = historyTickChangedNames(ent).join("、");
  b.append(t, names);
  // P7：旧数据（blockNames === null / 字段缺失）→ 气泡里加一行小字
  if (historyTickIsLegacy(ent)) {
    const lg = document.createElement("div");
    lg.className = "hhb-bub-legacy";
    lg.textContent = "历史旧数据（无法细分到框）";
    b.appendChild(lg);
  }
  // 先隐藏挂入：需要其 offsetWidth 才能算定位
  b.style.visibility = "hidden";
  b.style.left = "0px";
  b.style.top = "0px";
  historyBarEl.appendChild(b);
  try {
    const tr = tick.getBoundingClientRect();
    const br = historyBarEl.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    // P6-2：弹层带 scale(k) —— 气泡是本层内绝对定位，getBoundingClientRect 的差值已含 k，
    // 写回本地坐标前需除以 k，否则气泡会被二次缩放而错位。
    const k = historyBarFollowK();
    const barW = historyBarEl.offsetWidth || br.width;
    let left = (tr.left + tr.width / 2 - br.left) / k - bw / 2;
    const maxL = Math.max(0, barW - bw); // 最右：气泡右边贴弹层右边
    left = Math.max(0, Math.min(left, maxL));
    // 默认在刻度上方；弹层顶放不下 → 落到刻度下方
    /* 再让 13px：让出右上 ×N 上标高度，避免最右键气泡遮住 */
    let top = (tr.top - br.top) / k - bh - 19;
    if (tr.top - bh * k - 19 < 4 && tr.bottom + 6 + bh * k < window.innerHeight - 4) top = (tr.bottom - br.top) / k + 6;
    b.style.left = left.toFixed(1) + "px";
    b.style.top = top.toFixed(1) + "px";
  } catch {
    /* 定位失败也显示（左上角），不影响 hover 语义 */
  }
  b.style.visibility = "visible";
}

function historyBarBubbleHide() {
  if (!historyBarEl) return;
  const b = historyBarEl.querySelector(".hhb-bubble");
  if (b && b.parentElement) b.parentElement.removeChild(b);
}

// ── 单击刻度缩略图浮层（第2a：对齐树口径——浮在被点刻度上方 / 同刻度再点关 / 多图横滚 / 点图进全屏可翻页）──
function historyBarShotsToggle(tick, ent) {
  const host = historyBarEl;
  if (!host || !tick) return;
  const same = historyBarShotsTick === tick;
  historyBarShotsHide();
  if (same) return; // 再点同一刻度 → 关
  historyBarShotsTick = tick;
  const box = document.createElement("div");
  box.className = "hhb-shots hhb-shots-on";
  // 数据源＝ list 条目已合并好的 images（不再碰 /history）
  const images = ent && Array.isArray(ent.images) ? ent.images : [];
  const imgs = historyImagesToUrls(images);
  if (!imgs.length) {
    const ph = document.createElement("div");
    ph.className = "hhb-shots-ph";
    ph.textContent = "这次提交没有关联出图";
    box.appendChild(ph);
  } else {
    const single = imgs.length === 1;
    const strip = document.createElement("div");
    strip.className = "hhb-thumb-strip";
    for (const it of imgs) {
      const img = document.createElement("img");
      img.className = "hhb-thumb-img " + (single ? "single" : "multi");
      img.src = it.thumbUrl;
      img.alt = it.label;
      img.loading = "eager"; // 点开即看（同 P4 口径）
      // 缩图端点未生效（404/500）→ 一次性回退旧口径（dataset.fb 防死循环）
      img.onerror = () => { if (img.dataset.fb) return; img.dataset.fb = "1"; img.src = it.thumbFallbackUrl || it.thumbUrl; };
      img.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation(); // 点图只开原图，不触发刻度选中
        // 带本提交图清单 → 全屏内左右翻页（单图时箭头自动隐藏）
        historyOpenLightbox(it.fullUrl, it.label, { list: imgs, index: imgs.indexOf(it) });
      });
      // 图片异步加载完成 / 失败后重定位：占位高度 → 真实高度，底边锚定不跳（同树）。
      img.addEventListener("load", () => { try { historyBarShotsPosition(box, tick); } catch {} });
      img.addEventListener("error", () => { try { historyBarShotsPosition(box, tick); } catch {} });
      strip.appendChild(img);
    }
    box.appendChild(strip);
    // 多图横滚：滚轮作用在浮层内部可滚条（同树）
    box.addEventListener(
      "wheel",
      (ev) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
        if (d > 0 && strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1) return;
        if (d < 0 && strip.scrollLeft <= 0) return;
        ev.preventDefault();
        strip.scrollLeft += d;
      },
      { passive: false }
    );
  }
  host.appendChild(box);
  historyBarShotsPosition(box, tick);
  // 2026-10-14：点浮层容器（弹层）之外 → 关（点弹层内交给刻度逻辑）。
  box.__offOutside = bindOutsideClose(historyBarEl, () => historyBarShotsHide());
}

// 弹层缩略图浮层定位（2026-10-14）：锚「整个弹层上方」——不再锚被点刻度（刻度在弹层中部，会压住弹层标题行）。
// 打开时快照锚向（above/below），之后重定位只改高度不改锚向；底边锚定：图片加载变高 → top 变小 → 浮层向上生长，底边不动。
// 浮层与弹层共面（弹层带 scale(k)）；写回本地坐标前除以 k（同 .hhb-bubble）。水平：居中刻度 + 钳在弹层内（原算法保留）。
function historyBarShotsPosition(box, tick) {
  const host = historyBarEl;
  if (!host || !box || !tick) return;
  try {
    const hr = host.getBoundingClientRect();
    const tr = tick.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const k = historyBarFollowK();
    const barW = host.offsetWidth || hr.width;
    let left = (tr.left + tr.width / 2 - hr.left) / k - bw / 2;
    left = Math.max(6, Math.min(left, Math.max(6, barW - bw - 6)));
    // 锚点快照：打开时定一次——弹层上方视口内能放下则锚上方，否则落到弹层下方；此后复用（不再重判）。
    let anchor = box.dataset.anchorTop;
    if (anchor !== "above" && anchor !== "below") {
      anchor = hr.top - bh * k - 8 < 4 ? "below" : "above";
      box.dataset.anchorTop = anchor;
    }
    const top = anchor === "above" ? -bh - 8 : host.offsetHeight + 8;
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  } catch { /* 定位失败也显示（左上角），不影响预览语义 */ }
}

function historyBarShotsHide() {
  historyBarShotsTick = null; // 第2a：关闭即解除「当前刻度」绑定
  if (!historyBarEl) return;
  const b = historyBarEl.querySelector(".hhb-shots");
  if (b) {
    try { b.__offOutside?.(); } catch { /* 解绑失败不影响关闭 */ } // 解绑外部监听（移除前对同一元素）
    b.__offOutside = null;
    if (b.parentElement) b.parentElement.removeChild(b);
  }
}

// ── 双击确认框（复用 P3-G1 historyRollbackExecute）─────────────────
function historyRollbackConfirmOpen(tick, ent) {
  historyRollbackConfirmClose();
  // 2026-10-14：守卫与 historyRollbackExecute 同口径——两容器任一即可（弹层未开、只有底部提交树时也要出确认框）。
  // 确认框挂 body + position:fixed（CSS #hana-history-bar-confirm），本就不依赖 historyBarEl。
  if ((!historyBarEl && !historyTreeEl) || historyRollback.busy) return;
  // 2026-10-14 修（双击回滚窗回归）：确认框的 CSS 定义在 historyBarStyleEnsure() 注入的样式表
  // （HISTORY_BAR_STYLE_ID）内，而该函数原只在弹层 / lightbox 路径被调 → 树路径（弹层未开）
  // 从不注入 → 确认框无样式、退化为不可见块（DOM 里有、看不见点不到）。此处补注入（幂等）。
  historyBarStyleEnsure();
  const box = document.createElement("div");
  box.id = HISTORY_CONFIRM_ID;
  const text = document.createElement("div");
  text.className = "hhb-cf-text";
  text.textContent = "回到 #" + historySeqLabel(ent) + " 这一刻？";
  const warn = document.createElement("div"); // 未提交改动警告行（异步比对后回填；一致则留空）
  warn.className = "hhb-cf-warn";
  const row = document.createElement("div");
  row.className = "hhb-cf-row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "hhb-cf-btn";
  cancel.textContent = "取消";
  cancel.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyRollbackConfirmClose();
  });
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "hhb-cf-btn hhb-cf-ok";
  ok.textContent = "回跳";
  ok.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyRollbackConfirmClose();
    void historyRollbackExecute(); // 选中态已由 historyTickSelect 设好；未提交编辑拦截仍在 historyRollbackClick 一侧
  });
  row.append(cancel, ok);
  box.append(text, warn, row);
  document.body.appendChild(box);
  // 2026-10-14：点确认框外 → 关（判定域 = 框自身；点树/弹层内其它处也视为“外部” → 换选即复位）。
  box.__offOutside = bindOutsideClose(box, () => historyRollbackConfirmClose());
  // 2026-10-14：Esc 关（仅当确认框存在时生效；与 lightbox 的 Esc 互斥——两者不同时开）。
  box.__offEsc = (() => {
    const h = (e) => { if (e.key === "Escape") { e.preventDefault(); historyRollbackConfirmClose(); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  })();
  // 锚在刻度下方；越界翻到上方；水平钳在视口内
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  let r = null;
  try {
    r = tick && tick.getBoundingClientRect ? tick.getBoundingClientRect() : null;
  } catch {
    r = null;
  }
  let left = r && r.width ? r.left + r.width / 2 - bw / 2 : vw / 2 - bw / 2;
  left = Math.max(8, Math.min(left, vw - bw - 8));
  let top = r && r.width ? r.bottom + 8 : vh / 2 - bh / 2;
  if (top + bh > vh - 8) top = Math.max(8, (r && r.width ? r.top : vh / 2) - bh - 8);
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
  // 未提交改动提示：异步取该提交快照 vs 当前画布比对（复用 P3 同款公共函数）。
  // 不一致 / 比对失败 / 材料不全 → 显示警告行（宁可多提醒）；一致 → 留空（:empty 不占位）。
  // 竞态：确认框已关（或被新开的替换）→ 不回填。
  const sel = {
    file: ent && ent.file != null ? String(ent.file) : null,
    seq: ent && ent.seq != null ? ent.seq : null,
  };
  void historyDiffAgainstSnapshot(sel).then((differ) => {
    if (!differ) return;
    if (!box.isConnected || box.id !== HISTORY_CONFIRM_ID) return;
    warn.textContent = "当前画布有未提交的改动，回跳会一并丢弃。";
  });
}

// 拉取并渲染提交列表（只在弹层打开时 fetch 一次；不缓存不轮询）。
// 竞态：reqId 不等于当前哨兵 → 弹层已切其他 group 或已收起，旧响应直接丢弃。
// P6-1：不再渲染卡片列，改为在横轴（ctx.axis）上渲染刻度；轴下两端补最早/最新时间。
async function historyBarLoad(reqId, ctx, countEl) {
  let wfName = "(未命名)";
  try {
    wfName = currentWorkflowInfo().name || wfName;
  } catch {
    /* 保持默认 */
  }
  const axis = ctx && ctx.axis ? ctx.axis : null;
  const times = ctx && ctx.times ? ctx.times : null;
  const fail = (msg) => {
    if (reqId !== historyBarRequestId || !axis) return;
    axis.textContent = "";
    const errEl = document.createElement("div");
    errEl.className = "hhb-err";
    errEl.textContent = msg;
    axis.appendChild(errEl);
    if (times) times.textContent = "";
  };
  try {
    const resp = await api.fetchApi(HISTORY_LIST_PATH + withWorkflowIdQs("?workflow=" + encodeURIComponent(wfName)), {
      method: "GET",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || data.ok !== true) throw new Error(String((data && data.error) || "返回异常"));
    if (reqId !== historyBarRequestId) return; // 已切/已收起：作废
    const entries = Array.isArray(data.entries) ? data.entries : [];
    historyBarLatestEntry = entries.length ? entries[entries.length - 1] : null; // P3-G1：索引末条＝最近提交（比对基线）
    // P7（2026-10-12）框视角：只渲染「碰过当前框」的提交。
    // 口径：blockNames 为 null（旧数据，无法判定）→ 保留（不参与筛选）；为数组 → 保留当且仅当含当前框名。
    // 当前框名取不到（框不在图里 / 该框不成块 / 命名口径对不上）→ 退化为不过滤（宁多勿漏），console.warn。
    // 只影响渲染：不改 entries、不改 historyBarLatestEntry（比对基线）、不改选中态机制。
    // 缺口二：角色块视角优先取 historyBarRoleName（无 bundle 框点节点开出）；否则维持原 group 口径。
    // 比对式不变 —— ent.blockNames 同时含 group 名与 role 名（普查 6），角色块名可直接比对。
    const curBlock = historyBarRoleName || historyBlockNameOf(historyBarGroup);
    if (historyBarGroup && !curBlock) {
      console.warn(LOG_TAG, "提交历史框视角：当前框名未能判定，退化为不过滤（宁多勿漏）");
    }
    const shown = curBlock
      ? entries.filter((ent) => {
          const bn = ent && ent.blockNames;
          if (bn === null || bn === undefined) return true; // 旧数据：不参与筛选
          if (!Array.isArray(bn)) return true; // 异常字段：不参与筛选
          return bn.includes(curBlock);
        })
      : entries;
    // D6（2026-10-26）：历史框同步隐藏 —— 读隐藏集合 → sanitizeHidden → applyHidden 得 visibleShown。
    // 后续刻度渲染 / 时间标签 / 计数一律用 visibleShown。
    // 注：历史框按时间轴平铺、不看 parent（applyHidden 改写的 parent 对它无副作用）；
    //     但 applyHidden 会浅拷贝并保留 seq，seq 完整性得到保证。
    // 2026-10-26 口径统一：headSeq 传 historyTreeHead.seq（原为 null）—— HEAD 在任何视图里都不允许隐藏，
    // 否则会出现「树里还在、历史框里没了」的不一致。
    const hiddenRaw = historyHiddenGet();
    const hiddenSet = sanitizeHidden(hiddenRaw, shown, historyTreeHead && historyTreeHead.seq);
    const visibleShown = hiddenSet.size ? applyHidden(shown, hiddenSet) : shown;
    if (countEl) countEl.textContent = visibleShown.length + " 次提交";
    if (!axis) return;
    axis.textContent = "";
    if (times) times.textContent = "";
    // 统一母题「外框+内条」上下文：泳道表 + 活图框名→框色映射 + no-frame 退化标志。
    // 泳道表口径（2026-10-19 作者定案）：「其他」是 graphBlocks 自然产出的块（画布上有未分组节点时才存在），
    // 与组同级别。allBlocks 直接等于活图块名（按活图顺序去重），不额外追加任何泳道；
    // 历史提交里块名对不上当前任何块的 → 那根不对应任何小条，不亮，也不会多出一条。
    if (ctx) {
      const liveBlocks = historyLiveBlocks(); // 活图块清单（取不到 → null）
      let allBlocks = null;
      if (liveBlocks) {
        allBlocks = [];
        const seen = new Set();
        for (const b of liveBlocks) {
          const nm = b && b.name != null ? String(b.name) : "";
          if (nm && !seen.has(nm)) { seen.add(nm); allBlocks.push(nm); }
        }
      } else {
        // 活图取不到（无画布 / 异常）→ 退回旧行为：visibleShown 的块名并集，保证不炸。
        allBlocks = [];
        const seen = new Set();
        for (const ent of visibleShown) {
          const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : [];
          for (const b of bl) {
            const nm = b && b.name != null ? String(b.name) : "";
            if (nm && !seen.has(nm)) { seen.add(nm); allBlocks.push(nm); }
          }
        }
      }
      ctx.allBlocks = allBlocks;
      ctx.colorMap = historyLiveBlockColors(liveBlocks || undefined);
      ctx.singleBar = allBlocks.length === 0;
    }
    if (!visibleShown.length) {
      const empty = document.createElement("div");
      empty.className = "hhb-empty";
      empty.textContent = curBlock ? "这个块没有提交记录" : "这个工作流还没有提交记录";
      axis.appendChild(empty);
      return;
    }
    // 宽度自适应（定稿卡数值）：少时加宽（≤44）、多时定宽（≥11）+ 横滚；刻度随之缩窄。
    const n = visibleShown.length;
    const availW = axis.clientWidth || 0;
    const colW = Math.min(72, Math.max(22, availW / n)); // 第8条（2026-10-13）：下限 11→22（面板可横滚 → 密档不压缩 colW，靠溢出滚动）
    let tw = Math.min(24, Math.max(5, colW * 0.5)); // 第8条：单块更瘦（系数 0.72→0.5，下限 4→5）
    const twBulge = Math.min(tw + 10, colW - 3); // 第8条：多块更宽（+8→+10，封顶 colW-2→colW-3）→ 单/多差拉大
    tw = Math.min(tw, colW * 0.86);
    const gap = Math.max(2, colW - tw);
    axis.style.gap = gap + "px";
    if (ctx) ctx.colW = colW;
    // 刻度左旧右新：按 entries 原序（索引本身按 seq/时间递增）直接 append
    for (const ent of visibleShown) {
      const tick = historyBarTickMake(reqId, ent, ctx);
      tick.style.setProperty("--hhb-tw", tw + "px");
      tick.style.setProperty("--hhb-tw-bulge", twBulge + "px"); // 第7条：多块宽（已 clamp colW-2）
      axis.appendChild(tick);
    }
    // 定位到最新（左旧右新 + 打开滚到最右）
    axis.scrollLeft = axis.scrollWidth;
    historyBarUpdateAxisFade(axis);
    // 轴下：左端最早时间 / 右端最新时间（historyFmtTime）
    if (times) {
      const first = document.createElement("span");
      first.textContent = historyFmtTime(visibleShown[0] && visibleShown[0].at);
      const last = document.createElement("span");
      last.textContent = historyFmtTime(visibleShown[visibleShown.length - 1] && visibleShown[visibleShown.length - 1].at);
      times.append(first, last);
    }
  } catch (err) {
    fail("提交历史加载失败：" + String((err && err.message) || err));
    // 不抛异常：失败只落在弹层内
  }
}

// 轴两端渐隐更新：左边不可再左滚（scrollLeft <= 1）→ 隐；右边到底 → 隐（scrollLeft+clientWidth >= scrollWidth-1）。
function historyBarUpdateAxisFade(axis) {
  if (!axis) return;
  const wrap = axis.parentElement;
  if (!wrap || !wrap.classList.contains("hhb-axiswrap")) return;
  const l = wrap.querySelector(".hhb-fade.l");
  const r = wrap.querySelector(".hhb-fade.r");
  if (l) l.classList.toggle("hhb-fade-on", axis.scrollLeft > 1);
  if (r) r.classList.toggle("hhb-fade-on", axis.scrollLeft + axis.clientWidth < axis.scrollWidth - 1);
}

// 打开弹层（重复调用=切换：先拆旧再建新）。
// P6-1：参数由 anchor 点改为 group 本体 —— 锚定「框矩形顶部上方」（弹层底边贴近框顶）。
// 提交历史框重读（2026-10-22）：出图上报后调。
// 做法是「关掉再按同样视角重开」—— 复用现有 historyBarOpen / historyBarOpenRole 的
// 全部逻辑（锚点/框过滤/角色块过滤），不另写取数路径。没开着就不动。
function historyBarReloadIfOpen() {
  if (!historyBarEl) return;
  const g = historyBarGroup;
  const roleName = historyBarRoleName;
  historyBarClose();
  if (roleName && typeof historyBarOpenRole === "function") historyBarOpenRole(roleName);
  else if (g) historyBarOpen(g);
}
function historyBarOpen(group) {
  historyBarStyleEnsure();
  historyTickStateClear(); // P6-1：重开 → 三态残留先清
  historyRollbackStateReset(); // P3-G1：切换 group → 回跳态复位（同收起语义）
  historyBarSelection = null;
  historyBarLatestEntry = null;
  if (historyBarEl && historyBarEl.parentElement) {
    historyBarEl.parentElement.removeChild(historyBarEl);
  }
  const bar = document.createElement("div");
  bar.id = HISTORY_BAR_ID;
  historyBarEl = bar;
  historyBarGroup = group || null; // P5b：存档后重开弹层用（同 group 重载）
  historyBarRoleName = null; // 缺口二：group 视角 → 清角色块视角（historyBarOpenRole 打开后回填）
  // 头部：<分组框名> · <N 次提交>（fetch 后回填）+ 构建号 + ✕
  const title = document.createElement("div");
  title.className = "hhb-title";
  const wf = document.createElement("span");
  wf.className = "hhb-wf";
  if (group) {
    wf.textContent = historyGroupName(group);
  } else {
    try {
      wf.textContent = currentWorkflowInfo().name || "(未命名)";
    } catch {
      wf.textContent = "(未命名)";
    }
  }
  wf.title = wf.textContent;
  const count = document.createElement("span");
  count.className = "hhb-count";
  count.textContent = "…";
  const build = document.createElement("span"); // 契约 §2.4：版本标志（构建号短串）
  build.className = "hhb-build";
  build.textContent = historyBuildShort();
  build.title = BUILD_TAG;
  const x = document.createElement("button");
  x.type = "button";
  x.className = "hhb-x";
  x.textContent = "✕";
  x.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyBarClose();
  });
  title.append(wf, count, build, x);
  // 横轴（默认态：只有轴 + 刻度）；先放加载占位。轴外包 .hhb-axiswrap + 两端渐隐。
  const axis = document.createElement("div");
  axis.className = "hhb-axis";
  const loading = document.createElement("div");
  loading.className = "hhb-empty";
  loading.textContent = "加载中…";
  axis.appendChild(loading);
  const axisWrap = document.createElement("div");
  axisWrap.className = "hhb-axiswrap";
  const fadeL = document.createElement("div");
  fadeL.className = "hhb-fade l";
  const fadeR = document.createElement("div");
  fadeR.className = "hhb-fade r";
  axisWrap.append(axis, fadeL, fadeR);
  // 横滚轴：优先 ΔX（触控板横滑），否则 ΔY（鼠标滚轮）；到两端放行（不 preventDefault）
  const hscroll = (el) => (ev) => {
    if (el.scrollWidth <= el.clientWidth) return; // 不可滚 → 放行
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (d > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1) return; // 已在最右 → 放行
    if (d < 0 && el.scrollLeft <= 0) return; // 已在最左 → 放行
    ev.preventDefault();
    el.scrollLeft += d;
  };
  axis.addEventListener(
    "wheel",
    (ev) => {
      hscroll(axis)(ev);
      historyBarUpdateAxisFade(axis);
    },
    { passive: false }
  );
  axis.addEventListener("scroll", () => historyBarUpdateAxisFade(axis));
  // 轴下两端时间（fetch 后回填）
  const times = document.createElement("div");
  times.className = "hhb-times";
  // 单击刻度的缩略图浮层：第2a 起改为「每次点开时新建浮层」（同树 .htr-shots），不再占弹层内的行位
  // 底部：回到这一版（P3-G1 真功能）+ 弹层内提示行
  const foot = document.createElement("div");
  foot.className = "hhb-foot";
  const roll = document.createElement("button");
  roll.type = "button";
  roll.className = "hhb-roll";
  roll.textContent = "回到这一版";
  roll.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void historyRollbackClick(); // P3-G1：回跳动作（详见下方专块）
  });
  const tip = document.createElement("span");
  tip.className = "hhb-msg";
  // P5b（契约 §3.3）：存档当前画布（人的入口，独立动作，不参与回跳选中态）。
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "hhb-save";
  saveBtn.textContent = "存档当前画布";
  saveBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void historySaveClick();
  });
  foot.append(roll, saveBtn, tip);
  bar.append(title, axisWrap, times, foot);
  document.body.appendChild(bar); // position:fixed 自行定位，挂 body 避免容器裁剪
  // 第2a：已移除「鼠标移出 180ms 自动关」（浮层关闭改由「再点同一刻度」判定，同树）
  // P6-2：定位改为「跟随画布」——底边中心对准框顶，随 ds.scale 缩放（clamp 到 [MIN, MAX]）。
  // 起 rAF 循环：打开期间每帧比对视图态，变了才重算锚点/transform；locate 由 historyBarFollowApply 落到 style。
  historyBarFollowStart();
  // 打开时才 fetch；竞态哨兵在途响应作废
  const ctx = { axis, times };
  const reqId = ++historyBarRequestId;
  void historyBarLoad(reqId, ctx, count);
}

// ── 2026-10-15 缺口二：无 bundle 框时点节点开「角色块」历史框 ─────────────────────
// 轻封装 historyBarOpen(group = null)：先按无框打开（标题退工作流名、过滤退全量），再置角色块名。
// 时序：historyBarLoad 的取数在 await 之后才读 historyBarRoleName，同轮同步赋值必先于响应到达 → 过滤/标题按角色块生效。
function historyBarOpenRole(roleName) {
  const nm = roleName == null ? "" : String(roleName);
  if (!nm) return;
  historyBarOpen(null); // 复用弹层构造（锚定取不到框 → 回退视口中心）
  historyBarRoleName = nm; // 覆盖 historyBarOpen 的清零
  const wf = historyBarEl ? historyBarEl.querySelector(".hhb-wf") : null;
  if (wf) {
    wf.textContent = "角色块：" + nm; // 标题与 group 视角对称（group 视角显示框名）
    wf.title = wf.textContent;
  }
}

// 节点 → 所属「角色块」名（缺口二用）：消费 graphBlocks 输出，**不改其本体**。
// 口径：graphBlocks 里 source === "role" 且 nodeIds 含该节点 id 的块 → 取其 name；找不到 → null（调用方回落收起）。
// 边界：graphBlocks 里 group 优先（落框内的节点只进 group 块），故「框内节点」此处返回 null ——
//       但本函数只在「无 group 命中」时才走到（真有框时先走 group 分支），故不影响有框行为。
function historyRoleBlockNameOfNode(node) {
  if (!node) return null;
  let blocks = null;
  try {
    const g = app && app.graph ? app.graph : null;
    if (!g || typeof g.toJSON !== "function") return null;
    blocks = graphBlocks(g.toJSON());
  } catch (err) {
    console.warn(LOG_TAG, "提交历史：节点所属角色块名读取失败（不影响画布）", err);
    return null;
  }
  const nidS = node.id == null ? "" : String(node.id);
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || b.source !== "role") continue;
    const ids = Array.isArray(b.nodeIds) ? b.nodeIds : [];
    for (const id of ids) {
      if (String(id) === nidS) return b.name;
    }
  }
  return null;
}

// 画布坐标 → 命中节点（缺口二用）。探测结论（2026-10-15，前端 1.55.14 打包产物核对）：
//   · graph.getNodeOnPos(x, y, nodes?) → ✅ 存在（定义在 LGraph 上，与 getGroupOnPos 同处；
//     体：nodesInRenderOrder(this) 倒序遍历 + node.isPointInside）；canvas 上无同名方法。
//   · 故 graph 优先、canvas 次之（兼容未来版本挪位，同 getGroupOnPos 的写法）。
//   · 都不可用/抛错 → 倒序遍历 graph._nodes + isPointInside 兜底，再退 pos/size 矩形命中。
function historyNodeAtCanvasPos(x, y) {
  const canvas = app && app.canvas;
  const graph = (canvas && canvas.graph) || (app && app.graph) || null;
  if (!canvas || !graph) return null;
  if (typeof graph.getNodeOnPos === "function") {
    try {
      const n = graph.getNodeOnPos(x, y);
      if (n) return n;
    } catch {
      /* 落到兜底 */
    }
  }
  if (typeof canvas.getNodeOnPos === "function") {
    try {
      const n = canvas.getNodeOnPos(x, y);
      if (n) return n;
    } catch {
      /* 落到兜底 */
    }
  }
  // 兜底（同 group 兜底的倒序口径）：后添加者优先；isPointInside 首选 → pos/size 矩形次之
  const nodes = Array.isArray(graph._nodes) ? graph._nodes : [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n) continue;
    if (typeof n.isPointInside === "function") {
      try {
        if (n.isPointInside(x, y)) return n;
      } catch {
        /* 跳过该节点 */
      }
    }
    const p = n.pos;
    const s = n.size;
    if (Array.isArray(p) && Array.isArray(s) && typeof p[0] === "number" && typeof p[1] === "number") {
      const w = typeof s[0] === "number" ? s[0] : 0;
      const h = typeof s[1] === "number" ? s[1] : 0;
      if (x >= p[0] && x <= p[0] + w && y >= p[1] && y <= p[1] + h) return n;
    }
  }
  return null;
}

// 点击钩子（只读）：命中 group → 弹出/切换；无 group 命中节点 → 按角色块开；点空白 → 收起。任何分支不改画布状态。
function historyOnCanvasMouseDown(e) {
  if (!e) return;
  // 同一事件可能经多入口到达（实例重绑回调 / 自挂 capture 监听）→ 只处理一次（防重复弹层/重复 fetch）
  if (historyGroupHookSeenEvents.has(e)) return;
  historyGroupHookSeenEvents.add(e);
  if (e.button !== undefined && e.button !== 0) return; // 只响应左键；其余不干预
  const canvas = app && app.canvas;
  if (!canvas) return;
  let off = null;
  try {
    off = canvas.convertEventToCanvasOffset(e);
  } catch {
    off = null;
  }
  let group = null;
  // 主命中路径修正（P2-F1b）：getGroupOnPos 定义在 graph（LGraph）上，不在 canvas 上。
  // 真机实测（2026-10-11，新前端 comfyui_frontend_package 1.55.14）：
  //   · canvas.getGroupOnPos               → ❌ 不存在
  //   · graph.getGroupOnPos(x, y)          → ✅ 存在（注意是 graph，不是 canvas）
  // 源码核对（同包 static/assets/settingStore-X9ZV_dAu.js 内 `class LGraph`，方法体 offset≈495576）：
  //   getGroupOnPos(e,t){for(let n=this._groups.length-1;n>=0;n--){let r=this._groups[n];if(r.isPointInside(e,t))return r}}
  //   → 「倒序遍历 + isPointInside」：重叠时取最后添加的 group，且尊重 group 的实际形状。
  //     官方调用点同此口径（同包 getCanvasContextMenuTarget / processMouseDown 均走 e.graph.getGroupOnPos）。
  // 兼容：未来前端版本可能把它挪回 canvas，故 graph 优先、canvas 次之，取先存在的那个。
  if (off) {
    const getOnPos =
      canvas.graph && typeof canvas.graph.getGroupOnPos === "function"
        ? canvas.graph.getGroupOnPos.bind(canvas.graph)
        : typeof canvas.getGroupOnPos === "function"
          ? canvas.getGroupOnPos.bind(canvas)
          : null;
    if (getOnPos) {
      try {
        group = getOnPos(off[0], off[1]) || null;
      } catch {
        group = null;
      }
    }
  }
  // 兜底（主/次路径都不可用或抛错）：倒序遍历 graph._groups —— 与 getGroupOnPos 语义对齐（后添加的框优先）。
  // 正序会命中最先添加的框，与官方口径相反；重叠时结果会错。
  // 命中判定按可用性依次尝试：g.isPointInside(x,y)（首选，尊重真实形状）→ historyGroupRect(g)，
  // 后者内部再依次：boundingRect → _bounding（真机实测有值，如 [520,-90,396.9,708]）→ bounding（旧版/序列化）
  // → _pos/_size → pos/size。任一命中即停。
  if (!group && off && canvas.graph && Array.isArray(canvas.graph._groups)) {
    const groups = canvas.graph._groups;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (!g) continue;
      let hit = false;
      if (typeof g.isPointInside === "function") {
        try {
          hit = !!g.isPointInside(off[0], off[1]);
        } catch {
          hit = false;
        }
      }
      if (!hit) {
        const b = historyGroupRect(g);
        if (b && off[0] >= b[0] && off[0] <= b[0] + b[2] && off[1] >= b[1] && off[1] <= b[1] + b[3]) {
          hit = true;
        }
      }
      if (hit) {
        group = g;
        break;
      }
    }
  }
  // 2026-10-15 缺口二：无 group 时，单击节点 → 取该节点所属角色块名 → 开该块的历史框。
  // 有 group 时行为完全不变（优先 group，本分支只在 group 命中失败后才走）。
  if (!group && off) {
    const hitNode = historyNodeAtCanvasPos(off[0], off[1]);
    if (hitNode) {
      const roleName = historyRoleBlockNameOfNode(hitNode);
      if (roleName) {
        historyBarOpenRole(roleName); // 标题＝角色块名；过滤＝只显示碰过该块的提交
        return;
      }
    }
  }
  if (!group) {
    if (historyBarEl) historyBarClose(); // 点空白 → 收起
    return;
  }
  // 第4条（2026-10-13）：同一框再点 = 关（切换）；已开别的框 / 未开 → 开。
  if (historyBarEl && historyBarGroup === group) {
    historyBarClose();
    return;
  }
  historyBarOpen(group); // P6-1：锚定改为「框矩形顶部上方」，由 historyBarOpen 内部用 historyGroupRect/convertOffsetToCanvas 算；取不到框 → 回退视口中心
}

// 安装 group 点击命中（幂等 + 可重入）。setup() 里调用；另有延迟重试（见 scheduleHistoryGroupInstallRetries）。
//
// P2-F1b-3（2026-10-11）真机根因（桥旧版只包原型、事件到不了）：
//   litegraph 在「绑事件那一刻」就冻结了回调 —— bindEvents() 内：
//     this._mousedown_callback = this.processMouseDown.bind(this)
//   桥在此之后才替换原型 → 事件触发时走的仍是**旧绑定函数**，我们的包装被完全绕过。
//   实测（真机 headless Chrome + CDP）：prototype.processMouseDown 含包装=true，
//   canvas._mousedown_callback 含包装=false，canvas._events_binded=true。
//   同时印证：直接 proto.processMouseDown.call(canvas,e) 手工调用时命中链完全正确
//   （convertEventToCanvasOffset → graph.getGroupOnPos → 命中目标 group）—— 判定逻辑无误，
//   问题只在「事件到不了」。故必须：① 包原型（保留，兼容未来重新 bindEvents）；
//   ② 重新指向实例上的事件回调（并把元素监听同步换新）；③ 在 canvas 元素上自挂 capture 监听
//   （独立于 litegraph 绑定，最稳；只读不改事件）。
//
// bindEvents 源码原文（comfyui_frontend_package 1.55.14，static/assets/settingStore-X9ZV_dAu.js，
// `LGraphCanvas.bindEvents`，offset≈373756）：
//   this._mousedown_callback   = this.processMouseDown.bind(this)
//   this._mouseup_callback     = this.processMouseUp.bind(this)
//   this._mousemove_callback   = this.processMouseMove.bind(this)
//   this._mouseout_callback    = this.processMouseOut.bind(this)
//   this._mousecancel_callback = this.processMouseCancel.bind(this)
//   e.addEventListener(`pointerdown`,   this._mousedown_callback,   !0)   ← 事件名 pointerdown，capture=true
//   e.addEventListener(`wheel`,         this._mousewheel_callback,  !1)   ← bubble
//   e.addEventListener(`pointerup`,     this._mouseup_callback,    !0)
//   e.addEventListener(`pointermove`,   this._mousemove_callback)          ← 无第三参 = bubble
//   e.addEventListener(`pointerout`,    this._mouseout_callback)
//   e.addEventListener(`pointercancel`, this._mousecancel_callback, !0)
//   e.addEventListener(`contextmenu`,   this._doNothing)
//   e.addEventListener(`auxclick`,      this._preventMiddleAuxClick)
//   this._key_callback = this.processKey.bind(this); e.addEventListener(`keydown`, this._key_callback, !0)
//   t.addEventListener(`keyup`, this._key_callback, !0)
//   e.addEventListener(`dragover`/`dragend`/`dragenter`, ...)
//   → 要点：① 按下只绑 **pointerdown**（没有 mousedown 监听，故重绑按 pointerdown 对齐）；
//           ② capture 标志 = **true**（第三个参数 !0）——重绑/摘除必须带同一标志，否则摘不掉、也行为不一致；
//           ③ **未使用 AbortController**，摘除完全依赖实例字段 this._mousedown_callback：
//              unbindEvents(){ ... t.removeEventListener(`pointerdown`, this._mousedown_callback); ...
//                              this._mousedown_callback = void 0; ... }
//              → 故重绑时必须**同步更新 this._mousedown_callback**，否则日后 unbindEvents 会摘不到新回调。
function installHistoryGroupClick() {
  installHistoryGroupProto();
  installHistoryGroupCanvasBind();
}

// ① 包原型（幂等，只做一次）。留作「之后重新 bindEvents / 未来版本」的兼容层。
function installHistoryGroupProto() {
  if (historyGroupProtoWrapped) return;
  const proto =
    typeof LGraphCanvas !== "undefined" && LGraphCanvas && LGraphCanvas.prototype
      ? LGraphCanvas.prototype
      : null;
  if (!proto || typeof proto.processMouseDown !== "function") {
    console.warn(LOG_TAG, "P2-F1 跳过：LGraphCanvas.prototype.processMouseDown 不存在（前端版本不支持）");
    return;
  }
  const orig = proto.processMouseDown;
  proto.processMouseDown = function (e) {
    // 钩子先行、只读：异常吞掉只 warn，绝不影响原生按下行为
    try {
      historyOnCanvasMouseDown(e);
    } catch (err) {
      console.warn(LOG_TAG, "P2-F1 点击钩子失败（不影响画布）", err);
    }
    // 只读透传：this / arguments / 返回值 / 抛错时机全保持原样
    return orig.apply(this, arguments);
  };
  historyGroupProtoWrapped = true;
}

// ② 对当前 canvas 实例安装（幂等、可重入；对每个实例/元素各做一次）。
//    与原型包装互补：即便某实例自持 processMouseDown 覆盖而绕过原型，这里也会补包。
function installHistoryGroupCanvasBind() {
  const c = app && app.canvas;
  if (!c) return; // 时序：setup() 时 app.canvas 可能尚不存在 → 由延迟重试补齐
  const el = c.canvas || c.canvasEl || null;

  // ②-a 实例自持 processMouseDown 覆盖（会绕过原型包装）→ 就地再包一层（幂等）
  if (
    typeof c.processMouseDown === "function" &&
    Object.prototype.hasOwnProperty.call(c, "processMouseDown") &&
    !historyGroupInstanceWrapped.has(c)
  ) {
    const own = c.processMouseDown;
    c.processMouseDown = function (e) {
      try {
        historyOnCanvasMouseDown(e);
      } catch (err) {
        console.warn(LOG_TAG, "P2-F1 点击钩子失败（不影响画布）", err);
      }
      return own.apply(this, arguments);
    };
    historyGroupInstanceWrapped.add(c);
  }

  // ②-b 重新指向实例事件回调：litegraph 冻结的是 bindEvents 那一刻的绑定函数，必须换新。
  //      条件用「实例上存在 _mousedown_callback 函数」（unbindEvents 会把它置 void 0）。
  //      此时 c.processMouseDown 已是包装版（原型已在 ① 替换；若实例自持则 ②-a 已补包），
  //      故 next 内部必然经过 historyOnCanvasMouseDown。
  if (typeof c._mousedown_callback === "function" && !historyGroupBoundCanvases.has(c)) {
    const old = c._mousedown_callback;
    const next = c.processMouseDown.bind(c);
    if (el && typeof el.removeEventListener === "function") {
      el.removeEventListener("pointerdown", old, true); // flags 与 bindEvents 一致（capture=true）
    }
    c._mousedown_callback = next; // 同步字段：unbindEvents 才摘得到新回调
    if (el && typeof el.addEventListener === "function") {
      el.addEventListener("pointerdown", next, true);
    }
    historyGroupBoundCanvases.add(c);
  }

  // ②-c 自挂 capture 监听（独立于 litegraph 的内部绑定，最稳；只读：不改 e、不 prevent/stop）。
  //      与 litegraph 同元素同事件（pointerdown）+ 同 capture 标志，故必定随事件到；
  //      与 ②-b 可能同时到达同一事件 → 由 historyGroupHookSeenEvents 去重，只处理一次。
  if (el && typeof el.addEventListener === "function" && !historyGroupBoundElements.has(el)) {
    el.addEventListener(
      "pointerdown",
      (e) => {
        try {
          historyOnCanvasMouseDown(e);
        } catch (err) {
          console.warn(LOG_TAG, "P2-F1 点击钩子失败（不影响画布）", err);
        }
      },
      true
    );
    historyGroupBoundElements.add(el);
  }
}

// 延迟重试：setup() 执行时 app.canvas / canvas 元素可能尚未就绪（有就绪也有未就绪两种实测）。
// 已绑则内部各哨兵跳过（幂等）；元素/实例若在启动后重建，重入也会自愈（WeakSet 按对象区分）。
function scheduleHistoryGroupInstallRetries() {
  const delays = [500, 1500, 3000, 6000];
  for (const ms of delays) {
    setTimeout(() => {
      try {
        installHistoryGroupClick();
      } catch (err) {
        console.warn(LOG_TAG, "P2-F1 延迟安装失败（不影响画布）", err);
      }
      // N1（2026-10-12）：复用同一批延迟时机补装「换图」监听（app.canvas 可能晚到；已绑则内部跳过）
      try {
        installHistoryGraphSwitchListener();
      } catch (err) {
        console.warn(LOG_TAG, "N1 延迟安装失败（不影响画布）", err);
      }
    }, ms);
  }
}

// ── N1（2026-10-12）：工作流切换感知（画布换图 → 刷新提交树 + 收起弹层）──────────────
// 背景：setup() 只装了 queuePrompt 捕获 / 出图捕获 / 树容器 / 点击命中 / pollGraph，没监听
//   「换图」→ 切工作流后底部提交树仍显示上一个工作流的计数（新工作流显示「0 节点」），
//   弹层比对基线（historyBarLatestEntry）也过期。
// 事件依据（前端包 comfyui_frontend_package 1.55.14 实证，static/assets/settingStore-X9ZV_dAu.js）：
//   LGraphCanvas.setGraph(e)：`e!==t&&( … this.dispatch(`litegraph:set-graph`,{newGraph:e,oldGraph:t}) … )`
//   LGraphCanvas.dispatch(e,t)：`let n=new CustomEvent(e,{detail:t,bubbles:!0});return this.canvas.dispatchEvent(n)`
//   → 事件派发在 **canvas 画布元素**（this.canvas = setCanvas 传入的 HTMLCanvasElement）上，bubbles=true。
//   故挂点与点击命中同源：`app.canvas.canvas`（或 canvasEl）。
// 幂等：WeakSet 按元素区分（元素重建 → 视为新元素，重入自愈）；多次装不重复。
// 异常：一律 try/catch 吞 + warn，绝不影响画布；只加「触发刷新」入口，不改树/弹层既有逻辑。
const historyGraphSwitchBoundElements = new WeakSet(); // 已挂 litegraph:set-graph 监听的 canvas 元素（幂等）

// 换工作流后的**统一判据 + 动作**（主路径事件回调 与 兜底轮询共用同一入口）。
// N1修（2026-10-12）：litegraph:set-graph 在**任意 setGraph** 时都触发（进/出子图 openSubgraph、
//   回跳装载 loadGraphData 也走 setGraph）→ 事件本身不代表「换了工作流」，必须先比对工作流名。
// 判据（与轮询兜底同源，统一到这里，不再两套）：
//   取当前工作流名 currentWorkflowInfo().name（try/catch，取不到则保守不动）；
//   与基线 lastWorkflowName 比 —— 名字**变了**才是真换工作流；
//   名字**没变**（进子图 / 回跳装载：页身份不变）→ 直接返回，不误关用户正开着的弹层。
// 动作（仅真换工作流时执行）：
//   ① 刷新底部提交树（新工作流 → 重新取数，计数/渲染跟着走）；
//   ② 弹层若开着 → 收起（弹层锚定的框属于旧图，关掉最稳，符合「点空白收起」语义）。
// 幂等：同名重复调用直接返回 false；基线未建立时只记录、不执行（避免首次误判）。
// 返回：true = 真换了工作流（已执行动作）；false = 未换 / 取不到 / 基线未建立。
function historyOnWorkflowSwitch() {
  let name = null;
  try {
    name = currentWorkflowInfo().name || null;
  } catch {
    name = null;
  }
  if (name === null) return false; // 取不到工作流名 → 保守不动
  if (lastWorkflowName === null) {
    // 基线未建立（首次）→ 只记录，不执行（避免首轮就误判成「换工作流」把弹层关掉）
    lastWorkflowName = name;
    // 首次建立时也记图签名基线（供后续「改名 vs 换图」判据用）。
    try { lastWorkflowGraphSig = graphSignature()?.hash || null; } catch { lastWorkflowGraphSig = null; }
    return false;
  }
  if (name === lastWorkflowName) return false; // 同名 → 进子图 / 回跳装载，不误关弹层
  // 2026-10-14：名字变了 —— 用图签名区分「改名」vs「换图」。
  // 保存改名不改图内容 → 签名相同 → 判为改名 → 迁移旧名历史到新名；打开另一张图 → 签名不同 → 不迁移。
  let sig = null;
  try { sig = graphSignature()?.hash || null; } catch { sig = null; }
  if (sig != null && lastWorkflowGraphSig != null && sig === lastWorkflowGraphSig) {
    // 同一张图、仅改名（保存/另存）→ 迁移旧名历史到新名
    reportHistoryMigrate(lastWorkflowName, name);
  }
  lastWorkflowGraphSig = sig; // 更新基线（即使 sig 为 null 也更新，避免陈旧）
  lastWorkflowName = name; // 真换了工作流：更新基线，往下执行动作
  try {
    void historyTreeRefresh();
  } catch (err) {
    console.warn(LOG_TAG, "N1 换图刷新提交树失败（不影响画布）", err);
  }
  try {
    if (historyBarEl) historyBarClose();
  } catch (err) {
    console.warn(LOG_TAG, "N1 换图收起弹层失败（不影响画布）", err);
  }
  return true;
}

// 安装「换图」监听（幂等 + 可重入）。setup() 里调用一次；另有延迟重试（见 scheduleHistoryGroupInstallRetries）。
// 只读：不改 e、不 prevent/stop；异常吞掉只 warn。
function installHistoryGraphSwitchListener() {
  const c = app && app.canvas;
  if (!c) return; // 时序：setup() 时 app.canvas 可能尚不存在 → 由延迟重试补齐（轮询兜底再保一层）
  const el = c.canvas || c.canvasEl || null;
  if (!el || typeof el.addEventListener !== "function") return;
  if (historyGraphSwitchBoundElements.has(el)) return; // 幂等：同一元素只挂一次
  el.addEventListener("litegraph:set-graph", () => {
    try {
      historyOnWorkflowSwitch();
    } catch (err) {
      console.warn(LOG_TAG, "N1 换图处理失败（不影响画布）", err);
    }
  });
  historyGraphSwitchBoundElements.add(el);
}

// ── P3-G1（2026-10-11）：回跳到所选提交（branch 式原地回跳，不造副本）────────────
// 设计依据：docs/方案-画布提交历史.md §六 —— 每次提交本身是存档点；回跳可逆（点回新节点
// 即可），安全网从「副本」换「时间轴」。不自动落盘、不自动提交（回跳后画布相对文件是
// 「已修改」，保存或再提交由用户决定）；不造「回滚前快照」（会往时间轴混入非运行节点，
// 破坏「提交 = 运行」语义）。
// 闸门复核（2026-10-11，实现前复核结论）：副驾驶写闸门只挂在 agent 的桥 op 通道上 ——
// copilotWriteBlocked（约 L2700）只在 EVT_CALL 分发器（/hana_bridge/call 推来后的监听器，
// 约 L2721）内调用，服务端也只经该通道下发 op；本回跳动作只从弹层按钮的 DOM click 触发，
// 不产 op、不走 EVT_CALL → 不受 COPILOT_WRITE_EXEMPT / copilotWriteBlocked 约束（因此
// 两个名单都不改；copilotReadState 也无涉）。副驾驶关闭时本功能同样可用。
// 未提交编辑拦截（护栏 3）：canvas-diff.mjs 在 Node 侧，前端不可用 —— 简化口径 =
// graphSignature()（同款，L634：节点数+连线数+逐节点 fnv1a 签名，不含位置）比对当前画布
// 与最近一次提交（historyBarLoad 时回填的索引末条）。不一致 → 二次点击确认制（60s 超时/收
// 起弹层复位）；一致 → 单击直接执行。
// 装载：复用 loadWorkflowFile（L1339 起）的入口与参数语义 —— loadGraphData(graph, true,
// true, aw) 装进当前页（第 4 参传当前活动页对象 aw，保持页身份；上游 activateLoadedWorkflow
// 对「对象」走 store.openWorkflow(aw)）。graph 由快照端点直接传参，不经文件。
// P3-G1 画布写边界：装载是画布写操作，但**只由用户点「回到这一版/确认回跳」触发**，代码
// 内无任何自动触发路径（不接轮询/事件）。
const HISTORY_SNAPSHOT_PATH = "/hana_bridge/history-snapshot"; // fetchApi 自动加 /api 前缀（同 history-list，已实测等价口径）

// 二次确认状态复位（收起弹层 / 切换 group / 换选卡片 / 执行完成时调）
function historyRollbackStateReset() {
  if (historyRollback.timer) {
    clearTimeout(historyRollback.timer);
    historyRollback.timer = null;
  }
  historyRollback.armed = false;
  historyRollback.busy = false;
  historyRollbackBtnReset();
}

// 按钮回普通态（保留 busy；busy 时调用方自管文案）
function historyRollbackBtnReset() {
  if (!historyBarEl) return;
  const roll = historyBarEl.querySelector(".hhb-roll");
  if (roll) {
    roll.textContent = "回到这一版";
    roll.classList.remove("hhb-roll-armed");
  }
}

// 简化口径的「画布 vs 某提交快照」一致性判定（同 graphSignature 口径：nodeCount +
// linkCount + 逐节点 hash 集）。签名 / 快照读不出来 → null（调用方按「不一致」走确认制）。
// 备注（P3-G1 实现时复核）：graphSignature 的逐节点 hash 串接顺序为 type:mode:title:widgets，
// 且 widgets 项带 name= 前缀；快照落盘只有 widgets_values 数组（无 widget name）且无 mode
// 字段，故 historySnapshotGraphSig 按 type:0(title):widgets_values 串接 —— 两者仅用于
// 「当前画布 vs 最近提交快照」同口径对齐（同函数族、同 fnv1a），不要求跨形态哈希一致。
function historyGraphSigForCompare() {
  try {
    const sig = graphSignature();
    return { nodeCount: sig.nodeCount, linkCount: sig.linkCount, perNode: sig.perNode };
  } catch {
    return null;
  }
}

// 快照 graph 对象 → 与 graphSignature 同构的签名（节点以 id+type+widgets 串接 hash）。
// 只用 UI 格式字段（nodes[].id/type/widgets_values），与提交快照的落盘格式同源。
function historySnapshotGraphSig(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  const perNode = {};
  let linkCount = 0;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    let w = "";
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    for (const v of wv) {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      w += s + ";";
    }
    const idStr = String(n.id);
    perNode[idStr] = fnv1a(`${n.type}:0:${n.title || ""}:${w}`);
  }
  if (graph && Array.isArray(graph.links)) linkCount = graph.links.length;
  return { nodeCount: nodes.length, linkCount, perNode };
}

function historySnapshotsDiffer(cur, snapSig) {
  if (!cur || !snapSig) return true; // 比对材料不全 → 视为不一致（走确认制，宁可多问）
  if (cur.nodeCount !== snapSig.nodeCount || cur.linkCount !== snapSig.linkCount) return true;
  const a = cur.perNode || {};
  const b = snapSig.perNode || {};
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  for (const k of ka) if (a[k] !== b[k]) return true;
  return false;
}

// 取快照完整 JSON（含 graph 本体）。seq 为空时用 file 定位；都空 → null。
async function historyFetchSnapshot(sel) {
  const qs = withWorkflowIdQs("?workflow=" + encodeURIComponent(currentWorkflowInfo().name || "(未命名)"));
  if (sel && sel.file) return historyFetchSnapshotQs(qs + "&file=" + encodeURIComponent(sel.file));
  if (sel && sel.seq != null) return historyFetchSnapshotQs(qs + "&seq=" + encodeURIComponent(String(sel.seq)));
  throw new Error("未选中要回到的提交");
}

async function historyFetchSnapshotQs(qs) {
  const resp = await api.fetchApi(HISTORY_SNAPSHOT_PATH + qs, { method: "GET" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  if (!data || data.ok !== true) throw new Error(String((data && data.error) || "返回异常"));
  const snap = data.snapshot;
  if (!snap || typeof snap !== "object" || !snap.graph || typeof snap.graph !== "object") {
    throw new Error("快照缺少 graph 本体");
  }
  return snap;
}

// 当前画布 vs 某提交快照是否有差异（＝该提交之后画布是否还有未提交改动）。
// 公共函数：P3-G1「回到这一版」护栏 3 与 P6-1 双击确认框共用（勿抄两遍）。
// sel：{file, seq}（file 优先，缺失退回 seq）。
// 返回 true = 有差异 / 材料不全 / 比对失败（调用方按「需确认」处理，宁可多问）。
async function historyDiffAgainstSnapshot(sel) {
  try {
    if (!sel || (sel.file == null && sel.seq == null)) return true; // 无定位材料 → 按不一致
    const cur = historyGraphSigForCompare();
    const snap = await historyFetchSnapshot(sel);
    return historySnapshotsDiffer(cur, historySnapshotGraphSig(snap.graph));
  } catch (err) {
    console.warn(LOG_TAG, "未提交比对失败（按不一致处理）", err);
    return true;
  }
}

// 「回到这一版」点击处理（二次确认状态机，规格 4）：
//   无选卡 → 提示；未提交改动 → 第一次点=警示+按钮变「确认回跳」，60s 内再点=执行；
//   超时/收起弹层/换选 → 状态复位。执行中 busy 防重入。
async function historyRollbackClick() {
  if (!historyBarEl || historyRollback.busy) return;
  const roll = historyBarEl.querySelector(".hhb-roll");
  if (!roll) return;
  if (!historyBarSelection) {
    historyBarTip("先在上方点选一条提交，再点「回到这一版」", false);
    return;
  }
  // 未提交编辑拦截（护栏 3，简化口径）：当前画布 ≠ 最近一次提交 → 需二次确认。
  // 拿不到最近提交（从未提交 / 索引缺失）→ 直判需确认（宁可多问）。
  const latest = historyBarLatestEntry;
  const needsConfirm =
    !latest || latest.file == null ? true : await historyDiffAgainstSnapshot({ file: String(latest.file) });
  if (needsConfirm && !historyRollback.armed) {
    historyRollback.armed = true;
    if (historyRollback.timer) clearTimeout(historyRollback.timer);
    historyRollback.timer = setTimeout(() => {
      historyRollback.armed = false;
      historyRollback.timer = null;
      historyRollbackBtnReset();
      historyBarTip("确认已超时，未执行回跳", false);
    }, 60000);
    const tipEl = historyBarEl.querySelector(".hhb-msg");
    historyBarTip("当前有未提交的改动，回跳将丢弃。再点一次确认执行", false);
    if (tipEl) tipEl.style.color = "#e8a0a0"; // 警告红字（成功后由 historyBarTip 回默认色）
    roll.textContent = "确认回跳（丢弃未提交改动）";
    roll.classList.add("hhb-roll-armed");
    return;
  }
  await historyRollbackExecute();
}

// 执行回跳：拉快照 → loadGraphData 原地装载 → 关弹层 + 成功提示（规格 1/2/5）。
// 失败路径（规格 6）：弹层内红字，画布不动（装载前校验 + loadGraphData 原子性，见注释）。
async function historyRollbackExecute() {
  // P7-树（2026-10-12）：确认框可由底部提交树触发（弹层未开时也允许回跳）→ 两容器任一在即可。
  if (!historyBarEl && !historyTreeEl) return;
  const roll = historyBarEl ? historyBarEl.querySelector(".hhb-roll") : null;
  const sel = historyBarSelection;
  if (historyRollback.timer) {
    clearTimeout(historyRollback.timer);
    historyRollback.timer = null;
  }
  historyRollback.armed = false;
  historyRollback.busy = true;
  if (roll) {
    roll.textContent = "回跳中…";
    roll.classList.remove("hhb-roll-armed");
  }
  historyBarTip("正在拉取快照…", false);
  try {
    if (typeof app.loadGraphData !== "function") throw new Error("前端没有 app.loadGraphData");
    const aw = activeWorkflowObj(); // 当前活动页对象（同 loadWorkflowFile L1342 的取法）
    if (!aw) throw new Error("取不到当前活动页对象（activeWorkflowObj() 为空）");
    // 2026-10-24：身份必须在「换图之前」捕获 —— loadGraphData 会替换 app.graph（含 graph.id），
    // 之后 currentWorkflowId()/currentWorkflowPath() 可能已指向快照里的旧身份。
    const identity = captureWorkflowIdentity();
    const snap = await historyFetchSnapshot(sel);
    const seqLabel = "#" + String(snap.seq != null ? snap.seq : (sel && sel.seq) != null ? sel.seq : "?").padStart(3, "0");
    // 原子性依据（实现前复核）：loadGraphData 对「非法入参/装载中抛错」**先于**画布变更返回/抛出 ——
    // v1.55.14 打包源（settingStore-X9ZV_dAu.js 内 ComfyApp.loadGraphData，offset≈1866877）
    // 顺序：参数归一 + beforeLoadNewGraph → try{ … rootGraph.configure(e) … }catch{return false}
    // —— configure 抛错走 reportGraphLoadFailure 后**直接返回 false**，不进入后续的 widget 修正、
    // afterConfigureGraph、activateLoadedWorkflow；LiteGraph 的 LGraph.configure（同包 settingStore
    // chunk，offset≈512279）首行即「入参非法 → return；configure 事件被拒绝 → return」，且节点
    // 创建先在临时序列上逐个进行、任何阶段抛错即整体终止 —— 图未换（旧图原样）。
    // 因此「成功=整图换血、失败=旧图不动」，无半装载态；前端任何残余只可能是节点级的
    // last_serialization 记录，不影响画布内容。失败时 catch 落弹层红字（见下），不重试。
    const loadP = Promise.resolve(
      app.loadGraphData(snap.graph, true, true, aw, { checkForRerouteMigration: false, deferWarnings: false }),
    );
    const okGraph = await loadP.catch((e) => {
      console.warn(LOG_TAG, "P3-G1 loadGraphData 失败（画布应未变）", e);
      return null;
    });
    if (okGraph === null) throw new Error("画布装载失败（loadGraphData 报错，画布未变）");
    // P5b（契约 §3.1）→ 2026-10-23：回跳成功 → 把后端 HEAD 设为回跳到的 seq（.head.json）。
    // 这样「回跳后改再提交」时后端拿 HEAD 当 parent = 真分叉。
    // HEAD 由后端 .head.json 持有，前端不落 localStorage（2026-10-23）。
    // 后端失败：不再全吞 —— console.warn 留痕，但不影响回跳成功提示与流程。
    const backSeq = snap.seq != null ? snap.seq : (sel && sel.seq);
    const backAt = snap.at != null ? snap.at : null;
    if (backSeq != null) {
      try {
        const resp = await postJson(HISTORY_HEAD_SET_PATH, withWorkflowId({
          workflow: identity && identity.name ? identity.name : currentWorkflowInfo().name,
          seq: backSeq,
          at: backAt != null ? backAt : new Date().toISOString(),
        }, identity));
        if (!resp || resp.ok !== true) {
          // postJson 只在网络层抛错；HTTP 4xx/5xx 会正常 resolve，这里也要留痕（不当成功）。
          console.warn(LOG_TAG, "回跳后写后端 HEAD 失败", resp && resp.status);
        }
      } catch (err) {
        console.warn(LOG_TAG, "回跳后写后端 HEAD 失败", err);
      }
    }
    // 成功：关弹层（规格 2）……
    historyRollback.busy = false;
    historyBarClose();
    // ……提示改挂一次性元素（弹层已拆，规格 5 的成功文案仍在弹层顶部展示 5s）。
    // 说明：historyBarTip 写在弹层内，而弹层已关；为同时满足「弹层顶部显示」与「关闭弹层」
    // 两条规格，成功提示用同一样式的独立 toast 常驻到 5s 自动消失。
    historyRollbackToast(`已回到 ${seqLabel}（此时画布未保存，保存或再提交由你决定）`);
    historyTreeRefresh(); // P7-树：回跳成功 → HEAD 已变，重渲染树（HEAD 高亮跟随；收起着只更新计数）
    return;
  } catch (err) {
    console.warn(LOG_TAG, "P3-G1 回跳失败", err);
    historyRollback.busy = false;
    if (historyBarEl) {
      historyRollbackBtnReset();
      historyBarTip("回跳失败：" + String((err && err.message) || err), true);
    } else if (historyTreeEl) {
      // 2026-10-14：弹层不在（只有底部提交树触发）时也要可见地报失败，不静默。
      historyRollbackToast("回跳失败：" + String((err && err.message) || err), true);
    }
  }
}

// 成功提示（同弹层样式，顶部居中，5s 自动消失）。
function historyRollbackToast(msg, isError) {
  try {
    const el = document.createElement("div");
    el.id = HISTORY_BAR_ID + "-toast";
    const fg = isError ? "#f2a7a0" : "#b8e0a0";
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10002;" +
      "background:rgba(28,32,39,.96);color:" + fg + ";border:1px solid rgba(255,255,255,.2);" +
      "border-radius:11px;box-shadow:0 10px 32px rgba(0,0,0,.45);padding:10px 16px;font-size:13px;" +
      "pointer-events:auto;max-width:min(640px,calc(100vw - 16px));";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      if (el.parentElement) el.parentElement.removeChild(el);
    }, 5000);
  } catch (err) {
    console.warn(LOG_TAG, "P3-G1 成功提示失败", err);
  }
}

// ── P5b（2026-10-11）：存档当前画布（人的入口，契约 §3.3）─────────────────────
// 点击「存档当前画布」→ 取当前 app.graph.toJSON() → POST /hana_bridge/history-save
// （body {workflow, graph, at}；无 promptId——不运行）。成功后刷新弹层 + 提示「已存档 #NNN」。
// 失败 → 弹层内红字提示，不影响画布。存档独立动作，不参与回跳选中态。
// 端点由并行 worker（A）实现；未就绪时静默失败（落弹层红字）。
const HISTORY_SAVE_PATH = "/hana_bridge/history-save";

async function historySaveClick() {
  if ((!historyBarEl && !historyTreeEl) || historySaveBusy) return;
  const btn = historyBarEl ? historyBarEl.querySelector(".hhb-save") : null;
  let graph = null;
  try {
    if (app && app.graph && typeof app.graph.toJSON === "function") {
      graph = app.graph.toJSON();
    }
  } catch (err) {
    console.warn(LOG_TAG, "存档前抓画布失败", err);
    graph = null;
  }
  if (!graph || !graph.nodes || !Object.keys(graph.nodes).length) {
    if (historyBarEl) historyBarTip("存档失败：当前画布为空", true);
    else historyRollbackToast("存档失败：当前画布为空", true);
    return;
  }
  historySaveBusy = true;
  if (btn) btn.disabled = true;
  if (historyBarEl) historyBarTip("正在存档…", false);
  const at = new Date().toISOString();
  let workflow = null;
  try {
    workflow = currentWorkflowInfo().name;
  } catch {
    workflow = null;
  }
  try {
    const resp = await api.fetchApi(HISTORY_SAVE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withWorkflowId({ workflow, graph, at })),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (!resp.ok || !data || data.ok !== true) {
      throw new Error(String((data && data.error) || "HTTP " + resp.status));
    }
    // 存档成功：存档不参与合并判定，后端永远新建节点（kind="save"）。刷新弹层 + 顶部提示。
    const seq = data.seq != null ? data.seq : null;
    historySaveBusy = false;
    historyRollbackToast(seq != null ? "已存档 #" + String(seq).padStart(3, "0") : "已存档");
    if (historyBarEl) historyBarReopen();
    else historyTreeRefresh();
    return;
  } catch (err) {
    historySaveBusy = false;
    if (btn) btn.disabled = false;
    const emsg = "存档失败：" + String((err && err.message) || err);
    if (historyBarEl) historyBarTip(emsg, true);
    else historyRollbackToast(emsg, true);
  }
}

// 存档后刷新弹层：同 group 重开（复用 historyBarOpen 的「先拆旧再建新」+ 重新 load）。
function historyBarReopen() {
  const g = historyBarGroup;
  const rn = historyBarRoleName; // 缺口二：记住当前是「角色块视角」还是「group 视角」
  if (!historyBarEl) return;
  if (rn) historyBarOpenRole(rn);
  else historyBarOpen(g);
}

// ── P7-树（2026-10-12）：画布底部可收纳「全局提交树」───────────────────────────
// 规格：docs/方案-画布提交历史-P7-提交树.md。只读 + 点选回跳；复用弹层族的数据（history-list）、
// 视觉口径（historyTickColor / historyFmtTime / historySeqLabel / historyTickChangedNames）与
// 回跳链（historyBarSelection → historyRollbackExecute）。z-index：本树 9990 < 弹层 10001 < lightbox 10050。
// 布局：拓扑深度分层行（depth = depth(parent)+1；parent 为 null / 指向不存在 seq（孤儿，如被清理的
// 上游）→ depth=0）；同层按 seq（入队时间）从左到右；行内 flex 等分压缩（节点多不溢出）；
// 父子连线在渲染后按真实 DOM 位置用 SVG 折线补画（父刻度底边中点 → 下行 ≤10px → 横移 → 下行到
// 子刻度顶边；同 x 直连）。分叉 = 一个 parent 有 ≥2 子，呈 "y" 形。
const HISTORY_TREE_ID = "hana-history-tree";
const HISTORY_TREE_STYLE_ID = "hana-history-tree-style";
// 收纳状态 per-page localStorage（键结构照抄 HEAD：hana.history.tree.v1:<ws>:<hashPath(pageKey)>），值 {open:bool}
const HISTORY_TREE_LS_PREFIX = "hana.history.tree.v1:";
let historyTreeEl = null; // 底部容器单例（收纳条 + 展开面板）；null = 未初始化
let historyTreePanelEl = null;
let historyTreeCanvasEl = null; // 展开面板里的横滚容器（.tcanvas）
let historyTreeTreeEl = null; // 展开面板里的泳道层（.lanes；绝对定位节点 + svg 连线层）
let historyTreeCountEl = null; // 收纳条「N 节点 · M 分支 · K 泳道」
let historyTreeHiddenBtnEl = null; // D7：收纳条「隐藏 N」恢复入口（无隐藏时不渲染）
let historyTreeToggleEl = null; // 展开/收起按钮
let historyTreeSleepEl = null; // 休眠折叠条（+N 休眠分支）
let historyTreeFadeLEl = null; // 左端渐隐
let historyTreeFadeREl = null; // 右端渐隐
let historyTreeGeom = null; // 最近一次渲染几何 {colW,laneH,W,H}（连线路由用；必须为真实值）
// 缩放（2026-10-22）：滚轮控制提交树的密度，1=默认。
// 作用在 colW 与 laneH 两个尺度上，范围 0.45~2.2（再小节点就点不中，再大就一屏看不下）。
// 持久化到 localStorage（用户调好一次不用重复调）。
const HISTORY_TREE_ZOOM_LS = "hana.historyTreeZoom.v1";
const HISTORY_TREE_ZOOM_MIN = 0.6;   // 再小节点只剩 5px，点不中（热区 -htr-hot-w 另算但仍太窄）
const HISTORY_TREE_ZOOM_MAX = 2.2;
let historyTreeZoomCache = null;
function historyTreeZoomGet() {
  if (typeof historyTreeZoomCache === "number") return historyTreeZoomCache;
  let z = 1;
  try {
    const v = parseFloat(localStorage.getItem(HISTORY_TREE_ZOOM_LS));
    if (isFinite(v)) z = Math.max(HISTORY_TREE_ZOOM_MIN, Math.min(HISTORY_TREE_ZOOM_MAX, v));
  } catch { /* 忽略 */ }
  historyTreeZoomCache = z; return z;
}
function historyTreeZoomSet(z) {
  const next = Math.max(HISTORY_TREE_ZOOM_MIN, Math.min(HISTORY_TREE_ZOOM_MAX, z));
  if (Math.abs(next - historyTreeZoomGet()) < 0.001) return false;
  historyTreeZoomCache = next;
  try { localStorage.setItem(HISTORY_TREE_ZOOM_LS, String(next)); } catch { /* 忽略 */ }
  return true;
}
// 视角（时序 / 紧凑）：全局一种，localStorage 持久化（2026-10-14）。
const HISTORY_TREE_VIEW_LS = "hana.historyTreeView.v2"; // "time" | "compact"（v1→v2：2026-10-22 换默认值，旧偏好作废）
let historyTreeViewMode = null;
function historyTreeViewGet() {
  if (historyTreeViewMode === "time" || historyTreeViewMode === "compact") return historyTreeViewMode;
  let m = "time"; // 2026-10-22：默认视角 compact→time（用户明确要求「按时序和规则」）
  // 为什么改回时序：compact 下 x = 父x+1，多个提交会挤在同一 x 上，
  // 跨行的竖段全堆在同一道缝里 → 必然相互穿插，怎么排轨道都不够。
  // 时序下每个提交独占一个 x，竖段只跨 1 格，根本不会长穿。
  try { const v = localStorage.getItem(HISTORY_TREE_VIEW_LS); if (v === "compact" || v === "time") m = v; } catch { /* 忽略 */ }
  historyTreeViewMode = m; return m;
}
function historyTreeViewSet(m) {
  historyTreeViewMode = (m === "compact") ? "compact" : "time";
  try { localStorage.setItem(HISTORY_TREE_VIEW_LS, historyTreeViewMode); } catch { /* 忽略 */ }
}
let historyTreeOpen = false; // 展开态（内存镜像；持久化走 historyTreeState*）
let historyTreeReqId = 0; // 竞态哨兵：重渲染/收起后递增，在途旧响应作废
let historyTreeEntries = []; // 最近一次成功 fetch 的 entries（resize 重画连线用，不 refetch）
// D4（2026-10-26）：最近一次渲染实际画出来的 entries（已剔除隐藏项 + parent 已短路重挂）。
// historyTreeDrawEdges 优先用它，保证连线与节点同一份数据；null = 还没渲染过 → 回退 historyTreeEntries。
let historyTreeShownEntries = null;
// 2026-10-23：后端 HEAD（history-list 响应的 data.head），小黄点数据源。展开/收起时都更新。
let historyTreeHead = null;
// 2026-10-23（用户定）：首次渲染把 HEAD 滚到视口中间（他反馈「新开画布看不见节点在哪，得找」）。
// 每个工作流只自动居中一次；切换工作流重置，之后的重渲染（resize / 提交刷新）不抢用户当前的滚动位置。
let historyTreeCenteredOnce = false;
let historyTreeCenteredFor = null;
let historyTreeDragEndAt = -1e9; // 最近一次「带位移拖拽」结束时刻（远过去=无；节点 click 与拖拽消歧用，见 historyTreeNodeClick）

// —— 收纳状态存取（键结构同 copilot 页键；pageKey 取不到 → 不持久化，按收纳默认）——
function historyTreeLsKey() {
  try {
    const pk = historyPageKey();
    if (!pk) return null;
    return HISTORY_TREE_LS_PREFIX + copilotWorkspaceId() + ":" + hashPathKey(pk);
  } catch {
    return null;
  }
}

function historyTreeStateGet() {
  try {
    const k = historyTreeLsKey();
    if (!k) return false; // 无 pageKey → 默认收纳
    const raw = localStorage.getItem(k);
    if (!raw) return false;
    const v = JSON.parse(raw);
    return !!(v && v.open);
  } catch {
    return false;
  }
}

function historyTreeStateSet(open) {
  try {
    const k = historyTreeLsKey();
    if (!k) return;
    localStorage.setItem(k, JSON.stringify({ open: !!open, updatedAt: Date.now() }));
  } catch {
    /* 忽略 */
  }
}

// 独立 style 注入（新 style id，与弹层同族深色）。
function historyTreeStyleEnsure() {
  if (document.getElementById(HISTORY_TREE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HISTORY_TREE_STYLE_ID;
  style.textContent = `
/* 2026-10-15：中性色全部走变量，跟随 ComfyUI 明暗（:root=浅色默认，:root.dark-theme=深色覆盖）。
   语义色（谁提交 --htr-c、HEAD 橙点 #e8c268、旧数据标记、框色 --hnode-bc）不在此列。 */
:root {
  --htr-fg: #2c302d;
  --htr-sub: #5b6570;
  --htr-btn-fg: #2c302d;
  --htr-btn-bg: rgba(0,0,0,.05);
  --htr-btn-line: rgba(0,0,0,.16);
  --htr-btn-bg-h: rgba(0,0,0,.1);
  --htr-panel1: rgba(252,250,246,.96);
  --htr-panel2: rgba(243,240,234,.97);
  --htr-hi: rgba(255,255,255,.75);
  --htr-inset-line: rgba(0,0,0,.05);
  --htr-collapsed-sh: rgba(60,50,40,.12);
  --htr-panel-sh: rgba(60,50,40,.14);
  --htr-lane: rgba(0,0,0,.05);
  --htr-node-bg: #ffffff;
  --htr-edge: rgba(60,72,88,.5);
  --htr-sel-ring: rgba(40,46,54,.85);
  --htr-badge-fg: #fbfcfd;
  --htr-badge-bg: #3c444f;
  --htr-badge-sh: rgba(60,50,40,.2);
  --htr-fade: rgba(246,243,238,.95);
  --htr-sleep-line: rgba(0,0,0,.14);
  --htr-sleep-bg: rgba(238,235,229,.75);
  --htr-bubble-bg: rgba(252,250,246,.99);
  --htr-bubble-fg: #2c302d;
  --htr-bubble-line: rgba(0,0,0,.14);
  --htr-bubble-sh: rgba(60,50,40,.2);
  --htr-err: #b0332f;
  --htr-thumb-bg: #e7e4de;
}
:root.dark-theme {
  --htr-fg: #e6edf5;
  --htr-sub: #9fb3c8;
  --htr-btn-fg: #dfe7ef;
  --htr-btn-bg: rgba(255,255,255,.07);
  --htr-btn-line: rgba(255,255,255,.24);
  --htr-btn-bg-h: rgba(255,255,255,.14);
  --htr-panel1: rgba(38,44,54,.94);
  --htr-panel2: rgba(27,32,40,.95);
  --htr-hi: rgba(255,255,255,.075);
  --htr-inset-line: rgba(255,255,255,.05);
  --htr-collapsed-sh: rgba(0,0,0,.3);
  --htr-panel-sh: rgba(0,0,0,.4);
  --htr-lane: rgba(255,255,255,.032);
  --htr-node-bg: #1e242c;
  --htr-edge: rgba(196,214,236,.72);
  --htr-sel-ring: rgba(255,255,255,.9);
  --htr-badge-fg: #0d1014;
  --htr-badge-bg: #dfe8f2;
  --htr-badge-sh: rgba(0,0,0,.5);
  --htr-fade: rgba(31,37,46,.95);
  --htr-sleep-line: rgba(255,255,255,.2);
  --htr-sleep-bg: rgba(18,22,28,.6);
  --htr-bubble-bg: rgba(18,22,28,.98);
  --htr-bubble-fg: #e6edf5;
  --htr-bubble-line: rgba(255,255,255,.22);
  --htr-bubble-sh: rgba(0,0,0,.5);
  --htr-err: #e8a0a0;
  --htr-thumb-bg: #3a414b;
}
#${HISTORY_TREE_ID} {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 9990;
  pointer-events: none; user-select: none;
  font-size: 12px; line-height: 1.4; color: var(--htr-fg);
}
#${HISTORY_TREE_ID} .htr-collapsed {
  pointer-events: auto; height: 26px; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; cursor: pointer;
  background: linear-gradient(180deg, var(--htr-panel1) 0%, var(--htr-panel2) 100%);
  box-shadow: inset 0 1px 0 var(--htr-hi), 0 -1px 0 var(--htr-collapsed-sh);
  backdrop-filter: blur(6px);
}
#${HISTORY_TREE_ID} .htr-sum { font-weight: 600; }
#${HISTORY_TREE_ID} .htr-count { color: var(--htr-sub); }
/* 2026-10-26（D7·任务 B）：收纳条「隐藏 N」恢复入口 —— 与 .htr-count 同族（同字号/同色系），但可点。
   有无隐藏项由 historyTreeUpdateCounts 控制（hidden 属性切换）；点开恢复面板（见 historyTreeHiddenPanelOpen）。 */
#${HISTORY_TREE_ID} .htr-hidden-btn {
  background: transparent; border: 0; padding: 0 3px; margin: -1px 0;
  font: inherit; font-size: 12px; line-height: 1.4; color: var(--htr-sub);
  border-radius: 5px; cursor: pointer;
}
#${HISTORY_TREE_ID} .htr-hidden-btn:hover { color: var(--htr-fg); background: var(--htr-btn-bg-h); }
#${HISTORY_TREE_ID} .htr-hidden-btn[hidden] { display: none; }
#${HISTORY_TREE_ID} .htr-toggle {
  margin-left: auto; background: transparent; border: 1px solid var(--htr-btn-line);
  color: var(--htr-btn-fg); border-radius: 6px; padding: 1px 8px; cursor: pointer; font-size: 11px;
}
#${HISTORY_TREE_ID} .htr-toggle:hover { background: var(--htr-btn-bg-h); }
#${HISTORY_TREE_ID} .htr-save-btn {
  margin-left: 8px; background: var(--htr-btn-bg); border: 1px solid var(--htr-btn-line);
  color: var(--htr-btn-fg); border-radius: 7px; padding: 1px 10px; font-size: 11px; cursor: pointer; flex: none;
}
#${HISTORY_TREE_ID} .htr-save-btn:hover { background: var(--htr-btn-bg-h); }
#${HISTORY_TREE_ID} .htr-view-btn {
  margin-left: 6px; background: var(--htr-btn-bg); border: 1px solid var(--htr-btn-line);
  color: var(--htr-btn-fg); border-radius: 7px; padding: 1px 10px; font-size: 11px; cursor: pointer; flex: none;
}
#${HISTORY_TREE_ID} .htr-view-btn:hover { background: var(--htr-btn-bg-h); }
#${HISTORY_TREE_ID} .htr-panel {
  pointer-events: auto; display: none; height: auto; position: relative;
  background: linear-gradient(180deg, var(--htr-panel1) 0%, var(--htr-panel2) 100%);
  box-shadow: inset 0 1px 0 var(--htr-hi), inset 0 0 0 1px var(--htr-inset-line), 0 -10px 30px var(--htr-panel-sh);
  backdrop-filter: blur(6px); border-radius: 13px 13px 0 0;
  padding: 6px 10px;
}
#${HISTORY_TREE_ID}.htr-open .htr-panel { display: block; }
/* 泳道画布：双向滚动（隐藏滚动条），视口高封顶（JS 设 —— 上限 200），内容高由全量泳道行数决定；内部 .lanes 取内容全尺寸 */
#${HISTORY_TREE_ID} .tcanvas {
  position: relative; overflow: auto;
  scrollbar-width: none; cursor: grab;
}
#${HISTORY_TREE_ID} .tcanvas::-webkit-scrollbar { display: none; }
#${HISTORY_TREE_ID} .tcanvas.htr-dragging { cursor: grabbing; }
#${HISTORY_TREE_ID} .lanes { position: relative; height: 100%; }
/* 泳道基准线（2026-10-22 改）：从「横贯面板」改成「左侧短标记」。
   旧：left:0; right:0 → 一整条横线贯穿。跨泳道连线每穿一条泳道就在它上面切一个
   十字，用户看到的就是「连线跟泳道交叉」——那些长横线就是基准线本身。
   现：只留左侧 18px 一段作泳道标识，右边整条不再画 → 竖线与它碰不上。 */
#${HISTORY_TREE_ID} .htr-laneaxis {
  position: absolute; left: 0; width: 18px; height: 1px;
  background: var(--htr-lane); pointer-events: none;
}
/* 泳道序号：贴在左侧标记右边，跟着内容一起横滚（说明该行是第几条泳道） */
#${HISTORY_TREE_ID} .htr-laneaxis::after {
  content: attr(data-lane);
  position: absolute; left: 22px; top: -5px;
  font-size: 9px; line-height: 1; color: var(--htr-sub); opacity: .5;
  pointer-events: none; /* 2026-10-26：序号只是标注，不参与命中（否则会抢最左侧节点的右键） */
}
/* 节点（统一母题）：外框 = 线型(操作)+色(谁)；内条堆 = 本次碰过的画布框（框色，见 .hnode-bar） */
#${HISTORY_TREE_ID} .node {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: stretch;
  width: var(--nw, 10px); min-width: 6px; height: var(--htr-node-h, 22px); min-height: var(--htr-node-h, 22px); /* 2026-10-22：高改由变量控制（随缩放），旧值 22 写死 */
  padding: var(--htr-pad, 2px) 0; margin: 0; box-sizing: border-box; /* 3a修（2026-10-13）：横向 padding 1.5px→0，内条出血贴外框内侧 */
  border: var(--htr-bw, 2px) solid color-mix(in oklab, var(--htr-c, #5aa0d8) 60%, transparent); border-style: solid; border-radius: var(--htr-br, 4.5px); /* 2026-10-23：边框/圆角随缩放走变量（最小档 2px 边框会吃掉节点大半宽，内条把框顶出去） */ /* 3a修：统一 2px，与框节点同口径 */ /* 第8条：border-color 半透明 → 发光描边 */
  background: var(--htr-node-bg); cursor: pointer; z-index: 1; /* 连线层之下（.htr-edges z-index:0） */ /* 2026-10-14：底色不透明——连线经过节点矩形时被遮住，不再透出 */
  /* 第8条（2026-10-13）：常态外光晕加强（固定 10px / 65%，与框同口径） */
  box-shadow: 0 0 10px color-mix(in oklab, var(--htr-c, #5aa0d8) 65%, transparent);
}
/* 2026-10-14：透明扩大热区——节点本体很窄（≈12px），周围大片是 .tcanvas 的 grab；
   ::before 撑一块透明命中区，cursor 继承 .node 的 pointer → 热区内都是点击小手。
   视觉零变化（无背景）；拖拽不受影响（mousedown 在 tcanvas 上，位移>3px 才算拖动）。 */
#${HISTORY_TREE_ID} .node::before {
  content: "";
  position: absolute; left: 50%; top: 50%;
  width: var(--htr-hot-w, 100%); height: var(--htr-hot-h, 100%);
  transform: translate(-50%, -50%);
  border-radius: 6px;
}
/* 密档降级（同框口径）；3a修：不再改 border-width */
#${HISTORY_TREE_ID} .node[data-tight] { padding: var(--htr-pad, 1px) 0; border-radius: var(--htr-br, 3px); }
/* 合并提交加粗（外框加粗 + 强光晕，同框口径） */
#${HISTORY_TREE_ID} .node.htr-tick-bulge {
  width: var(--nw-bulge, calc(var(--nw, 10px) + 10px)); /* 第8条：多块宽由 JS 算好（min(nw+10, colW-3)），永不超格 */
  border-width: var(--htr-bw-bulge, 2.5px); /* 2026-10-23：随缩放，小档不再用 2.5px 硬值 */
  box-shadow: 0 0 12px color-mix(in oklab, var(--htr-c, #5aa0d8) 85%, transparent); /* 第8条：合并光晕更亮 */
}
/* ×N 徽标（同框口径） */
#${HISTORY_TREE_ID} .htr-runs {
  display: none; /* P8：×N 默认隐藏，滑过节点才显示（定位不变） */
  position: absolute; top: -6px; right: -8px; font-size: 8.5px; font-weight: 700;
  color: var(--htr-badge-fg); background: var(--htr-badge-bg); border-radius: 5px; padding: 0 3px; line-height: 11px;
  box-shadow: 0 1px 3px var(--htr-badge-sh); pointer-events: none;
}
#${HISTORY_TREE_ID} .node:hover .htr-runs { display: inline-block; }
/* 2026-10-26（任务 A）：窄列降级点 —— colW < 10 时 ×N 文字放不下，改画一个 2px 方点。
   定位沿用 .htr-runs 的右上角外沿（top:-6px / right:-8px），叠加 z-index 保证不被内条堆盖住；
   颜色走 --htr-sub（低存在感）；title 由 JS 挂「合并 N 次」（原生 tooltip，徽标是子元素可单独挂）。 */
#${HISTORY_TREE_ID} .htr-runs-dot {
  position: absolute; top: -5px; right: -5px; z-index: 2;
  width: 2px; height: 2px; border-radius: 1px; background: var(--htr-sub);
  /* 必须 auto 而非 none：pointer-events:none 的元素不参与命中测试，原生 title 不会弹。
     dot 在节点内部，点击/悬停依旧冒泡到 .node（mouseenter 进子元素不重触发），交互零变化。 */
  pointer-events: auto;
}
/* 2026-10-15 缺口一：变动符号（节点 ＋n/－n、连线 ⇄n）—— 常显小徽标，挂节点下方（×N 占上方，同框口径） */
#${HISTORY_TREE_ID} .htr-delta {
  position: absolute; top: auto; bottom: -7px; left: -8px; font-size: 8.5px; font-weight: 700; line-height: 11px;
  color: var(--htr-badge-fg); background: var(--htr-badge-bg); border-radius: 5px; padding: 0 3px;
  box-shadow: 0 1px 3px var(--htr-badge-sh); pointer-events: none; white-space: nowrap;
}
#${HISTORY_TREE_ID} .node:hover { filter: brightness(1.25); }
#${HISTORY_TREE_ID} .htr-tick-sel { outline: 2px solid var(--htr-sel-ring); outline-offset: 2px; border-radius: 4px; }
/* HEAD 高亮：节点下小金点 */
#${HISTORY_TREE_ID} .htr-tick-head::after {
  content: ""; position: absolute; bottom: -7px; left: 50%; transform: translateX(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: #e8c268;
}
/* D9（2026-10-26·记号）：可见节点的父链上跳过了被隐藏的提交 → 左边缘一个 2px 圆点。
   不占布局（绝对定位、pointer-events:none）；无隐藏项时该 class 一个都不会出现（正常树必须干净）。
   不用 .node::before：那是透明扩大热区；不用 ::after：那是 HEAD 金点。 */
#${HISTORY_TREE_ID} .node.htr-hid-after .htr-hid-dot {
  position: absolute; left: 0; top: 50%; transform: translate(-50%, -50%);
  width: 2px; height: 2px; border-radius: 50%;
  background: var(--htr-sub); opacity: .6; pointer-events: none;
}
/* 旧数据（blockNames === null）：淡化（同弹层 [data-legacy] 口径） */
#${HISTORY_TREE_ID} .node[data-legacy] .hnode-bars { opacity: .55; }
/* 父子连线层：渲染后按真实位置补画（SVG），只描边不填充 */
#${HISTORY_TREE_ID} .htr-edges {
  /* 2026-10-12 修（H0 根因）：<svg> 是替换元素，缺省视口 300×150；只写 inset:0 不撑开（width 命中 intrinsic 300px），
     超出 300px 的连线被 SVG 根 overflow:hidden 裁掉。显式 width/height:100% 让视口随 .lanes 内容尺寸。 */
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; z-index: 0; /* P8：连线置底，不再穿框/盖节点 */
  stroke: var(--htr-edge); stroke-width: 2.2; /* 2026-10-12：对比度 .55→.72、线宽 1.8→2.2（H3 对症） */
  stroke-linecap: round; stroke-linejoin: round; fill: none;
}
/* 两端渐隐（同框口径） */
#${HISTORY_TREE_ID} .htr-fade { position: absolute; top: 0; bottom: 0; width: 18px; pointer-events: none; z-index: 2; opacity: 0; transition: opacity .2s; }
#${HISTORY_TREE_ID} .htr-fade.l { left: 10px; background: linear-gradient(90deg, var(--htr-fade), transparent); }
#${HISTORY_TREE_ID} .htr-fade.r { right: 10px; background: linear-gradient(270deg, var(--htr-fade), transparent); }
#${HISTORY_TREE_ID} .htr-fade.htr-fade-on { opacity: 1; }
/* 休眠折叠条：虚线框 + +N（本期只显示+计数；展开折叠分支列为后续） */
#${HISTORY_TREE_ID} .htr-sleep {
  position: absolute; left: 10px; bottom: 4px; z-index: 3;
  display: none; align-items: center; gap: 5px;
  font-size: 10.5px; color: var(--htr-sub);
  border: 1px dashed var(--htr-sleep-line); border-radius: 6px; padding: 1px 7px;
  background: var(--htr-sleep-bg);
}
#${HISTORY_TREE_ID} .htr-sleep.htr-sleep-on { display: flex; }
#${HISTORY_TREE_ID} .htr-empty { color: var(--htr-sub); padding: 6px 2px; }
#${HISTORY_TREE_ID} .htr-err { color: var(--htr-err); padding: 6px 2px; }
/* 悬停气泡（同弹层 .hhb-bubble 家族） */
#${HISTORY_TREE_ID} .htr-bubble {
  position: absolute; z-index: 5; max-width: 280px; pointer-events: none;
  background: var(--htr-bubble-bg); color: var(--htr-bubble-fg);
  border: 1px solid var(--htr-bubble-line); border-radius: 8px;
  box-shadow: 0 6px 20px var(--htr-bubble-sh); padding: 5px 8px; font-size: 11px; line-height: 1.45;
}
#${HISTORY_TREE_ID} .htr-bub-time { color: var(--htr-sub); }
/* 2026-10-26：气泡正文改分组（改动 / 新增 / 删除 / 连线）。此前只有一行名字以「、」串接，
   不区分动作、也不说改了什么，吊在半空里读不出信息。 */
#${HISTORY_TREE_ID} .htr-bub-row {
  display: flex; gap: 6px; align-items: flex-start; margin-top: 3px; max-width: 320px;
}
#${HISTORY_TREE_ID} .htr-bub-tag {
  flex: none; font-size: 10px; line-height: 15px; padding: 0 4px; border-radius: 4px;
  background: var(--htr-inset-line); color: var(--htr-sub); letter-spacing: .02em;
}
#${HISTORY_TREE_ID} .htr-bub-tag-mod { color: #d9a45c; }
#${HISTORY_TREE_ID} .htr-bub-tag-add { color: #7fb069; }
#${HISTORY_TREE_ID} .htr-bub-tag-del { color: #d5787a; }
#${HISTORY_TREE_ID} .htr-bub-tag-link { color: #7ba6c9; }
/* 2026-10-26：种子标签（改种子仍合并，种子值单独一行展示），低饱和紫，与四个 delta 标签色区分 */
#${HISTORY_TREE_ID} .htr-bub-tag-seed { color: #9d8ad0; }
#${HISTORY_TREE_ID} .htr-bub-items { min-width: 0; }
#${HISTORY_TREE_ID} .htr-bub-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${HISTORY_TREE_ID} .htr-bub-fld { color: var(--htr-sub); font-size: 10px; margin-left: 3px; }
#${HISTORY_TREE_ID} .htr-bub-more { color: var(--htr-sub); font-size: 10px; }
/* 单击节点的缩略图浮层（默认隐藏；双击=回跳；点空白/移出关） */
#${HISTORY_TREE_ID} .htr-shots {
  position: absolute; z-index: 6; display: none;
  pointer-events: auto; /* P8：树根为 pointer-events:none；浮层必须收回指针事件，否则图不可点/不可滚/hover 不触发 */
  /* P8：与框预览 .hhb-shots 同口径——同款面板皮肤（渐变底 + 内描边 + 阴影 + 内边距/圆角） */
  background: linear-gradient(180deg, var(--htr-panel1) 0%, var(--htr-panel2) 100%);
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 var(--htr-hi),
    inset 0 0 0 1px var(--htr-inset-line),
    0 10px 30px var(--htr-bubble-sh),
    0 2px 6px var(--htr-panel-sh);
  backdrop-filter: blur(6px);
  padding: 7px 10px 8px; max-width: min(760px, 92vw); /* 树浮层保持限宽，不铺满以免遮画布 */
}
#${HISTORY_TREE_ID} .htr-shots.htr-shots-on { display: block; }
#${HISTORY_TREE_ID} .htr-shots-ph { color: var(--htr-sub); font-size: 11px; padding: 4px 2px; } /* 同 .hhb-shots-ph */
#${HISTORY_TREE_ID} .htr-shots-strip {
  display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; padding-bottom: 2px;
}
#${HISTORY_TREE_ID} .htr-shots-strip::-webkit-scrollbar { display: none; }
#${HISTORY_TREE_ID} .htr-shots-img {
  display: block; flex: none; border-radius: 8px; background: var(--htr-thumb-bg); /* 圆角 7→8，同 .hhb-thumb-img */
  cursor: zoom-in;
}
#${HISTORY_TREE_ID} .htr-shots-img.single { width: 100%; max-width: 720px; height: auto; max-height: 340px; object-fit: contain; } /* 限宽树浮层内单图自适应；同 .hhb-thumb-img 观感 */
#${HISTORY_TREE_ID} .htr-shots-img.multi { width: 240px; height: auto; max-height: 340px; object-fit: contain; } /* 同 .hhb-thumb-strip .hhb-thumb-img */
/* 2026-10-26（D6）：自绘右键菜单（隐藏节点）。
   挂 document.body（position:fixed），不挂在树容器内 —— 避免被 .tcanvas 的 overflow 裁切。
   皮肤沿用 .htr-bubble 家族变量；z-index 10002（> 树 9990，< 回跳确认框 10003）。 */
.htr-menu {
  position: fixed; z-index: 10002; min-width: 150px; max-width: 260px;
  background: var(--htr-bubble-bg); color: var(--htr-bubble-fg);
  border: 1px solid var(--htr-bubble-line); border-radius: 9px;
  box-shadow: 0 8px 26px var(--htr-bubble-sh);
  padding: 4px; font-size: 12px; line-height: 1.45;
  pointer-events: auto; user-select: none;
}
.htr-menu-title {
  padding: 3px 8px 5px; margin-bottom: 3px;
  color: var(--htr-sub); font-size: 11px;
  border-bottom: 1px solid var(--htr-bubble-line);
}
.htr-menu-item {
  display: block; width: 100%; text-align: left;
  background: transparent; border: 0; border-radius: 6px;
  color: var(--htr-bubble-fg); font: inherit; padding: 5px 8px; cursor: pointer; white-space: nowrap;
}
.htr-menu-item:hover { background: var(--htr-btn-bg-h); }
.htr-menu-item[disabled] { color: var(--htr-sub); opacity: .6; cursor: default; }
.htr-menu-item[disabled]:hover { background: transparent; }
.htr-menu-hint { display: block; margin-top: 1px; color: var(--htr-sub); font-size: 10.5px; white-space: normal; }
/* 2026-10-26（D7·任务 B）：隐藏项恢复面板 —— 复用 .htr-menu 皮肤（fixed / z-index 10002 / 气泡变量）。
   挂 document.body，所以选择器不带 #${HISTORY_TREE_ID} 前缀（同 .htr-menu）。 */
.htr-hidden-panel { min-width: 176px; max-width: 280px; max-height: 240px; overflow: auto; }
.htr-hidden-panel .htr-hid-row { display: flex; align-items: center; gap: 8px; padding: 1px 8px 1px 8px; }
.htr-hidden-panel .htr-hid-seq { flex: 1 1 auto; color: var(--htr-bubble-fg); font-variant-numeric: tabular-nums; }
.htr-hidden-panel .htr-hid-btn {
  flex: none; background: transparent; border: 1px solid var(--htr-btn-line); border-radius: 6px;
  color: var(--htr-btn-fg); font: inherit; font-size: 11px; line-height: 1.3; padding: 1px 8px; cursor: pointer;
}
.htr-hidden-panel .htr-hid-btn:hover { background: var(--htr-btn-bg-h); }
.htr-hidden-panel .htr-hid-all {
  margin-top: 3px; border-top: 1px solid var(--htr-bubble-line); border-radius: 0 0 6px 6px;
  padding-top: 6px; text-align: center;
}
`;
  document.head.appendChild(style);
  historyNodeStyleEnsure(); // 统一母题内条堆（两视图共用）
}

// ── W1 泳道算法（桥内内联版，逻辑与 app/lib/commit-graph-lanes.mjs 逐条一致）──────────
// CSP 下桥内不能 import ESM，故此处必须内联；严禁改为 import。
// 输入：entries（已按 seq 升序），每项至少 {seq, parent}。输出：
//   { lanes:[{lane,headSeq,sleeping}], nodes:[{seq,lane,row}], rows:number, sleepingCount:number }
// row = lane（2026-10-12 去折叠：全量显示，不再出现 row=-1）。
// G 算法（2026-10-14）：新分支插到父泳道正下方（消交叉）。
// 确定性：同输入两次 deepEqual（不依赖遍历顺序；同 parent 多 child 时 seq 最小者先接手）。
// 单遍插入式分配（2026-10-22 按用户规则重写）：
//
// 用户定的规则（原话）：
//   「出分支 → 放在父泳道下方 → 父泳道下方的泳道全部往下平移一泳道」
//   「不要只往下，初始泳道上，奇数次的分支往下，偶数次的分支往上」
//   「除了初始泳道的其他泳道，在上方的向上分支，在下方的向下分支」
//
// 即：新分支永远插在**紧邻父泳道**的位置（不开到列表末尾），
//     插入方向按上方的规则选，插入后其余泳道自然平移一格。
//     这样父子泳道永远相邻，汇聚边绝不会跨越无关泳道。
//
// 返回泳道对象数组（物理顺序即上下顺序）与每节点所属泳道对象。
function assignLanesRaw(entries) {
  const lanes = [];
  const objOf = new Map();
  const nodeLane = [];
  const branchCount = new Map(); // 每条泳道已分出多少个分支（奇偶决定方向）
  let rootLane = null;          // 初始泳道（第一个建立的）

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const seq = e.seq;
    const p = e.parent;
    let target = null;
    // 继承：「父是本泳道最新提交」→ 继续用这条泳道
    if (Number.isInteger(p) && p < seq) {
      for (const lane of lanes) { if (lane.head === p) { target = lane; break; } }
    }
    if (!target) {
      const pObj = (Number.isInteger(p) && p < seq) ? objOf.get(p) : null;
      target = { head: null, seqs: [] };
      if (pObj) {
        if (!rootLane) rootLane = pObj;
        const pIdx = lanes.indexOf(pObj);
        const rootIdx = lanes.indexOf(rootLane);
        let up;
        if (pObj === rootLane) {
          // 初始泳道分叉：奇数次往下、偶数次往上
          const n = (branchCount.get(pObj) || 0) + 1;
          branchCount.set(pObj, n);
          up = (n % 2 === 0);
        } else {
          // 其余泳道：在初始泳道上方的一律向上、下方的一律向下
          up = pIdx < rootIdx;
        }
        if (up) lanes.splice(pIdx, 0, target);
        else lanes.splice(pIdx + 1, 0, target);
      } else {
        lanes.push(target);
        if (!rootLane) rootLane = target;
      }
    }
    target.head = seq;
    target.seqs.push(seq);
    objOf.set(seq, target);
    nodeLane.push(target);
  }
  return { lanes, nodeLane };
}

// 几何交叉：两条「子→父」线段在 y 区间重叠内是否交换左右。共用端点不算。
function countCrossings(entries, laneOfSeq) {
  const edges = [];
  for (const e of entries) {
    if (!Number.isInteger(e.parent)) continue;
    const c = laneOfSeq.get(e.seq), p = laneOfSeq.get(e.parent);
    if (c === undefined || p === undefined) continue;
    edges.push({ x1: e.seq, y1: c, x2: e.parent, y2: p });
  }
  let cross = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (a.x1 === b.x1 || a.x2 === b.x2 || a.x1 === b.x2 || a.x2 === b.x1) continue;
      const aLo = Math.min(a.y1, a.y2), aHi = Math.max(a.y1, a.y2);
      const bLo = Math.min(b.y1, b.y2), bHi = Math.max(b.y1, b.y2);
      if (aHi < bLo || bHi < aLo) continue;
      const yl = Math.max(aLo, bLo), yh = Math.min(aHi, bHi);
      if (yl > yh) continue;
      const xa = (y) => a.y1 === a.y2 ? a.x1 : a.x1 + (a.x2 - a.x1) * (y - a.y1) / (a.y2 - a.y1);
      const xb = (y) => b.y1 === b.y2 ? b.x1 : b.x1 + (b.x2 - b.x1) * (y - b.y1) / (b.y2 - b.y1);
      if ((xa(yl) - xb(yl)) * (xa(yh) - xb(yh)) < 0) cross++;
    }
  }
  return cross;
}

// 跨道：边跨越中间泳道时，那条泳道在该 x 区间内有节点（视觉上也难读，一并计入代价）
function countLaneHops(entries, laneOfSeq, xOfSeq) {
  const laneXs = new Map();
  for (const [seq, l] of laneOfSeq) {
    if (!laneXs.has(l)) laneXs.set(l, []);
    laneXs.get(l).push(xOfSeq.get(seq));
  }
  let hops = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.parent) || !laneOfSeq.has(e.parent)) continue;
    const lo = Math.min(laneOfSeq.get(e.seq), laneOfSeq.get(e.parent));
    const hi = Math.max(laneOfSeq.get(e.seq), laneOfSeq.get(e.parent));
    const xlo = Math.min(xOfSeq.get(e.parent), xOfSeq.get(e.seq));
    const xhi = Math.max(xOfSeq.get(e.parent), xOfSeq.get(e.seq));
    for (let L = lo + 1; L < hi; L++) {
      if ((laneXs.get(L) || []).some((x) => x > xlo && x < xhi)) hops++;
    }
  }
  return hops;
}

// 代价：交叉权重更高（交叉比跨道更难读），跨道 1 分。
function scoreOf(entries, laneOfSeq, xOfSeq) {
  const cross = countCrossings(entries, laneOfSeq);
  const hops = countLaneHops(entries, laneOfSeq, xOfSeq);
  return { cross, hops, score: cross * 2 + hops };
}



// ── W2 隐藏节点（桥内内联版，逻辑与 app/lib/history-hide.mjs 逐条一致）────────────
// 镜像：app/lib/history-hide.mjs，改一处必须同改两处。
// CSP 下桥内不能 import ESM（同 W1 泳道算法），故必须内联；严禁改为 import。
//
// 语义定格：**短路隐藏** —— 隐藏 A 时，把 A 的所有子节点的 parent 改挂到 A 的 parent
// （即最近的可见祖先），再把 A 从输出里剔除。理由（lib 头部实测）：纯过滤会产 2 个孤儿、
// 泳道数 8→9、图断成两截；短路隐藏 0 孤儿、泳道数不变。
// 关键约束：回溯用的 bySeq 必须由**完整 entries**（含被隐藏项）建立，否则回溯会在隐藏点断掉，
// 子节点集体变孤儿。
//
// API（与 lib 一致）：HIDDEN_LS_PREFIX / indexBySeq / resolveVisibleParent / applyHidden / sanitizeHidden / mainlineSeqs / expandHiddenCascade。

// localStorage 键前缀：一个画布一份（后接画布标识），值为 seq 的 JSON 数组。
const HIDDEN_LS_PREFIX = "hana.history.hidden.v1:";

// 回溯上限：防御性上限，任何环或超深链都不得把主线程挂死。
const MAX_WALK = 100000;

// bySeq 兼容 Map / 普通对象 / null；seq 统一按数字取。
function pick(bySeq, seq) {
  if (!bySeq) return undefined;
  if (typeof bySeq.get === "function") return bySeq.get(seq);
  return bySeq[seq];
}

// hiddenSet 兼容 Set / Array / null。
function hasHidden(hiddenSet, seq) {
  if (!hiddenSet) return false;
  if (typeof hiddenSet.has === "function") return hiddenSet.has(seq);
  if (Array.isArray(hiddenSet)) return hiddenSet.includes(seq);
  return false;
}

// 由 entries 建 seq → entry 的索引。同一 seq 重复出现时后者覆盖前者（索引理论上一行一 seq）。
function indexBySeq(entries) {
  const bySeq = new Map();
  if (!Array.isArray(entries)) return bySeq;
  for (const e of entries) {
    if (!e || !Number.isInteger(e.seq)) continue;
    bySeq.set(e.seq, e);
  }
  return bySeq;
}

// 从 seq 的 parent 开始向上回溯，返回第一个不在 hiddenSet 里的祖先 seq；
// 一路全被隐藏、链断（parent 缺失 / 非整数）、成环、超过回溯上限 → 返回 null。
function resolveVisibleParent(seq, hiddenSet, bySeq) {
  const self = pick(bySeq, seq);
  if (!self) return null;

  const visited = new Set();
  let cursor = self.parent;

  for (let steps = 0; steps < MAX_WALK; steps++) {
    if (!Number.isInteger(cursor)) return null;
    // 环：回到自身，或在链上重复经过同一节点
    if (cursor === seq || visited.has(cursor)) return null;
    if (!hasHidden(hiddenSet, cursor)) return cursor;
    const node = pick(bySeq, cursor);
    if (!node) return null;
    visited.add(cursor);
    cursor = node.parent;
  }
  return null; // 超出回溯上限
}

// 短路隐藏：返回新数组，剔除 hiddenSet 内的项，其余项 parent 指向最近可见祖先。
// 不修改入参（原 entries 的 parent 保持原值，输出元素为浅拷贝）。
function applyHidden(entries, hiddenSet) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const bySeq = indexBySeq(entries); // 注意：完整 entries，含被隐藏项
  const out = [];
  for (const e of entries) {
    if (!e || !Number.isInteger(e.seq)) continue;
    if (hasHidden(hiddenSet, e.seq)) continue;
    out.push({ ...e, parent: resolveVisibleParent(e.seq, hiddenSet, bySeq) });
  }
  return out;
}

// D9（2026-10-26·级联）→ D10 修正：**保护主干，只藏侧枝**。
//   entries 用全量（含 mergeInto 行）；hiddenSet 是已 sanitize 的原始集合；headSeq 用于算 mainline。
//   BFS 遇 mainline 节点 → 不加入、也不从它继续往下扩（否则主干分叉点一藏，HEAD 连整棵树都没了）。
//   镜像：app/lib/history-hide.mjs 的 mainlineSeqs / expandHiddenCascade，改一处必须同改两处。
function mainlineSeqs(entries, headSeq) {
  const out = new Set();
  const list = Array.isArray(entries) ? entries : [];
  if (!Number.isInteger(headSeq)) return out;
  const parentOf = new Map();
  for (const e of list) {
    if (e && Number.isInteger(e.seq)) parentOf.set(e.seq, e.parent);
  }
  if (!parentOf.has(headSeq)) return out;
  const visited = new Set();
  let cursor = headSeq;
  for (let steps = 0; steps < MAX_WALK; steps++) {
    if (!Number.isInteger(cursor)) break;
    if (visited.has(cursor)) break;
    visited.add(cursor);
    out.add(cursor);
    cursor = parentOf.has(cursor) ? parentOf.get(cursor) : null;
  }
  return out;
}

function expandHiddenCascade(entries, hiddenSet, headSeq) {
  const out = new Set();
  if (!hiddenSet) return out;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return out;

  const mainline = mainlineSeqs(list, headSeq); // 空集 = 不做保护（headSeq 缺失）

  const childrenOf = new Map();
  for (const e of list) {
    if (!e || !Number.isInteger(e.seq)) continue;
    if (!Number.isInteger(e.parent)) continue;
    let kids = childrenOf.get(e.parent);
    if (!kids) { kids = []; childrenOf.set(e.parent, kids); }
    kids.push(e.seq);
  }

  const visited = new Set();
  const queue = [];
  const raw = typeof hiddenSet.has === "function" ? [...hiddenSet] : Array.isArray(hiddenSet) ? hiddenSet : [];
  for (const item of raw) {
    const seq = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(seq)) continue;
    if (visited.has(seq)) continue;
    visited.add(seq);
    out.add(seq); // 种子：即使在主干上也照藏（用户自己点的）
    queue.push(seq);
  }

  for (let i = 0; i < queue.length; i++) {
    const kids = childrenOf.get(queue[i]);
    if (!kids) continue;
    for (const k of kids) {
      if (visited.has(k)) continue;
      if (mainline.has(k)) continue; // D10：主干节点不藏，也不从它往下扩
      visited.add(k);
      out.add(k);
      queue.push(k);
    }
  }
  return out;
}

// 外部（localStorage）脏数据兜底。剔除：
//   1) entries 里不存在的 seq
//   2) 等于 headSeq 的 seq（HEAD 不允许隐藏）
//   3) 根节点（parent == null 且存在其他节点以它为 parent）——藏了会让子节点集体变孤儿
// 返回新的 Set。
function sanitizeHidden(rawSet, entries, headSeq) {
  const out = new Set();
  if (!rawSet) return out;
  const list = Array.isArray(entries) ? entries : [];

  const bySeq = indexBySeq(list);
  // 被别的节点当作 parent 的 seq 集合（判「根」用）
  const hasChildren = new Set();
  for (const e of list) {
    if (e && Number.isInteger(e.parent)) hasChildren.add(e.parent);
  }

  const raw = typeof rawSet.has === "function" ? [...rawSet] : Array.isArray(rawSet) ? rawSet : [];
  for (const item of raw) {
    const seq = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(seq)) continue;
    const node = bySeq.get(seq);
    if (!node) continue;                                  // 1) 不存在
    if (Number.isInteger(headSeq) && seq === headSeq) continue; // 2) HEAD
    const isRoot = !Number.isInteger(node.parent) && hasChildren.has(seq);
    if (isRoot) continue;                                 // 3) 根节点
    out.add(seq);
  }
  return out;
}

// ── D2：隐藏集合的 localStorage 读写（按画布隔离）：
// 键 = HIDDEN_LS_PREFIX + (画布 id，无 id 回退工作流名) + ":" + 路径；值 = seq 数组 JSON。
// 键结构照搬 historyTreeLsKey / historyTreeStateGet 口径（取不到键 → 读空 / 不写）。
function historyHiddenLsKey() {
  try {
    const id = currentWorkflowId() || currentWorkflowInfo().name;
    const p = currentWorkflowPath() || "";
    return HIDDEN_LS_PREFIX + id + ":" + p;
  } catch {
    return null;
  }
}

// 读：任何异常（无 localStorage / 坏 JSON / 非数组）→ 空 Set。
function historyHiddenGet() {
  const out = new Set();
  try {
    const k = historyHiddenLsKey();
    if (!k) return out;
    const raw = localStorage.getItem(k);
    if (!raw) return out;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      const seq = typeof item === "number" ? item : Number(item);
      if (Number.isInteger(seq)) out.add(seq);
    }
  } catch {
    return new Set();
  }
  return out;
}

// 写：静默（无 localStorage / 异常均忽略，不影响渲染）。
function historyHiddenSet(set) {
  try {
    const k = historyHiddenLsKey();
    if (!k) return;
    const arr = [...(set || [])].filter((seq) => Number.isInteger(seq));
    localStorage.setItem(k, JSON.stringify(arr));
  } catch {
    /* 忽略 */
  }
}

function commitGraphLanes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { lanes: [], nodes: [], rows: 0, sleepingCount: 0, cost: { cross: 0, hops: 0, score: 0 } };
  }

  // (1) 分配（插入式：新分支紧邻父泳道，插入后其余泳道平移一格）
  const { lanes } = assignLanesRaw(entries);
  const laneSeqs = lanes.map((l) => l.seqs.slice());
  const laneOfSeq = new Map();
  laneSeqs.forEach((seqs, i) => { for (const s of seqs) laneOfSeq.set(s, i); });

  // (2) 不再做重排（2026-10-22 去）：插入式分配已保证父子泳道相邻，
  //     即「新分支紧贴原泳道、其余泳道顺势平移」，不需要事后优化顺序。
  //     重排反而会把这种天然的相邻关系打乱（历史 bug 源）。
  //     下面只算代价，纯供诊断用。
  const xOfSeq = new Map(entries.map((e, i) => [e.seq, i]));
  // P0（2026-10-26）：scoreOf 是 O(n²) 纯诊断（见上方注释：不做重排，只算代价），
  // 实测占算法耗时 87%~99%（182 节点 0.65ms→0.08ms；2000 节点 16.7ms→0.34ms）。
  // 改为默认不算：调试时开 window.__hanaLaneDebug 才计算。cost 字段必须保留（下游会读），默认全 0。
  const score = (typeof window !== "undefined" && window.__hanaLaneDebug)
    ? scoreOf(entries, laneOfSeq, xOfSeq)
    : { cross: 0, hops: 0, score: 0 };

  // (3) 全量显示
  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const lane = laneOfSeq.get(entries[i].seq);
    nodes.push({ seq: entries[i].seq, lane, row: lane });
  }
  const outLanes = laneSeqs.map((seqs, idx) => ({
    lane: idx,
    headSeq: seqs.length ? seqs[seqs.length - 1] : null,
    sleeping: false,
  }));

  return {
    lanes: outLanes,
    nodes,
    rows: laneSeqs.length,
    sleepingCount: 0,
    cost: score,
  };
}




// 计数：N 节点；M 分支（parent 被 ≥2 个节点指向的 parent 数）；K 泳道（总泳道数，全量显示、无折叠）。
// 2026-10-26（D6·计数口径）：有隐藏项时首段改「可见 / 总数 节点」，无隐藏时保持原文案。
// D8（2026-10-26 修正）：留空位后泳道 / 分支均按**全量**算 —— 隐藏不动结构，数字必须与画面一致。
// 实现选型：不改函数签名（调用方 historyTreeRefreshNow / historyTreeHiddenApplyChange 均不动），
// 函数内部自读隐藏集合（与渲染同一来源：localStorage + sanitizeHidden）。
function historyTreeUpdateCounts(entries) {
  if (!historyTreeCountEl) return;
  // mergeInto 行是「与前一提交结构相同、只多了次运行」的合并记录，
  // 它们没有独立快照、也没有 blocks，**不应渲染成独立节点**。
  // 实测：某工作流 156 条索引里 131 条是 mergeInto，全被当成节点画出来，
  // 且因缺 blocks 被打上 data-legacy → 整棵树一片 55% 淡化（用户报「都不亮了」）。
  const solidEntries = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mergeInto == null);
  const headSeq = historyTreeHead && Number.isInteger(historyTreeHead.seq) ? historyTreeHead.seq : null;
  const hidden = sanitizeHidden(historyHiddenGet(), solidEntries, headSeq);
  // D9（2026-10-26·级联紧凑）：计数与渲染同口径 —— 级联扩集 → 可见集。
  //   分支 / 泳道都按可见集算（隐藏一个分支起点 → 泳道数会真的变小，与画面一致）。
  const hiddenExpanded = expandHiddenCascade(solidEntries, hidden, headSeq);
  const visibleEntries = hiddenExpanded.size ? applyHidden(solidEntries, hiddenExpanded) : solidEntries;
  const visibleCount = visibleEntries.length;
  const cnt = new Map();
  for (const ent of visibleEntries) {
    const p = ent && ent.parent;
    if (p == null) continue;
    cnt.set(p, (cnt.get(p) || 0) + 1);
  }
  let branches = 0;
  for (const v of cnt.values()) if (v >= 2) branches += 1;
  const graph = commitGraphLanes(visibleEntries);
  const nodeText = visibleCount !== solidEntries.length
    ? visibleCount + " / " + solidEntries.length + " 节点"
    : visibleCount + " 节点";
  historyTreeCountEl.textContent =
    nodeText + " · " + branches + " 分支 · " + graph.lanes.length + " 泳道";
  // D7（2026-10-26·任务 B）：收纳条「隐藏 N」—— 有隐藏才出现。
  // D9：N 仍取**用户明确隐藏**的个数（不含级联项）—— 恢复面板按同一集合列行，两者必须一致；
  //    级联带走的后代个数只放进 title，不改标签（否则「隐藏 1」会变成「隐藏 109」，与面板行数矛盾）。
  // 面板开着时顺便刷新行（原项可能已恢复 / 新项可能出现）。
  const cascadeExtra = Math.max(0, hiddenExpanded.size - hidden.size);
  if (historyTreeHiddenBtnEl) {
    if (hidden.size > 0) {
      historyTreeHiddenBtnEl.hidden = false;
      historyTreeHiddenBtnEl.textContent = "隐藏 " + hidden.size;
      historyTreeHiddenBtnEl.title = cascadeExtra > 0
        ? "已隐藏 " + hidden.size + " 个提交，连带 " + cascadeExtra + " 个分支后代（点击管理）"
        : "已隐藏 " + hidden.size + " 个提交（点击管理）";
    } else {
      historyTreeHiddenBtnEl.hidden = true;
      historyTreeHiddenBtnEl.textContent = "";
      historyTreeHiddenBtnEl.title = "";
    }
  }
  historyTreeHiddenPanelRefresh();
}

// 纯函数（自测用）：entries: [{seq,parent}]（seq 升序）；mode: "time"|"compact"。
// 返回 {xOf, maxX, cols}；时序 x=rank，紧凑 x=父 x+1（父不在集合 → 0）。
function historyTreeComputeX(entries, mode) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.seq != null);
  list.sort((a, b) => a.seq - b.seq);
  const xOf = new Map();
  if (mode === "compact") {
    for (const e of list) {
      const p = e.parent;
      const px = (p != null && xOf.has(p)) ? xOf.get(p) : -1;
      xOf.set(e.seq, px + 1); // 子 = 父 + 1（拓扑紧排）
    }
  } else {
    list.forEach((e, i) => xOf.set(e.seq, i)); // 时序 = rank
  }
  let maxX = 0;
  for (const v of xOf.values()) if (v > maxX) maxX = v;
  const cols = maxX + 1;
  return { xOf, maxX, cols };
}

// 2026-10-26（方案变更：不压细条，改自适应节点高）：
// 节点外壳档位（边框 / 内边距 / 圆角 / 条间距 / 条最小高）只由 nodeH 决定，抽成纯函数以便自检。
function historyTreeShellTier(nodeH) {
  const tightLvl = nodeH >= 18 ? 0 : nodeH >= 12 ? 1 : 2;
  const bwPx = tightLvl === 0 ? 2 : tightLvl === 1 ? 1.5 : 1;
  const padPx = tightLvl === 0 ? 2 : 1;
  const brPx = tightLvl === 0 ? 4.5 : tightLvl === 1 ? 3 : 2.5;
  const gapPx = tightLvl === 0 ? 1.5 : tightLvl === 1 ? 1 : 0.5;
  const barMinPx = tightLvl === 0 ? 2 : tightLvl === 1 ? 1.5 : 1;
  return { tightLvl, bwPx, padPx, brPx, gapPx, barMinPx };
}

// 2026-10-26（方案变更）：**条保持正常粗细**（barmin / gap 用档位原值，绝不为塞下而往下压），
// 改为「按该树最大框数把节点长高、泳道行高再跟着长」。
//   maxBlocks = 全量 solidEntries 里 blocks.length 的最大值（不能用可见集，否则隐藏节点会让行高跳动）
//   need      = maxBlocks * barMin + (maxBlocks - 1) * gap        // N 根条所需内容高
//   nodeHNeed = need + 2 * ((bwPx + 0.5) + padPx)                  // 节点所需高（含上下边框与内边距；
//                                                                  // 边框按合并节点口径 bw+0.5 取，保证普通/合并都能装下）
//   nodeH     = max(基准 nodeH, nodeHNeed)                          // 基准 = max(8, min(22, round(22*zoom), laneHBase-6))
//   laneH     = max(14, round(36*zoom), nodeH + 6)                  // 行高永远容得下节点
// 档位由 nodeH 决定、nodeH 又依赖档位 → 迭代至稳定（最多几轮；实际 1~2 轮收敛）。
function historyTreeAdaptSize(zoomZ, maxBlocks) {
  const zoom = Number.isFinite(zoomZ) && zoomZ > 0 ? zoomZ : 1;
  const N = Math.max(0, Math.floor(Number(maxBlocks) || 0));
  const laneHBase = Math.max(14, Math.round(36 * zoom));
  const nodeHBase = Math.max(8, Math.min(22, Math.round(22 * zoom), laneHBase - 6));
  const needFor = (t) => (N > 0 ? N * t.barMinPx + (N - 1) * t.gapPx : 0);
  const needHFor = (t, need) => need + 2 * (t.bwPx + 0.5 + t.padPx); // 按合并节点边框（bw+0.5）留余地
  let nodeH = nodeHBase;
  let tier = historyTreeShellTier(nodeH);
  let need = needFor(tier);
  let nodeHNeed = needHFor(tier, need);
  for (let i = 0; i < 8; i += 1) {
    tier = historyTreeShellTier(nodeH);
    need = needFor(tier);
    nodeHNeed = needHFor(tier, need);
    const next = Math.max(nodeHBase, Math.ceil(nodeHNeed * 100) / 100);
    if (Math.abs(next - nodeH) < 1e-9) break;
    nodeH = next;
  }
  tier = historyTreeShellTier(nodeH);
  need = needFor(tier);
  nodeHNeed = needHFor(tier, need);
  const laneH = Math.max(14, Math.round(36 * zoom), nodeH + 6);
  const inner = nodeH - 2 * tier.bwPx - 2 * tier.padPx; // 普通节点内高
  const innerBulge = nodeH - 2 * (tier.bwPx + 0.5) - 2 * tier.padPx; // 合并节点（边框 bw+0.5）内高
  return {
    zoom, maxBlocks: N, nodeHBase, nodeH, laneH, need, nodeHNeed,
    inner: Math.round(inner * 100) / 100,
    innerBulge: Math.round(innerBulge * 100) / 100,
    fits: need <= inner + 1e-6,
    fitsBulge: need <= innerBulge + 1e-6,
    raised: nodeH > nodeHBase,
    laneOk: nodeH <= laneH - 6 + 1e-6,
    tightLvl: tier.tightLvl, bwPx: tier.bwPx, padPx: tier.padPx,
    gapPx: tier.gapPx, barMinPx: tier.barMinPx, brPx: tier.brPx,
  };
}

// 该树最大框数（全量，绝不按可见集）：取 solidEntries 的 blocks.length 最大值；
// 补充：blocks 缺失 / 为空的旧条目在渲染时会回退「活图块清单」（historyBarsSpecFor 的 fromHistory=false 分支），
// 那些节点的条数 = 活图块数 → 存在这种条目时把活图块数一并纳入，否则节点会按偏小的 maxBlocks 长高、反而裁条。
// liveBlockCount：可选，活图块清单长度（即 globalBlocks.length）；不传 / 0 时不影响。
function historyTreeMaxBlocks(solidEntries, liveBlockCount) {
  let mx = 0;
  let anyFallback = false;
  for (const ent of Array.isArray(solidEntries) ? solidEntries : []) {
    const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : null;
    const n = bl ? bl.length : 0;
    if (n > mx) mx = n;
    if (n === 0) anyFallback = true;
  }
  const live = Math.max(0, Math.floor(Number(liveBlockCount) || 0));
  if (anyFallback && live > mx) mx = live;
  return mx;
}

// 树渲染（泳道式）：entries → commitGraphLanes → 泳道定位（X=seq 轴，Y=泳道行）→ 全量渲染（去折叠后无 row<0）。
// 返回 {nodeEls, graph}：nodeEls 供连线测量，graph 供连线使用。
function historyTreeRenderTree(entries) {
  const tree = historyTreeTreeEl;
  if (!tree) return { nodeEls: new Map(), graph: null };
  tree.textContent = "";
  if (historyTreeClickTimer) { clearTimeout(historyTreeClickTimer); historyTreeClickTimer = null; } // 重渲染 → 清消歧态
  historyTreeShotsHide(); // 重渲染 → 清预览浮层（防残留）
  historyTreeMenuClose(); // D6：重渲染 → 右键菜单也随之失效（锚点节点/泳道已重建，留着会点错）
  historyTreeHiddenPanelClose(); // D7：重渲染 → 恢复面板同因失效（行已重建，旧的 #seq 已不准）
  const sleepEl = historyTreeEl ? historyTreeEl.querySelector(".htr-sleep") : null;
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "htr-empty";
    empty.textContent = "这个工作流还没有提交记录";
    tree.appendChild(empty);
    tree.style.width = "";
    tree.style.height = "";
    if (sleepEl) sleepEl.classList.remove("htr-sleep-on");
    historyTreeShownEntries = []; // D4：空树 = 无可见节点，连线回退到空集
    return { nodeEls: new Map(), graph: null };
  }
  // 与计数函数同口径：mergeInto 行不渲染（它们没有独立快照，只有「并进前一条」的语义）
  const solidEntries = (Array.isArray(entries) ? entries : []).filter((e) => e && e.mergeInto == null);
  // D9（2026-10-26·级联紧凑）：隐藏 = 级联（分支一并藏）+ 紧凑（不留空位），取代 D8 的「留空位」。
  //   ① hidden = 用户明确隐藏的集合（sanitize 后；localStorage 只存这一份，不掺级联项）
  //   ② hiddenExpanded = 级联扩集（隐藏分支起点 → 该节点引出的所有后代一并藏）
  //   ③ visibleEntries = applyHidden(...) 短路：剔除隐藏项，其余 parent 改挂到最近可见祖先
  //      ——这就是「后面的节点提到被隐藏节点的位置」：不留空位，也不再另写重排。
  //   ④ 泳道 / x / 连线全部基于 visibleEntries 重算 → 泳道自动压实（空出来的行由下方泳道补上）。
  const hiddenRaw = historyHiddenGet();
  const headSeqForTree = historyTreeHead && Number.isInteger(historyTreeHead.seq) ? historyTreeHead.seq : null;
  const hidden = sanitizeHidden(hiddenRaw, solidEntries, headSeqForTree);
  // D10：级联必须传 headSeq —— 否则拿不到 mainline，主干会被一并藏掉（上一版的 bug）。
  const hiddenExpanded = expandHiddenCascade(solidEntries, hidden, headSeqForTree);
  const visibleEntries = hiddenExpanded.size ? applyHidden(solidEntries, hiddenExpanded) : solidEntries;
  // 连线数据源 = 可见集（parent 已被短路改挂到可见祖先 → 不存在隐藏端点，也不需要幽灵矩形补位）。
  historyTreeShownEntries = visibleEntries;
  const graph = commitGraphLanes(visibleEntries); // 泳道基于可见集重算 → 压实
  const bySeq = new Map(); // seq → ent（可见集：x 的驱动数据从这里取 parent）
  for (const ent of visibleEntries) {
    if (ent && ent.seq != null) bySeq.set(ent.seq, ent);
  }
  // D9·记号 → D10 重写：不占布局，但要能看出「这里藏过东西」，且**不能满屏都是点**。
  //
  // 判定演进（全部基于真实数据实测）：
  //   · D9 判据一「父链经过隐藏 seq」：级联下恒为 0（任何可见节点的父链都不可能经过隐藏项）
  //   · D9 判据二/三「按 seq 序取隐藏段紧前/紧后的可见节点」：主干保护后**满屏都是点**
  //     （实测 14f602c2 藏 #43 → 89/106 命中，96dd27ac 藏 #174 → 135/175）
  //     原因：侧枝散布在序号各处，每个侧枝与主干相邻对都成了一个「段边界」，全被当成了断口。
  //
  // 现判据（D10，基于父子边而非 seq 序）：一个可见节点被看成「这里藏过东西」的接入点，当且仅当
  //   它在**原始 entries** 里的某个子节点（直接子）被隐藏了。
  //   为什么这样正确：级联只藏「非主干后代」→ 被藏节点的父必然可见 → 断口就落在那个父节点上。
  //     a) 藏主干上的分叉点 A → A 的侧枝子被藏，而 A 自己也藏，不产生标记；
  //        但 A 的父 P 有个子 A 被藏 → 标记落在 P（= 紧接隐藏位置的保留节点）✔
  //     b) 藏侧枝 B → B 的父（接主干那个节点）有个子 B 被藏 → 标记落在它上面 ✔
  //   实测命中数：藏主干点 1 个、藏侧枝 1~2 个；无隐藏时为 0。
  const origParentOf = new Map();
  for (const ent of solidEntries) {
    if (ent && Number.isInteger(ent.seq)) origParentOf.set(ent.seq, ent.parent);
  }
  const cutMark = new Set(); // 断口接入点（有直接子节点被隐藏的可见节点）
  if (hiddenExpanded.size) {
    for (const ent of solidEntries) {
      if (!ent || !Number.isInteger(ent.seq)) continue;
      if (!hiddenExpanded.has(ent.seq)) continue; // 只看被隐藏项
      const p = ent.parent;
      if (!Number.isInteger(p)) continue;          // 根 / 脏 parent：没接入点
      if (hiddenExpanded.has(p)) continue;         // 父也被藏 → 断口往上推
      cutMark.add(p);
    }
  }
  const skippedAfterHidden = (seq) => cutMark.has(seq); // 无隐藏 → cutMark 空 → 一个点都不会打
  // 时间轴等距（2026-10-12 修）：每个「可见提交」占等宽一格。
  // 旧实现 X=(seq-0.5)*colW 用 seq 值定距，而 seq 因合并（mergeInto 行不生成节点）跳号
  // （实测 43 节点 seq 跨 1..144，相邻差 1~12 不等）→ 间距随序号差疏密悬殊、观感像按时间差伸缩。
  // 改：rank = 可见节点（row>=0）序号，等距铺开；折叠节点不占位（收进 +N，不撑开间距）。
  const mode = historyTreeViewGet();
  // D9：节点集 = 可见集（graph 已基于 visibleEntries），隐藏节点不在 entries 里，也不占列位。
  const shownNodes = graph.nodes.filter((nd) => nd && nd.row >= 0);
  // x 计算抽为纯函数 historyTreeComputeX：时序=rank；紧凑=父 x + 1（拓扑紧排）。
  const xIn = [];
  for (const nd of shownNodes) {
    const ent = bySeq.get(nd.seq);
    if (ent) xIn.push({ seq: nd.seq, parent: ent.parent });
  }
  const xOf = historyTreeComputeX(xIn, mode).xOf; // seq → x（0 起）
  let maxX = 0;
  for (const v of xOf.values()) if (v > maxX) maxX = v;
  const cols = maxX + 1;
  const availW = (historyTreeCanvasEl && historyTreeCanvasEl.clientWidth) || 320;
  // 2026-10-22：colW / laneH 受缩放控制。默认（zoom=1）比旧版紧凑（18~48 对旧 28~56）。
  // 缩小只影响格子密度：节点最小仍有 ~7px（热区是另一套 --htr-hot-w，不受这影响）。
  const zoomZ = historyTreeZoomGet();
  const colWMin = Math.max(7, 18 * zoomZ);
  const colWMax = Math.max(colWMin + 1, 48 * zoomZ);
  const colW = Math.max(colWMin, Math.min(colWMax, ((availW - 24) / cols) * zoomZ));
  const nw = Math.max(5, Math.min(colW - 3, colW * 0.42)); // 2026-10-14：0.45→0.42（略瘦，多留间隙）
  const nwBulge = Math.min(nw + 10, colW - 3); // 第8条：多块更宽（+8→+10，封顶 colW-3）→ 单/多差拉大
  // 2026-10-19 修：全局框列表 —— 与「提交历史框」（hhb）同口径，直接用活图块名（按活图顺序去重）。
  // 2026-10-26（方案变更）：提前到这里算 —— historyTreeMaxBlocks 需要它作「回退条目」的条数下限。
  // 旧实现扫 entries 取 blocks[].name 并集 → 历史上改过名的组 / 旧角色块名全被累进来，节点内小条堆到 12 根以上。
  // 历史提交里对不上的块名：那根不对应任何小条（不做 hitSet 映射），不亮、也不新增。
  const liveBlocks = historyLiveBlocks(); // 活图块清单（取不到 → null）
  let globalBlocks = null;
  if (liveBlocks) {
    globalBlocks = [];
    const seen = new Set();
    for (const b of liveBlocks) {
      const nm = b && b.name != null ? String(b.name) : "";
      if (nm && !seen.has(nm)) { seen.add(nm); globalBlocks.push(nm); }
    }
  } else {
    // 活图取不到（无画布 / 异常）→ 退回旧行为：entries 的 blocks[].name 并集（首次出现序），保证不炸。
    // D8：全量取（不再只扫可见集 —— 留空位后可见集只是「画不画」，全局框清单不该随隐藏而变）。
    globalBlocks = [];
    const seen = new Set();
    for (const ent of solidEntries) {
      const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : [];
      for (const b of bl) {
        if (!b || typeof b !== "object") continue;
        const nm = b.name == null ? "" : String(b.name);
        if (!seen.has(nm)) {
          seen.add(nm);
          globalBlocks.push(nm);
        }
      }
    }
  }
  const singleBar = globalBlocks.length === 0;
  const liveColors = historyLiveBlockColors(); // 内条色 = 画布框色（整树算一次）
  // 2026-10-26（方案变更）：节点高 / 行高改为按本树最大框数自适应（不再压细条）。
  //   maxBlocks 用全量 solidEntries（隐藏节点不得让行高跳动）；
  //   回退到活图块清单的旧条目按 globalBlocks.length 计条数（见 historyTreeMaxBlocks）。
  //   顺序：先按 zoom 得基准 nodeH → 再按 maxBlocks 抬到够用 → 最后反推 laneH（行高永远容得下节点）。
  const maxBlocks = Math.max(singleBar ? 1 : 0, historyTreeMaxBlocks(solidEntries, globalBlocks.length));
  const _sz = historyTreeAdaptSize(zoomZ, maxBlocks);
  const nodeH = _sz.nodeH;
  const laneH = _sz.laneH;
  // 防线断言（理论上恒成立）：行高必须容得下节点（至少留 6px 行间缝）。
  if (!_sz.laneOk) console.warn("[hana] historyTree: nodeH > laneH-6", _sz);
  // 内容宽只由内容决定（cols * colW），绝不被容器宽绑架（去 maxSeq*colW / availW-4，防右侧假留白）
  // 2026-10-22：右侧留白 = 半个视口宽。
  // 目的：最右侧的提交节点能被拖到面板中间（否则它永远贴在右边缘，改不了、看不全上下文）。
  // 留白 = clientWidth/2 刚好够把最右节点滚到中线。
  const rightPad = Math.max(24, ((historyTreeCanvasEl && historyTreeCanvasEl.clientWidth) || 320) / 2);
  // 2026-10-24：左侧留白 —— 泳道基准线（0~18px）与序号（22px 起）占的宽度。
  // 原实现第一列节点中心在 0.5*colW，节点半宽直接压住序号（用户报「泳道数字和提交节点撞车」）。
  // 现在所有列坐标整体右移 axisW，节点落在序号右侧。
  const axisW = 34;
  const W = axisW + cols * colW + rightPad;
  // 2026-10-12：内容高 = 全量泳道（rows=laneCount）；视口（.tcanvas）高封顶 ≤200，多的靠拖/滚查看。
  // .lanes 取内容全高 → 连线层（height:100%）不被截，SVG 也不再被 300×150 缺省视口裁。
  const contentH = Math.max(46, graph.rows * laneH + 6);
  const H = Math.min(200, contentH); // 视口高上限 200（面板不占满屏）
  // D8：geom 额外存 xOf / nw / nwBulge —— 隐藏节点没有 DOM，连线要用这套几何替它补位（穿过空位）。
  historyTreeGeom = { colW, laneH, nodeH, W, H: contentH, rightPad, axisW, nw, nwBulge, xOf };
  // 2026-10-23：外壳尺寸随档位一起缩（宽松 / 紧凑 / 极小）。
  // 不这么干的话，最小档节点只有 ~6×13px，2px 边框×2 就吃掉一半宽度，内条会把框顶出去。
  // 2026-10-26（方案变更）：档位判定抽为 historyTreeShellTier（与 historyTreeAdaptSize 同一口径）。
  const tier = historyTreeShellTier(nodeH);
  const bwPx = tier.bwPx;
  const padPx = tier.padPx;
  const brPx = tier.brPx;
  const gapPx = tier.gapPx;
  const barMinPx = tier.barMinPx;
  tree.style.setProperty("--htr-bw", bwPx + "px");
  tree.style.setProperty("--htr-bw-bulge", (bwPx + 0.5) + "px");
  tree.style.setProperty("--htr-pad", padPx + "px");
  tree.style.setProperty("--htr-br", brPx + "px");
  tree.style.setProperty("--hnode-gap", gapPx + "px");
  tree.style.setProperty("--hnode-barmin", barMinPx + "px");
  tree.style.width = W + "px";
  tree.style.height = contentH + "px";
  if (historyTreeCanvasEl) historyTreeCanvasEl.style.height = H + "px"; // 视口高封顶（内容可拖/滚）
  // 全局框列表 / singleBar / liveColors 已在上面（算 maxBlocks 之前）算好。
  // 泳道基准标记（2026-10-22 改）：左侧短标记 + 泳道序号，不再横贯面板。
  // 旧版 left:0;right:0 的长横线会被跨泳道竖线切出十字 —— 用户报的「连线跟泳道交叉」就是它。
  for (let row = 0; row < graph.rows; row += 1) {
    const ax = document.createElement("div");
    ax.className = "htr-laneaxis";
    ax.style.top = row * laneH + laneH / 2 + "px";
    ax.dataset.lane = String(row + 1); // 序号标注（CSS ::after）
    tree.appendChild(ax);
  }
  const nodeEls = new Map(); // seq → 节点元素（连线测量用）
  const head = historyTreeHead; // 2026-10-23：小黄点跟后端 HEAD（historyTreeRefresh 缓存），不读 localStorage
  // D9：不留空位 —— 隐藏项已从 entries 剔除，这里不再跳过；标记只加 class，不占布局。
  // （若仍保留跳过分支，一旦 hiddenExpanded 与 entries 不同步就会默默少画节点。）
  for (const nd of graph.nodes) {
    if (!nd || nd.row < 0) continue; // 去折叠后不会出现（保留兜底）
    const ent = bySeq.get(nd.seq);
    if (!ent) continue;
    const legacy = !(ent && Array.isArray(ent.blockNames));
    const srcColor = historyTickColor(ent && ent.source);
    const hitSet = legacy ? null : new Set(ent.blockNames.map((x) => String(x)));
    const runsN = ent && Array.isArray(ent.runs) ? ent.runs.length : 0;
    const node = document.createElement("button");
    node.type = "button";
    node.className = "node";
    node.dataset.src = String((ent && ent.source) || "unknown");
    if (legacy) node.dataset.legacy = "1"; // 旧数据淡化
    if (runsN > 1) node.classList.add("htr-tick-bulge"); // 合并加粗
    node.title = ""; // 自绘气泡，不用原生 tooltip
    if (head && head.seq === nd.seq) node.classList.add("htr-tick-head"); // HEAD 金点
    // D9·记号：父链上跳过了被隐藏的提交 → 左边缘一个 2px 圆点。
    // 为什么用子元素而不是 ::before：.node::before 已经是透明扩大热区（见 CSS），.htr-tick-head::after
    // 也已被 HEAD 金点占用（HEAD 节点本身不可隐藏，但可以有被隐藏的祖先）。故用一个绝对定位的 span，
    // 同样不占布局、pointer-events:none。
    if (skippedAfterHidden(nd.seq)) {
      node.classList.add("htr-hid-after");
      const hidDot = document.createElement("span");
      hidDot.className = "htr-hid-dot";
      node.appendChild(hidDot);
    }
    node.style.setProperty("--htr-c", srcColor); // 外框色 = 谁
    node.style.borderStyle = historyTickBorderStyle(ent && ent.kind); // 外框线型 = 操作
    const xx = xOf.get(nd.seq);
    node.style.left = axisW + ((xx == null ? 0 : xx) + 0.5) * colW + "px";
    node.style.top = nd.row * laneH + laneH / 2 + 3 + "px";
    node.style.setProperty("--nw", nw + "px");
    node.style.setProperty("--nw-bulge", nwBulge + "px"); // 第7条：多块宽（已 clamp colW-2）
    node.style.setProperty("--htr-node-h", nodeH + "px"); // 2026-10-22：节点高随缩放
    // 2026-10-14：透明热区尺寸——横向节点+12 但封顶 colW-2（防相邻重叠），纵向留 8px 行间拖动带。
    // ⚠️ 必须 clamp（下限+上限都夹）：max(baseW+12, colW-2) 在合并节点时 baseW 大会突破上限 → 盖到邻列。
    const baseW = runsN > 1 ? nwBulge : nw;
    const hotW = Math.max(8, Math.min(baseW + 12, colW - 2));
    const hotH = Math.max(16, Math.min(laneH - 8, laneH));
    node.style.setProperty("--htr-hot-w", hotW + "px");
    node.style.setProperty("--htr-hot-h", hotH + "px");
    if (colW < 14) node.dataset.tight = "1"; // 密档降级
    // 统一母题内条堆：全局框各一根；碰过的框 → 画布框色（亮），未碰 → 灰
    // 同 A：内条槽位与颜色取该提交自己的快照
    const _specB = historyBarsSpecFor(ent, globalBlocks, liveColors, singleBar);
    // 2026-10-26（方案变更）：条保持竖排、正常粗细 —— 条高 / 间距全用 tree 上交下来的档位值，
    // 塞不下的问题改由「节点高度按 maxBlocks 自适应」解决（见 historyTreeAdaptSize）。
    const _barsEl = historyBarsBuild(_specB.names, _specB.fromHistory ? _specB.hitSet : hitSet,
                                     _specB.colorMap, _specB.singleBar);
    node.appendChild(_barsEl);
    // ×N 徽标（合并提交）。2026-10-26（任务 A）三级降级：
    //   colW >= 10 → 照旧显示「×N」；6 <= colW < 10 → 画 2px 方点（title 挂「合并 N 次」）；
    //   colW < 6 → 点都放不下，不画任何东西（次数由悬停气泡的「合并 N 次」行兼底，见任务 D）。
    if (runsN > 1) {
      if (colW >= 10) {
        const badge = document.createElement("span");
        badge.className = "htr-runs";
        badge.textContent = "×" + runsN;
        node.appendChild(badge);
      } else if (colW >= 6) {
        const dot = document.createElement("span");
        dot.className = "htr-runs-dot";
        dot.title = "合并 " + runsN + " 次"; // 徽标是子元素，可单独挂原生 title（节点本身 node.title = ""）
        node.appendChild(dot);
      }
    }
    // 2026-10-15 缺口一：变动符号（节点 ＋n/－n + 连线 ⇄n）—— 同刻度口径，挂节点左上角。
    const deltaTxt = historyDeltaSymbolText(ent);
    if (deltaTxt) {
      const delta = document.createElement("span");
      delta.className = "htr-delta";
      delta.textContent = deltaTxt;
      node.appendChild(delta);
    }
    // 悬停气泡 / 单击点选回跳（回跳链：historyBarSelection → historyRollbackConfirmOpen → historyRollbackExecute）
    node.addEventListener("mouseenter", () => historyTreeBubbleShow(node, ent));
    node.addEventListener("mouseleave", () => historyTreeBubbleHide());
    node.addEventListener("click", (ev) => historyTreeNodeClick(ev, node, ent));
    // D6（2026-10-26）：节点右键 → 隐藏此节点 / 恢复全部隐藏。
    // preventDefault + stopPropagation 必须在监听器首行同步执行：否则事件冒泡到 ComfyUI 画布框架，弹画布自己的右键菜单。
    node.addEventListener("contextmenu", (ev) => historyTreeNodeContextMenu(ev, nd.seq, ent, solidEntries, hidden));
    tree.appendChild(node);
    nodeEls.set(nd.seq, node);
  }
  // 休眠折叠条：去折叠后 sleepingCount 恒 0 → 恒不展开（保留元素与分支，不再出现 +N 文案）
  if (sleepEl) {
    if (graph.sleepingCount > 0) {
      sleepEl.textContent = "+" + graph.sleepingCount + " 休眠分支";
      sleepEl.classList.add("htr-sleep-on");
    } else {
      sleepEl.textContent = "";
      sleepEl.classList.remove("htr-sleep-on");
    }
  }
  // 打开定位（2026-10-23 用户定）：首次渲染把「当前编辑节点」（HEAD）滚到视口中间；
  // 找不到 HEAD 才退回「最右贴边」。之后的重渲染不抢滚动位置。
  if (historyTreeCanvasEl) {
    const c = historyTreeCanvasEl;
    if (!historyTreeCenteredOnce) {
      historyTreeCenteredOnce = true;
      const hseq = head && xOf.has(head.seq) ? head.seq : null;
      if (hseq != null) {
        const hnd = (graph.nodes || []).find((n) => n && n.seq === hseq);
        const cxp = axisW + (xOf.get(hseq) + 0.5) * colW;
        const cyp = hnd ? hnd.row * laneH + laneH / 2 : contentH / 2;
        const maxL = Math.max(0, Math.max(W, c.scrollWidth || 0) - c.clientWidth);
        const maxT = Math.max(0, contentH - c.clientHeight);
        c.scrollLeft = Math.max(0, Math.min(maxL, cxp - c.clientWidth / 2));
        c.scrollTop = Math.max(0, Math.min(maxT, cyp - c.clientHeight / 2));
      } else {
        const contentOnly = axisW + cols * colW;   // 不含右侧留白的内容宽
        c.scrollLeft = Math.max(0, contentOnly - c.clientWidth);
      }
    }
  }
  historyTreeUpdateFade();
  return { nodeEls, graph };
}

// D5（2026-10-26）：隐藏集合变更入口（供后续交互单在模块内调用）。
// 流程：接受新集合（Set / seq 数组；省略则现读 localStorage）→ 对照完整 entries 做 sanitizeHidden
//     （剔除不存在 / HEAD / 根）→ 写回 localStorage → 展开着用 historyTreeEntries 重渲染 + 重画线；
//     收起着只更计数（不渲染）。
// 注意：必须先把集合写进 localStorage，再调 historyTreeRenderTree（它自己从 localStorage 取集合）。
// 返回 Boolean：true = 集合与调用前不同（已写盘并重绘）；false = 集合未变（已写盘，无需重绘也算已完成）。
function historyTreeHiddenApplyChange(hiddenSet) {
  const all = Array.isArray(historyTreeEntries) ? historyTreeEntries : [];
  const solid = all.filter((e) => e && e.mergeInto == null);
  const headSeq = historyTreeHead && Number.isInteger(historyTreeHead.seq) ? historyTreeHead.seq : null;
  const before = historyHiddenGet();
  const rawNext = (hiddenSet && typeof hiddenSet.has === "function") || Array.isArray(hiddenSet)
    ? hiddenSet
    : before;
  const next = sanitizeHidden(rawNext, solid, headSeq);
  historyHiddenSet(next);
  if (historyTreeEl && historyTreeEl.classList.contains("htr-open") && historyTreeTreeEl) {
    const res = historyTreeRenderTree(all);
    historyTreeDrawEdges(res && res.nodeEls, res && res.graph);
    // D6（2026-10-26）：重渲染路径原本不更计数（计数只在 fetch 后算）→ 隐藏/恢复后收纳条数字会停在旧值。补上。
    historyTreeUpdateCounts(all);
  } else {
    historyTreeUpdateCounts(all);
  }
  if (next.size !== before.size) return true;
  for (const seq of next) if (!before.has(seq)) return true;
  return false;
}

// ── D7（2026-10-26·任务 B）：收纳条「隐藏 N」恢复面板 ──────────────────
// 挂 document.body（position:fixed）：收纳条在树根内，且面板不能被任何 overflow 裁切。
// 皮肤沿用 .htr-menu（z-index 10002 / 气泡变量），只额外加 .htr-hidden-panel 做行布局。
// 关闭四路与右键菜单同口径：Esc / 点面板外空白 / 再次点入口 / 窗口失焦或缩放。
let historyTreeHiddenPanelEl = null;
let historyTreeHiddenPanelOff = null;

function historyTreeHiddenPanelClose() {
  if (historyTreeHiddenPanelOff) {
    try { historyTreeHiddenPanelOff(); } catch { /* 解绑失败不影响关闭 */ }
    historyTreeHiddenPanelOff = null;
  }
  if (historyTreeHiddenPanelEl && historyTreeHiddenPanelEl.parentElement) {
    historyTreeHiddenPanelEl.parentElement.removeChild(historyTreeHiddenPanelEl);
  }
  historyTreeHiddenPanelEl = null;
}

// 当前的隐藏项（按当前画布隔离：historyHiddenGet 已按画布分键）+ 过一遍 sanitizeHidden（与渲染同口径）
function historyTreeHiddenCurrentSet() {
  const all = Array.isArray(historyTreeEntries) ? historyTreeEntries : [];
  const solid = all.filter((e) => e && e.mergeInto == null);
  const headSeq = historyTreeHead && Number.isInteger(historyTreeHead.seq) ? historyTreeHead.seq : null;
  return sanitizeHidden(historyHiddenGet(), solid, headSeq);
}

// 面板内容重建（列表 + 底部全部恢复）。无隐藏项 → 直接关面板。
function historyTreeHiddenPanelRefresh() {
  const box = historyTreeHiddenPanelEl;
  if (!box) return;
  const set = historyTreeHiddenCurrentSet();
  if (!set.size) { historyTreeHiddenPanelClose(); return; }
  const seqs = [...set].sort((a, b) => a - b);
  const title = "已隐藏 " + set.size + " 个提交";
  // 保留已定位的外壳，只换内部
  const keepRect = { left: box.style.left, top: box.style.top };
  box.textContent = "";
  const t = document.createElement("div");
  t.className = "htr-menu-title";
  t.textContent = title;
  box.appendChild(t);
  for (const seq of seqs) {
    const row = document.createElement("div");
    row.className = "htr-hid-row";
    const lab = document.createElement("span");
    lab.className = "htr-hid-seq";
    lab.textContent = "#" + seq;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "htr-hid-btn";
    btn.textContent = "恢复";
    btn.title = "恢复 #" + seq;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = historyTreeHiddenCurrentSet();
      next.delete(seq);
      historyTreeHiddenApplyChange(next); // 立即生效（内部重渲染 + 更计数）
      // 面板刷新：展开着时 applyChange 会重渲染 → 面板已被关，这里按新集合重开；
      // 收起着时面板仍存在，updateCounts 已就地重建行（不重复 open，否则会被当成「再点一次」关掉）。
      if (!historyTreeHiddenPanelEl && historyTreeHiddenBtnEl && !historyTreeHiddenBtnEl.hidden) {
        historyTreeHiddenPanelOpen();
      }
    });
    row.append(lab, btn);
    box.appendChild(row);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "htr-menu-item htr-hid-all";
  all.textContent = "全部恢复（" + set.size + " 个）";
  all.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyTreeHiddenApplyChange(new Set()); // 清空 → applyChange 内会重渲染并关面板
  });
  box.appendChild(all);
  // 重建后尺寸可能变了：贴回入口上方（重算，不信任旧高度）
  historyTreeHiddenPanelPlace(keepRect);
}

// 定位：挂在入口按钮上方，水平左对齐；贴边则钳在视口内 8px。
function historyTreeHiddenPanelPlace(prev) {
  const box = historyTreeHiddenPanelEl;
  const anchor = historyTreeHiddenBtnEl;
  if (!box || !anchor) return;
  let left = 8;
  let top = 8;
  try {
    const r = anchor.getBoundingClientRect();
    left = r.left;
    top = r.top - box.offsetHeight - 6;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    if (vw > 0) left = Math.max(8, Math.min(left, Math.max(8, vw - bw - 8)));
    if (vh > 0) {
      if (top < 8) top = r.bottom + 6; // 上方放不下 → 翻到入口下方
      top = Math.max(8, Math.min(top, Math.max(8, vh - bh - 8)));
    }
  } catch {
    if (prev && prev.top) { left = prev.left; top = prev.top; }
  }
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
}

// 打开（幂等）：已开 → 先关（再次点入口 = 关闭）
function historyTreeHiddenPanelOpen() {
  historyTreeMenuClose(); // 与右键菜单互斥（同一块屏幕区域）
  if (historyTreeHiddenPanelEl) { historyTreeHiddenPanelClose(); return; }
  const set = historyTreeHiddenCurrentSet();
  if (!set.size) return; // 无隐藏项 → 不弹
  const box = document.createElement("div");
  box.className = "htr-menu htr-hidden-panel";
  box.style.left = "0px";
  box.style.top = "0px";
  box.style.visibility = "hidden";
  box.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  document.body.appendChild(box);
  historyTreeHiddenPanelEl = box;
  historyTreeHiddenPanelRefresh(); // 填内容 + 定位
  box.style.visibility = "visible";
  // 关闭监听（一次性绑定，关闭时全解）
  const onDown = (ev) => {
    const t = ev && ev.target;
    if (!t) return;
    try { if (box.contains(t)) return; } catch { return; }
    // 入口按钮自身不算「空白」：否则 pointerdown 先关、click 再开 → 永远关不掉
    try { if (historyTreeHiddenBtnEl && historyTreeHiddenBtnEl.contains(t)) return; } catch { /* 按外部处理 */ }
    historyTreeHiddenPanelClose();
  };
  const onKey = (ev) => { if (ev && ev.key === "Escape") historyTreeHiddenPanelClose(); };
  const onBlur = () => historyTreeHiddenPanelClose();
  const onScroll = () => historyTreeHiddenPanelClose(); // fixed 面板与入口会错位 → 直接关
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onScroll);
  document.addEventListener("scroll", onScroll, true);
  historyTreeHiddenPanelOff = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("scroll", onScroll, true);
  };
}

// ── D6（2026-10-26）：提交树右键菜单（节点隐藏）────────────────────
// 为什么自绘：原生 confirm/alert 会打断画布且无法「置灰 + 写原因」；皮肤沿用树气泡（.htr-bubble）变量族。
// 挂 document.body（position:fixed）：树面板内 .tcanvas 是 overflow:auto，挂在里面会被裁切。
// 关闭四路：菜单外 pointerdown（捕获）/ Esc / 再右键（contextmenu 捕获）/ 树重渲染与收起。
let historyTreeMenuEl = null;
let historyTreeMenuOff = null; // 当前菜单的全局监听解绑器

function historyTreeMenuClose() {
  if (historyTreeMenuOff) {
    try { historyTreeMenuOff(); } catch { /* 解绑失败不影响关闭 */ }
    historyTreeMenuOff = null;
  }
  if (historyTreeMenuEl && historyTreeMenuEl.parentElement) {
    historyTreeMenuEl.parentElement.removeChild(historyTreeMenuEl);
  }
  historyTreeMenuEl = null;
}

// spec: { title?: string, items: [{ label, hint?, disabled?, onPick? }] }
// 定位：跟随鼠标（client 坐标，fixed）；贴右/贴底则翻转到鼠标另一侧，最后仍钳在视口内 8px。
function historyTreeMenuOpen(clientX, clientY, spec) {
  historyTreeMenuClose();
  historyTreeHiddenPanelClose(); // D7：与「隐藏 N」恢复面板互斥（同一屏幕区域，同时开会叠在一起）
  const items = (spec && Array.isArray(spec.items)) ? spec.items : [];
  if (!items.length) return;
  const box = document.createElement("div");
  box.className = "htr-menu";
  if (spec && spec.title) {
    const t = document.createElement("div");
    t.className = "htr-menu-title";
    t.textContent = String(spec.title);
    box.appendChild(t);
  }
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "htr-menu-item";
    b.textContent = String(it && it.label != null ? it.label : "");
    if (it && it.hint) {
      const h = document.createElement("span");
      h.className = "htr-menu-hint";
      h.textContent = String(it.hint);
      b.appendChild(h);
    }
    if (it && it.disabled) b.disabled = true;
    if (it && typeof it.onPick === "function" && !it.disabled) {
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try { it.onPick(ev); } finally { /* 关不关由 onPick 自己决定（两步确认会在同位重开） */ }
      });
    }
    box.appendChild(b);
  }
  // 先隐藏挂入：需要 offsetWidth/offsetHeight 才能算翻转
  box.style.left = "0px";
  box.style.top = "0px";
  box.style.visibility = "hidden";
  // 菜单本体的右键也不再弹浏览器原生菜单（否则在菜单上再右键会闪出系统菜单）
  box.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  document.body.appendChild(box);
  historyTreeMenuEl = box;
  let left = clientX;
  let top = clientY;
  try {
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw > 0 && left + bw > vw - 8) left = clientX - bw;      // 贴右 → 翻到鼠标左侧
    if (vh > 0 && top + bh > vh - 8) top = clientY - bh;        // 贴底 → 翻到鼠标上方
    if (vw > 0) left = Math.max(8, Math.min(left, Math.max(8, vw - bw - 8)));
    if (vh > 0) top = Math.max(8, Math.min(top, Math.max(8, vh - bh - 8)));
  } catch { /* 定位失败就落在鼠标点 */ }
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
  box.style.visibility = "visible";

  // 关闭监听：一次性绑定，关闭时全部解绑（防监听堆积）
  const onDown = (ev) => {
    const t = ev && ev.target;
    if (!t) return;
    try { if (box.contains(t)) return; } catch { return; }
    historyTreeMenuClose();
  };
  const onCtx = (ev) => {
    const t = ev && ev.target;
    if (t) { try { if (box.contains(t)) return; } catch { /* 按外部处理 */ } }
    historyTreeMenuClose(); // 再次右键（含在节点/泳道上重开）：旧菜单先关，由新 contextmenu 处理器再开
  };
  const onKey = (ev) => { if (ev && ev.key === "Escape") historyTreeMenuClose(); };
  const onBlur = () => historyTreeMenuClose();
  const onScroll = () => historyTreeMenuClose(); // 滚动会让 fixed 菜单与锚点错位 → 直接关
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("contextmenu", onCtx, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onScroll);
  document.addEventListener("scroll", onScroll, true);
  historyTreeMenuOff = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("contextmenu", onCtx, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("scroll", onScroll, true);
  };
}

// 不可隐藏原因（与 sanitizeHidden 口径一致：HEAD / 根节点）。可隐藏 → 返回空串。
function historyTreeHiddenBlockReason(seq, solidEntries, headSeq) {
  if (Number.isInteger(headSeq) && seq === headSeq) return "当前编辑点（HEAD）不可隐藏";
  const list = Array.isArray(solidEntries) ? solidEntries : [];
  const self = list.find((e) => e && e.seq === seq);
  if (!self) return "该节点不在当前提交树数据里";
  if (!Number.isInteger(self.parent)) {
    for (const e of list) if (e && e.parent === seq) return "根节点（有子提交）不可隐藏";
  }
  return "";
}

// 节点右键菜单（任务 A）：隐藏此节点 / 恢复全部隐藏。
// 必须 preventDefault + stopPropagation：否则冒泡到 ComfyUI 画布框架，弹出画布自己的右键菜单。
function historyTreeNodeContextMenu(ev, seq, ent, solidEntries, hiddenSet) {
  ev.preventDefault();
  ev.stopPropagation();
  historyTreeBubbleHide(); // 右键时收起悬停气泡（避免与菜单重叠）
  const items = [];
  const reason = historyTreeHiddenBlockReason(seq, solidEntries, historyTreeHead && historyTreeHead.seq);
  items.push({
    label: "隐藏此节点",
    hint: reason || "",
    disabled: !!reason,
    onPick: () => {
      const next = new Set(hiddenSet || []);
      next.add(seq);
      historyTreeMenuClose();
      historyTreeHiddenApplyChange(next);
    },
  });
  const hiddenN = hiddenSet ? hiddenSet.size : 0;
  if (hiddenN > 0) {
    items.push({
      label: "恢复全部隐藏（" + hiddenN + " 个）",
      onPick: () => {
        historyTreeMenuClose();
        historyTreeHiddenApplyChange(new Set());
      },
    });
  }
  historyTreeMenuOpen(ev.clientX, ev.clientY, {
    title: "#" + historySeqLabel(ent) + (ent && ent.at ? " · " + historyFmtTime(ent.at) : ""),
    items,
  });
}

// ── P7 补完（2026-10-12）：容器挂载 / 取数 / 交互 / 连线 ────────────────────────

// 容器挂载（幂等）：底部收纳条 + 展开面板（行容器 + SVG 连线层）挂 document.body。
// 初始展开态从 historyTreeStateGet() 恢复；展开/收起走 historyTreeStateSet 持久化。
let historyTreeResizeBound = false; // resize 重画连线只绑一次（防 historyTreeEnsure 重建容器时重复绑）
function historyTreeEnsure() {
  historyTreeStyleEnsure();
  if (historyTreeEl && historyTreeEl.isConnected) return;
  const root = document.createElement("div");
  root.id = HISTORY_TREE_ID;
  const open0 = historyTreeStateGet();
  if (open0) root.classList.add("htr-open");
  historyTreeOpen = open0;
  // 收纳条：提交树 · N 节点 · M 分支 + 展开/收起按钮
  const collapsed = document.createElement("div");
  collapsed.className = "htr-collapsed";
  const sum = document.createElement("span");
  sum.className = "htr-sum";
  sum.textContent = "提交树";
  const count = document.createElement("span");
  count.className = "htr-count";
  count.textContent = "0 节点 · 0 分支";
  // D7（2026-10-26·任务 B）：收纳条「隐藏 N」恢复入口。
  // 默认 hidden（无隐藏就不占位）；N 与显隐由 historyTreeUpdateCounts 写。
  // 必须 stopPropagation：它在 .htr-collapsed 内，否则点一下会连带触发收纳条 toggleTree。
  const hiddenBtn = document.createElement("button");
  hiddenBtn.type = "button";
  hiddenBtn.className = "htr-hidden-btn";
  hiddenBtn.hidden = true;
  hiddenBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyTreeHiddenPanelOpen();
  });
  hiddenBtn.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "htr-toggle";
  const setToggleLabel = () => {
    toggle.textContent = root.classList.contains("htr-open") ? "收起" : "展开";
  };
  const toggleTree = () => {
    const open = !root.classList.contains("htr-open");
    root.classList.toggle("htr-open", open);
    historyTreeStateSet(open);
    historyTreeOpen = open;
    setToggleLabel();
    historyTreeMenuClose(); // D6：收起/展开 → 右键菜单失效（面板已隐或即将重渲染）
    historyTreeHiddenPanelClose(); // D7：收起/展开 → 恢复面板同样失效
    if (open) void historyTreeRefresh(); // 展开时取数渲染；收起不 fetch（下次提交/回跳的 refresh 只更计数）
  };
  collapsed.addEventListener("click", toggleTree);
  toggle.addEventListener("click", (ev) => {
    // 按钮在收纳条内：stopPropagation 防止冒泡触发两次切换
    ev.preventDefault();
    ev.stopPropagation();
    toggleTree();
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "htr-save-btn";
  saveBtn.textContent = "存档当前画布";
  saveBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation(); // 防冒泡触发收纳条 toggleTree
    void historySaveClick();
  });
  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "htr-view-btn";
  viewBtn.title = "切换视角：时序 / 紧凑";
  function historyTreeViewBtnSync() { viewBtn.textContent = (historyTreeViewGet() === "compact") ? "紧凑" : "时序"; }
  historyTreeViewBtnSync();
  viewBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation(); // 防冒泡触发收纳条 toggleTree
    historyTreeViewSet(historyTreeViewGet() === "compact" ? "time" : "compact");
    historyTreeViewBtnSync();
    try {
      const r = historyTreeRenderTree(historyTreeEntries);
      historyTreeDrawEdges(r.nodeEls, r.graph);
      if (historyTreeCanvasEl) historyTreeCanvasEl.scrollLeft = 0;
    } catch (e) { console.warn(LOG_TAG, "视角切换重渲染失败", e); }
  });
  collapsed.append(sum, count, hiddenBtn, saveBtn, viewBtn, toggle);
  // 展开面板：.tcanvas（横滚）> .lanes（节点层）+ 两端渐隐 + 休眠折叠条
  const panel = document.createElement("div");
  panel.className = "htr-panel";
  const tcanvas = document.createElement("div");
  tcanvas.className = "tcanvas";
  const lanes = document.createElement("div");
  lanes.className = "lanes";
  tcanvas.appendChild(lanes);
  const fadeL = document.createElement("div");
  fadeL.className = "htr-fade l";
  const fadeR = document.createElement("div");
  fadeR.className = "htr-fade r";
  const sleep = document.createElement("div");
  sleep.className = "htr-sleep";
  panel.append(tcanvas, fadeL, fadeR, sleep);
  // 横向滚轮（同框口径：ΔX 优先，否则 ΔY；到两端放行）+ scroll 渐隐
  // 2026-10-22：Ctrl/Shift + 滚轮 = 缩放；普通滚轮保持原来的横/纵向滚动。
  // 缩放锚定鼠标位置：记下鼠标在内容坐标系里的点，重渲染后把同一点拉回鼠标下，不跳。
  tcanvas.addEventListener(
    "wheel",
    (ev) => {
      // —— 缩放（2026-10-22）：直接滚轮 = 缩放（用户要求）。
      // 平移改用：Shift + 滚轮 / 拖动 / 底部滚动条。
      {
        ev.preventDefault();
        const oldZoom = historyTreeZoomGet();
        const step = ev.deltaY > 0 ? -1 : 1;
        const next = Math.max(HISTORY_TREE_ZOOM_MIN, Math.min(HISTORY_TREE_ZOOM_MAX, oldZoom * (step > 0 ? 1.12 : 1 / 1.12)));
        if (Math.abs(next - oldZoom) < 0.001) return;
        // 锚点：鼠标相对 tcanvas 视口的位置 + 当前 scroll = 内容坐标
        const rect = tcanvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const cx = tcanvas.scrollLeft + mx;
        const cy = tcanvas.scrollTop + my;
        const ratio = next / oldZoom;
        historyTreeZoomSet(next);
        const res = historyTreeRenderTree(historyTreeEntries);
        if (res && res.nodeEls) historyTreeDrawEdges(res.nodeEls, res.graph);
        // 重渲染后内容尺寸变了 → 把锚点拉回鼠标下（下一帧，等布局定型）
        requestAnimationFrame(() => {
          tcanvas.scrollLeft = cx * ratio - mx;
          tcanvas.scrollTop = cy * ratio - my;
          historyTreeUpdateFade();
        });
        return;
      }
      // 2026-10-12：纵向可滚且是纵向滚（|ΔY|≥|ΔX|）→ 放行原生纵向滚动（泳道多时看下方）
      if (tcanvas.scrollHeight > tcanvas.clientHeight && Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) return;
      if (tcanvas.scrollWidth <= tcanvas.clientWidth) return; // 不可横滚 → 放行
      const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (d > 0 && tcanvas.scrollLeft + tcanvas.clientWidth >= tcanvas.scrollWidth - 1) return;
      if (d < 0 && tcanvas.scrollLeft <= 0) return;
      ev.preventDefault();
      tcanvas.scrollLeft += d;
      historyTreeUpdateFade();
    },
    { passive: false }
  );
  tcanvas.addEventListener("scroll", () => historyTreeUpdateFade());
  // 拖拽平移（2026-10-12 · 2c）：按住任意处（含节点）横/纵拖动 → 反向平移 scrollLeft/Top。
  // 与节点 click 消歧：位移 > DRAG_SLOP 才判为拖拽；位移极小仍走 click（见 historyTreeNodeClick）。
  let drag = null;
  const DRAG_SLOP = 3;
  tcanvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    historyTreeDragEndAt = -1e9; // 新手势开始 → 清消歧态
    drag = { x: ev.clientX, y: ev.clientY, l: tcanvas.scrollLeft, t: tcanvas.scrollTop, moved: false };
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return; // 位移极小 → 仍算 click
      drag.moved = true;
      tcanvas.classList.add("htr-dragging");
    }
    ev.preventDefault();
    tcanvas.scrollLeft = drag.l - dx;
    tcanvas.scrollTop = drag.t - dy;
    historyTreeUpdateFade();
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) {
      historyTreeDragEndAt = Date.now(); // 已拖拽 → 紧随的 click 作废
      tcanvas.classList.remove("htr-dragging");
    }
    drag = null;
  };
  window.addEventListener("mouseup", endDrag);
  window.addEventListener("blur", endDrag);
  root.append(collapsed, panel);
  document.body.appendChild(root);
  historyTreeEl = root;
  historyTreePanelEl = panel;
  historyTreeCanvasEl = tcanvas;
  historyTreeTreeEl = lanes;
  historyTreeCountEl = count;
  historyTreeHiddenBtnEl = hiddenBtn; // D7：收纳条「隐藏 N」入口（计数函数与面板定位都需引用）
  historyTreeToggleEl = toggle;
  historyTreeSleepEl = sleep;
  historyTreeFadeLEl = fadeL;
  historyTreeFadeREl = fadeR;
  setToggleLabel();
  // resize 重画连线：用缓存的 historyTreeEntries 重渲染（不 refetch）；收起着跳过（下次展开时 refresh 会画）
  if (!historyTreeResizeBound) {
    historyTreeResizeBound = true;
    let rt = null;
    window.addEventListener("resize", () => {
      if (!historyTreeEl || !historyTreeEl.classList.contains("htr-open")) return;
      if (rt) clearTimeout(rt);
      rt = setTimeout(() => {
        const res = historyTreeRenderTree(historyTreeEntries);
        historyTreeDrawEdges(res && res.nodeEls, res && res.graph);
      }, 120);
    });
  }
}

// 泳道画布两端渐隐更新（同框口径）。
function historyTreeUpdateFade() {
  const c = historyTreeCanvasEl;
  if (!c) return;
  if (historyTreeFadeLEl) historyTreeFadeLEl.classList.toggle("htr-fade-on", c.scrollLeft > 1);
  if (historyTreeFadeREl) historyTreeFadeREl.classList.toggle("htr-fade-on", c.scrollLeft + c.clientWidth < c.scrollWidth - 1);
}

// 取数 + 渲染（commit 成功 / 回跳成功 / 展开时各调一次；函数本体补上即通，两处调用点不动）。
// 竞态：每次真正发起时递增 historyTreeReqId，回包校验，旧的作废。
// P0（2026-10-26）：200ms 防抖 —— 同名连续调用在窗口内合并成一次发起（详见下方 historyTreeRefresh）。
async function historyTreeRefreshNow() {
  if (!historyTreeEl) historyTreeEnsure();
  const reqId = ++historyTreeReqId;
  let wfName = "";
  try {
    wfName = currentWorkflowInfo().name || "";
  } catch {
    wfName = "";
  }
  // 换工作流 = 新画布：允许下次渲染重新把 HEAD 居中（同工作流内保持用户滚动位置）
  if (wfName !== historyTreeCenteredFor) {
    historyTreeCenteredFor = wfName;
    historyTreeCenteredOnce = false;
  }
  try {
    // 照抄弹层取法（HISTORY_LIST_PATH = /hana_bridge/history-list，fetchApi 自动加 /api 前缀）
    const resp = await api.fetchApi(HISTORY_LIST_PATH + withWorkflowIdQs("?workflow=" + encodeURIComponent(wfName)), {
      method: "GET",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || data.ok !== true) throw new Error(String((data && data.error) || "返回异常"));
    if (reqId !== historyTreeReqId) return; // 已有更新的 refresh / 已收起重开：作废
    const entries = Array.isArray(data.entries) ? data.entries : [];
    historyTreeEntries = entries; // 缓存：resize 重画连线用，不 refetch
    // 2026-10-23：HEAD 以后端为准（data.head = {seq, at} | null）。
    // 收起着（只更计数、不渲染）也要更新，否则下次展开渲染的小黄点会停在旧值。
    historyTreeHead = (data && data.head && typeof data.head.seq === "number") ? data.head : null;
    historyTreeUpdateCounts(entries);
    if (historyTreeEl && historyTreeEl.classList.contains("htr-open") && historyTreeTreeEl) {
      const res = historyTreeRenderTree(entries);
      historyTreeDrawEdges(res && res.nodeEls, res && res.graph);
    }
  } catch (err) {
    if (reqId !== historyTreeReqId) return;
    console.warn(LOG_TAG, "P7-树取数失败（静默，不影响画布）", err);
    if (historyTreeEl && historyTreeEl.classList.contains("htr-open") && historyTreeTreeEl) {
      historyTreeTreeEl.textContent = "";
      const errEl = document.createElement("div");
      errEl.className = "htr-err";
      errEl.textContent = "提交树取数失败：" + String((err && err.message) || err);
      historyTreeTreeEl.appendChild(errEl);
    }
  }
}

// P0（2026-10-26）：historyTreeRefresh 的 200ms 防抖外壳。
// 背景：每次调用都完整 fetch + 全量重渲染；提交/回跳/换图/resize 常成串触发 → 重复请求与重复重绘。
// 改法：连续调用都推进同一个 200ms 定时器，窗口到期只发起一次 historyTreeRefreshNow。
// 保留：reqId 竞态、收起着只更计数、展开着渲染+画线、换工作流重置居中（historyTreeCenteredFor）
//       全部在 historyTreeRefreshNow 内，一律不改。
// 返回：Promise —— 本轮合并的所有调用共享一个 Promise，真正那次取数+渲染跑完后才 resolve。
//       （调用方既有 void 也有 await，故不能返回 undefined、也不能提前 resolve。）
const HISTORY_TREE_REFRESH_DEBOUNCE_MS = 200;
let historyTreeRefreshTimer = null;
let historyTreeRefreshWaiters = [];
function historyTreeRefresh() {
  return new Promise((resolve) => {
    historyTreeRefreshWaiters.push(resolve); // 本轮合并的所有调用都在此排队
    if (historyTreeRefreshTimer) clearTimeout(historyTreeRefreshTimer); // 新调用 → 窗口重新计时（尾部触发）
    historyTreeRefreshTimer = setTimeout(() => {
      historyTreeRefreshTimer = null;
      const waiters = historyTreeRefreshWaiters;
      historyTreeRefreshWaiters = [];
      // 无论成败都 resolve（取数失败已在 Now 内部静默处理），避免 await 方永久挂住
      Promise.resolve()
        .then(() => historyTreeRefreshNow())
        .catch((err) => { console.warn(LOG_TAG, "P7-树刷新异常（静默，不影响画布）", err); })
        .then(() => { for (const w of waiters) { try { w(); } catch { /* 忽略 */ } } });
    }, HISTORY_TREE_REFRESH_DEBOUNCE_MS);
  });
}

// 悬停气泡（仿弹层 historyBarBubbleShow；内容：#NNN · 时间 / kind/source · 变更节点名）。
// 绝对定位在树容器内（.htr-bubble），移开由 mouseleave 隐藏。
function historyTreeBubbleShow(tick, ent) {
  if (!historyTreeEl || !tick) return;
  historyTreeBubbleHide();
  const b = document.createElement("div");
  b.className = "htr-bubble";
  const t = document.createElement("div");
  t.className = "htr-bub-time";
  t.textContent = "#" + historySeqLabel(ent) + " · " + historyFmtTime(ent && ent.at);
  b.append(t);
  // 2026-10-26：正文改分组渲染（改动 / 新增 / 删除 / 连线）。
  // 旧版把 changed/added/removed 的名字混成一行「、」串接，不区分动作、也不说改了什么。
  const MAX_ITEMS = 6; // 每组最多列几个名字，多的折成「…等 N 个」
  const addRow = (tag, cls, nodes, withFields) => {
    if (!Array.isArray(nodes) || !nodes.length) return;
    const row = document.createElement("div");
    row.className = "htr-bub-row";
    const tg = document.createElement("span");
    tg.className = "htr-bub-tag " + cls;
    tg.textContent = tag;
    const box = document.createElement("div");
    box.className = "htr-bub-items";
    for (const nd of nodes.slice(0, MAX_ITEMS)) {
      if (!nd || typeof nd !== "object") continue;
      const it = document.createElement("div");
      it.className = "htr-bub-item";
      const nm = String(nd.title == null ? "" : nd.title).trim() || "（未命名节点）";
      it.textContent = nm;
      if (withFields && Array.isArray(nd.fields) && nd.fields.length) {
        const flds = nd.fields.map(historyFieldLabel).filter(Boolean);
        if (flds.length) {
          const f = document.createElement("span");
          f.className = "htr-bub-fld";
          f.textContent = "（" + flds.join("、") + "）";
          it.appendChild(f);
        }
      }
      it.title = it.textContent; // 名字过长被 ellipsis 时能看全
      box.appendChild(it);
    }
    if (nodes.length > MAX_ITEMS) {
      const more = document.createElement("div");
      more.className = "htr-bub-more";
      more.textContent = "…等 " + nodes.length + " 个";
      box.appendChild(more);
    }
    row.append(tg, box);
    b.appendChild(row);
  };
  const d = ent && ent.delta && typeof ent.delta === "object" ? ent.delta : null;
  let rendered = false;
  // 2026-10-26：种子快照行（在四组 delta 之前 —— 种子是本次执行的输入参数，比 delta 更靠前）。
  // 改种子不新建节点（签名忽略 seed），故种子值只随 mergeInto 行下发、后端读时覆盖到主行。
  // 字段缺失（旧条目 → null）/ 空数组 → 整行不渲染，不留空行。
  const MAX_SEEDS = 3; // 种子行最多列几条，多的折成「…等 N 个」
  let seedRowAdded = false;
  const seeds = ent && Array.isArray(ent.seeds) ? ent.seeds.filter((s) => s && typeof s === "object") : [];
  if (seeds.length) {
    const items = [];
    for (const s of seeds.slice(0, MAX_SEEDS)) {
      const nm = String(s.title == null ? "" : s.title).trim();
      const vl = String(s.value == null ? "" : s.value);
      if (!vl) continue; // 没值就没什么可看的
      items.push(nm ? nm + " " + vl : vl);
    }
    if (items.length) {
      const row = document.createElement("div");
      row.className = "htr-bub-row";
      const tg = document.createElement("span");
      tg.className = "htr-bub-tag htr-bub-tag-seed";
      tg.textContent = "种子";
      const box = document.createElement("div");
      box.className = "htr-bub-items";
      for (const txt of items) {
        const it = document.createElement("div");
        it.className = "htr-bub-item";
        it.textContent = txt;
        it.title = txt;
        box.appendChild(it);
      }
      if (seeds.length > MAX_SEEDS) {
        const more = document.createElement("div");
        more.className = "htr-bub-more";
        more.textContent = "…等 " + seeds.length + " 个";
        box.appendChild(more);
      }
      row.append(tg, box);
      b.appendChild(row);
      seedRowAdded = true;
    }
  }
  if (d) {
    addRow("改动", "htr-bub-tag-mod", d.changed, true);
    addRow("新增", "htr-bub-tag-add", d.added, false);
    addRow("删除", "htr-bub-tag-del", d.removed, false);
    const lk = d.links && typeof d.links === "object" ? d.links : null;
    if (lk) {
      const ln = (Array.isArray(lk.added) ? lk.added.length : 0) + (Array.isArray(lk.removed) ? lk.removed.length : 0);
      if (ln) {
        const row = document.createElement("div");
        row.className = "htr-bub-row";
        const tg = document.createElement("span");
        tg.className = "htr-bub-tag htr-bub-tag-link";
        tg.textContent = "连线";
        const vl = document.createElement("div");
        vl.className = "htr-bub-items";
        vl.textContent = "⇄ " + ln + " 处";
        row.append(tg, vl);
        b.appendChild(row);
      }
    }
    rendered = b.childElementCount > 1 + (seedRowAdded ? 1 : 0);
    if (!rendered) {
      const row = document.createElement("div");
      row.className = "htr-bub-row";
      const vl = document.createElement("div");
      vl.className = "htr-bub-items";
      vl.textContent = "无节点 / 连线变更";
      row.appendChild(vl);
      b.appendChild(row);
    }
  }
  if (!d) {
    // delta 缺失（旧条目）：退化到块名（与旧行为一致，只是包一层行）
    const names = historyTickChangedNames(ent).join("、");
    if (names) {
      const row = document.createElement("div");
      row.className = "htr-bub-row";
      const vl = document.createElement("div");
      vl.className = "htr-bub-items";
      vl.textContent = names;
      row.appendChild(vl);
      b.appendChild(row);
    }
  }
  // 2026-10-26（任务 D）：合并次数稳定出口 —— 不看 colW、不看节点宽，气泡里无条件给一行。
  // 节点上的 ×N / 方点会随列宽降级甚至消失，这一行不会。
  // 放在 delta 各组之后（先看改了什么，再看这条提交合了几次）；rendered 已在上方算完，不受影响。
  const runs = ent && Array.isArray(ent.runs) ? ent.runs : [];
  if (runs.length > 1) {
    const row = document.createElement("div");
    row.className = "htr-bub-row";
    const tg = document.createElement("span");
    tg.className = "htr-bub-tag";
    tg.textContent = "合并";
    const vl = document.createElement("div");
    vl.className = "htr-bub-items";
    vl.textContent = runs.length + " 次";
    row.title = "合并 " + runs.length + " 次";
    row.append(tg, vl);
    b.appendChild(row);
  }
  // 注（2026-10-26）：原计划的「旧框名已不存在」提示行已撤回（未实现，也不要重加）—— 前提不成立：
  // historyBarsSpecFor 用每条提交自己快照的 ent.blocks[].name 作条槽（fromHistory: true），
  // 每个提交的色条数本来就等于它自己那个时刻的框数，与当前活图框名无关，不存在「对不上」。
  // 先隐藏挂入：需要 offsetWidth/offsetHeight 才能算定位
  b.style.visibility = "hidden";
  b.style.left = "0px";
  b.style.top = "0px";
  historyTreeEl.appendChild(b);
  try {
    const tr = tick.getBoundingClientRect();
    const rr = historyTreeEl.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    let left = tr.left + tr.width / 2 - rr.left - bw / 2;
    left = Math.max(0, Math.min(left, Math.max(0, rr.width - bw))); // 水平钳在容器内
    // 树贴底：气泡一律向上（下方必出视口/被裁）；树容器无 overflow 裁剪，向上溢出不裁，显示在容器上方。
    /* 再让 13px：让出右上 ×N 上标高度，避免最右键气泡遮住 */
    let top = tr.top - rr.top - bh - 19;
    b.style.left = left.toFixed(1) + "px";
    b.style.top = top.toFixed(1) + "px";
  } catch {
    /* 定位失败也显示（左上角），不影响 hover 语义 */
  }
  b.style.visibility = "visible";
}

function historyTreeBubbleHide() {
  if (!historyTreeEl) return;
  const b = historyTreeEl.querySelector(".htr-bubble");
  if (b && b.parentElement) b.parentElement.removeChild(b);
}

// 单击/双击消歧（同框弹层口径）：单击 → 选中 + 缩略图浮层；双击 → 回跳确认。
// 消歧窗口复用 HISTORY_TICK_DBL_MS（240ms）。
function historyTreeNodeClick(ev, tick, ent) {
  // 2026-10-12：拖拽平移（2c）后的 click 不算点击（同一次手势 mouseup→click；仅拦紧随的 300ms 内）
  if (Date.now() - historyTreeDragEndAt < 300) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (historyTreeClickTimer) {
    // 窗口内二次点击 = 双击 → 回跳确认
    clearTimeout(historyTreeClickTimer);
    historyTreeClickTimer = null;
    historyTreeShotsHide();
    historyTreePick(tick, ent);
    return;
  }
  historyTreeClickTimer = setTimeout(() => {
    historyTreeClickTimer = null;
    historyTreeSelect(tick, ent); // P8：单击先选中（同框 historyTickSelect 口径）
    historyTreeShotsToggle(tick, ent);
  }, HISTORY_TICK_DBL_MS);
}

// 单击选中（同框 historyTickSelect 口径；无轴，选中态自清树内 .node）。
function historyTreeSelect(tick, ent) {
  if (historyRollback.busy) return;
  const file = ent && ent.file ? String(ent.file) : null;
  const seq = ent && ent.seq != null ? ent.seq : null;
  historyRollbackBtnReset();
  historyBarSelection = { file, seq };
  if (historyTreeTreeEl) {
    historyTreeTreeEl.querySelectorAll(".node.htr-tick-sel").forEach((t) => t.classList.remove("htr-tick-sel"));
  }
  if (tick) tick.classList.add("htr-tick-sel");
}

// 单击节点 → 其提交的缩略图浮层（复用 historyImagesToUrls + lightbox）。
// 2a（2026-10-13）：不再「鼠标移出自动关」；同一节点再点 → 关；点别的节点 → 切换。
function historyTreeShotsToggle(tick, ent) {
  const host = historyTreeEl;
  if (!host || !tick) return;
  const same = historyTreeShotsTick === tick;
  historyTreeShotsHide();
  if (same) return; // 再点同一节点 → 关
  historyTreeShotsTick = tick;
  const box = document.createElement("div");
  box.className = "htr-shots htr-shots-on";
  const images = ent && Array.isArray(ent.images) ? ent.images : [];
  const imgs = historyImagesToUrls(images);
  if (!imgs.length) {
    const ph = document.createElement("div");
    ph.className = "htr-shots-ph";
    ph.textContent = "这次提交没有关联出图";
    box.appendChild(ph);
  } else {
    const strip = document.createElement("div");
    strip.className = "htr-shots-strip";
    const single = imgs.length === 1;
    for (const it of imgs) {
      const img = document.createElement("img");
      img.className = "htr-shots-img " + (single ? "single" : "multi");
      img.src = it.thumbUrl;
      img.alt = it.label;
      img.loading = "eager";
      // 缩图端点未生效（404/500）→ 一次性回退旧口径（dataset.fb 防死循环）
      img.onerror = () => { if (img.dataset.fb) return; img.dataset.fb = "1"; img.src = it.thumbFallbackUrl || it.thumbUrl; };
      img.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 2b：带本提交图清单 → 全屏内左右翻页（单图时箭头自动隐藏）
        historyOpenLightbox(it.fullUrl, it.label, { list: imgs, index: imgs.indexOf(it) });
      });
      // 图片异步加载完成 / 失败后重定位：占位高度 → 真实高度，底边锚定不跳。
      img.addEventListener("load", () => { try { historyTreeShotsPosition(box, tick); } catch {} });
      img.addEventListener("error", () => { try { historyTreeShotsPosition(box, tick); } catch {} });
      strip.appendChild(img);
    }
    box.appendChild(strip);
    // 多图横滚：滚轮作用在浮层内部可滚条
    box.addEventListener(
      "wheel",
      (e) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d > 0 && strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1) return;
        if (d < 0 && strip.scrollLeft <= 0) return;
        e.preventDefault();
        strip.scrollLeft += d;
      },
      { passive: false }
    );
  }
  host.appendChild(box);
  historyTreeShotsPosition(box, tick); // 定位：第2a→2026-10-14 抽函数 + 锚点快照（见 historyTreeShotsPosition）
  // 2026-10-14：点浮层容器（树）之外 → 关（点树内交给节点 click 的 toggle/切换逻辑）。
  box.__offOutside = bindOutsideClose(historyTreeEl, () => historyTreeShotsHide());
}

// 树缩略图浮层定位（2026-10-14）。
// 根因：「每帧重查 .htr-bubble 选锚点」→ 气泡在场/不在场（悬停时序）+ 气泡高度随内容变 → 同一节点两次点开落点不同 = 不稳定；
// 且 bh 在图片未加载时是占位值 → 一次性写死 top 后图片加载向下生长（底边下移、盖面板）。
// 修法：① 打开时快照锚点（气泡在场→气泡顶，否则→节点顶，局部坐标）存 box.dataset.anchorTop；后续读快照，不再重查气泡。
//      ② 底边锚定：top = anchorTop - box.offsetHeight - 6（图片加载变高 → top 变小 → 浮层向上生长，底边不动）。
// 水平：居中于节点、钳在宿主宽内（原算法保留）。
function historyTreeShotsPosition(box, tick) {
  const host = historyTreeEl;
  if (!host || !box || !tick) return;
  try {
    const hr = host.getBoundingClientRect();
    const tr = tick.getBoundingClientRect();
    const bw = box.offsetWidth;
    let left = tr.left + tr.width / 2 - hr.left - bw / 2;
    left = Math.max(6, Math.min(left, (hr.width || bw) - bw - 6));
    // 锚点快照：仅首次计算并写入（气泡在场→气泡顶；否则→节点顶）；后续复用，不重查气泡。
    let anchorTop = Number(box.dataset.anchorTop);
    if (!isFinite(anchorTop)) {
      const bub = host.querySelector(".htr-bubble");
      anchorTop = bub
        ? bub.getBoundingClientRect().top - hr.top   // 气泡在场：锚气泡上方
        : tr.top - hr.top;                           // 无气泡：锚节点上方
      box.dataset.anchorTop = String(anchorTop);
    }
    const top = anchorTop - box.offsetHeight - 6;
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  } catch { /* 定位失败也显示（左上角），不影响预览语义 */ }
}

// 点「浮层容器之外」时执行 onOut（用于预览浮层 / 确认框点击外部关闭）。
// 口径：pointerdown 捕获阶段，target 在 container 内 → 不关（交给节点/刻度自身逻辑）；否则 → 关。
// 返回解绑函数（浮层关闭时调用，防监听堆积）。
function bindOutsideClose(container, onOut) {
  if (!container) return () => {};
  const handler = (ev) => {
    const t = ev && ev.target;
    if (!t) return;
    try { if (container.contains(t)) return; } catch { return; }
    try { onOut(); } catch { /* 关闭失败不影响主流程 */ }
  };
  document.addEventListener("pointerdown", handler, true);
  return () => document.removeEventListener("pointerdown", handler, true);
}

function historyTreeShotsHide() {
  historyTreeShotsTick = null; // 2a：关闭即解除「当前节点」绑定
  if (!historyTreeEl) return;
  const b = historyTreeEl.querySelector(".htr-shots");
  if (b) {
    try { b.__offOutside?.(); } catch { /* 解绑失败不影响关闭 */ } // 解绑外部监听（移除前对同一元素）
    b.__offOutside = null;
    if (b.parentElement) b.parentElement.removeChild(b);
  }
}

// 点选回跳：写 historyBarSelection（historyRollbackExecute 读它）→ 复用弹层确认框。
// 防重入：historyRollback.busy 时忽略。树内旧选中态自清（弹层轴选中态归弹层管，互不干扰）。
function historyTreePick(tick, ent) {
  if (!ent || ent.seq == null || historyRollback.busy) return;
  historyTreeBubbleHide();
  historyTreeShotsHide();
  const file = ent && ent.file ? String(ent.file) : null;
  historyBarSelection = { file, seq: ent.seq };
  if (historyTreeTreeEl) {
    historyTreeTreeEl.querySelectorAll(".node.htr-tick-sel").forEach((t) => t.classList.remove("htr-tick-sel"));
  }
  if (tick) tick.classList.add("htr-tick-sel");
  historyRollbackConfirmOpen(tick, ent); // 确认框 → 「回跳」走 historyRollbackExecute（现有链）
}

// 连线（泳道式）：按真实 DOM 位置画 SVG。
//  · 同 row → 水平直线
//  · 跨 row → 圆角贝塞尔 M x1,y1 C mx,y1 mx,y2 x2,y2
//  · 一端在折叠泳道（row=-1，即节点未渲染）→ 淡出为水平短线 opacity .18（表示此处有分支被折叠）
// 折线 → 圆角路径（2026-10-23 用户定「连线换成曲线」）：
// 不动骨架——行间隙轨道、侧向接入的 L 形、跨道轨道错开全部照旧，只把每个拐角用二次贝塞尔磨圆。
// 半径按相邻两段长度的一半自动收窄，短段不会被切出倒刺；2 点直线原样输出。
function roundedPolyline(pts, radius) {
  const n = Array.isArray(pts) ? pts.length : 0;
  if (n < 2) return "";
  const f1 = (v) => v.toFixed(1);
  let s = "M" + f1(pts[0].x) + " " + f1(pts[0].y);
  if (n === 2) return s + "L" + f1(pts[1].x) + " " + f1(pts[1].y);
  for (let i = 1; i < n - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (!(r >= 0.6) || !(d1 > 0) || !(d2 > 0)) {
      s += "L" + f1(p1.x) + " " + f1(p1.y);
      continue;
    }
    const ax = p1.x + ((p0.x - p1.x) / d1) * r;
    const ay = p1.y + ((p0.y - p1.y) / d1) * r;
    const bx = p1.x + ((p2.x - p1.x) / d2) * r;
    const by = p1.y + ((p2.y - p1.y) / d2) * r;
    s += "L" + f1(ax) + " " + f1(ay);
    s += "Q" + f1(p1.x) + " " + f1(p1.y) + " " + f1(bx) + " " + f1(by);
  }
  return s + "L" + f1(pts[n - 1].x) + " " + f1(pts[n - 1].y);
}

// nodeEls/graph 均来自 historyTreeRenderTree；rAF 等一帧布局稳定后测量。
// D9（2026-10-26·级联紧凑）：遍历数据源 = historyTreeShownEntries（= 可见集 visibleEntries）。
// 可见集的 parent 已被 applyHidden 短路改挂到可见祖先 → 不存在隐藏端点，边一律两端都有 DOM。
// ghostRect 分支保留作兜底（正常路径不会再走到：几何、行号、端点均来自可见集）。
function historyTreeDrawEdges(nodeEls, graph) {
  const tree = historyTreeTreeEl;
  if (!tree || !nodeEls || !nodeEls.size) return;
  const edgeEntries = historyTreeShownEntries || historyTreeEntries;
  const bySeq = new Map();
  for (const ent of edgeEntries) {
    if (ent && ent.seq != null) bySeq.set(ent.seq, ent);
  }
  const rowOf = new Map();
  if (graph && Array.isArray(graph.nodes)) {
    for (const nd of graph.nodes) if (nd) rowOf.set(nd.seq, nd.row);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "htr-edges");
  tree.appendChild(svg);
  const geom = historyTreeGeom || { colW: 40, laneH: 36, nodeH: 22 };
  requestAnimationFrame(() => {
    let tr = null;
    try {
      tr = tree.getBoundingClientRect();
    } catch {
      return;
    }
    if (!tr || (!tr.width && !tr.height)) return;

    // ── 几何 ────────────────────────────────────────────────────────────
    let cw = (geom && geom.colW) || 40;
    const axW = (geom && typeof geom.axisW === "number") ? geom.axisW : 34;
    if (!(cw >= 12)) cw = 40;
    const lh = (geom && geom.laneH) || 36;
    const nh = (geom && geom.nodeH) || 22;
    const off3 = Math.max(1, Math.round(3 * (lh / 36)));
    const cyOf = (row) => row * lh + lh / 2 + off3;
    const botOf = (row) => cyOf(row) + nh / 2;
    const topOf = (row) => cyOf(row) - nh / 2;
    const corrOf = (row) => {
      const rowBottom = (row + 1) * lh;
      const gap = Math.max(1, rowBottom - botOf(row));
      return rowBottom - gap / 2;
    };

    // ── 第一遍：收集边 ──────────────────────────────────────────────────
    const edges = [];
    const fadedParts = [];
    const TRACK_GAP = 2.5;

    // 各泳道节点的 x 区间（按真实 DOM 量一次），供「侧向接入是否挡路」判定用。
    const xRangesByRow = new Map();
    for (const [sq, el] of nodeEls) {
      const r = rowOf.get(sq);
      if (r == null) continue;
      let rc = null;
      try { rc = el.getBoundingClientRect(); } catch { continue; }
      if (!rc || !rc.width) continue;
      const l = rc.left - tr.left;
      const rr = rc.right - tr.left;
      if (!xRangesByRow.has(r)) xRangesByRow.set(r, []);
      xRangesByRow.get(r).push({ seq: sq, l, r: rr });
    }
    // 目标泳道在 [xa,xb] 这段水平区间内是否有其它节点占位（含子节点自己则排除）。
    const laneBlocked = (row, exceptSeq, xa, xb) => {
      const lo = Math.min(xa, xb);
      const hi = Math.max(xa, xb);
      const list = xRangesByRow.get(row) || [];
      for (const it of list) {
        if (it.seq === exceptSeq) continue;
        if (it.r > lo + 0.5 && it.l < hi - 0.5) return true;
      }
      return false;
    };

    // D8（留空位时代的兼容分支）：被隐藏节点没有 DOM 时用 geom.xOf 补一个「幽灵矩形」。
    // D9（2026-10-26·级联紧凑）后 historyTreeShownEntries 已是可见集、parent 已短路改挂，
    // 正常情况下走不到这里；保留作几何/行号缺失时的兜底，不改变任何现有路径。
    const ghostRect = (sq) => {
      const row = rowOf.get(sq);
      if (row == null || row < 0) return null;
      const gx = (geom && geom.xOf && typeof geom.xOf.get === "function") ? geom.xOf.get(sq) : null;
      if (gx == null) return null;
      const e2 = bySeq.get(sq);
      if (!e2) return null;
      const runs2 = Array.isArray(e2.runs) ? e2.runs.length : 0;
      const w = runs2 > 1 ? ((geom && geom.nwBulge) || 10) : ((geom && geom.nw) || 10);
      const h = (geom && geom.nodeH) || 22;
      const cx2 = tr.left + axW + (gx + 0.5) * cw; // 与节点 left 同式
      const cy2 = tr.top + cyOf(row);                // 与节点中心同式（节点多 +3 的视觉偏移不参与连线）
      return { left: cx2 - w / 2, top: cy2 - h / 2, width: w, height: h };
    };
    const rectOf = (sq, el) => {
      if (el) {
        try {
          const r = el.getBoundingClientRect();
          if (r && r.width) return r;
        } catch { /* 落到 ghost */ }
      }
      return ghostRect(sq);
    };

    for (const ent of edgeEntries) {
      const seq = ent && ent.seq;
      if (seq == null) continue;
      const p = ent.parent;
      if (p == null || !bySeq.has(p)) continue;
      const cRow = rowOf.get(seq);
      const pRow = rowOf.get(p);
      const childEl = nodeEls.get(seq);
      const parentEl = nodeEls.get(p);
      const cr0 = rectOf(seq, childEl);
      const pr0 = rectOf(p, parentEl);
      if (!cr0 || !pr0) {
        // 连幽灵位都算不出（行/列缺失）→ 退回旧的半截淡线
        const visible = childEl || parentEl;
        if (!visible) continue;
        let vr;
        try { vr = visible.getBoundingClientRect(); } catch { continue; }
        if (!vr || !vr.width) continue;
        const vx = vr.left + vr.width / 2 - tr.left;
        const vy = vr.bottom - tr.top;
        const dir = childEl ? -1 : 1;
        fadedParts.push("M" + vx.toFixed(1) + " " + vy.toFixed(1) +
          "L" + (vx + dir * 12).toFixed(1) + " " + vy.toFixed(1));
        continue;
      }
      if (pRow == null || cRow == null) continue;
      const cr = cr0;
      const pr = pr0;

      const pcx = pr.left + pr.width / 2 - tr.left;
      const ccx = cr.left + cr.width / 2 - tr.left;
      const pcy = pr.top + pr.height / 2 - tr.top;
      const ccy = cr.top + cr.height / 2 - tr.top;

      if (pRow === cRow) {
        edges.push({
          kind: "same", ep: [seq, p],
          pts: [{ x: pcx + pr.width / 2, y: pcy }, { x: ccx - cr.width / 2, y: ccy }],
        });
        continue;
      }

      const down = cRow > pRow;
      const hop = Math.abs(cRow - pRow);
      const yP = down ? botOf(pRow) : topOf(pRow);
      const yC = down ? topOf(cRow) : botOf(cRow);

      if (Math.abs(ccx - pcx) < 0.5 && hop === 1) {
        edges.push({ kind: "cross", ep: [seq, p], pts: [{ x: pcx, y: yP }, { x: ccx, y: yC }] });
        continue;
      }
      if (hop === 1) {
        // 2026-10-23（用户定）：相邻泳道 + 水平错开时，不再绕到行间隙再拐回子节点顶部，
        // 而是从父节点底（/顶）直接下到子节点垂直中心，再水平接入它靠近父一侧的腰边。
        // 少一个拐点、路径更短，读起来更顺。
        // 两条前置：① 目标泳道在这段水平区间里没有其它节点挡路（否则线会穿节点）；
        //           ② 水平段得真有一段可走（太短就退化成一个小绊，不如原折线）。
        const sideX = ccx > pcx ? (ccx - cr.width / 2) : (ccx + cr.width / 2);
        const horizRun = Math.abs(sideX - pcx);
        if (horizRun >= 8 && !laneBlocked(cRow, seq, pcx, sideX)) {
          edges.push({
            kind: "cross", ep: [seq, p],
            pts: [{ x: pcx, y: yP }, { x: pcx, y: ccy }, { x: sideX, y: ccy }],
          });
          continue;
        }
        const c1 = down ? corrOf(pRow) : corrOf(pRow - 1);
        edges.push({
          kind: "cross", ep: [seq, p],
          pts: [{ x: pcx, y: yP }, { x: pcx, y: c1 }, { x: ccx, y: c1 }, { x: ccx, y: yC }],
        });
        continue;
      }
      const pCol = Math.round((pcx - axW) / cw - 0.5);
      const cCol = Math.round((ccx - axW) / cw - 0.5);
      let gapIdx;
      if (cCol > pCol) gapIdx = pCol + 1;
      else if (cCol < pCol) gapIdx = pCol;
      else gapIdx = pCol + 1;
      const yA = down ? corrOf(pRow) : corrOf(pRow - 1);
      const yB = down ? corrOf(cRow - 1) : corrOf(cRow);
      edges.push({
        kind: "cross-long", ep: [seq, p], gapIdx,
        lo: Math.min(pRow, cRow), hi: Math.max(pRow, cRow),
        pts: [
          { x: pcx, y: yP }, { x: pcx, y: yA },
          { x: axW + gapIdx * cw, y: yA }, { x: axW + gapIdx * cw, y: yB },
          { x: ccx, y: yB }, { x: ccx, y: yC },
        ],
      });
    }

    // ── 轨道分配：同一列间隙内行区间重叠的边错开 ──────────────────────────
    const gapW = Math.max(TRACK_GAP, cw - nh);
    const maxTracks = Math.max(1, Math.floor(gapW / TRACK_GAP));
    const byGap = new Map();
    for (const e of edges) {
      if (e.kind !== "cross-long") continue;
      if (!byGap.has(e.gapIdx)) byGap.set(e.gapIdx, []);
      byGap.get(e.gapIdx).push(e);
    }
    for (const [, list] of byGap) {
      list.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
      const trackEnd = [];
      for (const e of list) {
        let t = 0;
        for (; t < trackEnd.length; t++) if (trackEnd[t] < e.lo) break;
        if (t >= maxTracks) t = trackEnd.indexOf(Math.min.apply(null, trackEnd));
        e.track = t;
        trackEnd[t] = e.hi;
      }
      const n = Math.max(1, Math.min(maxTracks, trackEnd.length));
      for (const e of list) {
        const off = (e.track - (n - 1) / 2) * TRACK_GAP;
        const gx = axW + e.gapIdx * cw + off;
        e.pts[2].x = gx;
        e.pts[3].x = gx;
      }
    }

    // ── 第二遍：拼路径（同泳道水平线遇竖线断开）──────────────────────────
    const BRIDGE_GAP = 4;
    const vSegs = [];
    for (const e of edges) {
      if (!e.pts || e.pts.length < 2) continue;
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const a = e.pts[i];
        const b = e.pts[i + 1];
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5) {
          vSegs.push({ x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        }
      }
    }
    const dParts = [];
    for (const e of edges) {
      const pts = e.pts;
      if (!pts || pts.length < 2) continue;
      if (e.kind === "same" && pts.length === 2) {
        const y = pts[0].y;
        const xa = Math.min(pts[0].x, pts[1].x);
        const xb = Math.max(pts[0].x, pts[1].x);
        const cuts = [];
        for (const v of vSegs) {
          if (v.x > xa + 1 && v.x < xb - 1 && y > v.lo - 1 && y < v.hi + 1) cuts.push(v.x);
        }
        cuts.sort((p, q) => p - q);
        let cur = xa;
        for (const cx of cuts) {
          const l = cx - BRIDGE_GAP / 2;
          if (l > cur + 0.5) dParts.push({ from: cur, to: l, y });
          cur = cx + BRIDGE_GAP / 2;
        }
        if (xb > cur + 0.5) dParts.push({ from: cur, to: xb, y });
        continue;
      }
      // 2026-10-23（用户定）：折线统一走圆角曲线，骨架点不变。
      dParts.push({ raw: roundedPolyline(pts, 10) });
    }
    let d = "";
    for (const p of dParts) {
      if (p.raw) { d += p.raw; continue; }
      d += "M" + p.from.toFixed(1) + " " + p.y.toFixed(1) +
           "L" + p.to.toFixed(1) + " " + p.y.toFixed(1);
    }
    let html = "";
    if (d) html += '<path d="' + d + '"/>';
    if (fadedParts.length) html += '<path d="' + fadedParts.join("") + '" opacity="0.18"/>';
    svg.innerHTML = html;
  });
}
// 执行期间把变更来源标为 "agent"；装载类窗口另标 "system"（见 beginSystemWindow）。
// v2（2026-10-08）追加 canvas.copilot（开关自身也是写类；拦截豁免见下）。
const WRITE_OPS = new Set([
  "canvas.loadWorkflowFile", "canvas.openWorkflow", "canvas.activateWorkflow",
  "canvas.setWidget", "canvas.addNode", "canvas.removeNode",
  "canvas.connect", "canvas.disconnect", "canvas.setNodeMode", "canvas.moveNode",
  "canvas.addGroup", "canvas.setGroup", "canvas.removeGroup",
  "canvas.save", "canvas.undo", "canvas.patch", "canvas.organize",
  "canvas.queue", "canvas.duplicate", "canvas.visual", "canvas.copilot",
]);

// ── 副驾驶写拦截（v2 硬约束，2026-10-08）─────────────────────────────
// 写类 op 在「当前活动页副驾驶未开」时统一拒绝（{ok:false, error:"copilot_off", detail:指引}）。
// 判定实时取当前状态：关了立即恢复受限；开了立即放行。豁免名单及理由（逐条，任务书要求）：
//   · canvas.openWorkflow —— 「打开」（切前台看布）：无副驾驶画布上仅允许的两类动作之一。
//   · canvas.activateWorkflow —— 「切标签」（把已打开的目标页切前台）：同属「打开看布」类，对齐
//                            canvas.openWorkflow——无副驾驶的画布也应允许把它切到前台来看；写权限
//                            仍由后续写 op 自己把关（本 op 装载目标标签自己的 activeState、不向图
//                            注入新变更——与 canvas.openWorkflow 同属「打开看布」，故豁免）。
//   · canvas.duplicate    —— 「复制」：另一类允许动作；v2 默认工作方式就是先复制副本再干活。
//   · canvas.save         —— 「落盘」：v2 副本流程第 2 步（复制 → 落盘 → 开副本副驾驶 → 操作，
//                            顺序固定——落盘先于开启发生）；且落盘不注入新图变更（把已有内容
//                            写盘），不构成侵占性修改。
//   · canvas.copilot      —— 「开关自身」：若拦截它，未开的画布永远开不了（鸡生蛋）；
//                            其开启权限由 app 层「允许 Agent 开启画布副驾驶」总闸管辖
//                            （桥读不到设置——该边界如实：桥侧不检查总闸，只在 app 层生效）。
// 另注：frame.reload（壳页腿维护 op）不在本名单（不在 WRITE_OPS 里，两名单均不含），
// 评估结论＝维持豁免（维护性操作：重载内层 iframe，不向画布注入改动）。
// 另注（修订 1，2026-10-09）：canvas.loadWorkflowNewPage（移交快照「新开页装载」）两名单均不含——
// 口径＝「用户主动移交」（用户点「放入」+ 开卡接住，非 agent 代理写），不设副驾驶门槛、
// 也不标 agent 变更来源；装载窗口的变更由 beginSystemWindow 记 "system"（与 loadWorkflowFile 同）。
const COPILOT_WRITE_EXEMPT = new Set([
  "canvas.openWorkflow",
  "canvas.activateWorkflow",
  "canvas.duplicate",
  "canvas.save",
  "canvas.copilot",
]);

// 判定：该 op 此刻是否应被副驾驶硬约束拒绝；拒绝时返回指引文本，放行返回 null。
function copilotWriteBlocked(opName) {
  if (!WRITE_OPS.has(opName)) return null;
  if (COPILOT_WRITE_EXEMPT.has(opName)) return null;
  const cp = copilotReadState();
  if (cp.enabled) return null;
  return (
    `当前画布${cp.pageKey ? `（pageKey=${cp.pageKey}）` : ""}未开启副驾驶：写类操作已拒绝；` +
    "Agent 仅可打开（openWorkflow）/ 复制（duplicate）/ 落盘（save）。" +
    "开启方式：① 用户在画布顶栏点「副驾驶·开」；② 用户在设置页开启「允许 Agent 开启画布副驾驶」授权后，由 Agent 用 canvas.copilot {enabled:true} 奉命开启。"
  );
}

// 监听中继经 ComfyUI 自带 /ws 推来的指令，执行后同源回传
api.addEventListener(EVT_CALL, async (event) => {
  const msg = (event && event.detail) || {};
  let payload;
  try {
    const fn = OPS[msg.op];
    if (!fn) throw new Error("unknown op: " + msg.op);
    const isWrite = WRITE_OPS.has(msg.op);
    // 副驾驶硬约束（v2，2026-10-08）：写类 op 在「当前活动页未开副驾驶」时统一拒绝（豁免见上）。
    const blockedDetail = copilotWriteBlocked(msg.op);
    if (blockedDetail) {
      payload = { ok: false, error: "copilot_off", detail: blockedDetail };
    } else {
      if (isWrite) changeSource = "agent";
      try {
        payload = { ok: true, data: await fn(msg.args || {}) };
      } finally {
        // 仅当仍在 "agent" 时复位；op 内部开了 system 窗的（装载类）由窗口自己收口复位
        if (isWrite && changeSource === "agent") changeSource = "user";
      }
    }
  } catch (err) {
    payload = { ok: false, error: String((err && err.message) || err) };
  }
  try {
    await postJson(PATH_RESULT, { id: msg.id, ...payload });
  } catch (err) {
    console.warn(LOG_TAG, "回传失败", err);
  }
});

app.registerExtension({
  name: "hana.bridge",
  async setup() {
    // 壳页协同（修订 1.2）：把本实例身份推给 parent 壳页（定向直发用；与后端无关，先行；
    // 后端未就绪/hello 失败也不影响宣告——见上方 announceToShell 注释块）。
    announceToShell();
    // P1-A2：常驻安装 api.queuePrompt 包装（与后端无关，先行；不依赖 hello 成败）。
    installQueuePromptCapture();
    // P4 修：常驻安装出图产物捕获（与后端无关，先行；幂等；上报失败静默）。
    installOutputCapture();
  // 2026-10-22 兜底：依赖事件有漏网，再加一层定期扫描补绑（幂等）。
  installOrphanImageSync();
    // P7-树（2026-10-12）：底部提交树容器挂载（幂等）+ 首次刷新（收起着只更新计数）。
    historyTreeEnsure();
    void historyTreeRefresh();
    // P2-F1b：安装画布点击命中 group（包原型 + 重绑实例事件回调 + 元素 capture 监听；与后端无关，先行；幂等）。
    installHistoryGroupClick();
    // N1（2026-10-12）：安装「换图」监听（litegraph:set-graph；与后端无关，先行；幂等）。
    installHistoryGraphSwitchListener();
    // 延迟重试：setup() 时 app.canvas / canvas 元素可能尚未就绪（已绑则内部跳过）。
    scheduleHistoryGroupInstallRetries();
    try {
      await postJson(PATH_HELLO, {
        clientId: api.clientId || null,
        href: location.href,
        workflow: currentWorkflowInfo(),
      });
      // N1修（2026-10-12）：建立工作流名基线（统一判据 lastWorkflowName），
      // 让首轮轮询 / 启动期事件不会把「初始工作流」误判成「换工作流」。
      try {
        lastWorkflowName = currentWorkflowInfo().name;
      } catch {
        /* 取不到则留 null，由 historyOnWorkflowSwitch() 首轮自记 */
      }
      // 变更感知轮询（P2）：先建一次基线，之后定期比对签名
      pollGraph();
      setInterval(pollGraph, CHANGE_POLL_MS);
      // copilot 开关（D1）：挂到画布区顶栏（app.menu.element）；初始态从 localStorage 恢复
      copilotUiEnsure();
      // 页面加载后推一次基线快照（否则服务端要等到首次变化才有状态）
      void pushStateSnapshot();
      console.info(LOG_TAG + " 已挂载 clientId=" + (api.clientId || "?") + " ops=" + Object.keys(OPS).join(","));
    } catch (err) {
      console.warn(LOG_TAG, "上报失败（后端未就绪？）", err);
    }
  },
});
