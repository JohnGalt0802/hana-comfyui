// app/lib/canvas-history.test.mjs — 画布提交历史 P1：快照库纯模块 单测（自含 · 零依赖）
// 运行：node --test app/lib/canvas-history.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  SCHEMA_VERSION,
  MAX_NAME_LEN,
  sanitizeWorkflowName,
  historyDir,
  snapshotFileName,
  buildSnapshot,
  stripHeavyFields,
  buildIndexLine,
  parseIndex,
  nextSeq,
  latestEntry,
  normalizeSource,
  graphSigIgnoringSeed,
  computeDelta,
  shouldMergeWithHead,
  normalizeEntry,
} from "./canvas-history.mjs";

// ── 1. sanitizeWorkflowName ─────────────────────────────────────────────────
test("sanitizeWorkflowName：中文名保留", () => {
  assert.equal(sanitizeWorkflowName("Qwen21 t2i 质量版"), "Qwen21 t2i 质量版");
  assert.equal(sanitizeWorkflowName("尺寸组·生图"), "尺寸组·生图");
});

test("sanitizeWorkflowName：含空格的中间空格保留、首尾空白去掉", () => {
  assert.equal(sanitizeWorkflowName("  my workflow  "), "my workflow");
});

test("sanitizeWorkflowName：超长（>80）截断到 80", () => {
  const long = "超".repeat(120);
  const out = sanitizeWorkflowName(long);
  assert.equal(out.length, MAX_NAME_LEN);
  assert.equal(out, "超".repeat(80));
});

test("sanitizeWorkflowName：剔除路径分隔符 / 反斜杠 / 冒号 / Windows 非法字符 / 控制字符", () => {
  assert.equal(sanitizeWorkflowName("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij");
  assert.equal(sanitizeWorkflowName("x\u0000\u0001y"), "xy");
  assert.equal(sanitizeWorkflowName("dir/sub/name"), "dirsubname");
});

test("sanitizeWorkflowName：去首尾点（Windows 不允许名尾点）", () => {
  assert.equal(sanitizeWorkflowName("...name..."), "name");
  assert.equal(sanitizeWorkflowName(".hidden"), "hidden");
});

test("sanitizeWorkflowName：空名 / 纯空白 / 纯非法字符 → untitled", () => {
  assert.equal(sanitizeWorkflowName(""), "untitled");
  assert.equal(sanitizeWorkflowName("   "), "untitled");
  assert.equal(sanitizeWorkflowName(null), "untitled");
  assert.equal(sanitizeWorkflowName(undefined), "untitled");
  assert.equal(sanitizeWorkflowName("///:::***"), "untitled");
  assert.equal(sanitizeWorkflowName("..."), "untitled");
});

// ── 2. historyDir ───────────────────────────────────────────────────────────
test("historyDir：<workflowsDir>/.history/<净化名>（绝对路径）", () => {
  const wd = join("C:", "ComfyUI", "user", "default", "workflows");
  const dir = historyDir(wd, "Qwen21 t2i 质量版");
  assert.equal(dir, resolve(wd, ".history", "Qwen21 t2i 质量版"));
  assert.ok(dir.includes(`${".history"}`));
});

test("historyDir：名字需净化后进目录", () => {
  const wd = join("C:", "wf");
  assert.equal(historyDir(wd, "a/b:c"), resolve(wd, ".history", "abc"));
  assert.equal(historyDir(wd, "  "), resolve(wd, ".history", "untitled"));
});

// ── 3. snapshotFileName ─────────────────────────────────────────────────────
test("snapshotFileName：seq 补零到 4 位", () => {
  assert.equal(snapshotFileName(1, "a3f9c2e1"), "0001-a3f9c2e1.json");
  assert.equal(snapshotFileName(42, "a3f9c2e1"), "0042-a3f9c2e1.json");
  assert.equal(snapshotFileName(1234, "a3f9c2e1"), "1234-a3f9c2e1.json");
});

test("snapshotFileName：seq 超过 4 位自然增长（不截断）", () => {
  assert.equal(snapshotFileName(12345, "a3f9c2e1"), "12345-a3f9c2e1.json");
});

test("snapshotFileName：promptId 短于 8 位原样用", () => {
  assert.equal(snapshotFileName(3, "3f9"), "0003-3f9.json");
  assert.equal(snapshotFileName(3, "ab"), "0003-ab.json");
});

test("snapshotFileName：promptId 含非字母数字 → 净化", () => {
  assert.equal(snapshotFileName(7, "a3-f9!c2e1xx"), "0007-a3f9c2.json");
  assert.equal(snapshotFileName(7, "  a1 b2  "), "0007-a1b2.json");
});

test("snapshotFileName：promptId 净化后为空 / 缺失 → noid", () => {
  assert.equal(snapshotFileName(9, "----"), "0009-noid.json");
  assert.equal(snapshotFileName(9, ""), "0009-noid.json");
  assert.equal(snapshotFileName(9, null), "0009-noid.json");
  assert.equal(snapshotFileName(9, undefined), "0009-noid.json");
});

test("snapshotFileName：promptId 只取前 8 位", () => {
  assert.equal(snapshotFileName(1, "0123456789abcdef"), "0001-01234567.json");
});

// ── 4. buildSnapshot ────────────────────────────────────────────────────────
const SMALL_GRAPH = {
  nodes: [{ id: 1, type: "A" }, { id: 2, type: "B" }, { id: 3, type: "C" }],
  links: [[1, 1, 0, 2, 0, "INT"], [2, 2, 0, 3, 0, "INT"]],
};

test("buildSnapshot：字段齐全 + nodeCount/linkCount 从 graph 数", () => {
  const at = "2026-10-11T00:00:00.000Z";
  const s = buildSnapshot({ graph: SMALL_GRAPH, promptId: "a3f9c2e1", seq: 5, at, source: "agent" });
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(s.seq, 5);
  assert.equal(s.promptId, "a3f9c2e1");
  assert.equal(s.at, at);
  assert.equal(s.source, "agent");
  assert.equal(s.nodeCount, 3);
  assert.equal(s.linkCount, 2);
  assert.equal(s.graph, SMALL_GRAPH); // 原样嵌入（同一引用）
});

test("buildSnapshot：非法 source 归一化为 unknown", () => {
  for (const bad of ["robot", "", null, undefined, "USER", 123, {}]) {
    assert.equal(buildSnapshot({ graph: SMALL_GRAPH, source: bad }).source, "unknown");
  }
  assert.equal(buildSnapshot({ graph: SMALL_GRAPH, source: "user" }).source, "user");
  assert.equal(buildSnapshot({ graph: SMALL_GRAPH, source: "agent" }).source, "agent");
});

test("buildSnapshot：缺图 / 缺 at → 安全兜底（0 计数 + ISO 时间）", () => {
  const s = buildSnapshot({});
  assert.equal(s.nodeCount, 0);
  assert.equal(s.linkCount, 0);
  assert.equal(s.source, "unknown");
  assert.equal(s.seq, 1);
  assert.ok(!Number.isNaN(Date.parse(s.at)), "at 应为可解析的 ISO 字符串");
});

test("buildSnapshot：at 传 Date → ISO 字符串", () => {
  const d = new Date("2026-01-02T03:04:05Z");
  assert.equal(buildSnapshot({ graph: SMALL_GRAPH, at: d }).at, "2026-01-02T03:04:05.000Z");
});

// ── 5. stripHeavyFields ─────────────────────────────────────────────────────
function heavyGraph() {
  return {
    nodes: [
      { id: 1, type: "PreviewImage", widgets_values: ["ok", "data:image/png;base64,AAAA////"] },
      { id: 2, type: "LoadImage", inputs: [{ name: "image", image: "data:image/webp;base64,BBBB" }] },
      { id: 3, type: "Note", widgets_values: ["no image here"] },
    ],
    links: [],
    groups: [],
  };
}

test("stripHeavyFields：base64 内嵌图被剥离，stripped 记录路径", () => {
  const g = heavyGraph();
  const { graph, stripped } = stripHeavyFields(g);
  assert.equal(graph.nodes[0].widgets_values[1], "");
  assert.equal(graph.nodes[1].inputs[0].image, "");
  assert.equal(graph.nodes[2].widgets_values[0], "no image here"); // 未命中不动
  assert.deepEqual(stripped, [
    "nodes[0].widgets_values[1]",
    "nodes[1].inputs[0].image",
  ]);
});

test("stripHeavyFields：不修改入参对象（深拷贝）", () => {
  const g = heavyGraph();
  const before = JSON.stringify(g);
  const { graph } = stripHeavyFields(g);
  assert.equal(JSON.stringify(g), before, "原对象必须字节级不变");
  assert.notEqual(graph, g);
  assert.notEqual(graph.nodes, g.nodes);
  assert.notEqual(graph.nodes[0], g.nodes[0]);
});

test("stripHeavyFields：结构保持（数组长度 / 键不丢）", () => {
  const g = heavyGraph();
  const { graph } = stripHeavyFields(g);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes[0].widgets_values.length, 2);
  assert.ok("inputs" in graph.nodes[1]);
});

