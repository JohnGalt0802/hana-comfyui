// app/lib/canvas-diff.test.mjs — 画布语义层 T2：两版语义 diff 单测（自含 · 零依赖）
// 运行：node app/lib/canvas-diff.test.mjs
//       node app/lib/canvas-diff.test.mjs --sample    # 附加打印样例
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { diffGraph } from "./canvas-diff.mjs";

// ── 样例：B 相对 A 的语义变化 ──
// 节点：#1 改（title/widgets/named）、#2 改（steps）、#5 增、#4 删
// 连线：2.0 换源（1→5，直替）、3.0 删、3.1 增
// 组：G1 改（伸缩）、G2 删、G3 增
const A = {
  id: "wf-a",
  revision: 71,
  nodes: [
    { id: 1, type: "PrimitiveInt", title: "宽", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [10] }],
      widgets_values: [1024], widgets_values_named: { value: 1024 } },
    { id: 2, type: "KSampler", title: "采样", mode: 0,
      inputs: [{ name: "v", type: "INT", link: 10 }],
      outputs: [{ name: "LATENT", type: "LATENT", links: [11] }],
      widgets_values: [42, "euler", 20], widgets_values_named: { seed: 42, steps: 20 } },
    { id: 3, type: "SaveImage", title: "保存", mode: 0,
      inputs: [{ name: "images", type: "IMAGE", link: 11 }],
      outputs: [], widgets_values: ["A"] },
    { id: 4, type: "Note", title: "备注", mode: 0,
      inputs: [], outputs: [], widgets_values: ["todo"] },
  ],
  links: [[10, 1, 0, 2, 0, "INT"], [11, 2, 0, 3, 0, "LATENT"]],
  groups: [
    { id: 1, title: "G1", bounding: [0, 0, 100, 100] },
    { id: 2, title: "G2", bounding: [200, 0, 100, 100] },
  ],
};

const B = {
  id: "wf-b",
  revision: 72,
  nodes: [
    { id: 1, type: "PrimitiveInt", title: "宽·新", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [12] }],
      widgets_values: [2048], widgets_values_named: { value: 2048 } },
    { id: 2, type: "KSampler", title: "采样", mode: 0,
      inputs: [{ name: "v", type: "INT", link: 12 }],
      outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
      widgets_values: [42, "euler", 30], widgets_values_named: { seed: 42, steps: 30 } },
    { id: 3, type: "SaveImage", title: "保存", mode: 0,
      inputs: [{ name: "images", type: "IMAGE", link: null }, { name: "meta", type: "INT", link: 13 }],
      outputs: [], widgets_values: ["A"] },
    { id: 5, type: "PrimitiveInt", title: "宽2", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [12, 13] }],
      widgets_values: [111] },
  ],
  links: [[12, 5, 0, 2, 0, "INT"], [13, 5, 0, 3, 1, "INT"]],
  groups: [
    { id: 1, title: "G1", bounding: [0, 0, 120, 100] },
    { id: 3, title: "G3", bounding: [400, 0, 100, 100] },
  ],
};

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

test("diff：节点增/删/改（含值变化与 named 值对比）+ 连线增/删/直替 + 组变化 + rev", () => {
  const r = diffGraph(A, B);
  assert.strictEqual(r.op, "diff");
  assert.strictEqual(r.semanticRev, "s1");
  assert.deepStrictEqual(r.rev, { base: 71, next: 72 });
  assert.strictEqual(r.clean, false);

  // 节点
  assert.deepStrictEqual(r.nodes.added, [
    { id: 5, type: "PrimitiveInt", title: "宽2", symbol: '#5 PrimitiveInt "宽2" = 111' },
  ]);
  assert.deepStrictEqual(r.nodes.removed, [
    { id: 4, type: "Note", title: "备注", symbol: '#4 Note "备注" = "todo"' },
  ]);
  assert.deepStrictEqual(r.nodes.changed, [
    {
      id: 1, type: "PrimitiveInt", title: "宽·新", symbol: '#1 PrimitiveInt "宽·新" = 2048',
      changes: [
        { field: "title", from: "宽", to: "宽·新" },
        { field: "widgets_values", from: [1024], to: [2048] },
        { field: "widgets_values_named.value", from: 1024, to: 2048 },
      ],
    },
    {
      id: 2, type: "KSampler", title: "采样", symbol: '#2 KSampler "采样" = [42,"euler",30]',
      changes: [
        { field: "widgets_values", from: [42, "euler", 20], to: [42, "euler", 30] },
        { field: "widgets_values_named.steps", from: 20, to: 30 },
      ],
    },
  ]);

  // 连线：3.0 删；3.1 增；2.0 直替（1→5）
  assert.deepStrictEqual(r.links.added, [
    { from: 5, fromSlot: 0, to: 3, toSlot: 1, type: "INT", linkId: 13 },
  ]);
  assert.deepStrictEqual(r.links.removed, [
    { from: 2, fromSlot: 0, to: 3, toSlot: 0, type: "LATENT", linkId: 11 },
  ]);
  assert.deepStrictEqual(r.links.replaced, [
    { to: 2, toSlot: 0, before: { from: 1, fromSlot: 0 }, after: { from: 5, fromSlot: 0 }, type: "INT" },
  ]);

  // 组：G2 删、G3 增、G1 改
  assert.deepStrictEqual(r.groups.added, [{ id: 3, title: "G3", bounding: [400, 0, 100, 100] }]);
  assert.deepStrictEqual(r.groups.removed, [{ id: 2, title: "G2", bounding: [200, 0, 100, 100] }]);
  assert.deepStrictEqual(r.groups.changed, [
    { id: 1, title: "G1", changes: [{ field: "bounding", from: [0, 0, 100, 100], to: [0, 0, 120, 100] }] },
  ]);

  assert.strictEqual(r.summary, "节点 +1/-1/改2；连线 +1/-1/直替1；组 +1/-1/改1；rev 71→72");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r); // 可序列化
});

