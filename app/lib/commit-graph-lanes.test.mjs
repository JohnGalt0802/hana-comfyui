// app/lib/commit-graph-lanes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitGraphLanes } from "./commit-graph-lanes.mjs";

// 几何交叉检测（方案 §2 的评测口径）：x = entries 下标（拓扑/时序），y = 泳道；
// 逐条 parent→child 边拆段，判断是否穿过中间泳道上的节点竖线。返回交叉数。
function countCrossings(entries, g) {
  const xOf = new Map(entries.map((e, i) => [e.seq, i]));
  const laneOf = new Map(g.nodes.map((n) => [n.seq, n.lane]));
  const laneXs = new Map();
  for (const n of g.nodes) {
    if (!laneXs.has(n.lane)) laneXs.set(n.lane, []);
    laneXs.get(n.lane).push(xOf.get(n.seq));
  }
  let crossings = 0;
  for (const e of entries) {
    const p = e.parent;
    if (!Number.isInteger(p) || p >= e.seq || !laneOf.has(p)) continue;
    const lo = Math.min(laneOf.get(e.seq), laneOf.get(p));
    const hi = Math.max(laneOf.get(e.seq), laneOf.get(p));
    const xlo = Math.min(xOf.get(p), xOf.get(e.seq));
    const xhi = Math.max(xOf.get(p), xOf.get(e.seq));
    for (let L = lo + 1; L < hi; L += 1) {
      if ((laneXs.get(L) || []).some((x) => x > xlo && x < xhi)) crossings += 1;
    }
  }
  return crossings;
}

const linear = (n) => {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ seq: i, parent: i === 1 ? null : i - 1 });
  return out;
};

test("1. 线性 10 条 → 1 泳道、10 节点全 row=0、sleepingCount=0", () => {
  const g = commitGraphLanes(linear(10));
  assert.equal(g.lanes.length, 1);
  assert.equal(g.rows, 1);
  assert.equal(g.sleepingCount, 0);
  assert.equal(g.nodes.length, 10);
  for (const n of g.nodes) assert.equal(n.row, 0);
  assert.deepEqual(g.lanes, [{ lane: 0, headSeq: 10, sleeping: false }]);
});

test("2. 一次分叉（seq3 分出两支）→ 2 泳道、两行全显示", () => {
  const g = commitGraphLanes([
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 2 },
    { seq: 4, parent: 3 },
    { seq: 5, parent: 3 },
  ]);
  assert.equal(g.lanes.length, 2);
  assert.equal(g.rows, 2);
  assert.equal(g.sleepingCount, 0);
  assert.deepEqual(g.nodes, [
    { seq: 1, lane: 0, row: 0 },
    { seq: 2, lane: 0, row: 0 },
    { seq: 3, lane: 0, row: 0 },
    { seq: 4, lane: 0, row: 0 },
    { seq: 5, lane: 1, row: 1 },
  ]);
});

test("3. 分叉后一支长期不动 → 不折叠，sleeping 恒 false、row=lane", () => {
  const g = commitGraphLanes([
    { seq: 1, parent: null },
    { seq: 2, parent: 1 },
    { seq: 3, parent: 1 },
    { seq: 4, parent: 1 },
    { seq: 5, parent: 1 },
    { seq: 6, parent: 1 },
    { seq: 7, parent: 2 },
    { seq: 8, parent: 7 },
    { seq: 9, parent: 8 },
    { seq: 10, parent: 9 },
  ]);
  assert.equal(g.lanes.length, 5);
  assert.equal(g.rows, 5); // 去折叠：全量 5 行
  assert.equal(g.sleepingCount, 0);
  // G 下：新分支插到父泳道正下方，后续分支会把先建分支的泳道下推（lane 索引会变；泳道数 5 不变）。
  assert.deepEqual(g.lanes, [
    { lane: 0, headSeq: 10, sleeping: false },
    { lane: 1, headSeq: 6, sleeping: false },
    { lane: 2, headSeq: 5, sleeping: false },
    { lane: 3, headSeq: 4, sleeping: false },
    { lane: 4, headSeq: 3, sleeping: false },
  ]);
  // 长期不动的泳道其节点不再被折叠（row 不再是 -1）；row = lane。
  const n3 = g.nodes.find((n) => n.seq === 3);
  assert.equal(n3.row, n3.lane);
  assert.ok(n3.row >= 0, "去折叠后不应再有 row=-1 的节点");
  assert.ok(g.lanes.every((l) => l.sleeping === false));
});

