// app/lib/canvas-analysis.mjs — 画布语义层 P2：体检 check + 追踪 trace（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// 两个纯函数，输入都是「UI 格式 JSON」（前端 graph.toJSON() 的输出）；分析全在数据侧做，
// 供 canvas check / trace 直接使用（参数由 app 层消费）。
//
// T2 更新（2026-10-09）：check 规则集扩容（rules 裁剪 / MISSING_REQUIRED / DOMAIN_*）；
// trace 多级链（multi / depth）；输出统一附加 semanticRev；issue / 链级附节点符号
// （符号函数见 canvas-symbol.mjs）。全部向后兼容：缺省调用的检出行为与旧版一致（仅新增字段）。
//
// ① analyzeGraph(graph, { rules, objectInfo }) —— 体检：
//    缺省 rules = 核心 3 码（与旧版一致）：
//    互斥口径：连接性家族每节点最多一条 issue，优先级
//      DANGLING > OUTPUT_UNWIRED > MISSING_REQUIRED > MUTED_BYPASSED（后两码见下）
//    DANGLING        warn：既无输入连线（inputs 全 link 空/缺）也无输出连线（outputs 全 links 空/缺）
//    OUTPUT_UNWIRED  warn：type 匹配 /^(Save|Preview)/i，且 inputs 中存在未接（link=null 且非 widget）
//                    输入（2026-10-08 P7 修复：新前端把「可转输入」的 widget 也序列化进 inputs，
//                    如 {name:"filename_prefix",widget:{…},link:null}——不是「未接插座」，须排除）
//    MUTED_BYPASSED  info：mode 2=mute / 4=bypass
//    MISSING_REQUIRED warn：必填输入未接（需 rules 含 "missing_required"；依赖 objectInfo）。
//                    判定：objectInfo（ComfyUI /object_info，{类型:{input:{required,optional}}}）中
//                    required 声明里「非 widget 类型（或 forceInput:true）」的输入，若槽缺失、
//                    或 link=null 且无 widget 标记 → 报。节点类型不在 objectInfo → 跳过该节点；
//                    未提供 objectInfo（或格式无效）→ 整条规则跳过并记入 warnings（不报 issue）。
//    DOMAIN_*        warn：领域规则（需显式启用；与连接性家族正交共报，每规则每节点最多一条；
//                    值读取顺序：连线来源（含一跳 Primitive 解析）→ widgets_values_named →
//                    已知类型位置回退表（旧序列化）；无法解析 → 跳过不猜）：
//      domain_div16         width/height 应为 16 的倍数
//      domain_steps_range   采样步数应在 1..150
//      domain_save_name     保存文件名/前缀非空
//      domain_denoise_range denoise 应在 0..1
//    rules（规则集裁剪）：数组或逗号分隔字符串；可用 id：
//      "dangling" / "output_unwired" / "muted_bypassed"（核心）、"missing_required"、
//      "domain_div16" / "domain_steps_range" / "domain_save_name" / "domain_denoise_range"；
//      组记号 "core"（核心三码）/ "domain"（全部领域规则）/ "all"（全部）。
//      空 / 缺省 = 核心三码。未知 id → 抛 Error。
//    返回 {op:"check", semanticRev, rev, rules:[生效规则id按固定次序], scanned:{nodes,links},
//          issueCount, issues:[{level,code,node,type,title,msg,symbol}…按 node id 升序、
//          同节点按规则固定次序], warnings?（仅在非空时出现）}
//
// ② traceGraph(graph, { node, slot, dir, multi, depth }) —— 追踪：
//    单步（缺省；行为与旧版一致）：
//    node 必填（数字或字符串 id）；slot 必填（名字或索引：字符串先按名字匹配，不中回退数字索引）；
//    dir="up"（默认）→ 该输入槽的直接来源；dir="down" → 该输出槽的全部直接目标
//    （down 时对 links 表缺失的引用如实计数进 note，不静默丢弃）。
//    多级（multi:true 或 depth:N 显式启用）：返回有序完整链 path[]，每级
//    {node, dir:"in"|"out", slot, slotName, linkId?（仅 in 级）, value?, symbol?}；
//    up 链自源头到查询槽、down 链自查询槽到端点，DFS 顺序（分支按槽序）；depth 缺省 10、
//    上限 1000；触顶（truncated:true）/环路/引用缺失如实记入 note。
//    找不到节点/槽/连线 → resolved:"none" + note（正常回答，不抛错）；
//    graph 非对象或 node/slot 缺参 → 抛 Error。
// ─────────────────────────────────────────────────────────────────────────────
import { SEMANTIC_REV, formatNodeSymbol } from "./canvas-symbol.mjs";

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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ═══════════════════════════════════════════════════════════════════════════
// check：规则集（T2）
// ═══════════════════════════════════════════════════════════════════════════

