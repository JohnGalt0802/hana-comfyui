// app/lib/node-adapter.test.mjs — 节点适配规则引擎（adapters）契约
// 运行：node --test app/lib/node-adapter.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { convertUiToApi, expandSubgraphs } from "./workflow-tools.mjs";

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

test("无 adapters 时静音/旁路不再拒绝：mode 2/4 由 mode 预扫按 ComfyUI 语义处理（2026-10-31）", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", inputs: [] },
      { id: 2, type: "Opt", mode: 4, inputs: [{ name: "model", link: 10, type: "MODEL" }], outputs: [out("model", "MODEL")] },
    ],
    links: [[10, 1, 0, 2, 0, "MODEL"]],
  };
  // 孤立旁路节点（无下游）：不再整份拒绝；带或不带无关档案行为一致
  for (const adapters of [undefined, { Nope: { virtual: true } }]) {
    const warnings = [];
    const o = convertUiToApi(wf, OBJ, { adapters, onWarning: (w) => warnings.push(w) });
    assert.equal("2" in o, false, "旁路节点不进 prompt");
    assert.ok(warnings.some((w) => /旁路（mode 4）/.test(w)), `缺少旁路 warning：${JSON.stringify(warnings)}`);
  }
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

test("mode 2(mute) 无档案：mode 预扫按断链处理（不再拒绝）", () => {
  const warnings = [];
  // 下游消费被断的连线：仍报「连线缺失」，但文案补上引擎真实知道的原因（上游被静音）
  assert.throws(
    () => convertUiToApi(bypassWf(2), OBJ, { adapters: { Opt: {} }, onWarning: (w) => warnings.push(w) }),
    /连线缺失（link 11）；上游 #2 Opt 处于静音（mode 2），不执行/,
  );
  assert.ok(warnings.some((w) => /静音（mode 2）/.test(w)), `缺少静音 warning：${JSON.stringify(warnings)}`);
});

test("bypass 对象形式 { mute, bypass } 已废弃：warn 后忽略，mode 4 回落默认穿透语义", () => {
  const warnings = [];
  const o = convertUiToApi(bypassWf(4), OBJ, {
    onWarning: (w) => warnings.push(w),
    adapters: { Opt: { bypass: { mute: "skip", bypass: "passthrough" } } },
  });
  assert.equal("2" in o, false);
  assert.deepEqual(o["3"].inputs.model, ["1", 0], "档案非法时 mode 4 按默认语义穿透，不再拒绝");
  assert.ok(warnings.some((w) => /不接受 \{ mute, bypass \} 对象形式/.test(w)), `缺少废弃告警：${JSON.stringify(warnings)}`);
});

// ── 四'、mode 预扫（2026-10-31）：无档案的静音/旁路按 ComfyUI 语义处理 ─────────

// ① 旁路链 A→B(mode 4，同名同类型单输入)→C：产物里 C 的输入直指 A。
// 挂点：删掉 mode 预扫里 mode===4 分支的 passthroughIds.add(id)（本用例改回整份拒绝即挂）。
test("① 无档案 bypass(mode 4)：同名同类型单输入 → 按类型穿透，下游直指上游", () => {
  const warnings = [];
  const o = convertUiToApi(bypassWf(4), OBJ, { onWarning: (w) => warnings.push(w) });
  assert.equal("2" in o, false, "旁路节点不进 prompt");
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
  assert.ok(warnings.some((w) => /旁路（mode 4）/ .test(w) && /#2/.test(w)));
});

// ② 旁路节点两个同类型输入且名字对不上 → 整份拒绝，文案含「歧义」（沿用 pickEntry 的歧义拒绝）。
// 挂点：pickEntry 末尾的歧义返回（或 mode 预扫不再把旁路节点注册进 passthroughIds）都会让本用例挂。
test("② 无档案 bypass(mode 4)：两个同类型输入无法按名字确定 → 整份拒绝含「歧义」", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", inputs: [], outputs: [out("out", "MODEL")] },
      { id: 2, type: "SRC", inputs: [], outputs: [out("out", "MODEL")] },
      {
        id: 3, type: "Opt", mode: 4,
        inputs: [
          { name: "model_a", type: "MODEL", link: 10 },
          { name: "model_b", type: "MODEL", link: 11 },
        ],
        outputs: [out("model", "MODEL")],
      },
      { id: 4, type: "Sink", inputs: [{ name: "model", link: 12, type: "MODEL" }] },
    ],
    links: [
      [10, 1, 0, 3, 0, "MODEL"],
      [11, 2, 0, 3, 1, "MODEL"],
      [12, 3, 0, 4, 0, "MODEL"],
    ],
  };
  assert.throws(() => convertUiToApi(wf, OBJ), /歧义映射/);
});

// ③ 旁路一个无输入的 Loader → 下游连线缺失，且文案点明上游处于旁路（机器归因，非编造）。
// 挂点：删掉 bypassWhy 归因循环（pickEntry 之后的逐输出槽实算）或 deadWhy 的 precise 分支，文案退回无后缀即挂。
test("③ 无档案 bypass(mode 4)：无输入 Loader → 下游连线缺失且点明上游旁路", () => {
  const wf = {
    nodes: [
      { id: 2, type: "CheckpointLoaderSimple", mode: 4, inputs: [], outputs: [out("MODEL", "MODEL")] },
      { id: 3, type: "Sink", inputs: [{ name: "model", link: 11, type: "MODEL" }] },
    ],
    links: [[11, 2, 0, 3, 0, "MODEL"]],
  };
  assert.throws(
    () => convertUiToApi(wf, OBJ),
    /连线缺失（link 11）；上游 #2 CheckpointLoaderSimple 处于旁路（mode 4）且没有任何输入/,
  );
});

