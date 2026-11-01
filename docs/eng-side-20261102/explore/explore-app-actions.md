# hui App（comfyui-hana）主进程 action 机制探索报告

探索时间：2026-11-02。对象：`C:\Users\John Galt\.hanako\apps\comfyui-hana\index.js`（7626 行 / 457,318 字节）、`manifest.json`（2,783 字节）、`ui\assets\settings.js`（482 行）、`ui\settings.html`。只读，未修改任何文件。所有行号均为行号（1 基），来自 `Get-Content` 行扫描。

---

## 一、工具注册与 schema

- 注册调用：`sdk.tools.register({...})`，**index.js:6948-7033**；工具名 `name: "comfyui"` 在 **6949**。注册包在 try/catch 里（6946/7035）。
- 参数 schema：不是手写 JSON Schema 全文，而是由 **`actionBranches()`（index.js:6742-6944）** 返回分支数组，再在注册处拼成 oneOf：**6958-6969** —— `parameters: { type:"object", oneOf: branches.map(b => ({ ... required:["action", ...b.required], properties: { action: { const: b.command }, ...b.fields } })) }`。
- **新增一个 action 需要同步改 schema：是**。schema 完全由 `actionBranches()` 驱动，不加分支则参数校验直接拒绝新 action。
- 描述文本：`description` 字符串在 **6950-6957**（逐 action 拼接的长文本，新 action 应在此补一句）。
- 注册完成日志：**7034**（action 清单也写在这句里，顺手更新）。

## 二、action 分派机制（行号）

- **switch 分派**。`execute: async (input) => {...}` 在 **6971**，取 `action` 于 6974，`switch (action)` 在 **6976-7026**，`default` 分支 **7024-7025** 抛错（错误信息里枚举全部 action 名）。
- 整个 execute 外层有统一 catch：**7027-7031**，把任何抛错转成 `{ content:[{type:"text", text:"comfyui(action) 失败：..."}], details:{ comfyui:{ action, ok:false, error } } }` 返回。

## 三、action 全表

| action | case 行 | 处理函数 | 函数定义行 |
|---|---|---|---|
| status | 6977-7012 | 内联（无独立函数） | — |
| submit | 7013 | `actionSubmit(args, context)` | 2307 |
| query | 7014 | `actionQuery(args)` | 2864 |
| result | 7015 | `actionResult(args, context)` | 2961 |
| cancel | 7016 | `actionCancel(args)` | 3008 |
| workflows | 7017 | `actionWorkflows(args)` | 3053 |
| service | 7018 | `actionService(args, context)` | 5277 |
| update | 7019 | `actionUpdate(args, context)` | 3173 |
| canvas | 7020 | `actionCanvas(args, context)` | 4356 |
| window | 7021 | `actionWindow(args, context)` | 5673 |
| llmGateway | 7022 | `actionLlmGateway(args)` | 6168 |
| upload | 7023 | `actionUpload(args)` | 3082 |
| default | 7024-7025 | throw（枚举全部 action 名） | — |

辅助/子处理函数：`actionCanvasHistoryDiff` 5079、`actionCanvasFile` 5146、`actionHandoff` 6285。

**与你给的现状锚点的差异**：你列了 10 个已知 action，实际是 **12 个**——多出 `llmGateway`（7022/6168，长轮询模型执行端）和 `window`（你也没列）。canvas 子 op 枚举在 schema 分支 **6833-6873**。lib 目录实际是 `canvas-analysis/diff/edit/history/open-workflow/outline/project/symbol.mjs` + `workflow-tools.mjs` + `node-adapter-store.mjs`，另有根级 `workflow-file.mjs`（import 在 25-34）。

## 四、返回与投递约定

- **统一返回形态**：`{ content: [{ type:"text", text }], details: { comfyui: { action, ...业务字段 } } }`。所有 action 都遵守；`details.comfyui` 是机器可读字段区。
- **卡片/回执**：没有单一 helper；两类机制——
  1. `bridgedTool` 标记：`{ name:"comfyui", server: APP_ID }` 附在 details（2511、2813、5011、5316、5389 等），让宿主把回执桥到 App 卡片。
  2. 卡引用 `envcheckCardRef(snapshotId, blockerCount, sessionPath)`：**2068-2073**，随 service envcheck/start 的 blocked 回执出卡（5317、5390）。
- **next-step 投递**：`sdk.tasks.create({ callToken, label, delivery:"next-step", metadata })` 共 4 处——
  - submit 后台跟踪：**2456-2461**（能力检查 2449-2453，`app/tasks.manage` + `app/session.start-turn`，缺则记 taskNote 不投递）；
  - submit 画布 queue 路径：**2551-2559**；
  - upload 路径内：**3120-3123** `[注：函数体边界按行号区间推断，未逐行核对该处语义]`；
  - submit 自举准备任务：**6603-6610**（ensureEnvironmentPrepared 的后台准备，进度经 next-step 通报）。
  - 子代理限制说明常量 `SUBAGENT_DELIVERY_NOTE`：**2247**（next-step 只写桌面会话，子代理不自动回执）。
