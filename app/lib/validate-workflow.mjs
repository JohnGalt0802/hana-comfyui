// lib/validate-workflow.mjs — 提交前校验内核（纯函数，不碰网络/磁盘/process）
// 定位（John 2026-11-02）：只警告不硬拦 —— 给出结构化诊断，由 agent 决定提不提；
// errors/warnings 按 code 词表分级，不把结构性问题降级成 warning。
// 输入 workflow（UI 或 API 格式，自动判）+ T1 裁剪版 object-info，输出 { ok, format, errors, warnings, stats }。
// Violation 形状：{ code, node, title?, field?, message, suggestions? }。
// T1 裁剪结构（schema 1）：classes[类名] = { required: {输入名:"TYPE"}, optional: 同,
//   enums: {输入名:[选项...]}, outputs: ["TYPE",...] }。COMBO 在原始 /object_info 有两种载体
//   （spec[0] 选项数组 / "COMBO"+spec[1].options，2026-11-02 全语料普查两种并存），T1 统一收进 enums。
// 子图：借 workflow-tools.expandSubgraphs 拿展开产物（冻结文件不改）；展开后内部节点 id 是
//   `s<实例id>:<内部id>` 复合 id（与冻结文件同口径），所有报错都带这个 id。
// objectInfo 兼容两种入参：T1 裁剪结构（有 .classes）与 /object_info 原始形状（顶层即类名），
//   统一归一化成内部 classes 表；给 expandSubgraphs 的形状带 input 包装（它的子图定位依赖）。
import { convertUiToApi, expandSubgraphs, UNSUPPORTED_UI_TYPES } from "./workflow-tools.mjs";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);
// 与 workflow-tools.mjs 私有 NON_WIDGET_INPUT_TYPES 同名单（冻结文件未导出，按其口径抄全）：
// socket 类输入不是 widget，不占 widgets_values 位序。
const NON_WIDGET_INPUT_TYPES = new Set([
  "MODEL", "CLIP", "VAE", "CLIP_VISION", "CLIP_VISION_OUTPUT", "STYLE_MODEL", "UPSCALE_MODEL",
  "IMAGE", "MASK", "LATENT", "CONDITIONING", "CONTROL_NET", "SIGMAS", "SAMPLER", "GUIDER", "NOISE",
  "AUDIO", "VIDEO", "WEBCAM", "LATENT_UPSCALE", "GLIGEN", "TAESD",
]);
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const COMBO_TYPE_NAMES = new Set(["COMBO", "COMFY_DYNAMICCOMBO_V3", "EASY_COMBO"]);
// 与冻结文件私有 WIDGET_SPEC_TYPES 同名单（冻结文件未导出）：占 widgets_values 位的类型
const WIDGET_SPEC_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3", "AUTOCOMPLETE_TEXT_LORAS"]);
// COMFY_*_V3 动态构造（MATCHTYPE/AUTOGROW/DYNAMICCOMBO 等）：类型在运行时按接入物变化，静态检查不判
const isDynamicType = (t) => typeof t === "string" && t.startsWith("COMFY_");
const UUID_TYPE_RE = /^[0-9a-fA-F-]{20,}$/; // 子图实例的 type 是 UUID（与冻结文件同口径）
const REROUTE_TYPES = new Set(["Reroute", "rgthree-reroute"]); // 纯前端转发：outputs 槽类型不作判型依据

// ── objectInfo 归一化（两种入参 → 内部 classes 表）─────────────────────────────
// 条目形状：{ required:{名:类型}, optional:同, enums:{名:[选项]}, outputs:[类型], output_node:bool,
//   input:{required:{名:[spec]},optional:{…}} } —— input 包装仅供 expandSubgraphs 定位子图值用。
function normEntry() {
  return { required: {}, optional: {}, enums: {}, outputs: null, output_node: undefined, input: { required: {}, optional: {} } };
}

