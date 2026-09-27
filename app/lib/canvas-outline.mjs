// app/lib/canvas-outline.mjs — 画布语义层 P3：大纲 outline（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// outlineGraph(graph)：把「UI 格式 JSON」（前端 graph.toJSON() 输出）压成
// 「功能块 + 块间连线」的大纲。块识别两级（group 优先，角色兜底）：
//   ① graph.groups 非空时：节点 pos=[x,y] 落在某 group 的 bounding=[bx,by,bw,bh] 内（含边界）
//      → 归该组（落多个组取第一个；组名 = title，空则「组{i}」——i 为该组在 groups 中的
//      序号、从 1 起）；无 pos / 不入任何组 → 走 ②。
//   ② 角色兜底（first-match，不区分大小写）：
//      /Loader/ →「加载」；/TextEncode|TextGenerate|StringFormat/ →「文本」；
//      /Sampler|Scheduler|Guider|Noise/ →「采样」；/^(Save|Preview)/ →「输出」；其余 →「其他」。
//      （第三级「标题规范」本期不做；角色表按使用反馈扩展。）
//   输出：{op:"outline", rev, total:{nodes,links}, blockCount, blocks, blockEdges, issues}
//   - blocks 按块内最小 node id 升序；块内 nodes 升序
//   - summary：一句短摘要（单值参数进括号提示；块内链路按「出边节点… → 其余节点…」）
//   - blockEdges：跨块连线按 [fromName,toName] 去重（同块自环不算），按 [from 块最小 id, to 块最小 id] 排序
//   - issues：直接复用 analyzeGraph(graph).issues（不重写）
//   空图合法（全空输出）；graph 非对象 → 抛 Error。
// ─────────────────────────────────────────────────────────────────────────────
import { analyzeGraph } from "./canvas-analysis.mjs";

const ROLE_RULES = [
  [/Loader/i, "加载"],
  [/TextEncode|TextGenerate|StringFormat/i, "文本"],
  [/Sampler|Scheduler|Guider|Noise/i, "采样"],
  [/^(Save|Preview)/i, "输出"],
];
const ROLE_FALLBACK = "其他";

