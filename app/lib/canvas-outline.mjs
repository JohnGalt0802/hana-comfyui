// app/lib/canvas-outline.mjs — 画布语义层 P3：大纲 outline（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// outlineGraph(graph, { detail, select })：把「UI 格式 JSON」（前端 graph.toJSON() 输出）压成
// 「功能块 + 块间连线」的大纲。块识别两级（group 优先，角色兜底）：
//   ① graph.groups 非空时：节点 pos=[x,y] 落在某 group 的 bounding=[bx,by,bw,bh] 内（含边界）
//      → 归该组（落多个组取第一个；组名 = title，空则「组{i}」——i 为该组在 groups 中的
//      序号、从 1 起）。块名重名去重：按 groups 顺序命名，与「已用名」冲突时追加「#k」
//      （k 从 2 起递增直到唯一）；空标题「组{i}」与角色块名同样纳入检查——保证块名唯一、
//      块间边不因同名合并（方向信息不丢）。无 pos / 不入任何组 → 走 ②。
//   ② 角色兜底（first-match，不区分大小写）：
//      /Loader|LoadImage/ →「加载」；/TextEncode|TextGenerate|StringFormat/ →「文本」；
//      /Sampler|Scheduler|Guider|Noise/ →「采样」；/^(Save|Preview)/ →「输出」；其余 →「其他」。
//      （第三级「标题规范」本期不做；角色表按使用反馈扩展。）
//   detail —— "blocks"（缺省，旧版行为：块级大纲）| "nodes"（T2 下钻：某块节点级视图）：
//     detail="nodes" + select（按块名/索引选择；逗号分隔取并集，缺省=全部块）：
//       块名（精确优先，不中回退大小写不敏感）或 #<n>（块序号，从 1 起，按 blocks 顺序）。
//     每节点一行：{id, type, title, value（关键值：单值/多值数组/无则 null）, symbol（符号行）}。
//     语法合法但未命中 → 空结果 + note（含可选块清单）；select 在 detail="blocks" 时给出 → 抛错。
//   输出：{op:"outline", semanticRev, rev, total:{nodes,links}, blockCount, blocks, blockEdges, issues}
//   - blocks 按块内最小 node id 升序；块内 nodes 升序
//   - summary：一句短摘要（单值参数进括号提示；块内链路按「出边节点… → 其余节点…」）
//   - blockEdges：跨块连线按 [fromName,toName] 去重（同块自环不算），按 [from 块最小 id, to 块最小 id] 排序
//   - issues：直接复用 analyzeGraph(graph).issues（不重写）
//   - detail="nodes" 时：合并 detail 字段；blocks 换成被选块的 {index,name,source,nodeCount,nodes[]}
//     行视图（自带 symbol），不含 blockEdges/issues；select 原样回显；未命中项进入 note。
//   空图合法（全空输出）；graph 非对象 → 抛 Error。
// ─────────────────────────────────────────────────────────────────────────────
import { analyzeGraph } from "./canvas-analysis.mjs";
import { SEMANTIC_REV, formatNodeSymbol } from "./canvas-symbol.mjs";

