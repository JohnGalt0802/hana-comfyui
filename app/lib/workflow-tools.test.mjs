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

test("静音 / 旁路节点不再整份拒绝：按 ComfyUI 语义处理（2026-10-31）", () => {
  // mode 2：静音节点不进 prompt，孤立（无下游）时转换成功；mode 4：旁路同样不拒绝。
  // 下游消费被断的连线时仍会因「连线缺失」报错（见 node-adapter.test.mjs 的静音/旁路用例组）。
  for (const mode of [2, 4]) {
    const warnings = [];
    const o = convertUiToApi(
      { nodes: [{ id: 1, type: "LoraManager", mode, inputs: [] }], links: [] },
      OBJ,
      { onWarning: (w) => warnings.push(w) },
    );
    assert.equal(Object.keys(o).length, 0, `mode ${mode} 节点不进 prompt`);
    assert.ok(warnings.length >= 1, `mode ${mode} 应有 warning`);
  }
  // 未知 mode：仍拒绝并点名（不放行）
  assert.throws(
    () => convertUiToApi({ nodes: [{ id: 1, type: "LoraManager", mode: 7, inputs: [] }], links: [] }, OBJ),
    /未知 mode（7）/,
  );
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

// ── 六、拒绝报错末尾的归类汇总段（2026-10-31）────────────────────────────
// 只追加在整条消息末尾，不改变既有前缀 / 前 6 条 / 提示句；以下用例都传 adapters（App 工具路径的触发条件）。

const mixedWf = () => ({
  nodes: [
    { id: 1, type: "NopeNode", inputs: [] }, // 未知类型
    { id: 2, type: "Opt", mode: 2, inputs: [{ name: "model", link: 10, type: "MODEL" }] },
    { id: 3, type: "TriggerWordToggle", inputs: [{ name: "toggle", link: 11, type: "BOOLEAN" }] }, // 连线缺失 + 上游被静音归因
    { id: 4, type: "TriggerWordToggle", inputs: [{ name: "toggle", link: 77, type: "BOOLEAN" }] }, // 纯死链（无归因后缀）
  ],
  links: [
    [10, 1, 0, 2, 0, "MODEL"],
    [11, 2, 0, 3, 0, "MODEL"],
  ],
});

// ① 单类未知类型且 2 个类型名：数量与 Top 类型名都正确
test("汇总①：单类未知类型 2 个名字 → 数量与涉及类型正确", () => {
  assert.throws(
    () =>
      convertUiToApi(
        { nodes: [{ id: 1, type: "NopeNode", inputs: [] }, { id: 2, type: "AlsoNope", inputs: [] }], links: [] },
        OBJ,
        { adapters: {} },
      ),
    (e) =>
      /共 2 项阻断，分类：未知类型 2（涉及类型：NopeNode ×1、AlsoNope ×1）/.test(e.message) &&
      /静音\/旁路|连线缺失|子图|pull/.test(e.message) === false,
    `汇总段应只含未知类型一类且 Top 名字正确：${""}`,
  );
});

// ② 多类混合：三类都出现且顺序为 未知类型 · 静音/旁路 · 连线缺失，无 0 值类别
test("汇总②：未知类型+静音+连线缺失 → 三类都出现且顺序正确", () => {
  assert.throws(
    () => convertUiToApi(mixedWf(), OBJ, { adapters: {} }),
    (e) => /共 3 项阻断，分类：未知类型 1 · 静音\/旁路 1 · 连线缺失 1。/.test(e.message),
    `汇总段三类顺序应为 未知类型 · 静音/旁路 · 连线缺失：${""}`,
  );
});

// ③ 只有 1 类：有数量，不出现「涉及类型 / ×n」的重复噪音
test("汇总③：单类单名 → 有数量无 Top 噪音", () => {
  assert.throws(
    () => convertUiToApi({ nodes: [{ id: 1, type: "NopeNode", inputs: [] }], links: [] }, OBJ, { adapters: {} }),
    (e) => /未知类型 1。/.test(e.message) && !/涉及类型/.test(e.message) && !/×/.test(e.message),
    `单类单名不应列出「涉及类型 / ×n」：${""}`,
  );
});

// ④ 既有前缀、前 6 条原文、末尾提示句完整存在（汇总只是追加）
test("汇总④：既有报错原文三段完整，汇总仅追加在末尾", () => {
  assert.throws(
    () => convertUiToApi(mixedWf(), OBJ, { adapters: {} }),
    (e) =>
      /^UI→API 转换遇到不支持的构造：节点 #1 类型 NopeNode 不在 \/object_info/.test(e.message) &&
      /。请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。\n/.test(e.message),
    `前缀 / 首条问题原文 / 末尾提示句必须保持不变：${""}`,
  );
});

// ⑤ strict 模式：warnings 并入 errors 后汇总照常出现
test("汇总⑤：strict 下汇总照常出现（warnings 归入其他类）", () => {
  assert.throws(
    () => convertUiToApi(dynamicSlotWf, OBJ, { strict: true, adapters: {} }),
    (e) => /共 1 项阻断，分类：其他 1。/.test(e.message),
    `strict 下动态槽 warning 应计入汇总（其他 1）：${""}`,
  );
});

// ⑥ 建议句按类别给（2026-10-31 三处瑕疵修复）：只有静音/旁路一类 → 不出插件建议，出静音建议。
//    构造：静音上游导致下游连线缺失，文案带「处于静音」归因后缀 → 整条归 mute_bypass。
//    挂点：建议句改回无条件拼接，或 mute_bypass 建议句丢失 → 本用例挂。
test("汇总⑥：只有静音/旁路 → 不出现插件建议，出现静音建议句", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [
            { id: 2, type: "Opt", mode: 2, inputs: [] },
            { id: 3, type: "TriggerWordToggle", inputs: [{ name: "toggle", link: 11, type: "BOOLEAN" }] },
          ],
          links: [[11, 2, 0, 3, 0, "MODEL"]],
        },
        OBJ,
        { adapters: {} },
      ),
    (e) =>
      /共 1 项阻断，分类：静音\/旁路 1。静音\/旁路节点按 ComfyUI 语义处理，缺值下游会如实报错：在画布上确认这些节点是否应处于该状态。/.test(e.message) &&
      !e.message.includes("插件"),
    `只有静音/旁路时不应出现插件建议：${""}`,
  );
});

