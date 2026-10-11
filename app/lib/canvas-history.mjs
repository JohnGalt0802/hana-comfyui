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

// 快照结构版本（字段增删时递增，供将来迁移判断）
export const SCHEMA_VERSION = 1;
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

// ── 6. 索引行 ───────────────────────────────────────────────────────────────
/**
 * 构造一行索引元数据（JSON 字符串，**不含 graph**）。
 * 字段：seq / file（文件名）/ promptId / at / source / nodeCount / linkCount。
 * 入参兼容别名：file ← file | fileName | name。
 * @param {object} meta
 * @returns {string}
 */
export function buildIndexLine(meta = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const rawFile = m.file != null ? m.file : m.fileName != null ? m.fileName : m.name;
  return JSON.stringify({
    seq: toInt(m.seq, 0),
    file: rawFile == null ? "" : String(rawFile),
    promptId: m.promptId == null ? null : String(m.promptId),
    at: m.at == null ? null : String(m.at),
    source: normalizeSource(m.source),
    nodeCount: toInt(m.nodeCount, 0),
    linkCount: toInt(m.linkCount, 0),
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