const ROLE_RULES = [
  [/Loader|LoadImage/i, "加载"],
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
 * 大纲：功能块 + 块间连线（缺省）｜ 块下钻（detail:"nodes"）。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 * @param {{detail?: "blocks"|"nodes", select?: string}} [options]
 */
export function outlineGraph(graph, options = {}) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`outlineGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  const { detail, select } = options || {};
  const detailNorm = detail === undefined || detail === null ? "blocks" : String(detail).trim().toLowerCase();
  if (detailNorm !== "blocks" && detailNorm !== "nodes") {
    throw new Error(`outlineGraph: detail 只支持 "blocks" 或 "nodes"（收到 ${JSON.stringify(String(detail))}）`);
  }
  if (select !== undefined && select !== null && typeof select !== "string") {
    throw new Error(`outlineGraph: select 必须是字符串（收到 ${typeof select}）`);
  }
  const selectStr = (select ?? "").trim();
  if (detailNorm === "blocks" && selectStr !== "") {
    throw new Error('outlineGraph: select 仅在 detail:"nodes"（下钻）时可用');
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

  // 块名分配（按 groups 顺序）+ 重名去重：冲突时追加「#k」（k 从 2 起）；
  // 空标题组「组{i}」与角色块名同样纳入「已用名」检查——保证块名唯一、块间边不因同名合并。
  const usedNames = new Set();
  const dedupName = (base) => {
    let name = base;
    let k = 2;
    while (usedNames.has(name)) {
      name = `${base}#${k}`;
      k += 1;
    }
    usedNames.add(name);
    return name;
  };
  const rawBlocks = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const nodes = groupBuckets.get(gi);
    if (!nodes) continue;
    const g = groups[gi] || {};
    const title = typeof g.title === "string" ? g.title.trim() : "";
    rawBlocks.push({ name: dedupName(title || `组${gi + 1}`), source: "group", nodes });
  }
  for (const [role, nodes] of roleBuckets) {
    rawBlocks.push({ name: dedupName(role), source: "role", nodes });
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

  const issues = analyzeGraph(graph).issues;

  if (detailNorm === "blocks") {
    return {
      op: "outline",
      semanticRev: SEMANTIC_REV,
      rev: graph.revision ?? null,
      total: { nodes: rawNodes.length, links: rawLinks.length },
      blockCount: blocks.length,
      blocks,
      blockEdges,
      issues,
    };
  }

  // detail === "nodes"：块下钻（每节点一行：id/type/title/关键值/符号行）
  const nodeByKey = new Map();
  for (const node of rawNodes) {
    if (node && typeof node === "object") nodeByKey.set(keyOf(node.id), node);
  }
  const rowOf = (n) => {
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const value = wv.length === 0 ? null : wv.length === 1 ? wv[0] : wv.slice();
    return {
      id: n.id,
      type: String(n.type ?? ""),
      title: typeof n.title === "string" ? n.title : "",
      value,
      symbol: formatNodeSymbol(n),
    };
  };

  let matched;
  const unmatched = [];
  if (selectStr === "") {
    matched = blocks.map((b, i) => ({ index: i + 1, block: b })); // 缺省 = 全部块
  } else {
    const terms = selectStr.split(",").map((s) => s.trim()).filter(Boolean);
    const picked = new Set();
    for (const term of terms) {
      const m = /^#(\d+)$/.exec(term);
      if (m) {
        const n = Number(m[1]);
        if (n < 1) throw new Error(`outlineGraph: 块索引从 #1 起（收到 ${JSON.stringify(term)}）`);
        if (n <= blocks.length) picked.add(n);
        else unmatched.push(term);
        continue;
      }
      let hitIdx = [];
      blocks.forEach((b, i) => {
        if (b.name === term) hitIdx.push(i + 1);
      });
      if (!hitIdx.length) {
        const lower = term.toLowerCase();
        blocks.forEach((b, i) => {
          if (b.name.toLowerCase() === lower) hitIdx.push(i + 1);
        });
      }
      if (hitIdx.length) hitIdx.forEach((i) => picked.add(i));
      else unmatched.push(term);
    }
    matched = [...picked].sort((a, b) => a - b).map((i) => ({ index: i, block: blocks[i - 1] }));
  }

  const outBlocks = matched.map(({ index, block }) => ({
    index,
    name: block.name,
    source: block.source,
    nodeCount: block.nodes.length,
    nodes: block.nodes.map((id) => nodeByKey.get(keyOf(id))).filter(Boolean).map(rowOf),
  }));

  const result = {
    op: "outline",
    semanticRev: SEMANTIC_REV,
    detail: "nodes",
    rev: graph.revision ?? null,
    total: { nodes: rawNodes.length, links: rawLinks.length },
    blockCount: blocks.length,
    blocks: outBlocks,
  };
  if (selectStr !== "") result.select = selectStr;
  if (unmatched.length) {
    const what = outBlocks.length === 0 ? "未命中任何块" : "部分未命中";
    result.note = `${what}：${unmatched.map((t) => JSON.stringify(t)).join("、")}；可选块：${blocks.map((b, i) => `#${i + 1} ${b.name}`).join("、")}`;
  }
  return result;
}
