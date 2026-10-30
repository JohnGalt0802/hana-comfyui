// 转换拒绝原因量化扫描（常驻工具）——量化 UI→API 转换的「拒绝面」：把语料里每份 UI 工作流
// 走 convertUiToApi + loadNodeAdapters({userDir:null})，用 problemsOut 拿全量阻断项，按分类统计，
// 让「拒绝面变宽还是变窄」能靠数字衡量，不靠感觉。只读语料与 /object_info，不写任何仓库状态。
// 用法：node tools/scan-reject-reasons.mjs [--dirs "a;b;c"] [--object-info http://127.0.0.1:8188/object_info] [--json <path>] [--md <path>]
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dirs: null, objectInfo: "http://127.0.0.1:8188/object_info", json: null, md: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dirs") args.dirs = argv[++i];
    else if (a === "--object-info") args.objectInfo = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--md") args.md = argv[++i];
    else { console.error(`未知参数：${a}（支持 --dirs --object-info --json --md）`); process.exit(2); }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const DEFAULT_DIRS = [
  "D:/ComfyUI/ComfyUI/user/default/workflows",
  "D:/ComfyUI/user/workflows",
  "D:/BaiduNetdiskDownload/工作流",
];
const DIRS = args.dirs
  ? args.dirs.split(";").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_DIRS;

// ── 1. object_info：8188 不可达就明确报错退出，不静默产出空表 ─────────────────
let objectInfo;
try {
  const resp = await fetch(args.objectInfo);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  objectInfo = await resp.json();
} catch (e) {
  console.error(`无法获取 /object_info（${args.objectInfo}）：${e.message}`);
  console.error("ComfyUI 服务没在运行？先启动 ComfyUI（8188）再跑本工具。拒绝面扫描没有 object_info 没有意义，不产出空表。");
  process.exit(1);
}

// ── 2. 收集语料文件 ──────────────────────────────────────────────────────────
function walkFiles(dir, depth, acc) {
  if (depth > 8) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, depth + 1, acc);
    else if (/\.json$/i.test(e.name)) acc.push(p);
  }
}
const norm = (p) => p.replaceAll("\\", "/");
const perDir = {};
const allFiles = [];
for (const d of DIRS) {
  const acc = [];
  const missing = !existsSync(d);
  if (!missing && statSync(d).isDirectory()) walkFiles(d, 0, acc);
  else if (!missing) acc.push(d);
  perDir[norm(d)] = { total: acc.length, missing };
  for (const f of acc) allFiles.push(f);
}

// ── 3. 转换：只用 convertUiToApi + problemsOut，不打补丁 ──────────────────────
const repoRoot = new URL("..", import.meta.url); // <repo>/tools/../
const storeMod = await import(new URL("app/lib/node-adapter-store.mjs", repoRoot).href);
const wt = await import(new URL("app/lib/workflow-tools.mjs", repoRoot).href);
const adapters = await storeMod.loadNodeAdapters({ userDir: null });

const results = []; // { path, ok, problems, subgraphInstances, definitions }
let uiCount = 0;
const readFailures = [];
for (const f of allFiles) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch (e) { readFailures.push({ file: f, reason: `读取失败: ${e.message}` }); continue; }
  let wf;
  try { wf = JSON.parse(text); } catch (e) { readFailures.push({ file: f, reason: `坏 JSON: ${e.message.slice(0, 120)}` }); continue; }
  if (!wf || typeof wf !== "object" || !Array.isArray(wf.nodes)) continue; // 非 UI 格式，不计数不转换
  uiCount += 1;
  const entry = { path: f, ok: false, problems: [], subgraphInstances: 0, definitions: 0 };
  if (wf.definitions && typeof wf.definitions === "object" && Array.isArray(wf.definitions.subgraphs)) {
    entry.definitions = wf.definitions.subgraphs.length;
  }
  const problemsOut = [];
  try { wt.convertUiToApi(wf, objectInfo, { adapters, problemsOut }); entry.ok = true; }
  catch { entry.problems = problemsOut; } // 抛错时 problemsOut 已带全量阻断项；通过时列表为空
  entry.subgraphInstances = entry.problems.filter((p) => classify(p) === "subgraph").length;
  results.push(entry);
}