test("stripHeavyFields：零命中时 stripped 为空且返回等值深拷贝", () => {
  const g = { nodes: [{ id: 1, type: "X" }], links: [], groups: [] };
  const { graph, stripped } = stripHeavyFields(g);
  assert.deepEqual(stripped, []);
  assert.deepEqual(graph, g);
  assert.notEqual(graph, g);
});

test("stripHeavyFields：非 image 的 data: 串不剥离", () => {
  const g = { a: "data:text/plain;base64,QQ==", b: "data:image/png,plain" };
  const { graph, stripped } = stripHeavyFields(g);
  assert.deepEqual(stripped, []);
  assert.equal(graph.a, "data:text/plain;base64,QQ==");
  assert.equal(graph.b, "data:image/png,plain");
});

// ── 6. buildIndexLine ───────────────────────────────────────────────────────
test("buildIndexLine：一行合法 JSON，且不含 graph", () => {
  const line = buildIndexLine({
    seq: 2, file: "0002-a3f9c2e1.json", promptId: "a3f9c2e1",
    at: "2026-10-11T00:00:00.000Z", source: "user", nodeCount: 25, linkCount: 30,
  });
  assert.ok(!line.includes("\n"));
  const v = JSON.parse(line);
  assert.equal(v.seq, 2);
  assert.equal(v.file, "0002-a3f9c2e1.json");
  assert.equal(v.promptId, "a3f9c2e1");
  assert.equal(v.at, "2026-10-11T00:00:00.000Z");
  assert.equal(v.source, "user");
  assert.equal(v.nodeCount, 25);
  assert.equal(v.linkCount, 30);
  assert.ok(!("graph" in v));
});

test("buildIndexLine：非法 source 归一化；file 别名兼容", () => {
  const v = JSON.parse(buildIndexLine({ seq: 1, fileName: "0001-x.json", source: "bot" }));
  assert.equal(v.source, "unknown");
  assert.equal(v.file, "0001-x.json");
});

// ── 7. parseIndex ───────────────────────────────────────────────────────────
test("parseIndex：正常多行", () => {
  const text = [
    JSON.stringify({ seq: 1, file: "0001-a.json" }),
    JSON.stringify({ seq: 2, file: "0002-b.json" }),
  ].join("\n");
  const { entries, badLines } = parseIndex(text);
  assert.equal(entries.length, 2);
  assert.equal(badLines.length, 0);
  assert.equal(entries[1].file, "0002-b.json");
});

test("parseIndex：空行跳过，不计入 badLines", () => {
  const text = "\n" + JSON.stringify({ seq: 1 }) + "\n   \n\t\n" + JSON.stringify({ seq: 2 }) + "\n\n";
  const { entries, badLines } = parseIndex(text);
  assert.equal(entries.length, 2);
  assert.equal(badLines.length, 0);
});

test("parseIndex：坏行（截断的 JSON）计入 badLines 且不抛异常", () => {
  const text = [
    JSON.stringify({ seq: 1 }),
    '{"seq": 2, "file":',
    JSON.stringify({ seq: 3 }),
  ].join("\n");
  const { entries, badLines } = parseIndex(text);
  assert.equal(entries.length, 2);
  assert.equal(badLines.length, 1);
  assert.equal(badLines[0].line, 2);
  assert.ok(badLines[0].text.startsWith('{"seq": 2'));
});

