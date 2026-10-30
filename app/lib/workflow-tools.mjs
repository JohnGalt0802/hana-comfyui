// lib/workflow-tools.mjs — 工作流解析/转换/注入（app 与中继共享）
// 2026-09-29（M13）：从 index.js 抽出，供 app(index.js) 与中继(runtime/comfy-relay.mjs) 同源使用。
// 中继侧直提（/_relay/submit-file）需要同一份 UI→API 转换与 inputs 注入逻辑，避免双实现漂移。
// 2026-10-08（R1）：补 named↔位置值交叉校验（fail-loud），防「过期 named 被静默采用」的值分叉类事故。

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);
export const UNSUPPORTED_UI_TYPES = new Set(["Reroute", "PrimitiveNode", "Subgraph", "GroupNode", "SubgraphInputNode", "SubgraphOutputNode"]);

// UI 格式（nodes/links）→ API 格式：经典图子集（子图/环绕/静音/旁路节点会明确报错）
const WIDGET_SPEC_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3", "AUTOCOMPLETE_TEXT_LORAS"]);
// 常见 socket 类型的近似名单（实测未覆盖全部：本机 /object_info 有 220 个输入类型、这里有 20 个）；
// 未列出的类型靠「widgets_values_named 本就没有该键」兜底，不会误注入；名单不完备可接受。
const NON_WIDGET_INPUT_TYPES = new Set([
  "MODEL", "CLIP", "VAE", "CLIP_VISION", "CLIP_VISION_OUTPUT", "STYLE_MODEL", "UPSCALE_MODEL",
  "IMAGE", "MASK", "LATENT", "CONDITIONING", "CONTROL_NET", "SIGMAS", "SAMPLER", "GUIDER", "NOISE",
  "AUDIO", "VIDEO", "WEBCAM", "LATENT_UPSCALE", "GLIGEN", "TAESD",
]);
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);

// R1 防线（2026-10-08）：named↔位置值交叉校验——防静默采用过期 named。
// 背景：前端保存走 serialiseWidgetValues 双写（named 与位置同源），正常文件两字段一致；
// 但当文件被「只改 widgets_values、不动 widgets_values_named」的外部批处理脚本改写后，
// named 会停留在旧值——转换器 named 优先，会把「用户现值」静默换成「旧值」（04/少女事故同型）。
// 范围：下列类型的 named 主键恒在 widgets_values[0]（全语料核验：一致文件 0 误报）；分歧即拒绝。
// 新增类型前先核验「主键 ↔ wv 下标」对位语义（含 autogrow/控制副值等特殊形态不在列）。
const NAMED_WV_CHECK = new Map([
  ["PrimitiveStringMultiline", "value"],
  ["PrimitiveBoolean", "value"],
  ["PrimitiveInt", "value"],
  ["PrimitiveFloat", "value"],
  ["ComfySwitchNode", "switch"],
  ["LoadImage", "image"],
  ["LoadImageOutput", "image"],
  ["CLIPLoader", "clip_name"],
]);
const cutValue = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s == null ? String(s) : s.length > 36 ? s.slice(0, 36) + "…" : s; };

