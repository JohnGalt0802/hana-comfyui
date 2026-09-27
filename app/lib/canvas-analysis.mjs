// app/lib/canvas-analysis.mjs — 画布语义层 P2：体检 check + 追踪 trace（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// 两个纯函数，输入都是「UI 格式 JSON」（前端 graph.toJSON() 的输出）；分析全在数据侧做，
// 供 canvas check / trace 直接使用（参数不透传桥）。
//
// ① analyzeGraph(graph) —— 体检 v0（注释类节点 Note / MarkdownNote 整体跳过）：
//    互斥口径：每节点最多一条 issue，优先级 DANGLING > OUTPUT_UNWIRED > MUTED_BYPASSED
//    DANGLING        warn：既无输入连线（inputs 全 link 空/缺）也无输出连线（outputs 全 links 空/缺）
//    OUTPUT_UNWIRED  warn：type 匹配 /^(Save|Preview)/i，且 inputs 非空且存在未接（link=null）输入
//    MUTED_BYPASSED  info：mode 2=mute / 4=bypass
//    返回 {op:"check", rev, scanned:{nodes,links}, issueCount, issues:[…按 node id 升序]}
//    issue 项：{level, code, node, type, title, msg}（title 缺省为 ""）
//
// ② traceGraph(graph, { node, slot, dir }) —— 单步追踪（v0 不做多级链）：
//    node 必填（数字或字符串 id）；slot 必填（名字或索引：字符串先按名字匹配，不中回退数字索引）；
//    dir="up"（默认）→ 该输入槽的直接来源；dir="down" → 该输出槽的全部直接目标
//    （down 时对 links 表缺失的引用如实计数进 note，不静默丢弃）。
//    找不到节点/槽/连线 → resolved:"none" + note（正常回答，不抛错）；
//    graph 非对象或 node/slot 缺参 → 抛 Error。
// ─────────────────────────────────────────────────────────────────────────────

const NOTE_TYPE_RE = /^(markdown)?note$/i;
const SAVE_PREVIEW_RE = /^(save|preview)/i;

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

// 宽松 id 相等：8 与 "8" 视为同一；无法数值化的按字符串全等
function idEq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (String(a) === String(b)) return true;
  const an = parseId(a);
  const bn = parseId(b);
  return an !== null && bn !== null && an === bn;
}

// 槽名清单（用于 none 时的候选提示）
function slotNames(slots) {
  return slots
    .filter((s) => s && typeof s === "object" && s.name != null)
    .map((s) => String(s.name));
}

// 槽解析：名字优先；字符串不中回退数字索引；不中 → -1
function resolveSlot(slots, slot) {
  if (!Array.isArray(slots)) return -1;
  if (typeof slot === "number") {
    return Number.isInteger(slot) && slot >= 0 && slot < slots.length ? slot : -1;
  }
  const wanted = String(slot).trim();
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s && typeof s === "object" && s.name != null && String(s.name) === wanted) return i;
  }
  if (/^\d+$/.test(wanted)) {
    const idx = Number(wanted);
    if (idx >= 0 && idx < slots.length) return idx;
  }
  return -1;
}

// 摘要里的 value 格式：单值给标量，多值给数组
function fmtValue(vals) {
  return vals.length === 1 ? JSON.stringify(vals[0]) : JSON.stringify(vals);
}

/**
 * 体检：悬空 / 输出未接 / mute·bypass。返回 {op:"check", rev, scanned, issueCount, issues}。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 */