// ⑦ 只有参数分歧 → 归 value_mismatch 计数，出重存工作流建议，不出插件建议。
//    挂点：分类顺序里 value_mismatch 未先行（被子图/其他抢走）或建议句丢失 → 本用例挂。
// ── 七、子图输入槽扇出（2026-11-03）─────────────────────────────────────
// ComfyUI 前端合法写法：同一个子图输入槽（-10 同一 origin_slot）被多个内部节点消费。
// 展开时必须把同一个实例输入（外部连线 / widget 值）复制给每个消费端，不得整份拒绝。

const FANOUT_OBJ = {
  SRC: { input: {} },
  TwoIn: { input: { required: { image: ["IMAGE", {}] } } },
  Merger: { input: { required: { a: ["IMAGE", {}], b: ["IMAGE", {}] } } },
  SaveImg: { input: { required: { images: ["IMAGE", {}] } } },
  PromptNode: { input: { required: { text: ["STRING", {}] } } },
};

// 定义：输入 image 同时喂给内部 #11 与 #12（两条 -10 链接，旧版判据直接拒绝），两者再汇到 #13 → 输出接口。
const fanoutWf = () => ({
  nodes: [
    { id: 1, type: "SRC", mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }] },
    {
      id: 5,
      type: "fanout-def",
      mode: 0,
      inputs: [{ name: "image", type: "IMAGE", link: 10 }],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [20] }],
      widgets_values: [],
      widgets_values_named: {},
    },
    { id: 8, type: "SaveImg", mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 20 }], outputs: [] },
  ],
  links: [
    [10, 1, 0, 5, 0, "IMAGE"],
    [20, 5, 0, 8, 0, "IMAGE"],
  ],
  definitions: {
    subgraphs: [
      {
        id: "fanout-def",
        name: "扇出",
        inputs: [{ name: "image", type: "IMAGE", links: [1, 2] }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [3] }],
        widgets: [],
        nodes: [
          {
            id: 11,
            type: "TwoIn",
            mode: 0,
            inputs: [{ name: "image", type: "IMAGE", link: 1 }],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [4] }],
          },
          {
            id: 12,
            type: "TwoIn",
            mode: 0,
            inputs: [{ name: "image", type: "IMAGE", link: 2 }],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [5] }],
          },
          {
            id: 13,
            type: "Merger",
            mode: 0,
            inputs: [
              { name: "a", type: "IMAGE", link: 4 },
              { name: "b", type: "IMAGE", link: 5 },
            ],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [3] }],
          },
        ],
        links: [
          { id: 1, origin_id: -10, origin_slot: 0, target_id: 11, target_slot: 0, type: "IMAGE" },
          { id: 2, origin_id: -10, origin_slot: 0, target_id: 12, target_slot: 0, type: "IMAGE" },
          { id: 3, origin_id: 13, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
          { id: 4, origin_id: 11, origin_slot: 0, target_id: 13, target_slot: 0, type: "IMAGE" },
          { id: 5, origin_id: 12, origin_slot: 0, target_id: 13, target_slot: 1, type: "IMAGE" },
        ],
      },
    ],
  },
});

