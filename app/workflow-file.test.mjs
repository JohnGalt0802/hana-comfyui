// app/workflow-file.test.mjs — 文件源通道 IO/编排 集成测试（自含 · 零依赖）
// 运行：node app/workflow-file.test.mjs
// 隔离纪律：全程在 os.tmpdir() 的临时目录里做（workflowsDir 指向临时目录），
// 不触碰任何真实工作流文件。（对真实目录的只读 smoke 见 _temp/t1-readonly-smoke.mjs）
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveWorkflowPath,
  loadUiWorkflow,
  readTextViaNodeFs,
  writeTextViaNodeFs,
  parseUiWorkflow,
  writeFileAtomic,
  writeWorkflowBack,
  fileGet,
  fileCheck,
  fileTrace,
  fileOutline,
  fileSummary,
  fileDiff,
  runFilePatch,
  detectJsonFormat,
  stringifyAs,
} from "./workflow-file.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function makeSample() {
  return {
    id: "t1-wf-fixture",
    revision: 0,
    last_node_id: 12,
    last_link_id: 40,
    nodes: [
      { id: 2, type: "PrimitiveInt", pos: [100, 100], size: [210, 58], flags: {}, order: 0, mode: 0,
        inputs: [{ name: "value", type: "INT", widget: { name: "value" }, link: null }],
        outputs: [{ name: "INT", type: "INT", links: [38] }],
        properties: { "Node name for S&R": "PrimitiveInt" },
        widgets_values: [768, "fixed"], widgets_values_named: { value: 768, fixed: "fixed" } },
      { id: 3, type: "PrimitiveInt", pos: [100, 200], size: [210, 58], flags: {}, order: 1, mode: 0,
        inputs: [{ name: "value", type: "INT", widget: { name: "value" }, link: null }],
        outputs: [{ name: "INT", type: "INT", links: null }],
        properties: { "Node name for S&R": "PrimitiveInt" },
        widgets_values: [512, "fixed"], widgets_values_named: { value: 512, fixed: "fixed" } },
      { id: 8, type: "SizeApply", pos: [400, 100], size: [240, 80], flags: {}, order: 2, mode: 0,
        inputs: [{ name: "width", type: "INT", link: 38 }, { name: "height", type: "INT", link: null }],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        properties: { "Node name for S&R": "SizeApply" },
        widgets_values: [], widgets_values_named: {} },
      { id: 7, type: "Note", pos: [0, 0], size: [300, 200], flags: {}, order: 3, mode: 0,
        inputs: [], outputs: [], properties: {}, widgets_values: ["测试件（自备）"] },
    ],
    links: [[38, 2, 0, 8, 0, "INT"]],
    groups: [{ id: 1, title: "块A", bounding: [80, 80, 600, 260], flags: {} }],
  };
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.message}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "t1-wf-test-"));
const WF_DIR = join(TMP, "workflows");
mkdirSync(WF_DIR);
const SAMPLE = makeSample();
// 三种格式样本（模拟真实工作流目录里的多格式现状）
writeFileSync(join(WF_DIR, "样本A-2空格.json"), JSON.stringify(SAMPLE, null, 2), "utf8");
writeFileSync(join(WF_DIR, "样本B-单行JS.json"), JSON.stringify(SAMPLE), "utf8");
writeFileSync(join(WF_DIR, "样本C-单行Py.json"), stringifyAs(SAMPLE, { multiline: false, colonSpace: true, crlf: false }), "utf8");

async function patchFlow(relPath, edits, opts = {}) {
  const { abs } = resolveWorkflowPath(relPath, WF_DIR);
  const { text, parsed } = await loadUiWorkflow(abs, { readText: readTextViaNodeFs });
  const r = await runFilePatch({
    abs, text, parsed, edits,
    verify: opts.verify,
    dryRun: opts.dryRun,
    verifyCheck: opts.verifyCheck,
    getObjectInfo: opts.getObjectInfo,
    writeText: opts.writeText || writeTextViaNodeFs,
  });
  return { r, abs, beforeText: text };
}

