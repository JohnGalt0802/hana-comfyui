// app/lib/canvas-analysis.test.mjs — 画布语义层 P2：check + trace 单测（自含 · 零依赖）
// 运行：node app/lib/canvas-analysis.test.mjs
//       node app/lib/canvas-analysis.test.mjs --sample    # 附加打印 check / trace 样例
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { analyzeGraph, traceGraph } from "./canvas-analysis.mjs";

// ── 合成样本图（10 节点 / 5 连线）──
// 在 P1 样本上扩展：#30 悬空；#31 SaveImage 未接输入（且全未连 → 按互斥口径只报 DANGLING）；
// #32 MarkdownNote（排除用）；#7 为 bypass 的 Note（同样排除）；#12 为 mute。
const GRAPH = {
  id: "wf-test",
  revision: 71,
  nodes: [
    { id: 2, type: "CheckpointLoaderSimple", title: "Checkpoint 加载", mode: 0,
      inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [41] }],
      widgets_values: ["model.safetensors"], pos: [10, 10], size: [300, 98] },
    { id: 6, type: "CLIPTextEncode", title: "正向提示词", mode: 0,
      inputs: [{ name: "clip", type: "CLIP", link: null }],
      outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [42] }],
      widgets_values: ["a cat"], pos: [330, 10], size: [400, 200] },
    { id: 7, type: "Note", title: "备注", mode: 4,
      inputs: [], outputs: [], widgets_values: ["todo"], pos: [10, 300], size: [200, 100] },
    { id: 8, type: "SizeApply", title: "尺寸", mode: 0,
      inputs: [
        { name: "width", type: "INT", link: 38 },
        { name: "height", type: "INT", link: 39 },
        { name: "latent", type: "LATENT", link: null },
      ],
      outputs: [{ name: "LATENT", type: "LATENT", links: [40] }],
      widgets_values: [], pos: [600, 10], size: [240, 80] },
    { id: 12, type: "KSampler", mode: 2,
      inputs: [
        { name: "model", type: "MODEL", link: 41 },
        { name: "positive", type: "CONDITIONING", link: 42 },
        { name: "latent_image", type: "LATENT", link: 40 },
      ],
      outputs: [{ name: "LATENT", type: "LATENT", links: null }],
      widgets_values: [42, "euler", 20], pos: [900, 10], size: [315, 262] },
    { id: 27, type: "PrimitiveInt", title: "尺寸·宽", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [38] }],
      widgets_values: [1248], pos: [600, 320], size: [210, 58] },
    { id: 28, type: "PrimitiveInt", title: "尺寸·高", mode: 0,
      inputs: [], outputs: [{ name: "INT", type: "INT", links: [39] }],
      widgets_values: [832], pos: [840, 320], size: [210, 58] },
    { id: 30, type: "EmptyLatentImage", title: "悬空尺寸", mode: 0,
      inputs: [], outputs: [{ name: "LATENT", type: "LATENT", links: null }],
      widgets_values: [512, 512, 1], pos: [1200, 10], size: [315, 106] },
    { id: 31, type: "SaveImage", title: "保存", mode: 0,
      inputs: [{ name: "images", type: "IMAGE", link: null }],
      outputs: [], widgets_values: ["ComfyUI"], pos: [1200, 300], size: [315, 270] },
    { id: 32, type: "MarkdownNote", title: "说明", mode: 0,
      inputs: [], outputs: [], widgets_values: ["# 说明"], pos: [1200, 600], size: [300, 200] },
  ],
  links: [
    [38, 27, 0, 8, 0, "INT"],
    [39, 28, 0, 8, 1, "INT"],
    [40, 8, 0, 12, 2, "LATENT"],
    [41, 2, 0, 12, 0, "MODEL"],
    [42, 6, 0, 12, 1, "CONDITIONING"],
  ],
  groups: [],
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

// ── check ────────────────────────────────────────────────────────────────────

test("check：全量清单（互斥：每节点最多一条；升序；Note/MarkdownNote 排除）", () => {
  const r = analyzeGraph(GRAPH);
  assert.strictEqual(r.op, "check");
  assert.strictEqual(r.rev, 71);
  assert.deepStrictEqual(r.scanned, { nodes: 10, links: 5 });
  assert.strictEqual(r.issueCount, 3);
  assert.deepStrictEqual(r.issues, [
    { level: "info", code: "MUTED_BYPASSED", node: 12, type: "KSampler", title: "", msg: "已 mute（不参与执行）" },
    { level: "warn", code: "DANGLING", node: 30, type: "EmptyLatentImage", title: "悬空尺寸", msg: "悬空：无任何连线" },
    { level: "warn", code: "DANGLING", node: 31, type: "SaveImage", title: "保存", msg: "悬空：无任何连线" },
  ]);
  // #31 全未连 → 只报 DANGLING，不再双报 OUTPUT_UNWIRED
  assert.ok(!r.issues.some((i) => i.node === 31 && i.code !== "DANGLING"));
});

