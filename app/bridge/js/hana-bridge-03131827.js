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
const BUILD_TAG = "2026-10-03 hana-bridge-03131827";

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

// 工作流是否「已修改未保存」：isModified 实测为函数；兼容布尔 getter。
function workflowDirty(wf) {
  try {
    if (!wf) return false;
    const m = wf.isModified;
    if (typeof m === "boolean") return m;
    if (typeof m === "function") return !!wf.isModified();
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
  // 返回：{ opened, matched, activeBefore, blocked? }
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
    // 不 await：loadGraphData 会等整图渲染完，节点多时远超前端 6s 回传上限。
    // 发起后立即回报，加载在后台继续。
    void Promise.resolve(app.loadGraphData(graph)).catch((e) => {
      console.warn(LOG_TAG, "loadGraphData 失败", e);
    });
    return {
      loaded: true,
      file: rel,
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : null,
      note: "已发起加载（异步），画布稍后刷新",
    };
  },

  "canvas.openWorkflow": async (args) => {
    const a = args || {};
    const target = String(a.path || a.name || "").trim();
    if (!target) throw new Error("需要 name 或 path");
    const svc = app.extensionManager && app.extensionManager.workflow;
    if (!svc || typeof svc.openWorkflow !== "function") {
      throw new Error("前端没有 workflowService.openWorkflow（版本不支持）");
    }
    // 先刷新工作流列表：前端列表在启动时加载，agent 之后新增的文件不在其中
    for (const m of ["syncWorkflows", "loadWorkflows"]) {
      try {
        if (typeof svc[m] === "function") { await svc[m](); break; }
      } catch { /* 刷新失败不阻断，下面按现有列表匹配 */ }
    }

    const aw = svc.activeWorkflow || null;
    const before = aw ? (aw.filename || aw.path || aw.name || null) : null;
    // 未保存保护：默认不抢掉人正在改的图
    let dirty = false;
    try {
      if (aw && typeof aw.isModified === "function") dirty = !!aw.isModified();
    } catch { dirty = false; }
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

    await svc.openWorkflow(hit);
    const aw2 = svc.activeWorkflow || null;
    return {
      opened: true,
      matched: (hit && (hit.path || hit.filename || hit.name)) || null,
      activeBefore: before,
      activeAfter: aw2 ? (aw2.filename || aw2.path || aw2.name || null) : null,
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
    await app.loadGraphData(state, true, true, wf); // 先按 await 实现（耗时见验收记录）
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

  // 落盘：把当前图写成工作流文件（这样即使页面没开、或换个实例，打开就能看到改动）。
  // 备份语义（2026-09-28 修正）：.bak.json = 「覆盖前的磁盘旧文件」——先读旧文件、写到 .bak，
  // 再写新文件；磁盘上没有旧文件时不写 .bak（backup=null）。备份失败不阻断主写入。
  "canvas.save": async (args) => {
    const a = args || {};
    const wf = activeWorkflowObj();
    const raw = String(a.name || (wf && (wf.filename || wf.name)) || "").trim();
    if (!raw) throw new Error("无法确定工作流名：传 {name}，或先在前端打开/保存过一张工作流");
    const clean = raw.replace(/\.json$/i, "");
    const json = app.graph.toJSON();
    const body = JSON.stringify(json);
    const put = async (file, data) => {
      const res = await api.fetchApi(`/api/userdata/${encodeURIComponent(file)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
      });
      if (!res.ok) throw new Error(`${file} 写入失败：HTTP ${res.status}`);
    };
    // 先取「覆盖前的磁盘旧文件」：有 → 写 .bak；无（404/读失败）→ 跳过 .bak
    let backup = null;
    let oldBody = null;
    try {
      // 路径要带 workflows/ 前缀：/api/userdata/<file> 的 <file> 是相对 user/default/ 的，
      // 不带前缀会写到 user/default/ 根下（实测踩过）。
      const old = await api.fetchApi(`/api/userdata/${encodeURIComponent(`workflows/${clean}.json`)}`, { cache: "no-store" });
      if (old.ok) oldBody = await old.text();
    } catch { oldBody = null; }
    if (oldBody != null) {
      try {
        await put(`workflows/${clean}.bak.json`, oldBody);
        backup = `workflows/${clean}.bak.json`;
      } catch { /* 备份失败不阻断主写入 */ }
    }
    await put(`workflows/${clean}.json`, body);
    return { saved: `workflows/${clean}.json`, backup, nodes: json.nodes ? json.nodes.length : null };
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

// 监听中继经 ComfyUI 自带 /ws 推来的指令，执行后同源回传
api.addEventListener(EVT_CALL, async (event) => {
  const msg = (event && event.detail) || {};
  let payload;
  try {
    const fn = OPS[msg.op];
    if (!fn) throw new Error("unknown op: " + msg.op);
    payload = { ok: true, data: await fn(msg.args || {}) };
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
