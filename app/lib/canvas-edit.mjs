// app/lib/canvas-edit.mjs — 文件版 patch 编辑引擎（纯数据变换 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// 背景（T1 文件源通道）：环境里「语义读」已有三件纯函数（canvas-project / canvas-analysis /
// canvas-outline），但「语义写」只有桥侧执行器（依赖前端 graph 对象）。本模块把「写」的
// 变换层做成对「UI 格式 JSON」的纯数据操作，供文件版 patch（app/workflow-file.mjs）使用：
// 内存里应用 edits（全成才由上层写盘）、结构自检、引用完整性核对。
//
// edits 语言（与画布版 patch 的 7 种一致 + 本批扩展 4 种）：
//   画布版原集：addNode / setWidget / connect / disconnect / setNodeMode / removeNode / save
//   本批扩展：  addGroup{title,nodeIds?,bounds?}（0 基可查）
//              setGroup{index|title,title?,nodeIds?} —— index 定位时可改 title；title 定位时只能 nodeIds
//              removeGroup{index|title}
//              cloneNodes{nodeIds,offset?|position?} —— 图内克隆子图（节点+内部连线+widgets 值）
//   as/$：as 仅 addNode（重名拒绝）；$ 只在 nodeId / fromNode / toNode 三种字段解析（同画布版）。
//   save：仅最后一条；文件版语义＝写盘（上层执行），args 仅接受空对象。
//
// 与画布版的差异（有意为之，防呆优先）：
//   · 无 undo（文件版直接写盘，有 .bak 退路）；无并发锁（单进程串行）。
//   · addNode 的节点骨架来源二选一：objectInfo 声明（有服务时）→ 或文件内同型节点模板（降级）。
//     比画布版多走一步的原因是：文件版不能调 LiteGraph.createNode，必须自行构造序列化结构。
//   · verify 为「整批应用后自检」（纯数据操作确定性高，无需逐条即时核验）。
//
// ── UI JSON 结构口径（源自前端源码 comfyui_frontend_package 1.55.14 与全语料扫描，2026-10-09）──
//   · 顶层：{id,revision,last_node_id,last_link_id,nodes[],links[],groups[],config,extra,version}
//   · links 行：[linkId, originId, originSlot, targetId, targetSlot, type]（6 元）
//   · 节点 inputs[].link：null | linkId；outputs[].links：null | [linkId,…]（空数组=曾连过已断开）
//   · widgets_values 数组与 widgets_values_named 同源同序（前端 serialiseWidgetValues 铁证）：
//     named 键序 == wv 位置序；值可能过期（外部脚本只改 wv 的产物）——setWidget 按键序定位并双写。
//   · 组：{id,title,bounding:[x,y,w,h],color?,flags?}；组 id 独立编号空间（新组 id = max+1）。
//   · last_node_id / last_link_id 是「分配器」：新 id = max(该字段, 现有最大 id)+1，并回写。
// ─────────────────────────────────────────────────────────────────────────────

export const FILE_PATCH_ALLOWED = [
  "addNode", "setWidget", "connect", "disconnect", "setNodeMode", "removeNode", "save",
  "addGroup", "setGroup", "removeGroup", "cloneNodes",
];
export const FILE_PATCH_FORBIDDEN = ["undo", "loadWorkflowFile", "openWorkflow", "organize"];
export const PATCH_REF_FIELDS = ["nodeId", "fromNode", "toNode"];

const GROUP_PAD = 20;              // addGroup/setGroup 自动 bounding 的外扩边距
const CLONE_DEFAULT_OFFSET = [40, 40]; // cloneNodes 缺省平移量

// ── 小工具 ──────────────────────────────────────────────────────────────────
function parseId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function idEq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (String(a) === String(b)) return true;
  const an = parseId(a); const bn = parseId(b);
  return an !== null && bn !== null && an === bn;
}
function idKey(v) {
  const n = parseId(v);
  return n === null ? `s:${String(v)}` : `n:${n}`;
}
function cmpIds(a, b) {
  const an = parseId(a); const bn = parseId(b);
  if (an !== null && bn !== null) return an - bn;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
function messageOf(e) { return String((e && e.message) || e); }

// 槽解析：名字优先；字符串不中回退数字索引；不中 → -1（与 canvas-analysis.mjs resolveSlot 同口径）
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
function slotNames(slots) {
  return (Array.isArray(slots) ? slots : []).filter((s) => s && typeof s === "object" && s.name != null).map((s) => String(s.name));
}

// 宽松等值（verify 用）：标量按 String 比，对象按 JSON 比
function eqLoose(x, y) {
  if (x === y) return true;
  if (x === null || y === null || x === undefined || y === undefined) return false;
  if (typeof x === "object" || typeof y === "object") {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch { return false; }
  }
  return String(x) === String(y);
}

// ── 结构预检（parse）：与画布版同流程 + 4 种扩展的语法校验 ─────────────────────
function isPlainObjectLike(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function assertPosArray(v, label) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${label} 需要两个数字的数组 [x, y]`);
  }
}

function assertBoundsArray(v, label) {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${label} 需要四个数字的数组 [x, y, w, h]`);
  }
}

/**
 * 解析 + 结构预检（通道层；失败 → throw）。
 * @param {Array} raw src=file patch 的 edits 原始数组
 * @returns {Array<{index:number,key:string,args:object,raw:object}>}
 */