const WIDGET_CAPABLE_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);
const CORE_RULE_IDS = ["dangling", "output_unwired", "muted_bypassed"];
const DOMAIN_RULE_IDS = ["domain_div16", "domain_steps_range", "domain_save_name", "domain_denoise_range"];
// 固定次序：连接性家族按优先级在前，领域家族在后（rules 回显与同节点 issue 次序都用它）
const ALL_RULE_IDS = ["dangling", "output_unwired", "missing_required", "muted_bypassed", ...DOMAIN_RULE_IDS];
const CONN_PRIORITY = ["dangling", "output_unwired", "missing_required", "muted_bypassed"];
// 同节点多 issue 的固定次序（连接性 0..3，领域 4..7）
const CODE_RANK = {
  DANGLING: 0,
  OUTPUT_UNWIRED: 1,
  MISSING_REQUIRED: 2,
  MUTED_BYPASSED: 3,
  DOMAIN_DIV16: 4,
  DOMAIN_STEPS_RANGE: 5,
  DOMAIN_SAVE_NAME: 6,
  DOMAIN_DENOISE_RANGE: 7,
};

function resolveRules(rules) {
  if (rules === undefined || rules === null) return CORE_RULE_IDS.slice();
  let list;
  if (typeof rules === "string") list = rules.split(",");
  else if (Array.isArray(rules)) list = rules;
  else throw new Error(`rules 需要数组或逗号分隔字符串（收到 ${typeof rules}）`);
  list = list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return CORE_RULE_IDS.slice();
  const picked = new Set();
  for (const id of list) {
    if (id === "core") {
      CORE_RULE_IDS.forEach((r) => picked.add(r));
      continue;
    }
    if (id === "domain") {
      DOMAIN_RULE_IDS.forEach((r) => picked.add(r));
      continue;
    }
    if (id === "all") {
      ALL_RULE_IDS.forEach((r) => picked.add(r));
      continue;
    }
    if (ALL_RULE_IDS.includes(id)) {
      picked.add(id);
      continue;
    }
    throw new Error(`rules 不支持该规则："${id}"（可用：${ALL_RULE_IDS.join("、")}；组记号：core、domain、all）`);
  }
  return ALL_RULE_IDS.filter((r) => picked.has(r));
}

// 位置回退表（旧序列化无 widgets_values_named 时，仅对下列已知类型按位读取；其余跳过不猜）
const POS_WIDGET_MAP = {
  EmptyLatentImage: { width: 0, height: 1 },
  EmptySD3LatentImage: { width: 0, height: 1 },
  KSampler: { steps: 2, denoise: 6 },
  KSamplerAdvanced: { steps: 3 },
  BasicScheduler: { steps: 1, denoise: 2 },
  SaveImage: { filename_prefix: 0 },
  SaveAnimatedWEBP: { filename_prefix: 0 },
  SaveAnimatedPNG: { filename_prefix: 0 },
  SaveWEBM: { filename_prefix: 0 },
  SaveVideo: { filename_prefix: 0 },
};

// named 归一：{value:x} 形态取 value（与转换器口径一致）
function normVal(v) {
  return isPlainObject(v) && "value" in v ? v.value : v;
}

