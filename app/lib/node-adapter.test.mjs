// app/lib/node-adapter.test.mjs — 节点适配规则引擎（adapters）契约
// 运行：node --test app/lib/node-adapter.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { convertUiToApi } from "./workflow-tools.mjs";

const OBJ = {
  SRC: { input: {} },
  Sink: { input: { required: { model: ["MODEL", {}] } } },
  SinkC: { input: { required: { cond: ["CONDITIONING", {}] } } },
  Opt: { input: { required: { model: ["MODEL", {}] } } }, // 可被旁路的变换节点
  Dyn: { input: { required: { toggle: ["BOOLEAN", {}] } } }, // 动态槽 / 怪异 widget 载体
};

const REROUTE = { Reroute: { virtual: true, passthrough: true } };
const out = (name, type) => ({ name, type, links: [] });
// 两个键的声明顺序可对调：驗「alias 撞键」是否依赖声明顺序
const dynwObj = (order) => ({
  DynW: {
    input: {
      required:
        order === "strengthFirst"
          ? { strength: ["FLOAT", {}], toggle: ["BOOLEAN", {}] }
          : { toggle: ["BOOLEAN", {}], strength: ["FLOAT", {}] },
    },
  },
});

// A(1) → Reroute(2) → Sink(3)
const rerouteWf = () => ({
  nodes: [
    { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
    { id: 2, type: "Reroute", inputs: [{ name: "", link: 10, type: "MODEL" }], outputs: [out("", "MODEL")] },
    { id: 3, type: "Sink", inputs: [{ name: "model", link: 11, type: "MODEL" }] },
  ],
  links: [
    [10, 1, 0, 2, 0, "MODEL"],
    [11, 2, 0, 3, 0, "MODEL"],
  ],
});

// ── 一、无档案：行为必须与 0.16.2 逐字一致 ──────────────────────────────────

const dynSlotWf = () => ({
  nodes: [
    { id: 5, type: "SRC", inputs: [] },
    { id: 7, type: "Dyn", inputs: [{ name: "Lora1", link: 3, type: "*" }], widgets_values_named: { toggle: true }, widgets_values: [] },
  ],
  links: [[3, 5, 0, 7, 0, "MODEL"]],
});

test("无 adapters 时输出与不传第三参完全一致（含「合法但不相干」的档案）", () => {
  const wf = dynSlotWf();
  const base = convertUiToApi(wf, OBJ);
  assert.deepEqual(base["7"].inputs.Lora1, ["5", 0]);
  const variants = [
    undefined,
    null,
    {},
    { Nope: {} },
    { Nope: { virtual: true } }, // 合法但与本图无关：不得把任何节点当成虚拟件
    { Nope: { virtual: true, passthrough: true, bypass: "passthrough", slots: [{ match: "*", action: "ignore" }] } },
  ];
  for (const adapters of variants) {
    assert.deepEqual(convertUiToApi(wf, OBJ, { adapters }), base, `adapters=${JSON.stringify(adapters)} 不得改变输出`);
  }
});

test("无 adapters 时 Reroute 仍按原路径拒绝（不给档案就不放宽）", () => {
  assert.throws(() => convertUiToApi(rerouteWf(), OBJ), /子图\/环绕节点/);
  assert.throws(() => convertUiToApi(rerouteWf(), OBJ, { adapters: { Nope: { virtual: true } } }), /子图\/环绕节点/);
});

test("无 adapters 时静音/旁路仍按原路径拒绝（不复用 bypass 默认值）", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", inputs: [] },
      { id: 2, type: "Opt", mode: 4, inputs: [{ name: "model", link: 10, type: "MODEL" }] },
    ],
    links: [[10, 1, 0, 2, 0, "MODEL"]],
  };
  assert.throws(() => convertUiToApi(wf, OBJ), /静音\/旁路/);
});

// ── 二、virtual + passthrough：连线穿透 ─────────────────────────────────────

test("Reroute 穿透：A→Reroute→B，B 的输入 origin 直指 A", () => {
  const o = convertUiToApi(rerouteWf(), OBJ, { adapters: REROUTE });
  assert.equal("2" in o, false, "Reroute 不得出现在 prompt 里");
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
  assert.equal(o["3"].class_type, "Sink");
});

test("多层 Reroute 串联：穿透到最上游真实源", () => {
  const o = convertUiToApi(
    {
      nodes: [
        { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
        { id: 2, type: "Reroute", inputs: [{ name: "", link: 10, type: "MODEL" }], outputs: [out("", "MODEL")] },
        { id: 3, type: "Reroute", inputs: [{ name: "", link: 11, type: "MODEL" }], outputs: [out("", "MODEL")] },
        { id: 4, type: "Sink", inputs: [{ name: "model", link: 12, type: "MODEL" }] },
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 2, 0, 3, 0, "MODEL"],
        [12, 3, 0, 4, 0, "MODEL"],
      ],
    },
    OBJ,
    { adapters: REROUTE },
  );
  assert.deepEqual(Object.keys(o).sort(), ["1", "4"]);
  assert.deepEqual(o["4"].inputs.model, ["1", 0]);
});

