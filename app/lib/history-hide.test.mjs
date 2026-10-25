// app/lib/history-hide.test.mjs
// 断言口径：短路隐藏（见 history-hide.mjs 头注释）
//   隐藏 A → A 的子节点 parent 改挂到 A 的 parent，A 剔除；输出 0 孤儿。
// 风格对齐 commit-graph-lanes.test.mjs：node:test + node:assert/strict。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVisibleParent,
  applyHidden,
  sanitizeHidden,
  indexBySeq,
  HIDDEN_LS_PREFIX,
} from "./history-hide.mjs";
import { commitGraphLanes } from "./commit-graph-lanes.mjs";

// 线性链 1→2→…→n（parent = seq - 1，首项 parent = null）
const linear = (n) => {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ seq: i, parent: i === 1 ? null : i - 1 });
  return out;
};

// 孤儿数：parent 非 null 但指向的 seq 不在可见集合里
const orphanCount = (visible) => {
  const set = new Set(visible.map((e) => e.seq));
  return visible.filter((e) => e.parent !== null && !set.has(e.parent)).length;
};

const parentOf = (visible, seq) => visible.find((e) => e.seq === seq).parent;

test("1. 线性链 1→2→3→4 隐藏 2 → 3.parent = 1，0 孤儿", () => {
  const entries = linear(4);
  const bySeq = indexBySeq(entries);
  assert.equal(resolveVisibleParent(3, new Set([2]), bySeq), 1);
  const visible = applyHidden(entries, new Set([2]));
  assert.deepEqual(visible.map((e) => e.seq), [1, 3, 4]);
  assert.equal(parentOf(visible, 3), 1);
  assert.equal(parentOf(visible, 4), 3);
  assert.equal(orphanCount(visible), 0);
});

test("2. 连续隐藏 2 和 3（级联）→ 4.parent = 1", () => {
  const entries = linear(4);
  const bySeq = indexBySeq(entries);
  assert.equal(resolveVisibleParent(4, new Set([2, 3]), bySeq), 1);
  const visible = applyHidden(entries, new Set([2, 3]));
  assert.deepEqual(visible.map((e) => e.seq), [1, 4]);
  assert.equal(parentOf(visible, 4), 1);
  assert.equal(orphanCount(visible), 0);
});

test("3. 隐藏叶子 → 只少 1 个节点，其他 parent 不变", () => {
  const entries = linear(4);
  const visible = applyHidden(entries, new Set([4]));
  assert.deepEqual(visible.map((e) => e.seq), [1, 2, 3]);
  assert.equal(parentOf(visible, 2), 1);
  assert.equal(parentOf(visible, 3), 2);
  assert.equal(orphanCount(visible), 0);
  assert.equal(visible.length, entries.length - 1);
});

test("4. 隐藏有 2 个子节点的节点 → 两个子都挂到其父", () => {
  // 1 ← 2 ← {3, 4}；隐藏 2
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
    { seq: 4, parent: 2 },
  ];
  const visible = applyHidden(entries, new Set([2]));
  assert.deepEqual(visible.map((e) => e.seq), [1, 3, 4]);
  assert.equal(parentOf(visible, 3), 1);
  assert.equal(parentOf(visible, 4), 1);
  assert.equal(orphanCount(visible), 0);
});

test("5. 隐藏根 → 子节点 parent 变 null（预期行为）；sanitizeHidden 把根剔除", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
  ];
  const bySeq = indexBySeq(entries);
  assert.equal(resolveVisibleParent(2, new Set([1]), bySeq), null);
  const visible = applyHidden(entries, new Set([1]));
  assert.deepEqual(visible.map((e) => e.seq), [2, 3]);
  assert.equal(parentOf(visible, 2), null); // 子节点失去父 → 视同新的根
  // 但脏数据入口会拦住它：根节点不许进隐藏集合
  const clean = sanitizeHidden(new Set([1, 2]), entries, 3);
  assert.deepEqual([...clean], [2]);
  assert.equal(clean.has(1), false);
});

test("6. 隐藏 HEAD → sanitizeHidden 剔除；不存在的 seq 也剔除", () => {
  const entries = linear(4);
  const headSeq = 4;
  const clean = sanitizeHidden(new Set([2, 4, 99]), entries, headSeq);
  assert.deepEqual([...clean], [2]);
  assert.equal(clean.has(4), false, "HEAD 不允许隐藏");
  assert.equal(clean.has(99), false, "entries 里不存在");
  // 兜底后 applyHidden 绝不会把 HEAD 剔掉
  const visible = applyHidden(entries, clean);
  assert.ok(visible.some((e) => e.seq === headSeq));
  assert.equal(orphanCount(visible), 0);
});