export function parseFilePatchEdits(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('patch 需要 edits（非空编辑数组，如 [{"setWidget":{…}}]）');
  }
  const list = [];
  raw.forEach((e, i) => {
    if (!isPlainObjectLike(e)) throw new Error(`edits[${i}] 必须是对象（恰一个 key）`);
    const keys = Object.keys(e);
    if (keys.length !== 1) {
      throw new Error(`edits[${i}] 必须恰好一个 key（收到 ${keys.length} 个：${keys.join(", ") || "无"}）`);
    }
    const key = keys[0];
    if (FILE_PATCH_FORBIDDEN.includes(key)) {
      throw new Error(`edits[${i}]：文件版 patch 明确拒绝 "${key}"（可用：${FILE_PATCH_ALLOWED.join(" / ")}）`);
    }
    if (!FILE_PATCH_ALLOWED.includes(key)) {
      throw new Error(`edits[${i}] 未知 edit："${key}"（可用：${FILE_PATCH_ALLOWED.join(" / ")}）`);
    }
    let val = e[key];
    if (val === undefined || val === null) val = {};
    if (!isPlainObjectLike(val)) throw new Error(`edits[${i}].${key} 必须是对象`);

    if (key === "save" && i !== raw.length - 1) {
      throw new Error(`save 只能作为最后一条 edit（现在第 ${i + 1}/${raw.length} 条）`);
    }
    if (key === "save" && Object.keys(val).length > 0) {
      throw new Error(`edits[${i}]：文件版 save 不接受参数（语义＝写回原文件；另存请复制文件后对新文件操作）`);
    }
    if (key !== "addNode" && val.as !== undefined && val.as !== null) {
      throw new Error(`edits[${i}]：as 仅 addNode 支持`);
    }
    for (const f of PATCH_REF_FIELDS) {
      if (typeof val[f] === "string" && val[f].startsWith("$") && !val[f].slice(1)) {
        throw new Error(`edits[${i}]：非法引用 "${val[f]}"（$ 后需有名称）`);
      }
    }
    // 本批扩展的语法校验（不依赖图状态的部分）
    if (key === "addNode" && val.pos !== undefined) assertPosArray(val.pos, `edits[${i}].addNode.pos`);
    if (key === "addGroup") {
      if (typeof val.title !== "string" || !val.title.trim()) throw new Error(`edits[${i}].addGroup 需要 title（非空字符串）`);
      if (val.nodeIds !== undefined) {
        if (!Array.isArray(val.nodeIds) || val.nodeIds.length === 0) throw new Error(`edits[${i}].addGroup.nodeIds 需为非空数组（节点 id 列表）`);
      }
      if (val.bounds !== undefined) assertBoundsArray(val.bounds, `edits[${i}].addGroup.bounds`);
    }
    if (key === "setGroup") {
      const hasIdx = val.index !== undefined;
      const hasTitle = val.title !== undefined;
      if (!hasIdx && !hasTitle) throw new Error(`edits[${i}].setGroup 需要 index（0 基下标）或 title（现有组标题）定位`);
      if (hasIdx && (!Number.isInteger(val.index) || val.index < 0)) {
        throw new Error(`edits[${i}].setGroup.index 需为 ≥0 的整数（0 基数组下标）`);
      }
      if (hasTitle && (typeof val.title !== "string" || !val.title.trim())) throw new Error(`edits[${i}].setGroup.title 需为非空字符串`);
      if (val.nodeIds !== undefined) {
        if (!Array.isArray(val.nodeIds) || val.nodeIds.length === 0) throw new Error(`edits[${i}].setGroup.nodeIds 需为非空数组（节点 id 列表）`);
      }
      // index 定位：title=改名 / nodeIds=重算 bounds，至少一项；
      // title 定位：title 已被定位占用，变更字段只能是 nodeIds（改名请用 index 定位，见模块头注释）。
      if (hasIdx && !hasTitle && val.nodeIds === undefined) {
        throw new Error(`edits[${i}].setGroup 没有可变更内容：index 定位时需给 title（改名）或 nodeIds（重算 bounds）至少一项`);
      }
      if (!hasIdx && hasTitle && val.nodeIds === undefined) {
        throw new Error(`edits[${i}].setGroup 用 title 定位时没有可变更字段：title 定位只能配合 nodeIds（重算 bounds）；改名请用 index 定位`);
      }
    }
    if (key === "removeGroup") {
      const hasIdx = val.index !== undefined;
      const hasTitle = val.title !== undefined;
      if (!hasIdx && !hasTitle) throw new Error(`edits[${i}].removeGroup 需要 index（0 基下标）或 title（现有组标题）定位`);
      if (hasIdx && (!Number.isInteger(val.index) || val.index < 0)) {
        throw new Error(`edits[${i}].removeGroup.index 需为 ≥0 的整数（0 基数组下标）`);
      }
      if (hasTitle && (typeof val.title !== "string" || !val.title.trim())) throw new Error(`edits[${i}].removeGroup.title 需为非空字符串`);
    }
    if (key === "cloneNodes") {
      if (!Array.isArray(val.nodeIds) || val.nodeIds.length === 0) throw new Error(`edits[${i}].cloneNodes 需要 nodeIds（非空数组）`);
      if (val.offset !== undefined && val.position !== undefined) {
        throw new Error(`edits[${i}].cloneNodes 的 offset 与 position 二选一（同时给了）`);
      }
      if (val.offset !== undefined) assertPosArray(val.offset, `edits[${i}].cloneNodes.offset`);
      if (val.position !== undefined) assertPosArray(val.position, `edits[${i}].cloneNodes.position`);
    }
    list.push({ index: i, key, args: val, raw: e });
  });
  return list;
}

