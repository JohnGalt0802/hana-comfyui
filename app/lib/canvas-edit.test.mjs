// app/lib/canvas-edit.test.mjs — 文件版 patch 编辑引擎单测（自含 · 零依赖）
// 运行：node app/lib/canvas-edit.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import {
  parseFilePatchEdits,
  applyFilePatch,
  scanStructuralProblems,
  diffStructuralProblems,
} from "./canvas-edit.mjs";

// ── 合成样本图（前端序列化风格：widget 占位槽 / wv+named 双写 / links 6 元 / groups）──
function makeGraph() {
  return {
    id: "t1-fixture",
    revision: 3,
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
        inputs: [
          { name: "width", type: "INT", link: 38 },
          { name: "height", type: "INT", link: null },
          { name: "latent", type: "LATENT", link: null },
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        properties: { "Node name for S&R": "SizeApply" },
        widgets_values: [], widgets_values_named: {} },
      { id: 12, type: "KSampler", pos: [700, 100], size: [315, 262], flags: {}, order: 3, mode: 0,
        inputs: [
          { name: "model", type: "MODEL", link: null },
          { name: "seed", type: "INT", widget: { name: "seed" }, link: null },
          { name: "steps", type: "INT", widget: { name: "steps" }, link: null },
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        properties: { "Node name for S&R": "KSampler" },
        widgets_values: [42, "randomize", 20],
        widgets_values_named: { seed: 42, control_after_generate: "randomize", steps: 20 } },
    ],
    links: [[38, 2, 0, 8, 0, "INT"]],
    groups: [{ id: 1, title: "块A", bounding: [80, 80, 600, 260], flags: {} }],
  };
}