test("diff：幂等与顺序无关（同图全空；打乱两输入数组序结果不变）", () => {
  const r = diffGraph(A, JSON.parse(JSON.stringify(A)));
  assert.strictEqual(r.clean, true);
  assert.deepStrictEqual(r.nodes, { added: [], removed: [], changed: [] });
  assert.deepStrictEqual(r.links, { added: [], removed: [], replaced: [] });
  assert.deepStrictEqual(r.groups, { added: [], removed: [], changed: [] });
  assert.strictEqual(r.summary, "无差异；rev 71");

  const shuffle = (g) => ({
    revision: g.revision,
    nodes: [...g.nodes].reverse(),
    links: [...g.links].reverse(),
    groups: g.groups ? [...g.groups].reverse() : undefined,
  });
  assert.deepStrictEqual(diffGraph(shuffle(A), B), diffGraph(A, B));
  assert.deepStrictEqual(diffGraph(A, shuffle(B)), diffGraph(A, B));
});

test("diff：仅 linkId 变化不算差异；rev 不同但语义无差异", () => {
  const L1 = {
    revision: 5,
    nodes: [
      { id: 1, type: "PrimitiveInt", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [10] }], widgets_values: [1] },
      { id: 2, type: "SomeTool", mode: 0, inputs: [{ name: "v", link: 10 }], outputs: [], widgets_values: [] },
    ],
    links: [[10, 1, 0, 2, 0, "INT"]],
  };
  const L2 = JSON.parse(JSON.stringify(L1));
  L2.revision = 6;
  L2.links = [[99, 1, 0, 2, 0, "INT"]]; // 仅 linkId 不同
  const r = diffGraph(L1, L2);
  assert.strictEqual(r.clean, true);
  assert.strictEqual(r.summary, "无差异；rev 5→6");
});

test("diff：named 与位置值分开比对（过期 named 只报位置值变化；named 独改只报 named 项）", () => {
  const S1 = { revision: 1, nodes: [{ id: 1, type: "PrimitiveInt", widgets_values: [1024], widgets_values_named: { value: 1024 } }] };
  const S2 = { revision: 1, nodes: [{ id: 1, type: "PrimitiveInt", widgets_values: [2048], widgets_values_named: { value: 1024 } }] };
  const r1 = diffGraph(S1, S2);
  assert.deepStrictEqual(r1.nodes.changed, [
    { id: 1, type: "PrimitiveInt", title: "", symbol: "#1 PrimitiveInt = 2048",
      changes: [{ field: "widgets_values", from: [1024], to: [2048] }] },
  ]);
  const S3 = { revision: 1, nodes: [{ id: 1, type: "PrimitiveInt", widgets_values: [1024], widgets_values_named: { value: 999 } }] };
  const r2 = diffGraph(S1, S3);
  assert.deepStrictEqual(r2.nodes.changed[0].changes, [
    { field: "widgets_values_named.value", from: 1024, to: 999 },
  ]);
});

test("diff：组的 title 回退配对（无 id）；组标题变更也报", () => {
  const g1 = { revision: 1, nodes: [], links: [], groups: [{ title: "X", bounding: [0, 0, 1, 1] }] };
  const g2 = { revision: 1, nodes: [], links: [], groups: [{ title: "X", bounding: [0, 0, 2, 2] }] };
  const r = diffGraph(g1, g2);
  assert.deepStrictEqual(r.groups.changed, [
    { title: "X", changes: [{ field: "bounding", from: [0, 0, 1, 1], to: [0, 0, 2, 2] }] },
  ]);
});

test("diff：空图对空图 → 无差异；边界（缺 links/groups）；节点乱序输入", () => {
  const r = diffGraph({ nodes: [], links: [] }, { nodes: [] });
  assert.strictEqual(r.clean, true);
  assert.strictEqual(r.summary, "无差异；rev 无");
  const r2 = diffGraph({ nodes: [{ id: 2 }, { id: 1 }] }, { nodes: [{ id: 1 }, { id: 2 }] });
  assert.strictEqual(r2.clean, true);
});

test("diff：非对象输入 → 抛 Error", () => {
  assert.throws(() => diffGraph(null, A), /diffGraph: base 非对象/);
  assert.throws(() => diffGraph(A, "x"), /diffGraph: next 非对象/);
  assert.throws(() => diffGraph(undefined, undefined), /diffGraph: base 非对象/);
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
if (process.argv.includes("--sample")) {
  console.log("\n── 样例（本文件 A → B）──");
  console.log(JSON.stringify(diffGraph(A, B), null, 2));
}
process.exitCode = fail ? 1 : 0;
