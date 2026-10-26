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
// 级联隐藏（D9 · 2026-10-26，D10 修正为「保护主干、只藏侧枝」）：隐藏一个分支起点 → 该节点的
//   **侧枝**后代一并隐藏，主干（HEAD→根的 parent 链）保留。
//   语义归属：expanded 只是「渲染期的临时扩集」，**不写回 localStorage** ——
//   用户「明确隐藏了哪些」的原始语义保持不变，恢复按原始集合操作，级联项随之一起回来。
//
// API：resolveVisibleParent / applyHidden / sanitizeHidden / mainlineSeqs / expandHiddenCascade / HIDDEN_LS_PREFIX

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

// 级联扩展（D10 · 2026-10-26 修正：保护主干，只藏侧枝）：
//   在「用户明确隐藏的集合」之上，把它的**侧枝后代**一并纳入；**主干（mainline）节点不算侧枝**。
//
// 为什么需要 mainline 保护（上一版 D9 的真 bug）：
//   上一版把「所有后代」都藏掉。主干上的分叉点一藏，HEAD 也是它的后代 → HEAD 连同整棵树几乎全消失
//   （实测 14f602c2 藏 #43 后只剩 18/128 节点，HEAD #330 不见了）。
//   John 的原意「分支泳道一并隐藏」指的是**侧枝**，不是主干。
//
// mainline 定义：从 HEAD 出发沿 parent 链上溯到根的节点集合。
//   parent 链用**全量 entries**（含 mergeInto 行）的 seq→parent 映射走 —— 否则链会停在 merge 行上而截断。
//
// 语义：
//   · 种子（用户显式隐藏的 seq）一律隐藏，即使在主干上（那是用户自己点的，A 就该消失）
//   · BFS 扩隐藏时遇 mainline 节点：**不加入、也不从它继续往下扩**（它是主干的延续，必须保留）
//   · 其余后代照旧全部加入
//   · 因此 HEAD 永远不会被级联带走；HEAD 不可被**显式**隐藏仍由 sanitizeHidden 管（不变）
//
// 返回新 Set（含全部隐藏 seq：种子 + 侧枝后代）。这里只「扩集合」，剔除 + parent 改挂交给 applyHidden。

// 主干集合：HEAD → 根 的 parent 链。visited 防环；headSeq 非法 / 不在 entries → 空集（= 不做保护）。
export function mainlineSeqs(entries, headSeq) {
  const out = new Set();
  const list = Array.isArray(entries) ? entries : [];
  if (!Number.isInteger(headSeq)) return out;
  const parentOf = new Map();
  for (const e of list) {
    if (e && Number.isInteger(e.seq)) parentOf.set(e.seq, e.parent);
  }
  if (!parentOf.has(headSeq)) return out; // HEAD 不在这份数据里
  const visited = new Set();
  let cursor = headSeq;
  for (let steps = 0; steps < MAX_WALK; steps++) {
    if (!Number.isInteger(cursor)) break;      // 到根
    if (visited.has(cursor)) break;            // 环：停
    visited.add(cursor);
    out.add(cursor);
    cursor = parentOf.has(cursor) ? parentOf.get(cursor) : null;
  }
  return out;
}

export function expandHiddenCascade(entries, hiddenSet, headSeq) {
  const out = new Set();
  if (!hiddenSet) return out;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return out;

  const mainline = mainlineSeqs(list, headSeq); // 空集 = 不做保护（headSeq 缺失）

  // parent seq → 子 seq 列表（一次建表，BFS 时 O(1) 取子）
  const childrenOf = new Map();
  for (const e of list) {
    if (!e || !Number.isInteger(e.seq)) continue;
    if (!Number.isInteger(e.parent)) continue; // 根 / 脏 parent：不会成为任何人的「子」索引键之外的情况
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

  // BFS：队列里只放「已确认隐藏」的 seq，逐个把侧枝子节点纳进来。
  // 用下标游标代替 shift，避免大数组 O(n²)。
  for (let i = 0; i < queue.length; i++) {
    const kids = childrenOf.get(queue[i]);
    if (!kids) continue;
    for (const k of kids) {
      if (visited.has(k)) continue;   // 环 / 重复边 → 只处理一次
      if (mainline.has(k)) continue;  // D10：主干节点不藏，也不从它往下扩
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
