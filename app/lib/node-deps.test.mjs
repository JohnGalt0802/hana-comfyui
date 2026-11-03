// app/lib/node-deps.test.mjs — 缺包诊断内核 T8 单测（自含 · 零依赖）
// 运行：node --test app/lib/node-deps.test.mjs
// fixture：fixtures/node-deps/extension-node-map.sample.json —— 全部真实条目，
// 取自 cache 的 5718 键映射表（PreViewVideo 多候选整组 + SaveImageWithMetadata 三候选
// + 5 个唯一类名仓库），不含整份表。
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildReverseIndex,
  normalizeRepo,
  normalizeInstalled,
  resolveMissing,
  summarize,
} from "./node-deps.mjs";

const samplePath = fileURLToPath(new URL("./fixtures/node-deps/extension-node-map.sample.json", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(samplePath, "utf8"));

// ── 用例 1：唯一候选 → 返回 1 个 ──
test("buildReverseIndex + resolveMissing：唯一候选返回 1 个", () => {
  const index = buildReverseIndex(SAMPLE);
  const res = resolveMissing(["AniTalkerNode"], index);
  assert.equal(res.length, 1);
  assert.equal(res[0].className, "AniTalkerNode");
  assert.equal(res[0].candidates.length, 1);
  assert.equal(res[0].candidates[0].repo, "aifsh/anitalker-comfyui");
  assert.equal(res[0].candidates[0].installed, false);
  assert.equal(res[0].candidates[0].title, "AniTalker-ComfyUI");
  assert.deepEqual(res[0].candidates[0].classes, ["AniTalkerNode", "PreViewVideo"]);
});

// ── 用例 2：多候选（PreViewVideo 真实数据，15 个仓库）→ 全量返回、字母序 ──
test("resolveMissing：PreViewVideo 多候选给全且排序确定", () => {
  const index = buildReverseIndex(SAMPLE);
  const res = resolveMissing(["PreViewVideo"], index);
  assert.equal(res.length, 1);
  const cands = res[0].candidates;
  assert.ok(cands.length >= 14, `PreViewVideo 候选应 ≥14，实际 ${cands.length}`);
  for (let i = 1; i < cands.length; i++) {
    assert.ok(cands[i - 1].repo <= cands[i].repo, "repo 应按字母序");
  }
  const repos = cands.map((c) => c.repo);
  assert.ok(repos.includes("aifsh/comfyui-mimicmotion"));
  assert.ok(repos.includes("waddingtonholdings/comfyui-instasd"));
});

// ── 用例 3：已装的排前面；精确类名（单类仓库）在多类仓库之前 ──
test("resolveMissing：排序 = 已装优先 → 类名精确出现优先 → 仓库字母序", () => {
  const index = buildReverseIndex(SAMPLE);
  const installed = {
    "https://github.com/Arctenox/Arctenoxs-Essentials_ComfyUI": { present: true, dir: "custom_nodes/Arctenoxs-Essentials_ComfyUI" },
    "https://github.com/0nikod/ComfyUI-Metadata-Tools": { present: true, dir: "custom_nodes/ComfyUI-Metadata-Tools" },
  };
  const res = resolveMissing(["SaveImageWithMetadata"], index, installed);
  const [c1, c2, c3] = res[0].candidates;
  // 两个已装的在前；Braeden90000 的仓库 classes 只含 SaveImageWithMetadata（精确出现），
  // 且未装 → 在精确维度上赢过两个已装的多类仓库？不：已装优先级最高。
  assert.equal(c1.installed, true);
  assert.equal(c2.installed, true);
  assert.equal(c3.installed, false);
  // 两个已装内部：都是多类仓库（Arctenox 14 类、0nikod 4 类都不止 1 类）→ 字母序
  assert.equal(c1.repo, "0nikod/comfyui-metadata-tools");
  assert.equal(c2.repo, "arctenox/arctenoxs-essentials_comfyui");
  assert.equal(c3.repo, "braeden90000/comfyui-save-image-metadata");
  assert.equal(c1.dir, "custom_nodes/ComfyUI-Metadata-Tools");
});

// ── 用例 3b：精确出现优先（installed 全空时，单类仓库排最前）──
test("resolveMissing：单类仓库（精确出现）排在多类仓库之前", () => {
  const index = buildReverseIndex(SAMPLE);
  const res = resolveMissing(["SaveImageWithMetadata"], index, {});
  assert.equal(res[0].candidates[0].repo, "braeden90000/comfyui-save-image-metadata");
  assert.equal(res[0].candidates[0].classes.length, 1);
});

// ── 用例 4：三个状态各命中一次 ──
test("summarize：三态各命中一次，边界正确", () => {
  const index = buildReverseIndex(SAMPLE);
  const installed = {
    // 装了但类没加载出来：所有候选都已装
    "https://github.com/AIFSH/AniTalker-ComfyUI": { present: true, dir: "custom_nodes/AniTalker-ComfyUI" },
    // 部分候选已装：走 notInstalled（已装的那部分不进 installedNotLoaded）
    "https://github.com/Arctenox/Arctenoxs-Essentials_ComfyUI": { present: true, dir: "custom_nodes/Arctenoxs" },
  };
  const res = resolveMissing(
    ["AniTalkerNode", "SaveImageWithMetadata", "TotallyMadeUpClass"],
    index,
    installed,
  );
  const s = summarize(res);
  // installedNotLoaded：AniTalkerNode 唯一候选已装
  assert.equal(s.installedNotLoaded.length, 1);
  assert.equal(s.installedNotLoaded[0].repo, "aifsh/anitalker-comfyui");
  assert.deepEqual(s.installedNotLoaded[0].classes, ["AniTalkerNode"]);
  assert.equal(s.installedNotLoaded[0].dir, "custom_nodes/AniTalker-ComfyUI");
  // notInstalled：SaveImageWithMetadata 有未装候选；已装的 0nikod/Arctenox 不重复报
  const ni = s.notInstalled.find((e) => e.repo === "braeden90000/comfyui-save-image-metadata");
  assert.ok(ni, "未装候选应出现");
  assert.deepEqual(ni.classes, ["SaveImageWithMetadata"]);
  assert.ok(!s.notInstalled.some((e) => e.repo === "arctenox/arctenoxs-essentials_comfyui"),
    "同类已装候选不应混进 notInstalled");
  assert.ok(!s.installedNotLoaded.some((e) => e.repo === "arctenox/arctenoxs-essentials_comfyui"),
    "有未装候选时已装候选不进 installedNotLoaded");
  // unresolved
  assert.deepEqual(s.unresolved, [{ className: "TotallyMadeUpClass" }]);
});

// ── 用例 4b：装了但 present:false → 视为未装（不建议「看日志」而是「去装」）──
test("summarize：present:false 的候选按未装处理", () => {
  const index = buildReverseIndex(SAMPLE);
  const installed = {
    "https://github.com/AIFSH/AniTalker-ComfyUI": { present: false, dir: "custom_nodes/AniTalker-ComfyUI.disabled" },
  };
  const res = resolveMissing(["AniTalkerNode"], index, installed);
  assert.equal(res[0].candidates[0].installed, false);
  assert.equal(res[0].candidates[0].dir, "custom_nodes/AniTalker-ComfyUI.disabled");
  const s = summarize(res);
  assert.equal(s.installedNotLoaded.length, 0);
  assert.equal(s.notInstalled.length, 1);
});

// ── 用例 4c：同类多候选、一装一未装 → notInstalled 条目带 alsoInstalled，两桶不重叠 ──
test("summarize：同类另有已装候选时，notInstalled 条目带 alsoInstalled", () => {
  // 合成最小映射表：两个仓库都提供 SharedNode（标题不同），只装 plugin-a。
  const map = {
    "https://github.com/acme/plugin-a": [["SharedNode"], { title_aux: "Plugin A" }],
    "https://github.com/acme/plugin-b": [["SharedNode"], { title_aux: "Plugin B" }],
  };
  const installed = { "https://github.com/acme/plugin-a": { present: true, dir: "custom_nodes/plugin-a" } };
  const res = resolveMissing(["SharedNode"], map, installed);
  const s = summarize(res);
  // 未装那个进 notInstalled，并带上已装候选（repo + dir）
  assert.equal(s.notInstalled.length, 1);
  const entry = s.notInstalled[0];
  assert.equal(entry.repo, "acme/plugin-b");
  assert.deepEqual(entry.classes, ["SharedNode"]);
  assert.deepEqual(entry.alsoInstalled, [{ repo: "acme/plugin-a", dir: "custom_nodes/plugin-a" }]);
  // 两桶互斥：已装那个不得出现在 installedNotLoaded
  assert.equal(s.installedNotLoaded.length, 0);
  // 没有已装候选时不该出现该字段
  const s2 = summarize(resolveMissing(["SharedNode"], map, {}));
  assert.ok(s2.notInstalled.every((e) => e.alsoInstalled === undefined));
});

// ── 用例 5：仓库地址归一化（ssh / https / 带 .git / 大小写 / 尾斜杠）──
test("normalizeRepo：ssh / https / .git / 大小写归一一致", () => {
  const a = normalizeRepo("https://github.com/AIFSH/AniTalker-ComfyUI.git");
  const b = normalizeRepo("git@github.com:AIFSH/AniTalker-ComfyUI.git");
  const c = normalizeRepo("https://github.com/aifsh/anitalker-comfyui");
  assert.equal(a, "aifsh/anitalker-comfyui");
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(normalizeRepo("http://github.com/Owner/Repo/"), "owner/repo");
  // 非 GitHub / 坏输入 → null（调用方标 unresolvable）
  assert.equal(normalizeRepo("https://gitlab.com/owner/repo"), null);
  assert.equal(normalizeRepo("not-a-url"), null);
  assert.equal(normalizeRepo(""), null);
  assert.equal(normalizeRepo(null), null);
});

test("normalizeInstalled：原始地址键与 owner/repo 键都归一到 owner/repo", () => {
  const inst = normalizeInstalled({
    "git@github.com:AIFSH/AniTalker-ComfyUI.git": { present: true, dir: "custom_nodes/Ani" },
    "Some/Private": { present: true },
    "not-a-url": { present: true },
  });
  assert.deepEqual(Object.keys(inst).sort(), ["aifsh/anitalker-comfyui", "some/private"]);
  assert.equal(inst["aifsh/anitalker-comfyui"].dir, "custom_nodes/Ani");
});

// ── 用例 6：表里没有的类 → unresolved ──
test("summarize：空候选 → unresolved；纯前端扩展不做特例", () => {
  const index = buildReverseIndex(SAMPLE);
  // comfyui-node-organizer 是纯前端扩展，注册 0 类、不在映射表 —— 统一按查不到处理，
  // 不硬编码特例。两个查不到的类都落 unresolved。
  const res = resolveMissing(["ComfyNodeOrganizerPanel", "HanaBridgeInternal"], index, {});
  const s = summarize(res);
  assert.deepEqual(s.unresolved, [
    { className: "ComfyNodeOrganizerPanel" },
    { className: "HanaBridgeInternal" },
  ]);
  assert.equal(s.notInstalled.length, 0);
  assert.equal(s.installedNotLoaded.length, 0);
});

// ── 补充：summarize 聚合去重与确定性排序 ──
test("summarize：多类共享仓库时 classes 合并去重，输出按 repo/className 排序", () => {
  const index = buildReverseIndex(SAMPLE);
  const res = resolveMissing(["MimicMotionNode", "PreViewVideo", "HalloNode"], index, {});
  const s = summarize(res);
  // PreViewVideo 的 15 个候选都未装 → notInstalled；MimicMotion/Hallo 各自唯一候选未装
  const mimic = s.notInstalled.find((e) => e.repo === "aifsh/comfyui-mimicmotion");
  assert.ok(mimic);
  assert.ok(mimic.classes.includes("MimicMotionNode"));
  assert.ok(mimic.classes.includes("PreViewVideo"), "同一仓库的类名应合并");
  assert.equal(mimic.classes.length, 2);
  const repos = s.notInstalled.map((e) => e.repo);
  assert.deepEqual(repos, [...repos].sort(), "notInstalled 按 repo 字母序");
  const unresolvedNames = s.unresolved.map((e) => e.className);
  assert.deepEqual(unresolvedNames, [...unresolvedNames].sort());
});

// ── 补充：入参校验与空输入 ──
test("入参校验：非对象映射表 / 非数组类名 / 非数组 resolutions 抛错", () => {
  assert.throws(() => buildReverseIndex(null), /nodeMap/);
  assert.throws(() => resolveMissing("KSampler", {}), /unknownClasses/);
  assert.throws(() => summarize("nope"), /resolutions/);
  assert.deepEqual(summarize([]), { notInstalled: [], installedNotLoaded: [], unresolved: [] });
  assert.deepEqual(resolveMissing([], {}, {}), []);
});
