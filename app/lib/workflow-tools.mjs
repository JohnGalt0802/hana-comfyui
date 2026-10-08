// lib/workflow-tools.mjs — 工作流解析/转换/注入（app 与中继共享）
// 2026-09-29（M13）：从 index.js 抽出，供 app(index.js) 与中继(runtime/comfy-relay.mjs) 同源使用。
// 中继侧直提（/_relay/submit-file）需要同一份 UI→API 转换与 inputs 注入逻辑，避免双实现漂移。

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);
export const UNSUPPORTED_UI_TYPES = new Set(["Reroute", "PrimitiveNode", "Subgraph", "GroupNode", "SubgraphInputNode", "SubgraphOutputNode"]);

// UI 格式（nodes/links）→ API 格式：经典图子集（子图/环绕/静音/旁路节点会明确报错）
const WIDGET_SPEC_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);

export function convertUiToApi(wf, objectInfo) {
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : null;
  if (!nodes) throw new Error("不是 UI 格式工作流（缺 nodes 数组）");
  const linkById = new Map();
  if (Array.isArray(wf.links)) {
    for (const l of wf.links) {
      if (Array.isArray(l) && l.length >= 6) linkById.set(l[0], { origin: l[1], originSlot: l[2] });
    }
  }
  const out = {};
  const problems = [];
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
        problems.push(`节点 #${n.id} 输入槽 ${sname ? `「${sname}」` : "（无名）"}不对应任何声明输入（连线无法收编）`);
        continue;
      }
      const link = linkById.get(lid);
      if (!link) { problems.push(`节点 #${n.id} 输入 ${sname} 的连线缺失（link ${lid}）`); continue; }
      inputs[sname] = [String(link.origin), link.originSlot];
    }

    // ② widget 值：优先 widgets_values_named 按名取值（被连线 widget 亦占位，按名读天然免疫错位）；
    //    无 named 的位置回退：widget 位（含被连线覆盖者）消耗 wvi 一格；非 widget 类型 / forceInput 不消耗。
    if (named) {
      for (const name of declared) {
        if (Object.prototype.hasOwnProperty.call(inputs, name)) continue; // 已被连线覆盖
        const spec = required[name] || optional[name];
        if (!spec) continue;
        const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
        if (!WIDGET_SPEC_TYPES.has(t)) continue;
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

    out[String(n.id)] = { class_type: type, inputs };
    if (typeof n.title === "string" && n.title) out[String(n.id)]._meta = { title: n.title };
  }
  if (problems.length) {
    throw new Error(`UI→API 转换遇到不支持的构造：${problems.slice(0, 6).join("；")}${problems.length > 6 ? " 等" : ""}。请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。`);
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