// ── 实例辅助（作用于「图对象」）────────────────────────────────────────────
function findNode(graph, id) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((n) => n && typeof n === "object" && idEq(n.id, id)) || null;
}
function nodeByIdErr(graph, id) {
  const n = findNode(graph, id);
  if (!n) throw new Error(`找不到节点：#${String(id)}`);
  return n;
}
function resolveRef(value, symbols) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!(name in symbols)) {
    throw new Error(`未定义的引用 "${value}"（需先有 {"addNode":{…,"as":"${name}"}} 定义）`);
  }
  return symbols[name];
}

function nextNodeId(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  let max = 0;
  for (const n of nodes) {
    const id = parseId(n && n.id);
    if (id !== null && id > max) max = id;
  }
  const last = parseId(graph.last_node_id);
  if (last !== null && last > max) max = last;
  return max + 1;
}
function nextLinkId(graph) {
  let max = 0;
  for (const row of (Array.isArray(graph.links) ? graph.links : [])) {
    if (!Array.isArray(row)) continue;
    const id = parseId(row[0]);
    if (id !== null && id > max) max = id;
  }
  const last = parseId(graph.last_link_id);
  if (last !== null && last > max) max = last;
  return max + 1;
}
function nextGroupId(graph) {
  let max = 0;
  for (const g of (Array.isArray(graph.groups) ? graph.groups : [])) {
    const id = parseId(g && g.id);
    if (id !== null && id > max) max = id;
  }
  return max + 1;
}
function nextOrder(graph) {
  let max = -1;
  for (const n of (Array.isArray(graph.nodes) ? graph.nodes : [])) {
    const o = n && n.order;
    if (typeof o === "number" && Number.isFinite(o) && o > max) max = o;
  }
  return max + 1;
}

// 为一条（已确认目标节点存在的）连接建立 link 行引用：写 link 行 + 两侧槽引用
function attachLink(graph, linkId, fromNode, outIdx, toNode, inIdx) {
  const outType = fromNode.outputs && fromNode.outputs[outIdx] ? fromNode.outputs[outIdx].type : "";
  const inType = toNode.inputs && toNode.inputs[inIdx] ? toNode.inputs[inIdx].type : "";
  const typeStr =
    typeof outType === "string" && outType ? outType
      : typeof inType === "string" && inType ? inType
        : Array.isArray(outType) ? outType.map((x) => String(x)).join("|") || "unknown"
          : "*";
  if (!Array.isArray(graph.links)) graph.links = [];
  graph.links.push([linkId, fromNode.id, outIdx, toNode.id, inIdx, typeStr]);
  const out = fromNode.outputs[outIdx];
  if (out) {
    if (Array.isArray(out.links)) out.links.push(linkId);
    else out.links = [linkId];
  }
  if (toNode.inputs[inIdx]) toNode.inputs[inIdx].link = linkId;
}

// 从图中移除一条 link（行 + 两侧槽引用），返回被移除的链接行（找不到 → null）
function detachLink(graph, linkId) {
  const links = Array.isArray(graph.links) ? graph.links : [];
  const idx = links.findIndex((row) => Array.isArray(row) && idEq(row[0], linkId));
  const row = idx >= 0 ? links[idx] : null;
  if (idx >= 0) links.splice(idx, 1);
  if (row) {
    const from = findNode(graph, row[1]);
    const to = findNode(graph, row[3]);
    if (from && Array.isArray(from.outputs) && from.outputs[row[2]] && Array.isArray(from.outputs[row[2]].links)) {
      const arr = from.outputs[row[2]].links;
      const k = arr.findIndex((x) => idEq(x, linkId));
      if (k >= 0) arr.splice(k, 1);
    }
    if (to && Array.isArray(to.inputs) && to.inputs[row[4]] && idEq(to.inputs[row[4]].link, linkId)) {
      to.inputs[row[4]].link = null;
    }
  }
  return row;
}

// 节点「widget 名 → 位置」推导（无 named 时的防御路径；与 convertUiToApi 的无 named 分支同口径）
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
function deriveWidgetPositions(node) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const slotWidgets = inputs.filter((s) => s && typeof s === "object" && s.widget && typeof s.widget.name === "string");
  if (!slotWidgets.length) return null;
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const positions = new Map();
  let wvi = 0;
  for (const s of slotWidgets) {
    const name = String(s.widget.name);
    if (!positions.has(name)) positions.set(name, wvi);
    wvi += 1;
    if ((name === "seed" || name === "noise_seed") && wvi < wv.length && typeof wv[wvi] === "string" && SEED_CONTROL_VALUES.has(wv[wvi])) {
      wvi += 1; // 跳过 control_after_generate 副值
    }
  }
  return positions;
}

// 无 named 的节点：按推导位序重建完整 named（键序=位置序；seed/noise_seed 后补控制副值键，
// 名字用前端默认 "control_after_generate"）——让「named 键序 ↔ wv 位序」重新同源同序（复核 M1）。
function rebuildNamedFromPositions(node) {
  const derived = deriveWidgetPositions(node);
  const named = {};
  if (!derived) return named;
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  for (const [name, pos] of derived) {
    named[name] = pos < wv.length ? wv[pos] : null;
    if ((name === "seed" || name === "noise_seed") && pos + 1 < wv.length && typeof wv[pos + 1] === "string" && SEED_CONTROL_VALUES.has(wv[pos + 1])) {
      named.control_after_generate = wv[pos + 1];
    }
  }
  return named;
}