test("virtual 无 passthrough：节点不出现，下游按连线缺失报错", () => {
  assert.throws(
    () => convertUiToApi(rerouteWf(), OBJ, { adapters: { Reroute: { virtual: true } } }),
    /连线缺失（link 11）/,
  );
});

test("passthrough 但虚拟节点没有上游：下游按连线缺失报错，不抛其它错", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [
            { id: 2, type: "Reroute", inputs: [{ name: "", link: null }], outputs: [out("", "MODEL")] },
            { id: 3, type: "Sink", inputs: [{ name: "model", link: 11, type: "MODEL" }] },
          ],
          links: [[11, 2, 0, 3, 0, "MODEL"]],
        },
        OBJ,
        { adapters: REROUTE },
      ),
    /节点 #3 输入 model 的连线缺失（link 11）/,
  );
});

test("穿透成环：不猜源，按连线缺失处理", () => {
  assert.throws(
    () =>
      convertUiToApi(
        {
          nodes: [
            { id: 2, type: "Reroute", inputs: [{ name: "", link: 10, type: "MODEL" }], outputs: [out("", "MODEL")] },
            { id: 3, type: "Reroute", inputs: [{ name: "", link: 11, type: "MODEL" }], outputs: [out("", "MODEL")] },
            { id: 4, type: "Sink", inputs: [{ name: "model", link: 12, type: "MODEL" }] },
          ],
          links: [
            [10, 3, 0, 2, 0, "MODEL"],
            [11, 2, 0, 3, 0, "MODEL"],
            [12, 2, 0, 4, 0, "MODEL"],
          ],
        },
        OBJ,
        { adapters: REROUTE },
      ),
    /连线缺失（link 12）/,
  );
});

// ── 三、必改一：入口选择必须绑定被消费的输出槽 ─────────────────────────────

// ControlNetApplyAdvanced 形态：positive / negative 同为 CONDITIONING，输出也各有一个
const cnaWf = ({ reverseLinks = false, unnamedOutputs = false, bothSlots = false } = {}) => {
  const nodes = [
    { id: 1, type: "SRC", inputs: [], outputs: [out("out", "CONDITIONING")] },
    { id: 2, type: "SRC", inputs: [], outputs: [out("out", "CONDITIONING")] },
    {
      id: 3,
      type: "CNA",
      mode: 4,
      inputs: [
        { name: "positive", type: "CONDITIONING", link: 10 },
        { name: "negative", type: "CONDITIONING", link: 11 },
      ],
      outputs: unnamedOutputs
        ? [out("", "CONDITIONING"), out("", "CONDITIONING")]
        : [out("positive", "CONDITIONING"), out("negative", "CONDITIONING")],
    },
    { id: 4, type: "SinkC", inputs: [{ name: "cond", link: 12, type: "CONDITIONING" }] },
  ];
  const links = [
    [10, 1, 0, 3, 0, "CONDITIONING"], // SRC1 → CNA.positive
    [11, 2, 0, 3, 1, "CONDITIONING"], // SRC2 → CNA.negative
    [12, 3, 1, 4, 0, "CONDITIONING"], // CNA.negative(slot 1) → SinkC
  ];
  if (bothSlots) {
    nodes.push({ id: 5, type: "SinkC", inputs: [{ name: "cond", link: 13, type: "CONDITIONING" }] });
    links.push([13, 3, 0, 5, 0, "CONDITIONING"]); // CNA.positive(slot 0) → SinkC#5
  }
  return { nodes, links: reverseLinks ? [...links].reverse() : links };
};

const CNA_ADAPTER = { CNA: { bypass: "passthrough" } };

test("多入边同类型：按名字配对（negative 槽取 negative 入边，不是 positive）", () => {
  const o = convertUiToApi(cnaWf(), OBJ, { adapters: CNA_ADAPTER });
  assert.deepEqual(o["4"].inputs.cond, ["2", 0], "CNA.negative 必须来自 SRC2（negative 入边）");
});

test("结果与 wf.links 数组顺序无关（对调后产物完全相同）", () => {
  const plain = cnaWf({ bothSlots: true });
  const reversed = cnaWf({ bothSlots: true, reverseLinks: true });
  const a = convertUiToApi(plain, OBJ, { adapters: CNA_ADAPTER });
  const b = convertUiToApi(reversed, OBJ, { adapters: CNA_ADAPTER });
  assert.deepEqual(b, a);
  assert.deepEqual(a["4"].inputs.cond, ["2", 0]);
});

test("多输出同类型：不同输出槽解析到不同上游", () => {
  const o = convertUiToApi(cnaWf({ bothSlots: true }), OBJ, { adapters: CNA_ADAPTER });
  assert.deepEqual(o["5"].inputs.cond, ["1", 0], "slot 0(positive) → SRC1");
  assert.deepEqual(o["4"].inputs.cond, ["2", 0], "slot 1(negative) → SRC2");
});

