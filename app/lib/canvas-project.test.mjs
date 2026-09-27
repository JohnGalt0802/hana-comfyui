// app/lib/canvas-project.test.mjs — 画布语义层 P1：投影过滤器单测（自含 · 零依赖）
// 运行：node app/lib/canvas-project.test.mjs
//       node app/lib/canvas-project.test.mjs --sample    # 附加打印样例输入/输出
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { projectGraph } from "./canvas-project.mjs";

// ── 合成样本图（7 节点 / 5 连线；含 inputs / outputs / widgets_values / pos / size）──
// #12 无 title（验证“白名单字段存在才带”）；#7 无任何连线（验证 links=[]）
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

test("单 #id：命中节点 + 单端命中连线保留；结构原样", () => {
  const r = projectGraph(GRAPH, { select: "#8" });
  assert.strictEqual(r.op, "get");
  assert.strictEqual(r.projected, true);
  assert.strictEqual(r.rev, 71);
  assert.deepStrictEqual(r.total, { nodes: 7, links: 5 });
  assert.deepStrictEqual(r.matched, { count: 1, ids: [8] });
  assert.deepStrictEqual(r.nodes.map((n) => n.id), [8]);
  const n8 = r.nodes[0];
  assert.deepStrictEqual(Object.keys(n8), ["id", "title", "type", "mode", "inputs", "outputs", "widgets_values"]);
  assert.strictEqual(n8.title, "尺寸");
  assert.deepStrictEqual(n8.inputs.map((i) => [i.name, i.link]), [["width", 38], ["height", 39], ["latent", null]]);
  assert.deepStrictEqual(r.links.map((l) => l[0]), [38, 39, 40]);
  assert.deepStrictEqual(r.links[0], [38, 27, 0, 8, 0, "INT"]); // 链接行原结构保留
});

test("多 #id：输出按 id 升序；双端/单端命中都保留", () => {
  const r = projectGraph(GRAPH, { select: "#27,#8" }); // 故意乱序输入
  assert.deepStrictEqual(r.matched.ids, [8, 27]);
  assert.deepStrictEqual(r.nodes.map((n) => n.id), [8, 27]);
  assert.deepStrictEqual(r.links.map((l) => l[0]), [38, 39, 40]); // 38 双端、39/40 单端
  assert.deepStrictEqual(r.links.find((l) => l[0] === 38), [38, 27, 0, 8, 0, "INT"]);
  assert.deepStrictEqual(r.links.find((l) => l[0] === 39), [39, 28, 0, 8, 1, "INT"]);
});

test("type=：类型匹配，不区分大小写", () => {
  const a = projectGraph(GRAPH, { select: "type=PrimitiveInt" });
  assert.deepStrictEqual(a.matched.ids, [27, 28]);
  assert.deepStrictEqual(a.links.map((l) => l[0]), [38, 39]);
  const b = projectGraph(GRAPH, { select: "type=primitiveint" });
  assert.deepStrictEqual(b.matched.ids, [27, 28]);
});

test("title~：标题子串包含，不区分大小写", () => {
  const a = projectGraph(GRAPH, { select: "title~尺寸" });
  assert.deepStrictEqual(a.matched.ids, [8, 27, 28]);
  const b = projectGraph(GRAPH, { select: "title~CHECKPOINT" });
  assert.deepStrictEqual(b.matched.ids, [2]);
});

test("混合并集：三种 term 取并集且去重", () => {
  const r = projectGraph(GRAPH, { select: "#8,type=PrimitiveInt,title~提示词" });
  assert.deepStrictEqual(r.matched.ids, [6, 8, 27, 28]);
  assert.deepStrictEqual(r.links.map((l) => l[0]), [38, 39, 40, 42]);
  const d = projectGraph(GRAPH, { select: "type=PrimitiveInt,#27" });
  assert.deepStrictEqual(d.matched, { count: 2, ids: [27, 28] }); // 去重，不重复计
});