// widget 名清单（报错提示用）：named 键序 > 推导
function widgetNamesOf(node) {
  if (isPlainObjectLike(node.widgets_values_named)) return Object.keys(node.widgets_values_named);
  const derived = deriveWidgetPositions(node);
  return derived ? [...derived.keys()] : [];
}

// ── 构建新节点（addNode）──────────────────────────────────────────────────
const WIDGET_SPEC_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);

function defaultWidgetValue(t, spec) {
  const opts = spec && spec[1] ? spec[1] : {};
  if (opts.default !== undefined) return opts.default;
  if (t === "INT" || t === "FLOAT") return 0;
  if (t === "STRING") return "";
  if (t === "BOOLEAN") return false;
  if (Array.isArray(spec[0]) && spec[0].length) return spec[0][0]; // COMBO：第一项
  return null;
}

// 从 object_info 声明构建节点骨架（对齐前端「serialiseWidgetValues」与 control_after_generate 规则）
function buildNodeFromObjectInfo(graph, type, opts) {
  const info = opts.objectInfo[type];
  if (!info || typeof info !== "object") throw new Error(`未知节点类型：「${type}」（object_info 中没有）`);
  const declared = [
    ...Object.entries((info.input && info.input.required) || {}),
    ...Object.entries((info.input && info.input.optional) || {}),
  ];
  const node = {
    id: null,
    type,
    pos: Array.isArray(opts.pos) ? opts.pos.slice() : [0, 0],
    size: [210, 100],
    flags: {},
    order: 0,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: { "Node name for S&R": type },
    widgets_values: [],
    widgets_values_named: {},
  };
  for (const [name, spec] of declared) {
    if (!Array.isArray(spec)) continue;
    const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
    const sOpts = spec[1] && typeof spec[1] === "object" ? spec[1] : {};
    const isWidget = WIDGET_SPEC_TYPES.has(t) && sOpts.forceInput !== true;
    if (!isWidget) {
      node.inputs.push({ name, type: t, link: null });
      continue;
    }
    // widget 槽（新前端序列化形态：inputs 里带 widget 占位）
    node.inputs.push({ name, type: t, widget: { name }, link: null });
    const val = defaultWidgetValue(t, spec);
    node.widgets_values.push(val);
    node.widgets_values_named[name] = val;
    // control_after_generate 副值（前端规则：spec 声明 或 名字为 seed/noise_seed → 追加一格）
    const cag = sOpts.control_after_generate;
    if (cag !== undefined || name === "seed" || name === "noise_seed") {
      const ctrlName = typeof cag === "string" && cag ? cag : "control_after_generate";
      const ctrlDefault = typeof cag === "string" && cag ? cag : (t === "FLOAT" ? "fixed" : "randomize");
      node.widgets_values.push(ctrlDefault);
      node.widgets_values_named[ctrlName] = ctrlDefault;
    }
  }
  const ots = Array.isArray(info.output) ? info.output : [];
  const otNames = Array.isArray(info.output_name) ? info.output_name : [];
  ots.forEach((ot, i) => {
    const ts = typeof ot === "string" ? ot : Array.isArray(ot) ? ot.map((x) => String(x)).join("|") : "*";
    node.outputs.push({ name: otNames[i] != null ? String(otNames[i]) : ts, type: ts, links: null });
  });
  return node;
}

// 从文件内同型节点克隆骨架（object_info 不可用时的降级路径；结构保真、值随模板复制）
function buildNodeFromTemplate(graph, type, opts) {
  const tmpl = (Array.isArray(graph.nodes) ? graph.nodes : []).find(
    (n) => n && typeof n === "object" && String(n.type || "") === type,
  );
  if (!tmpl) {
    throw new Error(
      `addNode 无法构建「${type}」：object_info 不可达（服务未运行？）且文件内没有同型节点可作模板；` +
      `请先启动 ComfyUI 服务，或改用文件内已有类型的节点`,
    );
  }
  const node = deepClone(tmpl);
  node.id = null;
  node.pos = Array.isArray(opts.pos) ? opts.pos.slice() : [0, 0];
  delete node.title; // 同画布版：不传 title 时节点无自定义标题
  if (Array.isArray(node.inputs)) for (const s of node.inputs) if (s && typeof s === "object") s.link = null;
  if (Array.isArray(node.outputs)) for (const s of node.outputs) if (s && typeof s === "object") s.links = null;
  node.via = undefined; // 防御：避免历史字段混入
  delete node.via;
  return { node, templateId: tmpl.id };
}