test("check：主图规则分布（#31 让位 DANGLING，不再双报）", () => {
  const r = analyzeGraph(GRAPH);
  assert.deepStrictEqual(
    r.issues.filter((i) => i.code === "DANGLING").map((i) => [i.node, i.level]),
    [[30, "warn"], [31, "warn"]],
  );
  assert.deepStrictEqual(r.issues.filter((i) => i.code === "OUTPUT_UNWIRED"), []); // 主图由互斥用例另行覆盖
  assert.deepStrictEqual(
    r.issues.filter((i) => i.code === "MUTED_BYPASSED").map((i) => [i.node, i.level]),
    [[12, "info"]],
  );
});

test("check：互斥优先级（a 部分连接未接→OUTPUT_UNWIRED；b mute 悬空→DANGLING；c 有连接 mute→MUTED_BYPASSED）", () => {
  // a) SaveImage 有部分连接（images 已接），另一输入未接 → OUTPUT_UNWIRED 单独命中（无 DANGLING）
  const a = analyzeGraph({
    nodes: [
      { id: 1, type: "PrimitiveImage", mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }] },
      { id: 2, type: "SaveImage", title: "保存", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 2 }, { name: "mask", type: "MASK", link: null }], outputs: [] },
    ],
    links: [[2, 1, 0, 2, 0, "IMAGE"]],
  });
  assert.deepStrictEqual(a.issues, [
    { level: "warn", code: "OUTPUT_UNWIRED", node: 2, type: "SaveImage", title: "保存", msg: "输出未接：mask" },
  ]);
  // b) mute 节点悬空 → 只报 DANGLING（不再附加 MUTED_BYPASSED）
  const b = analyzeGraph({
    nodes: [{ id: 7, type: "KSampler", title: "静音节点", mode: 2, inputs: [{ name: "model", link: null }], outputs: [{ name: "LATENT", type: "LATENT", links: null }] }],
    links: [],
  });
  assert.deepStrictEqual(b.issues, [
    { level: "warn", code: "DANGLING", node: 7, type: "KSampler", title: "静音节点", msg: "悬空：无任何连线" },
  ]);
  // c) 有连接且 mute → MUTED_BYPASSED 正常命中
  const c = analyzeGraph({
    nodes: [
      { id: 1, type: "PrimitiveInt", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [3] }] },
      { id: 2, type: "KSampler", mode: 2, inputs: [{ name: "seed", link: 3 }], outputs: [] },
    ],
    links: [[3, 1, 0, 2, 0, "INT"]],
  });
  assert.deepStrictEqual(c.issues, [
    { level: "info", code: "MUTED_BYPASSED", node: 2, type: "KSampler", title: "", msg: "已 mute（不参与执行）" },
  ]);
});

test("check：Note / MarkdownNote 整体跳过", () => {
  const r = analyzeGraph(GRAPH);
  assert.ok(!r.issues.some((i) => i.node === 7 || i.node === 32));
  assert.ok(!r.issues.some((i) => i.type === "Note" || i.type === "MarkdownNote"));
});

test("check：issues 按 node id 升序（乱序输入样本）", () => {
  const g = {
    revision: 1,
    nodes: [
      { id: 9, type: "EmptyLatentImage", mode: 0, inputs: [], outputs: [{ name: "LATENT", type: "LATENT", links: null }] },
      { id: 3, type: "KSampler", mode: 2, inputs: [{ name: "model", type: "MODEL", link: 5 }], outputs: [], widgets_values: [] },
    ],
    links: [[5, 1, 0, 3, 0, "MODEL"]],
  };
  const r = analyzeGraph(g);
  assert.deepStrictEqual(r.issues.map((i) => i.node), [3, 9]);
});

test("check：空图 / 缺省字段 → 零问题，rev null", () => {
  const r1 = analyzeGraph({ nodes: [] });
  assert.strictEqual(r1.issueCount, 0);
  assert.deepStrictEqual(r1.issues, []);
  assert.deepStrictEqual(r1.scanned, { nodes: 0, links: 0 });
  assert.strictEqual(r1.rev, null);
  const r2 = analyzeGraph({ revision: 2, nodes: [], links: [] });
  assert.strictEqual(r2.rev, 2);
});