// ── 4. 分类统计（口径与 2026-10-30 扫描脚本一致）──────────────────────────────
const CATS = ["subgraph", "value_mismatch", "mute_bypass", "unknown_type", "missing_link", "pull", "other"];
function classify(msg) {
  // value_mismatch 先于 subgraph，与引擎 summarizeProblems 口径一致：值分歧文案也含「子图实例」，须先接走。
  if (msg.includes("位置值分歧") || msg.includes("widgets_values_named 与 widgets_values") || msg.includes("疑似过期 named")) return "value_mismatch";
  if (msg.includes("子图/环绕节点")) return "subgraph";
  if (msg.includes("静音/旁路")) return "mute_bypass";
  if (msg.includes("不在 /object_info")) return "unknown_type";
  if (msg.includes("连线缺失") || msg.includes("不在工作流节点内")) return "missing_link";
  if (msg.includes("无法确定来源") || msg.includes("取用的") && msg.includes("类型不兼容")) return "pull";
  return "other";
}
const unknownType = (msg) => {
  const m = msg.match(/类型 (.+?) 不在 \/object_info/);
  return m ? m[1] : null;
};

const catItems = {}, catFiles = {};
for (const c of CATS) { catItems[c] = 0; catFiles[c] = new Set(); }
const unkType = new Map(); // type → { count, files:Set }
const failed = results.filter((r) => !r.ok);
const totalProblems = failed.reduce((s, r) => s + r.problems.length, 0);

for (const r of failed) {
  for (const p of r.problems) {
    const c = classify(p);
    catItems[c] += 1;
    catFiles[c].add(r.path);
    if (c === "unknown_type") {
      const t = unknownType(p) || "(未解析出类型名)";
      if (!unkType.has(t)) unkType.set(t, { count: 0, files: new Set() });
      unkType.get(t).count += 1;
      unkType.get(t).files.add(r.path);
    }
  }
}
// 「只卡某一类」＝该文件 problems 全属此类（修好即全过）；「修好后仍被拒」＝还有其他类问题的文件
const onlyBlocked = (cat) =>
  failed.filter((r) => r.problems.some((p) => classify(p) === cat) && !r.problems.some((p) => classify(p) !== cat)).length;
const remainAfterFix = (cat) => failed.filter((r) => r.problems.some((p) => classify(p) !== cat)).length;

// ── 5. 输出 ──────────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? `${n} (${((n / d) * 100).toFixed(1)}%)` : "0");
const catSum = CATS.reduce((s, c) => s + catItems[c], 0);
const okCount = results.length - failed.length;
const subgraphFiles = results.filter((r) => r.subgraphInstances > 0);
const checks = {
  catTotal: catSum === totalProblems,
  passReject: okCount + failed.length === uiCount,
};
const verdict = (ok) => (ok ? "✅ 相等" : "❌ 不相等");