// ── 各 edit 的应用（在副本上；throw 表示该条失败）────────────────────────────
function applyEdit(graph, item, ctx) {
  const key = item.key;
  const a = { ...item.args };
  for (const f of PATCH_REF_FIELDS) {
    if (a[f] !== undefined) a[f] = resolveRef(a[f], ctx.symbols);
  }

  if (key === "setWidget") {
    if (a.nodeId === undefined || a.nodeId === null) throw new Error("setWidget 需要 nodeId");
    if (a.name == null || a.name === "") throw new Error("setWidget 需要 name");
    const node = nodeByIdErr(graph, a.nodeId);
    const name = String(a.name);
    // 无 named 的节点：先按推导位序重建完整 named（键序=位置序），再统一走「键序定位 + 双写」——
    // 修复旧格式节点的 setWidget fail-closed（复核 M1：原实现只补写单键，与 wv 位序错位）。
    if (!isPlainObjectLike(node.widgets_values_named)) {
      node.widgets_values_named = rebuildNamedFromPositions(node);
    }
    let pos = Object.keys(node.widgets_values_named).indexOf(name);
    if (pos < 0) {
      const derived = deriveWidgetPositions(node);
      if (derived && derived.has(name)) pos = derived.get(name);
    }
    if (pos < 0) {
      const avail = widgetNamesOf(node);
      throw new Error(`节点 #${node.id} 没有名为 ${name} 的参数${avail.length ? `（可用：${avail.join("、")}）` : ""}`);
    }
    const before = Object.prototype.hasOwnProperty.call(node.widgets_values_named, name)
      ? node.widgets_values_named[name]
      : (Array.isArray(node.widgets_values) && pos < node.widgets_values.length ? node.widgets_values[pos] : undefined);
    const val = deepClone(a.value === undefined ? null : a.value);
    if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
    while (node.widgets_values.length <= pos) node.widgets_values.push(null);
    node.widgets_values[pos] = val;
    node.widgets_values_named[name] = val;
    return { payload: { nodeId: node.id, type: node.type, name, before, after: val, position: pos }, afterCheck: () => {
      const n2 = findNode(graph, node.id);
      if (!n2) return `#${node.id} 不见了`;
      if (Array.isArray(n2.widgets_values) && !eqLoose(n2.widgets_values[pos], val)) return `wv[${pos}] 未同步（期望 ${JSON.stringify(val)}）`;
      if (!isPlainObjectLike(n2.widgets_values_named) || !eqLoose(n2.widgets_values_named[name], val)) return `named.${name} 未生效`;
      return null;
    } };
  }

  if (key === "addNode") {
    const type = String(a.type || "").trim();
    if (!type) throw new Error("addNode 需要 type");
    let node;
    let via = "object_info";
    let templateId = null;
    let note;
    if (ctx.objectInfo && isPlainObjectLike(ctx.objectInfo)) {
      node = buildNodeFromObjectInfo(graph, type, { pos: a.pos, objectInfo: ctx.objectInfo });
    } else {
      const r = buildNodeFromTemplate(graph, type, { pos: a.pos });
      node = r.node;
      via = "template";
      templateId = r.templateId;
      note = `object_info 不可用：节点骨架复制自文件内同型节点 #${String(templateId)}（widgets 值同复制；请按需 setWidget）`;
    }
    node.id = ctx.allocNodeId();
    node.order = ctx.allocOrder();
    if (a.title) node.title = String(a.title);
    graph.nodes.push(node);
    const asName = a.as;
    if (asName !== undefined && asName !== null) {
      const nm = String(asName);
      if (nm in ctx.symbols) throw new Error(`as 重名："${nm}"（同批已有同名定义）`);
      ctx.symbols[nm] = node.id;
    }
    return { payload: {
      nodeId: node.id, type: node.type, title: node.title,
      inputs: node.inputs.map((s) => s.name), outputs: node.outputs.map((s) => s.name),
      widgets: widgetNamesOf(node), via, ...(templateId !== null ? { templateNode: templateId, note } : {}),
    }, afterCheck: () => (findNode(graph, node.id) ? null : `新节点 #${node.id} 不在图中`) };
  }

  if (key === "connect") {
    if (a.fromNode === undefined || a.toNode === undefined) throw new Error("connect 需要 fromNode / toNode");
    const from = nodeByIdErr(graph, a.fromNode);
    const to = nodeByIdErr(graph, a.toNode);
    const outIdx = resolveSlot(from.outputs, a.fromSlot);
    const inIdx = resolveSlot(to.inputs, a.toSlot);
    if (outIdx < 0) throw new Error(`输出槽不存在：${String(a.fromSlot)}（可用：${slotNames(from.outputs).join(", ") || "无"}）`);
    if (inIdx < 0) throw new Error(`输入槽不存在：${String(a.toSlot)}（可用：${slotNames(to.inputs).join(", ") || "无"}）`);
    // 直替保护：目标槽已有连线 → 先摘（返回 replaced）
    const prevLink = to.inputs[inIdx].link;
    let replaced = null;
    if (prevLink != null) {
      detachLink(graph, prevLink);
      replaced = prevLink;
    }
    const linkId = ctx.allocLinkId();
    attachLink(graph, linkId, from, outIdx, to, inIdx);
    return { payload: { from: from.id, to: to.id, outSlot: outIdx, inSlot: inIdx, linkId, replaced }, afterCheck: () => {
      const row = (graph.links || []).find((r) => Array.isArray(r) && idEq(r[0], linkId));
      if (!row) return `link ${linkId} 不在 links 表`;
      if (!idEq(row[1], from.id) || Number(row[2]) !== outIdx || !idEq(row[3], to.id) || Number(row[4]) !== inIdx) return `link ${linkId} 端点不符`;
      const n2 = findNode(graph, to.id);
      if (!n2 || !n2.inputs[inIdx] || !idEq(n2.inputs[inIdx].link, linkId)) return `#${to.id} 输入槽引用未更新`;
      return null;
    } };
  }

  if (key === "disconnect") {
    if (a.nodeId === undefined || a.nodeId === null) throw new Error("disconnect 需要 nodeId");
    const node = nodeByIdErr(graph, a.nodeId);
    const inIdx = resolveSlot(node.inputs, a.slot);
    if (inIdx < 0) throw new Error(`输入槽不存在：${String(a.slot)}（可用：${slotNames(node.inputs).join(", ") || "无"}）`);
    const linkId = node.inputs[inIdx].link;
    if (linkId == null) throw new Error(`输入 ${String(a.slot)} 本来就没有连线`);
    detachLink(graph, linkId);
    return { payload: { nodeId: node.id, slot: node.inputs[inIdx].name != null ? String(node.inputs[inIdx].name) : String(a.slot), linkId }, afterCheck: () => {
      const n2 = findNode(graph, node.id);
      if (!n2 || !n2.inputs[inIdx]) return `输入槽不见了`;
      if (n2.inputs[inIdx].link != null) return `输入 ${String(a.slot)} 仍有连线（link=${n2.inputs[inIdx].link}）`;
      return null;
    } };
  }

  if (key === "setNodeMode") {
    if (a.nodeId === undefined || a.nodeId === null) throw new Error("setNodeMode 需要 nodeId");
    const node = nodeByIdErr(graph, a.nodeId);
    const mode = Number(a.mode);
    if (![0, 2, 4].includes(mode)) throw new Error("mode 必须是 0（正常）/ 2（mute）/ 4（bypass）");
    const before = node.mode;
    node.mode = mode;
    return { payload: { nodeId: node.id, mode, label: mode === 2 ? "mute" : mode === 4 ? "bypass" : "正常", before }, afterCheck: () => {
      const n2 = findNode(graph, node.id);
      return n2 && Number(n2.mode) === mode ? null : `#${node.id} 的 mode 未生效`;
    } };
  }

  if (key === "removeNode") {
    if (a.nodeId === undefined || a.nodeId === null) throw new Error("removeNode 需要 nodeId");
    const node = nodeByIdErr(graph, a.nodeId);
    const incoming = [];
    for (const s of node.inputs || []) if (s && s.link != null) incoming.push(s.link);
    const outgoing = [];
    for (const o of node.outputs || []) if (o && Array.isArray(o.links)) for (const l of o.links) outgoing.push(l);
    for (const lid of [...incoming, ...outgoing]) detachLink(graph, lid);
    const idx = graph.nodes.indexOf(node);
    if (idx >= 0) graph.nodes.splice(idx, 1);
    return { payload: { removed: node.id, type: node.type, incomingLinks: incoming.length, outgoingLinks: outgoing.length }, afterCheck: () => (findNode(graph, node.id) ? `#${node.id} 仍在图中` : null) };
  }

  if (key === "addGroup") {
    const title = String(a.title).trim();
    let bounds;
    if (Array.isArray(a.bounds)) {
      bounds = a.bounds.slice();
      if (Array.isArray(a.nodeIds)) for (const id of a.nodeIds) nodeByIdErr(graph, id); // 给了就校验存在性
    } else if (Array.isArray(a.nodeIds)) {
      bounds = boundsForNodes(graph, a.nodeIds);
    } else {
      bounds = [0, 0, 200, 100];
    }
    if (!Array.isArray(graph.groups)) graph.groups = [];
    const group = { id: ctx.allocGroupId(), title, bounding: bounds, flags: {} };
    graph.groups.push(group);
    return { payload: { index: graph.groups.length - 1, id: group.id, title, bounding: bounds }, afterCheck: () => {
      return graph.groups.some((g) => g && idEq(g.id, group.id) && g.title === title) ? null : `组未加入`;
    } };
  }

  if (key === "setGroup") {
    const gi = locateGroup(graph, a);
    const group = graph.groups[gi];
    const changed = {};
    if (a.index !== undefined && a.title !== undefined) {
      const before = group.title;
      group.title = String(a.title).trim();
      changed.title = { before, after: group.title };
    }
    if (Array.isArray(a.nodeIds)) {
      const before = group.bounding;
      group.bounding = boundsForNodes(graph, a.nodeIds);
      changed.bounding = { before, after: group.bounding };
    }
    return { payload: { index: gi, id: group.id, title: group.title, changed }, afterCheck: () => {
      const g2 = graph.groups[gi];
      if (!g2 || !idEq(g2.id, group.id)) return `组不见了`;
      if (changed.title && g2.title !== changed.title.after) return `标题未生效`;
      if (changed.bounding && JSON.stringify(g2.bounding) !== JSON.stringify(changed.bounding.after)) return `bounds 未生效`;
      return null;
    } };
  }

  if (key === "removeGroup") {
    const gi = locateGroup(graph, a);
    const group = graph.groups[gi];
    graph.groups.splice(gi, 1);
    return { payload: { index: gi, id: group.id, title: group.title, bounding: group.bounding, removed: true }, afterCheck: () => {
      return graph.groups.some((g) => g && idEq(g.id, group.id)) ? `组仍在` : null;
    } };
  }

  if (key === "cloneNodes") {
    const ids = a.nodeIds.map((x) => x);
    const seen = new Set();
    const picked = [];
    for (const id of ids) {
      const node = nodeByIdErr(graph, id);
      const k = idKey(node.id);
      if (seen.has(k)) throw new Error(`cloneNodes 的 nodeIds 有重复项：#${String(node.id)}`);
      seen.add(k);
      picked.push(node);
    }
    // 平移量
    let dx; let dy;
    if (Array.isArray(a.position)) {
      let minX = Infinity; let minY = Infinity;
      for (const n of picked) {
        if (!Array.isArray(n.pos) || n.pos.length < 2) throw new Error(`节点 #${n.id} 缺 pos，无法按 position 定位`);
        minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]);
      }
      dx = a.position[0] - minX;
      dy = a.position[1] - minY;
    } else {
      const off = Array.isArray(a.offset) ? a.offset : CLONE_DEFAULT_OFFSET;
      dx = off[0]; dy = off[1];
    }
    // 深拷贝 + 新 id
    const mapping = {};
    const newNodes = [];
    for (const n of picked) {
      const cp = deepClone(n);
      const oldId = n.id;
      cp.id = ctx.allocNodeId();
      mapping[String(oldId)] = cp.id;
      if (Array.isArray(cp.pos) && cp.pos.length >= 2) cp.pos = [cp.pos[0] + dx, cp.pos[1] + dy];
      if (Array.isArray(cp.inputs)) for (const s of cp.inputs) if (s && typeof s === "object") s.link = null;
      if (Array.isArray(cp.outputs)) for (const s of cp.outputs) if (s && typeof s === "object") s.links = null;
      cp.order = ctx.allocOrder();
      newNodes.push(cp);
      graph.nodes.push(cp);
    }
    // 内部连线重建（两端都在选中集的连线；外部连线不复制）
    const newById = new Map();
    for (const cp of newNodes) newById.set(idKey(cp.id), cp);
    let copiedLinks = 0;
    for (const row of (Array.isArray(graph.links) ? graph.links : [])) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const fromNew = seen.has(idKey(row[1])) ? newById.get(idKey(mapping[String(row[1])])) : null;
      const toNew = seen.has(idKey(row[3])) ? newById.get(idKey(mapping[String(row[3])])) : null;
      if (!fromNew || !toNew) continue;
      const lid = ctx.allocLinkId();
      attachLink(graph, lid, fromNew, row[2], toNew, row[4]);
      copiedLinks += 1;
    }
    return { payload: {
      mapping, count: newNodes.length, copiedLinks,
      offset: [dx, dy], ...(Array.isArray(a.position) ? { position: a.position.slice() } : {}),
    }, afterCheck: () => {
      for (const cp of newNodes) if (!findNode(graph, cp.id)) return `克隆节点 #${cp.id} 不在图中`;
      return null;
    } };
  }

  if (key === "save") {
    // 文件版：写盘由上层在事务成功后统一执行；本层仅占位记录
    return { payload: { deferred: true, note: "写盘在整批成功后执行" }, afterCheck: () => null };
  }

  throw new Error(`未知 edit："${key}"`);
}