test("同类型多入口且无法按名字确定：明确抛「歧义映射」，绝不取第一条", () => {
  assert.throws(
    () => convertUiToApi(cnaWf({ unnamedOutputs: true }), OBJ, { adapters: CNA_ADAPTER }),
    /歧义映射/,
  );
});

// ── 四、必改二：bypass 只作用于 mode 4；mute 恒为 skip ─────────────────────

const bypassWf = (mode) => ({
  nodes: [
    { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
    { id: 2, type: "Opt", mode, inputs: [{ name: "model", link: 10, type: "MODEL" }], outputs: [out("model", "MODEL")] },
    { id: 3, type: "Sink", inputs: [{ name: "model", link: 11, type: "MODEL" }] },
  ],
  links: [
    [10, 1, 0, 2, 0, "MODEL"],
    [11, 2, 0, 3, 0, "MODEL"],
  ],
});

test('mode 4 + bypass:"skip" — 节点不进 prompt，下游取不到源 → 连线缺失', () => {
  assert.throws(
    () => convertUiToApi(bypassWf(4), OBJ, { adapters: { Opt: { bypass: "skip" } } }),
    /节点 #3 输入 model 的连线缺失（link 11）/,
  );
});

test('mode 4 + bypass:"passthrough" — 节点不进 prompt，下游 origin 直指上游', () => {
  const o = convertUiToApi(bypassWf(4), OBJ, { adapters: { Opt: { bypass: "passthrough" } } });
  assert.equal("2" in o, false);
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
});

test('mode 2(mute) + bypass:"passthrough" — mute 是断链，只降级为 skip 并告警，绝不穿透', () => {
  const warnings = [];
  assert.throws(
    () => convertUiToApi(bypassWf(2), OBJ, { onWarning: (w) => warnings.push(w), adapters: { Opt: { bypass: "passthrough" } } }),
    /连线缺失（link 11）/,
  );
  assert.ok(warnings.some((w) => /mode 2/.test(w) && /按 skip 处理/.test(w)), `缺少 mute 降级告警：${JSON.stringify(warnings)}`);
});

test("mode 2(mute) 无档案：仍按旧行为拒绝", () => {
  assert.throws(() => convertUiToApi(bypassWf(2), OBJ, { adapters: { Opt: {} } }), /静音\/旁路/);
});

test("bypass 对象形式 { mute, bypass } 已废弃：warn 后忽略，mode 4 回落旧行为", () => {
  const warnings = [];
  assert.throws(
    () =>
      convertUiToApi(bypassWf(4), OBJ, {
        onWarning: (w) => warnings.push(w),
        adapters: { Opt: { bypass: { mute: "skip", bypass: "passthrough" } } },
      }),
    /静音\/旁路/,
  );
  assert.ok(warnings.some((w) => /不接受 \{ mute, bypass \} 对象形式/.test(w)), `缺少废弃告警：${JSON.stringify(warnings)}`);
});

// ── 五、slots：ignore / alias / passthrough（有连线的槽）───────────────────

const dynWf = () => ({
  nodes: [
    { id: 1, type: "SRC", inputs: [] },
    {
      id: 9,
      type: "Dyn",
      inputs: [
        { name: "image_1", link: 21, type: "IMAGE" },
        { name: "seed_1", link: 22, type: "INT" },
        { name: "extra", link: 23, type: "STRING" },
      ],
      widgets_values_named: { toggle: true },
      widgets_values: [],
    },
  ],
  links: [
    [21, 1, 0, 9, 0, "IMAGE"],
    [22, 1, 1, 9, 1, "INT"],
    [23, 1, 2, 9, 2, "STRING"],
  ],
});

test("slots: ignore / alias / passthrough 三种动作", () => {
  const warnings = [];
  const o = convertUiToApi(dynWf(), OBJ, {
    onWarning: (w) => warnings.push(w),
    adapters: {
      Dyn: {
        slots: [
          { match: "image*", action: "ignore" },
          { match: "seed*", action: "alias", as: "seed_value" },
          { match: "*", action: "passthrough" },
        ],
      },
    },
  });
  const inputs = o["9"].inputs;
  assert.equal("image_1" in inputs, false, "ignore：连了线也不收编");
  assert.deepEqual(inputs.seed_value, ["1", 1], "alias：改用 as 指定的键名");
  assert.equal("seed_1" in inputs, false);
  assert.deepEqual(inputs.extra, ["1", 2], "passthrough：按连线原样收编");
  assert.equal(inputs.toggle, true, "声明 widget 不受槽规则影响");
  assert.deepEqual(warnings, [], "规则命中时不该再报「不对应任何声明输入」");
});

test("slots: 先匹配先生效（前一条 ignore 遮蔽后一条 alias）", () => {
  const warnings = [];
  const o = convertUiToApi(dynWf(), OBJ, {
    onWarning: (w) => warnings.push(w),
    adapters: {
      Dyn: {
        slots: [
          { match: "image*", action: "ignore" },
          { match: "image_1", action: "alias", as: "img" },
        ],
      },
    },
  });
  assert.equal("img" in o["9"].inputs, false);
  assert.equal(warnings.filter((w) => /同时命中多条/.test(w)).length, 1, "冲突匹配要 warn");
});

// ── 六、必改三：只有 widget、没有连线的槽也要吃到规则 ──────────────────────

test("无连线的 widget 槽 + alias：值注入到 as 指定的新键名下", () => {
  const o = convertUiToApi(
    { nodes: [{ id: 1, type: "Dyn", inputs: [], widgets_values_named: { toggle: true }, widgets_values: [] }], links: [] },
    OBJ,
    { adapters: { Dyn: { slots: [{ match: "toggle", action: "alias", as: "switch_flag" }] } } },
  );
  assert.equal(o["1"].inputs.switch_flag, true);
  assert.equal("toggle" in o["1"].inputs, false, "alias 后不再写原名");
});

test("无连线的 widget 槽 + ignore：不注入", () => {
  const o = convertUiToApi(
    { nodes: [{ id: 1, type: "Dyn", inputs: [], widgets_values_named: { toggle: true }, widgets_values: [] }], links: [] },
    OBJ,
    { adapters: { Dyn: { slots: [{ match: "toggle", action: "ignore" }] } } },
  );
  assert.deepEqual(o["1"].inputs, {});
});

test("widget 槽 alias 撞上已占用键：warn 且不覆盖", () => {
  const warnings = [];
  const o = convertUiToApi(
    {
      nodes: [
        { id: 1, type: "SRC", inputs: [] },
        { id: 9, type: "Dyn", inputs: [{ name: "model", link: 5, type: "MODEL" }], widgets_values_named: { toggle: true }, widgets_values: [] },
      ],
      links: [[5, 1, 0, 9, 0, "MODEL"]],
    },
    OBJ,
    { onWarning: (w) => warnings.push(w), adapters: { Dyn: { slots: [{ match: "toggle", action: "alias", as: "model" }] } } },
  );
  assert.deepEqual(o["9"].inputs.model, ["1", 0], "已占用的键不得被 widget 覆盖");
  assert.equal("toggle" in o["9"].inputs, false);
  assert.ok(warnings.some((w) => /已被占用/.test(w)), `缺少撞键告警：${JSON.stringify(warnings)}`);
});

test("widget alias 撞另一个 widget 的键：结果与声明顺序无关，真值不被挤掉", () => {
  const wf = {
    nodes: [{ id: 1, type: "DynW", inputs: [], widgets_values_named: { toggle: true, strength: 0.5 }, widgets_values: [] }],
    links: [],
  };
  const products = [];
  for (const order of ["toggleFirst", "strengthFirst"]) {
    const warnings = [];
    const o = convertUiToApi(wf, dynwObj(order), {
      onWarning: (w) => warnings.push(w),
      adapters: { DynW: { slots: [{ match: "toggle", action: "alias", as: "strength" }] } },
    });
    assert.equal(o["1"].inputs.strength, 0.5, `${order}：真 widget 的值不得被 alias 挤掉`);
    assert.equal("toggle" in o["1"].inputs, false);
    assert.ok(warnings.some((w) => /已被占用/.test(w)), `${order}：撞键必须 warn（不能靠声明顺序）`);
    products.push(o);
  }
  assert.deepEqual(products[1], products[0], "两种声明顺序必须产出相同结果");
});

test("位置回退分支（无 named）下 alias 撞键同样与声明顺序无关", () => {
  const wfFor = (names, values) => ({
    nodes: [
      { id: 1, type: "DynW", inputs: names.map((nm) => ({ name: nm, widget: { name: nm }, link: null })), widgets_values: values },
    ],
    links: [],
  });
  const products = [];
  for (const [names, values] of [
    [["toggle", "strength"], [true, 0.5]],
    [["strength", "toggle"], [0.5, true]],
  ]) {
    const warnings = [];
    const o = convertUiToApi(wfFor(names, values), dynwObj("toggleFirst"), {
      onWarning: (w) => warnings.push(w),
      adapters: { DynW: { slots: [{ match: "toggle", action: "alias", as: "strength" }] } },
    });
    assert.equal(o["1"].inputs.strength, 0.5, `${names.join(",")}：真 widget 的值不得被 alias 挤掉`);
    assert.ok(warnings.some((w) => /已被占用/.test(w)), `${names.join(",")}：撞键必须 warn`);
    products.push(o);
  }
  assert.deepEqual(products[1], products[0]);
});

test("同 action 不同 as 的两条规则：后一条是死规则，要 warn", () => {
  const warnings = [];
  convertUiToApi(
    { nodes: [{ id: 1, type: "Dyn", inputs: [], widgets_values_named: { toggle: true }, widgets_values: [] }], links: [] },
    OBJ,
    {
      onWarning: (w) => warnings.push(w),
      adapters: { Dyn: { slots: [{ match: "toggle*", action: "alias", as: "a" }, { match: "toggle", action: "alias", as: "b" }] } },
    },
  );
  assert.ok(warnings.some((w) => /被遮蔽/.test(w) && /as=b/.test(w)), `缺少死规则告警：${JSON.stringify(warnings)}`);
});

test("mode 2(mute) + virtual+passthrough：Reroute 静音 = 断链，绝不允许穿透", () => {
  const wf = rerouteWf();
  wf.nodes[1].mode = 2;
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: REROUTE }),
    /连线缺失（link 11）/,
    "mute 下的 Reroute 必须被 skip（不穿透），下游取不到源",
  );
  assert.ok(warnings.some((w) => /mode 2/.test(w) && /virtual \+ passthrough/.test(w)), `mute 撤销穿透要告警：${JSON.stringify(warnings)}`);
  // 对照：同一个 Reroute 在 mode 0 下确实穿透，证明上面的拒绝不是因为规则失效
  assert.deepEqual(convertUiToApi(rerouteWf(), OBJ, { adapters: REROUTE })["3"].inputs.model, ["1", 0]);
});