const OBJ_INFO = {
  PrimitiveInt: {
    input: { required: { value: ["INT", { default: 1, min: 0, max: 1e9 }] } },
    output: ["INT"], output_name: ["INT"],
  },
  KSampler: {
    input: { required: {
      model: ["MODEL"],
      seed: ["INT", { default: 0 }],
      steps: ["INT", { default: 20 }],
      cfg: ["FLOAT", { default: 8 }],
      sampler_name: [["euler", "ddim"], { default: "euler" }],
      denoise: ["FLOAT", { default: 1 }],
    } },
    output: ["LATENT"], output_name: ["LATENT"],
  },
  LoadImage: {
    input: { required: { image: [["a.png", "b.png"], { default: "a.png", image_upload: true }] } },
    output: ["IMAGE", "MASK"], output_name: ["IMAGE", "MASK"],
  },
};

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.message}`);
  }
}
function parse1(obj) { return parseFilePatchEdits([obj]); }
function apply1(graph, obj, opts) { return applyFilePatch(graph, parse1(obj), opts); }

console.log("== canvas-edit.mjs 单测 ==");

// ── 1. parse（结构预检）────────────────────────────────────────────────────
console.log("-- parseFilePatchEdits --");
test("非数组 / 空数组 → 报错", () => {
  assert.throws(() => parseFilePatchEdits(null), /需要 edits/);
  assert.throws(() => parseFilePatchEdits([]), /需要 edits/);
});
test("每对象恰一个 key", () => {
  assert.throws(() => parseFilePatchEdits([{ a: {}, b: {} }]), /恰好一个 key/);
  assert.throws(() => parseFilePatchEdits(["x"]), /必须是对象/);
});
test("未知 edit / 拒绝名单", () => {
  assert.throws(() => parseFilePatchEdits([{ frobnicate: {} }]), /未知 edit/);
  assert.throws(() => parseFilePatchEdits([{ undo: {} }]), /明确拒绝 "undo"/);
  assert.throws(() => parseFilePatchEdits([{ openWorkflow: {} }]), /明确拒绝 "openWorkflow"/);
});
test("save 仅限最后一条、且不接受参数", () => {
  assert.throws(() => parseFilePatchEdits([{ save: {} }, { setNodeMode: { nodeId: 3, mode: 2 } }]), /save 只能作为最后一条/);
  assert.throws(() => parseFilePatchEdits([{ save: { name: "x" } }]), /不接受参数/);
  assert.doesNotThrow(() => parseFilePatchEdits([{ setNodeMode: { nodeId: 3, mode: 2 } }, { save: {} }]));
});
test("as 仅 addNode；$ 语法", () => {
  assert.throws(() => parseFilePatchEdits([{ setWidget: { nodeId: "$w", name: "value", as: "x" } }]), /as 仅 addNode/);
  assert.throws(() => parseFilePatchEdits([{ connect: { fromNode: "$", toNode: 8 } }]), /非法引用/);
});
test("addGroup 校验：title 必填；bounds 4 数字", () => {
  assert.throws(() => parseFilePatchEdits([{ addGroup: {} }]), /addGroup 需要 title/);
  assert.throws(() => parseFilePatchEdits([{ addGroup: { title: "x", bounds: [1, 2, 3] } }]), /四个数字/);
  assert.doesNotThrow(() => parseFilePatchEdits([{ addGroup: { title: "x", bounds: [1, 2, 3, 4] } }]));
});
test("setGroup 定位与变更规则", () => {
  assert.throws(() => parseFilePatchEdits([{ setGroup: {} }]), /需要 index/);
  assert.throws(() => parseFilePatchEdits([{ setGroup: { index: 0 } }]), /没有可变更内容/);
  assert.throws(() => parseFilePatchEdits([{ setGroup: { title: "A" } }]), /title 定位时没有可变更字段/);
  assert.throws(() => parseFilePatchEdits([{ setGroup: { index: -1, title: "x" } }]), /≥0 的整数/);
  assert.doesNotThrow(() => parseFilePatchEdits([{ setGroup: { index: 0, title: "新名" } }]));
  assert.doesNotThrow(() => parseFilePatchEdits([{ setGroup: { index: 0, nodeIds: [2] } }]));
  assert.doesNotThrow(() => parseFilePatchEdits([{ setGroup: { title: "旧名", nodeIds: [2] } }]));
});
test("removeGroup / cloneNodes 校验", () => {
  assert.throws(() => parseFilePatchEdits([{ removeGroup: {} }]), /removeGroup 需要/);
  assert.throws(() => parseFilePatchEdits([{ cloneNodes: {} }]), /cloneNodes 需要 nodeIds/);
  assert.throws(() => parseFilePatchEdits([{ cloneNodes: { nodeIds: [2], offset: [1, 1], position: [2, 2] } }]), /二选一/);
  assert.throws(() => parseFilePatchEdits([{ cloneNodes: { nodeIds: [2], offset: [1] } }]), /两个数字/);
  assert.doesNotThrow(() => parseFilePatchEdits([{ cloneNodes: { nodeIds: [2, 3] } }]));
});

// ── 2. 基础 edit ───────────────────────────────────────────────────────────
console.log("-- applyFilePatch：基础 edit --");
test("setWidget：named 键序定位 + wv 同步双写；原图不动", () => {
  const g = makeGraph();
  const snapshot = JSON.stringify(g);
  const r = apply1(g, { setWidget: { nodeId: 12, name: "steps", value: 30 } });
  assert.equal(r.ok, true);
  const n = r.graph.nodes.find((x) => x.id === 12);
  assert.equal(n.widgets_values_named.steps, 30);
  assert.equal(n.widgets_values[2], 30);
  assert.equal(JSON.stringify(g), snapshot, "原图应保持不变");
  const res = r.results[0].result;
  assert.equal(res.before, 20);
  assert.equal(res.after, 30);
  assert.equal(res.position, 2);
});
test("setWidget：无 named 节点（旧格式）pos>0 成功——重建完整 named 后双写（M1）", () => {
  const g = makeGraph();
  g.nodes.push({ id: 11, type: "OldKSampler", pos: [0, 300], size: [210, 100], flags: {}, order: 9, mode: 0,
    inputs: [{ name: "seed", type: "INT", widget: { name: "seed" }, link: null },
             { name: "steps", type: "INT", widget: { name: "steps" }, link: null }],
    outputs: [], properties: {}, widgets_values: [42, "randomize", 20] });
  const r = apply1(g, { setWidget: { nodeId: 11, name: "steps", value: 30 } });
  assert.equal(r.ok, true, r.failedAt && r.failedAt.reason);
  const n = r.graph.nodes.find((x) => x.id === 11);
  assert.deepEqual(n.widgets_values, [42, "randomize", 30]);
  assert.deepEqual(n.widgets_values_named, { seed: 42, control_after_generate: "randomize", steps: 30 });
  assert.deepEqual(Object.keys(n.widgets_values_named), ["seed", "control_after_generate", "steps"], "重建后键序=位置序");
  assert.equal(r.results[0].result.position, 2);
  assert.equal(r.results[0].result.before, 20);
});
test("setWidget：有 named 节点行为不回归（position/before/键序）", () => {
  const g = makeGraph();
  const r = apply1(g, { setWidget: { nodeId: 12, name: "steps", value: 44 } });
  assert.equal(r.ok, true);
  const n = r.graph.nodes.find((x) => x.id === 12);
  assert.equal(n.widgets_values[2], 44);
  assert.equal(n.widgets_values_named.steps, 44);
  assert.deepEqual(Object.keys(n.widgets_values_named), ["seed", "control_after_generate", "steps"]);
  assert.equal(r.results[0].result.before, 20);
  assert.equal(r.results[0].result.position, 2);
});
test("setWidget：不存在的参数名 → 失败并提示可用名", () => {
  const r = apply1(makeGraph(), { setWidget: { nodeId: 12, name: "nope", value: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.failedAt.reason, /没有名为 nope 的参数/);
  assert.match(r.failedAt.reason, /control_after_generate/);
});
test("addNode：objectInfo 构建（含 seed 副值规则）", () => {
  const r = apply1(makeGraph(), { addNode: { type: "KSampler", pos: [10, 20], title: "新采样", as: "k" } }, { objectInfo: OBJ_INFO });
  assert.equal(r.ok, true);
  const n = r.graph.nodes.find((x) => x.type === "KSampler" && x.id !== 12);
  assert.equal(n.id, 13);
  assert.equal(n.title, "新采样");
  assert.deepEqual(n.pos, [10, 20]);
  assert.deepEqual(n.widgets_values.slice(1, 4), ["randomize", 20, 8]); // seed 副值 + steps + cfg
  assert.equal(n.widgets_values_named.control_after_generate, "randomize");
  assert.equal(n.widgets_values_named.sampler_name, "euler");
  assert.equal(r.graph.last_node_id, 13);
  assert.equal(r.results[0].result.via, "object_info");
});
test("addNode：无 objectInfo → 模板降级（值复制与 note）", () => {
  const r = apply1(makeGraph(), { addNode: { type: "PrimitiveInt" } });
  assert.equal(r.ok, true);
  const res = r.results[0].result;
  assert.equal(res.via, "template");
  assert.equal(res.templateNode, 2);
  const n = r.graph.nodes.find((x) => x.id === res.nodeId);
  assert.deepEqual(n.widgets_values_named, { value: 768, fixed: "fixed" });
  assert.equal(n.title, undefined);
});
test("addNode：无 objectInfo 且无同型节点 → 失败（零变更）", () => {
  const g = makeGraph();
  const r = apply1(g, { addNode: { type: "NoSuchType" } });
  assert.equal(r.ok, false);
  assert.match(r.failedAt.reason, /object_info 不可达/);
  assert.equal(g.nodes.length, 4);
});
test("connect：新建 + 直替（replaced）", () => {
  const r = apply1(makeGraph(), { connect: { fromNode: 3, fromSlot: "INT", toNode: 8, toSlot: "width" } });
  assert.equal(r.ok, true);
  const res = r.results[0].result;
  assert.equal(res.replaced, 38, "原连线被顶替");
  assert.equal(res.linkId, 41);
  assert.equal(r.graph.links.length, 1);
  const row = r.graph.links[0];
  assert.deepEqual(row, [41, 3, 0, 8, 0, "INT"]);
  const n2 = r.graph.nodes.find((x) => x.id === 2);
  assert.equal(n2.outputs[0].links === null || n2.outputs[0].links.length === 0, true, "旧源 links 应清理");
});
test("connect：槽不存在 → 失败并列可用槽", () => {
  const r = apply1(makeGraph(), { connect: { fromNode: 2, fromSlot: "NOPE", toNode: 8, toSlot: "width" } });
  assert.equal(r.ok, false);
  assert.match(r.failedAt.reason, /输出槽不存在/);
});
test("disconnect：断开并清理两侧引用", () => {
  const r = apply1(makeGraph(), { disconnect: { nodeId: 8, slot: "width" } });
  assert.equal(r.ok, true);
  assert.equal(r.graph.links.length, 0);
  const n8 = r.graph.nodes.find((x) => x.id === 8);
  assert.equal(n8.inputs[0].link, null);
  const n2 = r.graph.nodes.find((x) => x.id === 2);
  assert.deepEqual(n2.outputs[0].links, []);
});
test("disconnect：本来没有连线 → 失败", () => {
  const r = apply1(makeGraph(), { disconnect: { nodeId: 8, slot: "height" } });
  assert.equal(r.ok, false);
  assert.match(r.failedAt.reason, /本来就没有连线/);
});
test("setNodeMode：0/2/4 校验", () => {
  const r = apply1(makeGraph(), { setNodeMode: { nodeId: 3, mode: 4 } });
  assert.equal(r.ok, true);
  assert.equal(r.graph.nodes.find((x) => x.id === 3).mode, 4);
  assert.equal(r.results[0].result.before, 0);
  const bad = apply1(makeGraph(), { setNodeMode: { nodeId: 3, mode: 1 } });
  assert.equal(bad.ok, false);
});
test("removeNode：移除入线出线", () => {
  const r = apply1(makeGraph(), { removeNode: { nodeId: 8 } });
  assert.equal(r.ok, true);
  assert.equal(r.graph.nodes.length, 3);
  assert.equal(r.graph.links.length, 0);
  assert.equal(r.results[0].result.incomingLinks, 1);
  assert.equal(r.results[0].result.outgoingLinks, 0);
});
test("$ 引用链：addNode as → setWidget → connect；as 重名拒绝", () => {
  const r = applyFilePatch(makeGraph(), parseFilePatchEdits([
    { addNode: { type: "PrimitiveInt", as: "w", pos: [0, 0] } },
    { setWidget: { nodeId: "$w", name: "value", value: 1024 } },
    { connect: { fromNode: "$w", fromSlot: "INT", toNode: 8, toSlot: "height" } },
  ]));
  assert.equal(r.ok, true);
  const wId = r.results[0].result.nodeId;
  const row = r.graph.links.find((x) => Number(x[3]) === 8 && Number(x[4]) === 1);
  assert.ok(row, "新连线应指向 #8.height");
  assert.equal(Number(row[1]), Number(wId));
  const dup = applyFilePatch(makeGraph(), parseFilePatchEdits([
    { addNode: { type: "PrimitiveInt", as: "w" } },
    { addNode: { type: "PrimitiveInt", as: "w" } },
  ]));
  assert.equal(dup.ok, false);
  assert.match(dup.failedAt.reason, /as 重名/);
});
test("未定义 $ → 失败（零残留）", () => {
  const r = apply1(makeGraph(), { setWidget: { nodeId: "$ghost", name: "value", value: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.failedAt.reason, /未定义的引用/);
});
test("多步链中途失败 → ok:false 且 results 只列已成功条", () => {
  const r = applyFilePatch(makeGraph(), parseFilePatchEdits([
    { setNodeMode: { nodeId: 3, mode: 2 } },
    { setWidget: { nodeId: 999, name: "value", value: 1 } },
    { setNodeMode: { nodeId: 2, mode: 2 } },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.failedAt.index, 1);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].index, 0);
});

// ── 3. 组操作 ──────────────────────────────────────────────────────────────
console.log("-- applyFilePatch：组操作 --");
test("addGroup：显式 bounds", () => {
  const r = apply1(makeGraph(), { addGroup: { title: "新组", bounds: [0, 0, 300, 200] } });
  assert.equal(r.ok, true);
  const g = r.graph.groups[1];
  assert.equal(g.id, 2);
  assert.deepEqual(g.bounding, [0, 0, 300, 200]);
  assert.deepEqual(r.results[0].result, { index: 1, id: 2, title: "新组", bounding: [0, 0, 300, 200] });
});
test("addGroup：nodeIds 自动 bounds（含 PAD=20）", () => {
  const r = apply1(makeGraph(), { addGroup: { title: "包住 2/3", nodeIds: [2, 3] } });
  assert.equal(r.ok, true);
  // 节点 2: [100,100]+[210,58]；节点 3: [100,200]+[210,58] → 外扩 20
  assert.deepEqual(r.graph.groups[1].bounding, [80, 80, 250, 198]);
});
test("addGroup：缺省 bounds [0,0,200,100]；nodeIds 不存在 → 失败", () => {
  const r = apply1(makeGraph(), { addGroup: { title: "空组" } });
  assert.deepEqual(r.graph.groups[1].bounding, [0, 0, 200, 100]);
  const bad = apply1(makeGraph(), { addGroup: { title: "x", nodeIds: [999] } });
  assert.equal(bad.ok, false);
});
test("setGroup：index 定位 + 改名", () => {
  const r = apply1(makeGraph(), { setGroup: { index: 0, title: "改名后" } });
  assert.equal(r.ok, true);
  assert.equal(r.graph.groups[0].title, "改名后");
  assert.equal(r.results[0].result.changed.title.before, "块A");
});
test("setGroup：title 定位 + nodeIds 重算 bounds", () => {
  const r = apply1(makeGraph(), { setGroup: { title: "块A", nodeIds: [8] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.graph.groups[0].bounding, [380, 80, 280, 120]);
});
test("setGroup：title 重名 → 报错要求 index；index 越界 → 报错", () => {
  const g = makeGraph();
  g.groups.push({ id: 2, title: "块A", bounding: [0, 0, 10, 10] });
  const dup = apply1(g, { setGroup: { title: "块A", nodeIds: [2] } });
  assert.equal(dup.ok, false);
  assert.match(dup.failedAt.reason, /无法唯一定位/);
  const oob = apply1(makeGraph(), { setGroup: { index: 5, title: "x" } });
  assert.equal(oob.ok, false);
  assert.match(oob.failedAt.reason, /越界/);
});
test("removeGroup：index / title 两路 + 返回摘要", () => {
  const r1 = apply1(makeGraph(), { removeGroup: { index: 0 } });
  assert.equal(r1.ok, true);
  assert.equal(r1.graph.groups.length, 0);
  assert.equal(r1.results[0].result.title, "块A");
  const r2 = apply1(makeGraph(), { removeGroup: { title: "块A" } });
  assert.equal(r2.ok, true);
  assert.equal(r2.graph.groups.length, 0);
  const miss = apply1(makeGraph(), { removeGroup: { title: "不存在" } });
  assert.equal(miss.ok, false);
});

// ── 4. cloneNodes ──────────────────────────────────────────────────────────
console.log("-- applyFilePatch：cloneNodes --");
test("cloneNodes：节点+内部连线+widgets 值；id 映射与分配器", () => {
  const g = makeGraph();
  // 给 2→3 造一条内部连线，方便验证复制
  g.links.push([39, 2, 0, 3, 0, "INT"]);
  g.nodes.find((x) => x.id === 3).inputs[0].link = 39;
  g.nodes.find((x) => x.id === 2).outputs[0].links.push(39);
  const r = applyFilePatch(g, parseFilePatchEdits([{ cloneNodes: { nodeIds: [2, 3, 8] } }]));
  assert.equal(r.ok, true);
  const res = r.results[0].result;
  assert.deepEqual(res.mapping, { "2": 13, "3": 14, "8": 15 });
  assert.equal(res.count, 3);
  assert.equal(res.copiedLinks, 2, "2→8 与 2→3 两条内部连线都复制");
  assert.equal(r.graph.nodes.length, 7);
  // 新连线：13→15（宽度）与 13→14
  const l1 = r.graph.links.find((x) => Number(x[1]) === 13 && Number(x[3]) === 15);
  assert.ok(l1 && l1[5] === "INT");
  const l2 = r.graph.links.find((x) => Number(x[1]) === 13 && Number(x[3]) === 14);
  assert.ok(l2);
  // 原连线仍在
  assert.equal(r.graph.links.length, 4);
  // widgets 值复制、位置平移默认 [40,40]、order 递增
  const c2 = r.graph.nodes.find((x) => x.id === 13);
  assert.deepEqual(c2.pos, [140, 140]);
  assert.equal(c2.widgets_values_named.value, 768);
  assert.equal(c2.order, 4);
  // 新节点引用：13 的输出 links 有两条新线
  assert.equal(c2.outputs[0].links.length, 2);
  // last ids 更新
  assert.equal(r.graph.last_node_id, 15);
  assert.equal(r.graph.last_link_id, 42);
});
test("cloneNodes：外部连线不复制；offset 显式", () => {
  const g = makeGraph();
  // 8 的 width 来自 2（2 不在选中集）
  const r = applyFilePatch(g, parseFilePatchEdits([{ cloneNodes: { nodeIds: [8], offset: [10, -5] } }]));
  assert.equal(r.ok, true);
  const res = r.results[0].result;
  assert.equal(res.copiedLinks, 0);
  const cp = r.graph.nodes.find((x) => x.id === Number(res.mapping["8"]));
  assert.deepEqual(cp.pos, [410, 95]);
  assert.equal(cp.inputs[0].link, null, "外部入线不复制");
});
test("cloneNodes：position 使块左上角对齐目标坐标", () => {
  const r = applyFilePatch(makeGraph(), parseFilePatchEdits([{ cloneNodes: { nodeIds: [2, 3], position: [1000, 2000] } }]));
  assert.equal(r.ok, true);
  const c2 = r.graph.nodes.find((x) => x.id === 13);
  const c3 = r.graph.nodes.find((x) => x.id === 14);
  assert.deepEqual(c2.pos, [1000, 2000]);
  assert.deepEqual(c3.pos, [1000, 2100]);
});
test("cloneNodes：重复/不存在 nodeIds → 失败", () => {
  const dup = applyFilePatch(makeGraph(), parseFilePatchEdits([{ cloneNodes: { nodeIds: [2, 2] } }]));
  assert.equal(dup.ok, false);
  assert.match(dup.failedAt.reason, /重复项/);
  const miss = applyFilePatch(makeGraph(), parseFilePatchEdits([{ cloneNodes: { nodeIds: [2, 999] } }]));
  assert.equal(miss.ok, false);
  assert.match(miss.failedAt.reason, /找不到节点/);
});

// ── 5. 结构自检 ────────────────────────────────────────────────────────────
console.log("-- scanStructuralProblems / diff --");
test("干净图 0 问题", () => {
  assert.deepEqual(scanStructuralProblems(makeGraph()), []);
});
test("悬空输入引用被检出", () => {
  const g = makeGraph();
  g.nodes.find((x) => x.id === 8).inputs[0].link = null;
  assert.equal(scanStructuralProblems(g).length, 0, "正常断线不是问题");
  g.nodes.find((x) => x.id === 8).inputs[0].link = 77; // 悬空
  const ps = scanStructuralProblems(g);
  assert.equal(ps.length, 1);
  assert.match(ps[0].detail, /引用的 link 77 不在 links 表/);
});
test("输出槽 links 悬空被检出", () => {
  const g = makeGraph();
  g.nodes.find((x) => x.id === 2).outputs[0].links.push(999);
  const ps = scanStructuralProblems(g);
  assert.equal(ps.length, 1);
  assert.match(ps[0].detail, /links 未含该 link|引用的 link 999/);
});
test("diff：只报新增问题", () => {
  const before = scanStructuralProblems(makeGraph());
  const g2 = makeGraph();
  g2.nodes.find((x) => x.id === 8).inputs[0].link = 77;
  const after = scanStructuralProblems(g2);
  const d = diffStructuralProblems(before, after);
  assert.equal(d.length, 1);
});
test("verify 语义：patch 前后无新增结构问题（正常链）", () => {
  const g = makeGraph();
  const before = scanStructuralProblems(g);
  const r = applyFilePatch(g, parseFilePatchEdits([
    { disconnect: { nodeId: 8, slot: "width" } },
    { connect: { fromNode: 3, fromSlot: "INT", toNode: 8, toSlot: "width" } },
    { addGroup: { title: "g", nodeIds: [2, 3] } },
  ]));
  assert.equal(r.ok, true);
  assert.equal(diffStructuralProblems(before, scanStructuralProblems(r.graph)).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
