// app/lib/canvas-perf.test.mjs — 画布语义层 T2：性能烟测（投影 / 大纲 × 2000 节点；记录耗时）
// 运行：node app/lib/canvas-perf.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 口径：2000 节点链式图（4 种角色 + 5 个组带），记录 projectGraph / outlineGraph 的墙钟耗时；
// 断言仅设「防病态」宽松上界（5000ms）+ 结果确定性（同输入两次调用深等）。
import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { projectGraph } from "./canvas-project.mjs";
import { outlineGraph } from "./canvas-outline.mjs";

const N = 2000;

function buildBigGraph(n) {
  const nodes = [];
  for (let i = 1; i <= n; i++) {
    const type = i % 10 === 0 ? "SaveImage" : i % 3 === 0 ? "KSampler" : i % 5 === 0 ? "PrimitiveInt" : "SomeTool";
    const wv = type === "PrimitiveInt" ? [1024 + (i % 7)] : type === "SaveImage" ? ["out"] : type === "KSampler" ? [1, "euler", 20] : [];
    nodes.push({
      id: i, type, title: `节点${i}`, mode: 0, inputs: [], outputs: [], widgets_values: wv,
      pos: [(i % 100) * 40, Math.floor(i / 100) * 40 + 10], size: [200, 80],
    });
  }
  const links = [];
  for (let i = 2; i <= n; i++) {
    const lid = i - 1;
    links.push([lid, i - 1, 0, i, 0, "INT"]);
    nodes[i - 2].outputs.push({ name: "OUT", type: "INT", links: [lid] });
    nodes[i - 1].inputs.push({ name: "in", type: "INT", link: lid });
  }
  const groups = [];
  for (let k = 0; k < 5; k++) groups.push({ title: `区${k + 1}`, bounding: [0, k * 200, 8000, 200] });
  return { id: "wf-perf", revision: 1, nodes, links, groups };
}

const GRAPH = buildBigGraph(N);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    const detail = e && e.stack ? String(e.stack).split("\n").slice(0, 3).join("\n      ") : String(e);
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

test("perf：projectGraph 2000 节点（全量 + 邻接），记录耗时", () => {
  const t0 = performance.now();
  const full = projectGraph(GRAPH);
  const t1 = performance.now();
  const adj = projectGraph(GRAPH, { select: "#1999/up:2" });
  const t2 = performance.now();
  const t3 = performance.now();
  projectGraph(GRAPH);
  const t4 = performance.now();
  console.log(`[perf] projectGraph 2000n 全量：${(t1 - t0).toFixed(2)}ms（复跑 ${(t4 - t3).toFixed(2)}ms；命中 ${full.matched.count} 节点 / ${full.links.length} 连线）`);
  console.log(`[perf] projectGraph 2000n 邻接 #1999/up:2：${(t2 - t1).toFixed(2)}ms（命中 ${adj.matched.count}）`);
  assert.strictEqual(full.matched.count, N);
  assert.deepStrictEqual(adj.matched.ids, [1997, 1998, 1999]);
  assert.ok(t1 - t0 < 5000 && t2 - t1 < 5000 && t4 - t3 < 5000, "耗时超防病态上界 5000ms");
});

test("perf：outlineGraph 2000 节点，记录耗时 + 确定性（两次深等）", () => {
  const t0 = performance.now();
  const a = outlineGraph(GRAPH);
  const t1 = performance.now();
  const b = outlineGraph(GRAPH);
  console.log(`[perf] outlineGraph 2000n：${(t1 - t0).toFixed(2)}ms（块 ${a.blockCount} / 块间边 ${a.blockEdges.length} / issues ${a.issues.length}）`);
  assert.strictEqual(a.blockCount, 5);
  assert.deepStrictEqual(b, a);
  assert.ok(t1 - t0 < 5000, "耗时超防病态上界 5000ms");
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
