// app/workflow-file.mjs — 文件源通道：对「工作流 JSON 文件」的语义级读写（IO + 编排）
// ─────────────────────────────────────────────────────────────────────────────
// T1（2026-10-09）：给 agent 一条不经画布、对工作流 JSON 文件完成语义读写的正规通道。
//   · 读：get / check / outline / trace / summary —— 读 path 指定的文件，走 app/lib 现成纯函数，
//     输出与 live（画布）同构（同一调用、同一结构；来源标记由工具层承载：文本尾注 + details）；
//   · 写：patch —— 同一套 edits 语言（画布版 7 种 + 组操作 3 种 + cloneNodes），
//     all-or-nothing（内存中全部应用成功才写盘）、写盘前 .bak（旧内容）、dryRun、verify。
//
// T2 接线（2026-10-09）：check 的 rules/objectInfo、trace 的 multi/depth、outline 的 detail/block、
// diff（两文件语义 diff）——参数原样映射到 lib（canvas-analysis / canvas-outline / canvas-diff）。
// 与画布版的关系：edits 经 lib/canvas-edit.mjs（纯数据变换）应用到文件的 JSON 上；
// 本文件只管「路径解析 / 文件 IO / 编排 / 写回格式」。不依赖画布在线，不依赖桥。
//
// IO 口径（T-fs 修复 2026-10-09：读/写改经中继；对齐踩坑记录 §28 与全语料实测）：
//   · 边界：生产环境 app 进程受宿主 --permission 沙箱限制（fs 白名单不含 ComfyUI 安装目录），
//     本模块不再由 app 进程直接 fs 触碰工作流路径——读/写均经调用方注入的 IO 后端
//     （生产=经中继 /_relay/fs/read、/_relay/fs/write；单测/直跑=readTextViaNodeFs / writeTextViaNodeFs）。
//   · 读：按序试读（不预 stat）→ 失败由后端给出可读文案（不存在/非文件/超限/权限等）；剥 BOM；
//   · 写：先备旧内容（读入时已备）→ 写 <name>.bak.json（旧内容）→ 写主文件（原子写 .tmp→rename）；
//     备份失败不阻断主写入（§28 口径），在结果里注明；无旧文件场景本通道不存在（读失败即中止）。
//   · 写回格式：探测原文件格式（缩进宽度 / 单行紧凑 JS 或 Python 风格 / CRLF），按原格式序列化
//     ——已对工作流目录全部 62 份真实文件做过字节级 round-trip 验证（62/62）。
//
// 路径口径（任务书）：path 为绝对路径，或相对「工作流目录」解析（workflowsDir 由调用方提供，
// 运行时 = ComfyUI 安装探测的 user/default/workflows）；目录之外的路径一律拒绝。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { isPlainObject } from "./lib/workflow-tools.mjs";
import { projectGraph } from "./lib/canvas-project.mjs";
import { analyzeGraph, traceGraph } from "./lib/canvas-analysis.mjs";
import { outlineGraph } from "./lib/canvas-outline.mjs";
import { diffGraph } from "./lib/canvas-diff.mjs";
import {
  parseFilePatchEdits,
  applyFilePatch,
  scanStructuralProblems,
  diffStructuralProblems,
} from "./lib/canvas-edit.mjs";

const msgOf = (e) => String((e && e.message) || e);

// ── 路径解析 ────────────────────────────────────────────────────────────────
/**
 * 解析 path：绝对路径直接规范化；相对路径基于 workflowsDir。
 * 结果必须位于工作流目录内，否则 throw（目录外拒绝）。
 * @returns {{abs:string, relative:string}}
 */