export function analyzeGraph(graph) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`analyzeGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  const issues = [];

  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const type = String(node.type ?? "");
    if (NOTE_TYPE_RE.test(type)) continue; // 注释类节点整体跳过

    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    const outputs = Array.isArray(node.outputs) ? node.outputs : [];
    const hasIn = inputs.some((s) => s && typeof s === "object" && s.link != null);
    const hasOut = outputs.some((s) => s && typeof s === "object" && Array.isArray(s.links) && s.links.length > 0);
    const base = { node: node.id, type, title: typeof node.title === "string" ? node.title : "" };

    // 互斥口径：每节点最多一条 issue，优先级 DANGLING > OUTPUT_UNWIRED > MUTED_BYPASSED
    // （根因修好后，次级信息会在下次 check 中自然浮现）
    const dangling = !hasIn && !hasOut;
    const muted = node.mode === 2 || node.mode === 4;
    const loose = [];
    if (SAVE_PREVIEW_RE.test(type)) {
      inputs.forEach((s, i) => {
        if (s && typeof s === "object" && s.link == null) loose.push(s.name != null ? String(s.name) : `#${i}`);
      });
    }

    if (dangling) {
      issues.push({ level: "warn", code: "DANGLING", ...base, msg: "悬空：无任何连线" });
    } else if (loose.length > 0) {
      issues.push({ level: "warn", code: "OUTPUT_UNWIRED", ...base, msg: `输出未接：${loose.join("、")}` });
    } else if (muted) {
      issues.push({
        level: "info",
        code: "MUTED_BYPASSED",
        ...base,
        msg: node.mode === 2 ? "已 mute（不参与执行）" : "已 bypass（输入直通）",
      });
    }
  }

  issues.sort((a, b) => cmpIds(a.node, b.node));
  return {
    op: "check",
    rev: graph.revision ?? null,
    scanned: { nodes: rawNodes.length, links: rawLinks.length },
    issueCount: issues.length,
    issues,
  };
}

/**
 * 追踪：某端口的直接来源（up，默认）/ 全部直接目标（down）。单步 v0。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 * @param {{node: number|string, slot: number|string, dir?: "up"|"down"}} q
 */