function namedGet(node, name) {
  const named = node.widgets_values_named;
  if (!isPlainObject(named) || !Object.prototype.hasOwnProperty.call(named, name)) return undefined;
  return normVal(named[name]);
}

function posGet(node, name) {
  const map = POS_WIDGET_MAP[String(node.type ?? "")];
  if (!map || map[name] === undefined) return undefined;
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  return map[name] < wv.length ? wv[map[name]] : undefined;
}

// 值解析（领域规则用）：连线的有效值优先（含一跳 Primitive 解析）→ named → 位置回退表；
// 无法解析 → null（跳过不猜；连线存在但来源不可判时不回退本节点 widget，避免旧值误报）
function resolveValue(node, name, rawNodes, rawLinks) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const slot = inputs.find((s) => s && typeof s === "object" && String(s.name) === name);
  if (slot && slot.link != null) {
    const row = rawLinks.find((r) => Array.isArray(r) && idEq(r[0], slot.link));
    if (!row) return null;
    const src = rawNodes.find((n) => n && typeof n === "object" && idEq(n.id, row[1]));
    if (!src) return null;
    let v = namedGet(src, "value");
    if (v === undefined && /^Primitive/i.test(String(src.type ?? ""))) {
      const wv = Array.isArray(src.widgets_values) ? src.widgets_values : [];
      if (wv.length >= 1) v = wv[0];
    }
    if (v === undefined) {
      const wv = Array.isArray(src.widgets_values) ? src.widgets_values : [];
      if (wv.length === 1) v = wv[0];
    }
    return v === undefined ? null : v;
  }
  let v = namedGet(node, name);
  if (v !== undefined) return v;
  v = posGet(node, name);
  return v === undefined ? null : v;
}

// 该节点是否存在 name 部件的「表面」（槽 / named / 位置表），供 domain_save_name 定目标
function hasWidgetSurface(node, name) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  if (inputs.some((s) => s && typeof s === "object" && String(s.name) === name)) return true;
  if (isPlainObject(node.widgets_values_named) && Object.prototype.hasOwnProperty.call(node.widgets_values_named, name)) return true;
  const map = POS_WIDGET_MAP[String(node.type ?? "")];
  return !!(map && map[name] !== undefined);
}

// ── 连接性家族（互斥：每节点最多一条，按 CONN_PRIORITY） ──────────────────────

function connDangling(node) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  const hasIn = inputs.some((s) => s && typeof s === "object" && s.link != null);
  const hasOut = outputs.some((s) => s && typeof s === "object" && Array.isArray(s.links) && s.links.length > 0);
  if (hasIn || hasOut) return null;
  return { level: "warn", code: "DANGLING", msg: "悬空：无任何连线" };
}

function connOutputUnwired(node, type) {
  if (!SAVE_PREVIEW_RE.test(type)) return null;
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const loose = [];
  inputs.forEach((s, i) => {
    // 2026-10-08（P7 修复）：条件追加 !s.widget——新前端把「可转输入」的 widget 也
    // 序列化进 inputs（link 为 null 但带 widget 字段），这类不是「未接插座」，跳过；
    // 否则 SaveImage 的 filename_prefix 会被误报 OUTPUT_UNWIRED。
    if (s && typeof s === "object" && s.link == null && !s.widget) loose.push(s.name != null ? String(s.name) : `#${i}`);
  });
  if (!loose.length) return null;
  return { level: "warn", code: "OUTPUT_UNWIRED", msg: `输入未接：${loose.join("、")}` };
}

// 必填输入判定：非 widget 类型（或 forceInput:true）才要求连线
function isLinkRequiredSpec(spec) {
  if (!Array.isArray(spec)) return false;
  const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0] ?? "");
  const opts = spec[1];
  if (isPlainObject(opts) && opts.forceInput === true) return true;
  return !WIDGET_CAPABLE_TYPES.has(t);
}

