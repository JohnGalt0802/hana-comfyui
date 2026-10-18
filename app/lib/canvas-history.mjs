// app/lib/canvas-history.mjs — 画布提交历史 P1：快照库（纯模块 · 零副作用 · 不碰磁盘）
// ─────────────────────────────────────────────────────────────────────────────
// 目标：给「每次运行工作流存一份画布快照」提供纯逻辑底座——只管命名、构造、序列化、
//   索引解析，不管 IO。app 侧（app/index.js）与中继（app/runtime/comfy-relay.mjs）两处
//   复用同一套口径，因此本模块必须**零副作用、纯函数、可用 node:test 单测**。
//
// 磁盘布局（由调用方负责，本模块只算路径/文件名）：
//   <workflowsDir>/.history/<工作流名>/
//     ├── index.jsonl             # 每行一条元数据（buildIndexLine）
//     ├── 0001-a3f9c2e1.json      # 第 1 次提交的画布快照，UI 格式 JSON（graph.serialize()）
//     └── ...
//
// 依赖口径：除 node:path 外不引入任何运行时依赖；不 import fs（本模块不碰磁盘）。
// ─────────────────────────────────────────────────────────────────────────────
import { join, resolve } from "node:path";

// 快照结构版本（字段增删时递增，供将来迁移判断）——P5 换代：1 → 2
//   v2 起索引行携带 parent/kind/sig/blocks(完整版)/delta/runs；旧条目按缺省读（normalizeEntry）。
export const SCHEMA_VERSION = 2;
// 目录/文件名段长度上限（含中文按字符数计）
export const MAX_NAME_LEN = 80;
// 净化后为空时的回退名
export const UNTITLED = "untitled";
// 剥离 base64 内嵌图时替换成的占位（保持结构、清空体积；此处取空串）
export const STRIPPED_IMAGE_PLACEHOLDER = "";

// data:image/...;base64,  开头的字符串
const BASE64_IMAGE_RE = /^data:image\/[a-z0-9.+-]*;base64,/i;
// 控制字符（C0 + DEL + C1）
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// 路径分隔符 + Windows 非法字符
const ILLEGAL_RE = /[/\\:*?"<>|]/g;
// 首尾空白与点
const EDGE_RE = /^[\s.]+|[\s.]+$/g;

const SOURCES = new Set(["user", "agent", "unknown"]);
// kind 白名单（跑出来的 / 主动存档的）；非法/缺省 → "run"
const KINDS = new Set(["run", "save"]);

/** 归一化 source：非 user/agent/unknown 一律 unknown。 */
export function normalizeSource(source) {
  return SOURCES.has(source) ? source : "unknown";
}

/** 数值安全取整（非有限值 → 0）。 */
function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ── 1. 命名 ─────────────────────────────────────────────────────────────────
/**
 * 把工作流名净化成安全的目录/文件名段：
 *   · 保留中文与常见字符；
 *   · 剔除路径分隔符（/ \ :）、Windows 非法字符（* ? " < > |）、控制字符；
 *   · 去首尾空白与点（Windows 不允许名以点/空格结尾）；
 *   · 超长截断到 MAX_NAME_LEN（80）；
 *   · 空名/纯空白/净化后为空 → "untitled"。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeWorkflowName(name) {
  let s = String(name == null ? "" : name);
  s = s.replace(CTRL_RE, "");
  s = s.replace(ILLEGAL_RE, "");
  s = s.replace(EDGE_RE, "");
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN);
  s = s.replace(EDGE_RE, "");
  return s || UNTITLED;
}

// ── 2. 目录 ─────────────────────────────────────────────────────────────────
/**
 * 历史目录绝对路径：<workflowsDir>/.history/<sanitize 后的名字>。
 * @param {string} workflowsDir
 * @param {string} workflowName
 * @returns {string}
 */
export function historyDir(workflowsDir, workflowName) {
  return resolve(join(String(workflowsDir == null ? "" : workflowsDir), ".history", sanitizeWorkflowName(workflowName)));
}

// ── 3. 文件名 ───────────────────────────────────────────────────────────────
/**
 * 快照文件名：<seq 补零到 4 位>-<promptId 前 8 位净化>.json
 *   · seq 非有限值按 0；超过 4 位不截断（自然增长）。
 *   · promptId 只取前 8 位，再剔除非字母数字；净化后为空 → "noid"。
 * @param {number} seq
 * @param {string} promptId
 * @returns {string}
 */
export function snapshotFileName(seq, promptId) {
  const head = String(toInt(seq, 0)).padStart(4, "0");
  let id = String(promptId == null ? "" : promptId).slice(0, 8).replace(/[^a-zA-Z0-9]/g, "");
  if (!id) id = "noid";
  return `${head}-${id}.json`;
}

// ── 4. 快照构造 ─────────────────────────────────────────────────────────────
/** at：缺省/空 → 当前时间 ISO；Date → toISOString()；其余原样转字符串。 */
function toIso(at) {
  if (at == null) return new Date().toISOString();
  if (at instanceof Date) return at.toISOString();
  return String(at);
}

/**
 * 构造一份快照对象（graph 原样嵌入，不做拷贝）。
 * @param {{graph?:object, promptId?:string, seq?:number, at?:string|Date, source?:string}} input
 * @returns {{schemaVersion:number, seq:number, promptId:string|null, at:string,
 *            source:string, nodeCount:number, linkCount:number, graph:object}}
 */
export function buildSnapshot({ graph, promptId = null, seq = 1, at = null, source = "unknown" } = {}) {
  const g = graph && typeof graph === "object" ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const links = Array.isArray(g.links) ? g.links : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: toInt(seq, 0),
    promptId: promptId == null ? null : String(promptId),
    at: toIso(at),
    source: normalizeSource(source),
    nodeCount: nodes.length,
    linkCount: links.length,
    graph,
  };
}