test("parseIndex：缺字段的行照样进 entries（不校验完整性）", () => {
  const text = '{"seq": 9}\n{"file":"0009-noid.json"}';
  const { entries, badLines } = parseIndex(text);
  assert.equal(entries.length, 2);
  assert.equal(badLines.length, 0);
  assert.equal(entries[0].seq, 9);
  assert.equal(entries[1].file, "0009-noid.json");
});

test("parseIndex：非对象行（数组/裸值）计入 badLines", () => {
  const { entries, badLines } = parseIndex("[1,2,3]\n42\n\"str\"");
  assert.equal(entries.length, 0);
  assert.equal(badLines.length, 3);
});

test("parseIndex：空文本 / null → 空结果", () => {
  assert.deepEqual(parseIndex(""), { entries: [], badLines: [] });
  assert.deepEqual(parseIndex(null), { entries: [], badLines: [] });
});

// ── 8. nextSeq ──────────────────────────────────────────────────────────────
test("nextSeq：空 → 1", () => {
  assert.equal(nextSeq([]), 1);
  assert.equal(nextSeq(null), 1);
  assert.equal(nextSeq(undefined), 1);
});

test("nextSeq：非空 → max(seq)+1（不依赖顺序）", () => {
  assert.equal(nextSeq([{ seq: 1 }, { seq: 5 }, { seq: 3 }]), 6);
  assert.equal(nextSeq([{ seq: 7 }]), 8);
});

test("nextSeq：忽略非法 seq", () => {
  assert.equal(nextSeq([{ seq: "abc" }, { seq: 4 }, { seq: null }]), 5);
  assert.equal(nextSeq([{ seq: "abc" }, { seq: null }]), 1);
});

// ── 9. latestEntry ──────────────────────────────────────────────────────────
test("latestEntry：最后一条 / 空 → null", () => {
  assert.equal(latestEntry([{ seq: 1 }, { seq: 2 }]).seq, 2);
  assert.equal(latestEntry([]), null);
  assert.equal(latestEntry(null), null);
});

// ── 10. 组合：一轮提交的完整纯逻辑链 ────────────────────────────────────────
test("组合：确定文件名 → 构造快照 → 造索引行 → 解析 → 取下一序号", () => {
  const g = heavyGraph();
  const { graph, stripped } = stripHeavyFields(g);
  const seq = nextSeq([]);
  const file = snapshotFileName(seq, "a3f9c2e1-extra");
  const snap = buildSnapshot({ graph, promptId: "a3f9c2e1-extra", seq, at: "2026-10-11T00:00:00.000Z", source: "user" });
  assert.equal(file, "0001-a3f9c2e1.json");
  assert.equal(stripped.length, 2);
  assert.equal(snap.nodeCount, 3);

  const line = buildIndexLine({ ...snap, file });
  const { entries, badLines } = parseIndex(line + "\n\n" + line + "\n{bad");
  assert.equal(badLines.length, 1);
  assert.equal(nextSeq(entries), 2);
  assert.equal(latestEntry(entries).file, file);
});

test("normalizeSource：白名单外一律 unknown", () => {
  assert.equal(normalizeSource("user"), "user");
  assert.equal(normalizeSource("agent"), "agent");
  assert.equal(normalizeSource("unknown"), "unknown");
  assert.equal(normalizeSource("nope"), "unknown");
});

// ── 11. P5a：索引字段扩展 ───────────────────────────────────────────────────
test("buildIndexLine：新字段默认值", () => {
  const v = JSON.parse(buildIndexLine({ seq: 1, file: "0001-x.json" }));
  assert.equal(v.parent, null);
  assert.equal(v.kind, "run");
  assert.equal(v.sig, "");
  assert.deepEqual(v.blocks, []);
  assert.equal(v.delta, null);
  assert.deepEqual(v.runs, []);
});

test("buildIndexLine：新字段写入 / 归一化", () => {
  const v = JSON.parse(
    buildIndexLine({
      seq: 3,
      file: "0003-x.json",
      parent: 2,
      kind: "save",
      sig: "deadbeef",
      blocks: [{ name: "组1", source: "group", nodeIds: [1, 2] }],
      delta: { changed: [], added: [{ id: 5, title: "X" }], removed: [] },
      runs: [{ promptId: "p1", at: "2026-10-11T00:00:00.000Z", images: [{ filename: "a.png", subfolder: "", type: "output" }] }],
    }),
  );
  assert.equal(v.parent, 2);
  assert.equal(v.kind, "save");
  assert.equal(v.sig, "deadbeef");
  assert.deepEqual(v.blocks, [{ name: "组1", source: "group", nodeIds: [1, 2] }]);
  assert.deepEqual(v.delta, { changed: [], added: [{ id: 5, title: "X" }], removed: [] });
  assert.equal(v.runs[0].promptId, "p1");
  assert.equal(v.runs[0].images[0].filename, "a.png");
  // 非法 kind → run；blocks 缺 source/nodeIds → 补 group/[]
  const v2 = JSON.parse(buildIndexLine({ kind: "bot", blocks: [{ name: "b" }] }));
  assert.equal(v2.kind, "run");
  assert.deepEqual(v2.blocks, [{ name: "b", source: "group", nodeIds: [] }]);
});

// ── 12. P5a：graphSigIgnoringSeed ───────────────────────────────────────────
const SIG_GRAPH = {
  nodes: [
    { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["model.safetensors"] },
    { id: 2, type: "KSampler", widgets_values_named: { seed: 42, steps: 20, cfg: 7 } },
    { id: 3, type: "EmptyLatentImage", widgets_values_named: { width: 512, height: 512 } },
  ],
  links: [[1, 1, 0, 2, 0, "MODEL"]],
};

test("graphSigIgnoringSeed：稳定 hex（v4 前缀 + 8 位），且与固定期望一致", () => {
  const sig = graphSigIgnoringSeed(SIG_GRAPH);
  assert.match(sig, /^v4:[0-9a-f]{8}$/);
  assert.equal(sig, "v4:b740be6d"); // 跨语言一致基准（Python 侧同值；v4 = groups + 节点 explicit title）
  assert.equal(graphSigIgnoringSeed(SIG_GRAPH), sig); // 幂等
});

