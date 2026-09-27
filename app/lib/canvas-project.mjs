// app/lib/canvas-project.mjs — 画布语义层 P1：投影过滤器（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// projectGraph(graph, { select, fields })：
//   对「UI 格式 JSON」（前端 graph.toJSON() 的输出）做“选子图 + 选字段”的投影，
//   供 canvas get 在 agent 通道按需回数，替代动辄数万字符的全量 JSON。
//
//   select —— 逗号分隔的 term 列表（取并集）：
//     #8                按节点 id 精确匹配（解析数字）
//     type=PrimitiveInt 按类型匹配（不区分大小写）
//     title~尺寸        按标题子串包含（不区分大小写）
//     空 / 缺省 = 不过滤（全部节点）；无法识别的 term 抛 Error。
//   fields —— 逗号分隔的字段白名单（title,type,mode,inputs,outputs,widgets_values,pos,size）：
//     空 / 缺省 = ["title","type","mode","inputs","outputs","widgets_values"]；id 始终保留；
//     未知字段名抛 Error。
//
//   返回普通可序列化对象：
//   { op:"get", projected:true, rev,
//     total:{nodes,links}, matched:{count,ids},
//     nodes:[{id, …白名单字段（节点上存在才带）}…按 id 升序],
//     links:[fromNode 或 toNode 命中即保留的链接行（原结构）] }
//
//   纯数据变换：不依赖宿主 / 前端 / 网络；可直接对历史快照跑。
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_FIELDS = ["title", "type", "mode", "inputs", "outputs", "widgets_values", "pos", "size"];
const DEFAULT_FIELDS = ["title", "type", "mode", "inputs", "outputs", "widgets_values"];

// 数值容错解析：number 或可转数字的字符串 → number；否则 null
function parseId(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// id 升序：数值优先，非数值回落字符串序
function cmpIds(a, b) {
  const an = parseId(a);
  const bn = parseId(b);
  if (an !== null && bn !== null) return an - bn;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// 链接匹配键：8 与 "8" 归一为同一 id；非数值按字符串
function idKey(v) {
  const n = parseId(v);
  return n === null ? `s:${String(v)}` : `n:${n}`;
}

function resolveFields(fields) {
  if (fields === undefined || fields === null) return DEFAULT_FIELDS.slice();
  if (typeof fields !== "string") throw new Error(`fields 必须是逗号分隔的字符串（收到 ${typeof fields}）`);
  const names = fields.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return DEFAULT_FIELDS.slice();
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (!ALLOWED_FIELDS.includes(name)) {
      throw new Error(`fields 不支持该字段："${name}"（允许值仅限：${ALLOWED_FIELDS.join(",")}；id 始终保留）`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function resolveMatchers(select) {
  if (select === undefined || select === null) return null;
  if (typeof select !== "string") throw new Error(`select 必须是逗号分隔的字符串（收到 ${typeof select}）`);
  const terms = select.split(",").map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return null;
  const matchers = [];
  for (const term of terms) {
    if (term.startsWith("#")) {
      const m = /^#(\d+)$/.exec(term);
      if (!m) throw new Error(`select 语法不支持："${term}"（#<id> 后应为数字，如 #8）`);
      const want = Number(m[1]);
      matchers.push((node) => parseId(node.id) === want);
      continue;
    }
    if (/^type=/i.test(term)) {
      const want = term.slice(5).trim().toLowerCase();
      if (!want) throw new Error(`select 语法不支持："${term}"（type= 后应为类型名，如 type=PrimitiveInt）`);
      matchers.push((node) => String(node.type ?? "").toLowerCase() === want);
      continue;
    }
    if (/^title~/i.test(term)) {
      const want = term.slice(6).trim().toLowerCase();
      if (!want) throw new Error(`select 语法不支持："${term}"（title~ 后应为子串，如 title~尺寸）`);
      matchers.push((node) => String(node.title ?? "").toLowerCase().includes(want));
      continue;
    }
    throw new Error(`select 语法不支持："${term}"（可用：#<id> 或 type=<类型> 或 title~<子串>，逗号分隔取并集）`);
  }
  return matchers;
}

/**
 * 投影：选子图（select）+ 选字段（fields），返回普通可序列化对象。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 * @param {{select?: string, fields?: string}} [opts]
 */
export function projectGraph(graph, { select, fields } = {}) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`projectGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  const fieldList = resolveFields(fields);
  const matchers = resolveMatchers(select);

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const matchedNodes = rawNodes.filter(
    (node) => node && typeof node === "object" && (matchers === null || matchers.some((fn) => fn(node))),
  );
  matchedNodes.sort((a, b) => cmpIds(a.id, b.id));

  const idSet = new Set(matchedNodes.map((n) => idKey(n.id)));
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  const links = rawLinks.filter((row) => Array.isArray(row) && (idSet.has(idKey(row[1])) || idSet.has(idKey(row[3]))));

  const nodes = matchedNodes.map((node) => {
    const out = { id: node.id };
    for (const f of fieldList) {
      if (Object.prototype.hasOwnProperty.call(node, f)) out[f] = node[f];
    }
    return out;
  });

  return {
    op: "get",
    projected: true,
    rev: graph.revision ?? null,
    total: { nodes: rawNodes.length, links: rawLinks.length },
    matched: { count: matchedNodes.length, ids: matchedNodes.map((n) => n.id) },
    nodes,
    links,
  };
}