// ── 5. 剥离 base64 内嵌图 ────────────────────────────────────────────────────
/** 深拷贝 + 命中 base64 内嵌图则替换为占位；原地记录命中路径。返回新值。 */
function walkStrip(node, trail, stripped) {
  if (typeof node === "string") {
    if (BASE64_IMAGE_RE.test(node)) {
      stripped.push(trail);
      return STRIPPED_IMAGE_PLACEHOLDER;
    }
    return node;
  }
  if (Array.isArray(node)) {
    const out = new Array(node.length);
    for (let i = 0; i < node.length; i++) out[i] = walkStrip(node[i], `${trail}[${i}]`, stripped);
    return out;
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) {
      out[k] = walkStrip(node[k], trail ? `${trail}.${k}` : k, stripped);
    }
    return out;
  }
  return node; // number / boolean / null / undefined
}

/**
 * 防御性深拷贝 graph，并剥离 base64 内嵌图（data:image/...;base64,... 字符串）。
 *   · **不修改入参对象**（深拷贝）；
 *   · 命中位置的值替换为 STRIPPED_IMAGE_PLACEHOLDER（空串），保持结构不变（数组长度/键不丢）；
 *   · stripped 记录命中路径，形如 "nodes[3].widgets_values[0]"（相对 graph 根）。
 * @param {object} graph
 * @returns {{graph:object, stripped:string[]}}
 */
export function stripHeavyFields(graph) {
  const stripped = [];
  const src = graph && typeof graph === "object" ? graph : {};
  const copy = walkStrip(src, "", stripped);
  return { graph: copy, stripped };
}

// ── 5.5 归一化签名 / 画布差异 / 兼容补全（P5a）───────────────────────────────
// 与「桥 js 的 graphSignature」同族的**简化可复现版**：只看逐节点 type + widget 值，
// 不看位置/尺寸/连线细节，且跳过 seed 类 widget，用于「当前画布 vs 最近提交」的合并判定。
// 本模块与 Python 版 history_store.py 必须给出**同一串**，故哈希算法在两处逐字节对齐。

