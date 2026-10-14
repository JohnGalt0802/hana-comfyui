// app/lib/commit-graph-lanes.mjs
// 泳道算法（W1 · 纯函数）
// 零副作用、不碰磁盘、不 import 除自身外任何模块。
//
// 输入：entries —— 索引行数组，已按 seq 升序，每项至少 { seq:number, parent:number|null }
// 输出：{ lanes:[{lane,headSeq,sleeping}], nodes:[{seq,lane,row}], rows:number, sleepingCount:number }
//
// 两段算法（确定性）：
//   (1) 泳道分配（单遍）：子继承「head === parent」的泳道；找不到则为新分支，
//       插到父泳道对象的「正下方」（数组 insert(index+1)）；父泳道不存在（根/孤儿）则 append。
//       同 parent 多 child 时 seq 最小者先接手。我们的图是严格树（单 parent、只分不合），
//       泳道永不真正回收。G 算法（2026-10-14）：新泳道挤在父泳道下方 → 消交叉。
//   (2) 全量显示（2026-10-12 去折叠）：不再按 headSeq 截断——row = lane、rows = laneCount、
//       sleepingCount 恒 0（lanes[].sleeping 恒 false）；泳道多时由视图侧拖拽/滚动查看。
//       ⚠️ 本文件与桥内内联版（app/bridge/js/hana-bridge-15021810.js 的 commitGraphLanes）
//       必须逐逻辑一致，改动请同改两处（含 commit-graph-lanes.test.mjs 断言）。

export function commitGraphLanes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { lanes: [], nodes: [], rows: 0, sleepingCount: 0 };
  }

  // (1) 泳道分配（单遍，seq 升序）——泳道对象数组，物理顺序即行序（lanes[0] 在最上）
  const lanes = []; // { head: seq|null, seqs: [] }；只增不回收
  const objOf = new Map(); // seq -> 泳道对象（该 seq 所在泳道）
  const nodeLane = []; // 与 entries 同序的「泳道对象」
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const seq = e.seq;
    const p = e.parent;
    let target = null;
    // ① 延续：找 head === p 的泳道
    // parent 必须是 < seq 的整数；孤儿 / parent>=seq / 非整数 / 缺失 一律视同根
    if (Number.isInteger(p) && p < seq) {
      for (const lane of lanes) { if (lane.head === p) { target = lane; break; } }
    }
    // ② 新分支：插到父泳道正下方；父泳道不存在 → append
    if (!target) {
      const pObj = (Number.isInteger(p) && p < seq) ? objOf.get(p) : null;
      if (pObj) {
        const pos = lanes.indexOf(pObj) + 1;
        target = { head: null, seqs: [] };
        lanes.splice(pos, 0, target);
      } else {
        target = { head: null, seqs: [] };
        lanes.push(target);
      }
    }
    target.head = seq;
    target.seqs.push(seq);
    objOf.set(seq, target);
    nodeLane.push(target);
  }

  // (2) 全量显示（去折叠）：row = lane，无 row=-1；sleeping 恒 false。
  const laneIndex = new Map();
  lanes.forEach((lane, idx) => laneIndex.set(lane, idx));
  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const lane = laneIndex.get(nodeLane[i]);
    nodes.push({ seq: entries[i].seq, lane, row: lane });
  }

  const outLanes = lanes.map((lane, idx) => ({ lane: idx, headSeq: lane.head, sleeping: false }));

  return { lanes: outLanes, nodes, rows: lanes.length, sleepingCount: 0 };
}

export default commitGraphLanes;