function connMissingRequired(node, objectInfo) {
  const info = objectInfo[String(node.type ?? "")];
  if (!isPlainObject(info) || !isPlainObject(info.input)) return null;
  const required = isPlainObject(info.input.required) ? info.input.required : null;
  if (!required) return null;
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const missing = [];
  for (const [name, spec] of Object.entries(required)) {
    if (!isLinkRequiredSpec(spec)) continue;
    const slot = inputs.find((s) => s && typeof s === "object" && String(s.name) === name);
    if (!slot) {
      missing.push(name); // 连槽都没有 → 必然未接
      continue;
    }
    if (slot.link == null && !slot.widget) missing.push(name);
  }
  if (!missing.length) return null;
  return { level: "warn", code: "MISSING_REQUIRED", msg: `必填输入未接：${missing.join("、")}` };
}

function connMuted(node) {
  if (node.mode !== 2 && node.mode !== 4) return null;
  return { level: "info", code: "MUTED_BYPASSED", msg: node.mode === 2 ? "已 mute（不参与执行）" : "已 bypass（输入直通）" };
}

function runConnRule(rid, node, ctx) {
  if (rid === "dangling") return connDangling(node);
  if (rid === "output_unwired") return connOutputUnwired(node, String(node.type ?? ""));
  if (rid === "missing_required") return ctx.objectInfoUsable ? connMissingRequired(node, ctx.objectInfo) : null;
  if (rid === "muted_bypassed") return connMuted(node);
  return null;
}

// ── 领域家族（正交共报；每规则每节点最多一条） ────────────────────────────────

function domainDiv16(node, ctx) {
  const bad = [];
  for (const name of ["width", "height"]) {
    const v = resolveValue(node, name, ctx.rawNodes, ctx.rawLinks);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v % 16 !== 0) bad.push(`${name}=${v}`);
  }
  if (!bad.length) return null;
  return { level: "warn", code: "DOMAIN_DIV16", msg: `尺寸非 16 的倍数：${bad.join("、")}` };
}

function domainStepsRange(node, ctx) {
  const v = resolveValue(node, "steps", ctx.rawNodes, ctx.rawLinks);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (Number.isInteger(v) && v >= 1 && v <= 150) return null;
  return { level: "warn", code: "DOMAIN_STEPS_RANGE", msg: `采样步数超范围：steps=${v}（应在 1..150）` };
}

function domainSaveName(node, ctx) {
  const bad = [];
  for (const name of ["filename_prefix", "filename"]) {
    if (!hasWidgetSurface(node, name)) continue;
    const v = resolveValue(node, name, ctx.rawNodes, ctx.rawLinks);
    if (v === null || v === undefined || typeof v !== "string") continue;
    if (v.trim() === "") bad.push(name);
  }
  if (!bad.length) return null;
  return { level: "warn", code: "DOMAIN_SAVE_NAME", msg: `保存文件名为空：${bad.join("、")}` };
}

function domainDenoiseRange(node, ctx) {
  const v = resolveValue(node, "denoise", ctx.rawNodes, ctx.rawLinks);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v >= 0 && v <= 1) return null;
  return { level: "warn", code: "DOMAIN_DENOISE_RANGE", msg: `denoise 超范围：denoise=${v}（应在 0..1）` };
}

function runDomainRule(rid, node, ctx) {
  if (rid === "domain_div16") return domainDiv16(node, ctx);
  if (rid === "domain_steps_range") return domainStepsRange(node, ctx);
  if (rid === "domain_save_name") return domainSaveName(node, ctx);
  if (rid === "domain_denoise_range") return domainDenoiseRange(node, ctx);
  return null;
}

/**
 * 体检：悬空 / 输入未接 / mute·bypass（核心，缺省）+ 必填未接 / 领域规则（可裁剪启用）。
 * 返回 {op:"check", semanticRev, rev, rules, scanned, issueCount, issues, warnings?}。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 * @param {{rules?: string|string[], objectInfo?: object}} [options]
 */