test("子图输入槽扇出：外部连线同时接到全部内部消费端，产物链接数正确", () => {
  const warnings = [];
  const out = convertUiToApi(fanoutWf(), FANOUT_OBJ, { onWarning: (w) => warnings.push(w) });
  // 实例 #5 消失，内部节点按 s5: 前缀进 prompt
  assert.equal("5" in out, false);
  assert.deepEqual(Object.keys(out).sort(), ["1", "8", "s5:11", "s5:12", "s5:13"]);
  // 两个内部消费槽指向同一条外部连线（同一上游 #1 的输出槽 0）
  assert.deepEqual(out["s5:11"].inputs.image, ["1", 0]);
  assert.deepEqual(out["s5:12"].inputs.image, ["1", 0]);
  // 内部连线与输出连线照旧
  assert.deepEqual(out["s5:13"].inputs, { a: ["s5:11", 0], b: ["s5:12", 0] });
  assert.deepEqual(out["8"].inputs.images, ["s5:13", 0]);
  // 产物连线总数：两条扇出 + 两条内部 + 一条输出 = 5
  const edges = Object.values(out).reduce((n, node) => n + Object.values(node.inputs || {}).length, 0);
  assert.equal(edges, 5);
  assert.equal(warnings.length, 0);
});

test("子图输入槽扇出：widget 值复制给每个内部消费端", () => {
  const wf = {
    nodes: [
      {
        id: 5,
        type: "widget-fanout",
        mode: 0,
        inputs: [{ name: "text", type: "STRING", link: null }],
        outputs: [],
        widgets_values: ["hello"],
      },
    ],
    links: [],
    definitions: {
      subgraphs: [
        {
          id: "widget-fanout",
          name: "扇出写入",
          inputs: [{ name: "text", type: "STRING", links: [1, 2] }],
          outputs: [],
          widgets: [],
          nodes: [
            {
              id: 11,
              type: "PromptNode",
              mode: 0,
              inputs: [{ name: "text", type: "STRING", link: 1, widget: { name: "text" } }],
              outputs: [],
              widgets_values: ["old"],
            },
            {
              id: 12,
              type: "PromptNode",
              mode: 0,
              inputs: [{ name: "text", type: "STRING", link: 2, widget: { name: "text" } }],
              outputs: [],
              widgets_values: ["old"],
            },
          ],
          links: [
            { id: 1, origin_id: -10, origin_slot: 0, target_id: 11, target_slot: 0, type: "STRING" },
            { id: 2, origin_id: -10, origin_slot: 0, target_id: 12, target_slot: 0, type: "STRING" },
          ],
        },
      ],
    },
  };
  const out = convertUiToApi(wf, FANOUT_OBJ);
  // 同一个实例值写给两个内部消费节点（位置回退对位表按「任一消费端带 widget 标记」入选）
  assert.equal(out["s5:11"].inputs.text, "hello");
  assert.equal(out["s5:12"].inputs.text, "hello");
});

