// app/lib/template-hub.test.mjs — 模板库内核测试
// 运行：node --test app/lib/template-hub.test.mjs（cwd = 工作树根）
// fixture 是真实索引/模板的小份切片（来源 D:\ComfyUI\...\comfyui_workflow_templates_json\templates）。
// ─────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCatalog,
  searchCatalog,
  compareVersion,
  runnableCheck,
  collectRequiredModels,
  diffModels,
} from "./template-hub.mjs";

const FIX = new URL("./fixtures/template-hub/", import.meta.url);
const readFixture = (f) => JSON.parse(readFileSync(new URL(f, FIX), "utf8"));

const mcpIndex = readFixture("mcp-index.fixture.json");
const zhIndex = readFixture("zh-index.fixture.json");
const templateJson = readFixture("template.fixture.json");

const catalog = buildCatalog({ mcpIndex, zhIndex });
const byName = (name) => catalog.find((t) => t.name === name);

// ── 一、buildCatalog：结构与中英对齐 ────────────────────────────────────────

test("buildCatalog：条目数 = mcp 索引模板数，字段齐", () => {
  const expected = mcpIndex.reduce((n, c) => n + c.templates.length, 0);
  assert.equal(catalog.length, expected);
  const t = byName("api_nano_banana_2_1_t2i");
  assert.equal(t.task, "Text to Image");
  assert.equal(t.model, "Nano Banana");
  assert.deepEqual(t.workflowTags, ["text-to-image", "api"]);
  assert.ok(t.usage > 0);
  assert.equal(t.minComfyUIVersion, "0.39.1");
  assert.ok(t.io.inputs.length >= 0 && t.io.outputs.length >= 0);
});

test("buildCatalog：中文对齐 titleZh/descriptionZh/mediaType/tags，hasZh 标记", () => {
  const t = byName("image_qwen_image_2_1_image_edit");
  assert.equal(t.hasZh, true);
  assert.equal(t.titleZh, "Qwen Image 2.1：图像编辑");
  assert.ok(t.descriptionZh.includes("编辑"));
  assert.equal(t.mediaType, "image");
  assert.ok(Array.isArray(t.tags) && t.tags.includes("图片编辑"));
  // 英文原字段保留
  assert.equal(t.title, "Qwen Image 2.1: Image Edit");
});

test("buildCatalog：zh 里有而 mcp 里没有的条目不混入目录（目录以 mcp 为准）", () => {
  const zhOnly = zhIndex.flatMap((m) => m.templates).map((t) => t.name);
  for (const name of zhOnly) {
    if (!mcpIndex.some((c) => c.templates.some((t) => t.name === name))) {
      assert.equal(catalog.find((t) => t.name === name), undefined, `zh-only 条目 ${name} 不应出现在目录里`);
    }
  }
});

// ── 二、searchCatalog：中英文检索 + 分页 ────────────────────────────────────

test("检索：中文关键词命中（titleZh/descriptionZh 对齐自 zh 索引）", () => {
  const { rows, total } = searchCatalog(catalog, { q: "图像编辑", limit: 50 });
  assert.ok(total >= 1);
  assert.ok(rows.some((t) => t.name === "image_qwen_image_2_1_image_edit"));
  // 另一个中文词走 descriptionZh
  const { rows: r2, total: t2 } = searchCatalog(catalog, { q: "图生视频", limit: 50 });
  assert.ok(t2 >= 1);
  assert.ok(r2.some((t) => t.name === "video_wan2_2_14B_i2v"));
});

test("检索：英文关键词命中", () => {
  const { rows, total } = searchCatalog(catalog, { q: "qwen image", limit: 50 });
  assert.ok(total >= 2);
  assert.ok(rows.some((t) => t.name === "image_qwen_image_2_1_t2i"));
});

test("检索：大小写不敏感", () => {
  assert.equal(searchCatalog(catalog, { q: "NANO BANANA" }).total, searchCatalog(catalog, { q: "nano banana" }).total);
  assert.ok(searchCatalog(catalog, { q: "NANO BANANA" }).total >= 1);
});

