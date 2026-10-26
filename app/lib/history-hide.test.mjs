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
  mainlineSeqs,
  expandHiddenCascade,
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

// ── D9 / D10（2026-10-26）：级联隐藏（D10 = 保护主干，只藏侧枝）───────────
// 语义：隐藏一个节点 → 它的**侧枝**后代一并隐藏；主干（HEAD→根）保留。
// 约束：扩集只是渲染期临时集，**不写回 localStorage**；HEAD / 根仍只由 sanitizeHidden 管。
// 注意：headSeq 缺省（不传 / 非整数）→ mainline 为空集 → 退化为「藏所有后代」（D9 旧行为），
//       只为兼容旧调用；桥内三处调用一律传 headSeq。
const sorted = (set) => [...set].sort((a, b) => a - b);

// 主分支结构：主干 1←2←3←4（HEAD=4），2 上挂侧枝 5←6，4 上挂侧枝 7
//   1 ← 2 ← 3 ← 4(HEAD)
//       ↳ 5 ← 6      ↳ 7
const mainTree = () => [
  { seq: 1, parent: null },
  { seq: 2, parent: 1 },
  { seq: 3, parent: 2 },
  { seq: 4, parent: 3 },
  { seq: 5, parent: 2 },
  { seq: 6, parent: 5 },
  { seq: 7, parent: 4 },
];

test("13. 级联（主干保护）：隐藏主干中间节点 → 它消失、主干后续保留、侧枝全消失", () => {
  const entries = mainTree();
  // mainline = {4,3,2,1}
  assert.deepEqual(sorted(mainlineSeqs(entries, 4)), [1, 2, 3, 4]);
  // 藏 2：种子 2 藏；子 3 在主干上 → 保留且不往下扩；子 5 是侧枝 → 带 6
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([2]), 4)), [2, 5, 6]);
  const visible = applyHidden(entries, expandHiddenCascade(entries, new Set([2]), 4));
  // 主干 1、3、4 全在；3 的 parent 短路改挂到 1
  assert.deepEqual(visible.map((e) => e.seq), [1, 3, 4, 7]);
  assert.equal(parentOf(visible, 3), 1, "3 接到隐藏点之前的 1");
  assert.equal(parentOf(visible, 4), 3);
  assert.equal(orphanCount(visible), 0);
  // HEAD 必须还在
  assert.ok(visible.some((e) => e.seq === 4), "HEAD 一定还在可见集里");
});

test("14. 级联（主干保护）：链式 A→B→C 里隐藏 A —— A 之后的主干全保留", () => {
  const entries = linear(4); // 1→2→3→4，HEAD=4
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([1]), 4)), [1]);
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([2]), 4)), [2]);
  // 后接 applyHidden：只剩 2、3、4（2 成为新的根，parent=null）
  const visible = applyHidden(entries, expandHiddenCascade(entries, new Set([1]), 4));
  assert.deepEqual(visible.map((e) => e.seq), [2, 3, 4]);
  assert.equal(parentOf(visible, 2), null);
  assert.equal(orphanCount(visible), 0);
  assert.ok(visible.some((e) => e.seq === 4), "HEAD 一定还在");
  // 退化路径（不传 headSeq）= D9 旧行为：藏所有后代
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([1]))), [1, 2, 3, 4]);
});

test("15. 级联（主干保护）：A→B、A→C，隐藏 A → 非主干的那个分支没，主干分支还在", () => {
  // 1 ← {2, 3(HEAD)}
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
  ];
  assert.deepEqual(sorted(mainlineSeqs(entries, 3)), [1, 3]);
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([1]), 3)), [1, 2]);
  const visible = applyHidden(entries, expandHiddenCascade(entries, new Set([1]), 3));
  assert.deepEqual(visible.map((e) => e.seq), [3]);
});

