// app/lib/canvas-symbol.mjs — 画布语义层：符号行 + 语义版本常量（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// T2（2026-10-09）：L3「符号」层的轻量落地件（不推翻既有字段结构）。
//   ① SEMANTIC_REV：语义层（折叠/分析逻辑）版本号——折叠逻辑变化时递增，供「compiler 漂移」
//      对账（同一输入在不同版本下的输出差异可解释）。当前 "s1"；随 project / check /
//      outline / trace / diff 输出一并回传（semanticRev 字段）。
//   ② formatNodeSymbol(node)：统一节点紧凑符号（规范形如 `#27 PrimitiveInt "宽度" = 1248`）：
//      - `#<id>` 恒在（id 缺失 → "#?"）；
//      - type 非空则附（空格分隔）；
//      - title 非空则附（JSON 引号；纯空白视为空）；
//      - widgets_values 非空则附关键值摘要：单值直接给、多值给数组，JSON 化后超过 40 字符
//        截断加 `…`。
//      该函数为纯函数（不依赖宿主/前端/网络），在 outline（下钻行）/ check（issue 行）/
//      trace（多级链级）输出中局部采用；不改动既有字段的结构与含义。
// ─────────────────────────────────────────────────────────────────────────────

export const SEMANTIC_REV = "s1";

const VALUE_CUT = 40;

/**
 * 统一节点紧凑符号：`#id Type "title" = value`（各段按数据存在与否拼装）。
 * @param {object} node UI 格式 JSON 中的节点对象
 * @returns {string}
 */
export function formatNodeSymbol(node) {
  if (node === null || typeof node !== "object") {
    throw new Error(`formatNodeSymbol: node 非对象（收到 ${node === null ? "null" : typeof node}）`);
  }
  const idPart = `#${node.id === undefined || node.id === null ? "?" : String(node.id)}`;
  const typePart = node.type === undefined || node.type === null || String(node.type) === "" ? "" : ` ${String(node.type)}`;
  const titlePart = typeof node.title === "string" && node.title.trim() !== "" ? ` ${JSON.stringify(node.title)}` : "";
  let valuePart = "";
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  if (wv.length > 0) {
    const v = wv.length === 1 ? wv[0] : wv;
    let s = JSON.stringify(v);
    if (s === undefined) s = String(v);
    if (s.length > VALUE_CUT) s = `${s.slice(0, VALUE_CUT)}…`;
    valuePart = ` = ${s}`;
  }
  return `${idPart}${typePart}${titlePart}${valuePart}`;
}