test("check：全正常图 → 零问题", () => {
  const CLEAN = {
    nodes: [
      { id: 1, type: "PrimitiveInt", title: "值", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [7] }], widgets_values: [5] },
      { id: 2, type: "SomeTool", mode: 0, inputs: [{ name: "in", type: "INT", link: 7 }], outputs: [{ name: "OUT", type: "INT", links: null }], widgets_values: [] },
    ],
    links: [[7, 1, 0, 2, 0, "INT"]],
  };
  const r = analyzeGraph(CLEAN);
  assert.strictEqual(r.issueCount, 0);
  assert.strictEqual(r.rev, null);
});

test("check：mode=4 → bypass info（与 mute 标签可区分）", () => {
  const g = {
    nodes: [{ id: 5, type: "SomeTool", mode: 4, inputs: [{ name: "a", link: 1 }], outputs: [] }],
    links: [[1, 9, 0, 5, 0, "X"]],
  };
  const r = analyzeGraph(g);
  assert.strictEqual(r.issueCount, 1);
  assert.deepStrictEqual(r.issues[0], { level: "info", code: "MUTED_BYPASSED", node: 5, type: "SomeTool", title: "", msg: "已 bypass（输入直通）" });
});

test("check：graph 非对象 → 抛 Error", () => {
  assert.throws(() => analyzeGraph(null), /graph 非对象/);
  assert.throws(() => analyzeGraph("x"), /graph 非对象/);
  assert.throws(() => analyzeGraph(), /graph 非对象/);
});

// ── trace ────────────────────────────────────────────────────────────────────

test("trace up：名字命中（source 详情 + summary）", () => {
  const r = traceGraph(GRAPH, { node: 8, slot: "width" });
  assert.deepStrictEqual(r, {
    op: "trace",
    dir: "up",
    query: { node: 8, slot: "width" },
    resolved: "link",
    linkId: 38,
    source: { node: 27, slot: 0, slotName: "INT", type: "PrimitiveInt", title: "尺寸·宽", widgets_values: [1248] },
    summary: "#8.width ← #27（PrimitiveInt「尺寸·宽」，value=1248）",
  });
});

test("trace up：索引命中（数字 0 / 数字字符串回退 / node 传字符串）", () => {
  const a = traceGraph(GRAPH, { node: 8, slot: 0 });
  assert.deepStrictEqual(a.query, { node: 8, slot: 0 });
  assert.strictEqual(a.linkId, 38);
  assert.strictEqual(a.source.node, 27);
  assert.strictEqual(a.summary, "#8.width ← #27（PrimitiveInt「尺寸·宽」，value=1248）");
  const b = traceGraph(GRAPH, { node: 8, slot: "1" }); // 名字不中 → 回退数字索引 1 → height → #28
  assert.strictEqual(b.linkId, 39);
  assert.strictEqual(b.source.node, 28);
  const c = traceGraph(GRAPH, { node: "8", slot: "width" }); // node 接受字符串
  assert.strictEqual(c.resolved, "link");
  assert.strictEqual(c.source.node, 27);
});

test("trace up：槽存在但无连线 → none + note", () => {
  const r = traceGraph(GRAPH, { node: 8, slot: "latent" });
  assert.strictEqual(r.resolved, "none");
  assert.strictEqual(r.note, "#8.latent 暂无所连来源");
  assert.ok(!("linkId" in r) && !("source" in r));
});

test("trace up：槽不存在 → none + 候选槽名", () => {
  const r = traceGraph(GRAPH, { node: 8, slot: "zzz" });
  assert.strictEqual(r.resolved, "none");
  assert.strictEqual(r.note, '节点 #8 没有输入槽 "zzz"；可用：width、height、latent');
  assert.strictEqual(r.summary, "#8.zzz 无此输入槽");
});

test("trace up：节点不存在 → none + note", () => {
  const r = traceGraph(GRAPH, { node: 999, slot: "width" });
  assert.strictEqual(r.resolved, "none");
  assert.strictEqual(r.note, "找不到节点 #999");
  assert.strictEqual(r.summary, "#999 不在当前画布中");
});

test("trace down：单目标", () => {
  const r = traceGraph(GRAPH, { node: 27, slot: "INT", dir: "down" });
  assert.deepStrictEqual(r, {
    op: "trace",
    dir: "down",
    query: { node: 27, slot: "INT" },
    resolved: "links",
    targets: [{ linkId: 38, node: 8, slot: 0, slotName: "width", type: "SizeApply", title: "尺寸" }],
    summary: "#27.INT → #8.width",
  });
});