test("graphSigIgnoringSeed：v3 节点 mode 参与签名（bypass/mute 另起新节点）", () => {
  const base = { nodes: [
    { id: 1, type: "A", mode: 0, widgets_values: [1] },
    { id: 2, type: "B", widgets_values: [2] },
  ], links: [] };
  const s0 = graphSigIgnoringSeed(base);
  const bypass = structuredClone(base); bypass.nodes[0].mode = 4;
  const mute = structuredClone(base); mute.nodes[0].mode = 2;
  const nomode = structuredClone(base); delete nomode.nodes[0].mode;
  assert.notEqual(graphSigIgnoringSeed(bypass), s0, "bypass 应改签名");
  assert.notEqual(graphSigIgnoringSeed(mute), s0, "mute 应改签名");
  assert.notEqual(graphSigIgnoringSeed(bypass), graphSigIgnoringSeed(mute));
  assert.equal(graphSigIgnoringSeed(nomode), s0, "mode 缺失应与 0 等价");
});

test("graphSigIgnoringSeed：忽略 seed 类 widget，对非 seed 变化敏感", () => {
  const base = structuredClone(SIG_GRAPH);
  const seedChanged = structuredClone(SIG_GRAPH);
  seedChanged.nodes[1].widgets_values_named.seed = 999999;
  assert.equal(graphSigIgnoringSeed(seedChanged), graphSigIgnoringSeed(base), "seed 变化不应改变签名");
  const stepsChanged = structuredClone(SIG_GRAPH);
  stepsChanged.nodes[1].widgets_values_named.steps = 30;
  assert.notEqual(graphSigIgnoringSeed(stepsChanged), graphSigIgnoringSeed(base), "steps 变化应改变签名");
  const noiseSeed = structuredClone(SIG_GRAPH);
  noiseSeed.nodes[1].widgets_values_named.noise_seed = 7;
  assert.equal(graphSigIgnoringSeed(noiseSeed), graphSigIgnoringSeed(base), "noise_seed 同样忽略");
});

test("graphSigIgnoringSeed：v2 纳入连线端点对（纯连线改动改签名）", () => {
  const base = structuredClone(SIG_GRAPH);
  // 纯连线改动（节点 widget 未变）→ 签名变化
  const relinked = structuredClone(SIG_GRAPH);
  relinked.links = [[1, 1, 0, 3, 0, "MODEL"]];
  assert.notEqual(graphSigIgnoringSeed(relinked), graphSigIgnoringSeed(base), "端点变化应改签名");
  // 删一条又加一条（条数不变，端点不同）→ 仍变化（不用条数）
  const swap = structuredClone(SIG_GRAPH);
  swap.links = [[1, 1, 1, 2, 1, "MODEL"]];
  assert.notEqual(graphSigIgnoringSeed(swap), graphSigIgnoringSeed(base), "同条数换端点应改签名");
  // 连线顺序无关（端点对集合）
  const reordered = structuredClone(SIG_GRAPH);
  reordered.links = [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "LATENT"]];
  const reordered2 = structuredClone(SIG_GRAPH);
  reordered2.links = [[2, 2, 0, 3, 0, "LATENT"], [1, 1, 0, 2, 0, "MODEL"]];
  assert.equal(graphSigIgnoringSeed(reordered2), graphSigIgnoringSeed(reordered), "连线顺序不应改签名");
  assert.notEqual(graphSigIgnoringSeed(reordered), graphSigIgnoringSeed(base), "多一条连线应改签名");
  // 仅换 seed → 签名不变（不回归）
  const seedOnly = structuredClone(SIG_GRAPH);
  seedOnly.nodes[1].widgets_values_named.seed = 999999;
  assert.equal(graphSigIgnoringSeed(seedOnly), graphSigIgnoringSeed(base), "仅换 seed 不应改签名");
  // 对象数组格式与数组数组格式等价
  const objLinks = structuredClone(SIG_GRAPH);
  objLinks.links = [{ id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "MODEL" }];
  assert.equal(graphSigIgnoringSeed(objLinks), graphSigIgnoringSeed(base), "两种 links 格式应同串");
});

// ── 13. P5a：computeDelta ───────────────────────────────────────────────────
test("computeDelta：changed / added / removed 三类", () => {
  const prev = {
    nodes: [
      { id: 1, type: "A", title: "甲", widgets_values_named: { value: 1, steps: 20 } },
      { id: 2, type: "B" },
    ],
  };
  const next = {
    nodes: [
      { id: 1, type: "A", title: "甲", widgets_values_named: { value: 1, steps: 30 } },
      { id: 3, type: "C" },
    ],
  };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.changed, [{ id: 1, title: "甲", fields: ["steps"] }]);
  assert.deepEqual(d.added, [{ id: 3, title: "C" }]);
  assert.deepEqual(d.removed, [{ id: 2, title: "B" }]);
  assert.deepEqual(d.links, { added: [], removed: [] });
});

test("computeDelta：links 维度（added / removed，改接 = removed+added）", () => {
  const prev = {
    nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "VAEDecode" },
      { id: 3, type: "SaveImage" },
    ],
    links: [[1, 1, 0, 2, 0, "LATENT"], [2, 2, 0, 3, 0, "IMAGE"]],
  };
  const next = {
    nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "VAEDecode" },
      { id: 3, type: "SaveImage" },
    ],
    links: [[1, 1, 0, 2, 0, "LATENT"], [2, 2, 1, 3, 0, "IMAGE"]],
  };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.links, {
    added: [{ from: { type: "VAEDecode", slot: 1 }, to: { type: "SaveImage", slot: 0 } }],
    removed: [{ from: { type: "VAEDecode", slot: 0 }, to: { type: "SaveImage", slot: 0 } }],
  });
});

test("computeDelta：links 端点取不到节点 type 时用 id 兜底", () => {
  const prev = { nodes: [{ id: 1, type: "A" }], links: [] };
  const next = { nodes: [{ id: 1, type: "A" }], links: [[1, 1, 0, 99, 0, "X"]] };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.links.added, [{ from: { type: "A", slot: 0 }, to: { type: "99", slot: 0 } }]);
});

test("computeDelta：被删连线的端点 type 取自 prev（端点节点在 next 缺失）", () => {
  const prev = { nodes: [{ id: 1, type: "A" }, { id: 2, type: "B" }], links: [[1, 1, 0, 2, 0, "X"]] };
  const next = { nodes: [{ id: 1, type: "A" }], links: [] };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.links.removed, [{ from: { type: "A", slot: 0 }, to: { type: "B", slot: 0 } }]);
  assert.deepEqual(d.links.added, []);
});

