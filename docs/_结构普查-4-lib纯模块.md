# 结构普查 · 4 · lib 纯模块（`app/lib/`）

> 范围：画布语义层 / 提交历史 / 工作流工具 / 泳道算法 的纯模块库（只读普查，未改动任何源码）。
> 共普查 **11 个目标条目**：10 个源 `.mjs`（`canvas-analysis` `canvas-edit` `canvas-diff` `canvas-history` `canvas-outline` `canvas-project` `canvas-symbol` `commit-graph-lanes` `canvas-open-workflow` `workflow-tools`）+ `canvas-perf`（仅 `.test.mjs`，无同名源模块）。另有 10 个 `.test.mjs` 一并记录。
> 所有模块零运行时依赖（仅 `canvas-history` 引入 `node:path`），可被 `node:test` 直接单测。

---

## 一、主表（文件 → 职责 → 关键导出 → 依赖/被依赖）

| 文件 | 职责 | 关键导出（行号） | 依赖 | 被依赖（引用方） |
|---|---|---|---|---|
| `canvas-symbol.mjs` | 符号行 + 语义版本常量（L3 符号层轻量落地件） | `SEMANTIC_REV`（L17，`"s1"`）；`formatNodeSymbol(node)`（L26） | 无 | `canvas-analysis`(L52) `canvas-diff`(L17) `canvas-outline`(L29) `canvas-project`(L27) |
| `canvas-analysis.mjs` | 画布语义层 P2：体检 `check` + 追踪 `trace`（纯函数，输入 UI 格式 JSON） | `analyzeGraph(graph, options)`（L356）；`traceGraph(graph, options)`（L430） | `canvas-symbol` | `canvas-outline`(L28)、`workflow-file.mjs`(L31)、`canvas-open-workflow`(仅注释引用口径) |
| `canvas-project.mjs` | 画布语义层 P1：投影过滤器（选子图 `select` + 选字段 `fields`） | `projectGraph(graph, {select, fields})`（L171） | `canvas-symbol` | `workflow-file.mjs`(L30)、`canvas-perf.test.mjs`(L8) |
| `canvas-outline.mjs` | 画布语义层 P3：大纲 `outline`（块识别 + 块间连线 + 下钻 `detail:nodes`） | `outlineGraph(graph, options)`（L73） | `canvas-analysis`、`canvas-symbol` | `workflow-file.mjs`(L32)、`canvas-perf.test.mjs`(L9) |
| `canvas-diff.mjs` | 画布语义层 T2：两版语义 diff（节点/连线/组，顺序无关） | `diffGraph(base, next)`（L194） | `canvas-symbol` | `workflow-file.mjs`(L33) |
| `canvas-edit.mjs` | 文件版 patch 编辑引擎（对 UI JSON 的纯数据变换：addNode/setWidget/connect/disconnect/setNodeMode/removeNode/save + addGroup/setGroup/removeGroup/cloneNodes） | `FILE_PATCH_ALLOWED`(L33) `FILE_PATCH_FORBIDDEN`(L37) `PATCH_REF_FIELDS`(L38)；`parseFilePatchEdits(raw)`(L118)；`applyFilePatch(graph,list,opts)`(L743)；`scanStructuralProblems(graph)`(L785)；`diffStructuralProblems(before,after)`(L840) | 无（注释引用 `canvas-analysis` 的 `resolveSlot` 口径） | `workflow-file.mjs`(L39 整批 import) |
| `canvas-history.mjs` | 画布提交历史 P1/P5a：快照库（命名/构造/序列化/索引解析/签名，零副作用不碰磁盘） | 常量 `SCHEMA_VERSION`(L19)=2 `MAX_NAME_LEN`(L21) `UNTITLED`(L23) `STRIPPED_IMAGE_PLACEHOLDER`(L25)；`normalizeSource`(L41) `sanitizeWorkflowName`(L62) `historyDir`(L79) `snapshotFileName`(L92) `buildSnapshot`(L113) `stripHeavyFields`(L162) `graphSigIgnoringSeed`(L268) `computeDelta`(L346) `shouldMergeWithHead`(L379) `buildIndexLine`(L457) `parseIndex`(L486) `normalizeEntry`(L513) `nextSeq`(L536) `latestEntry`(L556) | `node:path` | `runtime/history-commit.mjs`(L36) |
| `canvas-open-workflow.mjs` | openWorkflow 链路纯函数（T3-1 落定判定 / T3-3 路由失败文案，脱真实画布可桩测） | `toIntOrNull`(L12)；`nameMatchesTarget`(L19)；`openWorkflowLoadVerdict`(L36)；`openWorkflowRouteError`(L50) | 无 | `app/index.js`(L29) |
| `commit-graph-lanes.mjs` | W1 泳道算法（纯函数：entries→泳道分配+全量显示） | `commitGraphLanes(entries)`(L17)；`export default`(L58) | 无 | **仅自身 `.test.mjs`**；执行副本内联在 `app/bridge/js/hana-bridge-10131713.js`(L4663)（见第四节特别标注） |
| `workflow-tools.mjs` | 工作流解析/转换/注入（app 与中继共享，UI→API 转换 + inputs 注入） | `isPlainObject`(L6) `NOTE_TYPES`(L10) `UNSUPPORTED_UI_TYPES`(L11)；`convertUiToApi(wf,objectInfo)`(L35)；`applyInputs(prompt,inputs)`(L151)；`summarizeWorkflow(parsed)`(L171) | 无 | `workflow-file.mjs`(L29)、`runtime/comfy-relay.mjs`(L55) |

