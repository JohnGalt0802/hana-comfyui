// app/lib/canvas-outline.test.mjs — 画布语义层 P3：大纲 outline 单测（自含 · 零依赖）
// 运行：node app/lib/canvas-outline.test.mjs
//       node app/lib/canvas-outline.test.mjs --sample    # 附加打印 outline 样例
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { outlineGraph } from "./canvas-outline.mjs";
import { analyzeGraph } from "./canvas-analysis.mjs";

// ── 合成样本图 A：2 个 groups（故意打乱 nodes 顺序以验证排序）──
// 组1「尺寸组」含 #8/#27/#28；组2 无标题（含 #12/#20，#8 同时落在两组 → 取第一个=尺寸组）；
// 其余走角色兜底（#2 加载 / #6 文本 / #30 其他 / #31 输出）；#30 悬空（供 issues 复用用）。
const GRAPH_A = {
  id: "wf-a",
  revision: 72,
  nodes: [
    { id: 31, type: "SaveImage", title: "保存", mode: 0,
      inputs: [{ name: "images", type: "IMAGE", link: 43 }], outputs: [],
      widgets_values: ["ComfyUI"], pos: [400, 760], size: [315, 270] },
    { id: 8, type: "SizeApply", title: "尺寸", mode: 0,
      inputs: [{ name: "width", type: "INT", link: 38 }, { name: "height", type: "INT", link: 39 }, { name: "latent", type: "LATENT", link: null }],
      outputs: [{ name: "LATENT", type: "LATENT", links: [40] }],
      widgets_values: [], pos: [700, 420], size: [240, 80] },
    { id: 2, type: "CheckpointLoaderSimple", title: "Checkpoint 加载", mode: 0,
      inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [41, 46] }],
      widgets_values: ["model.safetensors"], pos: [20, 20], size: [300, 98] },
    { id: 20, type: "SamplerCustom", title: "自定义采样", mode: 0,
      inputs: [{ name: "model", type: "MODEL", link: 46 }], outputs: [],
      widgets_values: [], pos: [560, 440], size: [280, 100] },
    { id: 27, type: "PrimitiveInt", title: "尺寸·宽", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [38] }],
      widgets_values: [1248], pos: [720, 20], size: [210, 58] },
    { id: 12, type: "KSampler", title: "采样器", mode: 0,
      inputs: [{ name: "model", type: "MODEL", link: 41 }, { name: "positive", type: "CONDITIONING", link: 42 }, { name: "latent_image", type: "LATENT", link: 40 }],
      outputs: [{ name: "LATENT", type: "LATENT", links: [43] }],
      widgets_values: [42, "euler", 20], pos: [400, 420], size: [315, 262] },
    { id: 30, type: "EmptyLatentImage", title: "悬空尺寸", mode: 0,
      inputs: [], outputs: [{ name: "LATENT", type: "LATENT", links: null }],
      widgets_values: [512, 512, 1], pos: [20, 760], size: [315, 106] },
    { id: 6, type: "CLIPTextEncode", title: "正向提示词", mode: 0,
      inputs: [{ name: "clip", type: "CLIP", link: null }],
      outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [42] }],
      widgets_values: ["a cat"], pos: [400, 20], size: [400, 200] },
    { id: 28, type: "PrimitiveInt", title: "尺寸·高", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [39] }],
      widgets_values: [832], pos: [960, 20], size: [210, 58] },
  ],
  links: [
    [38, 27, 0, 8, 0, "INT"],
    [39, 28, 0, 8, 1, "INT"],
    [40, 8, 0, 12, 2, "LATENT"],
    [41, 2, 0, 12, 0, "MODEL"],
    [42, 6, 0, 12, 1, "CONDITIONING"],
    [43, 12, 0, 31, 0, "LATENT"],
    [46, 2, 0, 20, 0, "MODEL"],
  ],
  groups: [
    { title: "尺寸组", bounding: [700, 0, 500, 560] },
    { title: "", bounding: [380, 400, 400, 330] }, // 无标题 → 「组2」（序号从 1 起）
  ],
};

