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
    { level: "info", code: "MUTED_BYPASSED", node: 12, type: "KSampler", title: "", msg: "已 mute（不参与执行）", symbol: '#12 KSampler = [42,"euler",20]' },
    { level: "warn", code: "DANGLING", node: 30, type: "EmptyLatentImage", title: "悬空尺寸", msg: "悬空：无任何连线", symbol: '#30 EmptyLatentImage "悬空尺寸" = [512,512,1]' },
    { level: "warn", code: "DANGLING", node: 31, type: "SaveImage", title: "保存", msg: "悬空：无任何连线", symbol: '#31 SaveImage "保存" = "ComfyUI"' },
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
    { level: "warn", code: "OUTPUT_UNWIRED", node: 2, type: "SaveImage", title: "保存", msg: "输入未接：mask", symbol: '#2 SaveImage "保存"' },
  ]);
  // b) mute 节点悬空 → 只报 DANGLING（不再附加 MUTED_BYPASSED）
  const b = analyzeGraph({
    nodes: [{ id: 7, type: "KSampler", title: "静音节点", mode: 2, inputs: [{ name: "model", link: null }], outputs: [{ name: "LATENT", type: "LATENT", links: null }] }],
    links: [],
  });
  assert.deepStrictEqual(b.issues, [
    { level: "warn", code: "DANGLING", node: 7, type: "KSampler", title: "静音节点", msg: "悬空：无任何连线", symbol: '#7 KSampler "静音节点"' },
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
    { level: "info", code: "MUTED_BYPASSED", node: 2, type: "KSampler", title: "", msg: "已 mute（不参与执行）", symbol: "#2 KSampler" },
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
  assert.deepStrictEqual(r.issues[0], { level: "info", code: "MUTED_BYPASSED", node: 5, type: "SomeTool", title: "", msg: "已 bypass（输入直通）", symbol: "#5 SomeTool" });
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
    semanticRev: "s1",
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
    semanticRev: "s1",
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
    op: "trace", semanticRev: "s1", dir: "down", query: { node: 1, slot: "INT" },
    resolved: "links",
    targets: [{ linkId: 90, node: 2, slot: 0, slotName: "v", type: "SizeApply", title: "甲" }],
    summary: "#1.INT → #2.v",
    note: "有 1 条引用在 links 表中缺失",
  });
  const all = traceGraph(g, { node: 3, slot: "INT", dir: "down" });
  assert.deepStrictEqual(all, {
    op: "trace", semanticRev: "s1", dir: "down", query: { node: 3, slot: "INT" },
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

// ── T2：check 扩容（rules / MISSING_REQUIRED / domain） ──────────────────────

test("check T2：rules 裁剪——单规则 / core 组记号 / 空串回退默认 / 未知规则抛错", () => {
  const only = analyzeGraph(GRAPH, { rules: "dangling" });
  assert.deepStrictEqual(only.rules, ["dangling"]);
  assert.deepStrictEqual(only.issues.map((i) => [i.code, i.node]), [["DANGLING", 30], ["DANGLING", 31]]);
  const core = analyzeGraph(GRAPH, { rules: ["core"] });
  assert.deepStrictEqual(core.issues.map((i) => [i.code, i.node]), [["MUTED_BYPASSED", 12], ["DANGLING", 30], ["DANGLING", 31]]);
  const dflt = analyzeGraph(GRAPH);
  assert.deepStrictEqual(dflt.rules, ["dangling", "output_unwired", "muted_bypassed"]);
  const empty = analyzeGraph(GRAPH, { rules: "" });
  assert.deepStrictEqual(empty.rules, dflt.rules); // 空 = 默认
  assert.deepStrictEqual(empty.issues, dflt.issues);
  assert.throws(() => analyzeGraph(GRAPH, { rules: ["nope"] }), /rules 不支持该规则："nope"/);
  assert.throws(() => analyzeGraph(GRAPH, { rules: 42 }), /rules 需要数组或逗号分隔字符串/);
});

test("check T2：MISSING_REQUIRED——object_info 判定（必填未接/槽缺失/widget 型不报/类型不在 info 跳过/悬空让位）", () => {
  const objectInfo = {
    SizeApply: { input: { required: { width: ["INT"], height: ["INT"], latent: ["LATENT"] } } },
    FooTool: { input: { required: { model: ["MODEL"], opt: ["INT", { forceInput: true }], cfg: ["FLOAT"] } } },
    BarTool: { input: { required: { x: ["LATENT"] } } },
  };
  const g = {
    revision: 5,
    nodes: [
      { id: 8, type: "SizeApply", title: "尺寸", mode: 0,
        inputs: [
          { name: "width", type: "INT", link: 38 },
          { name: "height", type: "INT", link: 39 },
          { name: "latent", type: "LATENT", link: null },
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: [40] }], widgets_values: [] },
      { id: 9, type: "FooTool", title: "", mode: 0,
        inputs: [
          { name: "model", type: "MODEL", link: 41 },
          { name: "opt", type: "INT", link: null },
          { name: "cfg", type: "FLOAT", link: null },
        ],
        outputs: [{ name: "OUT", type: "OUT", links: null }], widgets_values: [] },
      { id: 10, type: "UnknownTool", mode: 0, inputs: [{ name: "z", type: "LATENT", link: 40 }], outputs: [], widgets_values: [] },
    ],
    links: [[38, 27, 0, 8, 0, "INT"], [39, 28, 0, 8, 1, "INT"], [40, 8, 0, 10, 0, "X"], [41, 2, 0, 9, 0, "MODEL"]],
  };
  const r = analyzeGraph(g, { rules: ["missing_required"], objectInfo });
  // #8：latent 未接 → 报（width/height 已接）；#9：opt（forceInput）未接 → 报，cfg 为 widget 型 → 不报，model 已接；
  // #10 类型不在 objectInfo → 跳过
  assert.deepStrictEqual(r.issues.map((i) => [i.code, i.node, i.msg]), [
    ["MISSING_REQUIRED", 8, "必填输入未接：latent"],
    ["MISSING_REQUIRED", 9, "必填输入未接：opt"],
  ]);
  assert.ok(!r.warnings);

  // 槽缺失（连槽都没有）也报
  const g2 = { nodes: [{ id: 1, type: "BarTool", mode: 0, inputs: [], outputs: [{ name: "Y", links: [9] }] }], links: [[9, 1, 0, 2, 0, "X"]] };
  const r2 = analyzeGraph(g2, { rules: ["missing_required"], objectInfo });
  assert.deepStrictEqual(r2.issues.map((i) => [i.code, i.node, i.msg]), [["MISSING_REQUIRED", 1, "必填输入未接：x"]]);
});

test("check T2：MISSING_REQUIRED——无 object_info 跳过 + warning；缺省不启用（不产生 warnings 字段）", () => {
  const r = analyzeGraph(GRAPH, { rules: "all" });
  assert.ok(!r.issues.some((i) => i.code === "MISSING_REQUIRED"));
  assert.deepStrictEqual(r.warnings, ["未提供 object_info，MISSING_REQUIRED 规则已跳过"]);
  const d = analyzeGraph(GRAPH);
  assert.ok(!("warnings" in d));
  assert.ok(!d.issues.some((i) => i.code === "MISSING_REQUIRED"));
  const r2 = analyzeGraph({ nodes: [], links: [] }, { rules: "all", objectInfo: {} });
  assert.strictEqual(r2.issueCount, 0);
  assert.ok(!("warnings" in r2)); // objectInfo 提供（哪怕空）即不告警
});

test("check T2：domain 规则（显式启用）——div16 / steps / save_name / denoise 命中集与固定次序", () => {
  const DOM = {
    revision: 3,
    nodes: [
      { id: 1, type: "EmptyLatentImage", title: "空latent", mode: 0,
        inputs: [
          { name: "width", type: "INT", link: 10 },
          { name: "height", type: "INT", link: null, widget: { name: "height" } },
          { name: "batch_size", type: "INT", link: null, widget: { name: "batch_size" } },
        ],
        outputs: [],
        widgets_values: [512, 1000, 1],
        widgets_values_named: { width: 512, height: 1000, batch_size: 1 } },
      { id: 2, type: "KSampler", title: "采样", mode: 0,
        inputs: [{ name: "model", type: "MODEL", link: null }],
        outputs: [{ name: "LATENT", type: "LATENT", links: [11] }],
        widgets_values: [42, "euler", 300, 7, "euler", "normal", 1.2],
        widgets_values_named: { seed: 42, steps: 300, denoise: 1.2 } },
      { id: 3, type: "SaveImage", title: "保存", mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 11 }],
        outputs: [],
        widgets_values: [""],
        widgets_values_named: { filename_prefix: "" } },
      { id: 4, type: "PrimitiveInt", title: "宽", mode: 0,
        inputs: [], outputs: [{ name: "INT", type: "INT", links: [10] }], widgets_values: [1199] },
    ],
    links: [[10, 4, 0, 1, 0, "INT"], [11, 2, 0, 3, 0, "LATENT"]],
  };
  const r = analyzeGraph(DOM, { rules: "domain" });
  assert.deepStrictEqual(r.rules, ["domain_div16", "domain_steps_range", "domain_save_name", "domain_denoise_range"]);
  assert.deepStrictEqual(r.issues.map((i) => [i.code, i.node, i.msg]), [
    ["DOMAIN_DIV16", 1, "尺寸非 16 的倍数：width=1199、height=1000"],
    ["DOMAIN_STEPS_RANGE", 2, "采样步数超范围：steps=300（应在 1..150）"],
    ["DOMAIN_DENOISE_RANGE", 2, "denoise 超范围：denoise=1.2（应在 0..1）"],
    ["DOMAIN_SAVE_NAME", 3, "保存文件名为空：filename_prefix"],
  ]);
});

