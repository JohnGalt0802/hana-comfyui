// app/lib/commit-graph-lanes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitGraphLanes, MAX_ROWS } from "./commit-graph-lanes.mjs";

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

test("2. 一次分叉（seq3 分出两支）→ 2 泳道", () => {
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

test("3. 分叉后一支长期不动（末端远落后于 latest）→ 该泳道 sleeping=true", () => {
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
  assert.equal(g.rows, 4);
  assert.equal(g.sleepingCount, 1);
  const stale = g.lanes.find((l) => l.lane === 1);
  assert.deepEqual(stale, { lane: 1, headSeq: 3, sleeping: true });
  // 长期不动的泳道其节点被折叠
  assert.equal(g.nodes.find((n) => n.seq === 3).row, -1);
});

test("4. 泳道数 > MAX_ROWS → rows <= 4 且 sleepingCount > 0", () => {
  const entries = [{ seq: 1, parent: null }];
  for (let s = 2; s <= 7; s++) entries.push({ seq: s, parent: 1 }); // 6 条泳道
  entries.push({ seq: 8, parent: 2 }, { seq: 9, parent: 8 });
  const g = commitGraphLanes(entries);
  assert.equal(g.lanes.length, 6);
  assert.ok(g.rows <= MAX_ROWS, "rows 不得超过 MAX_ROWS");
  assert.equal(g.rows, MAX_ROWS);
  assert.ok(g.sleepingCount > 0);
  assert.equal(g.sleepingCount, 6 - g.rows);
  assert.equal(g.lanes.filter((l) => l.sleeping).length, g.sleepingCount);
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

test("7. 每个节点在 nodes 里都有 row（含 -1）", () => {
  const entries = [{ seq: 1, parent: null }];
  for (let s = 2; s <= 7; s++) entries.push({ seq: s, parent: 1 });
  entries.push({ seq: 8, parent: 2 }, { seq: 9, parent: 8 });
  const g = commitGraphLanes(entries);
  assert.equal(g.nodes.length, entries.length);
  for (const n of g.nodes) {
    assert.equal(typeof n.row, "number");
    assert.ok(Number.isInteger(n.row));
    assert.ok(n.row >= -1);
  }
  assert.ok(g.nodes.some((n) => n.row === -1), "折叠泳道应有 row=-1 的节点");
  // nodes 的 seq 与输入同序
  assert.deepEqual(g.nodes.map((n) => n.seq), entries.map((e) => e.seq));
});