// ④ 静音一个无人消费的节点 → 整份转换成功（不再整份拒绝）。
// 挂点：恢复主循环的「mode === 2 → problems.push（整份拒绝）」即挂。
test("④ 无档案 mute(mode 2)：无人消费的静音节点 → 转换成功", () => {
  const wf = {
    nodes: [{ id: 1, type: "SRC", mode: 2, inputs: [], outputs: [out("out", "MODEL")] }],
    links: [],
  };
  const warnings = [];
  const o = convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(o, {}, "静音节点不进 prompt，转换成功");
  assert.ok(warnings.some((w) => /静音（mode 2）/.test(w) && /#1/.test(w)));
});

// ⑤ 静音一个喂必填输入的节点 → 报错，文案点明上游被静音（与 ComfyUI required_input_missing 同向）。
// 挂点：删掉 deadWhy 的 modeDrop 回退分支，文案退回「连线缺失（link 11）」无后缀即挂。
test("⑤ 无档案 mute(mode 2)：下游必填输入被断 → 报错且点明上游被静音", () => {
  assert.throws(
    () => convertUiToApi(bypassWf(2), OBJ),
    /连线缺失（link 11）；上游 #2 Opt 处于静音（mode 2），不执行/,
  );
});

// ⑥ 档案显式 bypass:"skip"/"passthrough" 仍按档案生效（回归：mode 预扫不得重复登记或改判）。
// 挂点：mode 预扫里删掉 droppedIds.has(id) 的跳过判断（对已登记节点重复登记）——虽然产物相同，
// 但 warning 会翻倍；或改掉档案分支本身，下面两个断言即挂。
test("⑥ 档案 bypass:"+"\"skip\"/\"passthrough\" 仍按档案生效（回归）", () => {
  assert.throws(
    () => convertUiToApi(bypassWf(4), OBJ, { adapters: { Opt: { bypass: "skip" } } }),
    /连线缺失（link 11）；上游 #2 Opt 处于旁路（mode 4），按档案跳过/,
    "skip：下游连线缺失，后缀归因来自档案分支的 modeDrop 登记（预扫不重复登记）",
  );
  const o = convertUiToApi(bypassWf(4), OBJ, { adapters: { Opt: { bypass: "passthrough" } } });
  assert.deepEqual(o["3"].inputs.model, ["1", 0]);
});

// ⑦ 全图 mode 0 → 输出与改动前逐字相同（golden 快照：mode 0 从不走预扫分支，主循环未动）。
// 挂点：mode 预扫若误把 mode 0 当作待处理（如分支条件写成 mode !== 2 而漏判 0），产物多出 warning/节点即挂。
test("⑦ 全图 mode 0：输出与改动前逐字相同", () => {
  const warnings = [];
  const o = convertUiToApi(bypassWf(0), OBJ, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(o, {
    "1": { class_type: "SRC", inputs: {} },
    "2": { class_type: "Opt", inputs: { model: ["1", 0] } },
    "3": { class_type: "Sink", inputs: { model: ["2", 0] } },
  });
  assert.deepEqual(warnings, []);
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

// ═════════════════════════════════════════════════════════════════════════════
// ── 子图（subgraph）展开 v1 ─────────────────────────────────────────────────
// 口径：单层展开、接口直连、widget 值要么正确传递要么整份拒绝；口径没覆盖的情形
// 一律拒绝并点名；无 definitions.subgraphs / 无实例时输出与改动前逐字一致。
// ═════════════════════════════════════════════════════════════════════════════

// 真实样本（本机 ComfyUI 用户工作流；不在的环境整节跳过）
const REAL_SAMPLE = "D:\\ComfyUI\\ComfyUI\\user\\default\\workflows\\image_moss_image_t2i.json";
const realWf = (() => {
  try {
    return JSON.parse(readFileSync(REAL_SAMPLE, "utf8"));
  } catch {
    return null;
  }
})();

// 真实样本的 /object_info（手工收窄到样本用到的类型；只覆盖断言涉及的键与必需形态）
const realObj = {
  SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } } },
  PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } } },
  TextGenerate: { input: {} },
  UNETLoader: { input: { required: { unet_name: [["x.safetensors"], {}], weight_dtype: [["default"], {}] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP", {}] } } },
  CLIPLoader: { input: { required: { clip_name: [["y.safetensors"], {}], type: [["default"], {}], device: [["default"], {}] } } },
  KSampler: {
    input: {
      required: {
        model: ["MODEL", {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}],
        seed: ["INT", {}], steps: ["INT", {}], cfg: ["FLOAT", {}], sampler_name: [["er_sde"], {}], scheduler: [["simple"], {}], denoise: ["FLOAT", {}],
      },
    },
  },
  VAELoader: { input: { required: { vae_name: [["z.safetensors"], {}] } } },
  PreviewAny: { input: { required: { source: ["*", {}] } } },
  ComfySwitchNode: { input: { required: { on_false: ["*", {}], on_true: ["*", {}], switch: ["BOOLEAN", {}] } } },
  EmptyFlux2LatentImage: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } } },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } } },
  SkipLayerGuidanceDiTSimple: { input: {} },
  ResolutionSelector: { input: { required: { resolution: [["1024 x 1024"], {}], upscale: [["1"], {}], rounding: [["nearest"], {}] } } },
  MarkdownNote: { input: {} },
};