export function analyzeGraph(graph, options = {}) {
  if (graph === null || typeof graph !== "object") {
    throw new Error(`analyzeGraph: graph 非对象（收到 ${graph === null ? "null" : typeof graph}），需要 UI 格式 JSON（graph.toJSON() 输出）`);
  }
  const { rules, objectInfo } = options || {};
  const effectiveRules = resolveRules(rules);
  const ruleSet = new Set(effectiveRules);
  const connRules = CONN_PRIORITY.filter((r) => ruleSet.has(r));
  const domainRules = DOMAIN_RULE_IDS.filter((r) => ruleSet.has(r));

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];
  const warnings = [];
  const objectInfoUsable = isPlainObject(objectInfo);
  if (ruleSet.has("missing_required") && !objectInfoUsable) {
    warnings.push("未提供 object_info，MISSING_REQUIRED 规则已跳过");
  }
  const ctx = { objectInfo, objectInfoUsable, rawNodes, rawLinks };

  const issues = [];
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const type = String(node.type ?? "");
    if (NOTE_TYPE_RE.test(type)) continue; // 注释类节点整体跳过
    const base = { node: node.id, type, title: typeof node.title === "string" ? node.title : "" };

    // 连接性家族：按优先级取第一个命中（缺省三码时与旧版互斥口径完全一致）
    for (const rid of connRules) {
      const hit = runConnRule(rid, node, ctx);
      if (hit) {
        issues.push({ level: hit.level, code: hit.code, ...base, msg: hit.msg, symbol: formatNodeSymbol(node) });
        break;
      }
    }
    // 领域家族：正交共报
    for (const rid of domainRules) {
      const hit = runDomainRule(rid, node, ctx);
      if (hit) issues.push({ level: hit.level, code: hit.code, ...base, msg: hit.msg, symbol: formatNodeSymbol(node) });
    }
  }

  issues.sort((a, b) => {
    const c = cmpIds(a.node, b.node);
    return c !== 0 ? c : (CODE_RANK[a.code] ?? 99) - (CODE_RANK[b.code] ?? 99);
  });

  const result = {
    op: "check",
    semanticRev: SEMANTIC_REV,
    rev: graph.revision ?? null,
    rules: effectiveRules,
    scanned: { nodes: rawNodes.length, links: rawLinks.length },
    issueCount: issues.length,
    issues,
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// trace
// ═══════════════════════════════════════════════════════════════════════════

function withSemanticRev(r) {
  const { op, ...rest } = r;
  return { op, semanticRev: SEMANTIC_REV, ...rest };
}

/**
 * 追踪：某端口的直接来源（up，默认）/ 全部直接目标（down）。缺省单步；
 * multi:true 或 depth:N → 返回多级完整链 path[]。
 * @param {object} graph UI 格式 JSON（graph.toJSON() 输出）
 * @param {{node: number|string, slot: number|string, dir?: "up"|"down", multi?: boolean, depth?: number}} q
 */
export function traceGraph(graph, options = {}) {
  return withSemanticRev(_traceGraphImpl(graph, options));
}

function _traceGraphImpl(graph, options) {
  const { node, slot, dir, multi, depth } = options || {};
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

  // T2：multi / depth（depth 显式给出即视为启用多级）
  if (multi !== undefined && typeof multi !== "boolean") {
    throw new Error(`traceGraph: multi 只能是布尔值（收到 ${typeof multi}）`);
  }
  let wantMulti = multi === true;
  let maxDepth = 10;
  if (depth !== undefined && depth !== null) {
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 1000) {
      throw new Error(`traceGraph: depth 需要 1..1000 的整数（收到 ${JSON.stringify(depth)}）`);
    }
    wantMulti = true;
    maxDepth = depth;
  }

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph.links) ? graph.links : [];

  if (wantMulti) return multiTrace(rawNodes, rawLinks, node, slot, dirNorm, maxDepth);

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

// ── T2：多级链 ────────────────────────────────────────────────────────────────