// 定位组：index 或 title（title 须唯一）
function locateGroup(graph, a) {
  const groups = Array.isArray(graph.groups) ? graph.groups : [];
  if (a.index !== undefined) {
    if (a.index >= groups.length) {
      throw new Error(`组 index ${a.index} 越界（现有 ${groups.length} 个组，0 基下标 0..${Math.max(0, groups.length - 1)}）`);
    }
    return a.index;
  }
  const wanted = String(a.title).trim();
  const hits = [];
  groups.forEach((g, i) => { if (g && typeof g.title === "string" && g.title.trim() === wanted) hits.push(i); });
  if (!hits.length) throw new Error(`没有标题为「${wanted}」的组（现有：${groups.map((g) => g && g.title).join(" / ") || "无"}）`);
  if (hits.length > 1) throw new Error(`标题「${wanted}」有 ${hits.length} 个组，无法唯一定位；请改用 index`);
  return hits[0];
}

// 由节点集计算 bounding（外扩 GROUP_PAD）
function boundsForNodes(graph, nodeIds) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const id of nodeIds) {
    const n = nodeByIdErr(graph, id);
    if (!Array.isArray(n.pos) || n.pos.length < 2 || typeof n.pos[0] !== "number" || typeof n.pos[1] !== "number") {
      throw new Error(`节点 #${n.id} 缺 pos，无法计算 bounds`);
    }
    const size = Array.isArray(n.size) && n.size.length >= 2 && typeof n.size[0] === "number" && typeof n.size[1] === "number"
      ? n.size : [0, 0];
    minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]);
    maxX = Math.max(maxX, n.pos[0] + size[0]); maxY = Math.max(maxY, n.pos[1] + size[1]);
  }
  return [minX - GROUP_PAD, minY - GROUP_PAD, (maxX - minX) + GROUP_PAD * 2, (maxY - minY) + GROUP_PAD * 2];
}