test("7. 环数据（1.parent=2, 2.parent=1）→ resolveVisibleParent 不死循环，返回 null", () => {
  const entries = [
    { seq: 1, parent: 2 },
    { seq: 2, parent: 1 },
  ];
  const bySeq = indexBySeq(entries);
  // 只藏 2：1 回溯到 2（隐藏）→ 2.parent=1 → 回到自身 → 判环
  assert.equal(resolveVisibleParent(1, new Set([2]), bySeq), null);
  // 两个都藏：谁也找不到可见祖先
  assert.equal(resolveVisibleParent(1, new Set([1, 2]), bySeq), null);
  assert.equal(resolveVisibleParent(2, new Set([1, 2]), bySeq), null);
  // 自指环
  const self = new Map([[5, { seq: 5, parent: 5 }]]);
  assert.equal(resolveVisibleParent(5, new Set([5]), self), null);
  // 入口不崩、applyHidden 有界返回
  assert.doesNotThrow(() => applyHidden(entries, new Set([1, 2])));
  assert.deepEqual(applyHidden(entries, new Set([1, 2])), []);
});

test("8. applyHidden 不修改入参（原对象 parent 保持原值）", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
    { seq: 4, parent: 3 },
  ];
  const snapshot = entries.map((e) => ({ ...e }));
  const visible = applyHidden(entries, new Set([2, 3]));
  assert.equal(parentOf(visible, 4), 1);              // 输出已改挂
  assert.deepEqual(entries, snapshot);                // 入参原封不动
  assert.equal(entries[2].parent, 2, "被隐藏项 3 的 parent 仍是 2");
  assert.equal(entries[3].parent, 3, "项 4 的 parent 仍是 3");
  assert.notEqual(visible[1], entries[3], "输出应为浅拷贝新对象");
});

test("9. 隐藏后接 commitGraphLanes → 孤儿数 0，泳道数不增", () => {
  // 4 泳道样本：根 1 分三支，各自延续
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
    { seq: 4, parent: 1 },
    { seq: 5, parent: 2 },
    { seq: 6, parent: 3 },
    { seq: 7, parent: 4 },
    { seq: 8, parent: 5 },
  ];
  const before = commitGraphLanes(entries);
  const visible = applyHidden(entries, new Set([2, 3, 5])); // 藏中间节点（2、3 各有子，5 有子）
  const after = commitGraphLanes(visible);
  assert.equal(orphanCount(visible), 0);
  assert.equal(after.nodes.length, visible.length);
  assert.equal(after.rows, before.rows, `泳道数应保持 ${before.rows}，实际 ${after.rows}`);
  // 每条父子边在结果图里都成立（parent 存在于可见集合）
  for (const e of visible) {
    if (e.parent === null) continue;
    assert.ok(visible.some((v) => v.seq === e.parent), `seq ${e.seq} 的 parent ${e.parent} 不可见`);
  }
});

test("10. 隐藏全部非根 → 只剩根，0 孤儿", () => {
  const entries = linear(5);
  const visible = applyHidden(entries, new Set([2, 3, 4, 5]));
  assert.deepEqual(visible.map((e) => e.seq), [1]);
  assert.equal(visible[0].parent, null);
  assert.equal(orphanCount(visible), 0);
});

test("11. 链断 / parent 缺失 / 非整数 parent → 回溯返回 null，不抛异常", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 7, parent: 99 },   // 孤儿：99 不存在
    { seq: 8 },               // 缺 parent
    { seq: 9, parent: 1.5 },  // 非整数 parent
  ];
  const bySeq = indexBySeq(entries);
  assert.equal(resolveVisibleParent(7, new Set(), bySeq), 99); // 不隐藏时原样返回 parent
  assert.equal(resolveVisibleParent(7, new Set([99]), bySeq), null); // 藏了不存在的父 → null
  assert.equal(resolveVisibleParent(8, new Set(), bySeq), null);
  assert.equal(resolveVisibleParent(9, new Set(), bySeq), null);
  assert.equal(resolveVisibleParent(12345, new Set(), bySeq), null); // seq 不在 bySeq
  const visible = applyHidden(entries, new Set());
  assert.deepEqual(visible.map((e) => e.seq), [1, 2, 7, 8, 9]);
  // 空集合 = 恒等映射
  // parent 一律经 resolveVisibleParent 归一化：缺失 / 非整数 → null（不是 undefined / 1.5）
  assert.deepEqual(visible.map((e) => e.parent), [null, 1, 99, null, null]);
  // 归一化只作用于输出拷贝，入参仍是原值
  assert.equal(entries[3].parent, undefined);
  assert.equal(entries[4].parent, 1.5);
});

test("12. 空 / null 输入、常量导出", () => {
  assert.deepEqual(applyHidden([], new Set([1])), []);
  assert.deepEqual(applyHidden(null, new Set([1])), []);
  assert.deepEqual([...sanitizeHidden(null, linear(3), 3)], []);
  assert.deepEqual([...sanitizeHidden(new Set(), linear(3), 3)], []);
  assert.equal(typeof HIDDEN_LS_PREFIX, "string");
  assert.equal(HIDDEN_LS_PREFIX, "hana.history.hidden.v1:");
});