export function resolveWorkflowPath(input, workflowsDir) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new Error("需要 path（工作流 JSON 文件：绝对路径，或相对工作流目录）");
  if (typeof workflowsDir !== "string" || !workflowsDir.trim()) {
    throw new Error("无法解析 ComfyUI 工作流目录（本机安装探测未就绪？先确认 ComfyUI 安装可被识别）");
  }
  const wfDir = pathResolve(workflowsDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = raw.replace(/\\/g, "/");
  const isAbs = /^[A-Za-z]:\//.test(norm) || norm.startsWith("//") || norm.startsWith("/");
  let abs;
  if (isAbs) {
    abs = pathResolve(norm);
  } else {
    if (norm.split("/").includes("..")) {
      throw new Error(`相对路径不允许包含 ".."（仅限工作流目录内）：${raw}`);
    }
    abs = pathResolve(workflowsDir, norm);
  }
  const absSlash = abs.replace(/\\/g, "/");
  const lc = (s) => s.toLowerCase();
  if (!(lc(absSlash) === lc(wfDir) || lc(absSlash).startsWith(lc(wfDir) + "/"))) {
    throw new Error(`路径在工作流目录之外，仅允许该目录内的文件。\n  路径：${raw}\n  工作流目录：${wfDir}`);
  }
  return { abs, relative: absSlash.slice(wfDir.length + 1) };
}

// ── 读取 / 解析 / UI 校验 ───────────────────────────────────────────────────
// IO 后端边界（T-fs 修复，2026-10-09）：生产环境 app 进程受宿主 --permission 沙箱限制
// （fs 白名单不含 ComfyUI 安装目录），**不得**由 app 进程直接 fs 触碰工作流路径——
// loadUiWorkflow 的文本获取一律经调用方注入的 readText 后端（生产=经中继 /_relay/fs/read；
// 单测/直跑环境无沙箱，用导出的小后端 readTextViaNodeFs）。
// 「按序试读、失败报可读错误」：不预先 stat，读取失败由后端给出可读文案（不存在/非文件/超限/权限等）。

/** 解析 + UI 校验（纯函数；文本已由后端备好）。返回 {text（剥 BOM 后）, parsed}。 */
export function parseUiWorkflow(text, abs) {
  let t = typeof text === "string" ? text : String(text ?? "");
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // 剥 BOM
  let parsed;
  try { parsed = JSON.parse(t); } catch (e) {
    throw new Error(`文件不是合法 JSON：${abs}（${msgOf(e)}）`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.nodes)) {
    throw new Error(`文件不是 UI 格式工作流（缺 nodes 数组）：${abs}（API 格式或其它 JSON 不支持本通道）`);
  }
  return { text: t, parsed };
}

/**
 * 读取并解析工作流文件。readText 必填（见上方 IO 后端边界）；错误由后端/解析层给出可读文案。
 * @returns {Promise<{text:string, parsed:object}>}
 */
export async function loadUiWorkflow(abs, { readText } = {}) {
  if (typeof readText !== "function") {
    throw new Error("loadUiWorkflow 需要 readText 后端（生产=经中继；单测=readTextViaNodeFs）");
  }
  const text = await readText(abs);
  return parseUiWorkflow(text, abs);
}

// node:fs 参考读后端（单测/直跑专用；生产路径不得使用——app 进程 fs 受宿主沙箱限制）
export async function readTextViaNodeFs(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    const code = e && e.code;
    if (code === "ENOENT") throw new Error(`文件不存在：${abs}`);
    if (code === "EISDIR") throw new Error(`不是普通文件（是目录）：${abs}`);
    if (code === "EACCES" || code === "EPERM" || code === "ERR_ACCESS_DENIED") {
      throw new Error(`读取文件被权限拦截：${abs}（当前进程文件访问受限，生产路径应经中继代读）`);
    }
    throw new Error(`读取文件失败：${abs}（${msgOf(e)}）`);
  }
}

// ── 读向（输出与 live 同构：同一调用、同一结构）──────────────────────────────
// 说明：数据体不额外加“source/file”字段——『trace』的返回本来就有 source（上游节点），
// 加同名标记会覆盖语义。来源标记由工具层承载（文本尾注 + details.source/file）。
export function fileGet(parsed, { select, fields } = {}) {
  const hasProj = (typeof select === "string" && select.trim() !== "") || (typeof fields === "string" && fields.trim() !== "");
  if (!hasProj) return parsed; // 全量：原样（与 live 全量 get 同构：输出即文件内容本身）
  return projectGraph(parsed, { select, fields });
}

export function fileCheck(parsed, { rules, objectInfo } = {}) {
  return analyzeGraph(parsed, { rules, objectInfo });
}

