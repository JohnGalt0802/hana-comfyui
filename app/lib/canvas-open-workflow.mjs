// app/lib/canvas-open-workflow.mjs — openWorkflow 链路纯函数（T3-1 落定判定 / T3-3 路由失败文案）
// ─────────────────────────────────────────────────────────────────────────────
// 抽成纯函数的原因：本批两条修复都落在「报错是否老实」上——判定与文案必须能脱开真实画布桩测
// （见 canvas-open-workflow.test.mjs；运行：node app/lib/canvas-open-workflow.test.mjs [--sample]）。
// 口径与 app/index.js 保持一致：工作流名归一＝反斜杠→斜杠、去尾 .json、小写、去空白。

const normName = (s) =>
  String(s == null ? "" : s).replace(/\\/g, "/").trim().toLowerCase().replace(/\.json$/, "");

// null / undefined / 空串 → null（取不到）；其余按数解析，非有限数也归 null。
// 注意：不能用 Number.isFinite(Number(null))——Number(null)=0 会把「取不到」误当 0。
export const toIntOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 目标页匹配（与 app/index.js canvasPageMatches 同口径）：全串或基名相等。
export function nameMatchesTarget(active, candidates) {
  if (!active) return false;
  const a = normName(active);
  if (!a) return false;
  const list = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);
  return list.some((c) => {
    const t = normName(c);
    if (!t) return false;
    return a === t || a.split("/").pop() === t.split("/").pop();
  });
}

// T3-1：装载落定判定（把「打开了」与「装上了」分开）。
//   第一证据＝到达（活动页名达目标 + revision 节点数一致），由 app 层等待循环给出；
//   第二证据＝现抓 summary 的节点数。
//   二者冲突（summary 可得且与期望不符）→ 判未落定；
//   summary 不可得 → 以第一证据为准（不因取不到第二证据而谎报失败）。
export function openWorkflowLoadVerdict({ arrived, expectedNodes, summaryNodeCount }) {
  const want = toIntOrNull(expectedNodes);
  const got = toIntOrNull(summaryNodeCount);
  if (!arrived) return { loaded: false, reason: "not_arrived", want, got };
  if (want != null && got != null && got !== want) {
    return { loaded: false, reason: `summary_mismatch(summary=${got}, expected=${want})`, want, got };
  }
  return { loaded: true, reason: got == null ? "arrived_only" : "arrived+summary", want, got };
}

// T3-3：openWorkflow 路由失败分类与文案（区分「无匹配页」与「有页但未响应」）。
//   入参 error＝桥回执 error 码；wantWf＝定向用的工作流名（工具 workflow 参数）。
//   命中路由类失败 → 返回 { code, text }；其余 → null（交回调用方按通用口径处理）。
//   text 不含「在线页面」清单（由调用方追加，数据源＝桥回执 pages）。
export function openWorkflowRouteError({ error, wantWf }) {
  const wf = String(wantWf == null ? "" : wantWf).trim();
  if (error === "no_page") {
    return {
      code: "no_live_page_matching_name",
      text:
        `openWorkflow 定向无匹配在线页：没有页面正打开「${wf || "(未指定)"}」` +
        "（name 路由只发给已打开该工作流的页面）。" +
        "改用 path=<工作流文件路径> 直接按文件装载（推荐），或先打开该工作流后再用 name。",
    };
  }
  if (error === "no_live_page") {
    return {
      code: "no_live_page_matching_name",
      text:
        `openWorkflow 定向无匹配在线页：「${wf || "(未指定)"}」的匹配页面均已过期（页面冻结 / 失联，已跳过）。` +
        "改用 path=<工作流文件路径> 直接按文件装载（推荐），或先刷新 / 重开该工作流页面。",
    };
  }
  if (error === "timeout") {
    if (wf) {
      return {
        code: "route_no_response",
        text:
          "openWorkflow 定向已发出但前端未在时限内回传——有在线页但未响应（与「无匹配页」不同）：" +
          "页面可能忙 / 正在执行阻塞 / 扩展未加载。可重试，或改用 path=<工作流文件路径> 装载（不依赖页面定向）。",
      };
    }
    return {
      code: "canvas_no_response",
      text:
        "openWorkflow 已发起但前端未在时限内回传：可能没有打开的 ComfyUI 页面" +
        "（或前端扩展未加载 / 正在执行阻塞）。改用 path=<工作流文件路径> 装载不依赖页面定向。",
    };
  }
  return null;
}
