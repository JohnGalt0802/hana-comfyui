// lib/validate-workflow.test.mjs — 校验内核测试（node:test，cwd = 仓根）
// fixture：app/lib/fixtures/object-info.sample.json（T1 裁剪形状，真实类样本）
//          app/lib/fixtures/workflows.json（九个工作流：六个规定用例 + 类型不匹配/reroute/API）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateWorkflow } from "./validate-workflow.mjs";

const objectInfo = JSON.parse(readFileSync(new URL("./fixtures/object-info.sample.json", import.meta.url), "utf8"));
const flows = JSON.parse(readFileSync(new URL("./fixtures/workflows.json", import.meta.url), "utf8"));

// 模板 fixture 里的占位 sampler 名换成真实选项（fixture 与真实枚举解耦）
function subgraphFlow() {
  const wf = structuredClone(flows.subgraph);
  const def = wf.definitions.subgraphs[0];
  const ks = def.nodes.find((n) => n.type === "KSampler");
  ks.widgets_values_named.sampler_name = objectInfo.classes.KSampler.enums.sampler_name[0]; // euler
  return wf;
}

test("① 正常小图 EmptyImage → SaveImage：ok:true，无 errors", () => {
  const r = validateWorkflow({ workflow: flows.ok, objectInfo });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 1));
  assert.equal(r.format, "ui");
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.nodeCount, 2);
  assert.equal(r.stats.linkCount, 1);
});

test("② 不存在的节点类型：unknown_type + 正确 node id", () => {
  const r = validateWorkflow({ workflow: flows.unknown, objectInfo });
  assert.equal(r.ok, false);
  const hits = r.errors.filter((v) => v.code === "unknown_type");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  assert.equal(hits[0].node, "3");
  assert.match(hits[0].message, /TotallyFakeNode/);
  assert.equal(r.stats.unknownCount, 1);
});

test("③ 删掉必填连线：missing_required + 节点 id + 字段名", () => {
  const r = validateWorkflow({ workflow: flows.missing_required, objectInfo });
  assert.equal(r.ok, false);
  const hits = r.errors.filter((v) => v.code === "missing_required");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  assert.equal(hits[0].node, "2");
  assert.equal(hits[0].field, "images");
  assert.match(hits[0].message, /images/);
});

test("④ checkpoint 名改成不存在的值：enum_mismatch + suggestions 是真实选项", () => {
  const r = validateWorkflow({ workflow: flows.enum_mismatch, objectInfo });
  assert.equal(r.ok, false);
  const hits = r.errors.filter((v) => v.code === "enum_mismatch");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  assert.equal(hits[0].node, "1");
  assert.equal(hits[0].field, "ckpt_name");
  assert.ok(Array.isArray(hits[0].suggestions) && hits[0].suggestions.length > 0);
  // suggestions 必须来自真实选项表
  assert.ok(objectInfo.classes.CheckpointLoaderSimple.enums.ckpt_name.includes(hits[0].suggestions[0]));
  assert.equal(r.stats.checkedEnums >= 1, true);
});

test("⑤ 带子图的模板结构：展开后不误报，复合 id 可定位", () => {
  const r = validateWorkflow({ workflow: subgraphFlow(), objectInfo });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 1));
  assert.deepEqual(r.errors, []);
  // 展开产物：4 顶层（1 实例被替换）+ 5 内部 = 8 节点；7 内部连线 + 2 外部 = 9
  assert.equal(r.stats.nodeCount, 8);
  assert.equal(r.stats.linkCount, 9);
});

test("⑤b 子图内部节点报错带复合 id（s<实例id>:<内部id>）", () => {
  const wf = subgraphFlow();
  const ks = wf.definitions.subgraphs[0].nodes.find((n) => n.type === "KSampler");
  ks.widgets_values_named.sampler_name = "definitely_not_a_sampler";
  const r = validateWorkflow({ workflow: wf, objectInfo });
  assert.equal(r.ok, false);
  const hits = r.errors.filter((v) => v.code === "enum_mismatch");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  assert.equal(hits[0].node, "s5:15"); // 实例 id 5，内部节点 id 15
  assert.equal(hits[0].field, "sampler_name");
});

