// app/lib/commit-graph-lanes.test.mjs
// 断言口径：与桥内联版 hana-bridge-23033000.js 的 assignLanesRaw / countCrossings /
// countLaneHops / scoreOf / commitGraphLanes 逐条对齐（2026-10-23 同步）。
// 规则：初始泳道奇数次分支往下、偶数次往上；非初始泳道按在初始泳道上下方决定方向；
//       新分支紧邻父泳道插入，其余泳道平移一格；row = lane（全量显示）；cost 仅诊断不参与重排。
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitGraphLanes } from "./commit-graph-lanes.mjs";

const laneOfMap = (g) => new Map(g.nodes.map((n) => [n.seq, n.lane]));

const linear = (n) => {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ seq: i, parent: i === 1 ? null : i - 1 });
  return out;
};

test("1. 纯线性链：单泳道、row 全 0、sleeping 恒 false、cost 全 0", () => {
  const g = commitGraphLanes(linear(10));
  assert.equal(g.lanes.length, 1);
  assert.equal(g.rows, 1);
  assert.equal(g.sleepingCount, 0);
  assert.equal(g.nodes.length, 10);
  for (const n of g.nodes) {
    assert.equal(n.lane, 0);
    assert.equal(n.row, 0);
  }
  assert.deepEqual(g.lanes, [{ lane: 0, headSeq: 10, sleeping: false }]);
  assert.deepEqual(g.cost, { cross: 0, hops: 0, score: 0 });
});

test("2. 根泳道第一次分叉 → 新分支向下（父泳道下方，紧邻）", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
  ];
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 2);
  // 奇数次 → 往下：父泳道留在原位 0，新泳道在 1
  assert.deepEqual([...laneOfMap(g)], [[1, 0], [2, 0], [3, 1]]);
  assert.equal(g.lanes[0].headSeq, 2);
  assert.equal(g.lanes[1].headSeq, 3);
});

test("3. 根泳道第二次分叉 → 新分支向上（插到父泳道上方，其余平移一格）", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 }, // 奇数次：下
    { seq: 4, parent: 1 }, // 偶数次：上
  ];
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 3);
  assert.deepEqual([...laneOfMap(g)], [[1, 1], [2, 1], [3, 2], [4, 0]]);
  // headSeq 按物理行序：[上插的 4, 根 2, 下插的 3]
  assert.deepEqual(g.lanes.map((l) => l.headSeq), [4, 2, 3]);
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});

test("4. 同一父节点多个子（兄弟）：奇偶交替上下、紧邻插入、互不交叉", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
    { seq: 4, parent: 1 },
    { seq: 5, parent: 1 },
  ];
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 4);
  // 第 1 支下、第 2 支上、第 3 支下：根泳道最终落在 lane 1
  assert.deepEqual([...laneOfMap(g)], [[1, 1], [2, 1], [3, 3], [4, 0], [5, 2]]);
  assert.deepEqual(g.lanes.map((l) => l.headSeq), [4, 2, 5, 3]);
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});

test("5. 非初始泳道分叉：在初始泳道下方的一律向下、上方的一律向上", () => {
  // seq1 根；seq3 是根向下分出的分支（lane 1）；seq5 再从 seq3 分叉 → 在根下方 → 继续向下
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 }, // 根第一次分叉：向下
    { seq: 4, parent: 3 },
    { seq: 5, parent: 3 }, // 从 lane 1（根下方）分叉 → 向下
  ];
  const g = commitGraphLanes(entries);
  const lane = laneOfMap(g);
  assert.equal(lane.get(3), 1); // 根的分支在根下方
  assert.equal(lane.get(5), lane.get(3) + 1); // 下方泳道 → 继续向下
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});

test("6. 孤儿 / parent 缺失 / parent >= seq / 非整数 parent → 视同根，各开一条泳道", () => {
  assert.deepEqual(commitGraphLanes([]), {
    lanes: [], nodes: [], rows: 0, sleepingCount: 0, cost: { cross: 0, hops: 0, score: 0 },
  });
  assert.deepEqual(commitGraphLanes(null), {
    lanes: [], nodes: [], rows: 0, sleepingCount: 0, cost: { cross: 0, hops: 0, score: 0 },
  });
  assert.doesNotThrow(() =>
    commitGraphLanes([
      { seq: 5, parent: 99 },
      { seq: 6, parent: 7 },
      { seq: 7, parent: 1.5 },
      { seq: 8 },
      { seq: 9, parent: null },
    ]),
  );
  const g = commitGraphLanes([
    { seq: 5, parent: 99 },   // 孤儿（指向不存在的 seq）
    { seq: 6 },               // 缺失 parent
    { seq: 7, parent: 1.5 },  // 非整数 parent
    { seq: 9, parent: 12 },   // parent >= seq
  ]);
  assert.equal(g.lanes.length, 4);
  assert.deepEqual([...laneOfMap(g)], [[5, 0], [6, 1], [7, 2], [9, 3]]);
  assert.deepEqual(g.lanes.map((l) => l.headSeq), [5, 6, 7, 9]);
  assert.equal(g.sleepingCount, 0);
});