test("16. 级联：隐藏叶子 → 只有它自己；隐藏 HEAD（若有侧枝）会带走侧枝", () => {
  const entries = mainTree();
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([6]), 4)), [6]); // 侧枝叶
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([7]), 4)), [7]); // 侧枝叶（挂在 HEAD 上）
  // 4 是 HEAD、也挂着侧枝 7：藏它（现实中被 sanitizeHidden 拦住）→ 侧枝 7 一并藏（主干保护不会扩，7 不是主干）
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([4]), 4)), [4, 7]);
  assert.deepEqual([...expandHiddenCascade(entries, new Set(), 4)], []);
});

test("17. 级联：隐藏侧枝节点 → 主干一个节点都不少", () => {
  const entries = mainTree();
  // 藏侧枝 5：带走 6；主干 {1,2,3,4} 一个不少
  const expanded = expandHiddenCascade(entries, new Set([5]), 4);
  assert.deepEqual(sorted(expanded), [5, 6]);
  const visible = applyHidden(entries, expanded);
  for (const s of [1, 2, 3, 4]) assert.ok(visible.some((e) => e.seq === s), `主干 #${s} 不得被隐藏`);
  assert.equal(visible.length, entries.length - expanded.size);
  // 藏主干上的侧枝入口 2 → 侧枝 5、6 一起没，但 3（主干）保留
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([2]), 4)), [2, 5, 6]);
});

test("18. 级联：parent 指向 mergeInto 行（merge 行在 entries 里）→ 不崩，侧枝照样收", () => {
  // 主干：1 ← 2 ← 3(mergeInto=2) ← 4(HEAD)；侧枝挂在 merge 行 3 上：5 ← 6
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2, mergeInto: 2 },
    { seq: 4, parent: 3 },
    { seq: 5, parent: 3 },
    { seq: 6, parent: 5 },
  ];
  assert.deepEqual(sorted(mainlineSeqs(entries, 4)), [1, 2, 3, 4]);
  // 藏 3（merge 行）：子 4 是主干→保留，子 5 是侧枝→带 6
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([3]), 4)), [3, 5, 6]);
  // 藏 4（HEAD）：只有它自己
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([4]), 4)), [4]);
  // 藏侧枝叶 6：只有它自己
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([6]), 4)), [6]);
});

test("19. 级联：parent 指向不存在的 seq → 不崩", () => {
  // 主干 1 ← 2(HEAD)；孤儿 7 的 parent 指向不存在的 99
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 7, parent: 99 },
  ];
  assert.doesNotThrow(() => expandHiddenCascade(entries, new Set([7]), 2));
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([7]), 2)), [7]);
  // 藏不存在的 99：本函数不剔除，7 作为它的子被级联进来（7 不在主干上）
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([99]), 2)), [7, 99]);
  // HEAD 不在 entries 里 → mainline 为空 → 退化但不崩
  assert.deepEqual(sorted(mainlineSeqs(entries, 999)), []);
});

test("20. 级联：环数据（A→B→A）不死循环", () => {
  const entries = [
    { seq: 1, parent: 2 },
    { seq: 2, parent: 1 },
  ];
  // 环里两个都是 mainline（HEAD=1：1→2→1 命中 visited 停）
  assert.deepEqual(sorted(mainlineSeqs(entries, 1)), [1, 2]);
  // 种子一律藏；子 2 在主干上 → 不扩
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([1]), 1)), [1]);
  // 无 headSeq → 退化到 D9 行为（两个都藏）
  assert.deepEqual(sorted(expandHiddenCascade(entries, new Set([1]))), [1, 2]);
  assert.doesNotThrow(() => expandHiddenCascade(entries, new Set([1]), 1));
  // 自指：mainline 只含自己；子表里 5 的 parent=5，起点 5 是 mainline → 不扩
  const self = [{ seq: 5, parent: 5 }];
  assert.deepEqual(sorted(mainlineSeqs(self, 5)), [5]);
  assert.deepEqual(sorted(expandHiddenCascade(self, new Set([5]), 5)), [5]);
  // 空 / null 入参
  assert.deepEqual([...expandHiddenCascade(null, new Set([1]), 1)], []);
  assert.deepEqual([...expandHiddenCascade(linear(3), null, 3)], []);
  assert.deepEqual([...mainlineSeqs(null, 1)], []);
  assert.deepEqual([...mainlineSeqs(linear(3), null)], []);
});

