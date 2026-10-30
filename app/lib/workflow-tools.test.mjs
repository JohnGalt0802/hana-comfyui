// app/lib/workflow-tools.test.mjs — UI→API 转换：放宽（动态槽 / 自定义 widget 类型）但保住该拒的
// 运行：node --test app/lib/workflow-tools.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { convertUiToApi } from "./workflow-tools.mjs";

// 类型不在 /object_info 之外都能过的最小 object_info
const OBJ = {
  TriggerWordToggle: { input: { required: { toggle: ["BOOLEAN", {}] } } },
  LoraManager: { input: { required: { loras: ["AUTOCOMPLETE_TEXT_LORAS", {}], strength: ["FLOAT", {}] } } },
  LoadImage: { input: { required: { image: [["a.png", "b.png"], {}] } } },
  Grow: { input: { required: { values: ["STRING", {}] } } },
  SRC: { input: {} }, // 无输入的上游节点（供连线 origin 指向）
};

// ── 一、必拒：6 类 ──────────────────────────────────────────────────────────

test("拒绝：缺 nodes 数组", () => {
  assert.throws(() => convertUiToApi({ links: [] }, OBJ), /不是 UI 格式工作流/);
});

test("拒绝：静音 / 旁路节点", () => {
  for (const mode of [2, 4]) {
    assert.throws(
      () => convertUiToApi({ nodes: [{ id: 1, type: "LoraManager", mode, inputs: [] }], links: [] }, OBJ),
      /静音\/旁路/,
    );
  }
});

test("拒绝：子图 / 环绕节点类型", () => {
  assert.throws(
    () => convertUiToApi({ nodes: [{ id: 1, type: "Reroute", inputs: [] }], links: [] }, OBJ),
    /子图\/环绕节点/,
  );
  // 20 位以上十六进制 uuid 形态的子图类型
  assert.throws(
    () => convertUiToApi({ nodes: [{ id: 2, type: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", inputs: [] }], links: [] }, OBJ),
    /子图\/环绕节点/,
  );
});

test("拒绝：类型不在 /object_info", () => {
  assert.throws(
    () => convertUiToApi({ nodes: [{ id: 1, type: "NopeNode", inputs: [] }], links: [] }, OBJ),
    /不在 \/object_info/,
  );
});

test("拒绝：声明槽的连线缺失（link 找不到）", () => {
  assert.throws(
    () =>
      convertUiToApi(
        { nodes: [{ id: 1, type: "TriggerWordToggle", inputs: [{ name: "toggle", link: 77, type: "BOOLEAN" }] }], links: [] },
        OBJ,
      ),
    /连线缺失/,
  );
});

test("拒绝：R1 named 与位置值分歧", () => {
  assert.throws(
    () =>
      convertUiToApi(
        { nodes: [{ id: 1, type: "LoadImage", inputs: [], widgets_values_named: { image: "b.png" }, widgets_values: ["a.png"] }], links: [] },
        OBJ,
      ),
    /分歧/,
  );
});

// ── 二、必放行：2 类 ────────────────────────────────────────────────────────

const dynamicSlotWf = {
  nodes: [
    { id: 5, type: "SRC", inputs: [] },
    {
      id: 7,
      type: "TriggerWordToggle",
      inputs: [{ name: "Lora1", link: 3, type: "*" }],
      widgets_values_named: { toggle: true },
      widgets_values: [],
    },
  ],
  links: [[3, 5, 0, 7, 0, "MODEL"]],
};

test("放行：未声明槽 + 有效连线（宽模式收编，仅 warning）", () => {
  const warnings = [];
  const out = convertUiToApi(dynamicSlotWf, OBJ, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(out["7"].inputs.Lora1, ["5", 0]);
  assert.equal(out["7"].inputs.toggle, true); // 声明 widget 照旧注入
  assert.equal(warnings.length, 1);
  // 文案必须中性：宽模式下收编，strict 下拒绝，同一句话不能自相矛盾
  assert.match(warnings[0], /不对应任何声明输入/);
  assert.doesNotMatch(warnings[0], /已按连线原样收编|已收编/);
});

test("放行：AUTOCOMPLETE_TEXT_LORAS 在 named 里有值时被注入", () => {
  const out = convertUiToApi(
    {
      nodes: [
        {
          id: 12,
          type: "LoraManager",
          inputs: [],
          widgets_values_named: { loras: "loraA.safetensors, loraB.safetensors", strength: 0.8 },
          widgets_values: [],
        },
      ],
      links: [],
    },
    OBJ,
  );
  assert.equal(out["12"].inputs.loras, "loraA.safetensors, loraB.safetensors");
  assert.equal(out["12"].inputs.strength, 0.8);
});

// 关键变异守卫（位置回退分支）：named 分支不看 WIDGET_SPEC_TYPES，白名单只活在位置回退这条路上；
// 一旦有人把 "AUTOCOMPLETE_TEXT_LORAS" 从 WIDGET_SPEC_TYPES 摘掉，本用例必须变红。
// 后果不是「少一个字段」而是整体错位：loras 那格不占位，widgets_values[0] 的字符串会溢到 strength 上。
test("放行：无 named 时位置回退仍能给 AUTOCOMPLETE_TEXT_LORAS 占位（不错位）", () => {
  const out = convertUiToApi(
    { nodes: [{ id: 13, type: "LoraManager", inputs: [], widgets_values: ["a.safetensors", 0.8] }], links: [] },
    OBJ,
  );
  const inputs = out["13"].inputs;
  assert.equal(inputs.loras, "a.safetensors");
  assert.equal(inputs.strength, 0.8);
  assert.equal(typeof inputs.strength, "number", "strength 必须是数值 0.8，不能吃到 loras 的字符串（位置错位）");
  assert.deepEqual(Object.keys(inputs).sort(), ["loras", "strength"]);
});

test("放行后返回结构不变（class_type / inputs / 可选 _meta）", () => {
  const out = convertUiToApi(dynamicSlotWf, OBJ);
  assert.deepEqual(Object.keys(out["7"]).sort(), ["class_type", "inputs"]);
  assert.equal(out["7"].class_type, "TriggerWordToggle");
  const titled = convertUiToApi(
    { nodes: [{ id: 9, type: "LoraManager", title: "LORA", inputs: [], widgets_values_named: { strength: 0.5 }, widgets_values: [] }], links: [] },
    OBJ,
  );
  assert.deepEqual(titled["9"]._meta, { title: "LORA" });
});

// ── 三、strict 与 options 容错 ──────────────────────────────────────────────

test("strict:true 时上面的放行样本必须 throw（且原因要说对）", () => {
  assert.throws(
    () => convertUiToApi(dynamicSlotWf, OBJ, { strict: true }),
    (e) => /不支持的构造/.test(e.message) && /Lora1/.test(e.message) && /动态输入槽/.test(e.message),
    "strict 抛错必须点名节点 #7 的 Lora1 动态槽，不能只是外壳文案",
  );
  // strict 下两参调用与 strict:false 都不 throw
  assert.doesNotThrow(() => convertUiToApi(dynamicSlotWf, OBJ));
  assert.doesNotThrow(() => convertUiToApi(dynamicSlotWf, OBJ, { strict: false }));
});

test("options 传 null / 非对象不炸（按默认非 strict 处理）", () => {
  for (const options of [null, undefined, "x", 0, [], () => {}]) {
    assert.doesNotThrow(() => convertUiToApi(dynamicSlotWf, OBJ, options));
  }
  // onWarning 非函数时忽略
  assert.doesNotThrow(() => convertUiToApi(dynamicSlotWf, OBJ, { onWarning: "not-a-fn" }));
});

test("onWarning 回调抛异常不影响转换结果", () => {
  const out = convertUiToApi(dynamicSlotWf, OBJ, {
    onWarning: () => {
      throw new Error("回调崩了");
    },
  });
  assert.deepEqual(out["7"].inputs.Lora1, ["5", 0]);
});

// ── 四、本次新增防线：降级分支 origin 存在性 ────────────────────────────────

test("拒绝：动态槽连线 origin 指向不存在的节点", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [{ id: 1, type: "TriggerWordToggle", inputs: [{ name: "Lora1", link: 3, type: "*" }], widgets_values_named: {}, widgets_values: [] }],
          links: [[3, 404, 0, 1, 0, "MODEL"]],
        },
        OBJ,
      ),
    /不在工作流节点内/,
  );
});

test("拒绝：动态槽连线 origin 指向 Note 节点", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [
            { id: 1, type: "TriggerWordToggle", inputs: [{ name: "Lora1", link: 3, type: "*" }], widgets_values_named: {}, widgets_values: [] },
            { id: 2, type: "Note", inputs: [], widgets_values: ["备注"] },
          ],
          links: [[3, 2, 0, 1, 0, "MODEL"]],
        },
        OBJ,
      ),
    /不在工作流节点内/,
  );
});