test("check T2：domain——连线来源优先（linked 胜于本节点旧 widget；不可判不猜）", () => {
  const g = {
    nodes: [
      { id: 1, type: "EmptyLatentImage", title: "甲", mode: 0,
        inputs: [
          { name: "width", type: "INT", link: 10 },
          { name: "height", type: "INT", link: 11 },
          { name: "batch_size", type: "INT", link: null, widget: { name: "batch_size" } },
        ],
        outputs: [],
        widgets_values: [999, 999, 1],
        widgets_values_named: { width: 999, height: 999, batch_size: 1 } },
      { id: 2, type: "PrimitiveInt", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [10] }], widgets_values: [1024] },
      { id: 3, type: "SomeTool", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [11] }], widgets_values: [] },
    ],
    links: [[10, 2, 0, 1, 0, "INT"], [11, 3, 0, 1, 1, "INT"]],
  };
  // width ← #2 value 1024（16 倍数，不报）；height ← #3 不可判 → 跳过；本节点旧 widget 999 不回退
  const r = analyzeGraph(g, { rules: ["domain_div16"] });
  assert.strictEqual(r.issueCount, 0);
});

test("check T2：domain——与连接性家族共报（悬空 + DIV16；同节点次序=连接先、领域后）", () => {
  const g = {
    revision: 2,
    nodes: [{
      id: 5, type: "EmptyLatentImage", title: "孤块", mode: 0,
      inputs: [], outputs: [],
      widgets_values: [1001, 512, 1],
      widgets_values_named: { width: 1001, height: 512, batch_size: 1 },
    }],
    links: [],
  };
  const r = analyzeGraph(g, { rules: ["dangling", "domain"] });
  assert.deepStrictEqual(r.issues.map((i) => [i.code, i.node]), [["DANGLING", 5], ["DOMAIN_DIV16", 5]]);
});

