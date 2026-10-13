// app/lib/commit-graph-lanes.mjs
// 泳道算法（W1 · 纯函数）
// 零副作用、不碰磁盘、不 import 除自身外任何模块。
//
// 输入：entries —— 索引行数组，已按 seq 升序，每项至少 { seq:number, parent:number|null }
// 输出：{ lanes:[{lane,headSeq,sleeping}], nodes:[{seq,lane,row}], rows:number, sleepingCount:number }
//
// 两段算法（确定性）：
//   (1) 泳道分配（单遍）：子继承父泳道 active[L] === p；找不到则 append 新泳道；
//       同 parent 多 child 时 seq 最小者先接手。我们的图是严格树（单 parent、只分不合），
//       泳道永不真正回收。
//   (2) 全量显示（2026-10-12 去折叠）：不再按 headSeq 截断——row = lane、rows = laneCount、
//       sleepingCount 恒 0（lanes[].sleeping 恒 false）；泳道多时由视图侧拖拽/滚动查看。
//       ⚠️ 本文件与桥内内联版（app/bridge/js/hana-bridge-14015734.js 的 commitGraphLanes）
//       必须逐逻辑一致，改动请同改两处（含 commit-graph-lanes.test.mjs 断言）。

export function commitGraphLanes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { lanes: [], nodes: [], rows: 0, sleepingCount: 0 };
  }

  // (1) 泳道分配（单遍，seq 升序）
  const active = []; // active[L] = 该泳道悬挂末端 seq；只增不回收
  const nodeLane = []; // 与 entries 同序的泳道号
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const seq = e.seq;
    const p = e.parent;
    let lane = -1;
    // parent 必须是 < seq 的整数；孤儿 / parent>=seq / 非整数 / 缺失 一律视同根
    if (Number.isInteger(p) && p < seq) {
      for (let L = 0; L < active.length; L++) {
        if (active[L] === p) { lane = L; break; }
      }
    }
    if (lane < 0) { lane = active.length; active.push(null); }
    active[lane] = seq;
    nodeLane.push(lane);
  }
  const laneCount = active.length;

  // (2) 全量显示（去折叠）：row = lane，无 row=-1；sleeping 恒 false。
  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const lane = nodeLane[i];
    nodes.push({ seq: e.seq, lane, row: lane });
  }

  const lanes = [];
  for (let L = 0; L < laneCount; L++) {
    lanes.push({ lane: L, headSeq: active[L], sleeping: false });
  }

  return { lanes, nodes, rows: laneCount, sleepingCount: 0 };
}

export default commitGraphLanes;