function toNormClasses(src) {
  const classes = {};
  for (const [name, cls] of Object.entries(src)) {
    if (!isPlainObject(cls)) continue;
    const c = normEntry();
    for (const dir of ["required", "optional"]) {
      const m = isPlainObject(cls[dir]) ? cls[dir] : null;
      if (!m) continue;
      for (const [iname, t] of Object.entries(m)) {
        if (typeof t !== "string") continue;
        c[dir][iname] = t;
        const opts = isPlainObject(cls.enums) && Array.isArray(cls.enums[iname]) ? cls.enums[iname] : null;
        c.enums[iname] = opts;
        c.input[dir][iname] = opts ? [opts, {}] : [t, {}];
      }
    }
    if (Array.isArray(cls.outputs)) c.outputs = cls.outputs;
    c.output_node = cls.output_node === true ? true : cls.output_node === false ? false : undefined;
    classes[name] = c;
  }
  return classes;
}

// /object_info 原始形状 → 同一内部表（spec[0] 选项数组 或 "COMBO"+spec[1].options 两种载体都认）
function fromRawObjectInfo(raw) {
  const classes = {};
  for (const [name, info] of Object.entries(raw)) {
    if (!isPlainObject(info)) continue;
    const c = normEntry();
    const input = isPlainObject(info.input) ? info.input : {};
    for (const dir of ["required", "optional"]) {
      const m = isPlainObject(input[dir]) ? input[dir] : null;
      if (!m) continue;
      for (const [iname, spec] of Object.entries(m)) {
        if (!Array.isArray(spec) || spec.length === 0) continue;
        let t, opts = null;
        if (Array.isArray(spec[0])) { t = "COMBO"; opts = spec[0]; }
        else if (typeof spec[0] === "string") {
          t = spec[0];
          if (isPlainObject(spec[1]) && Array.isArray(spec[1].options)) opts = spec[1].options;
        } else continue;
        c[dir][iname] = t;
        if (opts) c.enums[iname] = opts;
        c.input[dir][iname] = opts ? [opts, {}] : [t, {}];
      }
    }
    if (Array.isArray(info.output)) c.outputs = info.output;
    c.output_node = info.output_node === true ? true : info.output_node === false ? false : undefined;
    classes[name] = c;
  }
  return classes;
}

// COMBO 判定与选项提取（内部表）：返回选项数组；null = 不是 COMBO 输入；[] = COMBO 家族但没留下选项（不猜）。
// 注意：COMFY_DYNAMICCOMBO_V3 的选项元素是 {key,...} 对象（2026-11-02 实测 TextGenerate.sampling_mode），
// 比较与 suggestions 都取 .key。
function enumKey(o) {
  return isPlainObject(o) && "key" in o ? o.key : o;
}
function comboOptions(cls, iname) {
  const t = typeof cls.required[iname] === "string" ? cls.required[iname] : typeof cls.optional[iname] === "string" ? cls.optional[iname] : null;
  if (!t) return null;
  const opts = cls.enums[iname];
  if (Array.isArray(opts)) return opts;
  if (COMBO_TYPE_NAMES.has(t)) return [];
  return null;
}

// type_mismatch 判定：任一侧缺类型 / `*` 通配 → 兼容（不猜）
function typeCompat(src, dst) {
  if (src === dst) return true;
  if (!src || !dst || src === "*" || dst === "*") return true;
  return false;
}

