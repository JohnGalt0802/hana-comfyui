// lib/workflow-tools.mjs — 工作流解析/转换/注入（app 与中继共享）
// 2026-09-29（M13）：从 index.js 抽出，供 app(index.js) 与中继(runtime/comfy-relay.mjs) 同源使用。
// 中继侧直提（/_relay/submit-file）需要同一份 UI→API 转换与 inputs 注入逻辑，避免双实现漂移。
// 2026-10-08（R1）：补 named↔位置值交叉校验（fail-loud），防「过期 named 被静默采用」的值分叉类事故。

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);
export const UNSUPPORTED_UI_TYPES = new Set(["Reroute", "PrimitiveNode", "Subgraph", "GroupNode", "SubgraphInputNode", "SubgraphOutputNode"]);

// UI 格式（nodes/links）→ API 格式：经典图子集（环绕节点明确报错；静音/旁路按 ComfyUI 语义处理——mute 断链不执行、bypass 按类型穿透，2026-10-31；带 definitions.subgraphs 的实例先展开为普通节点，见「子图展开 v1」）
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
//   pull: { keyPath, fromType[], fromKeyPath, sourcePath }
//                          → 配合 virtual：按「名字」在整图里配对同类节点（如 GetNode 找同名 SetNode），
//                            取配对节点 sourcePath 那格输入的上游作为真实源（可与 passthrough 链式串联）
//                            0 候选 / 配对节点悬空 → 该连线作废，下游走既有「连线缺失」路径
//                            ≥2 候选（同名不唯一）/ 输出槽与取源槽类型不兼容 → problems，整份拒绝
//                            与 passthrough 同时声明时 pull 优先（passthrough 丢弃）；mute/bypass 恒按 skip（断链），不取源
//                            （Get 没有输入槽，旁路在无输入节点上只能当断链；档案写了 bypass="passthrough" 也不穿透）
//                            配对范围只有 wf.nodes 这一张图（子图定义不在 nodes 里，天然不参与）
//   bypass: "skip"|"passthrough"（仅字符串）
//                          → 节点 mode 4(bypass) 时的处理；缺省按 ComfyUI 默认语义（穿透到同类型输入，2026-10-31）
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
// pull 规则的路径语法（只认两种形态，可连续）：
//   `字段` / `字段[数字]`，例：widgets_values[0]、inputs[0]、a[0].b
// 解析成 token 序列 [{ key } | { index }]；语法不合法返回 null（调用方按「忽略该规则」处理）。
function parseFieldPath(path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const tokens = [];
  for (const seg of path.trim().split(".")) {
    const m = /^([^[\].]+)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return null;
    tokens.push({ key: m[1] });
    for (const n of m[2].match(/\d+/g) || []) tokens.push({ index: Number(n) });
  }
  return tokens.length ? tokens : null;
}
// 路径字段的多值形态（2026-10-31，P4）：keyPath / fromKeyPath 允许「字符串」或「字符串数组」。
// 数组 = 按序回退：项目其它地方是「named 优先、位置回退」双写，一份档案可能同时要写两条路，
// 例：["widgets_values_named.key", "widgets_values[0]"]——按序尝试，用第一个取到非空字符串的。
// sourcePath 保持单值（它指向「配对节点的那一格输入槽」，回退语义无意义）。
// 非法形态（非字符串 / 非字符串数组 / 空数组 / 数组里任一项语法不合法）→ null（调用方按「忽略该规则」处理）。
function parseFieldPathAlternatives(value) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const alts = [];
  for (const one of list) {
    const tokens = parseFieldPath(one);
    if (!tokens) return null;
    alts.push({ raw: one, tokens });
  }
  return alts;
}
// 按 token 序列取值；任何一步缺失（键不存在 / 越界 / 类型不对）都返回 undefined，不猜
function readFieldPath(value, tokens) {
  let cur = value;
  for (const t of tokens) {
    if (t.index !== undefined) {
      if (!Array.isArray(cur) || t.index >= cur.length) return undefined;
      cur = cur[t.index];
    } else {
      if (cur === null || typeof cur !== "object") return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, t.key)) return undefined;
      cur = cur[t.key];
    }
  }
  return cur;
}
// 按序回退取值：第一个「取到非空字符串」的路径胜出（空串视为没有值，继续回退）；全部取不到 → null
function readFieldPathAlternatives(value, alts) {
  for (const alt of alts) {
    const v = readFieldPath(value, alt.tokens);
    if (typeof v === "string" && v) return { value: v, raw: alt.raw };
  }
  return null;
}
// 诊断文案里展示路径：数组形态用 " | " 连接（不引 JSON 转义噪音）
const fieldPathDesc = (v) => (Array.isArray(v) ? v.join(" | ") : String(v));
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
    if ("pull" in raw) {
      const p = raw.pull;
      const drop = (why) => warn(`适配规则 ${type}.pull ${why}，已忽略该规则`);
      if (!isPlainObject(p)) {
        drop(`需要对象（{ keyPath, fromType, fromKeyPath, sourcePath }），收到 ${cutValue(p)}`);
      } else {
        const keyPaths = parseFieldPathAlternatives(p.keyPath);
        const fromKeyPaths = parseFieldPathAlternatives(p.fromKeyPath);
        const sourcePathTokens = parseFieldPath(p.sourcePath);
        const bad = [
          ["keyPath", p.keyPath, keyPaths, "路径或它们的非空字符串数组"],
          ["fromKeyPath", p.fromKeyPath, fromKeyPaths, "路径或它们的非空字符串数组"],
          ["sourcePath", p.sourcePath, sourcePathTokens, "路径"],
        ].find(([, , parsed]) => !parsed);
        if (bad) {
          drop(`的 ${bad[0]} 需要「字段」或「字段[数字]」形式的${bad[3]}（收到 ${cutValue(bad[1])}）`);
        } else if (!Array.isArray(p.fromType) || p.fromType.length === 0 || p.fromType.some((t) => typeof t !== "string" || !t)) {
          drop(`的 fromType 需要非空字符串数组（收到 ${cutValue(p.fromType)}）`);
        } else {
          rules.pull = {
            keyPath: p.keyPath,
            keyPaths,
            fromType: [...p.fromType],
            fromTypes: new Set(p.fromType),
            fromKeyPath: p.fromKeyPath,
            fromKeyPaths,
            sourcePath: p.sourcePath,
            sourcePathTokens,
          };
        }
      }
    }
    // pull 只在「节点自己不进 prompt」时才有意义（节点还在 prompt 里就没有「按名取源」这回事）
    if (rules.pull && rules.virtual !== true) {
      warn(`适配规则 ${type}.pull 需要配合 virtual: true（节点自身仍在 prompt 里，pull 语义无意义），已忽略 pull`);
      delete rules.pull;
    }
    // 同一档案里 pull 与 passthrough 冲突（两条路径抢同一条出边的解释权）→ pull 优先
    if (rules.pull && rules.passthrough === true) {
      warn(`适配规则 ${type} 同时声明了 pull 与 passthrough（语义冲突，pull 优先），已忽略 passthrough`);
      delete rules.passthrough;
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

// 拒绝报错的「归类汇总」辅助（2026-10-31）：只拼文案，不参与任何判定，不对外导出。
// summarizeProblems 按类别统计全量 problems；未知类型的类型名从「类型 X 不在 /object_info」解析，
// 解析不到的条目只进数量不进 Top（宁可少列不编造）。
const summarizeProblems = (list) => {
  const counts = { unknown_type: 0, mute_bypass: 0, missing_link: 0, subgraph: 0, pull: 0, other: 0 };
  const unknownNames = new Map(); // 未知类型的类型名 → 次数
  for (const msg of list) {
    if (/不在 \/object_info/.test(msg)) {
      counts.unknown_type++;
      const m = /类型 ([^\s（(]+) 不在 \/object_info/.exec(msg);
      if (m) unknownNames.set(m[1], (unknownNames.get(m[1]) || 0) + 1);
    } else if (/处于静音|处于旁路|处于未知 mode/.test(msg)) counts.mute_bypass++;
    else if (/连线缺失|不在工作流节点内/.test(msg)) counts.missing_link++;
    else if (/子图/.test(msg) || /^[0-9a-fA-F-]{20,}$/.test(msg)) counts.subgraph++;
    else if (/按名字|pull/.test(msg)) counts.pull++;
    else counts.other++;
  }
  // ≥2 个不同类型名才列 Top（同一类型重复多份只给数量，不制造重复噪音）
  const topTypes = [...unknownNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const parts = [];
  if (counts.unknown_type > 0) {
    const seg = `未知类型 ${counts.unknown_type}`;
    parts.push(topTypes.length > 1 ? `${seg}（涉及类型：${topTypes.map(([t, c]) => `${t} ×${c}`).join("、")}）` : seg);
  }
  if (counts.mute_bypass > 0) parts.push(`静音/旁路 ${counts.mute_bypass}`);
  if (counts.missing_link > 0) parts.push(`连线缺失 ${counts.missing_link}`);
  if (counts.subgraph > 0) parts.push(`子图 ${counts.subgraph}`);
  if (counts.pull > 0) parts.push(`pull ${counts.pull}`);
  if (counts.other > 0) parts.push(`其他 ${counts.other}`);
  return `共 ${list.length} 项阻断，分类：${parts.join(" · ")}。未知类型通常是本机没有安装对应插件：在 ComfyUI 里装好后重试；若确认是纯前端辅助件（不进 prompt），可写一份适配档案，写法见 app/skills/comfy-node-adapter/SKILL.md。`;
};

// ── 子图（subgraph）展开 v1（2026-10-31）────────────────────────────────────
// 单层展开：wf.nodes 里 type 命中 definitions.subgraphs[].id 的实例，替换为子图内部节点——
//   节点 id 重映射为 "s<实例id>:<内部id>"，link id 重映射为 "s<实例id>L<原id>"（不与任何既有 id 撞车）；
//   外部连线经实例的输入/输出接口（-10/-20）直连到内部消费端/生产者；实例 widgets_values 沿接口
//   连线写入目标节点的 named（按 widget 名）与位置值（按声明位序，与主循环共用 declaredWidgetSlots）。
//   对位一律按名字（2026-10-31 修）：实例槽下标 ≠ 定义下标（实例只暴露部分输入、槽序也可不同），
//   接线与取值都走「实例槽名 / 实例 named 键 → 定义输入名 → 定义下标 → -10 链接」；下标只作
//   widgets_values 的位置回退（无 named 时才用，且数量必须与定义 widget 输入数一致，否则拒绝）。
//   原则：widget 值要么正确传递、
//   要么整份拒绝——绝不静默产出错参数；口径没覆盖的情形一律拒绝并点名，绝不猜。
// 约束：不支持嵌套子图；实例被静音/旁路直接拒绝；展开阶段不查 /object_info（内部节点照常走既有校验）。
// 无 definitions.subgraphs 或没有实例时原样返回 wf（不动任何字段，输出与未展开逐字一致）。
function subgraphValueEq(a, b) {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 : a === b;
}
const subgraphUnwrap = (v) => (isPlainObject(v) && "value" in v ? v.value : v);

// 按「声明顺序」枚举节点占据 widget 位（即 widgets_values 位置序）的输入，返回「输入名 → 位置」Map。
// 与转换器主循环②段、子图展开 widget 值定位共用同一份实现（禁止两套口径漂移）：
//   - 节点 inputs 里存在带 widget 标记的槽（实例槽证据）→ 按槽序枚举，剔除 socketless 展示件；
//   - 无槽证据 → 按 object_info 声明序扫 required+optional，跳过非 widget 类型与 forceInput。
// 两条路径都含 seed/noise_seed 的 control_after_generate 副值跳格（副值多占一格）。
// info 为该节点的 /object_info 条目（可缺：无槽证据时拿不到任何位置 → 空 Map）。
function declaredWidgetSlots(info, node) {
  const input = isPlainObject(info) && isPlainObject(info.input) ? info.input : {};
  const required = isPlainObject(input.required) ? input.required : {};
  const optional = isPlainObject(input.optional) ? input.optional : {};
  const specOf = (name) => required[name] || optional[name];
  const nodeInputs = isPlainObject(node) && Array.isArray(node.inputs) ? node.inputs : [];
  const wvArr = isPlainObject(node) && Array.isArray(node.widgets_values) ? node.widgets_values : null;
  const slotWidgets = nodeInputs.filter((s) => s && typeof s === "object" && isPlainObject(s.widget) && typeof s.name === "string");
  const names = slotWidgets.length
    ? slotWidgets
        .filter((s) => {
          const spec = specOf(s.name);
          return !(spec && spec[1] && spec[1].socketless === true);
        })
        .map((s) => s.name)
    : [...Object.keys(required), ...Object.keys(optional)].filter((name) => {
        const spec = specOf(name);
        if (!spec) return false;
        const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
        return WIDGET_SPEC_TYPES.has(t) && !(spec[1] && spec[1].forceInput === true);
      });
  const slots = new Map();
  let pos = 0;
  for (const name of names) {
    slots.set(name, pos);
    pos += 1;
    if ((name === "seed" || name === "noise_seed") && wvArr && typeof wvArr[pos] === "string" && SEED_CONTROL_VALUES.has(wvArr[pos])) pos += 1; // 副值多占一格
  }
  return slots;
}

// widget 位序定位：目标输入名在声明序 widget 位里的位置（declaredWidgetSlots 的共用口径）。
// 未知类型（不在 objectInfo）/ 目标名不在声明里 → null（不猜，由调用方拒绝并点名）。
function subgraphWidgetIndexOf(objectInfo, node, targetSlotIdx) {
  const info = objectInfo && isPlainObject(node) && typeof node.type === "string" ? objectInfo[node.type] : null;
  if (!isPlainObject(info)) return null;
  const input = isPlainObject(info.input) ? info.input : {};
  const slot = Array.isArray(node.inputs) ? node.inputs[targetSlotIdx] : null;
  const name = slot && typeof slot.name === "string" ? slot.name : "";
  if (!name) return null;
  if (!Object.prototype.hasOwnProperty.call(input.required || {}, name) && !Object.prototype.hasOwnProperty.call(input.optional || {}, name)) return null;
  const idx = declaredWidgetSlots(info, node).get(name);
  return idx === undefined ? null : idx;
}

// 槽序近似定位（旧实现）：按节点 inputs 带 widget 标记的槽序消耗 widgets_values，seed 副值多占一格。
// 只用于「目标类型不在 objectInfo / 该键不在声明里」时的只读现值比对（判异同、决定放行或拒绝），
// 绝不用于写位置：写位置只走 declaredWidgetSlots 的声明序口径。
function slotOrderWidgetIndexOf(node, targetSlotIdx, wv) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  let wvi = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    const s = inputs[i];
    if (!s || typeof s !== "object" || !isPlainObject(s.widget) || typeof s.name !== "string") continue;
    if (i === targetSlotIdx) return wvi;
    wvi += 1;
    if ((s.name === "seed" || s.name === "noise_seed") && Array.isArray(wv) && typeof wv[wvi] === "string" && SEED_CONTROL_VALUES.has(wv[wvi])) wvi += 1;
  }
  return null;
}

export function expandSubgraphs(wf, problems, objectInfo, warnings) {
  const defs = wf && isPlainObject(wf) && isPlainObject(wf.definitions) ? wf.definitions.subgraphs : null;
  if (!Array.isArray(defs) || defs.length === 0) return wf;
  const defById = new Map();
  for (const d of defs) {
    if (d && typeof d === "object" && !Array.isArray(d) && typeof d.id === "string" && d.id) defById.set(d.id, d);
  }
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const isInst = (n) => n && typeof n === "object" && defById.has(String(n.type));
  if (!nodes.some(isInst)) return wf;

  const cloneOutSlot = (s) => (s && typeof s === "object" ? (Array.isArray(s.links) ? { ...s, links: [...s.links] } : { ...s }) : s);

  // 阶段一：逐实例克隆内部节点并重映射 id/link id；±10/±20 接口链接在此消化（不进产物 links）。
  // 阶段三会反向写入定义内部节点（named/位置值），因此每个实例必须拿到自己的深拷贝——
  // 同一子图被多个实例引用时共享原定义会互相污染（首实例先写，后实例就看不到旧值了）。
  const cloneInner = (m) => {
    if (!m || typeof m !== "object") return m;
    return {
      ...m,
      id: m.id,
      inputs: Array.isArray(m.inputs) ? m.inputs.map((s) => (s && typeof s === "object" ? { ...s } : s)) : m.inputs,
      outputs: Array.isArray(m.outputs) ? m.outputs.map(cloneOutSlot) : m.outputs,
      widgets_values: Array.isArray(m.widgets_values) ? [...m.widgets_values] : m.widgets_values,
      widgets_values_named: isPlainObject(m.widgets_values_named) ? { ...m.widgets_values_named } : m.widgets_values_named,
    };
  };
  const ctxByInst = new Map(); // String(实例id) → ctx
  for (const inst of nodes) {
    if (!isInst(inst)) continue;
    const sid = String(inst.id);
    const def = defById.get(String(inst.type));
    const defClone = {
      ...def,
      nodes: Array.isArray(def.nodes) ? def.nodes.map(cloneInner) : def.nodes,
      links: Array.isArray(def.links) ? def.links.map((l) => (l && typeof l === "object" ? { ...l } : l)) : def.links,
      inputs: Array.isArray(def.inputs) ? def.inputs.map((s) => (s && typeof s === "object" ? { ...s } : s)) : def.inputs,
    };
    const defName = typeof def.name === "string" && def.name ? def.name : def.id;
    const fail = (msg) => problems.push(msg);
    const mode = Number(inst.mode);
    if (mode === 2 || mode === 4) { fail(`子图实例 #${sid}（「${defName}」）被静音/旁路（mode ${mode}），子图展开 v1 暂不处理`); continue; }
    const innerNodes = Array.isArray(defClone.nodes) ? defClone.nodes : null;
    const innerLinks = Array.isArray(defClone.links) ? defClone.links : null;
    if (!innerNodes || !innerLinks) { fail(`子图「${defName}」定义缺 nodes/links 数组，无法展开实例 #${sid}`); continue; }
    // links 是数字数组 = 旧版前端序列化的子图格式，与「结构残缺」区分开，让人一眼知道不是自己的图坏了
    if (innerLinks.some((l) => typeof l === "number" || Array.isArray(l))) {
      fail(`子图「${defName}」的 links 是旧版子图格式（links 为数组而非链接对象列表，旧版前端序列化产物），当前引擎无法展开，实例 #${sid} 已拒绝`);
      continue;
    }
    const nested = innerNodes.find((m) => m && typeof m === "object" && defById.has(String(m.type)));
    if (nested) {
      const nd = defById.get(String(nested.type));
      fail(`子图「${defName}」的内部节点 #${nested.id}（type=${nested.type}，是子图「${nd && typeof nd.name === "string" && nd.name ? nd.name : nested.type}」）：子图展开 v1 不支持嵌套`);
      continue;
    }
    const idMap = new Map();
    let broken = false;
    for (const m of innerNodes) {
      if (!m || typeof m !== "object" || m.id === undefined || m.id === null) { fail(`子图「${defName}」存在缺 id 的内部节点，无法展开实例 #${sid}`); broken = true; break; }
      if (idMap.has(String(m.id))) { fail(`子图「${defName}」内部节点 id 重复（#${m.id}），无法展开实例 #${sid}`); broken = true; break; }
      idMap.set(String(m.id), `s${sid}:${m.id}`);
    }
    if (broken) continue;
    const cloned = new Map();
    for (const m of innerNodes) {
      cloned.set(String(m.id), {
        ...m,
        id: idMap.get(String(m.id)),
        inputs: Array.isArray(m.inputs) ? m.inputs.map((s) => (s && typeof s === "object" ? { ...s } : s)) : m.inputs,
        outputs: Array.isArray(m.outputs) ? m.outputs.map(cloneOutSlot) : m.outputs,
        widgets_values: Array.isArray(m.widgets_values) ? [...m.widgets_values] : m.widgets_values,
        widgets_values_named: isPlainObject(m.widgets_values_named) ? { ...m.widgets_values_named } : m.widgets_values_named,
      });
    }
    // 定义输入名 → 定义下标（按名字对位的唯一依据，2026-10-31 修）：实例槽下标与定义下标是两套序，禁止互代
    const defByName = new Map();
    const defDupNames = new Set();
    const defInputsArr = Array.isArray(defClone.inputs) ? defClone.inputs : [];
    for (let j = 0; j < defInputsArr.length; j += 1) {
      const dn = defInputsArr[j];
      const nm = dn && typeof dn === "object" && typeof dn.name === "string" ? dn.name : "";
      if (!nm) continue;
      if (defByName.has(nm)) defDupNames.add(nm);
      else defByName.set(nm, j);
    }
    const ctx = { inst, sid, defName, innerNodes, innerDef: defClone, idMap, cloned, defByName, defDupNames, inputBySlot: new Map(), outputBySlot: new Map(), usedInputs: new Map(), fedInputs: new Set(), internalLinks: [] };
    for (const l of innerLinks) {
      if (!l || typeof l !== "object" || Array.isArray(l) || l.id === undefined || l.origin_id === undefined || l.target_id === undefined) {
        fail(`子图「${defName}」的 links 存在缺 id/端点的项，无法展开实例 #${sid}`); broken = true; break;
      }
      const os = Number(l.origin_slot);
      const ts = Number(l.target_slot);
      if (!Number.isInteger(os) || os < 0 || !Number.isInteger(ts) || ts < 0) {
        fail(`子图「${defName}」链接 #${l.id} 的槽位（origin_slot=${l.origin_slot}, target_slot=${l.target_slot}）不是非负整数`); broken = true; break;
      }
      const oid = String(l.origin_id);
      const tid = String(l.target_id);
      const lid = `s${sid}L${l.id}`;
      const fedKey = `${tid}:${ts}`;
      if (tid === "-10") { fail(`子图「${defName}」链接 #${l.id} 指向输入接口（-10）：不符合子图链接结构`); broken = true; break; }
      if (oid === "-20") { fail(`子图「${defName}」链接 #${l.id} 从输出接口（-20）出发：不符合子图链接结构`); broken = true; break; }
      if (oid === "-10") {
        if (ctx.inputBySlot.has(os)) { fail(`子图「${defName}」输入接口槽 ${os} 对应多条链接，无法确定实例输入 ${os} 的消费端`); broken = true; break; }
        if (!idMap.has(tid)) { fail(`子图「${defName}」输入链接 #${l.id} 的目标节点 #${tid} 不在子图 nodes 里`); broken = true; break; }
        const tn = cloned.get(tid);
        const slot = Array.isArray(tn.inputs) ? tn.inputs[ts] : null;
        if (!slot || typeof slot !== "object") { fail(`子图「${defName}」输入链接 #${l.id} 的消费端（节点 #${tid} 输入槽 ${ts}）不存在`); broken = true; break; }
        if (ctx.fedInputs.has(fedKey)) { fail(`子图「${defName}」节点 #${tid} 输入槽 ${ts} 被多条链接喂入（含输入接口链接 #${l.id}）`); broken = true; break; }
        if (slot.link !== null && slot.link !== undefined && String(slot.link) !== String(l.id)) { fail(`子图「${defName}」节点 #${tid} 输入槽 ${ts} 的 link 字段（${slot.link}）与输入接口链接 #${l.id} 不一致`); broken = true; break; }
        ctx.fedInputs.add(fedKey);
        slot.link = null; // 先清空：接线阶段有外部连线则改写为外部连线 id，否则走 widget/named 值
        ctx.inputBySlot.set(os, { targetId: tid, targetSlot: ts });
        continue;
      }
      if (tid === "-20") {
        if (ctx.outputBySlot.has(ts)) { fail(`子图「${defName}」输出接口槽 ${ts} 对应多条链接，无法确定实例输出 ${ts} 的生产者`); broken = true; break; }
        if (!idMap.has(oid)) { fail(`子图「${defName}」输出链接 #${l.id} 的生产者 #${oid} 不在子图 nodes 里`); broken = true; break; }
        const on = cloned.get(oid);
        const oslot = Array.isArray(on.outputs) ? on.outputs[os] : null;
        if (!oslot || typeof oslot !== "object" || !Array.isArray(oslot.links) || !oslot.links.some((x) => String(x) === String(l.id))) {
          fail(`子图「${defName}」输出链接 #${l.id} 未出现在生产者 #${oid} 输出槽 ${os} 的 links 里（子图 links 缺项）`); broken = true; break;
        }
        oslot.links = oslot.links.filter((x) => String(x) !== String(l.id));
        ctx.outputBySlot.set(ts, { originId: oid, originSlot: os });
        continue;
      }
      // 内部 → 内部：重映射进产物
      if (!idMap.has(oid) || !idMap.has(tid)) { fail(`子图「${defName}」链接 #${l.id} 的端点（#${l.origin_id} → #${l.target_id}）不在子图 nodes 里`); broken = true; break; }
      const on = cloned.get(oid);
      const tn = cloned.get(tid);
      const oslot = Array.isArray(on.outputs) ? on.outputs[os] : null;
      const tslot = Array.isArray(tn.inputs) ? tn.inputs[ts] : null;
      if (!oslot || typeof oslot !== "object") { fail(`子图「${defName}」链接 #${l.id} 的起点（节点 #${oid} 输出槽 ${os}）不存在`); broken = true; break; }
      if (!tslot || typeof tslot !== "object") { fail(`子图「${defName}」链接 #${l.id} 的终点（节点 #${tid} 输入槽 ${ts}）不存在`); broken = true; break; }
      if (!Array.isArray(oslot.links) || !oslot.links.some((x) => String(x) === String(l.id))) {
        fail(`子图「${defName}」链接 #${l.id} 未出现在生产者 #${oid} 输出槽 ${os} 的 links 里（子图 links 缺项）`); broken = true; break;
      }
      if (ctx.fedInputs.has(fedKey)) { fail(`子图「${defName}」节点 #${tid} 输入槽 ${ts} 被多条链接喂入（含链接 #${l.id}）`); broken = true; break; }
      ctx.fedInputs.add(fedKey);
      oslot.links = oslot.links.map((x) => (String(x) === String(l.id) ? lid : x));
      if (tslot.link !== null && tslot.link !== undefined && String(tslot.link) !== String(l.id)) {
        fail(`子图「${defName}」节点 #${tid} 输入槽 ${ts} 的 link 字段（${tslot.link}）与链接 #${l.id} 不一致`); broken = true; break;
      }
      tslot.link = lid;
      ctx.internalLinks.push([lid, idMap.get(oid), os, idMap.get(tid), ts, l.type]);
    }
    if (!broken) ctxByInst.set(sid, ctx);
  }

  // 阶段二：外部连线接线——target/origin 命中实例的，改接到内部消费端/生产者
  const outLinks = [];
  for (const l of Array.isArray(wf.links) ? wf.links : []) {
    if (Array.isArray(l) && l.length >= 5) {
      const oCtx = ctxByInst.get(String(l[1]));
      const tCtx = ctxByInst.get(String(l[3]));
      if (oCtx && tCtx) { problems.push(`连线 [${l[0]}] 的两端都是子图实例（#${l[1]} → #${l[3]}），无法展开`); continue; }
      if (tCtx) {
        const k = Number(l[4]);
        const insArr = Array.isArray(tCtx.inst.inputs) ? tCtx.inst.inputs : [];
        if (!Number.isInteger(k) || k < 0 || k >= insArr.length) { problems.push(`连线 [${l[0]}] 指向子图实例 #${l[3]} 的输入槽 ${l[4]}，但该实例没有这个输入槽`); continue; }
        // 按名字对位（2026-10-31 修）：实例槽下标 ≠ 定义下标，必须经「实例槽名 → 定义输入名 → 定义下标」定位
        const iSlot = insArr[k];
        const sname = iSlot && typeof iSlot === "object" && typeof iSlot.name === "string" ? iSlot.name : "";
        if (!sname) { problems.push(`连线 [${l[0]}] 指向子图实例 #${l[3]}（「${tCtx.defName}」）的输入槽 ${k}，该槽没有名字，无法按名字对位到子图定义输入，已拒绝`); continue; }
        if (tCtx.defDupNames.has(sname)) { problems.push(`子图实例 #${l[3]}（「${tCtx.defName}」）的定义存在多个同名输入「${sname}」，无法确定连线 [${l[0]}] 的对位目标，已拒绝`); continue; }
        const j = tCtx.defByName.get(sname);
        if (j === undefined) { problems.push(`连线 [${l[0]}] 指向子图实例 #${l[3]}（「${tCtx.defName}」）的输入槽 ${k}「${sname}」，但子图定义的 inputs 里没有这个名字，已拒绝`); continue; }
        const hit = tCtx.inputBySlot.get(j);
        if (!hit) { problems.push(`连线 [${l[0]}] 指向子图实例 #${l[3]}（「${tCtx.defName}」）的输入「${sname}」，但子图中找不到该输入的接口链接（-10，定义下标 ${j}）`); continue; }
        if (tCtx.usedInputs.has(j)) { problems.push(`子图实例 #${l[3]} 的输入「${sname}」被多条外部连线指向（连线 [${tCtx.usedInputs.get(j)}] 与 [${l[0]}]），无法确定取值来源`); continue; }
        tCtx.usedInputs.set(j, l[0]);
        tCtx.cloned.get(hit.targetId).inputs[hit.targetSlot].link = l[0];
        outLinks.push([l[0], l[1], l[2], tCtx.idMap.get(hit.targetId), hit.targetSlot, l[5]]);
        continue;
      }
      if (oCtx) {
        const j = Number(l[2]);
        const outsArr = Array.isArray(oCtx.inst.outputs) ? oCtx.inst.outputs : [];
        const hit = Number.isInteger(j) && j >= 0 ? oCtx.outputBySlot.get(j) : null;
        if (!Number.isInteger(j) || j < 0 || j >= outsArr.length) { problems.push(`连线 [${l[0]}] 来自子图实例 #${l[1]} 的输出槽 ${l[2]}，但该实例没有这个输出槽`); continue; }
        if (!hit) { problems.push(`连线 [${l[0]}] 来自子图实例 #${l[1]}（「${oCtx.defName}」）的输出槽 ${j}，但子图中找不到 target_slot=${j} 的输出接口链接（-20）`); continue; }
        oCtx.cloned.get(hit.originId).outputs[hit.originSlot].links.push(l[0]);
        outLinks.push([l[0], oCtx.idMap.get(hit.originId), hit.originSlot, l[3], l[4], l[5]]);
        continue;
      }
    }
    outLinks.push(l);
  }

  // 阶段三：widget 值传递（2026-10-31 修：对位一律按名字）。
  // 有 widgets_values_named：逐个键名 → 定义输入名 → 定义下标 j → -10 链接 → 内部消费端，
  //   写入该节点的 named（按内部 widget 名）并同步声明位序的位置值（与主循环共用 declaredWidgetSlots）；
  //   同名位置值存在且与 named 分歧 → 拒绝（R1 同精神，防过期 named 被静默采用）。
  // 无 named：位置回退，序 = 定义「-10 链接指向的内部目标槽带 widget 标记」的输入按定义序；
  //   实例 widgets_values 项数与之不等 → 整份拒绝（不猜）。
  // 值与内部现值相同 → 放行不写入；定位不到现值 → 拒绝。外部连线已占用的输入不传递（连线值优先）。
  for (const ctx of ctxByInst.values()) {
    const insArr = Array.isArray(ctx.inst.inputs) ? ctx.inst.inputs : [];
    const wvArr = Array.isArray(ctx.inst.widgets_values) ? ctx.inst.widgets_values : null;
    const namedVals = isPlainObject(ctx.inst.widgets_values_named) ? ctx.inst.widgets_values_named : null;
    const defInputsArr = Array.isArray(ctx.innerDef.inputs) ? ctx.innerDef.inputs : [];
    // 位置回退对位表：定义序 widget 输入名 → 定义下标（有 -10 链接且内部目标槽带 widget 标记）
    const widgetNames = [];
    for (let j = 0; j < defInputsArr.length; j += 1) {
      const d = defInputsArr[j];
      if (!d || typeof d !== "object" || typeof d.name !== "string") continue;
      const hit0 = ctx.inputBySlot.get(j);
      if (!hit0) continue;
      const tn0 = ctx.cloned.get(hit0.targetId);
      const ts0 = tn0 && Array.isArray(tn0.inputs) ? tn0.inputs[hit0.targetSlot] : null;
      if (ts0 && typeof ts0 === "object" && isPlainObject(ts0.widget) && typeof ts0.widget.name === "string") widgetNames.push({ name: d.name, j });
    }
    if (!namedVals && wvArr && wvArr.length !== widgetNames.length) {
      problems.push(`子图实例 #${ctx.sid}（「${ctx.defName}」）的 widgets_values 有 ${wvArr.length} 项，但定义按序可对位的 widget 输入有 ${widgetNames.length} 个（${widgetNames.map((w) => w.name).join("、") || "无"}），数量不一致，无法按位置对位，已拒绝`);
      continue;
    }
    // 幽灵键（2026-10-31）：named 里有、定义 inputs 里没有的键不再静默跳过——记 warning 后照常忽略（不拒绝）。
    if (namedVals) {
      const defNameSet = new Set(defInputsArr.filter((d) => d && typeof d === "object" && typeof d.name === "string").map((d) => d.name));
      for (const k of Object.keys(namedVals)) {
        if (!defNameSet.has(k)) { if (Array.isArray(warnings)) warnings.push(`子图实例 #${ctx.sid}（「${ctx.defName}」）的 widgets_values_named 含定义里不存在的键「${k}」，已忽略`); }
      }
    }
    const items = namedVals
      ? defInputsArr.filter((d) => d && typeof d === "object" && typeof d.name === "string" && Object.prototype.hasOwnProperty.call(namedVals, d.name)).map((d) => ({ name: d.name, pos: -1 }))
      : widgetNames.map((w, i) => ({ name: w.name, pos: i }));
    for (const item of items) {
      const sname = item.name;
      const j = ctx.defByName.get(sname);
      const hit = j !== undefined ? ctx.inputBySlot.get(j) : null;
      if (!hit) continue; // 定义输入没有 -10 链接（接口未接内部）：值无处可写，跳过
      // 外部连线占用（连线值优先）：该输入的实例槽存在且有连线即占用
      const iSlotIdx = insArr.findIndex((s) => s && typeof s === "object" && s.name === sname);
      if (iSlotIdx >= 0 && insArr[iSlotIdx].link !== null && insArr[iSlotIdx].link !== undefined) continue;
      // 实例值：named 优先；无 named 按位置对位表取 widgets_values[i]
      let val;
      if (namedVals) {
        val = subgraphUnwrap(namedVals[sname]);
        const posIdx = widgetNames.findIndex((w) => w.name === sname);
        if (posIdx >= 0 && wvArr && posIdx < wvArr.length) {
          const pval = subgraphUnwrap(wvArr[posIdx]);
          if (val === undefined) val = pval; // named 键存在但无值：位置回退
          else if (!subgraphValueEq(pval, val)) {
            problems.push(`子图实例 #${ctx.sid}（「${ctx.defName}」）输入「${sname}」的 widgets_values_named 与 widgets_values 位置值分歧（named=${cutValue(val)} ≠ 位置=${cutValue(wvArr[posIdx])}）——疑似过期 named（外部脚本只改位置值的产物），已拒绝（防静默采用旧值）`);
            continue;
          }
        }
      } else {
        val = subgraphUnwrap(wvArr ? wvArr[item.pos] : undefined);
      }
      if (val === undefined) {
        problems.push(`子图实例 #${ctx.sid}（「${ctx.defName}」）输入「${sname}」需要传递实例值，但实例${wvArr ? ` widgets_values 缺第 ${item.pos} 项` : "没有 widgets_values"}`);
        continue;
      }
      const tn = ctx.cloned.get(hit.targetId);
      if (!tn) continue; // 定义输入有 -10 链接但目标节点不存在：阶段一已拒绝，这里不再重复报
      const tslot = tn.inputs[hit.targetSlot];
      const wn = isPlainObject(tslot.widget) && typeof tslot.widget.name === "string" ? tslot.widget.name : sname;
      const named = isPlainObject(tn.widgets_values_named) ? tn.widgets_values_named : null;
      const wv = Array.isArray(tn.widgets_values) ? tn.widgets_values : null;
      // 位置值定位：与主循环同源的声明序（declaredWidgetSlots），不是槽序近似。
      const posIdx = subgraphWidgetIndexOf(objectInfo, tn, hit.targetSlot);
      let cur;
      let located = false;
      if (named && Object.prototype.hasOwnProperty.call(named, wn)) { cur = subgraphUnwrap(named[wn]); located = true; }
      if (!located && posIdx !== null && wv && posIdx < wv.length) { cur = wv[posIdx]; located = true; }
      if (!located) {
        // 未知类型 / 声明里找不到该 widget：声明序拿不到现值，退用节点自带槽序做**只读**比对——
        // 相同则放行（写入与否结果一致），不同则拒绝并点名键名与两边取值；连槽序都定位不到才报无法定位。
        if (wv) {
          const slotPos = slotOrderWidgetIndexOf(tn, hit.targetSlot, wv);
          if (slotPos !== null && slotPos < wv.length) {
            if (subgraphValueEq(wv[slotPos], val)) continue; // 相同：放行，不写入
            problems.push(
              `子图实例 #${ctx.sid}（「${ctx.defName}」）输入「${sname}」（widget「${wn}」）的实例值 ${cutValue(val)} ≠ 内部节点 #${hit.targetId}（${tn.type}）键「${wn}」的现值 ${cutValue(wv[slotPos])}，且目标类型不在 /object_info（或该输入名不在声明里），无法安全写入，已拒绝`,
            );
            continue;
          }
        }
        const why = posIdx === null
          ? `目标类型 ${String(tn.type)} 不在 /object_info（或该输入名不在声明里），无法按声明位序定位`
          : `widget 位序越界：${posIdx} ≥ widgets_values 长度`;
        problems.push(
          `子图实例 #${ctx.sid}（「${ctx.defName}」）输入「${sname}」（widget「${wn}」）的值 ${cutValue(val)} 无法定位到内部节点 #${hit.targetId}（${tn.type}）的现值：named${named ? ` 无键「${wn}」` : " 缺失"}，${why}；无法确认实例值与现值是否一致，已拒绝`,
        );
        continue;
      }
      if (subgraphValueEq(cur, val)) continue; // 相同：放行，不写入
      if (named) named[wn] = val;
      if (posIdx !== null && wv && posIdx < wv.length) wv[posIdx] = val;
    }
  }

  // 阶段四：组装产物——实例节点移除，原位放入其内部节点；id 撞车与重复在此兜底
  const newNodes = [];
  for (const n of nodes) {
    const ctx = n && typeof n === "object" ? ctxByInst.get(String(n.id)) : null;
    if (!ctx) { newNodes.push(n); continue; }
    for (const m of ctx.innerNodes) newNodes.push(ctx.cloned.get(String(m.id)));
  }
  for (const ctx of ctxByInst.values()) outLinks.push(...ctx.internalLinks);
  const seenIds = new Set();
  for (const n of newNodes) {
    const k = String(n && typeof n === "object" ? n.id : n);
    if (seenIds.has(k)) problems.push(`子图展开后节点 id 重复：${k}`);
    else seenIds.add(k);
  }
  return { ...wf, nodes: newNodes, links: outLinks };
}

// options（可选）：{ strict = false, onWarning = null, adapters = undefined, problemsOut = null }
//   strict=true  → warnings 并入 errors，抛出行为与旧版完全一致；
//   onWarning(fn) → 每条 warning 调用一次（在判定 throw 之前，strict 下也会收到）。
//   problemsOut(array) → 传入时把本次全部阻断项按顺序推入（strict 下为合并后列表）；不传时行为逐字不变。
export function convertUiToApi(wf, objectInfo, options) {
  const opts = isPlainObject(options) ? options : {};
  const strict = opts.strict === true;
  const onWarning = typeof opts.onWarning === "function" ? opts.onWarning : null;
  const problemsOut = Array.isArray(opts.problemsOut) ? opts.problemsOut : null;
  const problems = []; // 即 errors：仍会导致整份拒绝（R1 校验也推入此列表，语义不变）
  const warnings = []; // 仅记录、不拒绝：动态槽等可安全收编的构造
  wf = expandSubgraphs(wf, problems, objectInfo, warnings); // 子图展开 v1：无 definitions.subgraphs 或无实例时原样返回
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
  // 下游可读性（2026-10-31）：连线因上游被静音/旁路而作废时，把引擎真实知道的原因补进文案。
  // 先查旁路死链精确归因（bypassWhy，含输出槽），再查 mode 归因表（modeDrop，按上游节点）；
  // 两处都没有（如 virtual skip）就不加后缀——绝不编造。
  const deadWhy = (lid) => {
    const raw = rawLinks.find((l) => String(l[0]) === String(lid));
    if (!raw) return "";
    const precise = bypassWhy.get(`${String(raw[1])}:${Number(raw[2])}`);
    if (precise) {
      const up = nodes.find((m) => m && typeof m === "object" && String(m.id) === String(raw[1]));
      return `；上游 #${raw[1]}${up ? ` ${up.type}` : ""} ${precise}`;
    }
    const pullWhy = pullDrop.get(String(raw[1]));
    if (pullWhy) {
      const up = nodes.find((m) => m && typeof m === "object" && String(m.id) === String(raw[1]));
      return `；上游 #${raw[1]}${up ? ` ${up.type}` : ""} ${pullWhy}`;
    }
    const drop = modeDrop.get(String(raw[1]));
    return drop ? `；上游 #${drop.id} ${drop.type} ${drop.reason}` : "";
  };
  const out = {};
  // 降级分支用：prompt 只会包含非 Note 节点，origin 必须落在这些 id 里才是可引用的上游
  const emittableIds = new Set(
    nodes.filter((n) => n && typeof n === "object" && !NOTE_TYPES.has(String(n.type || ""))).map((n) => String(n.id)),
  );

  // ── 适配规则：解析 + 连线重写（adapters 缺省时下面整段不介入）────────────────
  const adapters = normalizeAdapters(opts.adapters, (m) => warnings.push(m));
  const droppedIds = new Set(); // 不进 prompt 的节点（virtual / 按规则跳过的静音旁路）
  const passthroughIds = new Set(); // 连线需要穿透到上游真实源的节点
  const pullRules = new Map(); // 需要按名字配对展开的节点：id → pull 规则（走独立路径，不进 passthroughIds）
  // mode 归因表（2026-10-31）：id → { id, type, reason }。仅登记因 mode 2/4 而退出 prompt 的节点，
  // 供下游「连线缺失」文案补上引擎真实知道的原因；virtual/档案 skip 不在此表，不参与归因。
  const modeDrop = new Map();
  // 旁路死链精确归因（2026-10-31）："上游id:输出槽" → 原因。在连线重写块内按 pickEntry 逐输出槽
  // 实算后填入（无任何输入 / 无同类型输入可穿透）；歧义映射由 pickEntry 自行推入 problems，不在此重复。
  const bypassWhy = new Map();
  // pull 死链归因（2026-10-31）：GetNode id → 原因。GetNode 本身未被静音/旁路，
  // 但它按名字配到的 Set 被静音/旁路（P2 路径）时，连线同样因 mode 2/4 而作废，原因引擎真实知道。
  const pullDrop = new Map();
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
        if (rules.pull) pullRules.set(id, rules.pull);
      }
      // 静音/旁路：仅当节点类型有档案时这段才介入；无档案的 mode 2/4 由下方 mode 预扫按 ComfyUI 默认语义处理。
      // mute(2) 在 ComfyUI 里是断链（上游不接到下游），所以只允许 skip，绝不允许穿透。
      // 这条判定必须排在 virtual/passthrough 注册之后并主动撤销穿透：否则 {virtual,passthrough}
      // 档案下的 mute 节点会照旧穿透，产物与 mode 0 完全一致且零告警。
      if (n.mode === 2) {
        const wasPassthrough = passthroughIds.delete(id); // mute 一律撤销穿透
        const wasPull = pullRules.delete(id); // mute 是断链：pull 同理，绝不按名取源
        droppedIds.add(id);
        modeDrop.set(id, { id, type: ntype, reason: "处于静音（mode 2），不执行" });
        if (wasPassthrough || wasPull || rules.bypass === "passthrough") {
          const why = wasPassthrough ? "virtual + passthrough" : wasPull ? "pull" : 'bypass="passthrough"';
          warnings.push(`节点 #${id} ${ntype} 处于 mute（mode 2）：mute 是断链，${why} 不适用，已按 skip 处理`);
        }
      } else if (n.mode === 4) {
        // bypass(mode 4) 与 pull 的语义（2026-10-31，P1）：
        // Get 没有输入槽，bypass 在「无输入节点」上的语义只能是断链，不能当成「输入直通」。
        // 所以 pull 节点被旁路 == 这个名字没有值：撤销 pull 规则，下游走既有「连线缺失」。
        // 绝不给它注册 passthrough：那会把产物静默接到无关的上游。
        const wasPull = pullRules.delete(id);
        if (wasPull) {
          droppedIds.add(id);
          modeDrop.set(id, { id, type: ntype, reason: "处于旁路（mode 4），按名字取源不生效" });
          warnings.push(`节点 #${id} ${ntype} 处于 bypass（mode 4）：Get 被旁路，按断链处理（按名字取源不生效，下游连线缺失）`);
          if (rules.bypass === "passthrough") {
            warnings.push(`节点 #${id} ${ntype} 的档案声明了 bypass="passthrough"，但该节点无输入槽，旁路穿透对它无意义，按断链处理`);
          }
        } else if (rules.bypass === "skip") {
          droppedIds.add(id);
          modeDrop.set(id, { id, type: ntype, reason: "处于旁路（mode 4），按档案跳过" });
        } else if (rules.bypass === "passthrough") {
          droppedIds.add(id);
          passthroughIds.add(id);
        } else if (!rules.virtual) {
          // 档案存在但未声明 bypass：mode 4 回落默认语义（穿透），与无档案一致；此处只登记归因，
          // 穿透登记由 mode 预扫补上（该节点不在 droppedIds，预扫不会跳过它）。
          modeDrop.set(id, { id, type: ntype, reason: "处于旁路（mode 4）" });
        }
      }
    }
    // 不变量：pull 节点只进 droppedIds，永不进 passthroughIds（任何分支都不许）。
    // pull 是按名取源，passthrough 是按输入槽穿透；Get 没有输入槽，走穿透只会把产物接到无关上游。
    for (const pid of pullRules.keys()) passthroughIds.delete(pid);
  }
  // mode 预扫（2026-10-31）：对所有节点按 ComfyUI 语义处理静音/旁路，不再整份拒绝（原主循环拒绝已删）。
  // mute(2)：断链，不执行，下游连线一并断开；bypass(4)：按类型穿透——复用既有 resolveReal/pickEntry
  // （同名优先 → 唯一同类型 → 歧义即拒绝），不另写类型匹配。档案已显式决定处置的节点（已在 droppedIds）
  // 不重复登记；Note 类没有执行语义；mode 非 0/2/4 的奇异值仍由主循环拒绝并点名。
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (NOTE_TYPES.has(String(n.type || ""))) continue;
    const id = String(n.id);
    if (droppedIds.has(id)) continue; // 档案分支（virtual / bypass=skip|passthrough / mute 撤销穿透）已登记
    const ntype = String(n.type || "");
    if (n.mode === 2) {
      droppedIds.add(id);
      modeDrop.set(id, { id, type: ntype, reason: "处于静音（mode 2），不执行" });
      warnings.push(`节点 #${id} ${ntype} 处于静音（mode 2）：不执行，其下游连线一并断开`);
    } else if (n.mode === 4) {
      droppedIds.add(id);
      passthroughIds.add(id);
      modeDrop.set(id, { id, type: ntype, reason: "处于旁路（mode 4）" });
      warnings.push(`节点 #${id} ${ntype} 处于旁路（mode 4）：按类型穿透到同类型输入；找不到或不唯一将报错`);
    }
  }
  const modeRejection = new Map(); // 连线缺失的机器归因（2026-10-31）："上游id:输出槽" → 该源被旁路时的真实来源
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
    // 旁路死链精确归因：对每个被旁路节点的每个输出槽实算一次入口选择，取不到源的原因引擎是知道的。
    // （有源与歧义两种结果不记：有源的连线会被重写、不会死；歧义由 resolveReal 路径推入 problems。）
    for (const pid of passthroughIds) {
      const pnode = nodeById.get(pid);
      if (!pnode) continue;
      const pouts = Array.isArray(pnode.outputs) ? pnode.outputs : [];
      const pins = Array.isArray(pnode.inputs) ? pnode.inputs.filter((s) => s && typeof s === "object") : [];
      for (let os = 0; os < pouts.length; os += 1) {
        const entry = pickEntry(pnode, os);
        if (entry.why || entry.link) continue;
        bypassWhy.set(`${pid}:${os}`, pins.length === 0 ? "处于旁路（mode 4）且没有任何输入" : "处于旁路（mode 4）且无同类型输入可穿透");
      }
    }
    // pull：按「名字」配对展开（独立于 passthrough 的解析路径；pull 节点只进 droppedIds，不进 passthroughIds）
    // 配对只在 wf.nodes 这一张图内进行：子图定义的节点不在 nodes 里，天然不参与
    const pullSolved = new Map(); // `${节点id}:${输出槽}` → { origin, originSlot } | null（同一槽只解一次）
    const pullSaid = new Set(); // pull 的 warning / problems 去重：同一节点被多条下游连线碰到只报一次
    const pullOnce = (list, msg) => { if (pullSaid.has(msg)) return; pullSaid.add(msg); list.push(msg); };
    const pullKeyOf = (node, pull) => readFieldPathAlternatives(node, pull.keyPaths);
    const pullCandidatesOf = (pull, key) => {
      const cands = [];
      for (const other of nodes) {
        if (!other || typeof other !== "object") continue;
        if (!pull.fromTypes.has(String(other.type || ""))) continue;
        const otherKey = readFieldPathAlternatives(other, pull.fromKeyPaths);
        if (otherKey && otherKey.value === key) cands.push(other);
      }
      return cands;
    };
    const pullMultiMsg = (node, pull, key, cands) =>
      `同一个名字「${key}」对应多个 ${pull.fromType.join("/")} 节点（${cands.map((c) => `#${c.id}`).join(" / ")}），无法确定来源，已拒绝`;
    const pullSource = (node, originSlot, pull) => {
      const id = String(node.id);
      const hit = pullKeyOf(node, pull);
      const key = hit ? hit.value : undefined;
      if (typeof key !== "string" || !key) {
        pullOnce(warnings, `节点 #${id} ${node.type} 的 pull 规则取不到名字（${fieldPathDesc(pull.keyPath)}=${cutValue(key)}），按无源处理（下游连线缺失）`);
        return null;
      }
      const cands = pullCandidatesOf(pull, key);
      if (cands.length === 0) {
        pullOnce(warnings, `节点 #${id} ${node.type} 的名字「${key}」在本图中找不到对应的 ${pull.fromType.join("/")} 节点，按无源处理（下游连线缺失）`);
        return null;
      }
      if (cands.length > 1) {
        pullOnce(problems, pullMultiMsg(node, pull, key, cands));
        return null;
      }
      const setNode = cands[0];
      // P2（2026-10-31）：配对到的 Set 被静音/旁路 → 同名 Set 没有值（mode 2 断链、mode 4 旁路都不取源）。
      // 必须判在取源之前：静音/旁路的 Set 的 inputs[i].link 仍然留在文件里，只看 link 会把死值当活值。
      const setMode = Number(setNode.mode);
      if (setMode === 2 || setMode === 4) {
        pullOnce(
          warnings,
          `节点 #${id} ${node.type} 按名字「${key}」配到 ${setNode.type} #${setNode.id}，但同名 Set 节点 #${setNode.id} 处于静音/旁路（mode ${setMode}），值不可用，按无源处理（下游连线缺失）`,
        );
        pullDrop.set(id, `按名字「${key}」配到的 ${setNode.type} #${setNode.id} 处于${setMode === 2 ? "静音" : "旁路"}（mode ${setMode}），值不可用`);
        return null;
      }
      const slot = readFieldPath(setNode, pull.sourcePathTokens);
      const sIdx = isPlainObject(slot) && Array.isArray(setNode.inputs) ? setNode.inputs.indexOf(slot) : -1;
      const link = !isPlainObject(slot)
        ? null
        : sIdx >= 0
          ? slotLinkOf(setNode, sIdx)
          : slot.link === null || slot.link === undefined
            ? null
            : rawById.get(String(slot.link)) || null;
      if (!link) {
        pullOnce(
          warnings,
          `节点 #${id} ${node.type} 按名字「${key}」配到 ${setNode.type} #${setNode.id}，但它的 ${pull.sourcePath} 没有连线（悬空），按无源处理（下游连线缺失）`,
        );
        return null;
      }
      // 类型：被下游消费的输出槽（originSlot）声明类型 vs 配对节点取源那格的输入槽类型；`*` 任一侧通配，缺信息则跳过校验
      const outSlot = Array.isArray(node.outputs) ? node.outputs[originSlot] : null;
      const outType = outSlot && typeof outSlot.type === "string" ? outSlot.type : "";
      const inType = typeof slot.type === "string" ? slot.type : "";
      if (outType && inType && outType !== "*" && inType !== "*" && outType !== inType) {
        pullOnce(
          problems,
          `节点 #${id} ${node.type} 输出槽 ${originSlot}:${outType} 与按名字「${key}」取用的 ${setNode.type} #${setNode.id} 的 ${pull.sourcePath}:${inType} 类型不兼容，已拒绝`,
        );
        return null;
      }
      return { origin: link[1], originSlot: link[2] };
    };
    const pullReal = (id, slot) => {
      const k = `${id}:${slot}`;
      if (pullSolved.has(k)) return pullSolved.get(k);
      pullSolved.set(k, null); // 先占位：重入（链式成环）时按无源处理
      const node = nodeById.get(String(id));
      const pull = pullRules.get(String(id));
      const real = node && pull ? pullSource(node, slot, pull) : null;
      pullSolved.set(k, real);
      return real;
    };
    // 穿透：把经过 passthrough / pull 节点的链路压缩到真实源；无上游 / 成环 / 歧义 → null（下游走既有「连线缺失」路径）
    const reported = new Set(); // 同一条歧义映射可能被多条下游连线重复碰到，只报一次
    const resolveReal = (origin, originSlot, seen) => {
      const id = String(origin);
      const isPull = pullRules.has(id);
      if (!passthroughIds.has(id) && !isPull) return { origin, originSlot };
      if (seen.has(id)) return null;
      seen.add(id);
      const node = nodeById.get(id);
      if (!node) return null;
      if (isPull) {
        const src = pullReal(id, originSlot); // 按名字配对得到的真实源（可以是另一个 passthrough / pull 节点）
        if (!src) return null;
        return resolveReal(src.origin, src.originSlot, seen);
      }
      const entry = pickEntry(node, originSlot);
      if (entry.why) { if (!reported.has(entry.why)) { reported.add(entry.why); problems.push(entry.why); } return null; }
      if (!entry.link) return null;
      return resolveReal(entry.link[1], entry.link[2], seen);
    };
    // 预扫（2026-10-31，P3）：只做一条硬判定——「同名多候选 → 整份拒绝」不依赖该 pull 节点是否被下游消费
    // （孤立的 Get 也必须拒，否则同一名字到底取谁就变成「可能不报」）。
    // 其余判定（取不到名字 / 0 候选 / 配对槽悬空 / 配对节点静音旁路 / 类型不兼容）全部留在「被消费槽」的路径上：
    // 孤立 Get 没有下游，给它产出「下游连线缺失」只会误导，也不该拖垮整份提交。
    if (pullRules.size > 0) {
      for (const [pid, pull] of pullRules) {
        const node = nodeById.get(pid);
        if (!node) continue;
        const hit = pullKeyOf(node, pull);
        if (!hit) continue; // 取不到名字：留给「被消费」路径去报，孤立节点静默
        const cands = pullCandidatesOf(pull, hit.value);
        if (cands.length > 1) pullOnce(problems, pullMultiMsg(node, pull, hit.value, cands));
      }
    }
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
    if (droppedIds.has(String(n.id))) continue; // 适配规则 / mode 预扫：virtual、静音、旁路节点不进 prompt
    if (n.mode !== undefined && n.mode !== 0 && n.mode !== 2 && n.mode !== 4) {
      problems.push(`节点 #${n.id} ${type} 处于未知 mode（${String(n.mode)}）：只认 0（正常）/2（静音）/4（旁路）`);
      continue;
    }
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
        if (!rl) { problems.push(`节点 #${n.id} 输入 ${adapterKey} 的连线缺失（link ${lid}）${deadWhy(lid)}`); continue; }
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
      if (!link) { problems.push(`节点 #${n.id} 输入 ${sname} 的连线缺失（link ${lid}）${deadWhy(lid)}`); continue; }
      inputs[sname] = [String(link.origin), link.originSlot];
    }

    // ② widget 值：优先 widgets_values_named 按名取值（被连线 widget 亦占位，按名读天然免疫错位）；
    //    无 named 的位置回退：widget 位（含被连线覆盖者）消耗一格；非 widget 类型 / forceInput 不消耗。
    //    位序口径与子图展开共用同一份实现（declaredWidgetSlots，含 seed control 副值跳格），防两套漂移。
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
      // —— 与子图展开共用同一份实现（declaredWidgetSlots，含 seed control 副值跳格），防两套口径漂移。
      const positions = declaredWidgetSlots(info, n);
      for (const [name, pos] of positions) {
        let val;
        if (pos < wv.length) val = wv[pos];
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
  if (problemsOut) problemsOut.push(...blocking); // 全量外带（strict 下是合并列表），供扫描/诊断工具取证，不影响判定
  if (blocking.length) {
    let msg = `UI→API 转换遇到不支持的构造：${blocking.slice(0, 6).join("；")}${blocking.length > 6 ? " 等" : ""}。请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。`;
    // 汇总段只对走 LLM 工具的调用追加：App 侧既有消费方对整条消息做子串断言，不带 adapters 的旧调用保持原文案不变。
    if (opts.adapters !== undefined) msg += `\n${summarizeProblems(blocking)}`;
    throw new Error(msg);
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