test("7. 确定性：同输入两次调用 deepEqual", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
    { seq: 4, parent: 2 },
    { seq: 5, parent: 1 },
    { seq: 6, parent: 4 },
    { seq: 7, parent: 3 },
    { seq: 8, parent: 5 },
    { seq: 9, parent: 6 },
    { seq: 10, parent: 9 },
  ];
  const a = commitGraphLanes(entries);
  const b = commitGraphLanes(entries);
  assert.deepEqual(a, b);
  // 不修改入参
  assert.deepEqual(entries.map((e) => Object.keys(e).sort().join(",")), entries.map(() => "parent,seq"));
});

test("8. cost 字段存在、非负、score = cross*2 + hops", () => {
  const g = commitGraphLanes([
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
    { seq: 4, parent: 2 },
    { seq: 5, parent: 3 },
  ]);
  assert.ok(g.cost && typeof g.cost === "object");
  for (const k of ["cross", "hops", "score"]) {
    assert.equal(typeof g.cost[k], "number", `cost.${k} 应为 number`);
    assert.ok(Number.isInteger(g.cost[k]) && g.cost[k] >= 0, `cost.${k} 应为非负整数`);
  }
  assert.equal(g.cost.score, g.cost.cross * 2 + g.cost.hops);
  // 插入式分配下父子泳道恒相邻 → 交叉与跨道均为 0
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});

test("9. 全量显示：row = lane，无 row=-1；nodes 与输入同序", () => {
  const entries = [{ seq: 1, parent: null }];
  for (let s = 2; s <= 7; s++) entries.push({ seq: s, parent: 1 }); // 6 条泳道
  entries.push({ seq: 8, parent: 2 }, { seq: 9, parent: 8 });
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 6);
  assert.equal(g.rows, 6);
  assert.equal(g.sleepingCount, 0);
  assert.ok(g.lanes.every((l) => l.sleeping === false));
  for (const n of g.nodes) {
    assert.equal(n.row, n.lane);
    assert.ok(n.row >= 0, "去折叠后不应出现 row=-1");
  }
  assert.deepEqual(g.nodes.map((n) => n.seq), entries.map((e) => e.seq));
});

test("10. 新分支恒紧邻父泳道（|Δlane| = 1）且不产生交叉", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
    { seq: 4, parent: 3 },
    { seq: 5, parent: 3 },
    { seq: 6, parent: 2 },
    { seq: 7, parent: 6 },
  ];
  const g = commitGraphLanes(entries);
  const lane = laneOfMap(g);
  // 每个「与父不同泳道」的节点必须紧邻父泳道
  for (const e of entries) {
    if (!Number.isInteger(e.parent) || !lane.has(e.parent)) continue;
    const d = Math.abs(lane.get(e.seq) - lane.get(e.parent));
    assert.ok(d <= 1, `seq ${e.seq} 与父 ${e.parent} 泳道距离应为 0 或 1，实际 ${d}`);
  }
  // seq7 从 seq6 延续 → 同泳道
  assert.equal(lane.get(7), lane.get(6));
  // seq6 从 seq2 分出 → 紧邻（此处向上，根泳道在下方）
  assert.equal(lane.get(6), lane.get(2) - 1);
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});

test("11. 多级分叉样本无交叉（cost 全 0，泳道数 3）", () => {
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 4, parent: 2 },
    { seq: 8, parent: 4 },
    { seq: 9, parent: 8 },
    { seq: 10, parent: 9 },
    { seq: 11, parent: 8 },
    { seq: 12, parent: 11 },
    { seq: 14, parent: 12 },
    { seq: 15, parent: 14 },
    { seq: 16, parent: 10 },
    { seq: 17, parent: 16 },
    { seq: 18, parent: 10 },
  ];
  const g = commitGraphLanes(entries);
  const lane = laneOfMap(g);
  assert.equal(g.lanes.length, 3);
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
  // seq18 从其父 seq10 分出、紧邻父泳道
  assert.equal(Math.abs(lane.get(18) - lane.get(10)), 1);
});

test("12. 非初始泳道在初始泳道上方分叉 → 向上且紧邻（lane(6) < lane(4)、Δ = 1）", () => {
  // seq1 根；根前两次分叉：seq3 向下、seq4 向上（落在根上方）；seq5 从 seq4 延续；
  // seq6 再从 seq4 分叉 → 父泳道在初始泳道上方 → 继续向上
  const entries = [
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 }, // 根第 1 次分叉：向下
    { seq: 4, parent: 1 }, // 根第 2 次分叉：向上
    { seq: 5, parent: 4 },
    { seq: 6, parent: 4 }, // 从 lane 1（根上方）分叉 → 向上
  ];
  const g = commitGraphLanes(entries);
  const lane = laneOfMap(g);
  assert.ok(lane.get(4) < lane.get(1), "seq4 应落在初始泳道上方");
  assert.ok(lane.get(6) < lane.get(4), "上方泳道分叉应向上：lane(6) < lane(4)");
  assert.equal(lane.get(4) - lane.get(6), 1, "新分支应紧邻父泳道（不跨道）");
  assert.equal(g.cost.cross, 0);
  assert.equal(g.cost.hops, 0);
});