test("fields 裁剪：只带白名单字段（节点上有才带），id 恒在", () => {
  const r = projectGraph(GRAPH, { select: "#27,#8", fields: "inputs,widgets_values,title" });
  assert.deepStrictEqual(r.nodes.map((n) => n.id), [8, 27]);
  const [n8, n27] = r.nodes;
  assert.deepStrictEqual(Object.keys(n8), ["id", "inputs", "widgets_values", "title"]);
  assert.deepStrictEqual(Object.keys(n27), ["id", "inputs", "widgets_values", "title"]);
  assert.strictEqual(n8.title, "尺寸");
  assert.deepStrictEqual(n27.widgets_values, [1248]);
  assert.ok(!("outputs" in n8) && !("mode" in n8) && !("pos" in n8) && !("size" in n8));
  assert.deepStrictEqual(r.links.map((l) => l[0]), [38, 39, 40]);
});

test("默认 fields：缺省用默认集；节点缺某字段则不带（#12 无 title）", () => {
  const r = projectGraph(GRAPH, { select: "#8,#12" });
  assert.deepStrictEqual(Object.keys(r.nodes[0]), ["id", "title", "type", "mode", "inputs", "outputs", "widgets_values"]);
  assert.deepStrictEqual(Object.keys(r.nodes[1]), ["id", "type", "mode", "inputs", "outputs", "widgets_values"]);
  assert.ok(!("pos" in r.nodes[0]) && !("size" in r.nodes[0]));
});

test("links 过滤：与命中集不相交的连线被丢弃", () => {
  const none = projectGraph(GRAPH, { select: "#7" });
  assert.deepStrictEqual(none.links, []); // #7 无任何连线
  const one = projectGraph(GRAPH, { select: "#2" });
  assert.deepStrictEqual(one.links.map((l) => l[0]), [41]); // 只剩 2→12
});

test("空匹配：count=0，nodes/links 为空，total/rev 照给", () => {
  const r = projectGraph(GRAPH, { select: "#999" });
  assert.deepStrictEqual(r.matched, { count: 0, ids: [] });
  assert.deepStrictEqual(r.nodes, []);
  assert.deepStrictEqual(r.links, []);
  assert.deepStrictEqual(r.total, { nodes: 7, links: 5 });
  assert.strictEqual(r.rev, 71);
});

test("未知字段：抛 Error（消息注明不支持）", () => {
  assert.throws(
    () => projectGraph(GRAPH, { fields: "foo" }),
    (e) => e instanceof Error && e.message.includes("不支持") && e.message.includes('"foo"'),
  );
  assert.throws(() => projectGraph(GRAPH, { fields: "title,bad" }), /不支持/);
});

test("非法 term：抛 Error（消息含 select 语法不支持）", () => {
  assert.throws(
    () => projectGraph(GRAPH, { select: "nope=1" }),
    (e) => e instanceof Error && e.message.includes('select 语法不支持："nope=1"'),
  );
  assert.throws(
    () => projectGraph(GRAPH, { select: "#abc" }),
    (e) => e instanceof Error && e.message.includes('select 语法不支持："#abc"'),
  );
});

test("graph 非对象：抛 Error", () => {
  assert.throws(() => projectGraph(null), /graph 非对象/);
  assert.throws(() => projectGraph("str"), /graph 非对象/);
  assert.throws(() => projectGraph(42), /graph 非对象/);
  assert.throws(() => projectGraph(), /graph 非对象/);
});

test("graph.links 缺失 → []；revision 缺失 → null", () => {
  const r = projectGraph({ nodes: [{ id: 1, type: "X", widgets_values: [] }] }, { select: "#1" });
  assert.deepStrictEqual(r.links, []);
  assert.deepStrictEqual(r.total, { nodes: 1, links: 0 });
  assert.strictEqual(r.rev, null);
});

test("结果可 JSON 序列化（round-trip 深等）", () => {
  const r = projectGraph(GRAPH, { select: "type=PrimitiveInt", fields: "widgets_values,pos" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
if (process.argv.includes("--sample")) {
  const out = projectGraph(GRAPH, { select: "#27,#8", fields: "inputs,widgets_values,title" });
  console.log('\n── 样例 ── select="#27,#8" fields="inputs,widgets_values,title"（输入 + 输出）');
  console.log(JSON.stringify({ input: GRAPH, output: out }, null, 2));
}
process.exitCode = fail ? 1 : 0;
