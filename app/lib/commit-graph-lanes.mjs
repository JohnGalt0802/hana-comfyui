// app/lib/commit-graph-lanes.mjs
// 泳道算法（W1 · 纯函数）
// 零副作用、不碰磁盘、不 import 除自身外任何模块。
//
// 输入：entries —— 索引行数组，已按 seq 升序，每项至少 { seq:number, parent:number|null }
// 输出：{ lanes:[{lane,headSeq,sleeping}], nodes:[{seq,lane,row}], rows:number,
//         sleepingCount:number, cost:{cross,hops,score} }
//
// 2026-10-23：本文件与桥内联版 hana-bridge-23033000.js（assignLanesRaw L6314 起）逐条对齐。
// 2026-10-24：活动桥换代为 hana-bridge-18133900.js，泳道算法未变（仍为单遍插入式）。
// 线上 2026-10-22 按用户规则把算法重写为「单遍插入式分配」，本文件是它的镜像，只照搬、不优化：
//   「出分支 → 放在父泳道下方 → 父泳道下方的泳道全部往下平移一泳道」
//   「不要只往下，初始泳道上，奇数次的分支往下，偶数次的分支往上」
//   「除了初始泳道的其他泳道，在上方的向上分支，在下方的向下分支」
// 即：新分支永远插在紧邻父泳道的位置（不开到列表末尾），插入方向按上述规则选，
//     插入后其余泳道自然平移一格 → 父子泳道永远相邻，汇聚边不跨越无关泳道。
// 两段流程：分配（插入式）→ 全量显示（row = lane，无 row=-1）+ 诊断代价（cost，不参与重排）。
//
// ⚠️ 本文件与桥内联版必须逐逻辑一致（桥在 CSP 下不能 import ESM，故内联）。
//    改一处必须同改两处（含 commit-graph-lanes.test.mjs 断言）；
//    桥文件名随 BUILD_TAG 换代，以「W1 泳道算法」注释块所在处为准。

// 泳道分配（单遍插入式）。返回 { lanes:[{head,seqs}], nodeLane:[泳道对象] }：
// lanes 的物理顺序即上下顺序；nodeLane 与 entries 同序。
function assignLanesRaw(entries) {
  const lanes = [];
  const objOf = new Map();
  const nodeLane = [];
  const branchCount = new Map(); // 每条泳道已分出多少个分支（奇偶决定方向）
  let rootLane = null;          // 初始泳道（第一个建立的）

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const seq = e.seq;
    const p = e.parent;
    let target = null;
    // 继承：「父是本泳道最新提交」→ 继续用这条泳道
    // parent 必须是 < seq 的整数；孤儿 / parent>=seq / 非整数 / 缺失 一律视同根
    if (Number.isInteger(p) && p < seq) {
      for (const lane of lanes) { if (lane.head === p) { target = lane; break; } }
    }
    if (!target) {
      const pObj = (Number.isInteger(p) && p < seq) ? objOf.get(p) : null;
      target = { head: null, seqs: [] };
      if (pObj) {
        if (!rootLane) rootLane = pObj;
        const pIdx = lanes.indexOf(pObj);
        const rootIdx = lanes.indexOf(rootLane);
        let up;
        if (pObj === rootLane) {
          // 初始泳道分叉：奇数次往下、偶数次往上
          const n = (branchCount.get(pObj) || 0) + 1;
          branchCount.set(pObj, n);
          up = (n % 2 === 0);
        } else {
          // 其余泳道：在初始泳道上方的一律向上、下方的一律向下
          up = pIdx < rootIdx;
        }
        if (up) lanes.splice(pIdx, 0, target);
        else lanes.splice(pIdx + 1, 0, target);
      } else {
        lanes.push(target);
        if (!rootLane) rootLane = target;
      }
    }
    target.head = seq;
    target.seqs.push(seq);
    objOf.set(seq, target);
    nodeLane.push(target);
  }
  return { lanes, nodeLane };
}