// 合成样本脚手架：子图「sg1」= IN(值) → P1（widget value）→ OUT；外部 SRC → 实例 → Sink
const sgObj = { ...OBJ, P1: { input: { required: { value: ["STRING", {}] } } }, Mid: { input: { required: { image: ["IMAGE", {}] } } } };
const sgDef = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "sg1",
  inputNode: { id: -10 },
  outputNode: { id: -20 },
  inputs: [{ id: "u-in-0", name: "value", type: "STRING", label: "", linkIds: [25], pos: [0, 0] }],
  outputs: [{ id: "u-out-0", name: "IMAGE", type: "IMAGE", linkIds: [6], pos: [0, 0] }],
  widgets: [],
  nodes: [
    { id: 1, type: "P1", mode: 0, inputs: [{ name: "value", type: "STRING", widget: { name: "value" }, link: 25 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [26] }], widgets_values: ["old-inner"], widgets_values_named: { value: "old-inner" } },
    { id: 2, type: "Mid", mode: 0, inputs: [{ name: "image", type: "IMAGE", link: 26 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [6] }], widgets_values: [] },
  ],
  links: [
    { id: 25, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: "STRING" },
    { id: 26, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
    { id: 6, origin_id: 2, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
  ],
  ...over,
});
const sgWf = (over = {}) => ({
  nodes: [
    { id: 9, type: "SRC", mode: 0, inputs: [], outputs: [{ name: "", type: "IMAGE", links: [10] }] },
    { id: 18, type: "11111111-1111-1111-1111-111111111111", mode: 0, inputs: [{ label: "", name: "value", type: "STRING", widget: { name: "value" }, link: null }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }], widgets_values: ["hello"] },
    { id: 30, type: "Sink", mode: 0, inputs: [{ name: "model", link: 11, type: "IMAGE" }] },
  ],
  links: [
    [11, 18, 0, 30, 0, "IMAGE"],
  ],
  definitions: { subgraphs: [sgDef()] },
  ...over,
});

test("子图：真实样本展开——节点数、实例消失、s18: 前缀、外部输出连线指到内部生产者", (t) => {
  if (!realWf) t.skip("真实样本不存在（D:\\ComfyUI 未检出）");
  const expanded = expandSubgraphs(realWf, []);
  const sg = realWf.definitions.subgraphs[0];
  assert.equal(expanded.nodes.length, realWf.nodes.length - 1 + sg.nodes.length);
  assert.ok(!expanded.nodes.some((n) => String(n.type) === sg.id), "实例节点应消失");
  const inner = expanded.nodes.filter((n) => String(n.id).startsWith("s18:"));
  assert.equal(inner.length, sg.nodes.length);
  const prod = expanded.nodes.find((n) => n.id === "s18:8"); // VAEDecode 是实例输出 0 的生产者
  assert.ok(prod);
  // SaveImage(#9) 的输入应直连 s18:8:0
  const l9 = expanded.links.find((l) => Array.isArray(l) && l[3] === 9);
  assert.deepEqual([l9[1], l9[2]], ["s18:8", 0]);
  // 外部连线 40/41（#19 → 实例 18 的 width/height 槽）应直连到 s18:6 对应槽
  const l40 = expanded.links.find((l) => Array.isArray(l) && l[0] === 40);
  assert.equal(l40[3], "s18:6");
  assert.equal(l40[4], 0); // width
  const l41 = expanded.links.find((l) => Array.isArray(l) && l[0] === 41);
  assert.equal(l41[4], 1); // height
});

test("子图：真实样本端到端转换——实例 widgets_values 传递到内部节点（named 与位置同步写）", (t) => {
  if (!realWf) t.skip("真实样本不存在");
  const prompt = convertUiToApi(realWf, realObj, { onWarning: () => {} });
  // KSampler(s18:7)：实例值 25/2.5/"er_sde"/"simple" 应盖过子图内旧值；seed 槽被外部连线占用（连线值优先）
  const ks = prompt["s18:7"].inputs;
  assert.equal(ks.steps, 25);
  assert.equal(ks.cfg, 2.5);
  assert.equal(ks.sampler_name, "er_sde");
  assert.equal(ks.scheduler, "simple");
  // seed 槽无外部连线（实例 18 的 seed 输入 link=null）：实例值 333599710072681 直接传递
  assert.equal(ks.seed, 333599710072681);
  // 实例值确实盖过子图内的旧值（CLIPTextEncode 的 text：named 有键「text」）
  assert.notEqual(prompt["s18:5"].inputs.text, undefined);
  assert.equal(prompt["s18:1"].inputs.unet_name, "moss_image_sft_int8_convrot.safetensors");
  // 输出侧：SaveImage #9 的 images 指到内部生产者；实例 18 不在 prompt 里
  assert.deepEqual(prompt["9"].inputs.images, ["s18:8", 0]);
  assert.ok(!prompt["18"]);
});

test("子图：正常展开 + widget 传递（合成样本）", () => {
  const prompt = convertUiToApi(sgWf(), sgObj);
  assert.ok(prompt["s18:1"]);
  assert.equal(prompt["s18:1"].inputs.value, "hello"); // 实例值覆盖内部旧值 "old-inner"
  assert.deepEqual(prompt["s18:2"].inputs.image, ["s18:1", 0]); // 内部连线重映射后照常收编
  assert.deepEqual(prompt["30"].inputs.model, ["s18:2", 0]); // 输出接口直连到内部生产者
});