let md = `# 转换拒绝原因量化扫描

- 转换器：仓库 app/lib/workflow-tools.mjs + loadNodeAdapters({userDir:null})（仅内置档案）
- object_info：${args.objectInfo}
- 语料：${allFiles.length} 份 JSON，其中 UI 格式 ${uiCount} 份；转换通过 ${okCount} 份，被拒 ${failed.length} 份${readFailures.length ? `；另有读失败 ${readFailures.length} 份` : ""}
${DIRS.map((d) => `- ${norm(d)}${perDir[norm(d)].missing ? "（目录不存在，已跳过）" : `：JSON ${perDir[norm(d)].total} 份`}`).join("\n")}

## A. 按分类统计

| 分类 | 条目数 | 涉及文件数 |
|---|---|---|
${CATS.map((c) => `| ${c} | ${catItems[c]} | ${catFiles[c].size} |`).join("\n")}
| **合计** | **${catSum}** | **${failed.length}（被拒文件数）** |

## B. unknown_type 类型 Top 20

| 类型 | 出现次数 | 涉及文件数 |
|---|---|---|
${[...unkType.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([t, v]) => `| ${t} | ${v.count} | ${v.files.size} |`).join("\n") || "（无）"}

## C. 子图文件清单

| 文件 | 子图实例数 | definitions.subgraphs 条数 |
|---|---|---|
${subgraphFiles.sort((a, b) => b.subgraphInstances - a.subgraphInstances).map((r) => `| ${r.path} | ${r.subgraphInstances} | ${r.definitions} |`).join("\n") || "（无）"}

子图文件总数：${subgraphFiles.length}${readFailures.length ? `\n\n读失败文件：\n${readFailures.map((x) => `- ${x.file} — ${x.reason}`).join("\n")}` : ""}

## D. 假设修好某一类

「只卡该类」＝该文件 problems 全属此类（修好即全过）；「修好后仍被拒」＝文件还有其他类问题。

| 假设修好 | 只卡该类（可直接转过） | 修好后仍被拒 |
|---|---|---|
${CATS.map((c) => `| ${c} | ${onlyBlocked(c)} | ${remainAfterFix(c)} |`).join("\n")}

## 校验

- 分类条目合计 ${catSum} ＝ problems 总数 ${totalProblems} → ${verdict(checks.catTotal)}
- 通过 ${okCount} + 被拒 ${failed.length} ＝ UI 格式总数 ${uiCount} → ${verdict(checks.passReject)}
- 分类口径：UUID 型（子图实例）→ subgraph；「位置值分歧 / widgets_values_named 与 widgets_values / 疑似过期 named」→ value_mismatch（先于 subgraph，与引擎 summarizeProblems 一致）；「静音/旁路」→ mute_bypass；「不在 /object_info」→ unknown_type；「连线缺失/不在工作流节点内」→ missing_link；pull 专属文案（「无法确定来源」「类型不兼容」）→ pull；其余 → other。
- 注意：2026-10-30 临时扫描脚本没有 pull 类（pull 条目当时落在 other）；本次对比历史数字时 other 会偏大、pull 为 0。另外 value_mismatch 是本次新增类，历史数字里也落在 other，对比时同样注意。
`;
md += checks.catTotal && checks.passReject ? "" : "\n⚠️ 校验未通过，统计有洞，先排查再用数字。\n";

console.log(md);
if (args.json) {
  const payload = {
    generatedAt: new Date().toISOString(),
    objectInfoUrl: args.objectInfo,
    dirs: DIRS.map((d) => ({ dir: d, missing: perDir[norm(d)].missing, jsonFiles: perDir[norm(d)].total })),
    uiCount, ok: okCount, rejected: failed.length, totalProblems, catSum,
    categories: Object.fromEntries(CATS.map((c) => [c, { items: catItems[c], files: catFiles[c].size }])),
    unknownTypes: [...unkType.entries()].sort((a, b) => b[1].count - a[1].count).map(([type, v]) => ({ type, count: v.count, files: v.files.size })),
    subgraphFiles: subgraphFiles.map((r) => ({ file: r.path, instances: r.subgraphInstances, definitions: r.definitions })),
    perCat: Object.fromEntries(CATS.map((c) => [c, { onlyBlocked: onlyBlocked(c), remainAfterFix: remainAfterFix(c) }])),
    checks,
  };
  writeFileSync(args.json, JSON.stringify(payload, null, 2), "utf8");
  console.error(`已写入 ${args.json}`);
}
if (args.md) { writeFileSync(args.md, md, "utf8"); console.error(`已写入 ${args.md}`); }
if (!checks.catTotal || !checks.passReject) process.exitCode = 1;