test("check T2：domain——老序列化位置回退（无 named 的 EmptyLatentImage / KSampler）", () => {
  const g = {
    nodes: [
      { id: 1, type: "EmptyLatentImage", mode: 0, inputs: [], outputs: [{ name: "LATENT", links: [9] }], widgets_values: [768, 431, 1] },
      { id: 2, type: "KSampler", mode: 0, inputs: [{ name: "x", link: 9 }], outputs: [{ name: "LATENT", links: null }], widgets_values: [1, "euler", 0, 7, "euler", "normal", 3] },
    ],
    links: [[9, 1, 0, 2, 0, "LATENT"]],
  };
  const r = analyzeGraph(g, { rules: "domain" });
  assert.deepStrictEqual(r.issues.map((i) => [i.code, i.node, i.msg]), [
    ["DOMAIN_DIV16", 1, "尺寸非 16 的倍数：height=431"],
    ["DOMAIN_STEPS_RANGE", 2, "采样步数超范围：steps=0（应在 1..150）"],
    ["DOMAIN_DENOISE_RANGE", 2, "denoise 超范围：denoise=3（应在 0..1）"],
  ]);
});

test("check T2：semanticRev = s1", () => {
  assert.strictEqual(analyzeGraph(GRAPH).semanticRev, "s1");
});