// ── 批处理：副本上顺序应用（全成 → 返回结果副本；任一失败 → {ok:false}）─────────
/**
 * 在 graph 的深拷贝上应用全部 edits（all-or-nothing 的「内存段」）。
 * @param {object} graph UI 格式 JSON（原对象不会被修改）
 * @param {Array} list parseFilePatchEdits 的输出
 * @param {{objectInfo?: object}} [opts] objectInfo 可用时用于 addNode 构建（否则降级模板）
 * @returns {{ok:true, graph:object, results:Array}|{ok:false, failedAt:{index,edit,reason}, results:Array}}
 */
export function applyFilePatch(graph, list, opts = {}) {
  if (graph === null || typeof graph !== "object" || !Array.isArray(graph.nodes)) {
    throw new Error("workspace 非 UI 格式工作流（缺 nodes 数组）");
  }
  const work = deepClone(graph);
  if (!Array.isArray(work.links)) work.links = [];
  if (!Array.isArray(work.groups)) work.groups = [];
  const ctx = {
    symbols: Object.create(null),
    nextNode: nextNodeId(work),
    nextLink: nextLinkId(work),
    nextGroup: nextGroupId(work),
    nextOrd: nextOrder(work),
    allocNodeId() { const id = this.nextNode; this.nextNode += 1; work.last_node_id = id; return id; },
    allocLinkId() { const id = this.nextLink; this.nextLink += 1; work.last_link_id = id; return id; },
    allocGroupId() { const id = this.nextGroup; this.nextGroup += 1; return id; },
    allocOrder() { const o = this.nextOrd; this.nextOrd += 1; return o; },
    objectInfo: opts.objectInfo && isPlainObjectLike(opts.objectInfo) ? opts.objectInfo : null,
  };
  const results = [];
  for (const item of list) {
    try {
      const r = applyEdit(work, item, ctx);
      const checkErr = r.afterCheck ? r.afterCheck() : null;
      if (checkErr) throw new Error(`后置检查未通过：${checkErr}`);
      results.push({ index: item.index, edit: item.raw, ok: true, result: r.payload });
    } catch (e) {
      return {
        ok: false,
        failedAt: { index: item.index, edit: item.raw, reason: messageOf(e) },
        results,
      };
    }
  }
  return { ok: true, graph: work, results };
}