// ── 七、非法规则：warn 而不抛错 ────────────────────────────────────────────

test("非法规则（alias 缺 as）：产生 warning 而非抛错，退回默认流程", () => {
  const warnings = [];
  let o;
  assert.doesNotThrow(() => {
    o = convertUiToApi(dynWf(), OBJ, {
      onWarning: (w) => warnings.push(w),
      adapters: { Dyn: { slots: [{ match: "seed*", action: "alias" }] } },
    });
  });
  assert.ok(warnings.some((w) => /action=alias 缺少 as/.test(w)), `缺少警示：${JSON.stringify(warnings)}`);
  assert.deepEqual(o["9"].inputs.seed_1, ["1", 1], "规则被丢弃后按动态槽默认路径收编");
});

test("非法 adapters 形态：warn 且不改变输出", () => {
  const warnings = [];
  const wf = dynWf();
  const base = convertUiToApi(wf, OBJ, { onWarning: () => {} });
  const o = convertUiToApi(wf, OBJ, {
    onWarning: (w) => warnings.push(w),
    adapters: { Dyn: { virtual: "yes", passthrough: true, bypass: "explode", slots: "nope" }, Bad: 3 },
  });
  assert.deepEqual(o, base);
  assert.ok(warnings.some((w) => /virtual 需要布尔值/.test(w)));
  assert.ok(warnings.some((w) => /passthrough 需要配合 virtual/.test(w)));
  assert.ok(warnings.some((w) => /bypass 需要 "skip" \| "passthrough"/.test(w)));
  assert.ok(warnings.some((w) => /slots 需要数组/.test(w)));
  assert.ok(warnings.some((w) => /Bad 不是对象/.test(w)));
});

