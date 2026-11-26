// app/lib/canvas-target.mjs — 「画布写入的目标页」选页纯函数（2026-11-27 issue ② 配套）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：桥（app/bridge/__init__.py 的 `_write_target_gate`）加了硬闸——多页在线时，写类 op
//   **没有显式 sid/workflow 一律拒绝**，避免落到别人的画布上（事故：未定向的 loadWorkflowFile
//   把用户页的内存画布换成了测试图）。app 侧的「复制副本 → 落盘 → 装载 → 排队」链原先全不带 sid，
//   多页时被整链 409；这两个函数就是给那条链「自证目标页」用的：
//     · pickActivePageSid(pages)     —— 链首：从台账挑出「当前活动页」，取它的全量 sid；
//     · matchNewPageSid(pages, ref)  —— duplicate 之后：确认副本落在哪一页（回执没带 sid 时靠台账名匹配）。
// 抽成纯函数的原因：两条判定都要能脱开真实画布桩测（见 canvas-target.test.mjs），
//   且「活动页」口径必须与 py 定向路由 / app 侧 activePageCopilot 一致，写死在一处好对账。
//
// 口径与既有实现对齐（不要各自发明）：
//   · 页条目字段来自 py `_pages_payload()`：sid（8 位）/ sidFull / workflow / path / ageSec / stale /
//     openWorkflows [{name, path, key, active, dirty}]；
//   · 「活动页」判据同 app/index.js activePageCopilot()（2026-10-31 v3.1）与 py 定向路由：
//     非 stale；openWorkflows 非空 → 需其中有 active:true；多个候选取 ageSec 最小（≈py _live_pick
//     取 seenAt 最新）；再平局按 sidFull 字典序（确定性，不依赖账本插入序）；
//   · 工作流名归一复用 canvas-open-workflow.mjs 的 nameMatchesTarget（全串 / 基名相等，去 .json、反斜杠归一）。

import { nameMatchesTarget } from "./canvas-open-workflow.mjs";

const strOf = (v) => String(v == null ? "" : v).trim();

/** 页条目的全量 sid（页面清单里 sid 是 8 位短码，定向要用 sidFull）。取不到 → null。 */
export const fullSidOf = (p) => strOf(p && (p.sidFull || p.sid)) || null;

const brief = (p) => ({
  sid: (fullSidOf(p) || "").slice(0, 8),
  sidFull: fullSidOf(p),
  workflow: (p && p.workflow) || null,
});

const livePages = (pages) =>
  (Array.isArray(pages) ? pages : []).filter((p) => p && typeof p === "object" && fullSidOf(p) && p.stale !== true);

/**
 * 链首选页：从台账挑「当前活动页」，返回它的全量 sid。
 *
 * 返回：
 *   { sid, page, via: "active"|"active-tie", liveCount }  —— 有活页（多页也有确定解，不猜）
 *   { sid: null, reason: "no-live-page", liveCount: 0, seenCount } —— 台账里没有活页 → 调用方必须中止
 *
 * 为什么多页时也返回确定解：这条链的动作（duplicate / save / loadWorkflowFile / queue）本来就只对
 *   「一页」成立，而旧实现靠广播「谁先回谁算」——多页时会各页各复制一份、结果不可知且不可撤销。
 *   按活动页口径定死一页，比广播更安全（副本页照旧新建，用户原布不动）。
 */
export function pickActivePageSid(pages) {
  const all = (Array.isArray(pages) ? pages : []).filter((p) => p && typeof p === "object" && fullSidOf(p));
  const live = livePages(pages);
  if (!live.length) return { sid: null, reason: "no-live-page", liveCount: 0, seenCount: all.length };
  const withActive = live.filter((p) =>
    Array.isArray(p.openWorkflows) && p.openWorkflows.length
      ? p.openWorkflows.some((w) => w && w.active === true)
      : true // openWorkflows 缺失/空：该页 workflow 本身就是前台工作流（旧桥口径）
  );
  const cands = withActive.length ? withActive : live;
  const ordered = [...cands].sort((a, b) => {
    const d = Number(a.ageSec) - Number(b.ageSec);
    if (Number.isFinite(d) && d !== 0) return d;
    const sa = fullSidOf(a);
    const sb = fullSidOf(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const top = ordered[0];
  return { sid: fullSidOf(top), page: brief(top), via: ordered.length > 1 ? "active-tie" : "active", liveCount: live.length };
}

/**
 * duplicate 之后确认副本落在哪一页：按回执给的副本身份（page = 新页路径 / key = 新页 key）
 * 在台账里找**唯一**命中页，返回它的全量 sid。
 *
 * 返回：
 *   { sid, page }                        —— 唯一命中
 *   { sid: null, reason: "ambiguous", candidates } —— 多页同名（同名前缀歧义）→ 调用方必须中止
 *   { sid: null, reason: "not-reported", candidates: [] } —— 刚建的页还没上报 → 调用方必须中止
 *   { sid: null, reason: "no-target" } —— 回执里连副本身份都没有 → 调用方必须中止
 *
 * 注意：本函数**只做匹配**，不负责「回执带了 sid 就直接用」——那一步在调用方
 *   （回执的 sid 是执行页自报的真凭，优先级高于台账推断）。
 */
export function matchNewPageSid(pages, target) {
  const cands = [target && target.page, target && target.key].map(strOf).filter(Boolean);
  if (!cands.length) return { sid: null, reason: "no-target", candidates: [] };
  const live = livePages(pages);
  const hits = live.filter((p) => nameMatchesTarget(p.workflow, cands) || nameMatchesTarget(p.path, cands));
  if (hits.length === 1) return { sid: fullSidOf(hits[0]), page: brief(hits[0]), candidates: [brief(hits[0])] };
  if (hits.length > 1) return { sid: null, reason: "ambiguous", candidates: hits.map(brief) };
  return { sid: null, reason: "not-reported", candidates: [] };
}