> 说明：`canvas-perf` 无同名源模块，只有 `canvas-perf.test.mjs`（性能烟测，导入 `canvas-project` 与 `canvas-outline`）。`workflow-tools.mjs` 无独立 `.test.mjs`。

---

## 二、依赖有向关系（谁依赖谁）

```
canvas-symbol  ──► canvas-analysis ──► canvas-outline ──► workflow-file
     │                │                    │
     │                └────────► workflow-file
     │                └────────► canvas-open-workflow(注释口径)
     ├──► canvas-diff  ──► workflow-file
     └──► canvas-project ──► workflow-file / canvas-perf.test

canvas-edit    ──► workflow-file
canvas-history ──► runtime/history-commit.mjs
canvas-open-workflow ──► app/index.js
workflow-tools ──► workflow-file / runtime/comfy-relay.mjs
commit-graph-lanes ──► (桥内联副本) app/bridge/js/hana-bridge-10131713.js
```

- 叶子（无人依赖）：`canvas-symbol`、`canvas-edit`、`canvas-history`、`canvas-open-workflow`、`commit-graph-lanes`、`workflow-tools`。
- 聚合消费点：`workflow-file.mjs` 同时消费 analysis/project/outline/diff/edit/workflow-tools 共 6 件；`app/index.js` 与 `runtime/*` 各消费 1 件。
- `commit-graph-lanes.mjs` 不被任何 app `.mjs`/`.js` 文件 import——它是桥内联副本的「镜像参考 + node 单测载体」（详见第四节）。

---

## 三、测试覆盖（每个 `.test.mjs`）

| 测试文件 | 覆盖内容 | 运行方式 |
|---|---|---|
| `canvas-symbol.test.mjs` | `formatNodeSymbol` 各形态（无 title / 无 widgets / 多值 / >40 字截断 / `#?` / 数字串 id / 非对象抛错）；`SEMANTIC_REV="s1"` | `node app/lib/canvas-symbol.test.mjs` |
| `canvas-analysis.test.mjs` | check：互斥优先级、rules 裁剪(core/domain/all)、`MISSING_REQUIRED`(object_info)、domain 四类、Note 排除、rev；trace：单步 up/down、多级链、深度截断、环路/缺失引用计数、参数校验 | `node app/lib/canvas-analysis.test.mjs [--sample]` |
| `canvas-project.test.mjs` | select：`#id`/`type=`/`title~`/`#id/up[:n]`/`#id/down[:n]` 并集、fields 裁剪、空匹配、未知字段/非法 term 抛错、语义 rev | `node app/lib/canvas-project.test.mjs [--sample]` |
| `canvas-outline.test.mjs` | 双组图 group 命中/重叠取首/role 兜底/排序/块间边去重、`detail=nodes` 下钻、同名 `#k` 去重、`LoadImage` 入「加载」、复用 analyzeGraph 的 issues | `node app/lib/canvas-outline.test.mjs [--sample]` |
| `canvas-diff.test.mjs` | 节点增/删/改(含 named 值对比)、连线增/删/直替、组变化、幂等与顺序无关、仅 linkId 变化不算差异 | `node app/lib/canvas-diff.test.mjs [--sample]` |
| `canvas-edit.test.mjs` | parse 结构预检(11 种校验)、基础 edit(setWidget/addNode objectInfo+模板降级/connect/disconnect/setNodeMode/removeNode)、`$` 引用链、组操作、cloneNodes、scanStructuralProblems/diff | `node app/lib/canvas-edit.test.mjs` |
| `canvas-history.test.mjs` | 命名净化/历史目录/快照文件名/快照构造/stripHeavyFields(深拷贝不改性)/索引行/parseIndex(坏行容错)/nextSeq/latestEntry、P5a：graphSigIgnoringSeed(跨语言一致)/computeDelta/shouldMergeWithHead/normalizeEntry | `node --test app/lib/canvas-history.test.mjs` |
| `canvas-open-workflow.test.mjs` | `nameMatchesTarget` 归一、`openWorkflowLoadVerdict` 三态、`openWorkflowRouteError` 分类(no_page/timeout 区分)、`toIntOrNull` 边界 | `node app/lib/canvas-open-workflow.test.mjs [--sample]` |
| `commit-graph-lanes.test.mjs` | 线性/一次分叉/分叉后不折叠/sleeping 恒 false/确定性/孤儿·异常 parent 不抛/row=lane(去折叠) | `node --test app/lib/commit-graph-lanes.test.mjs` |
| `canvas-perf.test.mjs` | 2000 节点链式图下 `projectGraph`(全量+邻接) 与 `outlineGraph` 的墙钟耗时(<5000ms 宽松上界) + 结果确定性 | `node app/lib/canvas-perf.test.mjs` |
| （`workflow-tools` 无测试） | `convertUiToApi`/`applyInputs`/`summarizeWorkflow` 由 `workflow-file.mjs` 与 `runtime/comfy-relay.mjs` 直接调用，无独立 `.test.mjs` | — |