console.log("== workflow-file.mjs 集成测试（临时目录隔离）==");

// ── 1. 路径解析 ────────────────────────────────────────────────────────────
console.log("-- resolveWorkflowPath --");
await test("相对路径 → 基于工作流目录解析", () => {
  const { abs } = resolveWorkflowPath("样本A-2空格.json", WF_DIR);
  assert.equal(abs, join(WF_DIR, "样本A-2空格.json"));
  const { abs: abs2 } = resolveWorkflowPath("sub/x.json", WF_DIR);
  assert.equal(abs2, join(WF_DIR, "sub", "x.json"));
});
await test("绝对路径（目录内）→ OK；目录外 → 拒绝；.. 逃逸 → 拒绝", () => {
  const inside = join(WF_DIR, "样本A-2空格.json");
  assert.equal(resolveWorkflowPath(inside, WF_DIR).abs, inside);
  assert.throws(() => resolveWorkflowPath(join(TMP, "外面.json"), WF_DIR), /在工作流目录之外/);
  assert.throws(() => resolveWorkflowPath("../../evil.json", WF_DIR), /不允许包含/);
});
await test("大小写不敏感（Windows）", () => {
  const up = WF_DIR.toUpperCase();
  assert.doesNotThrow(() => resolveWorkflowPath(join(WF_DIR, "样本A-2空格.json").toUpperCase().replace("WORKFLOWS", "WORKFLOWS"), WF_DIR));
  assert.doesNotThrow(() => resolveWorkflowPath(join(up, "X.JSON"), WF_DIR)); // 目录部分大写匹配
});
await test("空 path / 无工作流目录 → 明确报错", () => {
  assert.throws(() => resolveWorkflowPath("", WF_DIR), /需要 path/);
  assert.throws(() => resolveWorkflowPath("a.json", ""), /无法解析 ComfyUI 工作流目录/);
});

// ── 2. 读取与格式校验 ──────────────────────────────────────────────────────
console.log("-- loadUiWorkflow --");
await test("不存在 / 非 JSON / 非 UI 格式 → 明确报错", async () => {
  await assert.rejects(loadUiWorkflow(join(WF_DIR, "无此文件.json"), { readText: readTextViaNodeFs }), /文件不存在/);
  writeFileSync(join(WF_DIR, "_坏.json"), "{not json", "utf8");
  await assert.rejects(loadUiWorkflow(join(WF_DIR, "_坏.json"), { readText: readTextViaNodeFs }), /不是合法 JSON/);
  writeFileSync(join(WF_DIR, "_api.json"), JSON.stringify({ "3": { class_type: "X", inputs: {} } }), "utf8");
  await assert.rejects(loadUiWorkflow(join(WF_DIR, "_api.json"), { readText: readTextViaNodeFs }), /不是 UI 格式/);
});
await test("正常读取（含 BOM 剥离）", async () => {
  writeFileSync(join(WF_DIR, "_bom.json"), "\uFEFF" + JSON.stringify(SAMPLE), "utf8");
  const { parsed } = await loadUiWorkflow(join(WF_DIR, "_bom.json"), { readText: readTextViaNodeFs });
  assert.equal(parsed.nodes.length, 4);
});
await test("detectJsonFormat / stringifyAs round-trip（三种格式）", () => {
  for (const f of ["样本A-2空格.json", "样本B-单行JS.json", "样本C-单行Py.json"]) {
    const text = readFileSync(join(WF_DIR, f), "utf8");
    const parsed = JSON.parse(text);
    assert.equal(stringifyAs(parsed, detectJsonFormat(text)), text, `${f} round-trip`);
  }
});