test("adapters 非对象：warn 且按默认行为处理", () => {
  const warnings = [];
  assert.throws(
    () => convertUiToApi(rerouteWf(), OBJ, { onWarning: (w) => warnings.push(w), adapters: "Reroute" }),
    /子图\/环绕节点/,
  );
  assert.ok(warnings.some((w) => /adapters 需要对象/.test(w)));
});

// ── 八、pull：按名字配对展开（SetNode/GetNode 这类「一个存、一个取」的虚拟件）──────
// 规则只描述「位置」：名字在各自节点的哪个字段、配对节点的源在哪个输入槽——引擎不认识 Set/Get 的节点身份。
const SETGET = {
  SetNode: { virtual: true },
  GetNode: {
    virtual: true,
    pull: {
      keyPath: "widgets_values[0]",
      fromType: ["SetNode"],
      fromKeyPath: "widgets_values[0]",
      sourcePath: "inputs[0]",
    },
  },
};
const setNodeOf = (id, key, link, inputType = "MODEL") => ({
  id,
  type: "SetNode",
  inputs: [{ name: "value", link, type: inputType }],
  outputs: [],
  widgets_values: [key],
});
const getNodeOf = (id, key, outType = "MODEL") => ({
  id,
  type: "GetNode",
  inputs: [],
  outputs: [out("", outType)],
  widgets_values: [key],
});
// SRC(1) → Set(11,"MODEL") … Get(12,"MODEL") → Sink(3)
const setGetWf = ({ getKey = "MODEL", setLink = 20, setInputType = "MODEL", getOutType = "MODEL", extraSets = [] } = {}) => ({
  nodes: [
    { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
    setNodeOf(11, "MODEL", setLink, setInputType),
    ...extraSets.map(([id, key]) => setNodeOf(id, key, 30 + id)),
    getNodeOf(12, getKey, getOutType),
    { id: 3, type: "Sink", inputs: [{ name: "model", link: 21, type: getOutType }] },
  ],
  links: [
    ...(setLink === null ? [] : [[20, 1, 0, 11, 0, setInputType]]),
    ...extraSets.map(([id]) => [30 + id, 1, 0, id, 0, "MODEL"]),
    [21, 12, 0, 3, 0, getOutType],
  ],
});

test("pull：同名 Set 唯一 → 下游直指 Set 的上游真实源，Set/Get 都不进 prompt", () => {
  const o = convertUiToApi(setGetWf(), OBJ, { adapters: SETGET });
  assert.deepEqual(Object.keys(o).sort(), ["1", "3"]);
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
});

test("pull：0 个候选 → warning 点名节点与名字，下游走既有「连线缺失」", () => {
  const warnings = [];
  assert.throws(
    () => convertUiToApi(setGetWf({ getKey: "CLIP" }), OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
  );
  assert.ok(warnings.some((w) => /#12/.test(w) && /CLIP/.test(w)), `缺少 0 候选告警：${JSON.stringify(warnings)}`);
});

test("pull：取不到名字（keyPath 解析不到值）→ warning + 下游连线缺失", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 12).widgets_values = [];
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /连线缺失（link 21）/,
  );
  assert.ok(warnings.some((w) => /取不到名字/.test(w)), `缺少取不到名字的告警：${JSON.stringify(warnings)}`);
});

test("pull：同名 Set 不唯一 → 整份拒绝并点名每个候选 id（不猜）", () => {
  const wf = setGetWf({ extraSets: [[23, "MODEL"]] });
  assert.throws(() => convertUiToApi(wf, OBJ, { adapters: SETGET }), (err) => {
    // 候选枚举顺序不属于契约：只要求文案点名「同名多候选」并包含两个 id，允许任意排列
    assert.match(err.message, /同一个名字「MODEL」对应多个 SetNode 节点（#[^）]*）/);
    assert.match(err.message, /#11/);
    assert.match(err.message, /#23/);
    return true;
  });
});

test("pull：输出槽与取源槽类型不兼容 → 整份拒绝并写明两边类型与节点", () => {
  const wf = setGetWf({ getOutType: "IMAGE", setInputType: "MODEL" });
  assert.throws(() => convertUiToApi(wf, OBJ, { adapters: SETGET }), (err) => {
    assert.match(err.message, /类型不兼容/);
    assert.match(err.message, /#12/);
    assert.match(err.message, /IMAGE/);
    assert.match(err.message, /MODEL/);
    return true;
  });
});

test('pull：类型校验中 `*` 任一侧视为通配，不拒绝', () => {
  const o = convertUiToApi(setGetWf({ getOutType: "*" }), OBJ, { adapters: SETGET });
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
});

test("pull：配对的 Set 源槽悬空 → warning + 下游连线缺失", () => {
  const warnings = [];
  assert.throws(
    () => convertUiToApi(setGetWf({ setLink: null }), OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /连线缺失（link 21）/,
  );
  assert.ok(warnings.some((w) => /悬空/.test(w) && /#11/.test(w)), `缺少悬空告警：${JSON.stringify(warnings)}`);
});

test("pull 链式：Set ← 另一个 Get ← 另一个 Set，一路解到最上游 SRC", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
      setNodeOf(15, "B", 21),
      getNodeOf(14, "B"),
      setNodeOf(11, "A", 20),
      getNodeOf(12, "A"),
      { id: 3, type: "Sink", inputs: [{ name: "model", link: 22, type: "MODEL" }] },
    ],
    links: [
      [21, 1, 0, 15, 0, "MODEL"],
      [20, 14, 0, 11, 0, "MODEL"],
      [22, 12, 0, 3, 0, "MODEL"],
    ],
  };
  const o = convertUiToApi(wf, OBJ, { adapters: SETGET });
  assert.deepEqual(Object.keys(o).sort(), ["1", "3"]);
  assert.deepEqual(o["3"].inputs.model, ["1", 0], "A → Set#11 → Get#14 → Set#15 → SRC#1");
});

test("pull 成环：Set 的源又来自同一个 Get → 不猜源，按连线缺失处理", () => {
  const wf = {
    nodes: [
      setNodeOf(11, "A", 20),
      getNodeOf(12, "A"),
      { id: 3, type: "Sink", inputs: [{ name: "model", link: 21, type: "MODEL" }] },
    ],
    links: [
      [20, 12, 0, 11, 0, "MODEL"],
      [21, 12, 0, 3, 0, "MODEL"],
    ],
  };
  assert.throws(() => convertUiToApi(wf, OBJ, { adapters: SETGET }), /连线缺失（link 21）/);
});

test("pull 节点被 mute：恒按 skip（断链），不按名取源", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 12).mode = 2;
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /连线缺失（link 21）/,
  );
  assert.ok(warnings.some((w) => /mode 2/.test(w) && /pull/.test(w)), `缺少 mute 告警：${JSON.stringify(warnings)}`);
  // 对照：同一个 Get 在 mode 0 下确实展开
  assert.deepEqual(convertUiToApi(setGetWf(), OBJ, { adapters: SETGET })["3"].inputs.model, ["1", 0]);
});

test("pull 缺 virtual：warn 并丢弃 pull，退回普通节点路径（GetNode 不在 /object_info）", () => {
  const warnings = [];
  assert.throws(
    () =>
      convertUiToApi(setGetWf(), OBJ, {
        onWarning: (w) => warnings.push(w),
        adapters: { SetNode: { virtual: true }, GetNode: { pull: SETGET.GetNode.pull } },
      }),
    /类型 GetNode 不在 \/object_info/,
  );
  assert.ok(warnings.some((w) => /pull 需要配合 virtual/.test(w)), `缺少缺 virtual 的告警：${JSON.stringify(warnings)}`);
});

test("pull 与 passthrough 同声明：warn 并丢弃 passthrough（pull 优先）", () => {
  const warnings = [];
  const o = convertUiToApi(setGetWf(), OBJ, {
    onWarning: (w) => warnings.push(w),
    adapters: { ...SETGET, GetNode: { ...SETGET.GetNode, passthrough: true } },
  });
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
  assert.ok(warnings.some((w) => /同时声明了 pull 与 passthrough/.test(w)), `缺少冲突告警：${JSON.stringify(warnings)}`);
});

test("pull 规则形态/路径非法：warn 并丢弃该规则（不回退成穿透）", () => {
  const warnings = [];
  const base = SETGET.GetNode.pull;
  for (const [pull, re] of [
    [{ ...base, sourcePath: "inputs[a]" }, /sourcePath 需要/],
    [{ ...base, keyPath: 3 }, /keyPath 需要/],
    [{ ...base, fromType: [] }, /fromType 需要非空字符串数组/],
    [{ ...base, keyPath: [] }, /keyPath 需要/],
    [{ ...base, fromKeyPath: [1, 2] }, /fromKeyPath 需要/],
    ["SetNode", /需要对象/],
  ]) {
    const w = [];
    assert.throws(
      () => convertUiToApi(setGetWf(), OBJ, { onWarning: (m) => w.push(m), adapters: { SetNode: { virtual: true }, GetNode: { virtual: true, pull } } }),
      /连线缺失（link 21）/,
      `pull=${JSON.stringify(pull)} 丢弃后 GetNode 仍虚拟，下游应连线缺失`,
    );
    assert.ok(w.some((m) => re.test(m)), `pull=${JSON.stringify(pull)} 缺少告警 ${re}：${JSON.stringify(w)}`);
    warnings.push(...w);
  }
  assert.ok(warnings.length > 0);
});

test("反向自检：同一份样本去掉 pull 规则就回到「GetNode 不在 /object_info」", () => {
  const wf = setGetWf();
  assert.deepEqual(convertUiToApi(wf, OBJ, { adapters: SETGET })["3"].inputs.model, ["1", 0], "有 pull 时必须展开");
  // 只留 SetNode 的 virtual：GetNode 回到普通节点路径，被 /object_info 拒
  assert.throws(
    () => convertUiToApi(wf, OBJ, { adapters: { SetNode: { virtual: true } } }),
    /节点 #12 类型 GetNode 不在 \/object_info/,
  );
  // 完全无档案：同样拒绝（证明展开来自 pull 规则，不是样本本身能过）
  assert.throws(() => convertUiToApi(wf, OBJ), /类型 GetNode 不在 \/object_info/);
});

test("有 pull 档案但图里没有 Set/Get：输出与无档案完全一致", () => {
  const wf = dynSlotWf();
  const base = convertUiToApi(wf, OBJ);
  assert.deepEqual(convertUiToApi(wf, OBJ, { adapters: SETGET }), base);
});

// ── 九、pull 口径修补（2026-10-31 复核）：mode 4 语义 / 配对节点静音旁路 / 预扫收窄 / 路径数组回退 ──

test("P1：pull 节点被 bypass（mode 4）→ 名字视为无值（断链）+ warning", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 12).mode = 4;
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
    "mode 4 的 Get 必须按断链处理，不能让产物接着 Set 的上游",
  );
  assert.ok(
    warnings.some((w) => /#12/.test(w) && /mode 4/.test(w) && /断链/.test(w)),
    `缺少「Get 被旁路，按断链处理」的告警：${JSON.stringify(warnings)}`,
  );
  // 对照：同一个 Get 在 mode 0 下确实展开（证明断链来自 mode 4 分支，不是样本本身取不到源）
  assert.deepEqual(convertUiToApi(setGetWf(), OBJ, { adapters: SETGET })["3"].inputs.model, ["1", 0]);
});

