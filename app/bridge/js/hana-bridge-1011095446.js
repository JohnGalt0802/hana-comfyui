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
const BUILD_TAG = "2026-10-11 hana-bridge-1011095446";

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
let lastWorkflowName = null;
let changes = [];

// ── 变更来源标记（P6，2026-10-08）─────────────────────────────────────────
// 甲案口径：变更记录追加 source = "user"（默认：人在画布上的操作）/ "agent"（本桥写 op
// 执行期间）/ "system"（装载 / 重配置的异步窗口内）。只增字段，不改 rev 递增语义
// （app 侧 settle 的强证据依赖它）；工具层过滤留待后续，本期只做桥侧标记。
let changeSource = "user";

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
  // 工作流身份也算一种变化：切了/重命名了工作流，页面就该重报一次
  const wfName = currentWorkflowInfo().name;
  const wfChanged = lastWorkflowName !== null && wfName !== lastWorkflowName;
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
  lastWorkflowName = wfName;
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
    const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
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
    try {
      await app.queuePrompt(front ? -1 : 0, 1);
    } finally {
      api.queuePrompt = orig;
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

  // 落盘（P2 修复，2026-10-08）：改走前端正规保存链，目标语义＝真保存——
  //   ① 同名保存：保留 .bak 步骤 → wf.changeTracker.prepareForSave() 刷齐 → svc.saveWorkflow(wf)
  //      （store 版 → wf.save() 全链：写盘 + changeTracker.reset + isModified=false + 清 draft）；
  //   ② 另存并切换（name=新名）：svc.saveAs(wf, newPath) → adopted.load() →
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
        note: done ? "另存并切换与落盘已完成" : "另存链已发起（异步）：重绘/落盘稍后完成，按落定校验确认",
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
        void reportHistoryCommit({ graph, promptId, blocks });
      }
    } catch (err) {
      console.warn(LOG_TAG, "提交历史上报失败（不影响提交）", err);
    }
    return r;
  };
  queuePromptCaptureInstalled = true;
}