---

## 四、特别标注：`commit-graph-lanes.mjs` 与桥内联版的逐逻辑一致耦合

**结论：改 `commit-graph-lanes.mjs` 必须同改 `app/bridge/js/hana-bridge-10131713.js` 的内联副本（及 `commit-graph-lanes.test.mjs` 断言），否则前端执行逻辑与 node 单测会分叉。**

- **源文件自述约束**：`commit-graph-lanes.mjs` L14–15 明确写「本文件与桥内内联版（`hana-bridge-10131713.js` 的 `commitGraphLanes`）必须逐逻辑一致，改动请同改两处（含 `commit-graph-lanes.test.mjs` 断言）」。
- **桥内联版位置**：`app/bridge/js/hana-bridge-10131713.js` L4656–4705 的函数 `commitGraphLanes`（L4663 定义）。
- **为何必须内联不能 import**：桥内 CSP 下不能 `import` ESM（桥注释 L4657：「CSP 下桥内不能 import ESM，故此处必须内联；严禁改为 import」），因此前端运行的是**内联副本**，而非 `lib/` 下的 `.mjs`。
- **一致性核对（已逐段比对两处正文）**：
  - **(1) 泳道分配单遍**：均以 `active[L] === parent` 匹配继承父泳道，找不到则 `active.length` 新泳道；`parent` 必须是 `< seq` 的整数，否则（孤儿 / `parent>=seq` / 非整数 / 缺失）视同根——两处逐字一致。
  - **(2) 全量显示（2026-10-12 去折叠）**：均 `row = lane`、`rows = laneCount`、`sleepingCount 恒 0`、`lanes[].sleeping 恒 false`；输出形状 `{lanes,nodes,rows,sleepingCount}` 完全一致。
  - I/O 契约（输入 `entries` 至少 `{seq,parent}`，输出节点 `{seq,lane,row}`）两处相同。
- **当前落地状态**：`lib/commit-graph-lanes.mjs` 自身不被任何 app `.mjs`/`.js` 文件 import（grep 仅命中 `index.js` 等注释与自身 test）——它的存在价值是**可 node 单测 + 作为桥内联副本的权威参考**；真正在浏览器执行的是桥内联版。因此「改一处必须改两处」在此处是硬约束：漏改桥副本 → 前端行为偏离测试预期；漏改 lib 副本 → 测试与源码漂移。
- **连带影响**：`canvas-perf` 不覆盖本模块；若改动泳道算法逻辑，`commit-graph-lanes.test.mjs` 的 7 条断言（尤其「去折叠 row=lane」「sleepingCount=0」「同输入 deepEqual」）需同步更新，且桥内 `commitGraphLanes` 调用点（`hana-bridge-10131713.js` L4719、L4743 等树渲染路径）需回归。

---

## 五、一句话小结

`app/lib/` 是一组零依赖纯函数：语义读四件套（`canvas-project`/`analysis`/`outline`/`diff`，统一依赖 `canvas-symbol`）由 `workflow-file.mjs` 聚合消费；写通道 `canvas-edit` 与提交历史 `canvas-history`、openWorkflow 链路判定、UI→API 转换 `workflow-tools` 各服务对应 runtime/桥端点；`commit-graph-lanes` 是唯一「lib 镜像 + 桥内联」双生模块，改两处是硬要求。