export function fileTrace(parsed, { node, slot, dir, multi, depth } = {}) {
  if (node == null || String(node).trim() === "") throw new Error("trace 需要 nodeId（目标节点 id）");
  if (slot == null || String(slot).trim() === "") throw new Error("trace 需要 slot（名字或索引）");
  return traceGraph(parsed, { node, slot, dir, multi, depth });
}

// outline 的块选择：工具面参数名为 block（避免与 get 的 select 混淆），映射到 lib 的 select。
export function fileOutline(parsed, { detail, block } = {}) {
  return outlineGraph(parsed, { detail, select: block });
}

// diff：两份 UI JSON 的语义差异（lib diffGraph；结构含 clean/summary/节点·连线·组三族）。
export function fileDiff(baseParsed, nextParsed) {
  return diffGraph(baseParsed, nextParsed);
}

// summary：复刻桥侧 graphSummary 的输出结构（nodeCount/linkCount/nodes/links）
const WIDGET_VALUE_MAX = 160;
const clip = (s) => (s.length > WIDGET_VALUE_MAX ? s.slice(0, WIDGET_VALUE_MAX) + "…" : s);
const toXY = (v) => (Array.isArray(v) && v.length >= 2 ? [v[0], v[1]] : null);

function fileSummaryNode(n) {
  const widgets = {};
  if (isPlainObject(n.widgets_values_named)) {
    for (const [k, v] of Object.entries(n.widgets_values_named)) {
      if (v === undefined || v === null) continue;
      widgets[k] = clip(typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else if (Array.isArray(n.widgets_values) && Array.isArray(n.inputs)) {
    // 防御路径（老格式无 named）：按 inputs 里的 widget 槽顺序对位
    const slotWidgets = n.inputs.filter((s) => s && typeof s === "object" && s.widget && typeof s.widget.name === "string");
    slotWidgets.forEach((s, i) => {
      if (i < n.widgets_values.length && n.widgets_values[i] !== undefined && n.widgets_values[i] !== null) {
        const v = n.widgets_values[i];
        widgets[s.widget.name] = clip(typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    });
  }
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    mode: n.mode === undefined ? null : n.mode,
    pos: toXY(n.pos),
    size: toXY(n.size),
    inputs: (Array.isArray(n.inputs) ? n.inputs : []).map((s) => (s && s.name != null ? s.name : null)),
    outputs: (Array.isArray(n.outputs) ? n.outputs : []).map((s) => (s && s.name != null ? s.name : null)),
    widgets,
  };
}

export function fileSummary(parsed) {
  const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter((n) => n && typeof n === "object");
  const links = [];
  for (const row of (Array.isArray(parsed.links) ? parsed.links : [])) {
    if (!Array.isArray(row) || row.length < 5) continue;
    links.push({ id: row[0], from: { node: row[1], slot: row[2] }, to: { node: row[3], slot: row[4] } });
  }
  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    nodes: nodes.map(fileSummaryNode),
    links,
  };
}

// ── 写向：patch 编排 ────────────────────────────────────────────────────────
// 失败「在 data 层」：edits 应用失败 / verify 失败 / 写盘失败都返回 {ok:false,…}，不 throw；
// 通道层（edits 结构预检、路径/文件错误）才 throw（由调用方转工具错误）。
/**
 * @param {object} p
 * @param {string} p.abs 目标文件绝对路径
 * @param {string} p.text 读入的原文（.bak 用）
 * @param {object} p.parsed 读入的 UI JSON
 * @param {Array}  p.edits edits 原始数组
 * @param {boolean} [p.verify] 应用后自检（默认开：结构完整性 + 可选 check 复跑）
 * @param {boolean} [p.dryRun] 只校验不落盘
 * @param {boolean} [p.verifyCheck] verify 时复跑 check 对比新增 issue（默认 true）
 * @param {Function} [p.getObjectInfo] async ()=>object_info（仅当 edits 含 addNode 时懒调用）
 * @param {Function} p.writeText async (abs,text)=>落盘（生产=经中继；单测=writeTextViaNodeFs）
 */
export async function runFilePatch({ abs, text, parsed, edits, verify, dryRun, verifyCheck, getObjectInfo, writeText }) {
  const list = parseFilePatchEdits(edits); // 通道层：结构预检失败 → throw
  const dryRunOn = dryRun === true;
  const verifyOn = verify !== false;
  const verifyCheckOn = verifyCheck !== false;

  // object_info（仅 addNode 需要；懒拉取；不可达 → 降级并在结果注明）
  let objectInfo = null;
  let oiNote = null;
  if (list.some((e) => e.key === "addNode")) {
    if (typeof getObjectInfo === "function") {
      try { objectInfo = await getObjectInfo(); } catch (e) {
        oiNote = `object_info 不可用（${msgOf(e)}）：addNode 走文件内同型节点模板降级（无同型节点则失败）`;
      }
    } else {
      oiNote = "object_info 未接入：addNode 走文件内同型节点模板降级（无同型节点则失败）";
    }
  }

  const beforeProblems = scanStructuralProblems(parsed);
  const r = applyFilePatch(parsed, list, { objectInfo });

  if (dryRunOn) {
    // dryRun：只校验不落盘；输出逐条 checks + valid（对齐画布版 dryRun 形态）
    const checks = [];
    const failedIndex = r.ok ? -1 : r.failedAt.index;
    for (const item of list) {
      if (r.ok || item.index < failedIndex) {
        checks.push({ index: item.index, edit: item.raw, ok: true, issues: [] });
      } else if (item.index === failedIndex) {
        checks.push({ index: item.index, edit: item.raw, ok: false, issues: [r.failedAt.reason] });
      } else {
        checks.push({ index: item.index, edit: item.raw, ok: null, skipped: true });
      }
    }
    let newProblems = [];
    if (r.ok) newProblems = diffStructuralProblems(beforeProblems, scanStructuralProblems(r.graph));
    const out = {
      ok: true,
      dryRun: true,
      op: "patch",
      source: "file",
      file: abs,
      checks,
      valid: r.ok && newProblems.length === 0,
    };
    if (beforeProblems.length) out.baselineProblemCount = beforeProblems.length;
    if (newProblems.length) out.newProblems = newProblems.slice(0, 20);
    if (oiNote) out.note = oiNote;
    return out;
  }

  if (!r.ok) {
    return {
      ok: false,
      op: "patch",
      source: "file",
      file: abs,
      failedAt: r.failedAt,
      reason: r.failedAt.reason,
      written: false,
    };
  }

  // verify（默认开）：应用后自检——结构完整性（硬失败）+ check 复跑（报告新增 issue，非失败）
  let verifyInfo = null;
  if (verifyOn) {
    const newProblems = diffStructuralProblems(beforeProblems, scanStructuralProblems(r.graph));
    if (newProblems.length) {
      const reason = `verify 未通过：新增 ${newProblems.length} 个结构问题（首个：${newProblems[0].detail}）`;
      return {
        ok: false,
        op: "patch",
        source: "file",
        file: abs,
        failedAt: { index: null, edit: null, reason },
        reason,
        written: false,
        newProblems: newProblems.slice(0, 20),
      };
    }
    verifyInfo = {
      structOk: true,
      baselineProblemCount: beforeProblems.length,
      newProblemCount: 0,
    };
    if (verifyCheckOn) {
      const beforeCheck = analyzeGraph(parsed);
      const afterCheck = analyzeGraph(r.graph);
      const oldKeys = new Set(beforeCheck.issues.map((x) => `${x.node}|${x.code}`));
      const newIssues = afterCheck.issues.filter((x) => !oldKeys.has(`${x.node}|${x.code}`));
      verifyInfo.check = {
        issueCount: afterCheck.issueCount,
        baselineIssueCount: beforeCheck.issueCount,
        newIssueCount: newIssues.length,
        newIssues: newIssues.slice(0, 20),
      };
    }
  }

  // 写盘：先 .bak（旧内容）→ 写主文件；备份失败不阻断主写入（§28）
  let save;
  try { save = await writeWorkflowBack(abs, text, r.graph, { writeText }); } catch (e) {
    const reason = `写盘失败：${msgOf(e)}`;
    return {
      ok: false,
      op: "patch",
      source: "file",
      file: abs,
      failedAt: { index: null, edit: null, reason },
      reason,
      written: false,
    };
  }

  const out = {
    ok: true,
    op: "patch",
    source: "file",
    file: abs,
    count: r.results.length,
    results: r.results,
    written: true,
    backup: save.backup, // 无旧文件/备份失败 → null（后附 note）
    bytes: save.bytes,
  };
  if (verifyInfo) out.verify = verifyInfo;
  const notes = [oiNote, save.backupError ? `备份写入失败（不影响主文件）：${save.backupError}` : null].filter(Boolean);
  if (notes.length) out.note = notes.join("；");
  return out;
}

// ── 写回 ────────────────────────────────────────────────────────────────────
// 写侧边界（T-fs 修复）：与读侧同理——app 侧只决定「写什么文本」，落盘经注入的 writeText
// 后端（生产=经中继 /_relay/fs/write；单测=writeTextViaNodeFs）。
/**
 * 写回文件：先写 <name>.bak.json（旧内容）→ 写主文件（按原格式序列化）。
 * 返回 {backup, backupError, bytes}；主文件写失败 → throw（调用方转 failedAt）。
 */
export async function writeWorkflowBack(abs, oldText, newGraph, { writeText } = {}) {
  if (typeof writeText !== "function") {
    throw new Error("writeWorkflowBack 需要 writeText 后端（生产=经中继；单测=writeTextViaNodeFs）");
  }
  const fmt = detectJsonFormat(oldText);
  const outText = stringifyAs(newGraph, fmt);
  const bakPath = /\.json$/i.test(abs) ? abs.replace(/\.json$/i, ".bak.json") : `${abs}.bak.json`;
  let backup = null;
  let backupError = null;
  try { await writeText(bakPath, oldText); backup = bakPath; } catch (e) { backupError = msgOf(e); }
  await writeText(abs, outText);
  return { backup, backupError, bytes: Buffer.byteLength(outText, "utf8") };
}

// node:fs 参考写后端 + 原子写核心（中继端点也 import 本函数使用——「app 侧决定文本、
// 落盘统一走原子实现」；单测直跑本函数即为对中继侧行为的规格验证）。
// 原子写：写 <path>.tmp → rename 覆盖（防半写损坏）；失败时清理 .tmp 残留。
export function writeFileAtomic(abs, text) {
  const tmp = `${abs}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
  } catch (e) {
    throw new Error(`写入失败：${abs}（${msgOf(e)}）`);
  }
  try {
    renameSync(tmp, abs);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖主错误 */ }
    throw new Error(`写入失败（.tmp 替换主文件未成功）：${abs}（${msgOf(e)}）`);
  }
}

export async function writeTextViaNodeFs(abs, text) {
  return writeFileAtomic(abs, text);
}

// ── 写回格式：探测 + 复刻（全语料 62/62 字节级 round-trip 验证）────────────────
/**
 * 探测原文件 JSON 格式：
 *   multiline: 是否多行；indent: 多行时的缩进宽度；colonSpace: 单行时是否 "': '" 分隔（Python json.dumps 风格）；
 *   crlf: 是否 CRLF 换行。
 */
export function detectJsonFormat(text) {
  const crlf = text.includes("\r\n");
  const multiline = /\r?\n\s*\S/.test(text);
  let indent = null;
  if (multiline) {
    const m = /\r?\n( +)\S/.exec(text);
    indent = m ? m[1].length : 2;
    if (indent < 0 || indent > 8) indent = 2;
  }
  let colonSpace = false;
  if (!multiline) colonSpace = /"[^"]*"\s*: /.test(text.slice(0, 400));
  return { crlf, multiline, indent, colonSpace };
}

function escJsonString(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}

// 单行紧凑 Python 风格（json.dumps 默认 separators：", " 与 ": "）
function pyCompact(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return escJsonString(v);
  if (Array.isArray(v)) return `[${v.map(pyCompact).join(", ")}]`;
  return `{${Object.keys(v).map((k) => `${escJsonString(k)}: ${pyCompact(v[k])}`).join(", ")}}`;
}

/** 按探测到的格式序列化（不变量：对未修改文件 = 原文；已由 62/62 round-trip 证明）。 */
export function stringifyAs(v, fmt) {
  let out;
  if (fmt.multiline) {
    out = JSON.stringify(v, null, fmt.indent === 0 ? undefined : fmt.indent);
  } else if (fmt.colonSpace) {
    out = pyCompact(v);
  } else {
    out = JSON.stringify(v);
  }
  if (fmt.crlf) out = out.split("\n").join("\r\n");
  return out;
}