test("computeDelta：被删连线的端点 type 取自 prev（端点节点在 next 中 type 已变）", () => {
  const prev = { nodes: [{ id: 1, type: "A" }, { id: 2, type: "B" }], links: [[1, 1, 0, 2, 0, "X"]] };
  const next = { nodes: [{ id: 1, type: "A" }, { id: 2, type: "B2" }], links: [] };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.links.removed, [{ from: { type: "A", slot: 0 }, to: { type: "B", slot: 0 } }]);
  assert.deepEqual(d.links.added, []);
});

test("computeDelta：type 变化计入 fields；title 缺失用 type；无 widgets 用 widget_<i>", () => {
  const prev = { nodes: [{ id: 1, type: "A", widgets_values: ["a", "b"] }] };
  const next = { nodes: [{ id: 1, type: "A2", widgets_values: ["a", "z"] }] };
  const d = computeDelta(prev, next);
  assert.deepEqual(d.changed, [{ id: 1, title: "A2", fields: ["type", "widget_1"] }]);
  assert.deepEqual(d.links, { added: [], removed: [] });
});

test("computeDelta：prevGraph 为 null/非法 → null", () => {
  assert.equal(computeDelta(null, {}), null);
  assert.equal(computeDelta(undefined, {}), null);
  assert.equal(computeDelta("x", {}), null);
  assert.equal(computeDelta([], {}), null);
});

// ── 14. P5a：shouldMergeWithHead ────────────────────────────────────────────
test("shouldMergeWithHead：相等即 true，非字符串 false", () => {
  assert.equal(shouldMergeWithHead("abc", "abc"), true);
  assert.equal(shouldMergeWithHead("abc", "abd"), false);
  assert.equal(shouldMergeWithHead(null, null), false);
  assert.equal(shouldMergeWithHead(undefined, "x"), false);
  assert.equal(shouldMergeWithHead(1, 1), false);
});

// ── 15. P5a：normalizeEntry 兼容旧条目 ──────────────────────────────────────
test("normalizeEntry：旧条目补全新字段", () => {
  const old = { seq: 1, file: "0001-noid.json", promptId: "p9", at: "2026-01-01T00:00:00.000Z", source: "user", nodeCount: 2, linkCount: 1 };
  const n = normalizeEntry(old);
  assert.equal(n.parent, null);
  assert.equal(n.kind, "run");
  assert.equal(n.sig, "");
  assert.equal(n.delta, null);
  assert.deepEqual(n.blocks, []);
  assert.deepEqual(n.runs, [{ promptId: "p9", at: "2026-01-01T00:00:00.000Z", images: [] }]);
  // 不改入参
  assert.equal("parent" in old, false);
});

test("normalizeEntry：promptId 缺失 → runs 为空；已有新字段原样保留", () => {
  const n = normalizeEntry({ seq: 5, kind: "save", parent: 3, sig: "aa", blocks: [{ name: "b", source: "role", nodeIds: [7] }], runs: [] });
  assert.deepEqual(n.runs, []);
  assert.equal(n.kind, "save");
  assert.equal(n.parent, 3);
  assert.equal(n.sig, "aa");
  assert.deepEqual(n.blocks, [{ name: "b", source: "role", nodeIds: [7] }]);
});

test("SCHEMA_VERSION：P5 换代后为 2", () => {
  assert.equal(SCHEMA_VERSION, 2);
});

// ── 16. P5a：跨语言签名一致性 fixture ────────────────────────────────────
test("graphSigIgnoringSeed：跨语言 fixture 与 Python 侧同串", () => {
  const fixture = {
    nodes: [
      { id: 1, type: "PrimitiveInt", widgets_values: [1024] },
      { id: 2, type: "KSampler", widgets_values_named: { seed: 123, sampler_name: "euler", steps: 20 } },
    ],
  };
  assert.equal(graphSigIgnoringSeed(fixture), "v4:9c90ed0e");
});

// ── 17. P5a：组合（新字段落索引行 → 解析 → normalizeEntry 读回）───────────
test("组合：buildIndexLine 新字段 → parseIndex → normalizeEntry 读回", () => {
  const sig = graphSigIgnoringSeed(SIG_GRAPH);
  const delta = computeDelta(
    { nodes: [{ id: 1, type: "A", widgets_values_named: { value: 1 } }] },
    { nodes: [{ id: 1, type: "A", widgets_values_named: { value: 2 } }] },
  );
  const line = buildIndexLine({
    seq: 2, parent: 1, file: "0002-p2.json", promptId: "p2", at: "2026-10-11T00:00:00.000Z",
    source: "agent", kind: "run", nodeCount: 1, linkCount: 0, sig,
    blocks: [{ name: "g", source: "group", nodeIds: [1] }], delta,
    runs: [{ promptId: "p2", at: "2026-10-11T00:00:00.000Z", images: [] }],
  });
  const { entries, badLines } = parseIndex(line);
  assert.equal(badLines.length, 0);
  const n = normalizeEntry(entries[0]);
  assert.equal(n.parent, 1);
  assert.equal(n.kind, "run");
  assert.equal(n.sig, sig);
  assert.deepEqual(n.blocks, [{ name: "g", source: "group", nodeIds: [1] }]);
  assert.deepEqual(n.delta.changed, [{ id: 1, title: "A", fields: ["value"] }]);
  assert.equal(n.runs.length, 1);
});

// ── 18. 2026-10-26：种子快照（改种子仍合并，种子值随行下发）────────────
test("buildIndexLine：meta 没 seeds → 不写该键（不补 null）", () => {
  assert.equal("seeds" in JSON.parse(buildIndexLine({ seq: 1, file: "0001-x.json" })), false);
  assert.deepEqual(JSON.parse(buildIndexLine({ seq: 1, seeds: [] })).seeds, []);
});

test("buildIndexLine：seeds 归一化（value 强制字符串）", () => {
  const v = JSON.parse(
    buildIndexLine({
      seq: 2,
      mergeInto: 1,
      seeds: [
        { title: "KSampler", name: "seed", value: 12345 },
        { title: null, name: "noise_seed", value: null },
        "bad",
      ],
    }),
  );
  assert.deepEqual(v.seeds, [
    { title: "KSampler", name: "seed", value: "12345" },
    { title: "", name: "noise_seed", value: "" },
  ]);
  // 非数组 → []
  assert.deepEqual(JSON.parse(buildIndexLine({ seeds: "x" })).seeds, []);
});