test("汇总⑦：只有参数分歧 → value_mismatch 计数 + 重存建议，无插件建议", () => {
  assert.throws(
    () =>
      convertUiToApi(
        { nodes: [{ id: 1, type: "LoadImage", inputs: [], widgets_values_named: { image: "b.png" }, widgets_values: ["a.png"] }], links: [] },
        OBJ,
        { adapters: {} },
      ),
    (e) =>
      /共 1 项阻断，分类：参数分歧 1。参数分歧通常是工作流被外部脚本只改了其中一个字段：在 ComfyUI 里重新保存一次工作流即可自愈。/.test(e.message) &&
      !e.message.includes("插件"),
    `参数分歧应出重存建议且不出插件建议：${""}`,
  );
});

// ⑧ 未知类型 + 参数分歧混合 → 两类计数正确，两句建议都出现且顺序稳定（未知类型在前）。
test("汇总⑧：未知类型+参数分歧 → 两类计数与两句建议，顺序稳定", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [
            { id: 1, type: "NopeNode", inputs: [] },
            { id: 2, type: "LoadImage", inputs: [], widgets_values_named: { image: "b.png" }, widgets_values: ["a.png"] },
          ],
          links: [],
        },
        OBJ,
        { adapters: {} },
      ),
    (e) =>
      /共 2 项阻断，分类：未知类型 1 · 参数分歧 1。未知类型通常是本机没有安装对应插件[\s\S]*参数分歧通常是工作流被外部脚本只改了其中一个字段：在 ComfyUI 里重新保存一次工作流即可自愈。/.test(e.message),
    `两类计数与建议顺序应为 未知类型 → 参数分歧：${""}`,
  );
});

// ── 八、子图实例 widgets_values 为空（2026-11-03）────────────────────────────
// John 拍板：实例没覆盖任何参数（字段缺失 / 0 项）→ 沿用子图内部默认值，不写值、只记 warning；
// 只有这一种放行，其余数量不一致照旧拒绝。

// 定义：1 个 widget 输入 text → -10 → 内部 PromptNode 的 text 槽（带 widget 标记，内部默认 "default text"）
const emptyWvWf = () => ({
  nodes: [
    {
      id: 5,
      type: "empty-wv-def",
      mode: 0,
      inputs: [{ name: "text", type: "STRING", link: null }],
      outputs: [],
      widgets_values: [],
    },
  ],
  links: [],
  definitions: {
    subgraphs: [
      {
        id: "empty-wv-def",
        name: "空值子图",
        inputs: [{ name: "text", type: "STRING", links: [1] }],
        outputs: [],
        widgets: [],
        nodes: [
          {
            id: 11,
            type: "PromptNode",
            mode: 0,
            inputs: [{ name: "text", type: "STRING", link: 1, widget: { name: "text" } }],
            outputs: [],
            widgets_values: ["default text"],
          },
        ],
        links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 11, target_slot: 0, type: "STRING" }],
      },
    ],
  },
});

test("子图实例 widgets_values 为空：展开成功，内部节点保留定义默认值，只记一条 warning", () => {
  // 对位表有 1 个 widget 输入、实例 0 项——旧版在这里拒绝，现在按「全用内部默认值」放行
  const warnings = [];
  const out = convertUiToApi(emptyWvWf(), FANOUT_OBJ, { onWarning: (w) => warnings.push(w) });
  assert.equal("5" in out, false, "实例节点不进 prompt");
  // 内部节点保留自己的默认 widget 值（不写值：既不是空、也不是错位）
  assert.deepEqual(out["s5:11"].inputs, { text: "default text" });
  assert.equal(warnings.length, 1, `应恰好一条 warning：${warnings.join(" | ")}`);
  assert.equal(warnings[0], "子图实例 #5（「空值子图」）未携带 widgets_values，已使用子图内部默认值");
});