test("子图：内部链接重映射正确（节点槽上的 link 字段与 links 数组一致）", () => {
  const expanded = expandSubgraphs(sgWf(), []);
  const p1 = expanded.nodes.find((n) => n.id === "s18:1");
  const p2 = expanded.nodes.find((n) => n.id === "s18:2");
  assert.equal(p1.id, "s18:1"); // 节点 id 本体已重映射
  // 接口输入链接（-10→P1）已被消化：无外部连线时 link 保持 null（走 widget 值），不残留旧 id
  assert.equal(p1.inputs[0].link, null);
  // 内部→内部连线：P1 输出槽 links 数组与 P2 输入槽 link 字段都指向重映射 id，双向一致
  assert.equal(p2.inputs[0].link, "s18L26");
  assert.deepEqual(p1.outputs[0].links, ["s18L26"]);
  const internal = expanded.links.find((l) => Array.isArray(l) && l[0] === "s18L26");
  assert.deepEqual(internal.slice(1), ["s18:1", 0, "s18:2", 0, "IMAGE"]);
  // 注：-10/-20 端点不应保留（接口连线已被消化）
  assert.ok(!expanded.links.some((l) => Array.isArray(l) && (l[1] === -10 || l[3] === -10 || l[1] === -20 || l[3] === -20)));
  // 外部连线 11（实例 → Sink）改接到内部生产者
  const l11 = expanded.links.find((l) => Array.isArray(l) && l[0] === 11);
  assert.deepEqual([l11[1], l11[2]], ["s18:2", 0]);
});

test("子图：嵌套子图 → 整份拒绝，点名子图名与内部节点 id", () => {
  const wf = sgWf();
  wf.definitions.subgraphs[0].nodes.push({
    id: 2, type: "22222222-2222-2222-2222-222222222222", mode: 0, inputs: [], outputs: [],
    widgets_values: [],
  });
  wf.definitions.subgraphs.push({ ...sgDef(), id: "22222222-2222-2222-2222-222222222222", name: "inner-sg", nodes: [], links: [] });
  assert.throws(() => convertUiToApi(wf, sgObj), (e) => /不支持嵌套/.test(e.message) && /sg1/.test(e.message) && /#2/.test(e.message));
});

test("子图：实例 mode 4（旁路）/ mode 2（静音）→ 整份拒绝", () => {
  const wf = sgWf();
  wf.nodes[1].mode = 4;
  assert.throws(() => convertUiToApi(wf, sgObj), /静音\/旁路/);
  wf.nodes[1].mode = 2;
  assert.throws(() => convertUiToApi(wf, sgObj), /静音\/旁路/);
});

test("子图：widget 值无法定位且与现值不同 → 整份拒绝", () => {
  const wf = sgWf();
  // 目标节点去掉 widgets_values_named 且 widgets_values 为空 → 现值定位不到
  delete wf.definitions.subgraphs[0].nodes[0].widgets_values_named;
  wf.definitions.subgraphs[0].nodes[0].widgets_values = [];
  assert.throws(() => convertUiToApi(wf, sgObj), /无法定位/);
});

test("子图：widget 值与现值相同 → 放行且不写入", () => {
  const wf = sgWf();
  wf.nodes[1].widgets_values = ["old-inner"]; // 与内部现值一致
  const prompt = convertUiToApi(wf, sgObj);
  assert.equal(prompt["s18:1"].inputs.value, "old-inner");
  // 相同值不写入：子图定义里的内部节点保持原样
  const p1 = wf.definitions.subgraphs[0].nodes[0];
  assert.equal(p1.widgets_values[0], "old-inner");
  assert.equal(p1.widgets_values_named.value, "old-inner");
});

test("子图：连线值优先——外部连线占用带 widget 的槽时，实例值不传递", () => {
  const wf = sgWf();
  // 实例输入槽 0 被外部连线占用：实例 inputs[0].link 非 null + wf.links 有对应连线
  wf.nodes[1].inputs[0].link = 10;
  wf.links.unshift([10, 9, 0, 18, 0, "IMAGE"]);
  wf.nodes[1].widgets_values = ["hijack"];
  const prompt = convertUiToApi(wf, sgObj);
  assert.deepEqual(prompt["s18:1"].inputs.value, ["9", 0]); // 连线值直通，widget 值未写入
});

test("子图：无 definitions 的工作流 → 输入 wf 不被改动，expandSubgraphs 返回原引用", () => {
  const wf = { nodes: [{ id: 1, type: "SRC", inputs: [], outputs: [{ name: "", type: "IMAGE", links: [] }] }], links: [] };
  const snapshot = JSON.stringify(wf);
  const out = convertUiToApi(wf, OBJ);
  assert.equal(JSON.stringify(wf), snapshot);
  assert.ok(out["1"]);
  assert.equal(expandSubgraphs(wf, []), wf);
});

// ── 子图 widget 位序：声明序共用口径（2026-10-31 修）───────────────────────────
// P1 形态：声明含 socketless 展示件 deco 夹在 value 前；展示件不占 widgets_values 格。
const slotsObj = () => ({
  ...sgObj,
  P1: { input: { required: { deco: ["STRING", { socketless: true }], value: ["STRING", {}], steps: ["INT", {}] } } },
});
const slotsInputs = () => [
  { name: "deco", type: "STRING", widget: { name: "deco" }, link: null }, // socketless 展示件夹在最前
  { name: "value", type: "STRING", widget: { name: "value" }, link: 25 },
  { name: "steps", type: "INT", widget: { name: "steps" }, link: null },
];
// value 在内部节点槽 1（deco 占槽 0）：接口链接 25 的 target_slot 要跟着改
const slotsWf = () => {
  const wf = sgWf();
  wf.definitions.subgraphs[0].links[0].target_slot = 1;
  return wf;
};

// 守门人：槽序近似会把 deco 算进位序（value 定位到 wv[1]），声明序剔除 deco（value = wv[0]）。
test("子图：无 named 且声明含 socketless 展示件夹中间 → 位序仍按声明口径正确", () => {
  const wf = slotsWf();
  const p1 = wf.definitions.subgraphs[0].nodes[0];
  delete p1.widgets_values_named;
  p1.widgets_values = ["old-inner", 7]; // 展示件不占格：value 在 wv[0]，steps 在 wv[1]
  p1.inputs = slotsInputs();
  const out = expandSubgraphs(wf, [], slotsObj());
  assert.deepEqual(out.nodes.find((n) => n.id === "s18:1").widgets_values, ["hello", 7]);
});

test("子图：内部节点类型未知且无 named——值不同 → 拒绝，文案含键名与两边取值", () => {
  const wf = sgWf();
  const p1 = wf.definitions.subgraphs[0].nodes[0];
  p1.type = "UnknownT";
  delete p1.widgets_values_named;
  p1.widgets_values = ["old-inner"];
  const problems = [];
  expandSubgraphs(wf, problems, { ...sgObj });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /「value」/);
  assert.match(problems[0], /hello/);
  assert.match(problems[0], /old-inner/);
});