test("trace down：多目标（扇出）", () => {
  const FAN = {
    revision: 5,
    nodes: [
      { id: 1, type: "PrimitiveInt", title: "值", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [10, 11] }], widgets_values: [7] },
      { id: 2, type: "SizeApply", title: "甲", mode: 0, inputs: [{ name: "v", type: "INT", link: 10 }], outputs: [] },
      { id: 3, type: "ImageScale", title: "乙", mode: 0, inputs: [{ name: "v", type: "INT", link: 11 }], outputs: [] },
    ],
    links: [[10, 1, 0, 2, 0, "INT"], [11, 1, 0, 3, 0, "INT"]],
  };
  const r = traceGraph(FAN, { node: 1, slot: "INT", dir: "down" });
  assert.strictEqual(r.resolved, "links");
  assert.deepStrictEqual(r.targets, [
    { linkId: 10, node: 2, slot: 0, slotName: "v", type: "SizeApply", title: "甲" },
    { linkId: 11, node: 3, slot: 0, slotName: "v", type: "ImageScale", title: "乙" },
  ]);
  assert.strictEqual(r.summary, "#1.INT → #2.v、#3.v");
});

test("trace down：无目标 → none + note", () => {
  const r = traceGraph(GRAPH, { node: 30, slot: "LATENT", dir: "down" });
  assert.strictEqual(r.resolved, "none");
  assert.strictEqual(r.note, "#30.LATENT 暂无所连去向");
  assert.ok(!("targets" in r));
});

test("trace down：槽不存在 → none + 候选槽名", () => {
  const r = traceGraph(GRAPH, { node: 8, slot: "zzz", dir: "down" });
  assert.strictEqual(r.resolved, "none");
  assert.strictEqual(r.note, '节点 #8 没有输出槽 "zzz"；可用：LATENT');
});

test("trace down：引用缺失如实计数（部分缺失 / 全部缺失）", () => {
  const g = {
    revision: 1,
    nodes: [
      { id: 1, type: "PrimitiveInt", title: "值", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [90, 91] }], widgets_values: [1] },
      { id: 2, type: "SizeApply", title: "甲", mode: 0, inputs: [{ name: "v", type: "INT", link: 90 }], outputs: [] },
      { id: 3, type: "PrimitiveInt", title: "值2", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [92, 93] }], widgets_values: [2] },
    ],
    links: [[90, 1, 0, 2, 0, "INT"]], // 91 / 92 / 93 均缺失
  };
  const partial = traceGraph(g, { node: 1, slot: "INT", dir: "down" });
  assert.deepStrictEqual(partial, {
    op: "trace", dir: "down", query: { node: 1, slot: "INT" },
    resolved: "links",
    targets: [{ linkId: 90, node: 2, slot: 0, slotName: "v", type: "SizeApply", title: "甲" }],
    summary: "#1.INT → #2.v",
    note: "有 1 条引用在 links 表中缺失",
  });
  const all = traceGraph(g, { node: 3, slot: "INT", dir: "down" });
  assert.deepStrictEqual(all, {
    op: "trace", dir: "down", query: { node: 3, slot: "INT" },
    resolved: "none",
    note: "有 2 条引用无法解析（links 表缺失）",
    summary: "#3.INT 有 2 条引用无法解析（links 表缺失）",
  });
});

test("trace：参数缺失 → 抛 Error", () => {
  assert.throws(() => traceGraph(GRAPH, {}), /node 必填/);
  assert.throws(() => traceGraph(GRAPH, { node: 8 }), /slot 必填/);
  assert.throws(() => traceGraph(GRAPH), /node 必填/);
});

test("trace：graph 非对象 → 抛 Error", () => {
  assert.throws(() => traceGraph(null, { node: 8, slot: "width" }), /graph 非对象/);
});

test("trace：dir 非法 → 抛 Error", () => {
  assert.throws(() => traceGraph(GRAPH, { node: 8, slot: "width", dir: "sideways" }), /dir/);
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
if (process.argv.includes("--sample")) {
  console.log("\n── 样例（输入：本文件合成图 GRAPH，10 节点 / 5 连线）──");
  console.log("\ncheck：");
  console.log(JSON.stringify(analyzeGraph(GRAPH), null, 2));
  console.log('\ntrace up（node=8, slot="width"）：');
  console.log(JSON.stringify(traceGraph(GRAPH, { node: 8, slot: "width" }), null, 2));
  console.log('\ntrace down（node=27, slot="INT", dir="down"）：');
  console.log(JSON.stringify(traceGraph(GRAPH, { node: 27, slot: "INT", dir: "down" }), null, 2));
}
process.exitCode = fail ? 1 : 0;