test('P1：pull 节点 mode 4 且档案写 bypass="passthrough" → 仍断链，且多一条「无输入槽」warning', () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 12).mode = 4;
  const adapters = { ...SETGET, GetNode: { ...SETGET.GetNode, bypass: "passthrough" } };
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
    "穿透对无输入槽的 Get 无意义：仍须断链，不许把 Set 的上游接过来",
  );
  // 两条都针对 #12：第一条「被旁路按断链」，第二条「穿透无意义」（后者不重复 mode 4 字样，一并筛进来）
  const about12 = warnings.filter((w) => /#12/.test(w) && /(mode 4|bypass=)/.test(w));
  assert.equal(about12.length, 2, `应恰好两条 mode 4 告警：${JSON.stringify(warnings)}`);
  assert.ok(
    about12.some((w) => /无输入槽/.test(w) && /按断链处理/.test(w)),
    `缺少「无输入槽，穿透对它无意义」的告警：${JSON.stringify(about12)}`,
  );
});

test("P2：配对的 Set 被静音（mode 2）→ 值不可用 + warning", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 11).mode = 2;
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: SETGET }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
  );
  assert.ok(
    warnings.some((w) => /同名 Set 节点 #11/.test(w) && /静音\/旁路/.test(w) && /值不可用/.test(w)),
    `缺少配对节点静音的告警：${JSON.stringify(warnings)}`,
  );
});