test("检索：过滤条件 task / mediaType / tag / recommend", () => {
  const task = searchCatalog(catalog, { task: "Lip Sync" });
  assert.equal(task.total, 1);
  assert.equal(task.rows[0].name, "video_wan2_1_infinitetalk");

  const tag = searchCatalog(catalog, { tag: "Int8", limit: 50 });
  assert.ok(tag.rows.every((t) => (t.tags || []).includes("Int8") || t.workflowTags.includes("int8")));

  const rec = searchCatalog(catalog, { recommend: "highly_recommended", limit: 50 });
  assert.ok(rec.rows.every((t) => t.recommend === "highly_recommended"));
  assert.equal(rec.total, rec.rows.length);

  const media = searchCatalog(catalog, { mediaType: "audio", limit: 50 });
  assert.ok(media.rows.every((t) => t.mediaType === "audio"));
});

test("检索：分页 total/shown/offset 正确", () => {
  const all = searchCatalog(catalog, { limit: 0 }); // limit 0 = 取全部
  assert.equal(all.shown, all.total);
  const p1 = searchCatalog(catalog, { limit: 2, offset: 0 });
  const p2 = searchCatalog(catalog, { limit: 2, offset: 2 });
  assert.equal(p1.shown, Math.min(2, p1.total));
  assert.equal(p2.shown, Math.min(2, Math.max(0, p2.total - 2)));
  assert.deepEqual(
    [...p1.rows, ...p2.rows].map((t) => t.name),
    all.rows.slice(0, 4).map((t) => t.name),
  );
  // 空页
  const empty = searchCatalog(catalog, { limit: 2, offset: all.total + 10 });
  assert.equal(empty.total, all.total);
  assert.equal(empty.shown, 0);
  assert.deepEqual(empty.rows, []);
});

// ── 三、版本比较：数值语义，不是字典序 ──────────────────────────────────────

test("compareVersion：0.43.0 > 0.39.1、0.9.2 < 0.10.0", () => {
  assert.equal(compareVersion("0.43.0", "0.39.1"), 1);
  assert.equal(compareVersion("0.39.1", "0.43.0"), -1);
  assert.equal(compareVersion("0.9.2", "0.10.0"), -1);
  assert.equal(compareVersion("0.10.0", "0.9.2"), 1);
  assert.equal(compareVersion("0.43.0", "0.43.0"), 0);
  // 段数不齐：缺段按 0
  assert.equal(compareVersion("0.4", "0.4.0"), 0);
  assert.equal(compareVersion("0.4", "0.4.1"), -1);
  // 字典序会做错、数值做对的护栏
  assert.equal(compareVersion("0.3.9", "0.3.10"), -1);
});

test("compareVersion：非法输入抛 TypeError", () => {
  assert.throws(() => compareVersion("abc", "0.1.0"), TypeError);
  assert.throws(() => compareVersion("0.43.0", undefined), TypeError);
  assert.throws(() => compareVersion(430, "0.1.0"), TypeError);
});

// ── 四、runnableCheck：可跑判定 ─────────────────────────────────────────────

test("runnableCheck：本机版本低 → runnable:false 且 reason 可读", () => {
  const t = byName("api_nano_banana_2_1_t2i"); // min 0.39.1
  const r = runnableCheck(t, "0.38.0");
  assert.equal(r.runnable, false);
  assert.match(r.reason, /0\.39\.1/);
  assert.match(r.reason, /0\.38\.0/);
  assert.equal(runnableCheck(t, "0.39.1").runnable, true);
  assert.equal(runnableCheck(t, "0.43.0").runnable, true);
});

test("runnableCheck：无 minComfyUIVersion → 可跑（3 条实测无版本号的模板）", () => {
  const noVer = { name: "no-ver", title: "x", task: "t", model: "m", description: "d" };
  assert.deepEqual(runnableCheck(noVer, "0.43.0"), { runnable: true });
  assert.deepEqual(runnableCheck({}, undefined), { runnable: true });
});

// ── 五、collectRequiredModels：递归进 subgraphs ─────────────────────────────

