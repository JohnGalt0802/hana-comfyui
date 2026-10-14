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
const BUILD_TAG = "2026-10-14 hana-bridge-15001613";

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

// 给 history 类请求体/查询补 workflowId + workflowPath + workflowTemporary
// （与既有 workflow 名并存；后端优先用 id/identity 判键，缺省回退名）。
function withWorkflowId(payload) {
  const id = currentWorkflowId();
  if (!id) return payload;
  const out = Object.assign({}, payload, { workflowId: id });
  const p = currentWorkflowPath();
  if (p) out.workflowPath = p;
  out.workflowTemporary = currentWorkflowTemporary();
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
const PATCH_ALLOWED = ["addNode", "setWidget", "connect", "disconnect", "setNodeMode", "removeNode", "save"];
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
    let dirty = false;
    try { dirty = workflowDirty(aw); } catch { dirty = false; }
    if (dirty && a.force !== true) {
      return { opened: false, blocked: "dirty", activeBefore: before };
    }

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
    let graph = null;
    try {
      if (app && app.graph && typeof app.graph.toJSON === "function") {
        graph = app.graph.toJSON();
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
        void reportHistoryCommit({ graph, promptId, blocks, source: historyCommitSource });
      }
    } catch (err) {
      console.warn(LOG_TAG, "提交历史上报失败（不影响提交）", err);
    }
    return r;
  };
  queuePromptCaptureInstalled = true;
}

// ── P5b（2026-10-11）：HEAD 管理（per-workflow localStorage）──────────────────
// 契约见 docs/方案-画布提交历史-P5b-数据模型接线.md §3.1。键结构照抄 copilot：
//   hana.history.head.v1:<ws>:<hashPath(pageKey)>（pageKey 取法同 copilotPageKey）。
// 值：{ seq, at }。seq 为 null → 删键。只存最小信息；异常一律 try/catch 吞。
const HISTORY_HEAD_LS_PREFIX = "hana.history.head.v1:";

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

function historyHeadKey(pageKey) {
  return HISTORY_HEAD_LS_PREFIX + copilotWorkspaceId() + ":" + hashPathKey(pageKey);
}

// 读当前页 HEAD：{seq, at} | null（坏 JSON / 无 pageKey / 无键 → null）
function historyHeadGet() {
  try {
    const pk = historyPageKey();
    if (!pk) return null;
    const raw = localStorage.getItem(historyHeadKey(pk));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || v.seq == null) return null;
    return { seq: v.seq, at: v.at != null ? v.at : null };
  } catch {
    return null;
  }
}

// 写当前页 HEAD；seq 为 null → 删键。异常一律吞。
function historyHeadSet(seq, at) {
  try {
    const pk = historyPageKey();
    if (!pk) return;
    const key = historyHeadKey(pk);
    if (seq == null) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ seq, at: at != null ? at : null }));
  } catch {
    /* 忽略 */
  }
}