test("P2：配对的 Set 被旁路（mode 4）→ 值不可用 + warning", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 11).mode = 4;
  // Set 自己给 bypass:"skip"，把「mode 4 节点一律拒绝」的旧路径让开，单独验 pull 侧的判定
  const adapters = { SetNode: { virtual: true, bypass: "skip" }, GetNode: SETGET.GetNode };
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
  );
  assert.ok(
    warnings.some((w) => /同名 Set 节点 #11/.test(w) && /静音\/旁路（mode 4）/.test(w) && /值不可用/.test(w)),
    `缺少配对节点旁路的告警：${JSON.stringify(warnings)}`,
  );
});

test("P3：同名多候选而 Get 没有下游 → 仍整份拒绝；孤立 Get 不产出「连线缺失」误导文案", () => {
  // ① 预扫守门：Get #12 没有任何下游消费，同名 Set 仍有两个 → 必须整份拒绝
  const wf = {
    nodes: [
      { id: 1, type: "SRC", inputs: [], outputs: [out("", "MODEL")] },
      setNodeOf(11, "MODEL", 20),
      setNodeOf(23, "MODEL", 31),
      getNodeOf(12, "MODEL"),
    ],
    links: [
      [20, 1, 0, 11, 0, "MODEL"],
      [31, 1, 0, 23, 0, "MODEL"],
    ],
  };
  assert.throws(() => convertUiToApi(wf, OBJ, { adapters: SETGET }), (err) => {
    assert.match(err.message, /同一个名字「MODEL」对应多个 SetNode 节点（#[^）]*）/);
    assert.match(err.message, /#11/);
    assert.match(err.message, /#23/);
    return true;
  });
  // ② 孤立 Get 配对到悬空 Set：唯一候选 → 不解析、不产出「下游连线缺失」类告警
  const w2 = [];
  const wf2 = { nodes: [setNodeOf(11, "MODEL", null), getNodeOf(12, "MODEL")], links: [] };
  assert.deepEqual(convertUiToApi(wf2, OBJ, { onWarning: (w) => w2.push(w), adapters: SETGET }), {});
  assert.deepEqual(w2, [], `孤立 Get 不应产生任何告警：${JSON.stringify(w2)}`);
});

const KEYFALLBACK = {
  SetNode: { virtual: true },
  GetNode: {
    virtual: true,
    pull: {
      keyPath: ["widgets_values_named.key", "widgets_values[0]"],
      fromType: ["SetNode"],
      fromKeyPath: "widgets_values[0]",
      sourcePath: "inputs[0]",
    },
  },
};

test("P4：keyPath 数组回退——named 缺失回退位置取值，named 存在时 named 优先", () => {
  // ① named 缺失 → 回退 widgets_values[0]
  assert.deepEqual(
    convertUiToApi(setGetWf(), OBJ, { adapters: KEYFALLBACK })["3"].inputs.model,
    ["1", 0],
    "named 缺失时必须回退位置取值",
  );
  // ② named 存在 → named 优先（位置值写另一个名字，按位置会 0 候选）
  const wf2 = setGetWf();
  const g = wf2.nodes.find((n) => n.id === 12);
  g.widgets_values = ["OTHER"];
  g.widgets_values_named = { key: "MODEL" };
  assert.deepEqual(
    convertUiToApi(wf2, OBJ, { adapters: KEYFALLBACK })["3"].inputs.model,
    ["1", 0],
    "named 必须排在位置之前",
  );
  // ③ fromKeyPath 同样支持数组（named 在 Set 侧，位置值是过期名字）
  const wf3 = setGetWf();
  const s = wf3.nodes.find((n) => n.id === 11);
  s.widgets_values = ["STALE"];
  s.widgets_values_named = { key: "MODEL" };
  const adapters3 = {
    SetNode: { virtual: true },
    GetNode: {
      ...KEYFALLBACK.GetNode,
      pull: { ...KEYFALLBACK.GetNode.pull, fromKeyPath: ["widgets_values_named.key", "widgets_values[0]"] },
    },
  };
  assert.deepEqual(
    convertUiToApi(wf3, OBJ, { adapters: adapters3 })["3"].inputs.model,
    ["1", 0],
    "fromKeyPath 也须支持数组回退",
  );
});

test("P4：keyPath 数组两项都取不到 → warning + 无源（下游连线缺失）", () => {
  const wf = setGetWf();
  wf.nodes.find((n) => n.id === 12).widgets_values = [];
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w), adapters: KEYFALLBACK }),
    /节点 #3 输入 model 的连线缺失（link 21）/,
  );
  assert.ok(
    warnings.some((w) => /取不到名字/.test(w) && /widgets_values_named\.key \| widgets_values\[0\]/.test(w)),
    `缺少取不到名字的告警（且应列出两条回退路径）：${JSON.stringify(warnings)}`,
  );
});