test("4. 泳道数 > 旧上限 4 → 全部显示：rows = laneCount、sleepingCount = 0", () => {
  const entries = [{ seq: 1, parent: null }];
  for (let s = 2; s <= 7; s++) entries.push({ seq: s, parent: 1 }); // 6 条泳道
  entries.push({ seq: 8, parent: 2 }, { seq: 9, parent: 8 });
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 6);
  assert.equal(g.rows, 6); // 不再截断到 4
  assert.equal(g.sleepingCount, 0);
  assert.equal(g.lanes.filter((l) => l.sleeping).length, 0);
  assert.ok(g.rows > 4, "rows 应超过旧上限 4（取消折叠）");
});

test("5. 确定性：同输入两次调用 deepEqual", () => {
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
  assert.deepEqual(commitGraphLanes(entries), commitGraphLanes(entries));
});

test("6. 空 / 孤儿 parent / 异常 parent 不抛异常", () => {
  assert.deepEqual(commitGraphLanes([]), { lanes: [], nodes: [], rows: 0, sleepingCount: 0 });
  assert.doesNotThrow(() =>
    commitGraphLanes([
      { seq: 5, parent: 99 },       // 孤儿（指向不存在的 seq）
      { seq: 6, parent: 7 },        // parent >= seq
      { seq: 7, parent: 1.5 },      // 非整数 parent
      { seq: 8 },                   // 缺失 parent
      { seq: 9, parent: null },     // 显式根
    ]),
  );
  const g = commitGraphLanes([{ seq: 5, parent: 99 }, { seq: 6 }, { seq: 7, parent: 1.5 }]);
  // 全部视同根 → 各开新泳道
  assert.equal(g.lanes.length, 3);
  assert.deepEqual(g.nodes.map((n) => n.lane), [0, 1, 2]);
});

test("7. 每个节点 row=lane（去折叠，无 -1）；nodes 与输入同序", () => {
  const entries = [{ seq: 1, parent: null }];
  for (let s = 2; s <= 7; s++) entries.push({ seq: s, parent: 1 });
  entries.push({ seq: 8, parent: 2 }, { seq: 9, parent: 8 });
  const g = commitGraphLanes(entries);
  assert.equal(g.nodes.length, entries.length);
  for (const n of g.nodes) {
    assert.equal(typeof n.row, "number");
    assert.ok(Number.isInteger(n.row));
    assert.equal(n.row, n.lane); // 去折叠：row 直接等于 lane
    assert.ok(n.row >= 0);
  }
  assert.ok(!g.nodes.some((n) => n.row === -1), "去折叠后不应再有 row=-1 的节点");
  // nodes 的 seq 与输入同序
  assert.deepEqual(g.nodes.map((n) => n.seq), entries.map((e) => e.seq));
});

test("8. 新分支插父下方：分叉后再分叉 → 新分支 lane = 父 lane + 1、无交叉", () => {
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
  const laneOf = new Map(g.nodes.map((n) => [n.seq, n.lane]));
  // 无交叉：几何交叉检测器为 0（方案 §5 的真实验收口径）
  assert.equal(countCrossings(entries, g), 0);
  // 新分支插到父泳道正下方：seq6（从 2 分出）应在 seq2 泳道的下一行
  assert.equal(laneOf.get(6), laneOf.get(2) + 1);
  // seq7（从 6 延续）应继承 seq6 泳道
  assert.equal(laneOf.get(7), laneOf.get(6));
});

test("9. 用户样本无交叉：分叉后再分叉（seq18）不跨道", () => {
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
  const laneOf = new Map(g.nodes.map((n) => [n.seq, n.lane]));
  // 无交叉：几何交叉检测器为 0
  assert.equal(countCrossings(entries, g), 0);
  // seq18 从其父 seq10 分出，应紧贴父泳道下方
  assert.equal(laneOf.get(18), laneOf.get(10) + 1);
});
