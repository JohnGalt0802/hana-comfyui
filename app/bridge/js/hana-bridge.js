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
      await postJson(PATH_HELLO, { clientId: api.clientId || null, href: location.href });
      console.info(LOG_TAG + " 已挂载 clientId=" + (api.clientId || "?") + " ops=" + Object.keys(OPS).join(","));
    } catch (err) {
      console.warn(LOG_TAG, "上报失败（后端未就绪？）", err);
    }
  },
});