test("normalizeEntry：seeds 字段缺失（旧条目）→ null；有字段 → [] 或归一化数组", () => {
  assert.strictEqual(normalizeEntry({ seq: 1 }).seeds, null);
  assert.deepEqual(normalizeEntry({ seq: 2, seeds: [] }).seeds, []);
  assert.deepEqual(
    normalizeEntry({ seq: 3, seeds: [{ title: "K", name: "seed", value: 9 }] }).seeds,
    [{ title: "K", name: "seed", value: "9" }],
  );
  // 不改入参
  const old = { seq: 1 };
  normalizeEntry(old);
  assert.equal("seeds" in old, false);
});

test("种子快照：跨语言一致（buildIndexLine → parseIndex → normalizeEntry）", () => {
  const line = buildIndexLine({
    seq: 3,
    mergeInto: 1,
    promptId: "p3",
    at: "2026-10-26T00:00:00.000Z",
    source: "user",
    kind: "run",
    seeds: [{ title: "KSampler", name: "seed", value: 333 }],
  });
  const { entries } = parseIndex(line);
  assert.deepEqual(normalizeEntry(entries[0]).seeds, [
    { title: "KSampler", name: "seed", value: "333" },
  ]);
});

// ── 19. 2026-10-26：delta 增加 groups 维度（框颜色 / 框名 / 框范围）────────────
// 匹配口径：按 title 对齐；fields 固定 color / bounding（改名走 removed+added）。
// 与 Python 侧 TestGroupDelta 逐条对应。
const groupOf = ({ title = "G", color = "#3f789e", bounding = [11, -100, 398.89737130223807, 349.751277854283] } = {}) => ({
  id: 1,
  title,
  color,
  bounding,
  flags: {},
});
const graphOf = ({ groups = [], nodes } = {}) => ({
  nodes: nodes || [
    { id: 1, type: "KSampler", widgets_values_named: { seed: 1, steps: 20 } },
    { id: 2, type: "VAEDecode" },
  ],
  links: [],
  groups,
});

test("computeDelta：groups 键恒存在（可为三个空数组）；prev 非法仍返回 null", () => {
  const d = computeDelta(graphOf(), graphOf());
  assert.deepEqual(d.groups, { changed: [], added: [], removed: [] });
  assert.equal(computeDelta(null, graphOf()), null);
  // 图里没有 groups 键 → 三组空，不报错
  assert.deepEqual(computeDelta({ nodes: [] }, { nodes: [] }).groups, { changed: [], added: [], removed: [] });
});

test("computeDelta：只改框颜色（节点零改动）→ groups.changed 含该框 + fields 含 color", () => {
  const prev = graphOf({ groups: [groupOf({ color: "#3f789e" })] });
  const next = graphOf({ groups: [groupOf({ color: "#a85a5a" })] });
  const d = computeDelta(prev, next);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.groups.changed, [{ name: "G", fields: ["color"] }]);
  assert.deepEqual(d.groups.added, []);
  assert.deepEqual(d.groups.removed, []);
  // 大小写差异不算变色
  assert.deepEqual(computeDelta(prev, graphOf({ groups: [groupOf({ color: "#3F789E" })] })).groups.changed, []);
});

test("computeDelta：只改框名 → removed(旧) + added(新)，changed 不含", () => {
  const prev = graphOf({ groups: [groupOf({ title: "旧名" })] });
  const next = graphOf({ groups: [groupOf({ title: "新名" })] });
  const g = computeDelta(prev, next).groups;
  assert.deepEqual(g.changed, []);
  assert.deepEqual(g.removed, [{ name: "旧名" }]);
  assert.deepEqual(g.added, [{ name: "新名" }]);
});

test("computeDelta：只改框范围 → fields 含 bounding；整数型 float / -0 不算变化", () => {
  const prev = graphOf({ groups: [groupOf({ bounding: [0, 0, 100, 200] })] });
  const next = graphOf({ groups: [groupOf({ bounding: [0, 0, 101, 200] })] });
  assert.deepEqual(computeDelta(prev, next).groups.changed, [{ name: "G", fields: ["bounding"] }]);
  const a = graphOf({ groups: [groupOf({ bounding: [11, -100, 398.897, 349.751] })] });
  const b = graphOf({ groups: [groupOf({ bounding: [11.0, -100.0, 398.897, 349.751] })] });
  assert.deepEqual(computeDelta(a, b).groups.changed, []);
  const z = graphOf({ groups: [groupOf({ bounding: [-0, 0, 10, 10] })] });
  const z2 = graphOf({ groups: [groupOf({ bounding: [0, 0, 10, 10] })] });
  assert.deepEqual(computeDelta(z, z2).groups.changed, []);
  // 真实几何位移仍算变化
  const c = graphOf({ groups: [groupOf({ bounding: [11, -100, 398.897, 349.751] })] });
  const d2 = graphOf({ groups: [groupOf({ bounding: [11, -100, 398.898, 349.751] })] });
  assert.deepEqual(computeDelta(c, d2).groups.changed, [{ name: "G", fields: ["bounding"] }]);
});

test("computeDelta：颜色 + 范围同时改 → fields 两项（顺序 color → bounding）", () => {
  const prev = graphOf({ groups: [groupOf({ color: "#3f789e", bounding: [0, 0, 10, 10] })] });
  const next = graphOf({ groups: [groupOf({ color: "#ffffff", bounding: [0, 0, 20, 10] })] });
  assert.deepEqual(computeDelta(prev, next).groups.changed, [
    { name: "G", fields: ["color", "bounding"] },
  ]);
});

test("computeDelta：框和节点都没变 → groups 三组全空，且原有 changed 仍为空", () => {
  const d = computeDelta(graphOf({ groups: [groupOf()] }), graphOf({ groups: [groupOf()] }));
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.groups, { changed: [], added: [], removed: [] });
});

test("computeDelta：框变了 + 节点也变了 → 两组都记", () => {
  const prev = graphOf({ groups: [groupOf({ color: "#3f789e" })] });
  const next = graphOf({
    groups: [groupOf({ color: "#a85a5a" })],
    nodes: [
      { id: 1, type: "KSampler", widgets_values_named: { seed: 1, steps: 30 } },
      { id: 2, type: "VAEDecode" },
    ],
  });
  const d = computeDelta(prev, next);
  assert.deepEqual(d.changed, [{ id: 1, title: "KSampler", fields: ["steps"] }]);
  assert.deepEqual(d.groups.changed, [{ name: "G", fields: ["color"] }]);
});