// ── 合成样本图 B：无 groups → 全走角色兜底 ──
const GRAPH_B = {
  id: "wf-b",
  revision: 5,
  nodes: [
    { id: 1, type: "CheckpointLoaderSimple", title: "模型", mode: 0, inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [10] }], widgets_values: ["x.safetensors"], pos: [10, 10] },
    { id: 2, type: "CLIPTextEncode", title: "词", mode: 0, inputs: [], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [11] }], widgets_values: ["a cat"], pos: [10, 200] },
    { id: 3, type: "KSampler", title: "采样", mode: 0, inputs: [{ name: "model", type: "MODEL", link: 10 }, { name: "positive", type: "CONDITIONING", link: 11 }], outputs: [{ name: "LATENT", type: "LATENT", links: [12] }], widgets_values: [7, "euler", 20], pos: [10, 400] },
    { id: 4, type: "SaveImage", title: "保存", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 12 }], outputs: [], widgets_values: ["ComfyUI"], pos: [400, 400] },
    { id: 5, type: "PrimitiveInt", title: "数值", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [13] }], widgets_values: [8], pos: [400, 10] },
    { id: 6, type: "GizmoWidget", title: "小工具", mode: 0, inputs: [{ name: "in", type: "INT", link: 13 }], outputs: [], widgets_values: [], pos: [400, 200] },
  ],
  links: [
    [10, 1, 0, 3, 0, "MODEL"],
    [11, 2, 0, 3, 1, "CONDITIONING"],
    [12, 3, 0, 4, 0, "LATENT"],
    [13, 5, 0, 6, 0, "INT"],
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

test("outline：双组图——group 命中/组名/重叠取首个/role 兜底/排序/块内箭头/去重", () => {
  const r = outlineGraph(GRAPH_A);
  assert.strictEqual(r.op, "outline");
  assert.strictEqual(r.rev, 72);
  assert.deepStrictEqual(r.total, { nodes: 9, links: 7 });
  assert.strictEqual(r.blockCount, 6);
  assert.deepStrictEqual(r.blocks, [
    { name: "加载", source: "role", nodes: [2], summary: "#2(model.safetensors)" },
    { name: "文本", source: "role", nodes: [6], summary: "#6(a cat)" },
    { name: "尺寸组", source: "group", nodes: [8, 27, 28], summary: "#27(1248) #28(832) → #8" },
    { name: "组2", source: "group", nodes: [12, 20], summary: "#12 #20" },
    { name: "其他", source: "role", nodes: [30], summary: "#30" },
    { name: "输出", source: "role", nodes: [31], summary: "#31(ComfyUI)" },
  ]);
  // #8 同时落在两组 → 取第一个（尺寸组）；组2 无标题 → 「组2」
  assert.deepStrictEqual(r.blockEdges, [
    ["加载", "组2"], // 41（2→12）与 46（2→20）两条归并为一条（去重）
    ["文本", "组2"],
    ["尺寸组", "组2"], // 40（8→12）而来；38/39 为组内连线，不算
    ["组2", "输出"],
  ]);
});

test("outline：无 groups——角色归类与「其他」兜底", () => {
  const r = outlineGraph(GRAPH_B);
  assert.strictEqual(r.blockCount, 5);
  assert.deepStrictEqual(r.blocks, [
    { name: "加载", source: "role", nodes: [1], summary: "#1(x.safetensors)" },
    { name: "文本", source: "role", nodes: [2], summary: "#2(a cat)" },
    { name: "采样", source: "role", nodes: [3], summary: "#3" },
    { name: "输出", source: "role", nodes: [4], summary: "#4(ComfyUI)" },
    { name: "其他", source: "role", nodes: [5, 6], summary: "#5(8) → #6" },
  ]);
  assert.deepStrictEqual(r.blockEdges, [
    ["加载", "采样"],
    ["文本", "采样"],
    ["采样", "输出"], // 5→6 同块（其他），不算
  ]);
  assert.deepStrictEqual(r.issues, []);
});

test("outline：角色匹配大小写不敏感 + first-match（Noise 先于 Save）", () => {
  const g = {
    nodes: [
      { id: 1, type: "checkpointloadersimple", inputs: [], outputs: [] },
      { id: 2, type: "TEXTENCODE", inputs: [], outputs: [] },
      { id: 3, type: "somEDGEnoiseThing", inputs: [], outputs: [] },
      { id: 4, type: "previewimage", inputs: [], outputs: [] },
      { id: 5, type: "SaveImageNoise", inputs: [], outputs: [] },
    ],
  };
  const r = outlineGraph(g);
  assert.deepStrictEqual(r.blocks.map((b) => [b.name, b.source, b.nodes]), [
    ["加载", "role", [1]],
    ["文本", "role", [2]],
    ["采样", "role", [3, 5]], // SaveImageNoise 含 Noise → 采样（first-match 先于 Save）
    ["输出", "role", [4]],
  ]);
});

test("outline：group bounding 含边界（边角命中）；组外节点落角色", () => {
  const g = {
    revision: 1,
    nodes: [
      { id: 1, type: "AnyType", inputs: [], outputs: [], pos: [100, 200] }, // 左上角
      { id: 2, type: "AnyType", inputs: [], outputs: [], pos: [300, 400] }, // 右下角（含边界）
      { id: 3, type: "AnyType", inputs: [], outputs: [], pos: [500, 500] }, // 组外
    ],
    groups: [{ title: "边界组", bounding: [100, 200, 200, 200] }],
  };
  const r = outlineGraph(g);
  assert.deepStrictEqual(r.blocks, [
    { name: "边界组", source: "group", nodes: [1, 2], summary: "#1 #2" },
    { name: "其他", source: "role", nodes: [3], summary: "#3" },
  ]);
});

test("outline：无 pos 节点走角色兜底（groups 存在时）", () => {
  const g = {
    nodes: [
      { id: 1, type: "TextEncoder", inputs: [], outputs: [], pos: [10, 10] },
      { id: 2, type: "PrimitiveInt", inputs: [], outputs: [], widgets_values: [1] }, // 无 pos
    ],
    groups: [{ title: "G", bounding: [0, 0, 100, 100] }],
  };
  const r = outlineGraph(g);
  assert.deepStrictEqual(r.blocks, [
    { name: "G", source: "group", nodes: [1], summary: "#1" },
    { name: "其他", source: "role", nodes: [2], summary: "#2(1)" },
  ]);
});

test("outline：issues 复用 analyzeGraph（悬空节点）", () => {
  const r = outlineGraph(GRAPH_A);
  const a = analyzeGraph(GRAPH_A);
  assert.deepStrictEqual(r.issues, a.issues);
  assert.deepStrictEqual(r.issues, [
    { level: "warn", code: "DANGLING", node: 30, type: "EmptyLatentImage", title: "悬空尺寸", msg: "悬空：无任何连线" },
  ]);
});

test("outline：空图 → 全空输出", () => {
  const r = outlineGraph({ revision: 3, nodes: [], links: [] });
  assert.strictEqual(r.op, "outline");
  assert.strictEqual(r.rev, 3);
  assert.deepStrictEqual(r.total, { nodes: 0, links: 0 });
  assert.strictEqual(r.blockCount, 0);
  assert.deepStrictEqual(r.blocks, []);
  assert.deepStrictEqual(r.blockEdges, []);
  assert.deepStrictEqual(r.issues, []);
  const r2 = outlineGraph({ nodes: [] });
  assert.strictEqual(r2.rev, null);
});

test("outline：graph 非对象 → 抛 Error", () => {
  assert.throws(() => outlineGraph(null), /graph 非对象/);
  assert.throws(() => outlineGraph("x"), /graph 非对象/);
  assert.throws(() => outlineGraph(), /graph 非对象/);
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
if (process.argv.includes("--sample")) {
  console.log("\n── 样例（输入：本文件合成图 GRAPH_A，9 节点 / 7 连线 / 2 组）──");
  console.log(JSON.stringify(outlineGraph(GRAPH_A), null, 2));
}
process.exitCode = fail ? 1 : 0;