- **失败如何让 agent 看到原因**：两条路——
  1. **抛错**：异常被 execute 统一 catch（7027-7031）转成文本回执 + `details.comfyui.error`，不裸抛给宿主；
  2. **blocked 范式**（预期内的停下）：**正常返回、不 throw** + `details.comfyui.blocked: true` + `code` / `reason` / `options`。范式定义 `submitStoppedReply`：**2252-2273**；分类器 `autoStopReplyForCanvasError`：**2276-2304**；service start 的同类 blocked：**5387**。范式说明注释：2249-2251。
- 文本组装无统一 helper，各 action 自拼；`msgOf(e)` 是全局错误转文本函数。

## 五、设置项与新增步骤

**架构**：设置不进 manifest，全部是 App dataDir 下的独立 JSON 文件（`dataDir = sdk.dataDir`，**index.js:218**），UI 经 App 路由读写，主进程内函数闸门。

| 设置项 | 文件常量 | 读/写函数 | 路由 | UI 复选框（settings.html） | JS（settings.js） |
|---|---|---|---|---|---|
| 服务自动拉起 | auto-start.json，651 | readAutoStart 1332 / writeAutoStart 1338 | 7213-7221 | s-auto-start，80 | loadAutoStart 130-135，handler 137-152 |
| **允许 agent 修改画布** | allow-write.json，654 | readAllowWrite 1114 / writeAllowWrite 1120 | GET/POST 7676-7685 | s-allow-write，90 | loadAllowWrite 157-162，handler 164-183 |
| **允许 Agent 开启画布副驾驶** | allow-copilot.json，662 | readAllowCopilot 1130 / writeAllowCopilot 1136 | GET/POST 7692-7701 | s-allow-copilot，97 | loadAllowCopilot 185-211 |
| 出图实时预览 | preview-settings.json，669 | （区段 1160 附近） | 7231-7241 | s-preview-enabled，108 | loadPreview 230-240，handler 275-293 |
| 启动参数 | launch-settings.json，1176 | readLaunchSettings 1207 / writeLaunchSettings 1217 | 7266-7287+ | （JS 动态建 DOM，353-427） | loadLaunch 429-439，handler 441-465 |

main() 的加载调用在 settings.js **472-478**。

**闸门的使用点**（新增设置要仿照）：`readAllowWrite()` 在 2598、3487、4220、4383、5219 等处拦截；`readAllowCopilot()` 在 1328、2644、3488、4221；诊断文本汇总在 2192、3485-3499。

**新增一个设置项的完整步骤**（6 步，全部有先例行号）：
1. index.js 常量区（~651-672）加 `const xxxFile = join(dataDir, "xxx.json")`；
2. 仿 1114-1141 加 `readXxx()` / `writeXxx()`（writeFileSync 带 `mode: 0o600`，失败 warn）；
3. 仿 7676-7701 加 GET/POST 路由 `/comfyui-hana/xxx`；
4. settings.html 加 `<label class="chk"><input type="checkbox" id="s-xxx">…</label>`（仿 90/97）；
5. settings.js 加 `loadXxx()` + change handler（仿 157-211），main() 里补一行（472-478 区）；
6. 在需要拦截的 action 内用 `readXxx()` 做闸门，并在 diagnoseEnvironment（3448-3499）的 reasons 里补一条。

## 六、能力声明（manifest.json）

- `capabilities` 数组：**manifest.json:21-31**，现有 9 项：`app/runtime.execute`、`app/runtime.local-machine`、`app/runtime.network`、`app/resources.read`、`app/models.infer`、`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`、`app/windows.manage`。
- `network` 块：**manifest.json:10-19**——`allowedHosts: ["127.0.0.1"]`、`methods: ["GET"]`、`allowLocalhost: true`、defaultTimeoutMs 5000、maxResponseBytes 1MB。UI CSP 另有 `ui.csp`（frameDomains/connectDomains，均 127.0.0.1:8188）。
- 运行时能力账本查询：`capabilitiesMap()` index.js **363-377**（30s 缓存）、`hasCapability()` **379-384**；窗口能力检查 `requireWindowsCapability()` 5460-5472。
- **新增"访问网络/读写磁盘"要不要改 manifest**：
  - 读写磁盘：`app/runtime.execute` + `app/runtime.local-machine` 已在清单里，**不需要改**。
  - 访问网络：`app/runtime.network` 已有，但 `network.allowedHosts` 目前只有 `127.0.0.1`、`methods` 只有 `GET`。若 `deps`/`templates` 要访问**本机 127.0.0.1** 用 GET → 不改也行；若要访问**外部主机或 POST** → 需要改 `network.allowedHosts` / `methods`（10-19 行）。
  - `[不确定]` capabilities 数组本身是宿主强校验还是声明式清单，未验证（只观察到缺 `app/tasks.manage` 时由代码自行降级，2450-2453）。