test("computeDelta：多框按 name 排序；added/removed 各自独立", () => {
  const prev = graphOf({ groups: [groupOf({ title: "Z", color: "#111111" }), groupOf({ title: "A", color: "#222222" })] });
  const next = graphOf({ groups: [groupOf({ title: "Z", color: "#333333" }), groupOf({ title: "A", color: "#444444" }), groupOf({ title: "B" })] });
  const g = computeDelta(prev, next).groups;
  assert.deepEqual(g.changed, [
    { name: "A", fields: ["color"] },
    { name: "Z", fields: ["color"] },
  ]);
  assert.deepEqual(g.added, [{ name: "B" }]);
  assert.deepEqual(g.removed, []);
  // 删框：removed 单独出现，不进 changed
  assert.deepEqual(computeDelta(next, prev).groups.removed, [{ name: "B" }]);
});

test("computeDelta：groups 跨语言同串（同一 fixture 的 groups 段一致）", () => {
  // 该 fixture 的期望值同时被 Python 侧 TestGroupDelta 校验（同输入 → 同输出）
  const prev = graphOf({ groups: [groupOf({ title: "④ 采样", color: "#b58b2a", bounding: [0, 0, 10, 10] })] });
  const next = graphOf({ groups: [groupOf({ title: "④ 采样", color: "#a1309b", bounding: [0, 0, 10, 12] })] });
  assert.equal(JSON.stringify(computeDelta(prev, next).groups),
    JSON.stringify({ changed: [{ name: "④ 采样", fields: ["color", "bounding"] }], added: [], removed: [] }));
});

// ── 20. 2026-10-26（v4）：分组框进签名 + seed 精确忽略 + 节点改名算改动 ────
// 与 Python 侧 TestP5Purity 的 test_graph_sig_v4_* / test_graph_sig_seed_ignore_exact_names_only /
// test_compute_delta_node_title_change 逐条对应。
const sigBase = () => ({
  nodes: [
    { id: 1, type: "KSampler", widgets_values_named: { seed: 1, steps: 20 } },
    { id: 2, type: "VAEDecode" },
  ],
  links: [],
  groups: [{ id: 1, title: "G", color: "#3f789e", bounding: [11, -100, 398.897, 349.751], flags: {} }],
});

test("graphSigIgnoringSeed：v4 只改框颜色 → 签名变化（修「色条永不亮」核心用例）", () => {
  const base = sigBase();
  const s0 = graphSigIgnoringSeed(base);
  const recolored = sigBase();
  recolored.groups[0].color = "#a85a5a";
  const s1 = graphSigIgnoringSeed(recolored);
  assert.match(s1, /^v4:[0-9a-f]{8}$/);
  assert.notEqual(s1, s0, "只改框颜色应改签名");
  // 颜色大小写规范化后同色 → 签名不变（复用 canonGroupColor）
  const sameCase = sigBase();
  sameCase.groups[0].color = "#3F789E";
  assert.equal(graphSigIgnoringSeed(sameCase), s0);
});

test("graphSigIgnoringSeed：v4 只改框范围 → 签名变化", () => {
  const base = sigBase();
  const s0 = graphSigIgnoringSeed(base);
  const moved = sigBase();
  moved.groups[0].bounding = [11, -100, 399.897, 349.751];
  assert.notEqual(graphSigIgnoringSeed(moved), s0, "只改框范围应改签名");
  // 整数型 float 同值 → 不变（复用 canonGroupBounding）
  const sameVal = sigBase();
  sameVal.groups[0].bounding = [11.0, -100.0, 398.897, 349.751];
  assert.equal(graphSigIgnoringSeed(sameVal), s0);
});

test("graphSigIgnoringSeed：v4 只改框名 → 签名变化", () => {
  const base = sigBase();
  const s0 = graphSigIgnoringSeed(base);
  const renamed = sigBase();
  renamed.groups[0].title = "H";
  assert.notEqual(graphSigIgnoringSeed(renamed), s0, "只改框名应改签名");
});

test("graphSigIgnoringSeed：v4 框全没变 → 签名不变；groups 缺失与 [] 同串", () => {
  const base = sigBase();
  const s0 = graphSigIgnoringSeed(base);
  assert.equal(graphSigIgnoringSeed(sigBase()), s0);
  const noGroups = sigBase();
  delete noGroups.groups;
  const emptyGroups = sigBase();
  emptyGroups.groups = [];
  assert.equal(graphSigIgnoringSeed(noGroups), graphSigIgnoringSeed(emptyGroups));
  // 非对象框项剔除（与 groupsByTitle 一致）
  const junk = sigBase();
  junk.groups = ["bad", null, base.groups[0]];
  assert.equal(graphSigIgnoringSeed(junk), s0);
});

test("graphSigIgnoringSeed：v4 框顺序参与签名；缺字段按空串参与", () => {
  const base = sigBase();
  base.groups = [
    { id: 1, title: "A", color: "#111111", bounding: [0, 0, 10, 10] },
    { id: 2, title: "B", color: "#222222", bounding: [0, 0, 20, 20] },
  ];
  const s0 = graphSigIgnoringSeed(base);
  const swapped = sigBase();
  swapped.groups = [base.groups[1], base.groups[0]];
  assert.notEqual(graphSigIgnoringSeed(swapped), s0, "框顺序应参与签名");
  const bare = sigBase();
  bare.groups = [{ id: 1, title: "A", color: "#111111", bounding: [0, 0, 10, 10] }, { id: 2 }];
  const sBare = graphSigIgnoringSeed(bare);
  assert.match(sBare, /^v4:[0-9a-f]{8}$/);
  assert.notEqual(sBare, s0);
  // bounding 非法与缺失同形
  const bad = sigBase();
  bad.groups = [bare.groups[0], { id: 2, bounding: "not-an-array" }];
  assert.equal(graphSigIgnoringSeed(bad), sBare);
});