test("子图：内部节点类型未知且无 named——值相同 → 放行", () => {
  const wf = sgWf();
  const p1 = wf.definitions.subgraphs[0].nodes[0];
  p1.type = "UnknownT";
  delete p1.widgets_values_named;
  p1.widgets_values = ["hello"];
  const problems = [];
  const out = expandSubgraphs(wf, problems, { ...sgObj });
  assert.equal(problems.length, 0);
  assert.equal(out.nodes.find((n) => n.id === "s18:1").widgets_values[0], "hello");
});

test("子图：主循环与展开共用同一份声明位序——同一 object_info、同一节点形态两边位序一致", () => {
  const obj = slotsObj();
  // 主循环侧：同形态 P1 独立节点（无 named → 位置回退），value 取自声明位 0（展示件不占格）
  const mainWf = {
    nodes: [{ id: 1, type: "P1", mode: 0, inputs: slotsInputs().map((s) => ({ ...s, link: null })), widgets_values: ["ov", 7] }],
    links: [],
  };
  const prompt = convertUiToApi(mainWf, obj);
  assert.equal(prompt["1"].inputs.value, "ov");
  // 展开侧：同形态节点作子图内部节点（无 named），实例值写入也命中声明位 0
  const wf = slotsWf();
  const p1 = wf.definitions.subgraphs[0].nodes[0];
  delete p1.widgets_values_named;
  p1.widgets_values = ["ov", 7];
  p1.inputs = slotsInputs();
  const out = expandSubgraphs(wf, [], obj);
  const tp = out.nodes.find((n) => n.id === "s18:1");
  assert.equal(tp.widgets_values[0], "hello");
  assert.equal(tp.widgets_values[1], 7);
});

// ── 子图对位按名字（2026-10-31 修）───────────────────────────────────────
// 背景：实例槽下标 ≠ 定义下标（实例只暴露部分输入、槽序也可不同），旧实现拿实例槽下标 k 直接
// 当 -10 槽号与 widgets_values[k] 下标，接线与参数全错（minimax 三模板同型事故）。
// 修后对位一律走名字：实例槽名 / named 键 → 定义输入名 → 定义下标 → -10 链接；下标只作
// widgets_values 的位置回退（序 = 定义 widget 输入按定义序，数量必须一致）。

const MINIMAX_T2V = "D:\\ComfyUI\\ComfyUI\\user\\default\\workflows\\minimax_h3_t2v_int8.json";
const minimaxWf = (() => {
  try {
    return JSON.parse(readFileSync(MINIMAX_T2V, "utf8"));
  } catch {
    return null;
  }
})();