function hasAdapterRule(adapters, type) {
  if (!isPlainObject(adapters)) return false;
  const r = adapters[type];
  return isPlainObject(r) && r.virtual === true;
}
// ── 子图展开（借冻结文件 expandSubgraphs 拿展开产物与问题清单）───────────────────
// 展开后内部节点 id 变成 `s<实例id>:<内部id>`；同一子图被多个实例引用时各得一份复合 id。
// expandSubgraphs 的 problems 是纯中文句子，从「实例 #12」「「子图名」」里抠定位信息做 subgraph_unexpanded。
function expandForCheck(wf, fullShape) {
  const defs = isPlainObject(wf.definitions) ? wf.definitions.subgraphs : null;
  const hasDefs = Array.isArray(defs) && defs.length > 0;
  if (!hasDefs) {
    return { nodes: Array.isArray(wf.nodes) ? wf.nodes : [], links: Array.isArray(wf.links) ? wf.links : [], expanded: false, subgraphProblems: [] };
  }
  const defById = new Map();
  for (const d of defs) if (isPlainObject(d) && typeof d.id === "string" && d.id) defById.set(d.id, d);
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const isInst = (n) => isPlainObject(n) && defById.has(String(n.type));
  if (!nodes.some(isInst)) {
    // 顶层无实例：定义只是随行（模板常见形态），无运行语义，不展开也不校验定义内部节点
    return { nodes, links: Array.isArray(wf.links) ? wf.links : [], expanded: false, subgraphProblems: [] };
  }
  // 有实例：交给冻结文件的展开逻辑（它对展开失败的场景推 problems 后继续，不抛）。
  // objectInfo 给展开逻辑的形状：类名 → { input: { required/optional 带包装的 spec } }
  //（它的 subgraphWidgetIndexOf 只读 info.input.required[name]，完整形状由 validateUiWorkflow 统一备好）。
  const problems = [];
  const warnings = [];
  const expanded = expandSubgraphs(wf, problems, fullShape, warnings);
  return {
    nodes: Array.isArray(expanded.nodes) ? expanded.nodes : nodes,
    links: Array.isArray(expanded.links) ? expanded.links : (Array.isArray(wf.links) ? wf.links : []),
    expanded: true,
    subgraphProblems: problems.map(subgraphViolation),
  };
}

function subgraphViolation(msg) {
  const m = /实例\s*#(-?\d+)/.exec(msg);
  const nm = /「([^」]+)」/.exec(msg);
  const v = { code: "subgraph_unexpanded", node: m ? m[1] : null, field: "definitions.subgraphs", message: msg };
  if (nm) v.title = nm[1];
  return v;
}

// widget 值解析：named 优先（值可能是 {value} 包装），无 named 按位序（口径与冻结文件 declaredWidgetSlots
// 一致：声明序枚举 widget 输入，seed/noise_seed 的 control_after_generate 副值多占一格）。
// 返回 Map(输入名 → 值)。
function widgetValues(n, cls) {
  const named = isPlainObject(n.widgets_values_named) ? n.widgets_values_named : null;
  const wv = Array.isArray(n.widgets_values) ? n.widgets_values : null;
  const unwrap = (v) => (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, "value") ? v.value : v);
  const out = new Map();
  const declared = [...Object.keys(cls.required), ...Object.keys(cls.optional)];
  if (named) {
    for (const name of declared) {
      if (!Object.prototype.hasOwnProperty.call(named, name)) continue;
      const val = unwrap(named[name]);
      if (val !== undefined) out.set(name, val);
    }
    return out;
  }
  if (!wv) return out;
  // 位序：优先实例槽证据（inputs 里带 widget 标记的槽序），否则按声明序
  const slotWidgets = Array.isArray(n.inputs) ? n.inputs.filter((s) => isPlainObject(s) && isPlainObject(s.widget) && typeof s.name === "string") : [];
  let names;
  if (slotWidgets.length > 0) {
    names = slotWidgets.map((s) => s.name);
  } else {
    names = declared.filter((name) => {
      const t = typeof cls.required[name] === "string" ? cls.required[name] : cls.optional[name];
      return typeof t === "string" && WIDGET_SPEC_TYPES.has(t);
    });
  }
  let pos = 0;
  for (const name of names) {
    if (pos >= wv.length) break;
    const val = unwrap(wv[pos]);
    if (val !== undefined && !out.has(name)) out.set(name, val);
    pos += 1;
    if ((name === "seed" || name === "noise_seed") && typeof wv[pos] === "string" && SEED_CONTROL_VALUES.has(wv[pos])) pos += 1;
  }
  return out;
}
export function validateWorkflow(input) {
  try {
    return impl(input);
  } catch (e) {
    return {
      ok: false,
      format: "ui",
      errors: [{ code: "internal", node: null, message: `校验内核内部异常：${e && e.message ? e.message : String(e)}` }],
      warnings: [],
      stats: { nodeCount: 0, linkCount: 0, unknownCount: 0, checkedEnums: 0 },
    };
  }
}

