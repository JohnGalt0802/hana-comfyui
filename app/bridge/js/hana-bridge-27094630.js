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

// 当前页面的「身份」：它打开的是哪个工作流。
// 多页面路由靠它：一个页面对应一个工作流名（对应一个 json 文件）。
function currentWorkflowInfo() {
  try {
    const wf = app.workflowManager && app.workflowManager.activeWorkflow;
    if (!wf) return { name: "(未命名)", path: null, modified: null };
    const name = String(wf.filename || wf.name || "").trim() || "(未命名)";
    return {
      name,
      path: wf.path || null,
      modified: typeof wf.isModified === "boolean" ? wf.isModified : null,
    };
  } catch {
    return { name: "(未命名)", path: null, modified: null };
  }
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

function pushUndo(label, undo) {
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
    });
  } catch (err) {
    console.warn(LOG_TAG, "状态推送失败", err);
  }
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
  "exec.running": () => ({
    runningNodeId: typeof app.runningNodeId === "number" ? app.runningNodeId : null,
    activeWorkflow:
      (app.workflowManager && app.workflowManager.activeWorkflow && app.workflowManager.activeWorkflow.name) || null,
  }),

  // 自检：一次性报出关键 API 的存在性（P0 核验用，转"推断"为"实测"）
  "api.probe": () => ({
    bridgeBuild: "2026-09-27T08:40-diag",
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

  // 接口形状探查：把 workflowManager / 命令表的真实形状报出来，
  // 目的是把"打开工作流该调哪个 API"从推断变实测。只读，不改任何状态。
  "api.diag": () => {
    const out = { href: location.href };
    const wm = app && app.workflowManager;
    if (wm) {
      const proto = Object.getPrototypeOf(wm) || {};
      const aw = wm.activeWorkflow || null;
      out.workflowManager = {
        ownKeys: Object.keys(wm).slice(0, 60),
        protoMethods: Object.getOwnPropertyNames(proto).slice(0, 80),
        activeWorkflowKeys: aw ? Object.keys(aw).slice(0, 40) : null,
        activeWorkflow: aw
          ? { name: aw.name ?? null, filename: aw.filename ?? null, path: aw.path ?? null, key: aw.key ?? null }
          : null,
      };
      try {
        const all = wm.workflows;
        if (all && typeof all[Symbol.iterator] === "function") {
          out.workflowManager.workflows = [...all].slice(0, 30).map((w) => ({
            name: (w && w.name) ?? null,
            filename: (w && w.filename) ?? null,
            path: (w && w.path) ?? null,
          }));
        } else if (all && typeof all === "object") {
          out.workflowManager.workflows = Object.keys(all).slice(0, 30);
        }
      } catch (e) { out.workflowManager.workflowsErr = String(e); }
      try {
        if (Array.isArray(wm.openWorkflows)) {
          out.workflowManager.openWorkflows = wm.openWorkflows.slice(0, 20).map((w) => (w && (w.filename || w.name)) ?? null);
        }
      } catch (e) { out.workflowManager.openWorkflowsErr = String(e); }
    }
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
    const aw = app.workflowManager && app.workflowManager.activeWorkflow;
    let dirty = false;
    try { if (aw && typeof aw.isModified === "function") dirty = !!aw.isModified(); } catch { dirty = false; }
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
    pushUndo(`setWidget #${node.id}.${a.name}`, () => {
      withChange(() => {
        w.value = restore;
        if (typeof w.callback === "function") {
          try { w.callback(restore, app.canvas, node, [0, 0], null); } catch { /* 忽略 */ }
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
    let link = null;
    withChange(() => { link = from.connect(outIdx, to, inIdx); });
    pollGraph();
    const linkId = link && link.id != null ? link.id : null;
    pushUndo(`connect #${from.id} → #${to.id}`, () => {
      if (linkId != null) withChange(() => app.graph.removeLink(linkId));
      pollGraph();
    });
    return { from: from.id, to: to.id, outSlot: outIdx, inSlot: inIdx, linkId };
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
  // 覆盖前先备份一份 <name>.bak.json（备份失败不阻断写入）。
  "canvas.save": async (args) => {
    const a = args || {};
    const wf = app.workflowManager && app.workflowManager.activeWorkflow;
    const raw = String(a.name || (wf && (wf.filename || wf.name)) || "").trim();
    if (!raw) throw new Error("无法确定工作流名：传 {name}，或先在前端打开/保存过一张工作流");
    const clean = raw.replace(/\.json$/i, "");
    const json = app.graph.toJSON();
    const body = JSON.stringify(json);
    const put = async (file) => {
      const res = await api.fetchApi(`/api/userdata/${encodeURIComponent(file)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(`${file} 写入失败：HTTP ${res.status}`);
    };
    let backup = null;
    try {
      // 路径要带 workflows/ 前缀：/api/userdata/<file> 的 <file> 是相对 user/default/ 的，
      // 不带前缀会写到 user/default/ 根下（实测踩过）。
      await put(`workflows/${clean}.bak.json`);
      backup = `workflows/${clean}.bak.json`;
    } catch { /* 备份失败不阻断主写入 */ }
    await put(`workflows/${clean}.json`);
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
};

// 诊断出口（只读）：用于确认“当前页面加载的是哪一版脚本、当前 revision 多少”。
// 只暴露版本与计数，不做任何写操作、也不抛出内部对象。
window.__hanaBridge = {
  version: "p4.0",
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
      // 页面加载后推一次基线快照（否则服务端要等到首次变化才有状态）
      void pushStateSnapshot();
      console.info(LOG_TAG + " 已挂载 clientId=" + (api.clientId || "?") + " ops=" + Object.keys(OPS).join(","));
    } catch (err) {
      console.warn(LOG_TAG, "上报失败（后端未就绪？）", err);
    }
  },
});