test("21. 级联：HEAD / 根被 sanitize 剔除后不会再被加回来；不写回原始集合", () => {
  const entries = [
    { seq: 1, parent: null }, // 根
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
    { seq: 4, parent: 3 },    // HEAD
  ];
  const raw = new Set([1, 2, 4]); // 脏数据：根 + HEAD 都标了隐藏
  const clean = sanitizeHidden(raw, entries, 4);
  assert.deepEqual([...clean], [2]); // 只剩合法的显式隐藏项
  // D10：主干 4→3→2→1，藏 2 时子 3 在主干上 → 不扩 → HEAD 不会被级联带走
  const expanded = expandHiddenCascade(entries, clean, 4);
  assert.deepEqual(sorted(expanded), [2]);
  assert.equal(expanded.has(4), false, "HEAD 不得被级联带走");
  assert.equal(expanded.has(1), false, "根不会被级联加回来");
  // 级联不修改入参集合（localStorage 只存用户明确隐藏的那一份）
  assert.deepEqual([...clean], [2]);
  assert.deepEqual([...raw].sort((a, b) => a - b), [1, 2, 4]);
  // 空 clean → 空 expanded（无隐藏时不得扩出任何东西，记号才不会误亮）
  assert.equal(expandHiddenCascade(entries, new Set(), 4).size, 0);
});

test("22. 主干保护核心断言：任意主干节点被藏，HEAD 都仍在可见集里", () => {
  const entries = mainTree(); // 主干 1←2←3←4(HEAD)，侧枝 2↳5←6、4↳7
  for (const hide of [2, 3]) {
    // 1 = 根（sanitizeHidden 拦住）、 4 = HEAD（同），故循环只用中间主干节点
    const clean = sanitizeHidden(new Set([hide]), entries, 4);
    assert.equal(clean.has(hide), true, `#${hide} 应当可以显式隐藏`);
    const expanded = expandHiddenCascade(entries, clean, 4);
    const visible = applyHidden(entries, expanded);
    assert.ok(visible.some((e) => e.seq === 4), `藏 #${hide} 后 HEAD 必须还在可见集`);
    assert.equal(orphanCount(visible), 0, `藏 #${hide} 后不得有孤儿`);
  }
  // 反向：sanitizeHidden 拦住显式隐藏 HEAD / 根，级联也就没机会带走 HEAD
  assert.equal(sanitizeHidden(new Set([4]), entries, 4).size, 0);
  assert.equal(sanitizeHidden(new Set([1]), entries, 4).size, 0);
});

test("23. 主干保护：藏主干分叉点只伤侧枝，泳道数下降但不崩", () => {
  // 两条侧枝加一条主干
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },   // 主干
    { seq: 4, parent: 3 },   // 主干
    { seq: 5, parent: 3 },   // 侧枝 A
    { seq: 6, parent: 5 },
    { seq: 7, parent: 3 },   // 侧枝 B
  ];
  const before = commitGraphLanes(entries);
  const expanded = expandHiddenCascade(entries, new Set([3]), 4);
  assert.deepEqual(sorted(expanded), [3, 5, 6, 7]);
  const visible = applyHidden(entries, expanded);
  assert.deepEqual(visible.map((e) => e.seq), [1, 2, 4]);
  assert.equal(orphanCount(visible), 0);
  const after = commitGraphLanes(visible);
  assert.equal(after.nodes.length, visible.length);
  assert.ok(after.lanes.length <= before.lanes.length, `泳道数不得增加：${before.lanes.length}→${after.lanes.length}`);
});

test("12. 空 / null 输入、常量导出", () => {
  assert.deepEqual(applyHidden([], new Set([1])), []);
  assert.deepEqual(applyHidden(null, new Set([1])), []);
  assert.deepEqual([...sanitizeHidden(null, linear(3), 3)], []);
  assert.deepEqual([...sanitizeHidden(new Set(), linear(3), 3)], []);
  assert.equal(typeof HIDDEN_LS_PREFIX, "string");
  assert.equal(HIDDEN_LS_PREFIX, "hana.history.hidden.v1:");
});