function multiTrace(rawNodes, rawLinks, node, slot, dirNorm, maxDepth) {
  const findNode = (id) => rawNodes.find((n) => n && typeof n === "object" && idEq(n.id, id));
  const findLink = (lid) => rawLinks.find((row) => Array.isArray(row) && idEq(row[0], lid));
  const base = { op: "trace", dir: dirNorm, query: { node, slot }, multi: true, depth: maxDepth };
  const target = findNode(node);
  if (!target) {
    return { ...base, resolved: "none", note: `找不到节点 #${String(node)}`, summary: `#${String(node)} 不在当前画布中` };
  }

  const wvOf = (nd) => {
    const wv = Array.isArray(nd.widgets_values) ? nd.widgets_values : [];
    if (!wv.length) return undefined;
    return wv.length === 1 ? wv[0] : wv.slice();
  };
  const outEntry = (nd, slotIdx) => {
    const o = (Array.isArray(nd.outputs) ? nd.outputs : [])[slotIdx];
    const e = { node: nd.id, dir: "out", slot: slotIdx, slotName: o && o.name != null ? String(o.name) : `#${String(slotIdx)}` };
    const v = wvOf(nd);
    if (v !== undefined) e.value = v;
    e.symbol = formatNodeSymbol(nd);
    return e;
  };
  const inEntry = (nd, slotIdx, linkId) => {
    const s = (Array.isArray(nd.inputs) ? nd.inputs : [])[slotIdx];
    const e = { node: nd.id, dir: "in", slot: slotIdx, slotName: s && s.name != null ? String(s.name) : `#${String(slotIdx)}`, linkId };
    const v = wvOf(nd);
    if (v !== undefined) e.value = v;
    e.symbol = formatNodeSymbol(nd);
    return e;
  };
  const label = (e) => `#${String(e.node)}.${e.slotName}`;
  const shortVal = (v) => {
    let s = JSON.stringify(v);
    if (s === undefined) s = String(v);
    return s.length > 24 ? `${s.slice(0, 24)}…` : s;
  };
  const entryLabel = (e) => (e.value !== undefined ? `${label(e)}=${shortVal(e.value)}` : label(e));
  const fmtChain = (path) => path.map(entryLabel).join(" → ");
  const finish = (path, truncated, notes) => {
    const out = { ...base, resolved: "path", path, summary: fmtChain(path) };
    if (truncated) out.truncated = true;
    if (notes.length) out.note = notes.join("；");
    return out;
  };

  if (dirNorm === "up") {
    const inputs = Array.isArray(target.inputs) ? target.inputs : [];
    const idx = resolveSlot(inputs, slot);
    if (idx < 0) {
      const names = slotNames(inputs);
      const note = `节点 #${String(node)} 没有输入槽 ${JSON.stringify(slot)}；可用：${names.length ? names.join("、") : "（无）"}`;
      return { ...base, resolved: "none", note, summary: `#${String(node)}.${String(slot)} 无此输入槽` };
    }
    const inp = inputs[idx];
    const qLabel = `#${String(node)}.${inp.name != null ? String(inp.name) : idx}`;
    if (inp.link == null) {
      return { ...base, resolved: "none", note: `${qLabel} 暂无所连来源`, summary: `${qLabel} 暂无所连来源` };
    }
    const row0 = findLink(inp.link);
    if (!row0) {
      const note = `${qLabel} 的连线（link=${String(inp.link)}）在 links 表中缺失`;
      return { ...base, resolved: "none", note, summary: note };
    }

    const seen = new Set();
    let truncated = false;
    let cycle = false;
    let missing = 0;
    const path = [];
    const upChain = (nd, inIdx, remaining) => {
      const ins = Array.isArray(nd.inputs) ? nd.inputs : [];
      const s = ins[inIdx];
      if (!s || s.link == null) return;
      const row = findLink(s.link);
      if (!row) {
        missing += 1;
        return;
      }
      const lk = `l:${String(row[0])}`;
      if (seen.has(lk)) {
        cycle = true;
        return;
      }
      seen.add(lk);
      const srcId = row[1];
      const srcOut = row[2];
      const srcNode = findNode(srcId);
      if (srcNode) {
        const sIns = Array.isArray(srcNode.inputs) ? srcNode.inputs : [];
        if (remaining > 1) {
          for (let t = 0; t < sIns.length; t++) {
            if (sIns[t] && sIns[t].link != null) upChain(srcNode, t, remaining - 1);
          }
        } else if (sIns.some((x) => x && x.link != null)) {
          truncated = true;
        }
        path.push(outEntry(srcNode, srcOut));
        path.push(inEntry(nd, inIdx, s.link));
      } else {
        // 源节点缺失：按行数据容忍（与单步的容忍度一致）
        path.push({ node: srcId, dir: "out", slot: srcOut, slotName: `#${String(srcOut)}` });
        path.push(inEntry(nd, inIdx, s.link));
      }
    };
    upChain(target, idx, maxDepth);

    const notes = [];
    if (truncated) notes.push(`已达深度上限（depth=${maxDepth}），链可能未到端点`);
    if (missing > 0) notes.push(`有 ${missing} 条引用在 links 表中缺失`);
    if (cycle) notes.push("检测到环路，已截断");
    return finish(path, truncated, notes);
  }

  // dirNorm === "down"
  const outputs = Array.isArray(target.outputs) ? target.outputs : [];
  const idx = resolveSlot(outputs, slot);
  if (idx < 0) {
    const names = slotNames(outputs);
    const note = `节点 #${String(node)} 没有输出槽 ${JSON.stringify(slot)}；可用：${names.length ? names.join("、") : "（无）"}`;
    return { ...base, resolved: "none", note, summary: `#${String(node)}.${String(slot)} 无此输出槽` };
  }
  const out0 = outputs[idx];
  const outLabel = `#${String(node)}.${out0.name != null ? String(out0.name) : idx}`;
  const linkIds = Array.isArray(out0.links) ? out0.links : [];
  if (!linkIds.length) {
    return { ...base, resolved: "none", note: `${outLabel} 暂无所连去向`, summary: `${outLabel} 暂无所连去向` };
  }

  const seen = new Set();
  let truncated = false;
  let cycle = false;
  let missing = 0;
  let hits = 0;
  const path = [outEntry(target, idx)];
  const expand = (nd, oIdx, remaining) => {
    const o = (Array.isArray(nd.outputs) ? nd.outputs : [])[oIdx];
    const lids = o && Array.isArray(o.links) ? o.links : [];
    for (const lid of lids) {
      const row = findLink(lid);
      if (!row) {
        missing += 1;
        continue;
      }
      const lk = `l:${String(row[0])}`;
      if (seen.has(lk)) {
        cycle = true;
        continue;
      }
      seen.add(lk);
      const dstId = row[3];
      const inIdx = row[4];
      const dstNode = findNode(dstId);
      if (dstNode) path.push(inEntry(dstNode, inIdx, lid));
      else path.push({ node: dstId, dir: "in", slot: inIdx, slotName: `#${String(inIdx)}`, linkId: lid });
      hits += 1;
      if (remaining <= 1) {
        const outs = dstNode ? (Array.isArray(dstNode.outputs) ? dstNode.outputs : []) : [];
        if (outs.some((x) => x && Array.isArray(x.links) && x.links.length > 0)) truncated = true;
        continue;
      }
      if (dstNode) {
        const outs = Array.isArray(dstNode.outputs) ? dstNode.outputs : [];
        for (let oi = 0; oi < outs.length; oi++) {
          const oo = outs[oi];
          if (oo && Array.isArray(oo.links) && oo.links.length > 0) {
            path.push(outEntry(dstNode, oi));
            expand(dstNode, oi, remaining - 1);
          }
        }
      }
    }
  };
  expand(target, idx, maxDepth);

  if (hits === 0) {
    const note = missing > 0 ? `有 ${missing} 条引用无法解析（links 表缺失）` : `${outLabel} 暂无所连去向`;
    return { ...base, resolved: "none", note, summary: `${outLabel} ${note}` };
  }
  const notes = [];
  if (truncated) notes.push(`已达深度上限（depth=${maxDepth}），链可能未到端点`);
  if (missing > 0) notes.push(`有 ${missing} 条引用在 links 表中缺失`);
  if (cycle) notes.push("检测到环路，已截断");
  return finish(path, truncated, notes);
}