// 几何交叉：两条「子→父」线段在 y 区间重叠内是否交换左右。共用端点不算。
function countCrossings(entries, laneOfSeq) {
  const edges = [];
  for (const e of entries) {
    if (!Number.isInteger(e.parent)) continue;
    const c = laneOfSeq.get(e.seq), p = laneOfSeq.get(e.parent);
    if (c === undefined || p === undefined) continue;
    edges.push({ x1: e.seq, y1: c, x2: e.parent, y2: p });
  }
  let cross = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (a.x1 === b.x1 || a.x2 === b.x2 || a.x1 === b.x2 || a.x2 === b.x1) continue;
      const aLo = Math.min(a.y1, a.y2), aHi = Math.max(a.y1, a.y2);
      const bLo = Math.min(b.y1, b.y2), bHi = Math.max(b.y1, b.y2);
      if (aHi < bLo || bHi < aLo) continue;
      const yl = Math.max(aLo, bLo), yh = Math.min(aHi, bHi);
      if (yl > yh) continue;
      const xa = (y) => a.y1 === a.y2 ? a.x1 : a.x1 + (a.x2 - a.x1) * (y - a.y1) / (a.y2 - a.y1);
      const xb = (y) => b.y1 === b.y2 ? b.x1 : b.x1 + (b.x2 - b.x1) * (y - b.y1) / (b.y2 - b.y1);
      if ((xa(yl) - xb(yl)) * (xa(yh) - xb(yh)) < 0) cross++;
    }
  }
  return cross;
}

// 跨道：边跨越中间泳道时，那条泳道在该 x 区间内有节点（视觉上也难读，一并计入代价）
function countLaneHops(entries, laneOfSeq, xOfSeq) {
  const laneXs = new Map();
  for (const [seq, l] of laneOfSeq) {
    if (!laneXs.has(l)) laneXs.set(l, []);
    laneXs.get(l).push(xOfSeq.get(seq));
  }
  let hops = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.parent) || !laneOfSeq.has(e.parent)) continue;
    const lo = Math.min(laneOfSeq.get(e.seq), laneOfSeq.get(e.parent));
    const hi = Math.max(laneOfSeq.get(e.seq), laneOfSeq.get(e.parent));
    const xlo = Math.min(xOfSeq.get(e.parent), xOfSeq.get(e.seq));
    const xhi = Math.max(xOfSeq.get(e.parent), xOfSeq.get(e.seq));
    for (let L = lo + 1; L < hi; L++) {
      if ((laneXs.get(L) || []).some((x) => x > xlo && x < xhi)) hops++;
    }
  }
  return hops;
}

// 代价：交叉权重更高（交叉比跨道更难读），跨道 1 分。
function scoreOf(entries, laneOfSeq, xOfSeq) {
  const cross = countCrossings(entries, laneOfSeq);
  const hops = countLaneHops(entries, laneOfSeq, xOfSeq);
  return { cross, hops, score: cross * 2 + hops };
}

export function commitGraphLanes(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { lanes: [], nodes: [], rows: 0, sleepingCount: 0, cost: { cross: 0, hops: 0, score: 0 } };
  }

  // (1) 分配（插入式：新分支紧邻父泳道，插入后其余泳道平移一格）
  const { lanes } = assignLanesRaw(entries);
  const laneSeqs = lanes.map((l) => l.seqs.slice());
  const laneOfSeq = new Map();
  laneSeqs.forEach((seqs, i) => { for (const s of seqs) laneOfSeq.set(s, i); });

  // (2) 不做重排（2026-10-22 去）：插入式分配已保证父子泳道相邻，
  //     重排反而会把这种天然的相邻关系打乱（历史 bug 源）。
  //     下面只算代价，纯供诊断用。
  const xOfSeq = new Map(entries.map((e, i) => [e.seq, i]));
  const score = scoreOf(entries, laneOfSeq, xOfSeq);

  // (3) 全量显示（去折叠）：row = lane，无 row=-1；sleeping 恒 false。
  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const lane = laneOfSeq.get(entries[i].seq);
    nodes.push({ seq: entries[i].seq, lane, row: lane });
  }
  const outLanes = laneSeqs.map((seqs, idx) => ({
    lane: idx,
    headSeq: seqs.length ? seqs[seqs.length - 1] : null,
    sleeping: false,
  }));

  return {
    lanes: outLanes,
    nodes,
    rows: laneSeqs.length,
    sleepingCount: 0,
    cost: score,
  };
}

export default commitGraphLanes;