/** 是否为普通对象（非 null / 非数组）。 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── FNV-1a（32 位）稳定 hex 版 ──
// 算法（JS / Python 两侧逐字节一致）：
//   · offset basis = 2166136261（0x811c9dc5）
//   · prime        = 16777619（0x01000193）
//   · 输入先按 **UTF-8** 编码成字节序列，再逐字节：h ^= byte; h = (h * prime) mod 2^32
//   · 结果输出为 **8 位小写十六进制**（左补 0）
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** 字符串 → UTF-8 字节数组（手写，避免引入 Buffer 依赖；口径同 Python str.encode("utf-8")）。 */
function utf8Bytes(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/** FNV-1a 32 位 → 8 位小写 hex（见上方算法说明）。 */
function fnv1aHex(str) {
  const bytes = utf8Bytes(str);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 规范化取值串（跨语言一致）：null/undefined → ""；对象/数组 → 排序键的紧凑 JSON；其余 → String。 */
function canonValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return canonJson(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 紧凑规范化 JSON（对象键排序、无空格；整数值用整型串，对齐 Python 侧写法）。 */
function canonJson(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(",")}}`;
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  return "null";
}

// seed 类 widget 名（seed / noise_seed / rand_seed …）
const SEED_WIDGET_RE = /seed/i;

/** 节点 widget 段串：优先 widgets_values_named（可按名跳过 seed 类）；否则按位置 widgets_values。 */
function widgetsPart(node) {
  const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null;
  let out = "";
  if (named && Object.keys(named).length) {
    for (const k of Object.keys(named)) {
      if (SEED_WIDGET_RE.test(k)) continue;
      out += `${k}=${canonValue(named[k])};`;
    }
    return out;
  }
  const wv = node.widgets_values;
  if (Array.isArray(wv)) {
    for (let i = 0; i < wv.length; i++) out += `widget_${i}=${canonValue(wv[i])};`;
  } else if (isPlainObject(wv)) {
    for (const k of Object.keys(wv)) {
      if (SEED_WIDGET_RE.test(k)) continue;
      out += `${k}=${canonValue(wv[k])};`;
    }
  }
  return out;
}

// ── 连线端点归一化（v2 签名 / delta 共用）────────────────────────────────
// 快照 links 真实格式（2026-10-15 实测 394 份历史快照：**全部为数组数组**）：
//   [[id, origin_id, origin_slot, target_id, target_slot, type], ...]
// 对象数组格式（[{id, origin_id, origin_slot, target_id, target_slot, type}]）一并兼容。
/** 单条 link → [originId, originSlot, targetId, targetSlot] 原始 4 元组；无法解析 → null。 */
function linkEndpoint(link) {
  if (isPlainObject(link)) {
    const o = link.origin_id;
    const t = link.target_id;
    if (o === undefined || o === null || t === undefined || t === null) return null;
    return [o, link.origin_slot, t, link.target_slot];
  }
  if (Array.isArray(link) && link.length >= 5) {
    const o = link[1];
    const t = link[3];
    if (o === undefined || o === null || t === undefined || t === null) return null;
    return [o, link[2], t, link[4]];
  }
  return null;
}

/** 端点 4 元组 → 规范化端点串 `originId:originSlot>targetId:targetSlot`（跨语言一致）。 */
function endpointStr(ep) {
  return `${canonValue(ep[0])}:${canonValue(ep[1])}>${canonValue(ep[2])}:${canonValue(ep[3])}`;
}

/** 签名的连线部分：全部端点串**排序**后以 "," 拼接（不用连线条数，端点对集合敏感）。 */
function linksPart(graph) {
  const g = isPlainObject(graph) ? graph : {};
  const links = Array.isArray(g.links) ? g.links : [];
  const parts = [];
  for (const l of links) {
    const ep = linkEndpoint(l);
    if (!ep) continue;
    parts.push(endpointStr(ep));
  }
  parts.sort();
  return parts.join(",");
}

/** 槽位号归一化：null/undefined → null；整数值 → 整型；其余数值原样；非数值 → 字符串。 */
function normSlot(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isInteger(v) ? v : v;
  return v;
}

/** links → {端点串: 端点 4 元组}（首个同串为准）。 */
function linksIndex(graph) {
  const g = isPlainObject(graph) ? graph : {};
  const links = Array.isArray(g.links) ? g.links : [];
  const out = new Map();
  for (const l of links) {
    const ep = linkEndpoint(l);
    if (!ep) continue;
    const key = endpointStr(ep);
    if (!out.has(key)) out.set(key, ep);
  }
  return out;
}

/** delta 的单侧端点：{type, slot}；type = 节点 type 名，取不到则用 id 兜底。 */
function linkEnd(nodeId, slot, byId) {
  const n = byId.get(canonValue(nodeId));
  let type = isPlainObject(n) && n.type !== null && n.type !== undefined ? String(n.type) : null;
  if (type === null || type === "") type = canonValue(nodeId);
  return { type, slot: normSlot(slot) };
}

/** 端点 4 元组 → {from:{type,slot}, to:{type,slot}}。 */
function linkDesc(ep, byId) {
  return { from: linkEnd(ep[0], ep[1], byId), to: linkEnd(ep[2], ep[3], byId) };
}

/**
 * 归一化画布签名（忽略 seed 类 widget；v2 起纳入连线端点对）。
 * 口径（v2）：节点部分 = 按 `graph.nodes` 数组顺序，逐节点 `type + "|" + widget 段`，各节点段先
 * fnv1a，再以 "|" 串接；连线部分 = 全部端点串（`originId:originSlot>targetId:targetSlot`）
 * 排序后以 "," 拼接；最终 `"v2:" + fnv1a(节点部分 + "#L#" + 连线部分)`，输出 8 位小写 hex。
 * 与桥 js `graphSignature()` 同族但**更简化**（不含 mode/title/位置；不含节点 id）。
 * 口径版本前缀：旧数据无 `v2:` 前缀 → 判为不可比 → 不合并（一次性代价）。
 * @param {object} graph UI 格式画布
 * @returns {string} `v2:` + 8 位 hex
 */
export function graphSigIgnoringSeed(graph) {
  const g = isPlainObject(graph) ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const parts = [];
  for (const n of nodes) {
    if (!isPlainObject(n)) continue;
    const type = n.type == null ? "" : String(n.type);
    parts.push(fnv1aHex(`${type}|${widgetsPart(n)}`));
  }
  return `v2:${fnv1aHex(parts.join("|") + "#L#" + linksPart(g))}`;
}

/** id → 节点（跳过无 id / 非对象）。 */
function indexNodesById(graph) {
  const map = new Map();
  const g = isPlainObject(graph) ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  for (const n of nodes) {
    if (!isPlainObject(n) || n.id === undefined || n.id === null) continue;
    map.set(String(n.id), n);
  }
  return map;
}

/** 节点显示名：title 非空则用，否则 type，否则 ""。 */
function nodeTitle(n) {
  if (typeof n.title === "string" && n.title) return n.title;
  return n.type == null ? "" : String(n.type);
}

/** 节点 widget 名/值对（named 优先命名，否则位置命名 widget_<i>）。 */
function widgetEntries(node) {
  const named = isPlainObject(node.widgets_values_named) ? node.widgets_values_named : null;
  const wv = node.widgets_values;
  if (Array.isArray(wv)) return { names: named ? Object.keys(named) : null, values: wv };
  if (isPlainObject(wv)) {
    const keys = Object.keys(wv);
    return { names: keys, values: keys.map((k) => wv[k]) };
  }
  if (named) {
    const keys = Object.keys(named);
    return { names: keys, values: keys.map((k) => named[k]) };
  }
  return { names: null, values: [] };
}

/** 同 id 两节点的 widget 变化名列表（逐项比较位置值；缺失项按 "" 参与比较）。 */
function changedWidgetNames(a, b) {
  const ea = widgetEntries(a);
  const eb = widgetEntries(b);
  const n = Math.max(ea.values.length, eb.values.length);
  const fields = [];
  for (let i = 0; i < n; i++) {
    const va = i < ea.values.length ? ea.values[i] : undefined;
    const vb = i < eb.values.length ? eb.values[i] : undefined;
    if (canonValue(va) !== canonValue(vb)) {
      fields.push((ea.names && ea.names[i]) || (eb.names && eb.names[i]) || `widget_${i}`);
    }
  }
  return fields;
}

/** id 排序：两数按数值，否则按字符串（对齐 Python 侧）。 */
function cmpId(a, b) {
  const na = typeof a === "number";
  const nb = typeof b === "number";
  if (na && nb) return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * 对比两画布（UI 格式），相对 prev 算四类变化（节点三类 + 连线一类）。
 * @param {object} prevGraph 父画布（null/非法 → 返回 null）
 * @param {object} nextGraph 本画布
 * @returns {{changed:{id:*,title:string,fields:string[]}[], added:{id:*,title:string}[], removed:{id:*,title:string}[], links:{added:{from:{type:string,slot:*},to:{type:string,slot:*}}[], removed:{from:{type:string,slot:*},to:{type:string,slot:*}}[]}}|null}
 */
export function computeDelta(prevGraph, nextGraph) {
  if (!isPlainObject(prevGraph)) return null;
  const prev = indexNodesById(prevGraph);
  const next = indexNodesById(nextGraph);
  const linkPrev = linksIndex(prevGraph);
  const linkNext = linksIndex(nextGraph);
  const linksAddedKeys = [];
  const linksRemovedKeys = [];
  for (const k of linkNext.keys()) if (!linkPrev.has(k)) linksAddedKeys.push(k);
  for (const k of linkPrev.keys()) if (!linkNext.has(k)) linksRemovedKeys.push(k);
  linksAddedKeys.sort();
  linksRemovedKeys.sort();
  const added = [];
  const removed = [];
  for (const [id, n] of next) if (!prev.has(id)) added.push({ id: n.id, title: nodeTitle(n) });
  for (const [id, n] of prev) if (!next.has(id)) removed.push({ id: n.id, title: nodeTitle(n) });
  const changed = [];
  for (const [id, a] of prev) {
    const b = next.get(id);
    if (!b) continue;
    const fields = [];
    const ta = a.type == null ? "" : String(a.type);
    const tb = b.type == null ? "" : String(b.type);
    if (ta !== tb) fields.push("type");
    for (const name of changedWidgetNames(a, b)) fields.push(name);
    if (fields.length) changed.push({ id: b.id, title: nodeTitle(b), fields });
  }
  added.sort((x, y) => cmpId(x.id, y.id));
  removed.sort((x, y) => cmpId(x.id, y.id));
  changed.sort((x, y) => cmpId(x.id, y.id));
  return {
    changed,
    added,
    removed,
    links: {
      added: linksAddedKeys.map((k) => linkDesc(linkNext.get(k), next)),
      removed: linksRemovedKeys.map((k) => linkDesc(linkPrev.get(k), prev)),
    },
  };
}

/**
 * 合并判定辅助（纯比较）：两侧签名串相等即 true（供桥侧调用）。
 * 非字符串一律 false；空串相等亦返回 true（调用方应传真实 sig，非缺省空串）。
 * 规格 §2.6 的完整判定（当前画布 sig vs 最近节点 sig）在桥侧做，本层只提供这一比较与 graphSigIgnoringSeed。
 * @param {string} newSig
 * @param {string} headSig
 * @returns {boolean}
 */
export function shouldMergeWithHead(newSig, headSig) {
  return typeof newSig === "string" && typeof headSig === "string" && newSig === headSig;
}

/** 归一化 kind：白名单 run/save，非法/缺省 → "run"。 */
function normKind(k) {
  return KINDS.has(k) ? k : "run";
}

/** 归一化 parent：有限数 → 整数；其余（含 null/""）→ null。 */
function normParent(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 归一化 images：[{filename,subfolder,type}]（缺省空串）。 */
function normImages(imgs) {
  if (!Array.isArray(imgs)) return [];
  const out = [];
  for (const im of imgs) {
    if (!isPlainObject(im)) continue;
    out.push({
      filename: im.filename == null ? "" : String(im.filename),
      subfolder: im.subfolder == null ? "" : String(im.subfolder),
      type: im.type == null ? "" : String(im.type),
    });
  }
  return out;
}

/** 归一化 runs：[{promptId, at, images}]。 */
function normRuns(runs) {
  if (!Array.isArray(runs)) return [];
  const out = [];
  for (const r of runs) {
    if (!isPlainObject(r)) continue;
    out.push({
      promptId: r.promptId == null ? null : String(r.promptId),
      at: r.at == null ? null : String(r.at),
      images: normImages(r.images),
    });
  }
  return out;
}

/** 归一化 block（完整版）：{name, source, nodeIds}；source 缺省 "group"，nodeIds 缺省 []。 */
function normBlock(blk) {
  const b = isPlainObject(blk) ? blk : {};
  const src = typeof b.source === "string" && b.source ? b.source : "group";
  return {
    name: b.name == null ? "" : String(b.name),
    source: src,
    nodeIds: Array.isArray(b.nodeIds) ? b.nodeIds.slice() : [],
  };
}

/** 归一化 blocks：非数组 → []；逐块补全 name/source/nodeIds（非对象块剔除）。 */
function normBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const blk of blocks) {
    if (!isPlainObject(blk)) continue;
    out.push(normBlock(blk));
  }
  return out;
}

// ── 6. 索引行 ───────────────────────────────────────────────────────────────
/**
 * 构造一行索引元数据（JSON 字符串，**不含 graph**）。
 * 字段（P5 v2）：seq / parent / file / promptId / at / source / kind /
 *   nodeCount / linkCount / sig / blocks(完整版) / delta / runs。
 * 入参兼容别名：file ← file | fileName | name。
 * 缺省：parent→null；kind→"run"；sig→""；blocks→[]；delta→null；runs→[]。
 * @param {object} meta
 * @returns {string}
 */
export function buildIndexLine(meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const rawFile = m.file != null ? m.file : m.fileName != null ? m.fileName : m.name;
  return JSON.stringify({
    seq: toInt(m.seq, 0),
    parent: normParent(m.parent),
    file: rawFile == null ? "" : String(rawFile),
    promptId: m.promptId == null ? null : String(m.promptId),
    at: m.at == null ? null : String(m.at),
    source: normalizeSource(m.source),
    kind: normKind(m.kind),
    nodeCount: toInt(m.nodeCount, 0),
    linkCount: toInt(m.linkCount, 0),
    sig: typeof m.sig === "string" ? m.sig : "",
    blocks: normBlocks(m.blocks),
    delta: isPlainObject(m.delta) ? m.delta : null,
    runs: normRuns(m.runs),
  });
}

// ── 7. 索引解析 ─────────────────────────────────────────────────────────────
/**
 * 容错解析 JSONL 索引：
 *   · 空行（含纯空白）跳过，不计入 badLines；
 *   · 坏行（JSON 解析失败，或解析出来不是对象）计入 badLines，不抛异常；
 *   · 缺字段的行照样进 entries（本模块不校验字段完整性）。
 * @param {string} text
 * @returns {{entries:object[], badLines:{line:number, text:string, error:string}[]}}
 */
export function parseIndex(text) {
  const entries = [];
  const badLines = [];
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch (e) {
      badLines.push({ line: i + 1, text: line, error: String((e && e.message) || e) });
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) entries.push(v);
    else badLines.push({ line: i + 1, text: line, error: "not-an-object" });
  }
  return { entries, badLines };
}

/**
 * 兼容补全：把旧条目（缺新字段）读成新形态，**不改写磁盘**、不改入参。
 * 缺省：parent→null；kind→"run"；sig→""；delta→null；blocks→[]；
 *   runs → 缺则用顶层 promptId/at 造单元素 runs（promptId 为 null 时 → []）。
 * @param {object} entry
 * @returns {object}
 */
export function normalizeEntry(entry) {
  const e = isPlainObject(entry) ? entry : {};
  const out = { ...e };
  out.parent = normParent(e.parent);
  out.kind = normKind(e.kind);
  out.sig = typeof e.sig === "string" ? e.sig : "";
  out.delta = isPlainObject(e.delta) ? e.delta : null;
  out.blocks = normBlocks(e.blocks);
  out.runs = Array.isArray(e.runs)
    ? normRuns(e.runs)
    : e.promptId == null
      ? []
      : [{ promptId: String(e.promptId), at: e.at == null ? null : String(e.at), images: [] }];
  return out;
}

// ── 8. 序号 ─────────────────────────────────────────────────────────────────
/**
 * 下一个序号：entries 为空（或无有效 seq）→ 1；否则 max(seq)+1。
 * 只统计有限数值 seq，坏行的非法 seq 忽略。
 * @param {object[]} entries
 * @returns {number}
 */
export function nextSeq(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let max = 0;
  let seen = false;
  for (const e of list) {
    const n = e && typeof e === "object" ? Number(e.seq) : NaN;
    if (Number.isFinite(n)) {
      seen = true;
      if (n > max) max = n;
    }
  }
  return seen ? Math.trunc(max) + 1 : 1;
}

// ── 9. 最新一条 ─────────────────────────────────────────────────────────────
/**
 * 最后一条 entry（按索引顺序，即最新）；空 → null。
 * @param {object[]} entries
 * @returns {object|null}
 */
export function latestEntry(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.length ? list[list.length - 1] : null;
}