## 七、统一"提交前处理"入口

**没有所有 action 共用的前置钩子**。现状是三种分散机制：

1. execute 级统一 catch（7027-7031）——只在事后兜底，不做前置检查。
2. 环境诊断 `diagnoseEnvironment(opts)`：**3448**（返回 `{ relayOk, serviceOk, shellOk, pageOk, pageVia, running, probe, allowWrite, allowCopilot, reasons }`，见 3447 注释）——由 status（6984，deep:true）和 submit auto（2347）各自调用，不是分派层强制的。
3. 自举 `ensureEnvironmentPrepared(opts)`：**6373**（单一互斥；服务段 envcheck→start→多轮 wait，见 6362-6364 注释）——只服务 submit 自举链（submitBootstrapFlow 6557 / runBootstrapContinuation 6641）。

新 action 若需要环境（如 validate 要连后端取 object_info），应像 submit 那样在自己的函数里先调 `diagnoseEnvironment()`；若只读本地文件（templates/deps）可以不依赖。

## 八、新增 validate / templates / deps 的最小改动清单

每个 action 的公共骨架（3 处必改 + 2 处顺手）：

| # | 位置 | 改什么 |
|---|---|---|
| 1 | index.js:6742-6944（actionBranches） | 各加一个 `{ command:"validate"|"templates"|"deps", required:[...], fields:{...} }` 分支（建议插在 update 分支 6826 之后或 workflows 6800 之后） |
| 2 | index.js:7023 附近（switch） | 加三个 `case "validate": return await actionValidate(args, context);` 等 |
| 3 | index.js:7025（default throw） | 错误消息的 action 枚举补上三个新名字 |
| 4 | index.js:6950-6957（description） | 每个 action 补一句用途说明（影响模型选参，建议别省） |
| 5 | index.js:7034（注册日志） | 枚举顺手更新（纯一致性） |

三个处理函数的建议落点与形态：

- **actionValidate**：放 update 区附近（3173 后）或 submit 区（2307）之后。若校验要连 ComfyUI 后端取 object_info → 函数内先 `diagnoseEnvironment()`（3448），缺环境时按 blocked 范式（仿 `submitStoppedReply` 2252-2273，返回 `details.comfyui.blocked`，不 throw）；纯结构校验则可复用已 import 的 `analyzeGraph`（26）/ `workflow-tools.mjs` 的 `summarizeWorkflow`（29）。可复用 `workflows` action 的文件定位逻辑（actionWorkflows 3053 / `resolveWorkflowPath`，import 28）。
- **actionTemplates**：只读 `userdata/workflows` 目录，逻辑与 actionWorkflows（3053）高度重叠——最小实现可以是 `actionWorkflows` 的超集（列出 + 返回模板元信息），甚至不加新 action、给 workflows 加个 field；是否独立成 action 由你拍板。零环境依赖，无闸门。
- **actionDeps**：读 ComfyUI 安装目录（custom_nodes / models / python 包），需要定位安装根——现成探测在中继侧（envcheck 返回的 installs，settings.js 63-75 有引用；index.js 内 relayEnvcheck 5255-5264）。若只读本地文件不改 manifest；若要 pip/git 操作则 `app/runtime.execute` 已覆盖。
- **返回形态**：三个都照统一形态 `{ content:[{type:"text",text}], details:{ comfyui:{ action, ... } } }`；要桥卡片就加 `bridgedTool` 字段（仿 5011）。
- **投递**：三个都是即时查询型，**不需要** tasks.create / next-step。

**共用 lib 模块建议（仅建议，非结论）**：建议新建一个 `lib/app-maintenance.mjs`（或类似名）放三个 action 的纯逻辑（输入 args → 返回结构化结果），index.js 只留薄壳：取参数、调诊断/闸门、拼回执。理由：index.js 已 7626 行且目录里 lib/*.mjs + 同名 .test.mjs 是既有惯例（canvas-analysis、workflow-tools 均如此），纯逻辑进 lib 才能进测试；validate 的图分析可直接 import 进该模块统一依赖。templates 与 workflows 重叠的部分若你决定复用 actionWorkflows，则 lib 模块只需装 validate + deps。**这是建议，是否采纳需你拍板。**

## 九、不确定项

1. `sdk.tools.register` 的 schema 由宿主强校验还是仅提示——未验证；保守起见按"必须同步改 actionBranches"处理。
2. manifest `capabilities` 数组是强校验还是声明式——未验证（见第六节）。
3. 3120-3123 的 tasks.create 按行号区间归入 actionUpload，但该处语义（为何 upload 会建宿主任务）未逐行核对。
4. `execute` 的 `context` 参数（7013 等传入）的完整字段（已知用到 `context.sessionPath`，5317）未全面梳理。
5. read 工具对 index.js 只返回前 409 行（codemode 内），本报告全部行号来自 PowerShell `Get-Content` 全量扫描，行号本身可信；但个别函数体边界（如 3120 归属）是按相邻函数定义行推断的。
