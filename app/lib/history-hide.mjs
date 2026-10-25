// app/lib/history-hide.mjs
// 提交树「隐藏节点」（W2 · 纯函数）
// 零副作用、不碰磁盘、不 import 除自身外任何模块。
//
// 语义定格：**短路隐藏**
//   隐藏 A 时，把 A 的所有子节点的 parent 改挂到 A 的 parent（即最近的可见祖先），
//   再把 A 从输出里剔除。
// 为什么不是「纯过滤」：真实样本（1186 行索引、182 主行）实测——
//   纯过滤会产出 2 个孤儿，泳道数 8 → 9，图断成两截；短路隐藏 0 孤儿、泳道数不变。
//
// 关键约束：回溯用的 bySeq 必须由**完整 entries**（含被隐藏项）建立，
//   否则被隐藏节点的 parent 查不到，回溯会在隐藏点断掉，子节点集体变孤儿。
//
// API：resolveVisibleParent / applyHidden / sanitizeHidden / HIDDEN_LS_PREFIX

// localStorage 键前缀：一个仓库一份（后接仓库标识），值为 seq 的 JSON 数组。
export const HIDDEN_LS_PREFIX = "hana.history.hidden.v1:";

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
export function indexBySeq(entries) {
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
export function resolveVisibleParent(seq, hiddenSet, bySeq) {
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
export function applyHidden(entries, hiddenSet) {
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

// 外部（localStorage）脏数据兜底。剔除：
//   1) entries 里不存在的 seq
//   2) 等于 headSeq 的 seq（HEAD 不允许隐藏）
//   3) 根节点（parent == null 且存在其他节点以它为 parent）——藏了会让子节点集体变孤儿
// 返回新的 Set。
export function sanitizeHidden(rawSet, entries, headSeq) {
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