// ── 结构自检（verify 用）：引用完整性 / 无悬空引用 ────────────────────────────
/**
 * 扫描 UI JSON 的结构性引用问题（不含语义体检——那由 analyzeGraph 负责）。
 * 返回 [{key, kind, detail}]；key 用于前后对比（新增问题 = 失败）。
 */
export function scanStructuralProblems(graph) {
  const problems = [];
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph && graph.links) ? graph.links : [];
  const byId = new Map();
  for (const n of nodes) if (n && typeof n === "object") byId.set(idKey(n.id), n);
  const linkById = new Map();
  for (const row of links) if (Array.isArray(row) && row.length >= 5) linkById.set(idKey(row[0]), row);
  const push = (kind, detail) => problems.push({ key: `${kind}|${detail}`, kind, detail });

  for (const row of links) {
    if (!Array.isArray(row) || row.length < 5) { push("link-bad-row", `links 中有非 6 元行：${JSON.stringify(row).slice(0, 80)}`); continue; }
    const [lid, fromId, fromSlot, toId, toSlot] = row;
    const from = byId.get(idKey(fromId));
    const to = byId.get(idKey(toId));
    if (!from) push("link-orphan", `link ${String(lid)} 的源节点 #${String(fromId)} 不存在`);
    else {
      const out = Array.isArray(from.outputs) ? from.outputs[fromSlot] : null;
      if (!out) push("link-bad-slot", `link ${String(lid)} 的源槽 #${String(fromId)}[${String(fromSlot)}] 不存在`);
      else if (!(Array.isArray(out.links) && out.links.some((x) => idEq(x, lid)))) {
        push("link-out-ref-missing", `link ${String(lid)}：#${String(fromId)} 输出槽 ${String(fromSlot)} 的 links 未含该 link`);
      }
    }
    if (!to) push("link-orphan", `link ${String(lid)} 的目标节点 #${String(toId)} 不存在`);
    else if (!(Array.isArray(to.inputs) && to.inputs[toSlot])) push("link-bad-slot", `link ${String(lid)} 的目标槽 #${String(toId)}[${String(toSlot)}] 不存在`);
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.inputs)) {
      n.inputs.forEach((s, i) => {
        if (!s || typeof s !== "object") return;
        if (s.link == null) return;
        const row = linkById.get(idKey(s.link));
        if (!row) push("dangling-input-ref", `#${String(n.id)} 输入槽「${String(s.name != null ? s.name : i)}」引用的 link ${String(s.link)} 不在 links 表`);
        else if (!idEq(row[3], n.id)) push("link-target-mismatch", `link ${String(s.link)} 的目标不是 #${String(n.id)}`);
      });
    }
    if (Array.isArray(n.outputs)) {
      n.outputs.forEach((s, i) => {
        if (!s || typeof s !== "object") return;
        if (!Array.isArray(s.links)) return;
        for (const lid of s.links) {
          const row = linkById.get(idKey(lid));
          if (!row) push("dangling-output-ref", `#${String(n.id)} 输出槽「${String(s.name != null ? s.name : i)}」引用的 link ${String(lid)} 不在 links 表`);
          else if (!idEq(row[1], n.id)) push("link-source-mismatch", `link ${String(lid)} 的源不是 #${String(n.id)}`);
        }
      });
    }
  }
  // 去重（key 已含 kind+detail）
  const seen = new Set();
  return problems.filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
}

/** before/after 结构问题对比：返回 after 中出现、before 中没有的问题（新增问题）。 */
export function diffStructuralProblems(before, after) {
  const oldKeys = new Set((before || []).map((p) => p.key));
  return (after || []).filter((p) => !oldKeys.has(p.key));
}
