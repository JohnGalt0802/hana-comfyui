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

// options（可选）：{ strict = false, onWarning = null }
//   strict=true  → warnings 并入 errors，抛出行为与旧版完全一致；
//   onWarning(fn) → 每条 warning 调用一次（在判定 throw 之前，strict 下也会收到）。
export function convertUiToApi(wf, objectInfo, options) {
  const opts = isPlainObject(options) ? options : {};
  const strict = opts.strict === true;
  const onWarning = typeof opts.onWarning === "function" ? opts.onWarning : null;
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : null;
  if (!nodes) throw new Error("不是 UI 格式工作流（缺 nodes 数组）");
  const linkById = new Map();
  if (Array.isArray(wf.links)) {
    for (const l of wf.links) {
      if (Array.isArray(l) && l.length >= 6) linkById.set(l[0], { origin: l[1], originSlot: l[2] });
    }
  }
  const out = {};
  // 降级分支用：prompt 只会包含非 Note 节点，origin 必须落在这些 id 里才是可引用的上游
  const emittableIds = new Set(
    nodes.filter((n) => n && typeof n === "object" && !NOTE_TYPES.has(String(n.type || ""))).map((n) => String(n.id)),
  );
  const problems = []; // 即 errors：仍会导致整份拒绝（R1 校验也推入此列表，语义不变）
  const warnings = []; // 仅记录、不拒绝：动态槽等可安全收编的构造
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const type = String(n.type || "");
    if (NOTE_TYPES.has(type)) continue;
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

    // ① 连线槽：以实例数组为准收编（含 autogrow 动态子槽，如 images.image_1 / values.a；槽名即 API 键名）
    for (const slot of nodeInputs) {
      if (!slot || typeof slot !== "object") continue;
      const lid = slot.link;
      if (lid === null || lid === undefined) continue;
      const sname = typeof slot.name === "string" ? slot.name : "";
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
        if (val !== undefined) inputs[name] = val;
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
        if (val !== undefined) inputs[name] = val;
      }
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