test("collectRequiredModels：真实模板切片（加载节点全在 subgraph 里）收集到 4 个模型", () => {
  const models = collectRequiredModels(templateJson);
  // fixture 来自 image_qwen_image_2_1_image_edit：顶层 nodes 只有 subgraph 引用与 IO 节点
  assert.equal(models.length, 4);
  assert.ok(models.every((m) => m.name.endsWith(".safetensors")));
  assert.ok(models.every((m) => typeof m.url === "string" && m.url.startsWith("https://")));
  const dirs = new Set(models.map((m) => m.directory));
  assert.ok(["diffusion_models", "text_encoders", "vae"].every((d) => dirs.has(d)));
  assert.deepEqual(
    models.map((m) => m.name).sort(),
    [
      "qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors",
      "qwen3vl_8b_int8_convrot.safetensors",
      "qwen_image_2.1_int8_convrot.safetensors",
      "qwen_image_2.1_vae_bf16.safetensors",
    ],
  );
});

test("collectRequiredModels：顶层 nodes 里的模型也收，重复对象去重", () => {
  const dup = {
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", properties: { models: [{ name: "a.safetensors", url: "u1", directory: "checkpoints" }] } },
    ],
    definitions: {
      subgraphs: [
        {
          id: "sg",
          nodes: [
            { id: 2, type: "LoraLoader", properties: { models: [{ name: "b.safetensors", url: "u2", directory: "loras" }] } },
            // 同名模型出现两次（不同 subgraph 实例展开后常见）→ 只报一次
            { id: 3, type: "LoraLoader", properties: { models: [{ name: "b.safetensors", url: "u2", directory: "loras" }] } },
          ],
        },
      ],
    },
  };
  const models = collectRequiredModels(dup);
  assert.deepEqual(models.map((m) => m.name), ["a.safetensors", "b.safetensors"]);
});

test("collectRequiredModels：空输入与畸形结构不炸", () => {
  assert.deepEqual(collectRequiredModels({}), []);
  assert.deepEqual(collectRequiredModels({ nodes: [] }), []);
  assert.deepEqual(collectRequiredModels({ nodes: [{ type: "X", properties: {} }] }), []);
  assert.deepEqual(collectRequiredModels({ definitions: { subgraphs: [{}] } }), []);
});

// ── 六、diffModels：缺模型对账 ──────────────────────────────────────────────

test("diffModels：不完整的 installed 准确报缺，directory+文件名精确匹配", () => {
  const required = collectRequiredModels(templateJson); // 4 个：diffusion_models×1, text_encoders×2, vae×1
  // 只装了 vae 和其中一个 text_encoder，diffusion_models 目录整个缺
  const installed = {
    vae: ["qwen_image_2.1_vae_bf16.safetensors"],
    text_encoders: ["qwen3vl_8b_int8_convrot.safetensors", "别的模型.safetensors"],
  };
  const { missing, present } = diffModels(required, installed);
  assert.deepEqual(
    missing.map((m) => m.name).sort(),
    ["qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors", "qwen_image_2.1_int8_convrot.safetensors"],
  );
  assert.deepEqual(
    present.map((m) => m.name).sort(),
    ["qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors"],
  );
});

test("diffModels：大小写敏感（Windows 上也按原样比）", () => {
  const required = [{ name: "Model.safetensors", url: "u", directory: "checkpoints" }];
  const r1 = diffModels(required, { checkpoints: ["model.safetensors"] });
  assert.equal(r1.missing.length, 1, "文件名大小写不同 → 报缺");
  const r2 = diffModels(required, { Checkpoints: ["Model.safetensors"] });
  assert.equal(r2.missing.length, 1, "目录名大小写不同 → 报缺");
  const r3 = diffModels(required, { checkpoints: ["Model.safetensors"] });
  assert.deepEqual(r3.present, required);
});

test("diffModels：installed 为空/畸形 → 全部报缺", () => {
  const required = [{ name: "a.safetensors", url: "u", directory: "loras" }];
  assert.deepEqual(diffModels(required, {}).missing, required);
  assert.deepEqual(diffModels(required, undefined).missing, required);
  assert.deepEqual(diffModels(required, { loras: null }).missing, required);
  assert.deepEqual(diffModels([], { loras: ["a.safetensors"] }), { missing: [], present: [] });
});
