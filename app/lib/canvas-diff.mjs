// app/lib/canvas-diff.mjs — 画布语义层 T2：两版语义 diff（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// diffGraph(base, next)：输入两份「UI 格式 JSON」（前端 graph.toJSON() 的输出），产出语义级差异。
// 语义口径（顺序无关；同图 → 全空 + clean:true；仅 linkId 变化不算差异）：
//   节点：按 id 配对；增/删/改。改 = title / type / mode / widgets_values（分值变化）/
//         widgets_values_named（按 key 拆条的 named 值对比，from/to 原样给出；两侧 named
//         齐全时逐键、缺一侧时整对象一条）。位置/尺寸等布局字段不参与 diff（布局噪音）。
//   连线：按「目标输入槽」配对（每个输入槽至多一条连线）；增/删；同槽换源 = 直替
//         （记录 before/after 源端）。linkId 本身不参与比较。
//   组：按 id 配对（无 id 回退 title；重名按出现序配对）；增/删/改（bounding / title）。
//   rev 元信息：{base, next} 原样带出（修订号变化但语义无差异时，摘要会显示 rev 走向）。
// 输出：{op:"diff", semanticRev, rev:{base,next}, clean, summary,
//        nodes:{added,removed,changed}, links:{added,removed,replaced},
//        groups:{added,removed,changed}}（各列表按 id / 目标槽 / 标题确定性排序；可直接序列化）。
// base / next 非对象 → 抛 Error。
// ─────────────────────────────────────────────────────────────────────────────
import { SEMANTIC_REV, formatNodeSymbol } from "./canvas-symbol.mjs";

// 数值容错解析：number 或可转数字的字符串 → number；否则 null
function parseId(v) {
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

// 宽松 id 相等
function idEq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (String(a) === String(b)) return true;
  const an = parseId(a);
  const bn = parseId(b);
  return an !== null && bn !== null && an === bn;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 稳定序列化（对象键排序）：顺序无关的深比较依据
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  const j = JSON.stringify(v);
  return j === undefined ? `undef:${String(v)}` : j;
}

function deepEq(a, b) {
  return stableJson(a) === stableJson(b);
}

function nodeBrief(n) {
  return {
    id: n.id,
    type: String(n.type ?? ""),
    title: typeof n.title === "string" ? n.title : "",
    symbol: formatNodeSymbol(n),
  };
}

function indexNodes(g) {
  const map = new Map();
  const rows = Array.isArray(g.nodes) ? g.nodes : [];
  for (const n of rows) {
    if (!n || typeof n !== "object") continue;
    const k = keyOf(n.id);
    if (!map.has(k)) map.set(k, n); // 重复 id 取首个（保持确定性）
  }
  return map;
}

// 连线索引：按「目标输入槽」配对（每个输入槽至多一条）
function indexLinks(g) {
  const map = new Map();
  const rows = Array.isArray(g.links) ? g.links : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const k = `${keyOf(row[3])}|${String(row[4])}`;
    if (!map.has(k)) {
      map.set(k, { linkId: row[0], from: row[1], fromSlot: row[2], to: row[3], toSlot: row[4], type: row.length > 5 ? row[5] : null });
    }
  }
  return map;
}

function slotEq(a, b) {
  if (String(a) === String(b)) return true;
  const an = parseId(a);
  const bn = parseId(b);
  return an !== null && bn !== null && an === bn;
}

function linkAdded(e) {
  return { from: e.from, fromSlot: e.fromSlot, to: e.to, toSlot: e.toSlot, type: e.type, linkId: e.linkId };
}

function groupBrief(g) {
  const out = {};
  if (g.id !== undefined && g.id !== null) out.id = g.id;
  out.title = typeof g.title === "string" ? g.title : "";
  out.bounding = g.bounding ?? null;
  return out;
}