// ── T2：trace 多级链 ────────────────────────────────────────────────────────

test("trace T2 multi：up 单跳（multi:true 缺省 depth 10）——有序链 + 级字段", () => {
  const r = traceGraph(GRAPH, { node: 8, slot: "width", multi: true });
  assert.deepStrictEqual(r, {
    op: "trace", semanticRev: "s1", dir: "up", query: { node: 8, slot: "width" }, multi: true, depth: 10,
    resolved: "path",
    path: [
      { node: 27, dir: "out", slot: 0, slotName: "INT", value: 1248, symbol: '#27 PrimitiveInt "尺寸·宽" = 1248' },
      { node: 8, dir: "in", slot: 0, slotName: "width", linkId: 38, symbol: '#8 SizeApply "尺寸"' },
    ],
    summary: "#27.INT=1248 → #8.width",
  });
});

test("trace T2 multi：深链——up/down 同链一致 + depth 截断（truncated/note）", () => {
  const CHAIN = {
    revision: 9,
    nodes: [
      { id: 1, type: "Target", title: "终点", mode: 0, inputs: [{ name: "b", type: "INT", link: 2 }], outputs: [], widgets_values: [] },
      { id: 2, type: "Middle", title: "中继", mode: 0, inputs: [{ name: "a", type: "INT", link: 1 }], outputs: [{ name: "OUT", type: "INT", links: [2] }], widgets_values: [] },
      { id: 3, type: "PrimitiveInt", title: "源", mode: 0, inputs: [], outputs: [{ name: "OUT", type: "INT", links: [1] }], widgets_values: [7] },
    ],
    links: [[1, 3, 0, 2, 0, "INT"], [2, 2, 0, 1, 0, "INT"]],
  };
  const up = traceGraph(CHAIN, { node: 1, slot: "b", multi: true });
  assert.deepStrictEqual(up, {
    op: "trace", semanticRev: "s1", dir: "up", query: { node: 1, slot: "b" }, multi: true, depth: 10,
    resolved: "path",
    path: [
      { node: 3, dir: "out", slot: 0, slotName: "OUT", value: 7, symbol: '#3 PrimitiveInt "源" = 7' },
      { node: 2, dir: "in", slot: 0, slotName: "a", linkId: 1, symbol: '#2 Middle "中继"' },
      { node: 2, dir: "out", slot: 0, slotName: "OUT", symbol: '#2 Middle "中继"' },
      { node: 1, dir: "in", slot: 0, slotName: "b", linkId: 2, symbol: '#1 Target "终点"' },
    ],
    summary: "#3.OUT=7 → #2.a → #2.OUT → #1.b",
  });
  const down = traceGraph(CHAIN, { node: 3, slot: "OUT", dir: "down", multi: true });
  assert.deepStrictEqual(down.path, up.path); // 同一链，双向应一致
  assert.strictEqual(down.summary, up.summary);
  const shallow = traceGraph(CHAIN, { node: 1, slot: "b", depth: 1 });
  assert.deepStrictEqual(shallow, {
    op: "trace", semanticRev: "s1", dir: "up", query: { node: 1, slot: "b" }, multi: true, depth: 1,
    resolved: "path",
    path: [
      { node: 2, dir: "out", slot: 0, slotName: "OUT", symbol: '#2 Middle "中继"' },
      { node: 1, dir: "in", slot: 0, slotName: "b", linkId: 2, symbol: '#1 Target "终点"' },
    ],
    summary: "#2.OUT → #1.b",
    truncated: true,
    note: "已达深度上限（depth=1），链可能未到端点",
  });
});