const failFast = (message) => ({
  ok: false,
  format: "ui",
  errors: [{ code: "internal", node: null, message }],
  warnings: [],
  stats: { nodeCount: 0, linkCount: 0, unknownCount: 0, checkedEnums: 0 },
});

function impl(input) {
  if (!isPlainObject(input)) return failFast("input 需要对象");
  const wf = input.workflow;
  if (!isPlainObject(wf)) return failFast("workflow 需要对象");
  const rawOI = input.objectInfo;
  if (!isPlainObject(rawOI)) return failFast("objectInfo 需要对象");
  const options = isPlainObject(input.options) ? input.options : {};
  const adapters = input.adapters;

  // ── 格式判定：API 格式是 {id:{class_type, inputs}}（无 nodes 数组）；UI 格式有 nodes 数组 ──
  const wfValues = Object.values(wf).filter(isPlainObject);
  const isApi = !Array.isArray(wf.nodes) && wfValues.length > 0 && wfValues.every((n) => typeof n.class_type === "string");
  const format = isApi ? "api" : "ui";

  // ── objectInfo 归一化：T1 裁剪结构（有 .classes）或 /object_info 原始形状（顶层即类名）──
  const classes = isPlainObject(rawOI.classes) ? toNormClasses(rawOI.classes) : fromRawObjectInfo(rawOI);
  if (Object.keys(classes).length === 0) return failFast("objectInfo 里没有任何节点类（classes 表为空）");

  const errors = [];
  const warnings = [];
  const stats = { nodeCount: 0, linkCount: 0, unknownCount: 0, checkedEnums: 0 };

  if (isApi) {
    validateApiPrompt(wf, classes, options, stats, errors, warnings);
  } else {
    // 转换兜底用完整形状：类名 → { input: { required/optional 带包装的 spec } }
    const fullShape = {};
    for (const [name, cls] of Object.entries(classes)) fullShape[name] = { input: cls.input };
    validateUiWorkflow(wf, classes, fullShape, options, adapters, stats, errors, warnings);
  }

  return { ok: errors.length === 0, format, errors, warnings, stats };
}

// ── API 格式：逐节点查 classes 表 + 枚举值域 ────────────────────────────────
// API 图的连线是 [originId, slot] 引用，类型可查；输出节点信息 classes 表带 output_node。
// no_output 与 UI 路径同一口径：能判定（classes 里有 output_node 字段）→ error；
// 拿不到该字段（T1 裁剪结构未带）→ warning 说明无法判定，不静默通过。
function validateApiPrompt(wf, classes, options, stats, errors, warnings) {
  for (const [id, node] of Object.entries(wf)) {
    if (!isPlainObject(node) || typeof node.class_type !== "string") continue;
    stats.nodeCount += 1;
    const cls = classes[node.class_type];
    if (!cls) {
      stats.unknownCount += 1;
      errors.push({ code: "unknown_type", node: id, message: `节点 ${id} 的类型 ${node.class_type} 不在 objectInfo.classes 里` });
      continue;
    }
    const inputs = isPlainObject(node.inputs) ? node.inputs : {};
    for (const [iname, val] of Object.entries(inputs)) {
      if (Array.isArray(val)) continue; // 连线引用：类型检查需要全图连线图，这里不查（UI 路径同款不覆盖）
      const opts = comboOptions(cls, iname);
      if (opts === null) continue;
      stats.checkedEnums += 1;
      if (opts.length === 0) continue;
      if (opts.some((o) => String(enumKey(o)) === String(val))) continue;
      errors.push({
        code: "enum_mismatch",
        node: id,
        field: iname,
        message: `节点 ${id}（${node.class_type}）输入「${iname}」的值 ${JSON.stringify(val)} 不在可选项里`,
        suggestions: opts.slice(0, 8).map(enumKey),
      });
    }
  }
  if (stats.nodeCount === 0) {
    errors.push({ code: "no_output", node: null, message: "工作流没有任何节点" });
  } else if (hasOutputNodeInfo(classes)) {
    const hasOut = Object.values(wf).some((n) => isPlainObject(n) && classes[n.class_type] && classes[n.class_type].output_node === true);
    if (!hasOut) errors.push({ code: "no_output", node: null, message: "工作流没有任何输出节点（output_node），提交必被拒" });
  } else {
    warnings.push({ code: "no_output", node: null, message: `无法确认是否有输出节点（缺少 output_node 信息；${stats.nodeCount} 个节点）` });
  }
}