// ① 真实样本：width/height 接到 131:5/131:6；loader 值各落各位，无错位。
//    挂点：删掉阶段二里「实例槽名 → defByName → j」三行（改回 inputBySlot.get(k)）即挂；
//    loader 断言挂点：删掉阶段三里 named 键 → 定义下标的查找（改回 wvArr[k]）即挂。
test("子图：minimax 真实样本按名对位——width/height 接线落对、loader 值不错位", (t) => {
  if (!minimaxWf) t.skip("真实样本不存在（D:\\ComfyUI 未检出）");
  const expanded = expandSubgraphs(minimaxWf, []);
  // 实例 #140 的 width/height 是槽 2/3（带外部连线）；定义下标 3/4 → 131:5/131:6
  const l246 = expanded.links.find((l) => Array.isArray(l) && l[0] === 246);
  assert.deepEqual([l246[3], l246[4]], ["s140:131", 5], "width 外部连线应接到内部 131:5");
  const l247 = expanded.links.find((l) => Array.isArray(l) && l[0] === 247);
  assert.deepEqual([l247[3], l247[4]], ["s140:131", 6], "height 外部连线应接到内部 131:6");
  // named 按名写入：unet/vae 各落各位，绝不允许 VAE 文件名写进 unet/clip
  const unet = expanded.nodes.find((n) => n.id === "s140:127");
  assert.equal(unet.widgets_values_named.unet_name, "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
  const vaeVideo = expanded.nodes.find((n) => n.id === "s140:119");
  assert.equal(vaeVideo.widgets_values_named.vae_name, "minimax_h3_video_vae_fp16.safetensors");
  const vaeAudio = expanded.nodes.find((n) => n.id === "s140:120");
  assert.equal(vaeAudio.widgets_values_named.vae_name, "minimax_h3_audio_vae_fp32.safetensors");
  assert.ok(!expanded.nodes.some((n) => String(n.id).startsWith("s140:") && isPlainLoaderWithWrongVae(n)), "无 VAE 文件名错写进 unet/clip 的错位");
  function isPlainLoaderWithWrongVae(n) {
    const named = n.widgets_values_named;
    if (!named) return false;
    if ("unet_name" in named && String(named.unet_name).includes("vae")) return true;
    if ("clip_name" in named && String(named.clip_name).includes("video_vae")) return true;
    return false;
  }
});

// ② 2 socket + 2 widget、定义 6 输入：socket 多于 widget 的布局必须能正常转换。
//    挂点：恢复「k ≥ widgets_values 长度即拒绝」的旧卫语句即挂。
test("子图：socket 多于 widget（2 socket + 2 widget、定义 6 输入）能正常转换", () => {
  const wf = sgWf();
  const def = wf.definitions.subgraphs[0];
  // 定义 6 输入：socket img1/img2（-10 链 25/27 → 内部 Mid 两个输入）+ widget value/steps/flag/name
  def.inputs = [
    { id: "i0", name: "img1", type: "IMAGE", linkIds: [25] },
    { id: "i1", name: "img2", type: "IMAGE", linkIds: [27] },
    { id: "i2", name: "value", type: "STRING", linkIds: [] },
    { id: "i3", name: "steps", type: "INT", linkIds: [] },
    { id: "i4", name: "flag", type: "BOOLEAN", linkIds: [] },
    { id: "i5", name: "name", type: "STRING", linkIds: [] },
  ];
  const mid = def.nodes.find((n) => n.id === 2);
  mid.inputs = [
    { name: "image", type: "IMAGE", link: 26 },
    { name: "img1", type: "IMAGE", link: 25 },
    { name: "img2", type: "IMAGE", link: 27 },
  ];
  def.links = [
    { id: 25, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 1, type: "IMAGE" },
    { id: 26, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
    { id: 27, origin_id: -10, origin_slot: 1, target_id: 2, target_slot: 2, type: "IMAGE" },
    { id: 6, origin_id: 2, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
  ];
  def.nodes[0].outputs[0].links = [26];
  mid.outputs[0].links = [6];
  // 实例：槽序与定义序相反（socket 在后），只有 2 socket + 2 widget，widgets_values 4 项
  const inst = wf.nodes[1];
  inst.inputs = [
    { name: "value", type: "STRING", widget: { name: "value" }, link: null },
    { name: "steps", type: "INT", widget: { name: "steps" }, link: null },
    { name: "img2", type: "IMAGE", link: 12 },
    { name: "img1", type: "IMAGE", link: 13 },
  ];
  inst.widgets_values = ["hello", 30];
  delete inst.widgets_values_named;
  // 外部 SRC → 实例槽 3（img1）、SRC2 → 槽 2（img2）：按名应分别落到内部 2:1 / 2:2
  wf.nodes[0].outputs[0].links = [10, 14];
  wf.links = [
    [11, 18, 0, 30, 0, "IMAGE"],
    [10, 9, 0, 18, 3, "IMAGE"],
    [14, 9, 0, 18, 2, "IMAGE"],
  ];
  const expanded = expandSubgraphs(wf, []);
  const l10 = expanded.links.find((l) => Array.isArray(l) && l[0] === 10);
  assert.deepEqual([l10[3], l10[4]], ["s18:2", 1], "img1（实例槽 3）应按名接到内部 2:1");
  const l14 = expanded.links.find((l) => Array.isArray(l) && l[0] === 14);
  assert.deepEqual([l14[3], l14[4]], ["s18:2", 2], "img2（实例槽 2）应按名接到内部 2:2");
  const midNode = expanded.nodes.find((n) => n.id === "s18:2");
  assert.equal(midNode.inputs[1].link, 10);
  assert.equal(midNode.inputs[2].link, 14);
});

// ③ 实例槽名在定义里找不到 → 整份拒绝并点名。
//    挂点：删掉接线里 defByName.get(sname) === undefined 的拒绝分支即挂。
test("子图：实例槽名不在定义 inputs 里 → 整份拒绝并点名", () => {
  const wf = sgWf();
  wf.nodes[1].inputs[0].name = "renamed_slot";
  // 槽被外部连线占用时才走到名字对位的拒绝分支（无连线时值传递按定义名走，与实例槽名无关）
  wf.nodes[1].inputs[0].link = 10;
  wf.links.unshift([10, 9, 0, 18, 0, "STRING"]);
  assert.throws(() => convertUiToApi(wf, sgObj), (e) => /「renamed_slot」/.test(e.message) && /没有这个名字/.test(e.message));
});

// ④ named 与位置值分歧 → 整份拒绝（R1 同精神）。
//    挂点：删掉阶段三里 subgraphValueEq(pval, val) 分歧分支即挂。
test("子图：实例 named 与位置值对同一名字分歧 → 整份拒绝", () => {
  const wf = sgWf();
  wf.nodes[1].widgets_values_named = { value: "hello" };
  wf.nodes[1].widgets_values = ["stale-value"];
  assert.throws(() => convertUiToApi(wf, sgObj), (e) => /分歧/.test(e.message) && /hello/.test(e.message) && /stale-value/.test(e.message));
});

// ⑤ 槽序与定义序相反 → 仍按名字对位正确。
//    挂点：接线或取值任何一处改回「按下标直取」即挂。
test("子图：实例槽序与定义序相反 → 按名对位仍正确", () => {
  const wf = sgWf();
  const def = wf.definitions.subgraphs[0];
  // 定义 2 widget 输入：value（→P1.value）+ steps（→新增内部节点 P1b.steps）
  def.inputs = [
    { id: "i0", name: "steps", type: "INT", linkIds: [27] },
    { id: "i1", name: "value", type: "STRING", linkIds: [25] },
  ];
  def.nodes.push({
    id: 3, type: "P1B", mode: 0,
    inputs: [{ name: "steps", type: "INT", widget: { name: "steps" }, link: 27 }],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets_values: [7], widgets_values_named: { steps: 7 },
  });
  def.links.push({ id: 27, origin_id: -10, origin_slot: 0, target_id: 3, target_slot: 0, type: "INT" });
  def.links[0].origin_slot = 1; // value 现在是定义下标 1
  const inst = wf.nodes[1];
  // 实例槽序与定义序相反：value 在前、steps 在后；named 双写一致（位置值按定义 widget 序：steps、value）
  inst.inputs = [
    { name: "value", type: "STRING", widget: { name: "value" }, link: null },
    { name: "steps", type: "INT", widget: { name: "steps" }, link: null },
  ];
  inst.widgets_values = [30, "hello"];
  inst.widgets_values_named = { value: "hello", steps: 30 };
  const prompt = convertUiToApi(wf, { ...sgObj, P1B: { input: { required: { steps: ["INT", {}] } } } });
  assert.equal(prompt["s18:1"].inputs.value, "hello", "value 写到 P1（内部节点 1）");
  assert.equal(prompt["s18:3"].inputs.steps, 30, "steps 按名写到 P1B（内部节点 3），不因槽序颠倒而错位");
  const expanded = expandSubgraphs(wf, []);
  assert.equal(expanded.nodes.find((n) => n.id === "s18:3").widgets_values_named.steps, 30);
});

// ⑥ moss 样本回归：展开结果与 KSampler 参数不变。
//    挂点：对位逻辑任何回退（名字→下标）都会让 KSampler 参数或节点数漂移即挂。
test("子图：moss 真实样本回归——KSampler 参数与展开结构不变", (t) => {
  if (!realWf) t.skip("真实样本不存在");
  const prompt = convertUiToApi(realWf, realObj, { onWarning: () => {} });
  const ks = prompt["s18:7"].inputs;
  assert.equal(ks.seed, 333599710072681);
  assert.equal(ks.steps, 25);
  assert.equal(ks.cfg, 2.5);
  assert.equal(ks.sampler_name, "er_sde");
  assert.equal(ks.scheduler, "simple");
  assert.equal(prompt["s18:1"].inputs.unet_name, "moss_image_sft_int8_convrot.safetensors");
  assert.deepEqual(prompt["9"].inputs.images, ["s18:8", 0]);
  assert.ok(!prompt["18"]);
});

// ── 裸防线补测（2026-10-31 复验：三守卫删掉 78 全绿，无覆盖）+ 两个场景补测 ──

// M3 挂点：删掉阶段三里「无 named 且 wvArr.length !== widgetNames.length → 拒绝」分支即挂。
// 删后位置回退取 wvArr[0]，展开/转换照常成功，本用例不再 throw。
test("子图：无 named 位置回退——widgets_values 项数与定义可对位 widget 输入不符 → 整份拒绝", () => {
  const wf = sgWf();
  const inst = wf.nodes[1];
  delete inst.widgets_values_named;
  inst.widgets_values = ["hello", 30]; // 定义可对位 widget 输入只有 value 一个，给 2 项
  assert.throws(
    () => convertUiToApi(wf, sgObj),
    (e) => /数量不一致/.test(e.message) && /2 项/.test(e.message) && /有 1 个/.test(e.message) && /value/.test(e.message) && /#18/.test(e.message),
  );
});

// M4 挂点：删掉接线里 defDupNames.has(sname) 的拒绝分支即挂。
// 删后 defByName 取第一个同名，连线照常接线、转换成功，本用例不再 throw。
test("子图：定义 inputs 出现两个同名输入，外部连线指向该名字 → 整份拒绝并点名字与实例", () => {
  const wf = sgWf();
  wf.definitions.subgraphs[0].inputs.push({ id: "u-in-1", name: "value", type: "STRING", label: "", linkIds: [], pos: [0, 0] });
  wf.nodes[1].inputs[0].link = 10;
  wf.links.unshift([10, 9, 0, 18, 0, "STRING"]);
  assert.throws(
    () => convertUiToApi(wf, sgObj),
    (e) => /同名输入「value」/.test(e.message) && /连线 \[10\]/.test(e.message) && /实例 #18/.test(e.message),
  );
});

// M5 挂点：删掉接线里 usedInputs.has(j) 的拒绝分支即挂。
// 删后两条连线都接线（后者覆盖前者），转换成功，本用例不再 throw。
test("子图：同一输入被两条外部连线指向 → 整份拒绝并点名连线 id", () => {
  const wf = sgWf();
  wf.nodes[1].inputs[0].link = 10;
  wf.links.unshift([10, 9, 0, 18, 0, "STRING"], [14, 9, 0, 18, 0, "STRING"]);
  assert.throws(
    () => convertUiToApi(wf, sgObj),
    (e) => /多条外部连线/.test(e.message) && /\[10\]/.test(e.message) && /实例 #18/.test(e.message) && /「value」/.test(e.message),
  );
});

// 场景挂点：任何实例间前缀/克隆/接线串线（如内部节点共用定义原对象、link id 不带实例前缀）即挂。
test("子图：同一子图被两个实例引用——id 前缀隔离、widget 值各写各的、外部连线各指各的", () => {
  const wf = sgWf();
  wf.nodes.push({
    id: 19, type: "11111111-1111-1111-1111-111111111111", mode: 0,
    inputs: [{ label: "", name: "value", type: "STRING", widget: { name: "value" }, link: null }],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [12] }],
    widgets_values: ["world"],
  });
  wf.nodes.push({ id: 31, type: "Sink", mode: 0, inputs: [{ name: "model", link: 12, type: "IMAGE" }] });
  wf.links.push([12, 19, 0, 31, 0, "IMAGE"]);
  const prompt = convertUiToApi(wf, sgObj);
  // 两个实例各展开一份内部节点，前缀互不相同；widget 值各写各的（串线 = 克隆共享定义对象，这里直接抓）
  assert.equal(prompt["s18:1"].inputs.value, "hello");
  assert.equal(prompt["s19:1"].inputs.value, "world");
  assert.ok(!prompt["18"] && !prompt["19"]);
  // 外部连线各指各的：Sink 30 ← 实例 18 的生产者，Sink 31 ← 实例 19 的生产者
  assert.deepEqual(prompt["30"].inputs.model, ["s18:2", 0]);
  assert.deepEqual(prompt["31"].inputs.model, ["s19:2", 0]);
  const expanded = expandSubgraphs(wf, [], sgObj);
  // 内部连线 id 带实例前缀：s18L26 与 s19L26 互不混淆
  assert.ok(expanded.links.some((l) => Array.isArray(l) && l[0] === "s18L26"));
  assert.ok(expanded.links.some((l) => Array.isArray(l) && l[0] === "s19L26"));
  // 展开产物里两实例各自的内部节点 widgets_values 各写各的（串线 = 克隆共享定义数组，直接抓）
  assert.equal(expanded.nodes.find((n) => n.id === "s18:1").widgets_values[0], "hello");
  assert.equal(expanded.nodes.find((n) => n.id === "s19:1").widgets_values[0], "world");
  assert.ok(!expanded.nodes.some((n) => String(n.type) === "11111111-1111-1111-1111-111111111111"));
});

// 场景挂点：穿透改为只解一层（不对 resolveReal 结果递归）或漏登记第二个旁路节点即挂。
test("旁路：连续两个 mode 4（A → B(mode4) → C(mode4) → D），D 的输入直指 A", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", mode: 0, inputs: [], outputs: [out("MODEL", "MODEL")] },
      { id: 2, type: "Opt", mode: 4, inputs: [{ name: "model", link: 10, type: "MODEL" }], outputs: [out("MODEL", "MODEL")] },
      { id: 3, type: "Opt", mode: 4, inputs: [{ name: "model", link: 11, type: "MODEL" }], outputs: [out("MODEL", "MODEL")] },
      { id: 4, type: "Sink", mode: 0, inputs: [{ name: "model", link: 12, type: "MODEL" }] },
    ],
    links: [
      [10, 1, 0, 2, 0, "MODEL"],
      [11, 2, 0, 3, 0, "MODEL"],
      [12, 3, 0, 4, 0, "MODEL"],
    ],
  };
  const warnings = [];
  const prompt = convertUiToApi(wf, OBJ, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(prompt["4"].inputs.model, ["1", 0]); // 穿透两层直达真实源
  assert.ok(!prompt["2"] && !prompt["3"]);
  assert.ok(warnings.some((w) => /#2/.test(w) && /旁路/));
  assert.ok(warnings.some((w) => /#3/.test(w) && /旁路/));
});

// 反向断言挂点：mode 4 + bypass:"skip" 的处置（撤销穿透、按断链）被破坏即挂。
test("旁路链断：B 的旁路登记被撤销（档案 bypass:\"skip\"）后链断，D 报连线缺失并归因到 C", () => {
  const wf = {
    nodes: [
      { id: 1, type: "SRC", mode: 0, inputs: [], outputs: [out("MODEL", "MODEL")] },
      { id: 2, type: "Opt", mode: 4, inputs: [{ name: "model", link: 10, type: "MODEL" }], outputs: [out("MODEL", "MODEL")] },
      { id: 3, type: "Opt", mode: 4, inputs: [{ name: "model", link: 11, type: "MODEL" }], outputs: [out("MODEL", "MODEL")] },
      { id: 4, type: "Sink", mode: 0, inputs: [{ name: "model", link: 12, type: "MODEL" }] },
    ],
    links: [
      [10, 1, 0, 2, 0, "MODEL"],
      [11, 2, 0, 3, 0, "MODEL"],
      [12, 3, 0, 4, 0, "MODEL"],
    ],
  };
  // B 按档案 skip（不穿透）→ C 的入口连线死 → C（仍 mode 4 穿透）无可用入口 → D 的连线 12 缺失
  const warnings = [];
  assert.throws(
    () => convertUiToApi(wf, OBJ, { adapters: { Opt: { bypass: "skip" } }, onWarning: (w) => warnings.push(w) }),
    (e) => /连线缺失/.test(e.message) && /link 12/.test(e.message) && /#3/.test(e.message),
  );
});

// 幽灵键守卫：named 含定义里不存在的键 → 记 warning 后照常忽略，不拒绝。
// 挂点：删掉阶段三的幽灵键 warning 循环（恢复静默跳过）即挂。
test("子图：named 含定义里不存在的键 → 记 warning 忽略，不拒绝", () => {
  const wf = sgWf();
  wf.nodes[1].widgets_values_named = { value: "hello", ghost_key: 1 };
  const warnings = [];
  const prompt = convertUiToApi(wf, sgObj, { onWarning: (w) => warnings.push(w) });
  assert.equal(prompt["s18:1"].inputs.value, "hello"); // 正常键不受影响
  assert.ok(warnings.some((w) => /#18/.test(w) && /sg1/.test(w) && /「ghost_key」/.test(w) && /定义里不存在的键/.test(w) && /已忽略/.test(w)));
});

// 旧版格式文案守卫：def.links 是数字数组（旧版前端序列化）→ 拒绝文案点明旧版子图格式。
// 挂点：删掉阶段一的数字数组检测分支即挂（回落「定义缺 nodes/links 数组」文案）。
test("子图：定义 links 是旧版数字数组 → 拒绝文案点明旧版子图格式", () => {
  const wf = sgWf();
  wf.definitions.subgraphs[0].links = [25, 26, 6];
  assert.throws(
    () => convertUiToApi(wf, sgObj),
    (e) => /旧版子图格式/.test(e.message) && /links 为数组/.test(e.message) && /sg1/.test(e.message) && /#18/.test(e.message),
  );
});