// 上报一次提交（契约字段冻结，勿改字段名）：POST /hana_bridge/history-commit
// ⚠️ P1-C2：目标改道桥 Python 后端（同源）；端点由 P1-C1 并行实现，未就绪时静默失败。
// source 恒为 "user"（前端通道都是人在点；agent 若经此通道也先记 user，后续批次再细分）。
async function reportHistoryCommit({ graph, promptId, blocks }) {
  try {
    let workflow = null;
    try {
      workflow = currentWorkflowInfo().name;
    } catch {
      workflow = null;
    }
    const body = {
      workflow,
      promptId,
      graph: graph || {},
      at: new Date().toISOString(),
      source: "user",
    };
    // P2-F2：块归属（[{name, source:"group"|"role", nodeIds:[…]}]）随快照上报；
    // 仅在算出数组时携带 —— null / 计算失败 → 不带字段（Python 端快照同样省略，读回 null）。
    if (Array.isArray(blocks)) body.blocks = blocks;
    await postJson(HISTORY_COMMIT_PATH, body);
  } catch (err) {
    // 端点由 P1-C1 实现，未就绪时静默失败。
    console.warn(LOG_TAG, "提交历史上报失败（端点由 P1-C1 实现，未就绪时静默失败）", err);
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
    rawBlocks.push({ name: dedupName(title || `组${gi + 1}`), source: "group", nodes });
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

let historyBarEl = null; // 弹层单例：null=收起
let historyBarRequestId = 0; // 竞态哨兵：切换/收起后递增，在途旧响应作废
let historyGroupClickInstalled = false; // processMouseDown 包裹幂等哨兵
// P3-G1：回跳态（卡片点选 / 最近提交基线 / 二次确认状态机）
let historyBarSelection = null; // 卡片点选的提交 {file, seq}（file 为空时按 seq 定位）
let historyBarLatestEntry = null; // 最近一次提交条目（未提交比对基线；historyBarLoad 渲染时回填）
let historyRollback = { armed: false, timer: null, busy: false };

function historyBarStyleEnsure() {
  if (document.getElementById(HISTORY_BAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HISTORY_BAR_STYLE_ID;
  style.textContent = `
#${HISTORY_BAR_ID} {
  position: fixed; z-index: 10001;
  background: rgba(28,32,39,.96); color: #fff;
  border: 1px solid rgba(255,255,255,.2); border-radius: 11px;
  box-shadow: 0 10px 32px rgba(0,0,0,.45);
  padding: 8px 10px; font-size: 12px; line-height: 1.4;
  pointer-events: auto; user-select: none;
  max-width: min(640px, calc(100vw - 16px));
}
#${HISTORY_BAR_ID} .hhb-title { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-wf { font-weight:600; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${HISTORY_BAR_ID} .hhb-count { color:#9fb3c8; }
#${HISTORY_BAR_ID} .hhb-x { margin-left:auto; background:transparent; border:0; color:#cfd8e3; font-size:14px; cursor:pointer; padding:0 4px; line-height:1; }
#${HISTORY_BAR_ID} .hhb-x:hover { color:#fff; }
#${HISTORY_BAR_ID} .hhb-cards { display:flex; gap:8px; overflow-x:auto; padding-bottom:2px; }
#${HISTORY_BAR_ID} .hhb-card { flex:none; display:flex; gap:6px; align-items:center; padding:5px 7px; border:1px solid rgba(255,255,255,.14); border-radius:8px; background:rgba(255,255,255,.04); cursor:pointer; }
#${HISTORY_BAR_ID} .hhb-card:hover { border-color:rgba(255,255,255,.35); }
#${HISTORY_BAR_ID} .hhb-card-sel { border-color:rgba(127,178,217,.9); background:rgba(127,178,217,.16); }
#${HISTORY_BAR_ID} .hhb-thumb { width:48px; height:48px; flex:none; border-radius:6px; background:#3a414b; color:#aab4c0; display:flex; align-items:center; justify-content:center; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-seq { font-weight:600; }
#${HISTORY_BAR_ID} .hhb-row { display:flex; align-items:center; gap:4px; color:#9fb3c8; font-size:11px; }
#${HISTORY_BAR_ID} .hhb-dot { width:7px; height:7px; border-radius:50%; flex:none; background:#9aa0a8; }
#${HISTORY_BAR_ID} .hhb-dot[data-src="user"] { background:#7fb2d9; }
#${HISTORY_BAR_ID} .hhb-dot[data-src="agent"] { background:#c9a0e8; }
#${HISTORY_BAR_ID} .hhb-foot { display:flex; align-items:center; gap:8px; margin-top:7px; }
#${HISTORY_BAR_ID} .hhb-roll { background:rgba(127,178,217,.15); border:1px solid rgba(127,178,217,.5); color:#cfe4f5; border-radius:7px; padding:3px 10px; cursor:pointer; font-size:12px; }
#${HISTORY_BAR_ID} .hhb-roll:hover { background:rgba(127,178,217,.28); }
#${HISTORY_BAR_ID} .hhb-roll-armed { background:rgba(232,160,160,.18); border-color:rgba(232,160,160,.75); color:#f3c6c6; }
#${HISTORY_BAR_ID} .hhb-topmsg { color:#b8e0a0; font-size:12px; margin-bottom:6px; }
#${HISTORY_BAR_ID} .hhb-msg { color:#e8c268; font-size:11px; }
#${HISTORY_BAR_ID} .hhb-empty, #${HISTORY_BAR_ID} .hhb-err { color:#9fb3c8; padding:6px 2px; }
#${HISTORY_BAR_ID} .hhb-err { color:#e8a0a0; }
`;
  document.head.appendChild(style);
}

// 收起弹层（幂等）：递增竞态哨兵作废在途 fetch 响应
function historyBarClose() {
  historyBarRequestId++;
  historyRollbackStateReset(); // P3-G1：收起 → 二次确认状态复位（规格 4）
  historyBarSelection = null;
  historyBarLatestEntry = null;
  if (historyBarEl && historyBarEl.parentElement) {
    historyBarEl.parentElement.removeChild(historyBarEl);
  }
  historyBarEl = null;
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

// group 几何中心 → 屏幕坐标（CSS px）。graph 坐标 → 画布元素 px 用 convertOffsetToCanvas
// （convertEventToCanvasOffset 的逆变换，同单位不乘 DPR）；缺失时手写同式逆变换兜底。
function historyGroupCenterScreen(group) {
  const canvas = app && app.canvas;
  const el = canvas && (canvas.canvas || canvas.canvasEl || null);
  if (!canvas || !el || !group) return null;
  const b =
    group.bounding ||
    (group.pos && group.size ? [group.pos[0], group.pos[1], group.size[0], group.size[1]] : null);
  if (!b || b[2] == null || b[3] == null) return null;
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

// 拉取并渲染提交列表（只在弹层打开时 fetch 一次；不缓存不轮询）。
// 竞态：reqId 不等于当前哨兵 → 弹层已切其他 group 或已收起，旧响应直接丢弃。
async function historyBarLoad(reqId, cards, countEl) {
  let wfName = "(未命名)";
  try {
    wfName = currentWorkflowInfo().name || wfName;
  } catch {
    /* 保持默认 */
  }
  try {
    const resp = await api.fetchApi(HISTORY_LIST_PATH + "?workflow=" + encodeURIComponent(wfName), {
      method: "GET",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || data.ok !== true) throw new Error(String((data && data.error) || "返回异常"));
    if (reqId !== historyBarRequestId) return; // 已切/已收起：作废
    const entries = Array.isArray(data.entries) ? data.entries : [];
    historyBarLatestEntry = entries.length ? entries[entries.length - 1] : null; // P3-G1：索引末条＝最近提交（比对基线）
    if (countEl) countEl.textContent = entries.length + " 条提交";
    cards.textContent = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "hhb-empty";
      empty.textContent = "这个工作流还没有提交记录";
      cards.appendChild(empty);
      return;
    }
    for (const ent of entries) {
      const seq = ent && ent.seq != null ? String(ent.seq) : "?";
      const card = document.createElement("div");
      card.className = "hhb-card";
      const thumb = document.createElement("div");
      thumb.className = "hhb-thumb";
      thumb.textContent = seq; // P4：换 .thumb.webp 真缩略图，当前灰底占位显示 seq
      const meta = document.createElement("div");
      const seqEl = document.createElement("div");
      seqEl.className = "hhb-seq";
      seqEl.textContent = "#" + seq.padStart(3, "0");
      const row = document.createElement("div");
      row.className = "hhb-row";
      const dot = document.createElement("span");
      dot.className = "hhb-dot";
      const src = String((ent && ent.source) || "unknown");
      if (src === "user" || src === "agent") dot.dataset.src = src; // unknown 走默认灰
      const time = document.createElement("span");
      time.textContent = historyFmtTime(ent && ent.at);
      row.append(dot, time);
      meta.append(seqEl, row);
      card.append(thumb, meta);
      // P3-G1：卡片可点选（选中态高亮）；换选复位二次确认状态（规格 4）
      card.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (historyRollback.busy) return;
        const file = ent && ent.file ? String(ent.file) : null;
        const seq = ent && ent.seq != null ? ent.seq : null;
        const prev = historyBarSelection;
        if (prev && prev.file === file && prev.seq === seq) return; // 重复点同一卡片
        historyRollbackBtnReset();
        historyBarSelection = { file, seq };
        cards.querySelectorAll(".hhb-card.hhb-card-sel").forEach((c) => c.classList.remove("hhb-card-sel"));
        card.classList.add("hhb-card-sel");
        historyBarTip("已选 #" + String(seq != null ? seq : "?").padStart(3, "0") + "，点「回到这一版」执行", false);
      });
      cards.appendChild(card);
    }
  } catch (err) {
    if (reqId !== historyBarRequestId) return;
    cards.textContent = "";
    const errEl = document.createElement("div");
    errEl.className = "hhb-err";
    errEl.textContent = "提交历史加载失败：" + String((err && err.message) || err);
    cards.appendChild(errEl);
    // 不抛异常：失败只落在弹层内
  }
}

// 打开弹层（重复调用=切换：先拆旧再建新）。anchor={x,y} 为屏幕 CSS px（group 几何中心）。
function historyBarOpen(anchor) {
  historyBarStyleEnsure();
  historyRollbackStateReset(); // P3-G1：切换 group → 回跳态复位（同收起语义）
  historyBarSelection = null;
  historyBarLatestEntry = null;
  if (historyBarEl && historyBarEl.parentElement) {
    historyBarEl.parentElement.removeChild(historyBarEl);
  }
  const bar = document.createElement("div");
  bar.id = HISTORY_BAR_ID;
  historyBarEl = bar;
  // 标题行：工作流名 + 提交数（fetch 后回填）+ ✕
  const title = document.createElement("div");
  title.className = "hhb-title";
  const wf = document.createElement("span");
  wf.className = "hhb-wf";
  try {
    wf.textContent = currentWorkflowInfo().name || "(未命名)";
  } catch {
    wf.textContent = "(未命名)";
  }
  wf.title = wf.textContent;
  const count = document.createElement("span");
  count.className = "hhb-count";
  count.textContent = "…";
  const x = document.createElement("button");
  x.type = "button";
  x.className = "hhb-x";
  x.textContent = "✕";
  x.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    historyBarClose();
  });
  title.append(wf, count, x);
  // 提交卡片列（横向滚动）；先放加载占位
  const cards = document.createElement("div");
  cards.className = "hhb-cards";
  const loading = document.createElement("div");
  loading.className = "hhb-empty";
  loading.textContent = "加载中…";
  cards.appendChild(loading);
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
  foot.append(roll, tip);
  bar.append(title, cards, foot);
  document.body.appendChild(bar); // position:fixed 自行定位，挂 body 避免容器裁剪
  // 锚定 group 几何中心下方，水平钳制视口；底部放不下则翻到中心上方
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  const ax = anchor ? anchor.x : vw / 2;
  const ay = anchor ? anchor.y : vh / 2;
  let left = ax - bw / 2;
  left = Math.max(8, Math.min(left, vw - bw - 8));
  let top = ay + 12;
  if (top + bh > vh - 8) top = Math.max(8, ay - bh - 12);
  bar.style.left = Math.round(left) + "px";
  bar.style.top = Math.round(top) + "px";
  // 打开时才 fetch；竞态哨兵在途响应作废
  const reqId = ++historyBarRequestId;
  void historyBarLoad(reqId, cards, count);
}

// 点击钩子（只读）：命中 group → 弹出/切换；点空白 → 收起。任何分支不改画布状态。
function historyOnCanvasMouseDown(e) {
  if (!e || (e.button !== undefined && e.button !== 0)) return; // 只响应左键；其余不干预
  const canvas = app && app.canvas;
  if (!canvas) return;
  let off = null;
  try {
    off = canvas.convertEventToCanvasOffset(e);
  } catch {
    off = null;
  }
  let group = null;
  if (off && typeof canvas.getGroupOnPos === "function") {
    try {
      group = canvas.getGroupOnPos(off[0], off[1]) || null;
    } catch {
      group = null;
    }
  }
  // 双保险：getGroupOnPos 不可用时，遍历 graph._groups 的 bounding 判定（口径同 canvas-outline.mjs）
  if (!group && off && canvas.graph && Array.isArray(canvas.graph._groups)) {
    for (const g of canvas.graph._groups) {
      const b = g && g.bounding;
      if (b && off[0] >= b[0] && off[0] <= b[0] + b[2] && off[1] >= b[1] && off[1] <= b[1] + b[3]) {
        group = g;
        break;
      }
    }
  }
  if (!group) {
    if (historyBarEl) historyBarClose(); // 点空白 → 收起
    return;
  }
  historyBarOpen(historyGroupCenterScreen(group)); // anchor 取不到时 historyBarOpen 内回退视口中心
}

// 安装 processMouseDown 包裹（幂等）。在 setup() 里调用一次。
function installHistoryGroupClick() {
  if (historyGroupClickInstalled) return;
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
  historyGroupClickInstalled = true;
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
  const qs = "?workflow=" + encodeURIComponent(currentWorkflowInfo().name || "(未命名)");
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
  let needsConfirm = true;
  try {
    const cur = historyGraphSigForCompare();
    if (!historyBarLatestEntry || historyBarLatestEntry.file == null) {
      needsConfirm = true; // 拿不到最近提交（从未提交/索引缺失）→ 宁可多问
    } else {
      const latestSnap = await historyFetchSnapshotQs(
        "?workflow=" + encodeURIComponent(currentWorkflowInfo().name || "(未命名)") +
        "&file=" + encodeURIComponent(String(historyBarLatestEntry.file)),
      );
      needsConfirm = historySnapshotsDiffer(cur, historySnapshotGraphSig(latestSnap.graph));
    }
  } catch (err) {
    console.warn(LOG_TAG, "P3-G1 未提交比对失败（按需确认处理）", err);
    needsConfirm = true;
  }
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
  if (!historyBarEl) return;
  const roll = historyBarEl.querySelector(".hhb-roll");
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
    // 成功：关弹层（规格 2）……
    historyRollback.busy = false;
    historyBarClose();
    // ……提示改挂一次性元素（弹层已拆，规格 5 的成功文案仍在弹层顶部展示 5s）。
    // 说明：historyBarTip 写在弹层内，而弹层已关；为同时满足「弹层顶部显示」与「关闭弹层」
    // 两条规格，成功提示用同一样式的独立 toast 常驻到 5s 自动消失。
    historyRollbackToast(`已回到 ${seqLabel}（此时画布未保存，保存或再提交由你决定）`);
    return;
  } catch (err) {
    console.warn(LOG_TAG, "P3-G1 回跳失败", err);
    historyRollback.busy = false;
    if (historyBarEl) {
      historyRollbackBtnReset();
      historyBarTip("回跳失败：" + String((err && err.message) || err), true);
    }
  }
}

// 成功提示（同弹层样式，顶部居中，5s 自动消失）。
function historyRollbackToast(msg) {
  try {
    const el = document.createElement("div");
    el.id = HISTORY_BAR_ID + "-toast";
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10002;" +
      "background:rgba(28,32,39,.96);color:#b8e0a0;border:1px solid rgba(255,255,255,.2);" +
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

// P6（2026-10-08）：写 op 白名单（与 app/index.js CANVAS_OPS 的 write:true 项一一对应）。
// 执行期间把变更来源标为 "agent"；装载类窗口另标 "system"（见 beginSystemWindow）。
// v2（2026-10-08）追加 canvas.copilot（开关自身也是写类；拦截豁免见下）。
const WRITE_OPS = new Set([
  "canvas.loadWorkflowFile", "canvas.openWorkflow",
  "canvas.setWidget", "canvas.addNode", "canvas.removeNode",
  "canvas.connect", "canvas.disconnect", "canvas.setNodeMode",
  "canvas.save", "canvas.undo", "canvas.patch", "canvas.organize",
  "canvas.queue", "canvas.duplicate", "canvas.visual", "canvas.copilot",
]);

// ── 副驾驶写拦截（v2 硬约束，2026-10-08）─────────────────────────────
// 写类 op 在「当前活动页副驾驶未开」时统一拒绝（{ok:false, error:"copilot_off", detail:指引}）。
// 判定实时取当前状态：关了立即恢复受限；开了立即放行。豁免名单及理由（逐条，任务书要求）：
//   · canvas.openWorkflow —— 「打开」（切前台看布）：无副驾驶画布上仅允许的两类动作之一。
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
    // P2-F1：安装画布点击命中 group 的 processMouseDown 包裹（与后端无关，先行；幂等）。
    installHistoryGroupClick();
    try {
      await postJson(PATH_HELLO, {
        clientId: api.clientId || null,
        href: location.href,
        workflow: currentWorkflowInfo(),
      });
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