// ── 2b. IO 后端边界（T-fs 修复）＋原子写 ────────────────────────────────
console.log("-- IO 后端边界 / 原子写 --");
await test("loadUiWorkflow 未提供 readText → 明确报错（生产必须显式注入后端）", async () => {
  await assert.rejects(loadUiWorkflow(join(WF_DIR, "样本A-2空格.json")), /需要 readText 后端/);
});
await test("readTextViaNodeFs 可读文案：不存在 / 目录（EISDIR）", async () => {
  await assert.rejects(readTextViaNodeFs(join(WF_DIR, "无此文件.json")), /文件不存在/);
  await assert.rejects(readTextViaNodeFs(WF_DIR), /不是普通文件/);
});
await test("读后端错误原样传播（超限 / 权限样例文案）", async () => {
  const big = async () => { throw new Error("读取文件失败（413）：文件超过 8 MiB 上限（8388608 字节；工作流文件通常 <200KB） —— X"); };
  await assert.rejects(loadUiWorkflow("X", { readText: big }), /8 MiB 上限/);
  const denied = async () => { throw new Error("读取文件被权限拦截：X（当前进程文件访问受限，生产路径应经中继代读）"); };
  await assert.rejects(loadUiWorkflow("X", { readText: denied }), /被权限拦截/);
});
await test("parseUiWorkflow：「文本已备好」纯函数形态（剥 BOM + UI 校验）", () => {
  const r1 = parseUiWorkflow("\uFEFF" + JSON.stringify({ nodes: [] }), "X");
  assert.deepEqual(r1.parsed, { nodes: [] });
  assert.notEqual(r1.text.charCodeAt(0), 0xFEFF);
  assert.throws(() => parseUiWorkflow("not json", "X"), /不是合法 JSON/);
  assert.throws(() => parseUiWorkflow("{}", "X"), /不是 UI 格式/);
});
await test("原子写：.tmp→rename；覆盖已存在文件；失败清理 .tmp", () => {
  const p = join(TMP, "_atomic.txt");
  writeFileSync(p, "old", "utf8");
  writeFileAtomic(p, "new-content");
  assert.equal(readFileSync(p, "utf8"), "new-content");
  assert.ok(!existsSync(p + ".tmp"), "覆盖后无 .tmp 残留");
  const p2 = join(TMP, "_atomic2.txt");
  writeFileAtomic(p2, "fresh");
  assert.equal(readFileSync(p2, "utf8"), "fresh");
  const bad = join(TMP, "no-such-dir", "x.txt");
  assert.throws(() => writeFileAtomic(bad, "x"), /写入失败/);
  assert.ok(!existsSync(bad + ".tmp"), "失败后无 .tmp 残留");
});
await test("writeWorkflowBack 未提供 writeText → 明确报错", async () => {
  await assert.rejects(writeWorkflowBack(join(TMP, "x.json"), "{}", { nodes: [] }), /需要 writeText 后端/);
});
await test("写后端桩化：调用序列（先 .bak 后主文件）可捕获", async () => {
  const calls = [];
  const spy = async (p, t) => { calls.push({ name: p.split(/[\\/]/).pop(), bytes: Buffer.byteLength(t, "utf8") }); writeFileAtomic(p, t); };
  const { r } = await patchFlow("样本A-2空格.json", [{ setNodeMode: { nodeId: 7, mode: 2 } }], { writeText: spy });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].name, /\.bak\.json$/);
  assert.match(calls[1].name, /样本A-2空格\.json$/);
});

