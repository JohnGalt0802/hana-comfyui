// app/runtime/history-commit.test.mjs — 提交快照落盘 单测（自含 · 零依赖）
// 运行：node --test app/runtime/history-commit.test.mjs
// 隔离纪律：workflowsDir 全程指向 os.tmpdir() 下的临时目录；结束清理；不触碰任何真实用户数据。
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHistoryCommit, INDEX_FILE_NAME, MAX_SNAPSHOT_BYTES } from "./history-commit.mjs";

// 每次测试一个独立临时目录当 workflowsDir
function makeTmp() {
  return mkdtempSync(join(tmpdir(), "hui-history-commit-"));
}

function makeGraph() {
  return {
    last_node_id: 3,
    last_link_id: 1,
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", pos: [0, 0], widgets_values: ["model.safetensors"] },
      { id: 2, type: "CLIPTextEncode", pos: [0, 100], widgets_values: ["a cat"] },
      { id: 3, type: "KSampler", pos: [0, 200], widgets_values: { seed: 42, steps: 20 } },
    ],
    links: [[1, 1, 0, 3, 0, "MODEL"]],
    groups: [],
    extra: { ds: { scale: 1 } },
  };
}

test("首次提交：自建目录 + 快照落盘 + round-trip + 索引 1 行（不含 graph）", () => {
  const root = makeTmp();
  try {
    const historyDir = join(root, ".history", "my workflow");
    assert.equal(existsSync(historyDir), false, "前置：历史目录尚不存在");

    const graph = makeGraph();
    const out = handleHistoryCommit(
      { workflow: "my workflow", promptId: "a3f9c2e1-0000", graph, at: "2026-10-11T00:00:00.000Z", source: "user" },
      { workflowsDir: root },
    );

    assert.equal(out.status, 200);
    assert.equal(out.ok, true);
    assert.equal(out.seq, 1);
    assert.equal(out.dir, join(root, ".history", "my workflow"));
    assert.equal(out.file, "0001-a3f9c2e1.json");

    // 目录被自建
    assert.equal(existsSync(historyDir), true, "历史目录应被递归自建");
    assert.equal(statSync(historyDir).isDirectory(), true);

    // 快照文件存在且内容 round-trip
    const absFile = join(historyDir, out.file);
    assert.equal(existsSync(absFile), true);
    const snap = JSON.parse(readFileSync(absFile, "utf8"));
    assert.equal(snap.seq, 1);
    assert.equal(snap.promptId, "a3f9c2e1-0000");
    assert.equal(snap.at, "2026-10-11T00:00:00.000Z");
    assert.equal(snap.source, "user");
    assert.equal(snap.nodeCount, graph.nodes.length);
    assert.equal(snap.linkCount, graph.links.length);
    assert.deepEqual(snap.graph, graph, "graph 应 round-trip 回原对象");

    // index.jsonl 一行，且不含 graph
    const idxText = readFileSync(join(historyDir, INDEX_FILE_NAME), "utf8");
    const lines = idxText.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1);
    assert.equal(idxText.includes('"graph"'), false, "索引行不得含 graph 字段");
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.seq, 1);
    assert.equal(meta.file, "0001-a3f9c2e1.json");
    assert.equal(meta.promptId, "a3f9c2e1-0000");
    assert.equal(meta.nodeCount, graph.nodes.length);
    assert.equal(meta.linkCount, graph.links.length);
    assert.equal(Object.prototype.hasOwnProperty.call(meta, "graph"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("第二次提交：seq=2 + 第二个文件 + 索引 2 行（追加而非覆盖）", () => {
  const root = makeTmp();
  try {
    const out1 = handleHistoryCommit(
      { workflow: "wf", promptId: "aaaa1111", graph: makeGraph(), source: "user" },
      { workflowsDir: root },
    );
    assert.equal(out1.seq, 1);

    const firstIdxBefore = readFileSync(join(root, ".history", "wf", INDEX_FILE_NAME), "utf8");

    const out2 = handleHistoryCommit(
      { workflow: "wf", promptId: "bbbb2222", graph: makeGraph(), source: "agent" },
      { workflowsDir: root },
    );
    assert.equal(out2.status, 200);
    assert.equal(out2.seq, 2);
    assert.equal(out2.file, "0002-bbbb2222.json");

    const dir = join(root, ".history", "wf");
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["0001-aaaa1111.json", "0002-bbbb2222.json", INDEX_FILE_NAME]);
    assert.equal(existsSync(join(dir, "0002-bbbb2222.json")), true);

    const idxText = readFileSync(join(dir, INDEX_FILE_NAME), "utf8");
    const lines = idxText.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 2, "索引应为追加：2 行");
    // 追加语义：第一行内容原样保留（未被覆盖重写）
    assert.equal(idxText.startsWith(firstIdxBefore), true, "第一次的索引内容应在文件开头原样保留");
    assert.equal(JSON.parse(lines[0]).seq, 1);
    assert.equal(JSON.parse(lines[1]).seq, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺 graph → 400 错误返回，且不落盘", () => {
  const root = makeTmp();
  try {
    const out = handleHistoryCommit({ workflow: "wf" }, { workflowsDir: root });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.ok(out.error, "应有 error 文案");
    assert.equal(existsSync(join(root, ".history")), false, "错误路径不应创建任何目录/文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺 workflow → 400 错误返回", () => {
  const root = makeTmp();
  try {
    const out = handleHistoryCommit({ graph: makeGraph() }, { workflowsDir: root });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("超大 graph → 体积错误（413 语义），不写盘", () => {
  const root = makeTmp();
  try {
    const bigGraph = makeGraph();
    bigGraph.blob = "x".repeat(MAX_SNAPSHOT_BYTES + 1024); // 序列化后必超上限
    const out = handleHistoryCommit(
      { workflow: "wf", promptId: "big", graph: bigGraph },
      { workflowsDir: root },
    );
    assert.equal(out.ok, false);
    assert.equal(out.status, 413);
    assert.ok(out.size > MAX_SNAPSHOT_BYTES, "应报告超限体积");
    assert.equal(existsSync(join(root, ".history")), false, "体积超限不得写盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