test("graphSigIgnoringSeed：seed / noise_seed 忽略，seed_mode 变化必须改签名（子串 bug 已修）", () => {
  const base = { nodes: [{ id: 1, type: "KSampler", widgets_values_named: { seed: 1, noise_seed: 2, seed_mode: "randomize", steps: 20 } }] };
  const s0 = graphSigIgnoringSeed(base);
  const seedChanged = { nodes: [{ id: 1, type: "KSampler", widgets_values_named: { seed: 999999, noise_seed: 2, seed_mode: "randomize", steps: 20 } }] };
  assert.equal(graphSigIgnoringSeed(seedChanged), s0, "seed 变化应忽略");
  const noiseChanged = { nodes: [{ id: 1, type: "KSampler", widgets_values_named: { seed: 1, noise_seed: 888888, seed_mode: "randomize", steps: 20 } }] };
  assert.equal(graphSigIgnoringSeed(noiseChanged), s0, "noise_seed 变化应忽略");
  const modeChanged = { nodes: [{ id: 1, type: "KSampler", widgets_values_named: { seed: 1, noise_seed: 2, seed_mode: "fixed", steps: 20 } }] };
  assert.notEqual(graphSigIgnoringSeed(modeChanged), s0, "seed_mode 变化必须改签名");
  // dict 型 widgets_values 同口径
  const baseD = { nodes: [{ id: 1, type: "K", widgets_values: { seed: 1, seed_mode: "randomize" } }] };
  const sd0 = graphSigIgnoringSeed(baseD);
  assert.equal(graphSigIgnoringSeed({ nodes: [{ id: 1, type: "K", widgets_values: { seed: 5, seed_mode: "randomize" } }] }), sd0);
  assert.notEqual(graphSigIgnoringSeed({ nodes: [{ id: 1, type: "K", widgets_values: { seed: 1, seed_mode: "fixed" } }] }), sd0);
});

test("graphSigIgnoringSeed：v4 节点 explicit title 进签名（只改名也改签名）", () => {
  const makeBase = () => ({
    nodes: [
      { id: 1, type: "KSampler", title: "旧名", widgets_values_named: { seed: 1, steps: 20 } },
      { id: 2, type: "VAEDecode" },
    ],
    links: [],
    groups: [{ id: 1, title: "G", color: "#3f789e", bounding: [11, -100, 398.897, 349.751], flags: {} }],
  });
  const base = makeBase();
  const s0 = graphSigIgnoringSeed(base);
  const renamed = makeBase();
  renamed.nodes[0].title = "新名";
  const s1 = graphSigIgnoringSeed(renamed);
  assert.match(s1, /^v4:[0-9a-f]{8}$/);
  assert.notEqual(s1, s0, "只改节点 title 应改签名");
  // 删名（有 → 无）也改签名
  const unnamed = makeBase();
  delete unnamed.nodes[0].title;
  assert.notEqual(graphSigIgnoringSeed(unnamed), s0, "删名应改签名");
});

test("graphSigIgnoringSeed：v4 节点 title 缺失与空串等价；非法 title 归空串", () => {
  const plain = () => ({
    nodes: [{ id: 1, type: "KSampler", widgets_values_named: { seed: 1, steps: 20 } }],
    links: [],
    groups: [],
  });
  const s0 = graphSigIgnoringSeed(plain());
  const missing = plain();
  delete missing.nodes[0].title;
  const empty = plain();
  empty.nodes[0].title = "";
  assert.equal(graphSigIgnoringSeed(missing), s0);
  assert.equal(graphSigIgnoringSeed(empty), s0);
  assert.equal(graphSigIgnoringSeed(missing), graphSigIgnoringSeed(empty));
  // 非字符串 title（null / 数字 / 对象 / 数组）归 ""（explicitTitle 只认非空 str）
  for (const bad of [null, 123, {}, []]) {
    const g = plain();
    g.nodes[0].title = bad;
    assert.equal(graphSigIgnoringSeed(g), s0, `非法 title ${JSON.stringify(bad)} 应归空串`);
  }
});

test("graphSigIgnoringSeed：v4 用 explicitTitle（不用 nodeTitle），纯改 type 不重复计 title", () => {
  const a = { nodes: [{ id: 1, type: "A", title: "同名", widgets_values: [1] }] };
  const b = { nodes: [{ id: 1, type: "B", title: "同名", widgets_values: [1] }] };
  assert.notEqual(graphSigIgnoringSeed(a), graphSigIgnoringSeed(b));
  // 两侧都无 title 时节点段 title 位恒为 ""（补空串 title 不改签名）
  const c = { nodes: [{ id: 1, type: "A", widgets_values: [1] }] };
  const c2 = { nodes: [{ id: 1, type: "A", title: "", widgets_values: [1] }] };
  assert.equal(graphSigIgnoringSeed(c), graphSigIgnoringSeed(c2));
});

test("computeDelta：只改节点 title → changed 含 fields:[\"title\"]", () => {
  const prev = { nodes: [{ id: 1, type: "KSampler", title: "旧名", widgets_values_named: { seed: 1, steps: 20 } }] };
  const next = { nodes: [{ id: 1, type: "KSampler", title: "新名", widgets_values_named: { seed: 1, steps: 20 } }] };
  assert.deepEqual(computeDelta(prev, next).changed, [{ id: 1, title: "新名", fields: ["title"] }]);
  // 起名 / 删名也算
  const noTitle = { nodes: [{ id: 1, type: "KSampler", widgets_values_named: { steps: 20 } }] };
  const named = { nodes: [{ id: 1, type: "KSampler", title: "甲", widgets_values_named: { steps: 20 } }] };
  assert.deepEqual(computeDelta(noTitle, named).changed, [{ id: 1, title: "甲", fields: ["title"] }]);
  assert.deepEqual(computeDelta(named, noTitle).changed, [{ id: 1, title: "KSampler", fields: ["title"] }]);
  // 纯改 type（两侧无显式 title）→ 只报 type
  assert.deepEqual(
    computeDelta({ nodes: [{ id: 1, type: "A" }] }, { nodes: [{ id: 1, type: "B" }] }).changed,
    [{ id: 1, title: "B", fields: ["type"] }],
  );
  // title + widgets 同时变 → 顺序 title → widget
  assert.deepEqual(
    computeDelta(
      { nodes: [{ id: 1, type: "A", title: "x", widgets_values_named: { steps: 1 } }] },
      { nodes: [{ id: 1, type: "A", title: "y", widgets_values_named: { steps: 2 } }] },
    ).changed,
    [{ id: 1, title: "y", fields: ["title", "steps"] }],
  );
});