// ── 节点适配规则引擎（2026-10-30）──────────────────────────────────────────────
// 目的：陌生的/特殊的 UI 节点（Reroute、SetNode、被旁路的变换节点、动态槽形态差异）不靠硬编码节点名，
// 而由调用方传入的声明式规则处理。本模块是 app 与 relay 共享的纯函数模块：不读盘、不做 IO，规则由调用方给。
// 形态：{ [nodeType]: { virtual?, passthrough?, bypass?, slots? } }
//   virtual: true          → 该类型的节点不进 prompt（Note / Reroute / SetNode 这类纯前端件）
//   passthrough: true      → 配合 virtual：经过该节点的连线穿透到它的上游真实源（支持多层嵌套）
//   bypass: "skip"|"passthrough"（仅字符串）
//                          → 节点 mode 4(bypass) 时的处理；缺省沿用旧行为（problems 拒绝）
//                            mode 2(mute) 不做配置项：mute 在 ComfyUI 里是断链，有档案时恒按 skip 处理
//   slots: [{ match, action: "passthrough"|"ignore"|"alias", as? }]
//                          → 槽级规则，match 支持 `*` 通配（`image*` 即前缀匹配），数组顺序先匹配先生效
//                            作用于「有连线的槽」与「只有 widget、没有连线的槽」两条路径
//                            passthrough 的实际含义就是「走默认动态槽路径且不记 warning」（显式化，不改行为）
// adapters 为 undefined/空时，以下逻辑一次也不介入，行为与 0.16.2 完全一致。
// 语义无效的规则不抛错也不静默：转成 warning（走 onWarning）并退回默认行为。
const ADAPTER_ACTIONS = new Set(["passthrough", "ignore", "alias"]);
const BYPASS_ACTIONS = new Set(["skip", "passthrough"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matchSlotPattern(pattern, name) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  return new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$").test(name);
}

function normalizeAdapters(adapters, warn) {
  const map = new Map();
  if (adapters === undefined || adapters === null) return map;
  if (!isPlainObject(adapters)) { warn(`adapters 需要对象（{ nodeType: rules }），收到 ${cutValue(adapters)}，已忽略`); return map; }
  for (const [type, raw] of Object.entries(adapters)) {
    if (!isPlainObject(raw)) { warn(`适配规则 ${type} 不是对象，已忽略`); continue; }
    const rules = {};
    if ("virtual" in raw) {
      if (typeof raw.virtual === "boolean") rules.virtual = raw.virtual;
      else warn(`适配规则 ${type}.virtual 需要布尔值（收到 ${cutValue(raw.virtual)}），已忽略`);
    }
    if ("passthrough" in raw) {
      if (typeof raw.passthrough === "boolean") rules.passthrough = raw.passthrough;
      else warn(`适配规则 ${type}.passthrough 需要布尔值（收到 ${cutValue(raw.passthrough)}），已忽略`);
    }
    if (rules.passthrough === true && rules.virtual !== true) {
      warn(`适配规则 ${type}.passthrough 需要配合 virtual: true（节点自身仍在 prompt 里，穿透语义无意义），已忽略 passthrough`);
      delete rules.passthrough;
    }
    if ("bypass" in raw) {
      const b = raw.bypass;
      if (BYPASS_ACTIONS.has(b)) rules.bypass = b;
      else if (isPlainObject(b)) warn(`适配规则 ${type}.bypass 不接受 { mute, bypass } 对象形式：mute（mode 2）是断链，不允许穿透，有档案时恒按 skip 处理；bypass 只作用于 mode 4，请直接写字符串 "skip" | "passthrough"。已忽略`);
      else warn(`适配规则 ${type}.bypass 需要 "skip" | "passthrough"（收到 ${cutValue(b)}），已忽略`);
    }
    if ("slots" in raw) {
      if (!Array.isArray(raw.slots)) {
        warn(`适配规则 ${type}.slots 需要数组，已忽略`);
      } else {
        const slots = [];
        for (let i = 0; i < raw.slots.length; i += 1) {
          const r = raw.slots[i];
          if (!isPlainObject(r)) { warn(`适配规则 ${type}.slots[${i}] 不是对象，已忽略`); continue; }
          if (typeof r.match !== "string" || !r.match) { warn(`适配规则 ${type}.slots[${i}] 的 match 需要非空字符串，已忽略`); continue; }
          const action = String(r.action || "");
          if (!ADAPTER_ACTIONS.has(action)) { warn(`适配规则 ${type}.slots[${i}]（match=「${r.match}」）的 action 需要 passthrough | ignore | alias（收到 ${cutValue(r.action)}），已忽略`); continue; }
          if (action === "alias" && (typeof r.as !== "string" || !r.as)) { warn(`适配规则 ${type}.slots[${i}]（match=「${r.match}」）action=alias 缺少 as（API 键名），已忽略该规则`); continue; }
          slots.push({ match: r.match, action, as: action === "alias" ? r.as : undefined });
        }
        if (slots.length) rules.slots = slots;
      }
    }
    if (Object.keys(rules).length === 0) continue;
    map.set(String(type), rules);
  }
  return map;
}

// 槽级规则：数组顺序先匹配先生效；命中多条且动作不同（或同 action 不同 as）→ warning（不静默吞掉被遮蔽的规则）
// 例外：结尾的 `*` 兑底规则被前面的具体规则遮住属正常用法，不算冲突；
// 反之，`*` 写在前面把后面的具体规则变死规则，则算冲突并告警。
function matchSlotRule(rules, name, warn) {
  if (!rules || !Array.isArray(rules.slots)) return null;
  let hit = null;
  const shadowed = new Set();
  const desc = (r) => `${r.action}${r.as ? ` as=${r.as}` : ""}`;
  for (const r of rules.slots) {
    if (!matchSlotPattern(r.match, name)) continue;
    if (!hit) { hit = r; continue; }
    if (r.action === hit.action && r.as === hit.as) continue;
    if (r.match === "*" && hit.match !== "*") continue; // 兑底被具体规则遮住：正常
    shadowed.add(desc(r));
  }
  if (hit && shadowed.size) {
    warn(`输入槽「${name}」同时命中多条角色不同的适配规则（采用先匹配的 ${desc(hit)}，被遮蔽：${[...shadowed].join("/")}）`);
  }
  return hit;
}

// options（可选）：{ strict = false, onWarning = null, adapters = undefined }
//   strict=true  → warnings 并入 errors，抛出行为与旧版完全一致；
//   onWarning(fn) → 每条 warning 调用一次（在判定 throw 之前，strict 下也会收到）。
export function convertUiToApi(wf, objectInfo, options) {
  const opts = isPlainObject(options) ? options : {};
  const strict = opts.strict === true;
  const onWarning = typeof opts.onWarning === "function" ? opts.onWarning : null;
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : null;
  if (!nodes) throw new Error("不是 UI 格式工作流（缺 nodes 数组）");
  const linkById = new Map();
  const rawLinks = []; // 仅适配规则重写用：保留 target/type，供穿透上溯（语义不变，linkById 仍是 origin/originSlot）
  if (Array.isArray(wf.links)) {
    for (const l of wf.links) {
      if (Array.isArray(l) && l.length >= 6) {
        rawLinks.push(l);
        linkById.set(l[0], { origin: l[1], originSlot: l[2] });
      }
    }
  }
  const out = {};
  // 降级分支用：prompt 只会包含非 Note 节点，origin 必须落在这些 id 里才是可引用的上游
  const emittableIds = new Set(
    nodes.filter((n) => n && typeof n === "object" && !NOTE_TYPES.has(String(n.type || ""))).map((n) => String(n.id)),
  );
  const problems = []; // 即 errors：仍会导致整份拒绝（R1 校验也推入此列表，语义不变）
  const warnings = []; // 仅记录、不拒绝：动态槽等可安全收编的构造

  // ── 适配规则：解析 + 连线重写（adapters 缺省时下面整段不介入）────────────────
  const adapters = normalizeAdapters(opts.adapters, (m) => warnings.push(m));
  const droppedIds = new Set(); // 不进 prompt 的节点（virtual / 按规则跳过的静音旁路）
  const passthroughIds = new Set(); // 连线需要穿透到上游真实源的节点
  if (adapters.size > 0) {
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const ntype = String(n.type || "");
      const rules = adapters.get(ntype);
      if (!rules) continue;
      const id = String(n.id);
      if (rules.virtual === true) {
        droppedIds.add(id);
        if (rules.passthrough === true) passthroughIds.add(id);
      }
      // 静音/旁路：无档案时这段不介入，mode 2/4 仍按旧行为拒绝（见主循环）。
      // mute(2) 在 ComfyUI 里是断链（上游不接到下游），所以只允许 skip，绝不允许穿透。
      // 这条判定必须排在 virtual/passthrough 注册之后并主动撤销穿透：否则 {virtual,passthrough}
      // 档案下的 mute 节点会照旧穿透，产物与 mode 0 完全一致且零告警。
      if (n.mode === 2) {
        const wasPassthrough = passthroughIds.delete(id); // mute 一律撤销穿透
        droppedIds.add(id);
        if (wasPassthrough || rules.bypass === "passthrough") {
          warnings.push(
            `节点 #${id} ${ntype} 处于 mute（mode 2）：mute 是断链，${wasPassthrough ? "virtual + passthrough" : 'bypass="passthrough"'} 不适用，已按 skip 处理`,
          );
        }
      } else if (n.mode === 4 && rules.bypass === "skip") {
        droppedIds.add(id);
      } else if (n.mode === 4 && rules.bypass === "passthrough") {
        droppedIds.add(id);
        passthroughIds.add(id);
      }
    }
  }
  if (droppedIds.size > 0 || passthroughIds.size > 0) {
    const rawById = new Map();
    for (const l of rawLinks) rawById.set(String(l[0]), l);
    const nodeById = new Map();
    for (const n of nodes) {
      if (n && typeof n === "object") nodeById.set(String(n.id), n);
    }
    const slotLinkOf = (node, idx) => { // 该输入槽上的连线（以槽自己的 link 字段为准，不看 links 数组顺序）
      const slot = Array.isArray(node.inputs) ? node.inputs[idx] : null;
      if (slot && slot.link !== null && slot.link !== undefined) {
        const l = rawById.get(String(slot.link));
        if (l) return l;
      }
      // 回退：槽上没写 link（或该 id 在 links 里不存在）时按 target 反查；仅在唯一命中时采用，保证顺序无关
      let hit = null;
      for (const l of rawLinks) {
        if (String(l[3]) !== String(node.id) || Number(l[4]) !== Number(idx)) continue;
        if (hit) return null; // 同一槽多条连线：图已经坏了，不猜
        hit = l;
      }
      return hit;
    };
    // 入口选择必须绑定「被消费的输出槽」（originSlot），不能只看 socket 类型取第一条同类型入边：
    // 像 ControlNetApplyAdvanced 这种 positive/negative 同类型的节点，取第一条会把条件静默换掉。
    // 顺序：同名配对（输出名 ↔ 输入名）→ 唯一同类型入边 → 其余一律判「歧义映射」并拒绝（绝不猜）。
    // 候选按 node.inputs 数组顺序枚举，因此结果与 wf.links 的数组顺序无关。
    const pickEntry = (node, os) => {
      const ins = Array.isArray(node.inputs) ? node.inputs : [];
      const outs = Array.isArray(node.outputs) ? node.outputs : [];
      const out = outs[os] && typeof outs[os] === "object" ? outs[os] : null;
      const outType = out && typeof out.type === "string" ? out.type : "";
      const typed = Boolean(outType) && outType !== "*";
      const outName = out && typeof out.name === "string" ? out.name : "";
      const cands = [];
      for (let i = 0; i < ins.length; i += 1) {
        const slot = ins[i];
        if (!slot || typeof slot !== "object") continue;
        if (typed && typeof slot.type === "string" && slot.type !== outType) continue;
        const link = slotLinkOf(node, i);
        if (!link) continue;
        cands.push({ idx: i, name: typeof slot.name === "string" ? slot.name : "", link });
      }
      if (!cands.length) return { link: null, why: null }; // 没有可用入口 → 下游走「连线缺失」
      if (outName) {
        const same = cands.filter((c) => c.name === outName);
        if (same.length === 1) return { link: same[0].link, why: null };
      }
      if (cands.length === 1) return { link: cands[0].link, why: null };
      return {
        link: null,
        why: `节点 #${node.id} ${node.type} 的旁路/穿透存在歧义映射：输出槽 ${os}${outName ? `「${outName}」` : ""}${typed ? `:${outType}` : ""} 对应多个同类型入口（${cands.map((c) => `「${c.name}」`).join("/")}），无法确定上游来源，已拒绝`,
      };
    };
    // 穿透：把经过 passthrough 节点的链路压缩到真实源；无上游 / 成环 / 歧义 → null（下游走既有「连线缺失」路径）
    const reported = new Set(); // 同一条歧义映射可能被多条下游连线重复碰到，只报一次
    const resolveReal = (origin, originSlot, seen) => {
      const id = String(origin);
      if (!passthroughIds.has(id)) return { origin, originSlot };
      if (seen.has(id)) return null;
      seen.add(id);
      const node = nodeById.get(id);
      if (!node) return null;
      const entry = pickEntry(node, originSlot);
      if (entry.why) { if (!reported.has(entry.why)) { reported.add(entry.why); problems.push(entry.why); } return null; }
      if (!entry.link) return null;
      return resolveReal(entry.link[1], entry.link[2], seen);
    };
    const rewritten = new Map();
    for (const l of rawLinks) {
      const real = resolveReal(l[1], l[2], new Set());
      if (!real) continue; // 穿透后无真实源 → 该连线作废，下游走既有「连线缺失」路径
      if (droppedIds.has(String(real.origin))) continue; // 上游本身是不进 prompt 且不穿透的节点 → 同上
      rewritten.set(l[0], { origin: real.origin, originSlot: real.originSlot });
    }
    linkById.clear();
    for (const [k, v] of rewritten) linkById.set(k, v);
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const type = String(n.type || "");
    if (NOTE_TYPES.has(type)) continue;
    if (droppedIds.has(String(n.id))) continue; // 适配规则：virtual / 按规则跳过的静音旁路节点不进 prompt
    if (n.mode === 2 || n.mode === 4) { problems.push(`节点 #${n.id} ${type} 处于静音/旁路状态`); continue; }
    if (UNSUPPORTED_UI_TYPES.has(type) || /^[0-9a-fA-F-]{20,}$/.test(type)) {
      problems.push(`节点 #${n.id} 类型 ${type}（子图/环绕节点）`);
      continue;
    }
    const info = objectInfo[type];
    if (!info) { problems.push(`节点 #${n.id} 类型 ${type} 不在 /object_info`); continue; }
    const required = info.input?.required || {};
    const optional = info.input?.optional || {};
    const declared = [...Object.keys(required), ...Object.keys(optional)];
    const declaredSet = new Set(declared);
    const nodeInputs = Array.isArray(n.inputs) ? n.inputs : [];
    const named = isPlainObject(n.widgets_values_named) ? n.widgets_values_named : null;
    const wv = Array.isArray(n.widgets_values) ? [...n.widgets_values] : [];
    const inputs = {};
    let wvi = 0;
    // 适配规则：槽级规则按节点缓存（同一槽在连线分支与 widget 分支都会被问到，冲突 warning 只报一次）；
    // 该节点类型无档案时 nodeRules 为 null，slotRuleOf 恒返回 null，下面所有规则点都不介入。
    const nodeRules = adapters.get(type) || null;
    const ruleCache = new Map();
    const slotRuleOf = (name) => {
      if (!nodeRules) return null;
      if (!ruleCache.has(name)) {
        ruleCache.set(name, matchSlotRule(nodeRules, name, (m) => warnings.push(`节点 #${n.id} ${type}：${m}`)));
      }
      return ruleCache.get(name);
    };
    // 写一个 widget 值：alias / ignore 在「只有 widget、没有连线」的槽上同样生效（社区节点的怪异 widget 槽就走这条路）。
    // 两阶段：先收集（不落地），全部算完再合并——这样「alias 撞上另一个 widget 的键」不论声明顺序都能识别出冲突。
    const widgetWrites = [];
    const pushWidget = (name, val) => {
      const rule = slotRuleOf(name);
      if (rule && rule.action === "ignore") return;
      const alias = Boolean(rule && rule.action === "alias");
      const key = alias ? rule.as : name;
      if (!key) return;
      widgetWrites.push({ name, key, alias, val });
    };

    // ① 连线槽：以实例数组为准收编（含 autogrow 动态子槽，如 images.image_1 / values.a；槽名即 API 键名）
    for (const slot of nodeInputs) {
      if (!slot || typeof slot !== "object") continue;
      const lid = slot.link;
      if (lid === null || lid === undefined) continue;
      const sname = typeof slot.name === "string" ? slot.name : "";
      // 适配规则：槽级（先于声明判断生效；该类型无规则时 srule 恒为 null，下面整段不介入）
      const srule = slotRuleOf(sname);
      if (srule && srule.action === "ignore") continue;
      const adapterKey = srule ? (srule.action === "alias" ? srule.as : sname) : null;
      if (srule && !adapterKey) {
        warnings.push(`节点 #${n.id} ${type} 的输入槽（无名）命中了适配规则 action=${srule.action}，无法作 API 键，已按默认流程处理`);
      } else if (srule) {
        const rl = linkById.get(lid);
        if (!rl) { problems.push(`节点 #${n.id} 输入 ${adapterKey} 的连线缺失（link ${lid}）`); continue; }
        if (!emittableIds.has(String(rl.origin))) {
          problems.push(`节点 #${n.id} 输入 ${adapterKey} 的连线 origin ${rl.origin} 不在工作流节点内（无法引用上游）`);
          continue;
        }
        inputs[adapterKey] = [String(rl.origin), rl.originSlot];
        continue;
      }
      if (!sname || !(declaredSet.has(sname) || declared.some((d) => sname.startsWith(d + ".")))) {
        // 动态输入槽（如 FlexibleOptionalInputType / TriggerWord Toggle）不出现在 /object_info，
        // 槽名不在 declared 里属正常：能找到连线就按连线原样收编，仅记 warning；
        // 无名槽无法作 API 键、连线缺失或 origin 不在工作流节点内则无从取源，三者归 errors。
        const dyn = sname ? linkById.get(lid) : null;
        if (!dyn) {
          problems.push(`节点 #${n.id} 输入槽 ${sname ? `「${sname}」` : "（无名）"}不对应任何声明输入（连线无法收编）`);
          continue;
        }
        if (!emittableIds.has(String(dyn.origin))) {
          problems.push(`节点 #${n.id} 输入槽「${sname}」的连线 origin ${dyn.origin} 不在工作流节点内（无法引用上游）`);
          continue;
        }
        warnings.push(`节点 #${n.id} 输入槽「${sname}」不对应任何声明输入（按动态输入槽处理）`);
        inputs[sname] = [String(dyn.origin), dyn.originSlot];
        continue;
      }
      const link = linkById.get(lid);
      if (!link) { problems.push(`节点 #${n.id} 输入 ${sname} 的连线缺失（link ${lid}）`); continue; }
      inputs[sname] = [String(link.origin), link.originSlot];
    }

    // ② widget 值：优先 widgets_values_named 按名取值（被连线 widget 亦占位，按名读天然免疫错位）；
    //    无 named 的位置回退：widget 位（含被连线覆盖者）消耗 wvi 一格；非 widget 类型 / forceInput 不消耗。
    //    R1（2026-10-08）：双字段皆存时先做 named↔位置交叉校验，分歧即拒绝（附分歧清单），见 ③。
    if (named) {
      for (const name of declared) {
        if (Object.prototype.hasOwnProperty.call(inputs, name)) continue; // 已被连线覆盖
        const spec = required[name] || optional[name];
        if (!spec) continue;
        const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
        if (NON_WIDGET_INPUT_TYPES.has(t)) continue;
        if (spec[1] && spec[1].forceInput === true) continue;
        if (!Object.prototype.hasOwnProperty.call(named, name)) continue;
        let val = named[name];
        if (isPlainObject(val) && "value" in val) val = val.value;
        if (val !== undefined) pushWidget(name, val);
      }
    } else {
      // widget 位按实例槽的 widget 标记枚举（排除 socketless 展示件）；无槽证据时按声明顺序扫描
      const slotWidgets = nodeInputs.filter((s) => s && typeof s === "object" && isPlainObject(s.widget) && typeof s.name === "string");
      const positions = slotWidgets.length
        ? slotWidgets
            .filter((s) => {
              const spec = required[s.name] || optional[s.name];
              return !(spec && spec[1] && spec[1].socketless === true);
            })
            .map((s) => s.name)
        : declared.filter((name) => {
            const spec = required[name] || optional[name];
            if (!spec) return false;
            const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
            return WIDGET_SPEC_TYPES.has(t) && !(spec[1] && spec[1].forceInput === true);
          });
      for (const name of positions) {
        let val;
        if (wvi < wv.length) val = wv[wvi++];
        if ((name === "seed" || name === "noise_seed") && wvi < wv.length && typeof wv[wvi] === "string" && SEED_CONTROL_VALUES.has(wv[wvi])) {
          wvi += 1; // 跳过 control_after_generate 副值
        }
        if (!declaredSet.has(name)) continue; // 非声明 widget（如 upload）：只占位不注入
        if (Object.prototype.hasOwnProperty.call(inputs, name)) continue; // 被连线覆盖：已占位，不覆盖连线
        if (isPlainObject(val) && "value" in val) val = val.value;
        if (val !== undefined) pushWidget(name, val);
      }
    }

    // ②' 两阶段写入：真 widget 先落，alias 后落。
    //     真值永远优先——alias 撞上「连线占位」或「另一个真 widget」一律 warn 并跳过，不静默挤掉真值；
    //     因此撞键结果与 object_info 的声明顺序（或位置槽顺序）无关。
    for (const w of widgetWrites) {
      if (w.alias) continue;
      if (Object.prototype.hasOwnProperty.call(inputs, w.key)) continue; // 被连线覆盖（原语义）
      inputs[w.key] = w.val;
    }
    for (const w of widgetWrites) {
      if (!w.alias) continue;
      if (Object.prototype.hasOwnProperty.call(inputs, w.key)) {
        warnings.push(`节点 #${n.id} ${type} 的输入 ${w.name} 按适配规则 alias 到「${w.key}」，但该键已被占用（连线或另一个 widget），已跳过别名注入`);
        continue;
      }
      inputs[w.key] = w.val;
    }

    // ③ R1 校验（2026-10-08）：双字段皆存 → named 主键 vs 位置值交叉核对；分歧 → problems（最终 throw）。
    //    只覆盖 NAMED_WV_CHECK 内类型（对位语义已核验）；分歧清单含节点号 / 类型 / 两侧值。
    if (named && wv.length > 0) {
      const checkKey = NAMED_WV_CHECK.get(type);
      if (checkKey && Object.prototype.hasOwnProperty.call(named, checkKey)) {
        let namedVal = named[checkKey];
        if (isPlainObject(namedVal) && "value" in namedVal) namedVal = namedVal.value;
        if (JSON.stringify(namedVal) !== JSON.stringify(wv[0])) {
          problems.push(
            `节点 #${n.id} ${type}.${checkKey} 的 widgets_values_named 与 widgets_values 位置值分歧（named=${cutValue(namedVal)} ≠ wv[0]=${cutValue(wv[0])}）——疑似过期 named（外部脚本只改位置值的产物），已拒绝（防静默采用旧值）`,
          );
        }
      }
    }

    out[String(n.id)] = { class_type: type, inputs };
    if (typeof n.title === "string" && n.title) out[String(n.id)]._meta = { title: n.title };
  }
  // 回调失败只影响它自己，不掩盖真实转换结果
  if (onWarning) for (const w of warnings) { try { onWarning(w); } catch { /* 忽略回调自身异常 */ } }
  const blocking = strict ? [...problems, ...warnings] : problems;
  if (blocking.length) {
    throw new Error(`UI→API 转换遇到不支持的构造：${blocking.slice(0, 6).join("；")}${blocking.length > 6 ? " 等" : ""}。请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。`);
  }
  return out;
}

