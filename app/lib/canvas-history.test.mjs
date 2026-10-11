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