function diffGroups(base, next) {
  const gsA = Array.isArray(base.groups) ? base.groups.filter(isPlainObject) : [];
  const gsB = Array.isArray(next.groups) ? next.groups.filter(isPlainObject) : [];
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  // ① 按 id 配对（两侧都有 id 时）
  const idMapA = new Map();
  gsA.forEach((g, i) => {
    if (g.id !== undefined && g.id !== null) idMapA.set(String(g.id), i);
  });
  gsB.forEach((g, j) => {
    if (g.id === undefined || g.id === null) return;
    const i = idMapA.get(String(g.id));
    if (i !== undefined && !usedA.has(i)) {
      pairs.push([i, j]);
      usedA.add(i);
      usedB.add(j);
    }
  });
  // ② 其余按 title 配对（重名按出现序）
  gsB.forEach((g, j) => {
    if (usedB.has(j)) return;
    const t = typeof g.title === "string" ? g.title : "";
    const i = gsA.findIndex((a, i2) => !usedA.has(i2) && (typeof a.title === "string" ? a.title : "") === t);
    if (i >= 0) {
      pairs.push([i, j]);
      usedA.add(i);
      usedB.add(j);
    }
  });

  const added = [];
  const removed = [];
  gsB.forEach((g, j) => {
    if (!usedB.has(j)) added.push(groupBrief(g));
  });
  gsA.forEach((g, i) => {
    if (!usedA.has(i)) removed.push(groupBrief(g));
  });
  const changed = [];
  for (const [i, j] of pairs) {
    const a = gsA[i];
    const b = gsB[j];
    const changes = [];
    if (!deepEq(a.bounding, b.bounding)) changes.push({ field: "bounding", from: a.bounding ?? null, to: b.bounding ?? null });
    const ta = typeof a.title === "string" ? a.title : "";
    const tb = typeof b.title === "string" ? b.title : "";
    if (ta !== tb) changes.push({ field: "title", from: a.title ?? null, to: b.title ?? null });
    if (changes.length) {
      const c = {};
      if (b.id !== undefined && b.id !== null) c.id = b.id;
      c.title = tb;
      c.changes = changes;
      changed.push(c);
    }
  }
  const byTitle = (x, y) => {
    if (x.title !== y.title) return x.title < y.title ? -1 : 1;
    return stableJson(x.bounding) < stableJson(y.bounding) ? -1 : stableJson(x.bounding) > stableJson(y.bounding) ? 1 : 0;
  };
  added.sort(byTitle);
  removed.sort(byTitle);
  changed.sort((x, y) => (x.title !== y.title ? (x.title < y.title ? -1 : 1) : cmpIds(x.id ?? 0, y.id ?? 0)));
  return { added, removed, changed };
}

/**
 * 语义级 diff：两份 UI 格式 JSON → 节点/连线/组差异 + rev 元信息。
 * @param {object} base 旧版 UI 格式 JSON
 * @param {object} next 新版 UI 格式 JSON
 */
