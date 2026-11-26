// app/lib/canvas-target.test.mjs — 画布写入「目标页自证」纯函数单测（自含 · 零依赖 · 不触真实画布）
// 运行：node --test app/lib/canvas-target.test.mjs
// 覆盖 2026-11-27 issue ② 的两个判定：链首选页（pickActivePageSid）与副本页确认（matchNewPageSid）。
import test from "node:test";
import assert from "node:assert";
import { pickActivePageSid, matchNewPageSid, fullSidOf } from "./canvas-target.mjs";

const page = (sidFull, workflow, extra = {}) => ({ sid: sidFull.slice(0, 8), sidFull, workflow, ageSec: 1, stale: false, ...extra });

test("pickActivePageSid：单页 → 直接取它，via=active", () => {
  const r = pickActivePageSid([page("a1b2c3d4-0000-1111-2222-333344445555", "moss-image-SFT综合 (8)")]);
  assert.strictEqual(r.sid, "a1b2c3d4-0000-1111-2222-333344445555");
  assert.strictEqual(r.via, "active");
  assert.strictEqual(r.page.sid, "a1b2c3d4");
});

test("pickActivePageSid：多页 → 取 openWorkflows.active 的页（不是 ageSec 最小的）", () => {
  const r = pickActivePageSid([
    page("bbbb1111-x", "别的页", { ageSec: 0.2, openWorkflows: [{ name: "别的页", active: true }] }),
    page("aaaa2222-y", "用户正在看的页", { ageSec: 900, openWorkflows: [{ name: "用户正在看的页", active: true }] }),
  ]);
  // 两页都报了 active（各自都是自己的前台）→ 该按 ageSec 取最近上报者
  assert.strictEqual(r.sid, "bbbb1111-x");
  const r2 = pickActivePageSid([
    page("cccc3333-z", "后台页", { ageSec: 0.1, openWorkflows: [{ name: "前台页", active: false }] }),
    page("dddd4444-w", "前台页", { ageSec: 30, openWorkflows: [{ name: "前台页", active: true }] }),
  ]);
  assert.strictEqual(r2.sid, "dddd4444-w", "只有 active:true 的页算活动页");
});

test("pickActivePageSid：多候选 ageSec 相同 → 按 sidFull 字典序定解（不靠插入序）", () => {
  const a = page("ffff0000-1", "A", { ageSec: 5 });
  const b = page("11110000-1", "B", { ageSec: 5 });
  assert.strictEqual(pickActivePageSid([a, b]).sid, "11110000-1");
  assert.strictEqual(pickActivePageSid([b, a]).sid, "11110000-1");
});

test("pickActivePageSid：只剩 stale 条目 → sid=null（调用方必须中止，不能当在线页用）", () => {
  const r = pickActivePageSid([page("dead0001-x", "旧页", { ageSec: 5000, stale: true })]);
  assert.strictEqual(r.sid, null);
  assert.strictEqual(r.reason, "no-live-page");
  assert.strictEqual(r.seenCount, 1);
});

test("pickActivePageSid：台账为空 / 脏数据 → sid=null", () => {
  assert.strictEqual(pickActivePageSid([]).sid, null);
  assert.strictEqual(pickActivePageSid(null).sid, null);
  assert.strictEqual(pickActivePageSid([{ workflow: "无 sid" }, null, "x"]).sid, null);
});

test("pickActivePageSid：短 sid 台账（只有 sid 没有 sidFull）也能用", () => {
  const r = pickActivePageSid([{ sid: "abcd1234", workflow: "W", ageSec: 1, stale: false }]);
  assert.strictEqual(r.sid, "abcd1234");
});

test("matchNewPageSid：台账唯一命中副本名 → 取该页 sid（去 .json / 路径形态都认）", () => {
  const pages = [
    page("aaaa1111-0", "moss-image-SFT综合 (8)"),
    page("bbbb2222-0", "moss-image-SFT综合 (8) (Copy)"),
    page("cccc3333-0", "Qwen21 t2i 质量版"),
  ];
  const r = matchNewPageSid(pages, { page: "workflows/moss-image-SFT综合 (8) (Copy).json" });
  assert.strictEqual(r.sid, "bbbb2222-0");
  // key 形态（前端 store key）也走同一归一
  const r2 = matchNewPageSid(pages, { key: "moss-image-SFT综合 (8) (Copy)" });
  assert.strictEqual(r2.sid, "bbbb2222-0");
});

test("matchNewPageSid：刚建的页还没上报 → sid=null / not-reported（必须中止，不猜）", () => {
  const r = matchNewPageSid([page("aaaa1111-0", "moss-image-SFT综合 (8)")], { page: "workflows/全新副本 (Copy).json" });
  assert.strictEqual(r.sid, null);
  assert.strictEqual(r.reason, "not-reported");
});

test("matchNewPageSid：多页同名（同名前缀歧义）→ sid=null / ambiguous，列候选", () => {
  const pages = [page("aaaa1111-0", "副本 (Copy)"), page("bbbb2222-0", "副本 (Copy)")];
  const r = matchNewPageSid(pages, { page: "workflows/副本 (Copy).json" });
  assert.strictEqual(r.sid, null);
  assert.strictEqual(r.reason, "ambiguous");
  assert.deepStrictEqual(r.candidates.map((c) => c.sid), ["aaaa1111", "bbbb2222"]);
});

test("matchNewPageSid：stale 页不参与匹配（死条目不能截胡活页）", () => {
  const pages = [page("aaaa1111-0", "副本 (Copy)", { stale: true })];
  const r = matchNewPageSid(pages, { page: "workflows/副本 (Copy).json" });
  assert.strictEqual(r.reason, "not-reported");
});

test("matchNewPageSid：回执没给副本身份 → no-target", () => {
  assert.strictEqual(matchNewPageSid([page("a-1", "W")], {}).reason, "no-target");
  assert.strictEqual(matchNewPageSid([page("a-1", "W")], null).reason, "no-target");
});

test("fullSidOf：sidFull 优先于 8 位 sid；空值与缺字段 → null", () => {
  assert.strictEqual(fullSidOf({ sid: "abcd1234", sidFull: "abcd1234-full" }), "abcd1234-full");
  assert.strictEqual(fullSidOf({ sid: "" }), null);
  assert.strictEqual(fullSidOf(null), null);
});
