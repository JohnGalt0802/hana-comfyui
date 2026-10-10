// app/lib/canvas-open-workflow.test.mjs — openWorkflow 链路纯函数单测（自含 · 零依赖 · 不触真实画布）
// 运行：node app/lib/canvas-open-workflow.test.mjs
//       node app/lib/canvas-open-workflow.test.mjs --sample   # 附加打印「无匹配页」报错样例（桩）
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { nameMatchesTarget, openWorkflowLoadVerdict, openWorkflowRouteError, toIntOrNull } from "./canvas-open-workflow.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  \u2717 ${name}\n    ${(e && e.message) || e}`);
  }
}

console.log("openWorkflow 链路纯函数");

test("nameMatchesTarget：全串 / 基名 / 去扩展名 / 反斜杠归一；空与不匹配为 false", () => {
  assert.strictEqual(nameMatchesTarget("hui-edit4-narrative.json", ["hui-edit4-narrative"]), true);
  assert.strictEqual(nameMatchesTarget("workflows\\hui-edit4-narrative", ["workflows/hui-edit4-narrative.json"]), true);
  assert.strictEqual(nameMatchesTarget("HUI-EDIT4-NARRATIVE", ["hui-edit4-narrative"]), true);
  assert.strictEqual(nameMatchesTarget("other", ["hui-edit4-narrative"]), false);
  assert.strictEqual(nameMatchesTarget("", ["x"]), false);
  assert.strictEqual(nameMatchesTarget("x", []), false);
});

test("loadVerdict：到达 + summary 一致 → loaded:true（arrived+summary）", () => {
  const v = openWorkflowLoadVerdict({ arrived: true, expectedNodes: 34, summaryNodeCount: 34 });
  assert.strictEqual(v.loaded, true);
  assert.strictEqual(v.reason, "arrived+summary");
});

test("loadVerdict：未到达 → loaded:false（not_arrived）", () => {
  const v = openWorkflowLoadVerdict({ arrived: false, expectedNodes: 34, summaryNodeCount: 34 });
  assert.strictEqual(v.loaded, false);
  assert.strictEqual(v.reason, "not_arrived");
});

test("loadVerdict：到达但 summary 节点数冲突 → loaded:false（summary_mismatch）", () => {
  const v = openWorkflowLoadVerdict({ arrived: true, expectedNodes: 34, summaryNodeCount: 9 });
  assert.strictEqual(v.loaded, false);
  assert.ok(/summary_mismatch/.test(v.reason));
});

test("loadVerdict：summary 不可得 → 以到达为准（arrived_only）", () => {
  const v = openWorkflowLoadVerdict({ arrived: true, expectedNodes: 34, summaryNodeCount: null });
  assert.strictEqual(v.loaded, true);
  assert.strictEqual(v.reason, "arrived_only");
});

test("toIntOrNull：null/undefined/空串 → null（不能把「取不到」当 0）", () => {
  assert.strictEqual(toIntOrNull(null), null);
  assert.strictEqual(toIntOrNull(undefined), null);
  assert.strictEqual(toIntOrNull(""), null);
  assert.strictEqual(toIntOrNull("34"), 34);
  assert.strictEqual(toIntOrNull(0), 0);
  assert.strictEqual(toIntOrNull("x"), null);
});

test("routeError：no_page → no_live_page_matching_name + path= 指引", () => {
  const r = openWorkflowRouteError({ error: "no_page", wantWf: "hui-edit4-narrative" });
  assert.strictEqual(r.code, "no_live_page_matching_name");
  assert.ok(r.text.includes("hui-edit4-narrative"));
  assert.ok(r.text.includes("path="));
});

test("routeError：no_live_page（只剩过期页）→ 同码，提示先刷新/重开", () => {
  const r = openWorkflowRouteError({ error: "no_live_page", wantWf: "x" });
  assert.strictEqual(r.code, "no_live_page_matching_name");
  assert.ok(r.text.includes("过期"));
});

test("routeError：timeout 区分「有页未响应」(带定向名) 与「无页回传」(无定向名)", () => {
  const routed = openWorkflowRouteError({ error: "timeout", wantWf: "x" });
  assert.strictEqual(routed.code, "route_no_response");
  assert.ok(routed.text.includes("有在线页但未响应"));
  const bcast = openWorkflowRouteError({ error: "timeout", wantWf: "" });
  assert.strictEqual(bcast.code, "canvas_no_response");
});

test("routeError：非路由类错误 → null（交回通用口径）", () => {
  assert.strictEqual(openWorkflowRouteError({ error: "copilot_off", wantWf: "x" }), null);
  assert.strictEqual(openWorkflowRouteError({ error: "internal", wantWf: "x" }), null);
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);

if (process.argv.includes("--sample")) {
  // 桩：模拟 `canvas.openWorkflow` 带 name 路由但无在线页打开该工作流（不触真实画布）。
  // 桥回执形状取自 app/bridge/__init__.py 的 no_page 分支（error/detail/pages）。
  const stubInv = {
    ok: false,
    error: "no_page",
    detail: "没有页面正打开「hui-edit4-narrative」",
    pages: [
      { sid: "ab12cd34", workflow: "Qwen21 t2i+edit 质量版", stale: false },
      { sid: "ef56ab78", workflow: "(未命名)", stale: false },
      { sid: "0999dead", workflow: "hui-edit3", stale: true },
    ],
  };
  const brief = stubInv.pages
    .slice(0, 8)
    .map((p) => `${p.sid}\u2026\u300c${p.workflow || "(未命名)"}\u300d${p.stale ? "（过期）" : ""}`)
    .join(" / ");
  const routeMsg = openWorkflowRouteError({ error: stubInv.error, wantWf: "hui-edit4-narrative" });
  console.log("\n\u2500\u2500 桩：openWorkflow(name=\u2026) 无匹配在线页（不触真实画布）\u2500\u2500");
  console.log(`桥回执（桩）：${JSON.stringify(stubInv)}`);
  console.log(`\napp 层报错（op=openWorkflow, workflow="hui-edit4-narrative"）：`);
  console.log(`[${routeMsg.code}] ${routeMsg.text}`);
  console.log(`- 在线页面：${brief}`);
}

process.exitCode = fail ? 1 : 0;