// ── 3. 读向（输出与 live 同构）────────────────────────────────────────────
console.log("-- 读向 --");
await test("fileGet：投影与纯函数同构；全量=原对象；数据体不加标记", async () => {
  const { parsed } = await loadUiWorkflow(join(WF_DIR, "样本A-2空格.json"), { readText: readTextViaNodeFs });
  const proj = fileGet(parsed, { select: "#2,#8", fields: "title,inputs" });
  assert.equal(proj.op, "get");
  assert.ok(!("source" in proj) && !("file" in proj), "数据体不加标记（标记由工具层承载）");
  assert.deepEqual(proj.matched.ids, [2, 8]);
  assert.equal(fileGet(parsed, {}), parsed);
});
await test("fileCheck / fileOutline / fileTrace / fileSummary", async () => {
  const { parsed } = await loadUiWorkflow(join(WF_DIR, "样本A-2空格.json"), { readText: readTextViaNodeFs });
  const chk = fileCheck(parsed);
  assert.equal(chk.op, "check");
  assert.ok(Array.isArray(chk.issues));
  const ol = fileOutline(parsed);
  assert.equal(ol.blockCount, 2); // 组“块A”（#2,#3,#8 圈入）+ 角色兜底“其他”（#7 Note）
  const tr = fileTrace(parsed, { node: 8, slot: "width" });
  assert.equal(tr.resolved, "link");
  assert.equal(tr.source.node, 2);
  const sm = fileSummary(parsed);
  assert.equal(sm.nodeCount, 4);
  assert.equal(sm.linkCount, 1);
  assert.equal(sm.nodes[0].widgets.value, "768");
  assert.throws(() => fileTrace(parsed, { node: 8 }), /trace 需要 slot/);
});
await test("fileSummary：links 结构 {id,from,to}", async () => {
  const { parsed } = await loadUiWorkflow(join(WF_DIR, "样本A-2空格.json"), { readText: readTextViaNodeFs });
  const sm = fileSummary(parsed);
  assert.deepEqual(sm.links[0], { id: 38, from: { node: 2, slot: 0 }, to: { node: 8, slot: 0 } });
});

// ── 4. patch：成功链（含 .bak / 格式保持 / verify）────────────────────────────
console.log("-- runFilePatch：成功链 --");
await test("成功：setWidget+connect+组+克隆，written=true，.bak=旧内容，格式保持", async () => {
  const { r, abs, beforeText } = await patchFlow("样本B-单行JS.json", [
    { setWidget: { nodeId: 2, name: "value", value: 1024 } },
    { connect: { fromNode: 3, fromSlot: "INT", toNode: 8, toSlot: "height" } },
    { addGroup: { title: "新块", nodeIds: [2, 3] } },
    { cloneNodes: { nodeIds: [2, 8], offset: [500, 0] } },
  ]);
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.written, true);
  assert.equal(r.count, 4);
  assert.equal(r.backup, abs.replace(/\.json$/, ".bak.json"));
  assert.equal(readFileSync(r.backup, "utf8"), beforeText, ".bak 应为旧内容");
  const after = readFileSync(abs, "utf8");
  assert.ok(!after.includes("\n"), "单行 JS 格式应保持单行");
  const g = JSON.parse(after);
  assert.equal(g.nodes.find((n) => n.id === 2).widgets_values_named.value, 1024);
  assert.equal(g.groups.length, 2);
  assert.equal(g.nodes.length, 6);
  assert.equal(g.links.length, 3);
  assert.equal(r.verify.structOk, true);
  assert.equal(r.verify.check.newIssueCount, 0);
});
await test(".bak 语义（§28）：第二次 patch 后 bak=第一次结果的旧内容", async () => {
  const abs = join(WF_DIR, "样本B-单行JS.json");
  const first = readFileSync(abs, "utf8");
  const { r } = await patchFlow("样本B-单行JS.json", [{ setNodeMode: { nodeId: 3, mode: 2 } }]);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(abs.replace(/\.json$/, ".bak.json"), "utf8"), first);
  const second = readFileSync(abs, "utf8");
  const { r: r2 } = await patchFlow("样本B-单行JS.json", [{ setNodeMode: { nodeId: 3, mode: 0 } }]);
  assert.equal(r2.ok, true);
  assert.equal(readFileSync(abs.replace(/\.json$/, ".bak.json"), "utf8"), second);
});
await test("2 空格格式：写回保持缩进", async () => {
  const { r } = await patchFlow("样本A-2空格.json", [{ setWidget: { nodeId: 3, name: "value", value: 333 } }]);
  assert.equal(r.ok, true);
  const after = readFileSync(join(WF_DIR, "样本A-2空格.json"), "utf8");
  assert.ok(after.startsWith('{\n  "id"'), "2 空格缩进保持");
  assert.equal(JSON.parse(after).nodes.find((n) => n.id === 3).widgets_values_named.value, 333);
});
await test("Py 单行格式：写回保持 ': ' 风格", async () => {
  const { r } = await patchFlow("样本C-单行Py.json", [{ setNodeMode: { nodeId: 2, mode: 4 } }]);
  assert.equal(r.ok, true);
  const after = readFileSync(join(WF_DIR, "样本C-单行Py.json"), "utf8");
  assert.ok(!after.includes("\n"));
  assert.ok(after.includes('"id": "t1-wf-fixture"'), "Py 冒号空格风格保持");
});
await test("addNode 无 objectInfo → 模板降级（note 注明）；有 objectInfo → 声明构建", async () => {
  const { r } = await patchFlow("样本A-2空格.json", [{ addNode: { type: "PrimitiveInt", as: "w" } }]);
  assert.equal(r.ok, true);
  assert.match(r.note || "", /object_info 未接入/);
  assert.equal(r.results[0].result.via, "template");
  const oi = { PrimitiveInt: { input: { required: { value: ["INT", { default: 7 }] } }, output: ["INT"], output_name: ["INT"] } };
  const { r: r2 } = await patchFlow("样本A-2空格.json", [{ addNode: { type: "PrimitiveInt" } }], { getObjectInfo: async () => oi });
  assert.equal(r2.results[0].result.via, "object_info");
  assert.equal(r2.note, undefined);
});