export function traceGraph(graph, { node, slot, dir } = {}) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`traceGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  if (node === undefined || node === null || (typeof node === "string" && node.trim() === "")) {
    throw new Error("traceGraph: node 必填（目标节点 id，数字或字符串）");
  }
  if (slot === undefined || slot === null || (typeof slot === "string" && slot.trim() === "")) {
    throw new Error("traceGraph: slot 必填（名字或索引）");
  }
  const direction = dir === undefined || dir === null ? "up" : String(dir).trim().toLowerCase();
  if (direction !== "up" && direction !== "down" && direction !== "") {
    throw new Error(`traceGraph: dir 只能是 "up" 或 "down"（收到 ${JSON.stringify(String(dir))}）`);
  }
  const dirNorm = direction === "down" ? "down" : "up";

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  const findNode = (id) => rawNodes.find((n) => n && typeof n === "object" && idEq(n.id, id));
  const findLink = (lid) => rawLinks.find((row) => Array.isArray(row) && idEq(row[0], lid));

  const target = findNode(node);
  if (!target) {
    return {
      op: "trace",
      dir: dirNorm,
      query: { node, slot },
      resolved: "none",
      note: `找不到节点 #${String(node)}`,
      summary: `#${String(node)} 不在当前画布中`,
    };
  }

  if (dirNorm === "up") {
    const inputs = Array.isArray(target.inputs) ? target.inputs : [];
    const idx = resolveSlot(inputs, slot);
    if (idx < 0) {
      const names = slotNames(inputs);
      const note = `节点 #${String(node)} 没有输入槽 ${JSON.stringify(slot)}；可用：${names.length ? names.join("、") : "（无）"}`;
      return { op: "trace", dir: "up", query: { node, slot }, resolved: "none", note, summary: `#${String(node)}.${String(slot)} 无此输入槽` };
    }
    const inp = inputs[idx];
    const label = `#${String(node)}.${inp.name != null ? String(inp.name) : idx}`;
    if (inp.link == null) {
      const note = `${label} 暂无所连来源`;
      return { op: "trace", dir: "up", query: { node, slot }, resolved: "none", note, summary: note };
    }
    const row = findLink(inp.link);
    if (!row) {
      const note = `${label} 的连线（link=${String(inp.link)}）在 links 表中缺失`;
      return { op: "trace", dir: "up", query: { node, slot }, resolved: "none", note, summary: note };
    }
    const srcId = row[1];
    const srcSlot = row[2];
    const srcNode = findNode(srcId);
    const srcOut = srcNode && Array.isArray(srcNode.outputs) ? srcNode.outputs[srcSlot] : null;
    const srcType = srcNode && srcNode.type != null ? String(srcNode.type) : row[5] != null ? String(row[5]) : "";
    const source = {
      node: srcId,
      slot: srcSlot,
      slotName: srcOut && srcOut.name != null ? String(srcOut.name) : `#${String(srcSlot)}`,
      type: srcType,
    };
    if (srcNode && typeof srcNode.title === "string" && srcNode.title !== "") source.title = srcNode.title;
    if (srcNode && Array.isArray(srcNode.widgets_values) && srcNode.widgets_values.length > 0) source.widgets_values = srcNode.widgets_values;

    let inner = `${srcType}`;
    if (source.title !== undefined) inner += `「${source.title}」`;
    if (source.widgets_values !== undefined) inner += `，value=${fmtValue(source.widgets_values)}`;
    return {
      op: "trace",
      dir: "up",
      query: { node, slot },
      resolved: "link",
      linkId: row[0],
      source,
      summary: `${label} ← #${String(srcId)}（${inner}）`,
    };
  }

  // dirNorm === "down"
  const outputs = Array.isArray(target.outputs) ? target.outputs : [];
  const idx = resolveSlot(outputs, slot);
  if (idx < 0) {
    const names = slotNames(outputs);
    const note = `节点 #${String(node)} 没有输出槽 ${JSON.stringify(slot)}；可用：${names.length ? names.join("、") : "（无）"}`;
    return { op: "trace", dir: "down", query: { node, slot }, resolved: "none", note, summary: `#${String(node)}.${String(slot)} 无此输出槽` };
  }
  const out = outputs[idx];
  const outLabel = `#${String(node)}.${out.name != null ? String(out.name) : idx}`;
  const linkIds = Array.isArray(out.links) ? out.links : [];
  const targets = [];
  let missingRefs = 0;
  for (const lid of linkIds) {
    const row = findLink(lid);
    if (!row) {
      missingRefs += 1; // 如实计数：不静默丢弃
      continue;
    }
    const toNode = findNode(row[3]);
    const inSlot = toNode && Array.isArray(toNode.inputs) ? toNode.inputs[row[4]] : null;
    const item = {
      linkId: row[0],
      node: row[3],
      slot: row[4],
      slotName: inSlot && inSlot.name != null ? String(inSlot.name) : `#${String(row[4])}`,
      type: toNode && toNode.type != null ? String(toNode.type) : row[5] != null ? String(row[5]) : "",
    };
    if (toNode && typeof toNode.title === "string" && toNode.title !== "") item.title = toNode.title;
    targets.push(item);
  }
  if (!targets.length) {
    if (missingRefs > 0) {
      // 与「确实没有连接」区分：有引用但查不到
      const note = `有 ${missingRefs} 条引用无法解析（links 表缺失）`;
      return { op: "trace", dir: "down", query: { node, slot }, resolved: "none", note, summary: `${outLabel} ${note}` };
    }
    const note = `${outLabel} 暂无所连去向`;
    return { op: "trace", dir: "down", query: { node, slot }, resolved: "none", note, summary: note };
  }
  const result = {
    op: "trace",
    dir: "down",
    query: { node, slot },
    resolved: "links",
    targets,
    summary: `${outLabel} → ${targets.map((t) => `#${String(t.node)}.${t.slotName}`).join("、")}`,
  };
  if (missingRefs > 0) result.note = `有 ${missingRefs} 条引用在 links 表中缺失`;
  return result;
}