export function diffGraph(base, next) {
  if (base === null || typeof base !== "object") {
    throw new Error(`diffGraph: base 非对象（收到 ${base === null ? "null" : typeof base}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  if (next === null || typeof next !== "object") {
    throw new Error(`diffGraph: next 非对象（收到 ${next === null ? "null" : typeof next}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }

  const baseNodes = indexNodes(base);
  const nextNodes = indexNodes(next);

  // ── 节点：增 / 删 ──
  const addedNodes = [];
  const removedNodes = [];
  for (const [k, n] of nextNodes) {
    if (!baseNodes.has(k)) addedNodes.push(nodeBrief(n));
  }
  for (const [k, n] of baseNodes) {
    if (!nextNodes.has(k)) removedNodes.push(nodeBrief(n));
  }
  addedNodes.sort((a, b) => cmpIds(a.id, b.id));
  removedNodes.sort((a, b) => cmpIds(a.id, b.id));

  // ── 节点：改（title/type/mode/widgets_values/named 值对比） ──
  const changedNodes = [];
  for (const [k, nA] of baseNodes) {
    const nB = nextNodes.get(k);
    if (!nB) continue;
    const changes = [];
    const tA = typeof nA.title === "string" ? nA.title : "";
    const tB = typeof nB.title === "string" ? nB.title : "";
    if (tA !== tB) changes.push({ field: "title", from: nA.title ?? null, to: nB.title ?? null });
    const tyA = String(nA.type ?? "");
    const tyB = String(nB.type ?? "");
    if (tyA !== tyB) changes.push({ field: "type", from: nA.type ?? null, to: nB.type ?? null });
    const mA = nA.mode ?? 0;
    const mB = nB.mode ?? 0;
    if (mA !== mB) changes.push({ field: "mode", from: nA.mode ?? null, to: nB.mode ?? null });
    if (!deepEq(nA.widgets_values, nB.widgets_values)) {
      changes.push({ field: "widgets_values", from: nA.widgets_values ?? null, to: nB.widgets_values ?? null });
    }
    const namedA = isPlainObject(nA.widgets_values_named) ? nA.widgets_values_named : null;
    const namedB = isPlainObject(nB.widgets_values_named) ? nB.widgets_values_named : null;
    if (namedA && namedB) {
      const keys = [...new Set([...Object.keys(namedA), ...Object.keys(namedB)])].sort();
      for (const key of keys) {
        const va = Object.prototype.hasOwnProperty.call(namedA, key) ? namedA[key] : undefined;
        const vb = Object.prototype.hasOwnProperty.call(namedB, key) ? namedB[key] : undefined;
        if (!deepEq(va, vb)) {
          changes.push({ field: `widgets_values_named.${key}`, from: va === undefined ? null : va, to: vb === undefined ? null : vb });
        }
      }
    } else if (namedA || namedB) {
      changes.push({ field: "widgets_values_named", from: namedA ?? null, to: namedB ?? null });
    }
    if (changes.length) {
      changedNodes.push({
        id: nB.id,
        type: String(nB.type ?? ""),
        title: typeof nB.title === "string" ? nB.title : "",
        symbol: formatNodeSymbol(nB),
        changes,
      });
    }
  }
  changedNodes.sort((a, b) => cmpIds(a.id, b.id));

  // ── 连线：增 / 删 / 直替 ──
  const baseLinks = indexLinks(base);
  const nextLinks = indexLinks(next);
  const addedLinks = [];
  const removedLinks = [];
  const replacedLinks = [];
  for (const [k, e] of nextLinks) {
    if (!baseLinks.has(k)) addedLinks.push(linkAdded(e));
  }
  for (const [k, e] of baseLinks) {
    if (!nextLinks.has(k)) removedLinks.push(linkAdded(e));
  }
  for (const [k, eB] of baseLinks) {
    const eN = nextLinks.get(k);
    if (!eN) continue;
    if (!idEq(eB.from, eN.from) || !slotEq(eB.fromSlot, eN.fromSlot)) {
      replacedLinks.push({
        to: eN.to,
        toSlot: eN.toSlot,
        before: { from: eB.from, fromSlot: eB.fromSlot },
        after: { from: eN.from, fromSlot: eN.fromSlot },
        type: eN.type,
      });
    }
  }
  const byTarget = (x, y) => {
    const c = cmpIds(x.to, y.to);
    if (c !== 0) return c;
    const xs = parseId(x.toSlot);
    const ys = parseId(y.toSlot);
    if (xs !== null && ys !== null) return xs - ys;
    return String(x.toSlot) < String(y.toSlot) ? -1 : String(x.toSlot) > String(y.toSlot) ? 1 : 0;
  };
  addedLinks.sort(byTarget);
  removedLinks.sort(byTarget);
  replacedLinks.sort(byTarget);

  // ── 组 ──
  const groups = diffGroups(base, next);

  // ── rev + 摘要 ──
  const revA = base.revision ?? null;
  const revB = next.revision ?? null;
  const clean =
    !addedNodes.length && !removedNodes.length && !changedNodes.length &&
    !addedLinks.length && !removedLinks.length && !replacedLinks.length &&
    !groups.added.length && !groups.removed.length && !groups.changed.length;
  const fmtRev = revA === revB ? String(revA ?? "无") : `${revA ?? "无"}→${revB ?? "无"}`;
  const summary = clean
    ? `无差异；rev ${fmtRev}`
    : `节点 +${addedNodes.length}/-${removedNodes.length}/改${changedNodes.length}；连线 +${addedLinks.length}/-${removedLinks.length}/直替${replacedLinks.length}；组 +${groups.added.length}/-${groups.removed.length}/改${groups.changed.length}；rev ${fmtRev}`;

  return {
    op: "diff",
    semanticRev: SEMANTIC_REV,
    rev: { base: revA, next: revB },
    clean,
    summary,
    nodes: { added: addedNodes, removed: removedNodes, changed: changedNodes },
    links: { added: addedLinks, removed: removedLinks, replaced: replacedLinks },
    groups,
  };
}