test("trace T2 multi：down 扇出 DFS 槽序 / 无链 none 镜像单步 / 引用缺失计数 / 参数校验", () => {
  const FAN = {
    revision: 5,
    nodes: [
      { id: 1, type: "PrimitiveInt", title: "值", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [10, 11] }], widgets_values: [7] },
      { id: 2, type: "SizeApply", title: "甲", mode: 0, inputs: [{ name: "v", type: "INT", link: 10 }], outputs: [] },
      { id: 3, type: "ImageScale", title: "乙", mode: 0, inputs: [{ name: "v", type: "INT", link: 11 }], outputs: [] },
    ],
    links: [[10, 1, 0, 2, 0, "INT"], [11, 1, 0, 3, 0, "INT"]],
  };
  const r = traceGraph(FAN, { node: 1, slot: "INT", dir: "down", multi: true });
  assert.deepStrictEqual(r.path, [
    { node: 1, dir: "out", slot: 0, slotName: "INT", value: 7, symbol: '#1 PrimitiveInt "值" = 7' },
    { node: 2, dir: "in", slot: 0, slotName: "v", linkId: 10, symbol: '#2 SizeApply "甲"' },
    { node: 3, dir: "in", slot: 0, slotName: "v", linkId: 11, symbol: '#3 ImageScale "乙"' },
  ]);
  // 无链 → 镜像单步 none（含 multi/depth 回显）
  const none = traceGraph(GRAPH, { node: 8, slot: "latent", multi: true });
  assert.strictEqual(none.resolved, "none");
  assert.strictEqual(none.note, "#8.latent 暂无所连来源");
  assert.strictEqual(none.multi, true);
  assert.strictEqual(none.depth, 10);
  // 引用缺失：全部无法解析 → none + 计数
  const g = { revision: 1, nodes: [{ id: 1, type: "PrimitiveInt", mode: 0, inputs: [], outputs: [{ name: "INT", type: "INT", links: [90, 91] }], widgets_values: [1] }], links: [] };
  const m = traceGraph(g, { node: 1, slot: "INT", dir: "down", multi: true });
  assert.strictEqual(m.resolved, "none");
  assert.strictEqual(m.note, "有 2 条引用无法解析（links 表缺失）");
  assert.strictEqual(m.summary, "#1.INT 有 2 条引用无法解析（links 表缺失）");
  // 参数校验
  assert.throws(() => traceGraph(GRAPH, { node: 8, slot: "width", multi: "yes" }), /multi 只能是布尔值/);
  assert.throws(() => traceGraph(GRAPH, { node: 8, slot: "width", depth: 0 }), /depth 需要 1\.\.1000 的整数/);
  assert.throws(() => traceGraph(GRAPH, { node: 8, slot: "width", depth: 2.5 }), /depth 需要 1\.\.1000 的整数/);
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