test("⑥ 空图（无输出节点）：no_output", () => {
  const r = validateWorkflow({ workflow: flows.no_output, objectInfo });
  assert.equal(r.ok, false);
  const hits = r.errors.filter((v) => v.code === "no_output");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  // 顶层零节点的 UI 图：同样 no_output
  const r2 = validateWorkflow({ workflow: { ...flows.ok, nodes: [], links: [] }, objectInfo });
  assert.ok(r2.errors.some((v) => v.code === "no_output"));
});

test("⑦ 类型不匹配：LATENT 喂 IMAGE 输入 → type_mismatch", () => {
  const r = validateWorkflow({ workflow: flows.type_mismatch, objectInfo });
  const hits = r.errors.filter((v) => v.code === "type_mismatch");
  assert.equal(hits.length, 1, JSON.stringify(r.errors, null, 1));
  assert.equal(hits[0].node, "2");
  assert.equal(hits[0].field, "images");
});

test("⑧ 环绕件 Reroute：无档案报 virtual_node，有 virtual 档案放行", () => {
  const noAdapter = validateWorkflow({ workflow: flows.reroute, objectInfo });
  const hits = noAdapter.errors.filter((v) => v.code === "virtual_node");
  assert.equal(hits.length, 1, JSON.stringify(noAdapter.errors, null, 1));
  assert.equal(hits[0].node, "2");
  const withAdapter = validateWorkflow({ workflow: flows.reroute, objectInfo, adapters: { Reroute: { virtual: true, passthrough: true } } });
  const hits2 = withAdapter.errors.filter((v) => v.code === "virtual_node");
  assert.equal(hits2.length, 0, JSON.stringify(withAdapter.errors, null, 1));
  assert.equal(withAdapter.stats.nodeCount, 3); // Reroute 仍在图里计数，但不再报
});

test("⑨ API 格式：未知类报 unknown_type；无输出节点报 no_output", () => {
  const r = validateWorkflow({ workflow: flows.api, objectInfo });
  assert.equal(r.format, "api");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((v) => v.code === "unknown_type" && v.node === "6"));
  assert.ok(r.errors.some((v) => v.code === "no_output"));
  assert.equal(r.stats.nodeCount, 3);
});

test("⑨b API 格式 + 缺 output_node 信息：no_output 降为 warning，不静默通过", () => {
  // classes 表里没有任何 output_node 字段（T1 裁剪结构未带）→ 无法判定，只能 warning。
  const apiWf = {
    "1": { class_type: "KSampler", inputs: {} },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };
  const noOutputInfo = {
    classes: {
      KSampler: { required: {}, optional: {}, outputs: [] },
      SaveImage: { required: {}, optional: {}, outputs: [] },
    },
  };
  const r = validateWorkflow({ workflow: apiWf, objectInfo: noOutputInfo });
  assert.equal(r.format, "api");
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 1));
  assert.equal(r.errors.filter((v) => v.code === "no_output").length, 0, "拿不到信息时不应硬报错");
  const hits = r.warnings.filter((v) => v.code === "no_output");
  assert.equal(hits.length, 1, JSON.stringify(r.warnings, null, 1));
  assert.equal(hits[0].node, null);
  assert.match(hits[0].message, /output_node/);
  assert.equal(r.stats.nodeCount, 2);
});

test("⑩ 纯健壮性：坏输入不抛异常，统一 internal 错误", () => {
  for (const bad of [null, {}, { workflow: null }, { workflow: { nodes: [] }, objectInfo: null }, { workflow: { nodes: [] }, objectInfo: { classes: {} } }]) {
    const r = validateWorkflow(bad);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, "internal");
    assert.deepEqual(Object.keys(r).sort(), ["errors", "format", "ok", "stats", "warnings"]);
  }
  // workflow 本身抛异常的（冻结文件 throw）也接住
  const r = validateWorkflow({ workflow: { nodes: "not-an-array" }, objectInfo });
  assert.equal(r.errors[0].code, "internal");
});