// 非零但数量不一致（3 项 vs 8 个 widget 输入）→ 仍是真正的位置歧义，文案与拒绝行为都不动
const wideWvObj = {
  ...FANOUT_OBJ,
  Wide: {
    input: {
      required: { t0: ["STRING", {}], t1: ["STRING", {}], t2: ["STRING", {}], t3: ["STRING", {}], t4: ["STRING", {}], t5: ["STRING", {}], t6: ["STRING", {}], t7: ["STRING", {}] },
    },
  },
};
const mismatchWvWf = () => ({
  nodes: [{ id: 5, type: "wide-def", mode: 0, inputs: [], outputs: [], widgets_values: ["a", "b", "c"] }],
  links: [],
  definitions: {
    subgraphs: [
      {
        id: "wide-def",
        name: "宽子图",
        inputs: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, type: "STRING", links: [i + 1] })),
        outputs: [],
        widgets: [],
        nodes: [
          {
            id: 11,
            type: "Wide",
            mode: 0,
            inputs: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, type: "STRING", link: i + 1, widget: { name: `t${i}` } })),
            outputs: [],
            widgets_values: ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"],
          },
        ],
        links: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, origin_id: -10, origin_slot: i, target_id: 11, target_slot: i, type: "STRING" })),
      },
    ],
  },
});

test("子图实例 widgets_values 非零但数量不一致：仍然拒绝，报错文案不变", () => {
  assert.throws(
    () => convertUiToApi(mismatchWvWf(), wideWvObj),
    /子图实例 #5（「宽子图」）的 widgets_values 有 3 项，但定义按序可对位的 widget 输入有 8 个（t0、t1、t2、t3、t4、t5、t6、t7），数量不一致，无法按位置对位，已拒绝/,
  );
});