test("拒绝：动态槽无名（无法作 API 键）", () => {
  assert.throws(
    () =>
      convertUiToApi(
        { nodes: [{ id: 1, type: "TriggerWordToggle", inputs: [{ name: "", link: 3, type: "*" }] }], links: [[3, 5, 0, 1, 0, "MODEL"]] },
        OBJ,
      ),
    /（无名）/,
  );
});

// ── 五、回归：既有路径没被放宽带歪 ──────────────────────────────────────────

test("回归：autogrow 子槽（declared 前缀）仍走原路径且不产生 warning", () => {
  const warnings = [];
  const out = convertUiToApi(
    { nodes: [{ id: 6, type: "Grow", inputs: [{ name: "values.a", link: 1, type: "STRING" }], widgets_values_named: {}, widgets_values: [] }], links: [[1, 9, 0, 6, 0, "STRING"]] },
    OBJ,
    { onWarning: (w) => warnings.push(w) },
  );
  assert.deepEqual(out["6"].inputs["values.a"], ["9", 0]);
  assert.equal(warnings.length, 0);
});

test("回归：named 分支跳过 socket 类型，未知类型默认按 widget 注入", () => {
  const out = convertUiToApi(
    {
      nodes: [{ id: 5, type: "Mixer", inputs: [], widgets_values_named: { img: "leak.png", mystery: "hello" }, widgets_values: [] }],
      links: [],
    },
    { Mixer: { input: { required: { img: ["IMAGE", {}], mystery: ["SOME_FUTURE_WIDGET_V9", {}] } } } },
  );
  assert.equal("img" in out["5"].inputs, false);
  assert.equal(out["5"].inputs.mystery, "hello");
});

test("回归：R1 一致时不误报", () => {
  const out = convertUiToApi(
    { nodes: [{ id: 4, type: "LoadImage", inputs: [], widgets_values_named: { image: "a.png" }, widgets_values: ["a.png"] }], links: [] },
    OBJ,
  );
  assert.equal(out["4"].inputs.image, "a.png");
});