// 数值容错解析：number 或可转数字的字符串 → number；其余 → null
function parseId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// id 比较：数值优先，非数值回落字符串序
function cmpIds(a, b) {
  const an = parseId(a);
  const bn = parseId(b);
  if (an !== null && bn !== null) return an - bn;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// 归一化 id 键：8 与 "8" 视为同一
function keyOf(v) {
  const n = parseId(v);
  return n === null ? `s:${String(v)}` : `n:${n}`;
}

function minIdOf(ids) {
  let min = ids[0];
  for (const id of ids) {
    if (cmpIds(id, min) < 0) min = id;
  }
  return min;
}

/**
 * 大纲：功能块 + 块间连线。返回 {op:"outline", rev, total, blockCount, blocks, blockEdges, issues}。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 */
export function outlineGraph(graph) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`outlineGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  const groups = Array.isArray(graph.groups) ? graph.groups : [];

  // ① group 归属：节点 pos 点落在 bounding 内（含边界）；落多个组取第一个
  const groupOf = new Map(); // node obj → group index
  if (groups.length) {
    for (const node of rawNodes) {
      if (!node || typeof node !== "object") continue;
      const pos = node.pos;
      if (!Array.isArray(pos) || typeof pos[0] !== "number" || typeof pos[1] !== "number") continue;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const b = g && Array.isArray(g.bounding) ? g.bounding : null;
        if (!b || b.length < 4 || b.slice(0, 4).some((v) => typeof v !== "number")) continue;
        if (pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3]) {
          groupOf.set(node, gi);
          break;
        }
      }
    }
  }

  // 块分桶：group 优先；未归组 → ② 角色兜底（first-match）
  const groupBuckets = new Map(); // group index → node[]
  const roleBuckets = new Map(); // role name → node[]
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const gi = groupOf.get(node);
    if (gi !== undefined) {
      if (!groupBuckets.has(gi)) groupBuckets.set(gi, []);
      groupBuckets.get(gi).push(node);
      continue;
    }
    const type = String(node.type ?? "");
    let role = ROLE_FALLBACK;
    for (const [re, name] of ROLE_RULES) {
      if (re.test(type)) {
        role = name;
        break;
      }
    }
    if (!roleBuckets.has(role)) roleBuckets.set(role, []);
    roleBuckets.get(role).push(node);
  }

  const rawBlocks = [];
  for (const [gi, nodes] of groupBuckets) {
    const g = groups[gi] || {};
    const title = typeof g.title === "string" ? g.title.trim() : "";
    rawBlocks.push({ name: title || `组${gi + 1}`, source: "group", nodes });
  }
  for (const [role, nodes] of roleBuckets) {
    rawBlocks.push({ name: role, source: "role", nodes });
  }

  // 块排序：按块内最小 node id 升序
  rawBlocks.sort((a, b) => cmpIds(minIdOf(a.nodes.map((n) => n.id)), minIdOf(b.nodes.map((n) => n.id))));

  // 摘要：单值参数进括号；块内链路「出边节点… → 其余节点…」
  const summarize = (nodes) => {
    const sorted = nodes.slice().sort((a, b) => cmpIds(a.id, b.id));
    const idSet = new Set(sorted.map((n) => keyOf(n.id)));
    const outCount = new Map();
    for (const row of rawLinks) {
      if (!Array.isArray(row) || !idSet.has(keyOf(row[1])) || !idSet.has(keyOf(row[3]))) continue;
      const k = keyOf(row[1]);
      outCount.set(k, (outCount.get(k) || 0) + 1);
    }
    const fmtNode = (n) => {
      const w = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      if (w.length !== 1) return `#${String(n.id)}`;
      let s = String(w[0]);
      if (s.length > 24) s = `${s.slice(0, 24)}…`;
      return `#${String(n.id)}(${s})`;
    };
    const senders = sorted.filter((n) => (outCount.get(keyOf(n.id)) || 0) > 0);
    const rest = sorted.filter((n) => !((outCount.get(keyOf(n.id)) || 0) > 0));
    if (senders.length && rest.length) {
      return [...senders.map(fmtNode), "→", ...rest.map(fmtNode)].join(" ");
    }
    return sorted.map(fmtNode).join(" ");
  };

  const blocks = rawBlocks.map((b) => ({
    name: b.name,
    source: b.source,
    nodes: b.nodes.map((n) => n.id).sort(cmpIds),
    summary: summarize(b.nodes),
  }));

  // blockEdges：跨块连线（同块不算），按 [fromName,toName] 去重，按 [from 块最小 id, to 块最小 id] 排序
  const minIds = blocks.map((b) => minIdOf(b.nodes));
  const blockIdxOf = new Map();
  blocks.forEach((b, i) => {
    for (const id of b.nodes) blockIdxOf.set(keyOf(id), i);
  });
  const seen = new Set();
  const kept = [];
  for (const row of rawLinks) {
    if (!Array.isArray(row)) continue;
    const fi = blockIdxOf.get(keyOf(row[1]));
    const ti = blockIdxOf.get(keyOf(row[3]));
    if (fi === undefined || ti === undefined || fi === ti) continue; // 端点缺失 / 同块自环，不算
    const k = `${blocks[fi].name}\u0000${blocks[ti].name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push({ fi, ti });
  }
  kept.sort((a, b) => {
    const c = cmpIds(minIds[a.fi], minIds[b.fi]);
    return c !== 0 ? c : cmpIds(minIds[a.ti], minIds[b.ti]);
  });
  const blockEdges = kept.map((e) => [blocks[e.fi].name, blocks[e.ti].name]);

  return {
    op: "outline",
    rev: graph.revision ?? null,
    total: { nodes: rawNodes.length, links: rawLinks.length },
    blockCount: blocks.length,
    blocks,
    blockEdges,
    issues: analyzeGraph(graph).issues,
  };
}