// 上报一次提交（契约字段冻结，勿改字段名）：POST /hana_bridge/history-commit
// ⚠️ P1-C2：目标改道桥 Python 后端（同源）；端点由 P1-C1 并行实现，未就绪时静默失败。
// P5b：增 source / kind（可选参，默认 "user" / "run"，为 P8 agent 通道预留）与 parent
//      （读 HEAD；无 HEAD → 不传该字段，后端用线性默认）。读响应判 merged：
//      未合并 → 写新 seq 到 HEAD；merged:true → HEAD 不变（仍是目标节点）。
async function reportHistoryCommit({ graph, promptId, blocks, source = "user", kind = "run" }) {
  try {
    let workflow = null;
    try {
      workflow = currentWorkflowInfo().name;
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
    // P5b：parent = 当前 HEAD 节点 seq；无 HEAD → 不带字段（后端线性默认 = 索引末条）。
    try {
      const head = historyHeadGet();
      if (head && head.seq != null) body.parent = head.seq;
    } catch { /* 忽略 */ }
    // P2-F2：块归属（[{name, source:"group"|"role", nodeIds:[…]}]）随快照上报；
    // 仅在算出数组时携带 —— null / 计算失败 → 不带字段（Python 端快照同样省略，读回 null）。
    if (Array.isArray(blocks)) body.blocks = blocks;
    const resp = await postJson(HISTORY_COMMIT_PATH, withWorkflowId(body));
    // P5b：读响应判合并。未合并（新建节点）→ HEAD 移到新 seq；合并 → HEAD 不变。
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (data && data.ok === true && data.merged !== true && data.seq != null) {
      historyHeadSet(data.seq, at);
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
  api.addEventListener("execution_success", (e) => {
    try {
      const d = e && e.detail;
      const pid = d && typeof d.prompt_id === "string" ? d.prompt_id : null;
      if (!pid) return;
      const images = pendingImages.get(pid) || [];
      pendingImages.delete(pid);
      if (images.length) void reportHistoryImages(pid, images);
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

// 上报一次出图产物（契约字段冻结，勿改字段名）：POST /hana_bridge/history-attach-images
// ⚠️ 端点在索引里按 promptId 找 entry → 写/合并 sidecar；未就绪时静默失败。
async function reportHistoryImages(promptId, images) {
  try {
    let workflow = null;
    try { workflow = currentWorkflowInfo().name; } catch { workflow = null; }
    await postJson(HISTORY_ATTACH_PATH, withWorkflowId({
      workflow, promptId, images, at: new Date().toISOString(),
    }));
  } catch (err) {
    console.warn(LOG_TAG, "P4 出图产物回填失败（不影响画布）", err);
  }
}

// ── P2-F2（2026-10-11）：提交快照的块归属 blocks ──────────────────────────────
// graphBlocks(graph)：对「UI 格式 JSON」算块归属 → [{name, source:"group"|"role", nodeIds:[…]}]。
// 归组口径移植自 app/lib/canvas-outline.mjs（group 优先 + 角色兜底两级），纯函数零依赖 ——
// CSP 'self' 下桥全局脚本不能 import ESM，只能复制而非引用；**改动需同步两侧**。
// 口径：① graph.groups 非空时，节点 pos=[x,y] 落在某 group.bounding=[x,y,w,h] 内（含边界）
// → 归该组，落多个组取第一个；无 pos / 不入任何组 → ② 角色兜底（first-match、不区分大小写）：
// /Loader|LoadImage/→加载、/TextEncode|TextGenerate|StringFormat/→文本、
// /Sampler|Scheduler|Guider|Noise/→采样、/^(Save|Preview)/→输出、其余→其他。
// 块名去重沿用同款：重名加 #2 递增直到唯一；空 title 用「组{i}」（i 为 groups 序号、从 1 起），
// 与角色块名同池查重。与 outline 的差异：不产 summary/blockEdges/issues；块排序与 outline
// 一致（按块内最小 node id 升序，nodeIds 亦升序）。
// 边界：graph 非对象/null → 返回 null（调用方整字段省略，Python 快照读回 null）；
//       空 groups → 全部节点走角色兜底；空节点图 → []（合法零块；但提交通道有 hasGraph
//       拦截，空节点图本就不上报，[] 只会出现在直连 Python 的请求里）。
//       空 group（bounding 内无节点）不成块，同 outline。
function graphBlocks(graph) {
  if (graph === null || typeof graph !== "object") return null;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const groups = Array.isArray(graph.groups) ? graph.groups : [];
  const ROLE_RULES = [
    [/Loader|LoadImage/i, "加载"],
    [/TextEncode|TextGenerate|StringFormat/i, "文本"],
    [/Sampler|Scheduler|Guider|Noise/i, "采样"],
    [/^(Save|Preview)/i, "输出"],
  ];
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
  // 分桶：group 优先；未归组 → ② 角色兜底（first-match）
  const groupBuckets = new Map(); // group index → node[]
  const roleBuckets = new Map(); // role name → node[]
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const gi = groupOfNode.get(node);
    if (gi !== undefined) {
      if (!groupBuckets.has(gi)) groupBuckets.set(gi, []);
      groupBuckets.get(gi).push(node);
      continue;
    }
    const type = String(node.type ?? "");
    let role = ROLE_FALLBACK;
    for (const [re, name] of ROLE_RULES) {
      if (re.test(type)) {
        role = name;
        break;
      }
    }
    if (!roleBuckets.has(role)) roleBuckets.set(role, []);
    roleBuckets.get(role).push(node);
  }
  // 块名分配（groups 顺序）+ 重名去重「#k」（k 从 2 起；空标题组名与角色名同池检查）
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
    rawBlocks.push({ name: dedupName(title || `组${gi + 1}`), source: "group", color: g.color, nodes });
  }
  for (const [role, nodes] of roleBuckets) {
    rawBlocks.push({ name: dedupName(role), source: "role", nodes });
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
#${HISTORY_BAR_ID} {
  position: fixed; z-index: 10001;
  background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
  color: #fff;
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.075),
    inset 0 0 0 1px rgba(255,255,255,.05),
    0 10px 30px rgba(0,0,0,.5),
    0 2px 6px rgba(0,0,0,.4);
  backdrop-filter: blur(6px);
  padding: 7px 10px 8px; font-size: 12px; line-height: 1.4;
  pointer-events: auto; user-select: none;
  max-width: min(760px, calc(100vw - 16px));
}
#${HISTORY_BAR_ID} .hhb-title { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-wf { font-weight:600; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${HISTORY_BAR_ID} .hhb-count { color:#9fb3c8; }
#${HISTORY_BAR_ID} .hhb-x { margin-left:auto; background:transparent; border:0; color:#cfd8e3; font-size:14px; cursor:pointer; padding:0 4px; line-height:1; }
#${HISTORY_BAR_ID} .hhb-x:hover { color:#fff; }
#${HISTORY_BAR_ID} .hhb-build { color:#6f8194; font-size:10px; margin-left:2px; }
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
#${HISTORY_BAR_ID} .hhb-fade.l { left: 0; background: linear-gradient(90deg, rgba(31,37,46,.95), transparent); }
#${HISTORY_BAR_ID} .hhb-fade.r { right: 0; background: linear-gradient(270deg, rgba(31,37,46,.95), transparent); }
#${HISTORY_BAR_ID} .hhb-fade.hhb-fade-on { opacity: 1; }
/* 刻度（统一母题）：外框 = 线型(操作)+色(谁)；内条堆 = 本次碰过的画布框（框色，见 .hnode-bar） */
#${HISTORY_BAR_ID} .hhb-tick {
  flex: none; position: relative; width: var(--hhb-tw, 9px); height: 27px; padding: 2px 0; margin: 0; /* 3a修（2026-10-13）：横向 padding 1px→0，内条贴外框内侧，消除「色块挤占」造成的框粗细错觉 */
  box-sizing: border-box; display: flex; flex-direction: column;
  border: 2px solid color-mix(in oklab, var(--hhb-c, #5aa0d8) 60%, transparent); border-style: solid; border-radius: 4.5px; /* 3a修：统一 2px（原 明2.5/密1.5） */ /* 第8条（2026-10-13）：border-color 半透明 → 发光描边（原实色 = 实心框观感） */
  background: rgba(255,255,255,.025); cursor: pointer;
  /* 第8条（2026-10-13）：常态外光晕加强（固定 10px / 65%，与树同口径） */
  box-shadow: 0 1.5px 4px rgba(0,0,0,.45), 0 0 10px color-mix(in oklab, var(--hhb-c, #5aa0d8) 65%, transparent);
  transition: transform .14s, box-shadow .14s, filter .14s;
}
/* 密档降级：列宽小时只收内边距；3a修：不再改 border-width（否则与明档跳变 1px） */
#${HISTORY_BAR_ID} .hhb-tick[data-tight] { padding: 1px 0; border-radius: 3px; }
#${HISTORY_BAR_ID} .hhb-tick:hover {
  transform: translateY(-1.5px); filter: brightness(1.12);
  box-shadow: 0 1.5px 4px rgba(0,0,0,.55), 0 0 12px color-mix(in oklab, var(--hhb-c, #5aa0d8) 80%, transparent);
}
/* 合并加粗：3a修（2026-10-13）3.5→2.5px（保留合并可辨，收窄与单次 2px 的差距）；密档不再另行降级（统一 2.5px） */
#${HISTORY_BAR_ID} .hhb-tick.hhb-tick-bulge { width: var(--hhb-tw-bulge, calc(var(--hhb-tw, 9px) + 10px)); border-width: 2.5px; box-shadow: 0 1.5px 4px rgba(0,0,0,.5), 0 0 12px color-mix(in oklab, var(--hhb-c, #5aa0d8) 85%, transparent); } /* 第8条：合并光晕更亮 */
#${HISTORY_BAR_ID} .hhb-tick .hhb-runs {
  display: none; /* P8：×N 默认隐藏，滑过节点才显示（定位不变） */
  position: absolute; top: -5px; right: -6px; font-size: 8.5px; font-weight: 700;
  color: #0d1014; background: #dfe8f2; border-radius: 5px; padding: 0 3px; line-height: 11px;
  box-shadow: 0 1px 3px rgba(0,0,0,.5); pointer-events: none;
}
#${HISTORY_BAR_ID} .hhb-tick:hover .hhb-runs { display: inline-block; }
#${HISTORY_BAR_ID} .hhb-tick-sel { box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
#${HISTORY_BAR_ID} .hhb-tick[data-legacy] { opacity: .55; }
#${HISTORY_BAR_ID} .hhb-tick[data-legacy]::after {
  content: ""; position: absolute; top: -3px; right: -3px;
  width: 4px; height: 4px; border-radius: 50%; background: #e8c268;
}
#${HISTORY_BAR_ID} .hhb-times { display:flex; justify-content:space-between; gap:12px; margin-top:3px; color:#8fa3b8; font-size:11px; }
#${HISTORY_BAR_ID} .hhb-times span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 悬停气泡（锚在刻度上方；越界落到刻度下方）。pointer-events:none → 不挡刻度 hover */
#${HISTORY_BAR_ID} .hhb-bubble {
  position:absolute; z-index:3; max-width:280px; pointer-events:none;
  background:rgba(18,22,28,.98); color:#e6edf5;
  border:1px solid rgba(255,255,255,.22); border-radius:8px;
  box-shadow:0 6px 20px rgba(0,0,0,.5); padding:5px 8px; font-size:11px; line-height:1.45;
}
#${HISTORY_BAR_ID} .hhb-bub-time { color:#9fb3c8; }
#${HISTORY_BAR_ID} .hhb-bub-legacy { color:#9aa0a8; font-size:10px; }
/* 单击刻度的缩略图浮层（2026-10-13 第2a：由弹层内固定行改为浮层；浮在被点刻度上方；同刻度再点关） */
#${HISTORY_BAR_ID} .hhb-shots {
  position:absolute; z-index:6; display:none;
  pointer-events:auto; /* 必须收回指针事件，否则图不可点/不可滚 */
  /* 与树 .htr-shots 同口径：同款面板皮肤（渐变底 + 内描边 + 阴影 + 内边距/圆角） */
  width:auto; max-width: min(760px, 92vw); /* 浮层限宽（同树 .htr-shots），不铺满以免遮画布 */
  background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.075),
    inset 0 0 0 1px rgba(255,255,255,.05),
    0 10px 30px rgba(0,0,0,.5),
    0 2px 6px rgba(0,0,0,.4);
  backdrop-filter: blur(6px);
  padding:7px 10px 8px;
}
#${HISTORY_BAR_ID} .hhb-shots-on { display:block; }
#${HISTORY_BAR_ID} .hhb-shots-ph { color:#9fb3c8; font-size:11px; padding:4px 2px; }
#${HISTORY_BAR_ID} .hhb-thumb { width:100%; border-radius:8px; background:#3a414b; color:#aab4c0; display:flex; align-items:center; justify-content:center; font-size:12px; overflow:hidden; }
#${HISTORY_BAR_ID} .hhb-thumb-has { background:transparent; }
#${HISTORY_BAR_ID} .hhb-thumb-multi { width:100%; }
#${HISTORY_BAR_ID} .hhb-thumb-img { width:100%; height:auto; max-height:220px; object-fit:contain; border-radius:8px; display:block; cursor:zoom-in; background:#3a414b; }
#${HISTORY_BAR_ID} .hhb-shots .hhb-thumb-img.single { width:100%; max-width:720px; height:auto; max-height:340px; object-fit:contain; } /* 浮层内单图自适应（同树 .htr-shots-img.single） */
#${HISTORY_BAR_ID} .hhb-shots .hhb-thumb-img.multi { flex:none; width:240px; height:auto; max-height:340px; object-fit:contain; } /* 浮层内多图小条（同树 .htr-shots-img.multi） */
#${HISTORY_BAR_ID} .hhb-thumb-strip { display:flex; gap:4px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; padding-bottom:2px; max-width:100%; }
#${HISTORY_BAR_ID} .hhb-thumb-strip::-webkit-scrollbar { display:none; }
#${HISTORY_BAR_ID} .hhb-seq { font-weight:600; }
#${HISTORY_BAR_ID} .hhb-row { display:flex; align-items:center; gap:4px; color:#9fb3c8; font-size:11px; }
#${HISTORY_BAR_ID} .hhb-dot { width:7px; height:7px; border-radius:50%; flex:none; background:#9aa0a8; }
#${HISTORY_BAR_ID} .hhb-dot[data-src="user"] { background:#7fb2d9; }
#${HISTORY_BAR_ID} .hhb-dot[data-src="agent"] { background:#c9a0e8; }
#${HISTORY_BAR_ID} .hhb-foot { display:flex; align-items:center; gap:8px; margin-top:7px; }
#${HISTORY_BAR_ID} .hhb-roll { background:rgba(127,178,217,.15); border:1px solid rgba(127,178,217,.5); color:#cfe4f5; border-radius:7px; padding:3px 10px; cursor:pointer; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-roll:hover { background:rgba(127,178,217,.28); }
#${HISTORY_BAR_ID} .hhb-roll-armed { background:rgba(232,160,160,.18); border-color:rgba(232,160,160,.75); color:#f3c6c6; }
#${HISTORY_BAR_ID} .hhb-save { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.24); color:#dfe7ef; border-radius:7px; padding:3px 10px; cursor:pointer; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-save:hover { background:rgba(255,255,255,.14); }
#${HISTORY_BAR_ID} .hhb-save[disabled] { opacity:.55; cursor:default; }
#${HISTORY_BAR_ID} .hhb-topmsg { color:#b8e0a0; font-size:12px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-msg { color:#e8c268; font-size:11px; }
#${HISTORY_BAR_ID} .hhb-msg:empty { display:none; }
#${HISTORY_BAR_ID} .hhb-empty, #${HISTORY_BAR_ID} .hhb-err { color:#9fb3c8; padding:6px 2px; }
#${HISTORY_BAR_ID} .hhb-err { color:#e8a0a0; }
#${HISTORY_LIGHTBOX_ID} { position:fixed; inset:0; z-index:10050; background:rgba(0,0,0,.82); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; cursor:zoom-out; pointer-events:auto; user-select:none; }
#${HISTORY_LIGHTBOX_ID} img { max-width:92vw; max-height:84vh; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,.6); background:#222; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-cap { color:#cfd8e3; font-size:12px; max-width:90vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-page { color:#cfd8e3; font-size:12px; font-variant-numeric:tabular-nums; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-x { position:absolute; top:10px; right:14px; background:transparent; border:0; color:#cfd8e3; font-size:20px; cursor:pointer; line-height:1; padding:0 4px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-x:hover { color:#fff; }
/* 2b（2026-10-13）：同提交内多图左右翻页（单图 [hidden] 隐藏） */
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav { position:absolute; top:50%; transform:translateY(-50%); width:38px; height:38px; border-radius:50%; background:rgba(18,22,28,.72); border:1px solid rgba(255,255,255,.24); color:#e6edf5; font-size:22px; line-height:1; cursor:pointer; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav:hover { background:rgba(38,44,54,.92); }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-prev { left:14px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-next { right:14px; }
#${HISTORY_LIGHTBOX_ID} .hhb-lb-nav[hidden] { display:none; }
#${HISTORY_CONFIRM_ID} {
  position: fixed; z-index: 10003; min-width: 220px; max-width: min(420px, calc(100vw - 16px));
  background: rgba(28,32,39,.98); color: #fff;
  border: 1px solid rgba(255,255,255,.22); border-radius: 11px;
  box-shadow: 0 12px 36px rgba(0,0,0,.55); padding: 12px 14px; font-size: 13px;
  pointer-events: auto; user-select: none;
}
#${HISTORY_CONFIRM_ID} .hhb-cf-text { margin-bottom: 10px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-warn { color:#e8a0a0; font-size:12px; margin:-4px 0 10px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-warn:empty { display:none; }
#${HISTORY_CONFIRM_ID} .hhb-cf-row { display:flex; justify-content:flex-end; gap:8px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-btn { background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.22); color:#dfe7ef; border-radius:7px; padding:4px 12px; cursor:pointer; font-size:12px; }
#${HISTORY_CONFIRM_ID} .hhb-cf-ok { background:rgba(127,178,217,.18); border-color:rgba(127,178,217,.6); color:#cfe4f5; }
#${HISTORY_CONFIRM_ID} .hhb-cf-ok:hover { background:rgba(127,178,217,.3); }
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
    img.onerror = () => { if (img.dataset.fb) return; img.dataset.fb = "1"; img.src = it.fullFallbackUrl || it.fullUrl; };
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
  // 点任意处关闭（✕ / 箭头已 stopPropagation，不会重复触发）
  box.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyLightboxClose();
  });
  // 滚轮翻页（多图）：向下/右滚 → 下一张，向上/左滚 → 上一张；单图不拦（不 preventDefault，页面正常滚）。
  // 节流 220ms 防触控板惯性连翻。不动已有箭头/键盘逻辑。
  box.addEventListener(
    "wheel",
    (ev) => {
      if (!historyLightboxItems || historyLightboxItems.length < 2) return; // 单图不翻
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

// 活图「框名 → 框色」映射（内条取色源 = 画布 bundle 框色）。
// 框名口径与内条渲染完全同源（都走 graphBlocks，source === "group"）；取不到活图/无框 → 空 Map。
function historyLiveBlockColors() {
  const m = new Map();
  try {
    const g = app && app.graph ? app.graph : null;
    if (!g || typeof g.toJSON !== "function") return m;
    const blocks = graphBlocks(g.toJSON());
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (b && b.source === "group" && typeof b.color === "string" && b.color) m.set(b.name, b.color);
    }
  } catch { /* 取不到 → 空 Map（渲染退化为中性灰） */ }
  return m;
}

// 统一母题样式（两视图共用，一次性注入）：外框由各视图自己画（线型=操作、色=谁），内条堆用此公共类。
function historyNodeStyleEnsure() {
  const ID = "hana-history-node-style";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
.hnode-bars { display:flex; flex-direction:column; gap:1.5px; align-items:stretch; justify-content:center; flex:1 1 auto; min-height:0; }
.hnode-bar { display:block; flex:1 1 0; min-height:2px; border-radius:2px; background:${HNODE_BAR_DIM}; } /* 3b（2026-10-13）：内条圆角 1px→2px */
.hnode-bar.hnode-bar-on { background:var(--hnode-bc, #5aa0d8); filter:brightness(1.08); } /* 3a修（2026-10-13）：去掉内条 5px 光晕 + 降亮度 1.15→1.08，外框始终是视觉主线（原亮条盖过外框） */
`;
  document.head.appendChild(style);
}

// 内条堆（统一母题）：全局框各一根；「碰过」的框 → 该框真色（亮），未碰 → 中性灰。
// barNames=全局框名（singleBar 时传 [null] 退化为单根）；hitSet=碰过的框名 Set（null=旧数据全灰）；
// colorMap=框名→框色。
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
  const bars = historyBarsBuild(ctx && ctx.allBlocks, hitSet, ctx && ctx.colorMap, !!(ctx && ctx.singleBar));
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
    let top = (tr.top - br.top) / k - bh - 6;
    if (tr.top - bh * k - 6 < 4 && tr.bottom + 6 + bh * k < window.innerHeight - 4) top = (tr.bottom - br.top) / k + 6;
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
    const curBlock = historyBlockNameOf(historyBarGroup);
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
    if (countEl) countEl.textContent = shown.length + " 次提交";
    if (!axis) return;
    axis.textContent = "";
    if (times) times.textContent = "";
    // 统一母题「外框+内条」上下文：全局框列表（首次出现序）+ 活图框名→框色映射 + no-frame 退化标志。
    if (ctx) {
      const allBlocks = [];
      const seen = new Set();
      for (const ent of shown) {
        const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : [];
        for (const b of bl) {
          const nm = b && b.name != null ? String(b.name) : "";
          if (nm && !seen.has(nm)) { seen.add(nm); allBlocks.push(nm); }
        }
      }
      ctx.allBlocks = allBlocks;
      ctx.colorMap = historyLiveBlockColors();
      ctx.singleBar = allBlocks.length === 0;
    }
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "hhb-empty";
      empty.textContent = curBlock ? "这个块没有提交记录" : "这个工作流还没有提交记录";
      axis.appendChild(empty);
      return;
    }
    // 宽度自适应（定稿卡数值）：少时加宽（≤44）、多时定宽（≥11）+ 横滚；刻度随之缩窄。
    const n = shown.length;
    const availW = axis.clientWidth || 0;
    const colW = Math.min(72, Math.max(22, availW / n)); // 第8条（2026-10-13）：下限 11→22（面板可横滚 → 密档不压缩 colW，靠溢出滚动）
    let tw = Math.min(24, Math.max(5, colW * 0.5)); // 第8条：单块更瘦（系数 0.72→0.5，下限 4→5）
    const twBulge = Math.min(tw + 10, colW - 3); // 第8条：多块更宽（+8→+10，封顶 colW-2→colW-3）→ 单/多差拉大
    tw = Math.min(tw, colW * 0.86);
    const gap = Math.max(2, colW - tw);
    axis.style.gap = gap + "px";
    if (ctx) ctx.colW = colW;
    // 刻度左旧右新：按 entries 原序（索引本身按 seq/时间递增）直接 append
    for (const ent of shown) {
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
      first.textContent = historyFmtTime(shown[0] && shown[0].at);
      const last = document.createElement("span");
      last.textContent = historyFmtTime(shown[shown.length - 1] && shown[shown.length - 1].at);
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

// 点击钩子（只读）：命中 group → 弹出/切换；点空白 → 收起。任何分支不改画布状态。
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
    // P5b（契约 §3.1）：回跳成功 → 写 HEAD = 回跳到的 seq。
    // 这样「回跳后改再提交」时 parent 指向回跳节点 = 分支。异常吞掉，不影响回跳。
    try {
      const backSeq = snap.seq != null ? snap.seq : (sel && sel.seq);
      if (backSeq != null) historyHeadSet(backSeq, snap.at != null ? snap.at : null);
    } catch { /* 忽略 */ }
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
  if (!historyBarEl) return;
  historyBarOpen(g);
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
let historyTreeToggleEl = null; // 展开/收起按钮
let historyTreeSleepEl = null; // 休眠折叠条（+N 休眠分支）
let historyTreeFadeLEl = null; // 左端渐隐
let historyTreeFadeREl = null; // 右端渐隐
let historyTreeGeom = null; // 最近一次渲染几何 {colW,laneH,W,H}（预留）
// 视角（时序 / 紧凑）：全局一种，localStorage 持久化（2026-10-14）。
const HISTORY_TREE_VIEW_LS = "hana.historyTreeView.v1"; // "time" | "compact"
let historyTreeViewMode = null;
function historyTreeViewGet() {
  if (historyTreeViewMode === "time" || historyTreeViewMode === "compact") return historyTreeViewMode;
  let m = "compact"; // 2026-10-14：默认视角 time→compact（仅 localStorage 无值时；有历史选择仍按历史）
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
let historyTreeDragEndAt = -1e9; // 最近一次「带位移拖拽」结束时刻（远过去=无；节点 click 与拖拽消歧用，见 historyTreeNodeClick）

// —— 收纳状态存取（键结构同 historyHeadKey；pageKey 取不到 → 不持久化，按收纳默认）——
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
#${HISTORY_TREE_ID} {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 9990;
  pointer-events: none; user-select: none;
  font-size: 12px; line-height: 1.4; color: #e6edf5;
}
#${HISTORY_TREE_ID} .htr-collapsed {
  pointer-events: auto; height: 26px; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; cursor: pointer;
  background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.075), 0 -1px 0 rgba(0,0,0,.3);
  backdrop-filter: blur(6px);
}
#${HISTORY_TREE_ID} .htr-sum { font-weight: 600; }
#${HISTORY_TREE_ID} .htr-count { color: #9fb3c8; }
#${HISTORY_TREE_ID} .htr-toggle {
  margin-left: auto; background: transparent; border: 1px solid rgba(255,255,255,.24);
  color: #dfe7ef; border-radius: 6px; padding: 1px 8px; cursor: pointer; font-size: 11px;
}
#${HISTORY_TREE_ID} .htr-toggle:hover { background: rgba(255,255,255,.1); }
#${HISTORY_TREE_ID} .htr-save-btn {
  margin-left: 8px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.24);
  color: #dfe7ef; border-radius: 7px; padding: 1px 10px; font-size: 11px; cursor: pointer; flex: none;
}
#${HISTORY_TREE_ID} .htr-save-btn:hover { background: rgba(255,255,255,.14); }
#${HISTORY_TREE_ID} .htr-view-btn {
  margin-left: 6px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.24);
  color: #dfe7ef; border-radius: 7px; padding: 1px 10px; font-size: 11px; cursor: pointer; flex: none;
}
#${HISTORY_TREE_ID} .htr-view-btn:hover { background: rgba(255,255,255,.14); }
#${HISTORY_TREE_ID} .htr-panel {
  pointer-events: auto; display: none; height: auto; position: relative;
  background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.075), inset 0 0 0 1px rgba(255,255,255,.05), 0 -10px 30px rgba(0,0,0,.4);
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
/* 泳道基准线：每条显示泳道一根 1px 微亮横线 */
#${HISTORY_TREE_ID} .htr-laneaxis {
  position: absolute; left: 0; right: 0; height: 1px;
  background: rgba(255,255,255,.032); pointer-events: none;
}
/* 节点（统一母题）：外框 = 线型(操作)+色(谁)；内条堆 = 本次碰过的画布框（框色，见 .hnode-bar） */
#${HISTORY_TREE_ID} .node {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: stretch;
  width: var(--nw, 10px); min-width: 6px; min-height: 22px; /* 2026-10-12：节点加高 18→22（laneH 36 不变 → 行内仍留 ≥14px 间隙） */
  padding: 2px 0; margin: 0; box-sizing: border-box; /* 3a修（2026-10-13）：横向 padding 1.5px→0，内条出血贴外框内侧 */
  border: 2px solid color-mix(in oklab, var(--htr-c, #5aa0d8) 60%, transparent); border-style: solid; border-radius: 4.5px; /* 3a修：统一 2px，与框节点同口径 */ /* 第8条：border-color 半透明 → 发光描边 */
  background: #1e242c; cursor: pointer; z-index: 1; /* 连线层之下（.htr-edges z-index:0） */ /* 2026-10-14：底色不透明——连线经过节点矩形时被遮住，不再透出 */
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
#${HISTORY_TREE_ID} .node[data-tight] { padding: 1px 0; border-radius: 3px; }
/* 合并提交加粗（外框加粗 + 强光晕，同框口径） */
#${HISTORY_TREE_ID} .node.htr-tick-bulge {
  width: var(--nw-bulge, calc(var(--nw, 10px) + 10px)); /* 第8条：多块宽由 JS 算好（min(nw+10, colW-3)），永不超格 */
  border-width: 2.5px;
  box-shadow: 0 0 12px color-mix(in oklab, var(--htr-c, #5aa0d8) 85%, transparent); /* 第8条：合并光晕更亮 */
}
/* ×N 徽标（同框口径） */
#${HISTORY_TREE_ID} .htr-runs {
  display: none; /* P8：×N 默认隐藏，滑过节点才显示（定位不变） */
  position: absolute; top: -6px; right: -8px; font-size: 8.5px; font-weight: 700;
  color: #0d1014; background: #dfe8f2; border-radius: 5px; padding: 0 3px; line-height: 11px;
  box-shadow: 0 1px 3px rgba(0,0,0,.5); pointer-events: none;
}
#${HISTORY_TREE_ID} .node:hover .htr-runs { display: inline-block; }
#${HISTORY_TREE_ID} .node:hover { filter: brightness(1.25); }
#${HISTORY_TREE_ID} .htr-tick-sel { outline: 2px solid rgba(255,255,255,.9); outline-offset: 2px; border-radius: 4px; }
/* HEAD 高亮：节点下小金点 */
#${HISTORY_TREE_ID} .htr-tick-head::after {
  content: ""; position: absolute; bottom: -7px; left: 50%; transform: translateX(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: #e8c268;
}
/* 旧数据（blockNames === null）：淡化（同弹层 [data-legacy] 口径） */
#${HISTORY_TREE_ID} .node[data-legacy] .hnode-bars { opacity: .55; }
/* 父子连线层：渲染后按真实位置补画（SVG），只描边不填充 */
#${HISTORY_TREE_ID} .htr-edges {
  /* 2026-10-12 修（H0 根因）：<svg> 是替换元素，缺省视口 300×150；只写 inset:0 不撑开（width 命中 intrinsic 300px），
     超出 300px 的连线被 SVG 根 overflow:hidden 裁掉。显式 width/height:100% 让视口随 .lanes 内容尺寸。 */
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; z-index: 0; /* P8：连线置底，不再穿框/盖节点 */
  stroke: rgba(196,214,236,.72); stroke-width: 2.2; /* 2026-10-12：对比度 .55→.72、线宽 1.8→2.2（H3 对症） */
  stroke-linecap: round; stroke-linejoin: round; fill: none;
}
/* 两端渐隐（同框口径） */
#${HISTORY_TREE_ID} .htr-fade { position: absolute; top: 0; bottom: 0; width: 18px; pointer-events: none; z-index: 2; opacity: 0; transition: opacity .2s; }
#${HISTORY_TREE_ID} .htr-fade.l { left: 10px; background: linear-gradient(90deg, rgba(31,37,46,.95), transparent); }
#${HISTORY_TREE_ID} .htr-fade.r { right: 10px; background: linear-gradient(270deg, rgba(31,37,46,.95), transparent); }
#${HISTORY_TREE_ID} .htr-fade.htr-fade-on { opacity: 1; }
/* 休眠折叠条：虚线框 + +N（本期只显示+计数；展开折叠分支列为后续） */
#${HISTORY_TREE_ID} .htr-sleep {
  position: absolute; left: 10px; bottom: 4px; z-index: 3;
  display: none; align-items: center; gap: 5px;
  font-size: 10.5px; color: #9fb3c8;
  border: 1px dashed rgba(255,255,255,.2); border-radius: 6px; padding: 1px 7px;
  background: rgba(18,22,28,.6);
}
#${HISTORY_TREE_ID} .htr-sleep.htr-sleep-on { display: flex; }
#${HISTORY_TREE_ID} .htr-empty { color: #9fb3c8; padding: 6px 2px; }
#${HISTORY_TREE_ID} .htr-err { color: #e8a0a0; padding: 6px 2px; }
/* 悬停气泡（同弹层 .hhb-bubble 家族） */
#${HISTORY_TREE_ID} .htr-bubble {
  position: absolute; z-index: 5; max-width: 280px; pointer-events: none;
  background: rgba(18,22,28,.98); color: #e6edf5;
  border: 1px solid rgba(255,255,255,.22); border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,.5); padding: 5px 8px; font-size: 11px; line-height: 1.45;
}
#${HISTORY_TREE_ID} .htr-bub-time { color: #9fb3c8; }
/* 单击节点的缩略图浮层（默认隐藏；双击=回跳；点空白/移出关） */
#${HISTORY_TREE_ID} .htr-shots {
  position: absolute; z-index: 6; display: none;
  pointer-events: auto; /* P8：树根为 pointer-events:none；浮层必须收回指针事件，否则图不可点/不可滚/hover 不触发 */
  /* P8：与框预览 .hhb-shots 同口径——同款面板皮肤（渐变底 + 内描边 + 阴影 + 内边距/圆角） */
  background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
  border: 0; border-radius: 13px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.075),
    inset 0 0 0 1px rgba(255,255,255,.05),
    0 10px 30px rgba(0,0,0,.5),
    0 2px 6px rgba(0,0,0,.4);
  backdrop-filter: blur(6px);
  padding: 7px 10px 8px; max-width: min(760px, 92vw); /* 树浮层保持限宽，不铺满以免遮画布 */
}
#${HISTORY_TREE_ID} .htr-shots.htr-shots-on { display: block; }
#${HISTORY_TREE_ID} .htr-shots-ph { color: #9fb3c8; font-size: 11px; padding: 4px 2px; } /* 同 .hhb-shots-ph */
#${HISTORY_TREE_ID} .htr-shots-strip {
  display: flex; gap: 4px; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; padding-bottom: 2px;
}
#${HISTORY_TREE_ID} .htr-shots-strip::-webkit-scrollbar { display: none; }
#${HISTORY_TREE_ID} .htr-shots-img {
  display: block; flex: none; border-radius: 8px; background: #3a414b; /* 圆角 7→8，同 .hhb-thumb-img */
  cursor: zoom-in;
}
#${HISTORY_TREE_ID} .htr-shots-img.single { width: 100%; max-width: 720px; height: auto; max-height: 340px; object-fit: contain; } /* 限宽树浮层内单图自适应；同 .hhb-thumb-img 观感 */
#${HISTORY_TREE_ID} .htr-shots-img.multi { width: 240px; height: auto; max-height: 340px; object-fit: contain; } /* 同 .hhb-thumb-strip .hhb-thumb-img */
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
function commitGraphLanes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { lanes: [], nodes: [], rows: 0, sleepingCount: 0 };
  }
  // (1) 泳道分配（单遍，seq 升序）——泳道对象数组，物理顺序即行序（lanes[0] 在最上）
  const lanes = []; // { head: seq|null, seqs: [] }；只增不回收
  const objOf = new Map(); // seq -> 泳道对象（该 seq 所在泳道）
  const nodeLane = []; // 与 entries 同序的「泳道对象」
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i] || {};
    const seq = e.seq;
    const p = e.parent;
    let target = null;
    // ① 延续：找 head === p 的泳道
    // parent 必须是 < seq 的整数；孤儿 / parent>=seq / 非整数 / 缺失 一律视同根
    if (Number.isInteger(p) && p < seq) {
      for (const lane of lanes) {
        if (lane.head === p) {
          target = lane;
          break;
        }
      }
    }
    // ② 新分支：插到父泳道正下方；父泳道不存在 → append
    if (!target) {
      const pObj = Number.isInteger(p) && p < seq ? objOf.get(p) : null;
      if (pObj) {
        const pos = lanes.indexOf(pObj) + 1;
        target = { head: null, seqs: [] };
        lanes.splice(pos, 0, target);
      } else {
        target = { head: null, seqs: [] };
        lanes.push(target);
      }
    }
    target.head = seq;
    target.seqs.push(seq);
    objOf.set(seq, target);
    nodeLane.push(target);
  }
  // (2) 全量显示（2026-10-12：取消 LANES_MAX_ROWS 折叠）——所有泳道全部显示：
  //     row = lane、rows = laneCount、sleepingCount 恒 0（lanes[].sleeping 恒 false）。
  //     泳道多时由 .tcanvas 拖拽/滚动查看（见 2c）。逻辑与 app/lib/commit-graph-lanes.mjs 逐条一致。
  const laneIndex = new Map();
  lanes.forEach((lane, idx) => laneIndex.set(lane, idx));
  const nodes = [];
  for (let i = 0; i < entries.length; i += 1) {
    const lane = laneIndex.get(nodeLane[i]);
    nodes.push({ seq: entries[i].seq, lane, row: lane });
  }
  const outLanes = lanes.map((lane, idx) => ({ lane: idx, headSeq: lane.head, sleeping: false }));
  return { lanes: outLanes, nodes, rows: lanes.length, sleepingCount: 0 };
}

// 计数：N 节点；M 分支（parent 被 ≥2 个节点指向的 parent 数）；K 泳道（总泳道数，全量显示、无折叠）。
function historyTreeUpdateCounts(entries) {
  if (!historyTreeCountEl) return;
  const cnt = new Map();
  for (const ent of entries) {
    const p = ent && ent.parent;
    if (p == null) continue;
    cnt.set(p, (cnt.get(p) || 0) + 1);
  }
  let branches = 0;
  for (const v of cnt.values()) if (v >= 2) branches += 1;
  const graph = commitGraphLanes(entries);
  historyTreeCountEl.textContent =
    entries.length + " 节点 · " + branches + " 分支 · " + graph.lanes.length + " 泳道";
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

// 树渲染（泳道式）：entries → commitGraphLanes → 泳道定位（X=seq 轴，Y=泳道行）→ 全量渲染（去折叠后无 row<0）。
// 返回 {nodeEls, graph}：nodeEls 供连线测量，graph 供连线使用。
function historyTreeRenderTree(entries) {
  const tree = historyTreeTreeEl;
  if (!tree) return { nodeEls: new Map(), graph: null };
  tree.textContent = "";
  if (historyTreeClickTimer) { clearTimeout(historyTreeClickTimer); historyTreeClickTimer = null; } // 重渲染 → 清消歧态
  historyTreeShotsHide(); // 重渲染 → 清预览浮层（防残留）
  const sleepEl = historyTreeEl ? historyTreeEl.querySelector(".htr-sleep") : null;
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "htr-empty";
    empty.textContent = "这个工作流还没有提交记录";
    tree.appendChild(empty);
    tree.style.width = "";
    tree.style.height = "";
    if (sleepEl) sleepEl.classList.remove("htr-sleep-on");
    return { nodeEls: new Map(), graph: null };
  }
  const graph = commitGraphLanes(entries);
  const bySeq = new Map(); // seq → ent
  for (const ent of entries) {
    if (ent && ent.seq != null) bySeq.set(ent.seq, ent);
  }
  // 时间轴等距（2026-10-12 修）：每个「可见提交」占等宽一格。
  // 旧实现 X=(seq-0.5)*colW 用 seq 值定距，而 seq 因合并（mergeInto 行不生成节点）跳号
  // （实测 43 节点 seq 跨 1..144，相邻差 1~12 不等）→ 间距随序号差疏密悬殊、观感像按时间差伸缩。
  // 改：rank = 可见节点（row>=0）序号，等距铺开；折叠节点不占位（收进 +N，不撑开间距）。
  const mode = historyTreeViewGet();
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
  const colW = Math.max(28, Math.min(56, (availW - 24) / cols)); // 2026-10-14：下限 16→28（拉大列距，给跨泳道过渡留空间；面板可横滚，宽度增加可接受）
  const laneH = 36; // 泳道行高（节点加高到 22 → 相邻行仍留 ≥14px 间隙，laneH 不变）
  const nw = Math.max(5, Math.min(colW - 3, colW * 0.42)); // 2026-10-14：0.45→0.42（略瘦，多留间隙）
  const nwBulge = Math.min(nw + 10, colW - 3); // 第8条：多块更宽（+8→+10，封顶 colW-3）→ 单/多差拉大
  // 内容宽只由内容决定（cols * colW），绝不被容器宽绑架（去 maxSeq*colW / availW-4，防右侧假留白）
  const W = cols * colW;
  // 2026-10-12：内容高 = 全量泳道（rows=laneCount）；视口（.tcanvas）高封顶 ≤200，多的靠拖/滚查看。
  // .lanes 取内容全高 → 连线层（height:100%）不被截，SVG 也不再被 300×150 缺省视口裁。
  const contentH = Math.max(46, graph.rows * laneH + 6);
  const H = Math.min(200, contentH); // 视口高上限 200（面板不占满屏）
  historyTreeGeom = { colW, laneH, W, H: contentH };
  tree.style.width = W + "px";
  tree.style.height = contentH + "px";
  if (historyTreeCanvasEl) historyTreeCanvasEl.style.height = H + "px"; // 视口高封顶（内容可拖/滚）
  // 全局框列表：扫 entries 取 blocks[].name 并集（首次出现序）；空 → 每节点退化为单根色条
  const globalBlocks = [];
  const blockSeen = new Set();
  for (const ent of entries) {
    const bl = ent && Array.isArray(ent.blocks) ? ent.blocks : [];
    for (const b of bl) {
      if (!b || typeof b !== "object") continue;
      const nm = b.name == null ? "" : String(b.name);
      if (!blockSeen.has(nm)) {
        blockSeen.add(nm);
        globalBlocks.push(nm);
      }
    }
  }
  const singleBar = globalBlocks.length === 0;
  const liveColors = historyLiveBlockColors(); // 内条色 = 画布框色（整树算一次）
  // 泳道基准线（每条显示泳道一根 1px 横线）
  for (let row = 0; row < graph.rows; row += 1) {
    const ax = document.createElement("div");
    ax.className = "htr-laneaxis";
    ax.style.top = row * laneH + laneH / 2 + "px";
    tree.appendChild(ax);
  }
  const nodeEls = new Map(); // seq → 节点元素（连线测量用）
  const head = historyHeadGet();
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
    node.style.setProperty("--htr-c", srcColor); // 外框色 = 谁
    node.style.borderStyle = historyTickBorderStyle(ent && ent.kind); // 外框线型 = 操作
    const xx = xOf.get(nd.seq);
    node.style.left = ((xx == null ? 0 : xx) + 0.5) * colW + "px";
    node.style.top = nd.row * laneH + laneH / 2 + 3 + "px";
    node.style.setProperty("--nw", nw + "px");
    node.style.setProperty("--nw-bulge", nwBulge + "px"); // 第7条：多块宽（已 clamp colW-2）
    // 2026-10-14：透明热区尺寸——横向节点+12 但封顶 colW-2（防相邻重叠），纵向留 8px 行间拖动带。
    // ⚠️ 必须 clamp（下限+上限都夹）：max(baseW+12, colW-2) 在合并节点时 baseW 大会突破上限 → 盖到邻列。
    const baseW = runsN > 1 ? nwBulge : nw;
    const hotW = Math.max(8, Math.min(baseW + 12, colW - 2));
    const hotH = Math.max(16, Math.min(laneH - 8, laneH));
    node.style.setProperty("--htr-hot-w", hotW + "px");
    node.style.setProperty("--htr-hot-h", hotH + "px");
    if (colW < 14) node.dataset.tight = "1"; // 密档降级
    // 统一母题内条堆：全局框各一根；碰过的框 → 画布框色（亮），未碰 → 灰
    node.appendChild(historyBarsBuild(globalBlocks, hitSet, liveColors, singleBar));
    // ×N 徽标（合并提交；colW < 10 不渲染）
    if (runsN > 1 && colW >= 10) {
      const badge = document.createElement("span");
      badge.className = "htr-runs";
      badge.textContent = "×" + runsN;
      node.appendChild(badge);
    }
    // 悬停气泡 / 单击点选回跳（回跳链：historyBarSelection → historyRollbackConfirmOpen → historyRollbackExecute）
    node.addEventListener("mouseenter", () => historyTreeBubbleShow(node, ent));
    node.addEventListener("mouseleave", () => historyTreeBubbleHide());
    node.addEventListener("click", (ev) => historyTreeNodeClick(ev, node, ent));
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
  // 打开定位到最新（最右）
  if (historyTreeCanvasEl) historyTreeCanvasEl.scrollLeft = historyTreeCanvasEl.scrollWidth;
  historyTreeUpdateFade();
  return { nodeEls, graph };
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
  collapsed.append(sum, count, saveBtn, viewBtn, toggle);
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
  tcanvas.addEventListener(
    "wheel",
    (ev) => {
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
// 竞态：每次 refresh 递增 historyTreeReqId，回包校验，旧的作废。
async function historyTreeRefresh() {
  if (!historyTreeEl) historyTreeEnsure();
  const reqId = ++historyTreeReqId;
  let wfName = "";
  try {
    wfName = currentWorkflowInfo().name || "";
  } catch {
    wfName = "";
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
  const changed = historyTickChangedNames(ent).join("、");
  if (changed) {
    const names = document.createElement("div");
    names.textContent = changed;
    b.append(t, names);
  } else {
    b.append(t);
  }
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
    let top = tr.top - rr.top - bh - 6;
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
// nodeEls/graph 均来自 historyTreeRenderTree；rAF 等一帧布局稳定后测量。
function historyTreeDrawEdges(nodeEls, graph) {
  const tree = historyTreeTreeEl;
  if (!tree || !nodeEls || !nodeEls.size) return;
  const bySeq = new Map();
  for (const ent of historyTreeEntries) {
    if (ent && ent.seq != null) bySeq.set(ent.seq, ent);
  }
  const rowOf = new Map(); // seq → row（来自算法结果；未渲染时也能查折叠）
  if (graph && Array.isArray(graph.nodes)) {
    for (const nd of graph.nodes) if (nd) rowOf.set(nd.seq, nd.row);
  }
  // 渲染时 tree.textContent="" 已清掉旧 svg，这里新挂一层
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "htr-edges");
  tree.appendChild(svg);
  const geom = historyTreeGeom || { colW: 6, laneH: 40 };
  requestAnimationFrame(() => {
    let tr = null;
    try {
      tr = tree.getBoundingClientRect();
    } catch {
      return;
    }
    if (!tr || (!tr.width && !tr.height)) return; // 已收起 / 不可见：不画
    let d = "";
    let faded = "";
    // P8：端点从节点中心裁剪到节点外框边缘（线与节点间留缝，不再穿框/被填充盖住）。
    // rect: {l,t,r,b}（相对 tree）；从 (cx,cy) 朝 (tx,ty) 方向求与外框边界的交点。
    const trimToEdge = (rect, cx, cy, tx, ty) => {
      const dx = tx - cx;
      const dy = ty - cy;
      let t = 1;
      if (dx > 1e-6) t = Math.min(t, (rect.r - cx) / dx);
      else if (dx < -1e-6) t = Math.min(t, (rect.l - cx) / dx);
      if (dy > 1e-6) t = Math.min(t, (rect.b - cy) / dy);
      else if (dy < -1e-6) t = Math.min(t, (rect.t - cy) / dy);
      if (!isFinite(t) || t < 0) t = 0;
      return { x: cx + dx * t, y: cy + dy * t };
    };
    // 2026-10-14：跨泳道分叉错开用——按父 seq 计数（同一父的第几个跨泳道子，从 0 起）。
    const branchCount = new Map();
    for (const ent of historyTreeEntries) {
      const seq = ent && ent.seq;
      if (seq == null) continue;
      const p = ent.parent;
      if (p == null || !bySeq.has(p)) continue; // 根 / 孤儿不画
      const childEl = nodeEls.get(seq);
      const parentEl = nodeEls.get(p);
      const cRow = rowOf.get(seq);
      const pRow = rowOf.get(p);
      // 一端在折叠泳道（row=-1）→ 淡出短线（父或子自身未渲染）
      if (childEl == null || parentEl == null) {
        const visible = childEl || parentEl;
        if (!visible) continue;
        const r = rowOf.get(childEl ? p : seq);
        void r;
        let vr;
        try {
          vr = visible.getBoundingClientRect();
        } catch {
          continue;
        }
        if (!vr || !vr.width) continue;
        const vx = vr.left + vr.width / 2 - tr.left;
        const vy = vr.bottom - tr.top;
        // 折叠分支方向：子未渲染（向右分出）→ 向右短横；父未渲染（向左接入）→ 向左短横
        const dir = childEl ? -1 : 1;
        faded +=
          "M" + vx.toFixed(1) + " " + vy.toFixed(1) +
          "L" + (vx + dir * 12).toFixed(1) + " " + vy.toFixed(1);
        continue;
      }
      let cr, pr;
      try {
        cr = childEl.getBoundingClientRect();
        pr = parentEl.getBoundingClientRect();
      } catch {
        continue;
      }
      if (!cr.width || !pr.width) continue;
      const pcx = pr.left + pr.width / 2 - tr.left;
      const pcy = pr.top + pr.height / 2 - tr.top;
      const ccx = cr.left + cr.width / 2 - tr.left;
      const ccy = cr.top + cr.height / 2 - tr.top;
      const pRect = { l: pr.left - tr.left, r: pr.right - tr.left, t: pr.top - tr.top, b: pr.bottom - tr.top };
      const cRect = { l: cr.left - tr.left, r: cr.right - tr.left, t: cr.top - tr.top, b: cr.bottom - tr.top };
      const s = trimToEdge(pRect, pcx, pcy, ccx, ccy);
      const e = trimToEdge(cRect, ccx, ccy, pcx, pcy);
      const x1 = s.x;
      const y1 = s.y;
      const x2 = e.x;
      const y2 = e.y;
      if (pRow === cRow || Math.abs(y2 - y1) < 0.5) {
        // 同泳道 → 水平直线
        d += "M" + x1.toFixed(1) + " " + y1.toFixed(1) + "L" + x2.toFixed(1) + " " + y2.toFixed(1);
      } else {
        // 2026-10-14（迭代3）：固定过渡段 + 直线——过渡水平投影固定（T=16，同父多子微增 4px，封顶 dx*0.7），
        // 过渡段用三次贝塞尔（两端水平切线，平滑换道），之后纯水平直线到子左边缘 → 更干脆。
        const branchIdx = branchCount.get(p) || 0;
        branchCount.set(p, branchIdx + 1);   // 同父第几个跨泳道子（从 0 起）
        const xr = pRect.r;                  // 父右边缘
        const xl = cRect.l;                  // 子左边缘
        const dx = xl - xr;
        const T = 28;                                            // 2026-10-14：16→28（过渡更宽 → 端曲率更低、更舒展）
        const t = Math.max(2, Math.min(T + branchIdx * 4, dx * 0.72)); // 2026-10-14：0.7→0.72
        d +=
          "M" + xr.toFixed(1) + " " + pcy.toFixed(1) +
          "C" + (xr + t / 2).toFixed(1) + " " + pcy.toFixed(1) +
          " " + (xr + t / 2).toFixed(1) + " " + ccy.toFixed(1) +
          " " + (xr + t).toFixed(1) + " " + ccy.toFixed(1) +
          "L" + xl.toFixed(1) + " " + ccy.toFixed(1);
      }
    }
    let html = "";
    if (d) html += '<path d="' + d + '"/>';
    if (faded) html += '<path d="' + faded + '" opacity="0.18"/>';
    svg.innerHTML = html;
    void geom;
  });
}
// 执行期间把变更来源标为 "agent"；装载类窗口另标 "system"（见 beginSystemWindow）。
// v2（2026-10-08）追加 canvas.copilot（开关自身也是写类；拦截豁免见下）。
const WRITE_OPS = new Set([
  "canvas.loadWorkflowFile", "canvas.openWorkflow", "canvas.activateWorkflow",
  "canvas.setWidget", "canvas.addNode", "canvas.removeNode",
  "canvas.connect", "canvas.disconnect", "canvas.setNodeMode",
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