// ── 九、稀疏槽：widget 位序必须按声明序，不能按槽序（2026-11-03 修）──────
// 背景：旧实现「有槽证据就按槽序取 widgets_values」，节点只有部分 widget 带输入槽时（KSampler 只带 seed/steps 槽）
// 槽序 ≠ 声明序，值整体错位——实测把 steps 写成 43（真实 50）、BasicScheduler.steps 写成 "simple"。
// 这里的 KSampler 声明序取自本机 /object_info 原样（键序 + 每条 spec），不手写臆造。
const KSampler_OBJ = {
  KSampler: {
    input: {
      required: {
        model: ["MODEL", {}],
        seed: ["INT", { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        cfg: ["FLOAT", { default: 8, min: 0, max: 100, step: 0.1 }],
        sampler_name: [["euler", "uni_pc", "dpmpp_2m"], {}],
        scheduler: [["simple", "karras", "beta"], {}],
        positive: ["CONDITIONING", {}],
        negative: ["CONDITIONING", {}],
        latent_image: ["LATENT", {}],
        denoise: ["FLOAT", { default: 1, min: 0, max: 1, step: 0.01 }],
      },
    },
  },
  SRC: { input: {} },
};
// 稀疏槽样本：节点 inputs 里只有 steps 一个 widget 槽（其余都是连线槽）——真实文件 image_longcat_image_edit.json #7 的形态
const sparseKSamplerWf = () => ({
  nodes: [
    ...[1, 2, 3, 4].map((id) => ({ id, type: "SRC", inputs: [], outputs: [{ name: "X", type: "X", links: [id] }] })),
    {
      id: 7,
      type: "KSampler",
      inputs: [
        { name: "model", type: "MODEL", link: 1 },
        { name: "positive", type: "CONDITIONING", link: 2 },
        { name: "negative", type: "CONDITIONING", link: 3 },
        { name: "latent_image", type: "LATENT", link: 4 },
        { name: "steps", type: "INT", link: null, widget: { name: "steps" } },
      ],
      outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
      widgets_values: [43, "fixed", 50, 4.5, "euler", "simple", 1],
    },
  ],
  links: [
    [1, 1, 0, 7, 0, "MODEL"],
    [2, 2, 0, 7, 1, "CONDITIONING"],
    [3, 3, 0, 7, 2, "CONDITIONING"],
    [4, 4, 0, 7, 3, "LATENT"],
  ],
});

test("稀疏槽（KSampler 只有 steps 带槽）：widget 值按声明序落位，不按槽序错位", () => {
  const inputs = convertUiToApi(sparseKSamplerWf(), KSampler_OBJ)["7"].inputs;
  assert.equal(inputs.seed, 43, "seed 必须落在 seed 名下");
  assert.equal(inputs.steps, 50, "steps 必须是真实声明位的 50，不能吃到 seed 的 43");
  assert.equal(inputs.cfg, 4.5);
  assert.equal(inputs.sampler_name, "euler");
  assert.equal(inputs.scheduler, "simple");
  assert.equal(inputs.denoise, 1);
  // seed 的 control_after_generate 副值（"fixed"）仍多占一格，并未被当成某个 widget 的值注入
  assert.equal(Object.values(inputs).includes("fixed"), false, "control_after_generate 副值不得被当参数注入");
  assert.deepEqual(Object.keys(inputs).sort(), ["cfg", "denoise", "latent_image", "model", "negative", "positive", "sampler_name", "scheduler", "seed", "steps"]);
});

// 对照：「全部 widget 都有槽」的常规路径必须一字不变（slot 与声明同位）
const DENSE_OBJ = {
  Dense: {
    input: {
      required: { a: ["STRING", {}], socketIn: ["IMAGE", {}], b: ["INT", {}], c: [["p", "q"], {}] },
    },
  },
};
const denseWf = () => ({
  nodes: [
    {
      id: 3,
      type: "Dense",
      inputs: [
        { name: "a", type: "STRING", link: null, widget: { name: "a" } },
        { name: "socketIn", type: "IMAGE", link: null },
        { name: "b", type: "INT", link: null, widget: { name: "b" } },
        { name: "c", type: "COMBO", link: null, widget: { name: "c" } },
      ],
      outputs: [],
      widgets_values: ["hello", 7, "q"],
    },
  ],
  links: [],
});

test("对照：全部 widget 都带槽（稠密槽）时行为不变，socket 槽不占位", () => {
  const inputs = convertUiToApi(denseWf(), DENSE_OBJ)["3"].inputs;
  assert.deepEqual(inputs, { a: "hello", b: 7, c: "q" });
});

// autogrow 子槽（model.width 这类未声明子控件）必须紧跟父项占位，否则其后的 seed 会错位
const AUTOGROW_OBJ = {
  Dyn: { input: { required: { model: [["m1", "m2"], {}], seed: ["INT", { control_after_generate: true }] } } },
};

test("autogrow 子槽跟随父项占位：未声明子控件只占位、不注入，seed 不错位", () => {
  const wf = {
    nodes: [
      {
        id: 4,
        type: "Dyn",
        inputs: [
          { name: "model", type: "COMBO", link: null, widget: { name: "model" } },
          { name: "model.width", type: "INT", link: null, widget: { name: "model.width" } },
          { name: "seed", type: "INT", link: null, widget: { name: "seed" } },
        ],
        outputs: [],
        widgets_values: ["m1", 1024, 5, "fixed"],
      },
    ],
    links: [],
  };
  const inputs = convertUiToApi(wf, AUTOGROW_OBJ)["4"].inputs;
  assert.equal(inputs.model, "m1");
  assert.equal(inputs.seed, 5, "子槽占一格时 seed 不能被挤到 1024");
  assert.equal("model.width" in inputs, false, "未声明子控件只占位不注入");
});