function hasOutputNodeInfo(classes) {
  for (const cls of Object.values(classes)) if (cls.output_node !== undefined) return true;
  return false;
}

// ── UI 格式：展开子图 → 连线类型检查 → 逐节点检查 → no_output ─────────────────
function validateUiWorkflow(wf, classes, fullShape, options, adapters, stats, errors, warnings) {
  if (!Array.isArray(wf.nodes)) {
    errors.push({ code: "internal", node: null, message: "workflow 不是 UI 格式（nodes 不是数组）" });
    return;
  }
  const { nodes, links, expanded, subgraphProblems } = expandForCheck(wf, fullShape);
  for (const v of subgraphProblems) errors.push(v);

  // 连线索引：连线 id → { origin, originSlot, target, targetSlot, type }；统计只数有效项（与展开产物同源）
  const linkById = new Map();
  for (const l of links) {
    if (!Array.isArray(l) || l.length < 6) continue;
    linkById.set(String(l[0]), { origin: l[1], originSlot: l[2], target: l[3], targetSlot: l[4], type: l[5] });
  }
  stats.linkCount = linkById.size;
  const nodeById = new Map();
  for (const n of nodes) if (isPlainObject(n)) nodeById.set(String(n.id), n);

  // 源输出类型：优先实例 outputs 槽自述（连线重定向后的展开产物里也在），fallback classes.outputs[slot]
  const outTypeOf = (n, slot) => {
    const s = Array.isArray(n.outputs) && isPlainObject(n.outputs[slot]) && typeof n.outputs[slot].type === "string" ? n.outputs[slot].type : null;
    if (s !== null) return s;
    const cls = classes[String(n.type)];
    if (!cls || !Array.isArray(cls.outputs)) return null;
    return typeof cls.outputs[slot] === "string" ? cls.outputs[slot] : null;
  };

  if (options.checkTypes !== false) {
    for (const [lid, li] of linkById) {
      const on = nodeById.get(String(li.origin));
      const tn = nodeById.get(String(li.target));
      if (!on || !tn) continue; // 悬空连线：转换兜底路径管，不重复报
      if (Number(on.mode) === 2 || Number(on.mode) === 4) continue; // 静音/旁路不执行，死链不判型
      if (REROUTE_TYPES.has(String(on.type))) continue; // reroute 的槽类型不可信，穿透由转换器负责
      const tcls = classes[String(tn.type)];
      if (!tcls) continue; // 目标类型未知：unknown_type 已另有报告，无从判型
      const slot = Array.isArray(tn.inputs) && isPlainObject(tn.inputs[li.targetSlot]) ? tn.inputs[li.targetSlot] : null;
      const slotName = slot && typeof slot.name === "string" ? slot.name : null;
      if (!slotName) continue; // 无名槽/槽缺失：不猜
      const declared = typeof tcls.required[slotName] === "string" ? tcls.required[slotName] : typeof tcls.optional[slotName] === "string" ? tcls.optional[slotName] : null;
      if (declared === null) continue; // 动态输入槽：不报
      if (declared === "COMBO" || isDynamicType(declared)) continue; // COMBO/动态构造可接任意源（转枚举/运行时匹配），不判型
      const srcType = outTypeOf(on, li.originSlot);
      if (srcType === null) continue; // 源类型取不到：不猜
      // 实例槽自述类型（前端已物化的匹配结果）与源一致 → 兼容
      if (typeof slot.type === "string" && slot.type === srcType) continue;
      if (typeCompat(srcType, declared)) continue;
      errors.push({
        code: "type_mismatch",
        node: String(tn.id),
        field: slotName,
        message: `连线 ${lid}：来源 ${String(on.id)}（${String(on.type)}）输出槽 ${li.originSlot} 的类型 ${srcType} 与目标 ${String(tn.id)}（${String(tn.type)}）输入「${slotName}」声明的 ${declared} 不兼容`,
      });
    }
  }

  let hasOutputNode = false;
  for (const n of nodes) {
    if (!isPlainObject(n)) continue;
    const id = String(n.id);
    const type = String(n.type || "");
    if (NOTE_TYPES.has(type)) continue; // 纯前端注释件：无运行语义
    stats.nodeCount += 1;
    if (Number(n.mode) === 2 || Number(n.mode) === 4) continue; // 静音/旁路：不执行，跳过值域检查
    const cls = classes[type];
    if (!cls) {
      if (expanded && UUID_TYPE_RE.test(type)) continue; // 展开失败的实例残留：subgraph_unexpanded 已报，不重复
      if (UNSUPPORTED_UI_TYPES.has(type) || UUID_TYPE_RE.test(type)) {
        // 孤立的子图/环绕件（有实例时实例已被展开替换；剩下的都是没接线的孤件）：
        if (hasAdapterRule(adapters, type)) continue;
        errors.push({ code: "virtual_node", node: id, message: `节点 ${id} 类型 ${type} 是子图/环绕节点，且没有 virtual 适配档案，无法提交` });
      } else {
        stats.unknownCount += 1;
        errors.push({ code: "unknown_type", node: id, message: `节点 ${id} 类型 ${type} 不在 objectInfo.classes 里` });
      }
      continue;
    }
    if (cls.output_node === true) hasOutputNode = true;
    // ── 逐输入检查 ──
    const vals = widgetValues(n, cls);
    const requiredNames = Object.keys(cls.required);
    // 连线槽名集合：以连线表为准（「被喂入」不看 slot.link 单字段，防槽字段与 links 数组漂移）
    const fedSlots = new Set();
    for (const [lid, li] of linkById) {
      if (String(li.target) === id) {
        const slot = Array.isArray(n.inputs) ? n.inputs[li.targetSlot] : null;
        if (isPlainObject(slot) && typeof slot.name === "string") fedSlots.add(slot.name);
        else fedSlots.add(`#${li.targetSlot}`); // 无名/越界槽也标记，避免误报 missing_required
      }
    }
    for (const iname of requiredNames) {
      const t = cls.required[iname];
      // 连线占位：精确名或前缀名（autogrow 动态子槽 values.a 归属于声明名 values，2026-11-02 实测）都算被喂入
      const isFed = fedSlots.has(iname) || [...fedSlots].some((s) => s.startsWith(iname + "."));
      if (isFed) continue;
      const hasWidgetVal = vals.has(iname);
      if (!hasWidgetVal) {
        // 动态构造（AUTOGROW 等）的空缺取决于运行时模板展开，静态判不了：降为 warning（只警告不硬拦）
        if (isDynamicType(t)) {
          warnings.push({ code: "missing_required", node: id, field: iname, message: `节点 ${id}（${type}）的必填输入「${iname}」（${t} 动态构造）当前既没有连线也没有值，是否能空缺取决于后端模板展开，请自行确认` });
          continue;
        }
        // required 但既没连线也没值：widget 可能性不存在（forceInput 型必连；widget 型缺值）——两种都报
        const canWidget = !NON_WIDGET_INPUT_TYPES.has(t);
        errors.push({
          code: "missing_required",
          node: id,
          field: iname,
          message: `节点 ${id}（${type}）的必填输入「${iname}」既没有连线也没有值`,
          suggestions: canWidget ? undefined : [`输入「${iname}」是 ${t} 类型，需要从上游连线接入`],
        });
        continue;
      }
      // 枚举检查
      if (options.checkEnums === false) continue;
      const opts = comboOptions(cls, iname);
      if (opts === null || opts.length === 0) continue;
      stats.checkedEnums += 1;
      const val = vals.get(iname);
      if (opts.some((o) => String(enumKey(o)) === String(val))) continue;
      errors.push({
        code: "enum_mismatch",
        node: id,
        field: iname,
        message: `节点 ${id}（${type}）输入「${iname}」的值 ${JSON.stringify(val)} 不在可选项里`,
        suggestions: opts.slice(0, 8).map(enumKey),
      });
    }
  }
  // no_output：空图必报；有节点但没有任何 output_node 类时，缺 output_node 信息（T1 裁剪结构未带该字段）
  // 则只给 warning 说明无法判定，不硬报错。
  if (stats.nodeCount === 0) {
    errors.push({ code: "no_output", node: null, message: "整图没有任何节点，提交必被拒" });
  } else if (!hasOutputNode) {
    if (hasOutputNodeInfo(classes)) {
      errors.push({ code: "no_output", node: null, message: `整图 ${stats.nodeCount} 个节点里没有任何输出节点（output_node），提交必被拒` });
    } else {
      warnings.push({ code: "no_output", node: null, message: `objectInfo 没带 output_node 字段，无法判定整图是否有输出节点（${stats.nodeCount} 个节点）` });
    }
  }

  // ── 转换兜底（任务书：两边的结论合并，不要二选一）────────────────────────────
  // convertUiToApi 有一批本函数没有的硬判定（连线缺失、未知 mode、R1 named/位置分歧、动态槽收编失败、
  // pull/passthrough 歧义）。跑一遍只取 problemsOut，分类后并入；产物丢弃。
  mergeConverterProblems(runConverter(wf, fullShape, adapters), classes, nodeById, errors, warnings);
}