// ── 5. patch：失败零写盘 / dryRun ──────────────────────────────────────────
console.log("-- runFilePatch：失败与 dryRun --");
await test("中途失败 → ok:false、零写盘（文件与 .bak 均不变）", async () => {
  const f = join(WF_DIR, "样本A-2空格.json");
  const before = readFileSync(f, "utf8");
  const bak = f.replace(/\.json$/, ".bak.json");
  const bakBefore = existsSync(bak) ? readFileSync(bak, "utf8") : null;
  const { r } = await patchFlow("样本A-2空格.json", [
    { setWidget: { nodeId: 2, name: "value", value: 99999 } },
    { connect: { fromNode: 2, fromSlot: "NOPE", toNode: 8, toSlot: "width" } },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.written, false);
  assert.equal(r.failedAt.index, 1);
  assert.match(r.reason, /输出槽不存在/);
  assert.equal(readFileSync(f, "utf8"), before, "主文件零写盘");
  assert.equal(existsSync(bak) ? readFileSync(bak, "utf8") : null, bakBefore, ".bak 零写盘");
});
await test("dryRun：只校验不落盘；失败条 ok:false + 后续 skipped", async () => {
  const f = join(WF_DIR, "样本A-2空格.json");
  const before = readFileSync(f, "utf8");
  const { r } = await patchFlow("样本A-2空格.json", [
    { setWidget: { nodeId: 2, name: "value", value: 2048 } },
    { addGroup: { title: "dry组", nodeIds: [8] } },
  ], { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.valid, true);
  assert.equal(r.checks.length, 2);
  assert.ok(r.checks.every((c) => c.ok === true));
  assert.equal(readFileSync(f, "utf8"), before, "dryRun 不落盘");

  const { r: r2 } = await patchFlow("样本A-2空格.json", [
    { setWidget: { nodeId: 2, name: "value", value: 1 } },
    { disconnect: { nodeId: 8, slot: "height" } },  // 本来就没连线 → 失败
    { setNodeMode: { nodeId: 2, mode: 2 } },
  ], { dryRun: true });
  assert.equal(r2.ok, true);
  assert.equal(r2.valid, false);
  assert.equal(r2.checks[0].ok, true);
  assert.equal(r2.checks[1].ok, false);
  assert.match(r2.checks[1].issues[0], /本来就没有连线/);
  assert.equal(r2.checks[2].skipped, true);
  assert.equal(readFileSync(f, "utf8"), before, "dryRun 失败也不落盘");
});
await test("通道层：edits 结构非法 → throw（非 data 层失败）", async () => {
  let threw = false;
  try { await patchFlow("样本A-2空格.json", [{ undo: {} }]); } catch (e) { threw = true; assert.match(e.message, /明确拒绝/); }
  assert.ok(threw);
});
await test("save 末条 + 缺省自动等价；save 带参 → throw", async () => {
  const { r } = await patchFlow("样本A-2空格.json", [{ setNodeMode: { nodeId: 7, mode: 4 } }, { save: {} }]);
  assert.equal(r.ok, true);
  assert.equal(r.results[1].result.deferred, true);
  let threw = false;
  try { await patchFlow("样本A-2空格.json", [{ save: { name: "x" } }]); } catch (e) { threw = true; assert.match(e.message, /不接受参数/); }
  assert.ok(threw);
});
await test("verifyCheck=false → 无 check 段；verify=false → 无 verify 段", async () => {
  const { r } = await patchFlow("样本A-2空格.json", [{ setNodeMode: { nodeId: 7, mode: 0 } }], { verifyCheck: false });
  assert.equal(r.ok, true);
  assert.equal(r.verify.structOk, true);
  assert.equal(r.verify.check, undefined);
  const { r: r2 } = await patchFlow("样本A-2空格.json", [{ setNodeMode: { nodeId: 7, mode: 0 } }], { verify: false });
  assert.equal(r2.ok, true);
  assert.equal(r2.verify, undefined);
});

// ── 6. 综合：克隆后 check 无误 / 连线完整（验收①口径）────────────────────────
console.log("-- 综合：克隆子图 --");
await test("克隆后：check 无新增 issue、连线完整、id 映射可用", async () => {
  const { abs } = resolveWorkflowPath("样本A-2空格.json", WF_DIR);
  const before = JSON.parse(readFileSync(abs, "utf8"));
  const { r } = await patchFlow("样本A-2空格.json", [{ cloneNodes: { nodeIds: [2, 8], position: [2000, 100] } }]);
  assert.equal(r.ok, true);
  const mapping = r.results[0].result.mapping;
  assert.equal(Object.keys(mapping).length, 2);
  const after = JSON.parse(readFileSync(abs, "utf8"));
  const c2 = after.nodes.find((n) => n.id === mapping["2"]);
  const c8 = after.nodes.find((n) => n.id === mapping["8"]);
  assert.ok(c2 && c8, "映射的 id 在新文件里可用");
  assert.deepEqual(c2.pos, [2000, 100]);
  const internal = after.links.find((row) => String(row[1]) === String(mapping["2"]) && String(row[3]) === String(mapping["8"]));
  assert.ok(internal, "克隆内部连线 2→8 已重建");
  assert.equal(internal[4], 0);
  // check 对比：无新增 issue
  const chkBefore = fileCheck(before).issues;
  const chkAfter = fileCheck(after).issues;
  const key = (x) => `${x.node}|${x.code}`;
  const beforeSet = new Set(chkBefore.map(key));
  const newIssues = chkAfter.filter((x) => !beforeSet.has(key(x)));
  assert.equal(newIssues.length, 0, `克隆后不应产生新 issue：${JSON.stringify(newIssues)}`);
});

// ── 7. T2 接线：check rules / outline 下钻 / trace multi / diff ─────────────
console.log("-- T2 接线 --");
function makeT2Sample() {
  return {
    id: "t2-fixture", revision: 1, last_node_id: 4, last_link_id: 52,
    nodes: [
      { id: 1, type: "PrimitiveInt", pos: [0, 0], size: [210, 58], flags: {}, order: 0, mode: 0,
        inputs: [{ name: "value", type: "INT", widget: { name: "value" }, link: null }],
        outputs: [{ name: "INT", type: "INT", links: [51] }],
        properties: {}, widgets_values: [512, "fixed"], widgets_values_named: { value: 512, fixed: "fixed" } },
      { id: 2, type: "ChainNode", pos: [300, 0], size: [210, 58], flags: {}, order: 1, mode: 0,
        inputs: [{ name: "in", type: "INT", link: 51 }],
        outputs: [{ name: "OUT", type: "INT", links: [52] }],
        properties: {}, widgets_values: [], widgets_values_named: {} },
      { id: 3, type: "ChainNode", pos: [600, 0], size: [210, 58], flags: {}, order: 2, mode: 0,
        inputs: [{ name: "in", type: "INT", link: 52 }],
        outputs: [{ name: "OUT", type: "INT", links: null }],
        properties: {}, widgets_values: [], widgets_values_named: {} },
      { id: 4, type: "EmptyLatentImage", pos: [1200, 0], size: [210, 100], flags: {}, order: 3, mode: 0,
        inputs: [{ name: "width", type: "INT", widget: { name: "width" }, link: null },
                 { name: "height", type: "INT", widget: { name: "height" }, link: null }],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        properties: {}, widgets_values: [1000, 1024, 1], widgets_values_named: { width: 1000, height: 1024, batch_size: 1 } },
    ],
    links: [[51, 1, 0, 2, 0, "INT"], [52, 2, 0, 3, 0, "INT"]],
    groups: [{ id: 1, title: "链组", bounding: [-20, -20, 860, 120], flags: {} }],
  };
}
await test("fileCheck：rules='all' → DANGLING+DIV16；object_info 缺 → warnings；单条 rules", () => {
  const g = makeT2Sample();
  const chk = fileCheck(g, { rules: "all" });
  const codes = new Set(chk.issues.map((i) => i.code));
  assert.ok(codes.has("DANGLING"));
  assert.ok(codes.has("DOMAIN_DIV16"));
  assert.ok((chk.warnings || []).some((w) => /object_info/.test(w)));
  const one = fileCheck(g, { rules: ["domain_div16"] });
  assert.deepEqual(one.rules, ["domain_div16"]);
  assert.ok(one.issues.every((i) => i.code === "DOMAIN_DIV16"));
});
await test("fileOutline：detail=nodes + block（块名/#1/未命中）", () => {
  const g = makeT2Sample();
  const ol = fileOutline(g, { detail: "nodes", block: "链组" });
  assert.equal(ol.detail, "nodes");
  assert.deepEqual(ol.blocks[0].nodes.map((n) => n.id), [1, 2, 3]);
  assert.deepEqual(fileOutline(g, { detail: "nodes", block: "#1" }).blocks[0].nodes.map((n) => n.id), [1, 2, 3]);
  assert.ok(fileOutline(g, { detail: "nodes", block: "无此块" }).note);
});
await test("fileTrace：multi 多级链 / depth 剪切 / 缺省单步", () => {
  const g = makeT2Sample();
  const tr = fileTrace(g, { node: 3, slot: "in", dir: "up", multi: true });
  assert.equal(tr.path.length, 4); // 每跳两条：源出槽 + 目标入槽
  assert.equal(tr.path[0].node, 1);
  assert.equal(tr.path[3].node, 3);
  assert.equal(fileTrace(g, { node: 3, slot: "in", dir: "up", depth: 1 }).path.length, 2);
  assert.ok(!fileTrace(g, { node: 3, slot: "in", dir: "up" }).path);
});
await test("fileDiff：差异结构 + summary；同图 clean", () => {
  const g = makeT2Sample();
  const g2 = JSON.parse(JSON.stringify(g));
  g2.nodes.find((n) => n.id === 4).widgets_values_named.width = 1024;
  g2.nodes.push({ id: 5, type: "NewNodeZ", pos: [0, 400], size: [210, 58], flags: {}, order: 4, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: [] });
  const d = fileDiff(g, g2);
  assert.equal(d.clean, false);
  assert.deepEqual(d.nodes.added.map((n) => n.id), [5]);
  assert.ok(d.nodes.changed.some((n) => n.id === 4));
  assert.ok(d.summary.includes("节点 +1"));
  assert.equal(fileDiff(g, g).clean, true);
});

// 清理
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