export function applyInputs(prompt, inputs) {
  const applied = [];
  if (!inputs) return applied;
  if (!isPlainObject(inputs)) throw new Error("inputs 需要对象：{\"<node_id>.<input>\": value}");
  for (const [key, value] of Object.entries(inputs)) {
    const i = key.lastIndexOf(".");
    if (i <= 0) throw new Error(`inputs 键格式应为 "<node_id>.<input>"：${key}`);
    const nodeId = key.slice(0, i);
    const inputName = key.slice(i + 1);
    const node = prompt[nodeId];
    if (!node || !isPlainObject(node)) {
      throw new Error(`inputs 注入失败：节点 ${nodeId} 不存在（现有节点 id：${Object.keys(prompt).slice(0, 30).join(", ")}）`);
    }
    node.inputs = isPlainObject(node.inputs) ? node.inputs : {};
    node.inputs[inputName] = value;
    applied.push(key);
  }
  return applied;
}

export function summarizeWorkflow(parsed) {
  if (Array.isArray(parsed?.nodes)) {
    const nodes = parsed.nodes
      .filter((n) => n && !NOTE_TYPES.has(String(n.type)))
      .map((n) => ({ id: n.id, type: n.type, title: n.title || undefined }));
    return { format: "ui", nodeCount: nodes.length, nodes };
  }
  if (isPlainObject(parsed)) {
    const nodes = Object.entries(parsed).map(([id, n]) => ({ id, type: n?.class_type, title: n?._meta?.title || undefined }));
    return { format: "api", nodeCount: nodes.length, nodes };
  }
  return { format: "unknown", nodeCount: 0, nodes: [] };
}
