// app/lib/commit-graph-lanes.mjs
// 泳道算法（W1 · 纯函数）
// 零副作用、不碰磁盘、不 import 除自身外任何模块。
//
// 输入：entries —— 索引行数组，已按 seq 升序，每项至少 { seq:number, parent:number|null }
// 输出：{ lanes:[{lane,headSeq,sleeping}], nodes:[{seq,lane,row}], rows:number, sleepingCount:number }
//
// 三段算法（确定性）：
//   (1) 泳道分配（单遍）：子继承父泳道 active[L] === p；找不到则 append 新泳道；
//       同 parent 多 child 时 seq 最小者先接手。我们的图是严格树（单 parent、只分不合），
//       泳道永不真正回收，只能靠休眠折叠隐藏。
//   (2) 休眠判定：各泳道末端 headSeq 降序取前 MAX_ROWS 条 = 显示集。
//   (3) 紧凑重映射：显示集按 lane 升序 row=0,1,2...；其余 row=-1。

export const MAX_ROWS = 4;

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

  // (2) 休眠判定 + 选显示集
  const order = [];
  for (let L = 0; L < laneCount; L++) order.push(L);
  order.sort((a, b) => (active[b] - active[a]) || (a - b)); // headSeq 降序，同值按 lane 升序
  const display = order.slice(0, MAX_ROWS);
  const shown = new Array(laneCount).fill(false);
  for (const L of display) shown[L] = true;

  // (3) 紧凑重映射（显示集按 lane 升序 → row 0,1,2...）
  const rowOf = new Array(laneCount).fill(-1);
  const displayAsc = display.slice().sort((a, b) => a - b);
  for (let r = 0; r < displayAsc.length; r++) rowOf[displayAsc[r]] = r;

  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const lane = nodeLane[i];
    nodes.push({ seq: e.seq, lane, row: rowOf[lane] });
  }

  const lanes = [];
  for (let L = 0; L < laneCount; L++) {
    lanes.push({ lane: L, headSeq: active[L], sleeping: !shown[L] });
  }

  return { lanes, nodes, rows: displayAsc.length, sleepingCount: laneCount - displayAsc.length };
}

export default commitGraphLanes;