function runConverter(wf, fullShape, adapters) {
  const problems = [];
  try {
    convertUiToApi(wf, fullShape, { adapters, problemsOut: problems });
  } catch { /* blocking 非空必 throw，problemsOut 在 throw 前已填充（workflow-tools 704 行） */ }
  return problems;
}

// 转换器问题 → 固定 code 词表的映射。分类不进的按 internal 落 errors（词表外判定也是「提交会被拒」
// 的事实，降 warning 会让 agent 拿着 ok:true 去撞墙）。
function mergeConverterProblems(problems, classes, nodeById, errors, warnings) {
  // 本函数自己产的问题不重复转手（两边同报一条事实只留一条）
  const seen = new Set([...errors, ...warnings].map((v) => `${v.code}|${v.node}|${v.field}|${v.message}`));
  const push = (code, node, field, message, extra) => {
    const key = `${code}|${node}|${field}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const v = { code, node, message };
    if (field !== null && field !== undefined) v.field = field;
    if (extra) Object.assign(v, extra);
    errors.push(v);
  };
  for (const p of problems) {
    // 与自家结论同义的去重：同节点同类型（消息措辞不同也算同一条）
    const nm = /#(-?\d+)/.exec(p);
    const node = nm ? nm[1] : null;
    const sameFact = (code, nid) => [...errors, ...warnings].some((v) => v.code === code && String(v.node) === String(nid));
    if (/不在 \/object_info/.test(p)) {
      if (!sameFact("unknown_type", node) && !sameFact("virtual_node", node)) push("unknown_type", node, null, p);
    } else if (/（子图\/环绕节点）/.test(p)) {
      if (!sameFact("virtual_node", node) && !sameFact("unknown_type", node)) push("virtual_node", node, null, p);
    } else if (/子图实例/.test(p) || /子图「/.test(p)) {
      const v = subgraphViolation(p);
      push("subgraph_unexpanded", v.node, v.field, p, v.title ? { title: v.title } : null);
    } else {
      // 「节点 #N 输入 X 的连线缺失（link Y）」：required 输入 → missing_required（连线无效等同没接）
      const miss = /^节点 #(-?\d+) 输入 (\S+) 的连线缺失/.exec(p);
      let mapped = false;
      if (miss) {
        const n = nodeById.get(miss[1]);
        const cls = n ? classes[String(n.type)] : null;
        if (cls && typeof cls.required[miss[2]] === "string") {
          push("missing_required", miss[1], miss[2], p);
          mapped = true;
        }
      }
      if (!mapped) push("internal", node, null, `转换器将拒绝本图（词表无对应 code）：${p}`);
    }
  }
}
