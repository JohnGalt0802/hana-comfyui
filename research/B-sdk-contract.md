# B · HanaAgent v2 App SDK 能力契约调研报告

- 项目：ComfyUI-Hana（把本机 ComfyUI 前端与能力作为原生 v2 App 移植进 Hana，Agent-native 适配）
- 调研日期：2026-09-21（会话时）
- 本机 Hana 版本：**0.1013.2**（`C:\Users\John Galt\.hanako\last-update-version`）
- 结论标注约定：`【读码】`=直接读过源码/类型/官方文档确认；`【实测】`=对本机现装产物/安装状态的直接观察（仍为只读）；`【推断】`=由已读材料推导，非文档原文；`[不确定]`=资料未覆盖或无法确认。
- 本轮为纯只读调研，未做运行时实测（未启动/驱动任何进程）。

## 0. 调研来源清单（全部为本机权威材料）

| 来源 | 路径 | 说明 |
|---|---|---|
| 官方开发指南（主文档，中文，2687 行） | `C:\Users\John Galt\.hanako\artifacts\server\0.1013.2-win32-x64-0c4a512d36b007db-ge82f5aaf7ce9a6df\APPS.md` | 与 0.970.9 旧版并存，本报告以 0.1013.2 为准 |
| 官方开发指南（英文） | 同目录 `APPS_EN.md`（342KB） | 内容为中文版同源 |
| 官方创作 Skill | `C:\Users\John Galt\.hanako\skills\hana-app-creator\SKILL.md` + `references\builder.md` | 含脚手架、校验、Builder 工作流 |
| 作者 SDK 类型包（`@hana/app-sdk`） | `C:\Users\John Galt\.hanako\skills\hana-app-creator\assets\sdk\hana-app-sdk.tgz`（packedVersion 0.1013.0） | manifest、ctx、bus 动词、能力词的完整 `.d.ts` |
| 浏览器侧 SDK 包（`@hana/plugin-sdk`） | 同目录 `hana-plugin-sdk-0.0.0.tgz` | 卡片/页面 iframe 里的 `hana` 对象、README 契约 |
| 协议/组件包 | 同目录 `hana-plugin-protocol-0.0.0.tgz`、`hana-plugin-components-0.0.0.tgz` | iframe↔宿主协议常量；React 同源组件 |
| 内置 App 样板 | `...\artifacts\server\0.1013.2...\apps\jimeng-cli\manifest.json` | 媒体提供方形态样板 |
| 本机已装 App | `C:\Users\John Galt\.hanako\apps\{dshana, hana-builder, hana-downloader, llama-monitor, powershell-tool, savetoken}` | 全部为 `manifestVersion: 2`【实测】 |
| 公开检索（anysearch） | — | 公开网络**未找到**独立可用的 v2 App SDK 文档；GitHub `liliMozi/openhanako` 现只公开 v1 的 `PLUGINS.md`，未见 `APPS.md`。SDK 也未上公开 npm（包内 `private: true`） |

---

## 1. v2 App 基础：manifest 与装载

### 1.1 什么是 v2 App【读码】

> 一个 v2 App 是一份 `manifest.json` 和它声明的入口。入口通过 `defineApp(async sdk => …)` 注册工具、UI 或其他已发布能力。宿主负责装载、授权，并在停止、失败或卸载时回收注册。底层执行模型使用 cordis fiber。

v1/v2 编号量的是**装载机制与 manifest 格式**，不是 UI 世代；v1 已是永久冻结的兼容层，所有新扩展都用 v2 App（来源：APPS.md §v2 是什么；SKILL.md 开头）。

### 1.2 manifest 顶层字段全表【读码：APPS.md §目录与 manifest 字段表 + `hana-app-sdk.tgz!dist/app-contract/manifest.d.ts`】

| 字段 | 必填 | 规则与含义 |
|---|---|---|
| `manifestVersion` | 是 | 必须恰等于 `2`（不是下限；v3 清单会被拒） |
| `id` | 是 | 非空字符串；**必须与所在目录名一字不差**；不能含 `/`、`\`、`:` |
| `name` | 是 | 非空字符串，批准弹窗显示名 |
| `version` | 是 | 非空字符串；宿主不解析语义 |
| `entry` | 是 | 相对路径；解析后必须落在应用目录内（绝对路径 / `../` 拒绝） |
| `icon` | 是（新包） | 包内 PNG/JPEG/WebP/SVG 相对路径（如 `assets/icon.png`）；宿主自动生成 ≤256px 展示图；旧无图包兼容读取 |
| `capabilities` | 否 | 字符串数组；申请的能力账本词（见 §6.4）；缺省空数组 |
| `description` | 否 | 字符串；市场「已安装」列表副标题与详情页说明 |
| `hidden` | 否 | 布尔；`true` 时照常运行但不出现在已安装列表 / `extension_manager list` |
| `minAppVersion` | 否 | 形如 `MAJOR.MINOR.PATCH`；低于宿主版本时装载 `failed`（带理由，不跑 apply） |
| `formFactors` | 否 | 字符串数组；卡片形态过滤的顶层缺省 |
| `network` | 否 | 受控出站通道声明：`allowedHosts` / `methods` / `allowLocalhost` / `defaultTimeoutMs`（默认 15000）/ `maxResponseBytes`（默认 5MiB）。**未知键（含 v1 的 `hosts`）整应用拒载**；不声明时 `ctx.network.fetch` 抛 `PLUGIN_NETWORK_NOT_DECLARED` |
| `activation` | 否 | `{ mode: "on-demand", tools: [...], idleTimeoutMs? }`；静态工具声明必须与运行时注册严格一致；省略 = 启动时加载 |
| `contributes` | 否 | 贡献声明对象（见 §1.3） |

### 1.3 `contributes` 子键全表【读码：APPS.md 各章节 + manifest.d.ts】

| 键 | 形态 | 要点 |
|---|---|---|
| `settings` | `{ title?, schema?, ui?: { route } }` | `schema`/`ui` 至少一个；schema 词汇见 §6.1；注册发生在 `apply` 跑完之后 |
| `ui` | 七类入口 | `messageActions`(≤2) / `cardChrome`(≤4) / `slots`(≤8) / `slotContributions`(≤16) / `contextMenus`(≤8，3 面开放) / `keybindings`(全局快捷键，需非 Shift 修饰键) / `inputStatus`(输入栏按钮与状态) |
| `cards` | 数组 | 黑板卡 / 整页卡 / 流内映射卡（详见 §3） |
| `messageRenderers` | `[{ customType, cardId }]` | 自定义消息 → 流内卡映射（详见 §5） |
| `agentTypes` | 数组 | 私有 Agent 类型；**逐条校验、坏条丢条不炸应用**（v1 对齐纪律） |
| `providers` | 数组 | 静态 Provider 身份 `{ id, displayName, authType, capabilities }`；纯数据，非权限 |
| `nativeProviders` | 数组 | 原生模型回调的完整描述符 |
| `previewers` | 数组 | 文件查看器/编辑器声明 `{ id, title, selectors, route, mode: "read"|"edit" }`；身份 `app:<appId>/<id>` |
| `cliFlags` | 数组 | `hana serve -- --app.<id>.<flag>` 的静态启动参数 |
| `homeActions` | ≤4 条 | 扩展首页动作 `{ id, title, toolName, args?, icon? }` |

**拒收纪律**：清单是数据不是模块，所有检查发生在 `import()` 之前；未知键 / 结构错误 → 整个应用 `failed`，代码一行不跑。个别键（如 cards 里一条非法 route、agentTypes 一条坏条目）走「丢条 + 警告」不炸应用。UI 表注册在 `apply` 之后，注册被拒会连带整个应用 `failed` 并撤回先注册的表。

### 1.4 安装位置与加载机制【读码】

```text
<HANA_HOME>/                     （本机 = C:\Users\John Galt\.hanako）
├── apps/<id>/                   ← 安装目录（目录名 == manifest.id）；对子进程只读
│   ├── manifest.json
│   ├── index.js                 ← 入口（或 index.mjs 等）
│   ├── ui/                      ← 静态 UI 树（卡片/页面/设置页/FP 都在这里）
│   ├── sdk/                     ← 随包携带的本地 SDK 拷贝（脚手架产物）【实测 llama-monitor】
│   ├── skills/                  ← 可选，应用自带技能（见 §7.3）
│   └── routes/                  ← 可选，后端路由目录（见 §1.5）
└── app-data/<id>/               ← 数据目录（懒建、卸载保留）
    ├── storage/global.json      ← ctx.storage.global
    ├── storage/agent-<id>.json  ← ctx.storage.agent
    └── generated/               ← 媒体适配器产物（generatedDir）
```

- **扫描与启动**：服务端启动时扫 `apps/`；只有扩展注册表里**已有安装记录、且记录带 approval** 的应用才会启动。目录在、没有记录 = `unregistered`：不 import、不上树、一行代码不跑（可在市场「已安装」页「待批准」区块批准或拒绝；批准走 `POST /extensions/install`，`source: { type: "unregistered", id }`）。**进程跑起来后新扔进 `apps/` 的目录要下次启动才被扫到**。
- **五个状态**：`unregistered` / `loaded` / `failed`（一定带理由）/ `stopped`（崩溃重启用尽）/ `disabled`。没有"静默跳过"档。
- **执行模型**：每个已批准应用 = **一个独立 Node 子进程**（入口 `app-host-entry.js`）；宿主用 JSON-RPC 代理公开成员；RPC 超时默认 30s，`apply` 最长 60s。
- **砂箱**：子进程开 Node Permission Model——安装目录只读、`app-data/{id}` 可写；**不开** `--allow-net` / `--allow-worker` / `--allow-addons`；`--allow-child-process` 仅在授予 `app/process.spawn` 后开、且**下次启动才生效**。环境变量只给 `PATH` / `HOME` / `TMPDIR` / `LANG` + 只读 `HANA_LOCALE_DIR`。
- **崩溃**：非正常退出后按 1s/5s/30s 退避重启最多 3 次，耗尽记 `stopped`（本进程内不能复活，重启 server 才会按 approvals 再装）。
- **重载**：没有 in-place 热重载；本地目录安装的可在详情页「重新加载」（`POST /extensions/:ref/reload`）。普通编辑直接重启；**扩大权限声明/网络范围会先进审查**，取消则保留旧实例；缩小权限不提示。市场安装的没有本地重载路径。重载成功会自动刷新该 App 已打开的卡片/整页/聊天卡/设置页/FP/iframe 插槽（`hana.state` 的卡片状态与布局保留）。内置 App（0.978+）支持 force reload；忙碌时不排队。
- **内置 App**：以打包产物存在于 `artifacts/server/<版本>/apps/<id>/`（如 `jimeng-cli`），非源码直装。
- **卸载**：等实例清理与后台删除完成才成功；删 `apps/{id}`、清 approval 行、**保留 `app-data/{id}`**。
- **验证工具链**（作者侧）：`node scripts/validate-app.mjs --dir <app> --json`（静态）/ `--smoke`（临时 AppHost + Electron 启动验证）/ `--archive <zip> --smoke`；打包 `pack_app.mjs`；归档上限压缩 256MiB / 展开 512MiB / 30000 条目。

### 1.5 应用自带后端路由（两条互斥路径）【读码：APPS.md §应用自带后端路由】

- **单 bundle**：`apply(ctx)` 里调用一次 `ctx.routes.register((app) => { app.get("/card", ...) })`（Hono app；registrar 可返回 Promise，装载器等它落定才发布；二次调用 → 整应用 `failed`）。
- **兼容目录**：`routes/` 下顶层 `.ts`/`.js` 文件（三种导出：default 静态 Hono 子 app 按文件名前缀挂载 / default 工厂 `(app, ctx)` / 具名 `register(app, ctx)`）。
- **URL 面**：`/api/apps/<appId>/routes/<子路径>`。
- **鉴权两通道**（档位 `app_route`，与 `ui/` 文档同档）：
  1. 宿主登录态（本机 owner 或工作室主人 scope）；
  2. **App 自己的 surface session**——iframe 装载时随 URL query 下发 `appSurfaceSession`，页面请求时用 header `X-Hana-App-Surface-Session` 回传（header 优先；也可用 query 本身）。票据必须绑路径上的 `appId`。
- **handler 上下文**：`c.get("appRequestContext")` = 冻结的 `{ appId, agentId, principal }`；`?agentId=` 显式传且进程内存在才有效；**入口凭证会被剥离**，handler 永远看不到原文。
- **错误隔离**：programmatic 路由出错 → 整应用 `failed`；目录路由单文件坏只丢该文件；整段坏只停该应用的 routes，其余贡献照常。
- **浏览器侧调用**：`hana.api.fetch(path, init)` 自动构 `/api/apps/{appId}/routes/{path}` 并带 surface session header；`hana.api.url(path)` 直接取 URL。

---

## 2. defineApp / 入口 API 与生命周期

### 2.1 入口写法【读码：APPS.md §官方 SDK；`server-client.d.ts`；`llama-monitor/index.js`（实测样式）】

```ts
import { defineApp } from "@hana/app-sdk/server";          // 官方导入
// 或随包本地拷贝（脚手架/已装 App 的惯例）：
import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.tools.register({ name: "my_app_hello", description: "…", parameters: {…}, execute: async (args) => ({…}) });
});
```

- `defineApp(setup)` 返回 `{ apply(context) }`，由宿主装载器调用；`createAppSdk(ctx)` 适配宿主入口上下文。
- **注册方法返回可调用回执**（`AppRegistration`）：`ready`（Promise）+ `disposeAsync()`；注册动作在 `apply` 返回后、装载器发布贡献前排干。
- **便捷成员全部异步化**：`logger.*`、`bus.emit`、`config.set`、`network.fetch`、`storage.*`、`listOwn` 等返回 Promise；`apply` 内不 await 也会被装载器兜底等待；fire-and-forget 必须自己吞 rejection（llama-monitor 实测写法有 `fire()` 包装）。
- 权限/参数错误抛 `AppSdkError`（带 `code` / `operation` / `kind` / `capability` / `appId`）。

### 2.2 生命周期【读码】

| 阶段 | 行为与约束 |
|---|---|
| 装载 | 安装确认的能力在**首次 `defineApp` 回调前已生效**（不要加轮询等授权）；`apply` 成功 → `loaded`；抛错 → `failed` |
| 按需激活（可选） | `activation.mode: "on-demand"` + 静态工具声明；宿主先登记静态贡献，首次工具/路由调用才启动代码；并发首调共用一次启动 |
| 空闲回收 | `idleTimeoutMs`（0=不回收，启用时 ≥1000ms）；有活动调用/任务/受管程序/流时不回收 |
| 重载 | 见 §1.4；注册全部随旧 fiber 一并收回 |
| 停止/卸载 | 子进程终止、树摘除、注册回收 |
| 崩溃 | 最多 3 次退避重启，然后 `stopped` |

### 2.3 `apply` 收到的对象（服务端 `ctx` 完整成员表）【读码：APPS.md §apply 收到什么 + `context.d.ts`】

`ctx` 是**冻结的公开成员**对象（不是 cordis context，拿不到宿主任意服务）：

| 成员 | 主要方法 | 一句话 |
|---|---|---|
| `ctx.tools` | register / listOwn / list({scope}) | 注册模型可调用工具（见 §7.1） |
| `ctx.commands` | register / listOwn / list | 斜杠命令（identity 固定 `source:"app"`、permission `"owner"`） |
| `ctx.hooks` | onDecision / on | 会话钩子裁决与观察（见 §7.4） |
| `ctx.tasks` | create/get/list/update/complete/fail/cancel/requestApproval/respondApproval/watch/registerHandler/schedule... | 后台任务与审批（见 §6.5） |
| `ctx.models` | list / stream / utility / cancel | 宿主代理模型推理（需 `app/models.infer`） |
| `ctx.media` | registerAdapter / registerCapabilitySource / listTasks / getTask / addModel... | 媒体提供方与任务（需 `app/media.provide`） |
| `ctx.providers` | register / unregister | 原生模型 Provider |
| `ctx.runtime` | start / list / get / stop / watch / fetch | 受管程序与本地服务（见 §6.6） |
| `ctx.mcp` | list / get / update / setEnabled / removeData | MCP 管理（`app/mcp.*`） |
| `ctx.network` | fetch(url, init?) | 受控出站 HTTP（清单 `network` 声明 + 宿主闸门） |
| `ctx.routes` | register | 后端路由（见 §1.5） |
| `ctx.resources` | 十七个 ResourceIO 方法 + `stage` / `register` | 资源读写（`app/resources.read|write`） |
| `ctx.documents` | read / readRelated / writeExpectedVersion / requestView | 绑定预览文档的受限 IO |
| `ctx.storage` | global / agent(agentId?) — 各 6 方法 | KV 存储（见 §6.2） |
| `ctx.config` | get/getAll/getSchema/getState/set/setMany/forkSession/discardSession | 声明式设置读写 |
| `ctx.bus` | emit / subscribe / handle / request / hasHandler / getCapability / listCapabilities | 总线（见 §4） |
| `ctx.userInteraction` | ask / show / dismiss / updatePanel | 问用户 / 常驻输入面板 |
| `ctx.inputBanner` | set / dismiss | 输入框上方提示条 |
| `ctx.inputStatus` | set / remove | 输入栏按钮与状态 |
| `ctx.shortcuts` | register | 全局快捷键（需 `app/ui.keybindings`） |
| `ctx.messageRenderers` | register | 动态消息渲染映射（需 `app/ui.message-renderers`） |
| `ctx.appEvents` | emit(type, payload?) | 本机桌面 app_event 通道（需 `app/events.emit`） |
| `ctx.publicData` | publish / unpublish / list / get | 同实例 App 间数据共享 |
| `ctx.notifications` | show({title, body}) | 系统通知（需 `app/notifications.show`） |
| `ctx.windows` | create/list/get/close/control/request/handleMessages/onEvent | App 自有原生窗口（`app/windows.manage`） |
| `ctx.instances` | create/list/get/reload/stop/close/logs/catalog/requestReview | 隔离数据根的运行实例（`app/instances.manage`） |
| `ctx.environments` | create/list/get/close/logs/catalog/runTool/invokeUiAction/listModels/listAgents... | 隔离多扩展环境（`app/environments.manage`） |
| `ctx.surfaces` | open / openHost / get / move / close / workspace | 已声明视图的打开与操作（见 §3.6） |
| `ctx.process` | resolveExecutable({candidates}) | 外部可执行文件解析（需 `app/process.spawn`） |
| `ctx.dataDir` | string | `{HANA_HOME}/app-data/{appId}` 绝对路径 |
| `ctx.logger` | debug/info/warn/error | 日志（模块名由宿主盖为 appId） |
| `ctx.launchArgs` | get / getAll | 启动参数 |

### 2.4 服务端 `AppSdk`（defineApp 注入的 `sdk`）【读码：`server-client.d.ts`】

- sdk 域方法：`sdk.sessions.*`（create/get/send/update/abort/history/tools/getToolSelection/setActiveTools/list/search/sendCustom/appendEntry/setEntryLabel/getEntryLabel/switchModel/stageFile/registerFile/archive/restore/delete/fork/compact/context/entries）、`sdk.agents.*`、`sdk.roles.*`、`sdk.capabilities.*`、`sdk.usage.*`、`sdk.render.*`（htmlToPdf）、`sdk.media.*`、`sdk.providers.*`、`sdk.models.*`（+ `streamEvents` 异步生成器）、`sdk.tools.register`、`sdk.hooks`、`sdk.storage`、`sdk.bus`（+ `requestService`）。
- 另有 entry-context 包装的各域：`windows`、`instances`、`environments`、`surfaces`、`tasks`（`registerHandler` 返回 Promise 回执）、`config`、`logger`、`inputBanner`、`inputStatus`、`inputPanels`、`appEvents`、`routes`、`resources`、`documents`、`publicData`、`notifications`、`shortcuts`、`messageRenderers`、`userInteraction`、`network`、`process`、`mcp`、`runtime`、`providers`、`launchArgs`、`dataDir`。
- 工具注册的 `execute` 是**单参数**：`execute({ ...args, context: { sessionPath, messageId, messageText, callToken?, document? } })`。

### 2.5 浏览器侧 `hana` SDK（iframe 内）【读码：`_ui-types.d.ts` / `app-entry.d.ts` / plugin-sdk README】

| API | 作用 |
|---|---|
| `hana.ready()` | 与宿主握手（使用前必须） |
| `hana.assets.url(path)` | `ui/` 静态树资源地址（含 surface 凭证，不可持久化）；支持 byte-range 视频 |
| `hana.api.url / fetch` | 本 App 后端路由（`/api/apps/{id}/routes/*`；自动带 surface session）；托管服务用 `/_runtime/<runtimeId>/...` |
| `hana.ui.resize({w,h})` | 报高（聊天流/page/widget 生效；黑板/拆窗不采纳） |
| `hana.envelope` | 宿主尺寸约束只读信号（fixed/flexible/unbounded） |
| `hana.lifecycle` | 运行时预算快照/订阅（active、maxFrameRate、motion） |
| `hana.theme` | 主题快照/订阅（host 签发 cssUrl；含 appearance/palettes 可选字段） |
| `hana.surface` | `getContext()`（`{appId, slot, cardInstanceId}`）/ `onContextChanged` / `setInteractiveRegions`（标题栏交互区，≤64 矩形） |
| `hana.sessions` | `getActive()` / `onActiveChanged` / `focus({sessionId})`（需 `app/sessions.read`） |
| `hana.cards` | `open(cardId)` 打开本 App 已声明卡片 |
| `hana.state` | 卡实例私有草稿纸（**64KB 上限**，随卡实例持久化） |
| `hana.storage.global / .agent(id?)` | 应用态 KV（v2 只有这两个 scope；卡片需显式 agentId 才能 `onChanged`） |
| `hana.emit / track` | 回传会话 / 安静日志（见 §3.5） |
| `hana.panel` | 功能面板：`set({sections, refresh})` / `onEvent` / `onRefresh` |
| `hana.toast / clipboard.writeText / external.open / resources.{open,pick,saveFile,requestAccess}` | 宿主中介动作（能力词见 §3.7） |
| `hana.document` | 绑定文档读写/状态上报/onRequest（仅 Preview 绑定卡） |
| `hana.inputPanel` | 输入面板上下文/提交/呈现 |
| `hana.window` | **仅原生 App 窗口**：`getContext/request/onRequest/onContextChanged/onInspect/registerInspectionSurface/control/close/getDroppedResources`；普通 iframe 调用报不可用 |
| `hana.surfaces.onEvent(surfaceId, fn)` | 工作区/槽位单向通知（workspace-action / workspace-changed） |
| `hana.instances/environments.onChanged`、`hana.appEvents.on` | 实例/环境变化、App 自报事件订阅 |

三个浏览器入口：`@hana/app-sdk/ui`（官方）、`@hana/plugin-sdk`（兼容，含自包含 `dist/browser.js`，脚手架复制为 `ui/assets/sdk.js`）。React 组件走 `@hana/app-sdk/components` + `components.css`。

---

## 3. 卡片体系：类型、渲染能力与交互

### 3.1 卡片类型总览【读码】

| 类型 | 来源 | 渲染形态 |
|---|---|---|
| 黑板卡（画布卡） | `contributes.cards[]`（默认 `realization:"card"`） | 宿主卡壳 + **iframe**（`route` 或 `embedUrl`；两者都没有则只有卡中心条目、无页面） |
| 整页卡 | `contributes.cards[]`，`realization:"page"` | 宿主开整页承载；同伴卡 `pageOf` 可加卡；`siteNavEntry`/`fpFullPanel` 控制导航与 FP 全占 |
| 流内卡（聊天流） | 工具结果 `details.card` 运行时透传 | 聊天流中的 `plugin_card`/`PluginStreamCard` iframe；可取/钉到黑板 |
| 消息渲染卡 | `contributes.messageRenderers` 映射 | `display:true` 的自定义消息 → 流内卡（详见 §5） |
| 卡片功能面板（FP） | 卡片 `functionPanel`（`route` 或 `embedUrl`） | 宿主 FP 列表区：宿主原语绘制 **或** loopback iframe |
| 槽位（slot） | `contributes.ui.slots` + `slotContributions` | 宿主按钮原语 或 iframe（**固定高度 160**，贡献方不能 resize） |
| 设置页 | `contributes.settings.schema` 和/或 `ui.route` | 宿主表单或 App 自定义 HTML 页面 |
| 预览器/编辑器 | `contributes.previewers` | Preview 内的 App 页面（文档绑定） |
| 输入面板 | `app/input.panels` | 输入框上方 iframe（无框满宽，宿主外置确认控件） |
| App 原生窗口 | `sdk.windows.create({ entry })` | 独立窗口（`chrome: "native"|"custom"`），页面来自本 App `ui/` |
| 拆窗（detached） | 卡片 `detached.route` + `detachedDefaultSize` | 独立窗口加载同卡 UI（`ui/` 内页面） |

### 3.2 卡片字段全表【读码：APPS.md §贡献一张黑板卡】

`contributes.cards[]` 每条：

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 数组内唯一；省略 `title` 时显示它 |
| `title` / `description` | 否 | `description` 面向模型摘要（非法值当未声明，回退 title） |
| `route` | 与 embedUrl 互斥 | `/` 开头 `ui/` 相对路径；→ `/api/apps/<appId>/ui<route>`，带 iframe 票据 |
| `embedUrl` | 与 route 互斥 | 绝对 `http(s)`，**主机只认 `127.0.0.1` / `localhost` / `[::1]`**；原样作 iframe src，无包装页、无宿主票 |
| `cardForm` | 否 | `"framed"` / `"flush"`（历史值 `fill`/`unified` 兼容映射） |
| `titlebar` | 否 | `"solid"` / `"translucent"` |
| `realization` | 否 | `"card"`（默认）/ `"page"` |
| `pageOf` | 否 | 指向本 App 一张整页卡；打开整页时插入同页 |
| `closable` | 否 | 仅整页主卡；`false` 时只能删整页 |
| `siteNavEntry` / `fpFullPanel` | 否 | 仅整页卡 |
| `functionPanel` | 否 | `{ id, label?, route? , embedUrl? }`；合法的 embedUrl → loopback iframe，否则走 `hana.panel.set` 原语 |
| `detached` | 否 | `{ route }`：独立拆窗 UI（要求原卡已有合法 route） |
| `detachedDefaultSize` | 否 | `{ width: 240–4096, height: 160–4096 }`（仅影响新建拆窗） |
| `face` | **是** | `{ image }`：`ui/` 下的 PNG/WebP/SVG 封面；每张卡都要，含整页/流内卡 |
| `formFactors` | 否 | 覆盖顶层缺省 |

### 3.3 卡片能渲染什么？【读码，含明确边界】

- **内容 = iframe（HTML/CSS/JS 完整能力）**：页面来自两处之一——宿主代理的本 App `ui/` 静态树（带 App 票据与 surface session），或 loopback `embedUrl`。SSR/构建产物按普通静态资源加载：相对路径入口 JS、Vite 分包、懒加载、字体、图片、JSON、**wasm**、可播放视频（byte-range）都可以放 `ui/` 下（minAppVersion 0.928.0+ 默认继承授权）。
- **没有 markdown / 任意 HTML 注入型卡**：宿主不提供"把 markdown/富文本渲成卡"的机制【读码未见此类卡片渲染器】；面板是声明式原语，不渲染任意 HTML。
- **没有 v1 的 `chat.surface` / `hana.native` 内联卡形态**：永久退役；新 UI 用 WebView 卡。
- **iframe 的沙箱与票据**：清单贡献的 `ui/` 页面跑在 iframe 里，"那一层有独立的票据和沙箱"；`appIframeTicket` 只管 `ui/` 文档，不能当路由代理凭证。[不确定]沙箱属性白名单未在文档逐条列出。
- **卡片身份**：宿主铸造 `a_*` 实例 ID（`cardInstanceId`）；agent 用 `ui_inspect` / `ui_action` / `read_card_activity`（`app-card:`）访问。作者不得自造或覆盖。
- **宿主驱动**：`ui_action` 对已挂载 `a_*` 卡可用一期动作 `describe_dom` / `click_element` / `type_text` / `read_state`；**拒绝** `click_sequence` / `drag_element` / `press_key`；点击不 focus、拒绝 `input[type=file]`；`describe_dom` 不回 innerHTML。

### 3.4 大视图 / 面板机制（能否承载重型 SPA）【读码】

可以，分层如下（由轻到重）：

1. **整页卡**（`realization:"page"`）：宿主开一整页，从 `siteNavEntry`/`fpFullPanel` 控制导航与 FP 归属；卡片几何不受聊天列限制。
2. **拆窗**（`detached.route` + `detachedDefaultSize`）：卡片拖出为独立窗口，加载专属 `ui/` 页面。
3. **App 原生窗口**（`sdk.windows.create({ entry: "/index.html", bounds, chrome })`，需 `app/windows.manage`）：真正的多窗口应用形态；`chrome:"custom"` 自绘标题栏 + `hana.window.control("toggle-fullscreen")`；标题栏交互区可上报；`onInspect` / `registerInspectionSurface` 对宿主 UI 工具暴露状态（只报告，不自授权）。窗口与后端之间是 App 自定义 JSON 消息协议。
4. **宿主视图（HostSurface，≥0.970.9）**：`sdk.surfaces.openHost({ slot: "chat"|"preview"|"workspace" })` 在 App 自己的窗口布局里嵌入宿主真实组件；`slot:"workspace"` 是**完整主画布工作区**（caption、navigator、Function Panel、Card Center、画布、卡壳，同一 renderer 的真组件）。需要隔离环境（`sdk.environments`）。
5. **功能面板（FP）**：随卡走；loopback `embedUrl` 时是固定容器 iframe；宿主动词 `hana.panel.set` 时是声明式原语（`section/status/list/pills/bar/meta/actions/toggle/text`；≤64 段/推送、≤200 行/列表、宽 180–400px；轴图/多列表格/外嵌整页/自定义键位**明确不在面板范围**——放到卡上）。
6. **输入面板**：输入框上方满宽 iframe（问答式或常驻），支持 presentation 高度/折叠。
7. **槽位 iframe**：定高 160px，适合"小内嵌"，不适合重型 UI。

### 3.5 交互三件套：emit / track / state【读码】

- **`hana.emit(name, payload?, to?)`**：把用户手势回传给嵌入会话并**唤醒 agent**。仅 card slot；`userGesture` 由 SDK 注入层采集（作者不可自报）；**需 `app/session.start-turn`**，未授权明确拒绝；事件名 `^[a-z0-9][a-z0-9._-]{0,63}$`；payload ≤8KB；每卡每分钟 ≤20 次；宿主写 `customType: app:<appId>/card-event` 并盖 `routeOrigin` + `cardInstanceId`。`to` 仅在用户明确要求时传。
- **`hana.track(name, payload?)`**：安静活动记录（不进会话、不唤 agent、不需要 start-turn）；仅 card slot + 宿主铸造 `a_*` 实例；≤8KB、≤120 次/分；落 `{HANA_HOME}/app-card-activity/`（环形保留 500 条），agent 用 `read_card_activity` 的 `app-card:` 读取。
- **`hana.state`**：卡实例私有草稿（64KB），随卡实例持久化、跨端不共享。
- 更新/创建通路：卡片本身由清单声明（静态）；运行时"创建"的是实例（流内卡由工具结果落地、钉出/取出到黑板）；面板内容靠 `hana.panel.set` 推送。

### 3.6 尺寸与形态【读码：APPS.md §卡片尺寸与形态契约 / §尺寸信封】

- 三层模型：① 声明式占位（`details.card.aspectRatio`，聊天流卡）；② `hana.ui.resize` 运行时报高（黑板/拆窗不采纳）；③ 宿主 clamp 与最终裁决。
- `hana.envelope` 只读信号（fixed/flexible/unbounded），各挂载位模式表：聊天流卡 flexible/上限=聊天可视区；黑板/拆窗 fixed；page/widget 高 flexible 宽 fixed；槽位 iframe fixed 160；输入面板 fixed；FP loopback fixed。
- `details.card.preferredWidthPx` **不支持**（被忽略）。

### 3.7 卡片 iframe 的授权词（App 级，非按卡）【读码】

`external.open`→`app/ui.open-external`；`clipboard.writeText`→`app/ui.clipboard-write`；`resource.open/pick/requestAccess`→`app/resources.read`；`resource.saveFile`→`app/resources.write`。**黑板卡槽里剪贴板写入与外部打开被拒**（防小卡产生全局副作用）；要用去 page/widget/settings 表面。`hostCapabilities` 依然是未知键，写了整应用失败。

---

## 4. 宿主通信（bus）：动词清单与限制

### 4.1 请求动词全清单（`ctx.bus.request` 允许的 49 个）【读码：`app-bus-contract.js` 的 `APP_BUS_REQUEST_ALLOWLIST`】

**会话类（25）**：`session:create`、`session:get`、`session:send`、`session:update`、`session:abort`、`session:history`、`session:tools`、`session:tool-selection`、`session:set-active-tools`、`session:list`、`session:search`、`session:send-custom`、`session:append-entry`、`session:set-entry-label`、`session:get-entry-label`、`session:switch-model`、`session:stage-file`、`session:register-file`、`session:archive`、`session:restore`、`session:delete`、`session:fork`、`session:compact`、`session:context`、`session:entries`

**Agent/角色类（12）**：`agent:create-from-type`、`agent:create-from-role`、`agent:create`、`agent:list`、`agent:profile`、`agent:config`、`agent:update`、`agent:update-config`、`agent:retire`、`agent:purge`、`role:list`、`role:get`

**模型/查询类（6）**：`model:list`、`app:capabilities`、`usage:list`、`provider:credentials`、`provider:models-by-type`、`provider:resolve-media-model`

**媒体类（5）**：`media:generate`、`media:generate-image`、`media:generate-video`、`media:transcribe-audio`、`provider:media-providers`

**其余**：`render:html-to-pdf`

> 计数口径：allowlist 数组逐项 49 条；上表分组供阅读。

### 4.2 各动词语义与限制要点【读码】

- **范围模型**：每个 v2 请求用稳定 `sessionId`（可附当前 `sessionPath` 定位器）；默认 `scope:"own"`（只看本 App 的会话）；`scope:"all"` 跨归属分区时读取需 `app/sessions.read`、写入需 `app/sessions.manage`。`session:list` 支持 `lifecycle: "active"|"archived"|"all"` 与 all-scope `ownerPluginId` 过滤。
- **`session:send`**：往会话发消息（text + base64 images）；`deliverAs: "steer"|"followUp"` 控制流式插话；**需 `app/session.start-turn`**（必然进模型）。工具调用里回复当前会话：把 `context.callToken` 交给 `session:send` / `send-custom` / `append-entry` / `stage-file`，无需先猜 sessionId；带 callToken 且带 sessionId 时两者必须指向同一会话。
- **`session:send-custom`**：投递"不一定触发回合"的 custom message；`display: true` 才会在聊天记录里渲染（配合 messageRenderers）；`triggerTurn` 省略/非 false 且会话空闲 → 进模型（需要 start-turn）；空闲显式 `triggerTurn:false` → 只记历史（不需该授权）；聊天流式中始终进模型。
- **`session:append-entry`**：写一条不进模型上下文、也不在聊天记录展示的自定义条目；**不需要 start-turn**；不出现在 `session:history`。
- **`session:compact`**：需要 manage + `app/session.start-turn`（消耗模型回合）。`session:delete` 只收已归档会话。
- **`session:switch-model` / `session:update` 的 thinkingLevel、permissionMode / `session:create` 携带的同类字段**：各需独立能力词 `app/session.switch-model`、`app/session.thinking-level`、`app/session.permission-mode`，默认关闭、整单拒绝、不部分生效。
- **`session:set-active-tools`**：设置下一次模型请求的工具选择（需 `app/session.tools.configure`）；忙时延后到下一次空闲 preflight。
- **`agent:*`**：App 创建的 Agent 由宿主盖 `ownerPluginId`（本 App）+ `visibility:"plugin_private"`；`agent:retire` / `agent:purge` 是 v2 专属动词、需 `app/agents.manage`；跨分区读写另需 `scope:"all"` + `app/agents.read/manage`。
- **`model:list`** / **`app:capabilities`**：不另需授权；后者返回本应用账本状态（`always/session/denied/not_asked` + `hard/advisory`）。
- **查询类**：`usage:list`→`app/usage.read`；`provider:credentials`→`app/provider.credentials.read`（可返回可用 apiKey/OAuth access token，绝不返回 refresh token/凭据文件）；`provider:models-by-type` / `resolve-media-model`→`app/models.read`。
- **不允许的动词**：不在 allowlist 的宿主动词一律明确拒绝；**`model:sample-text` / `utility:call-text` 不是 v2 动词**（文本辅助用 `sdk.models.utility`）；`media-gen:register-adapter` 等内部动词也不开放（走 `ctx.media` 句柄）。

### 4.3 事件侧：emit / subscribe / handle【读码】

- **`ctx.bus.emit(event, sessionPath?)`**：App 可发**自定义**事件；**宿主事件名禁名单**（`APP_BUS_EMIT_DENYLIST`）含：17 个 Pi 透传事件、6 个会话生命周期、8 个宿主具名、以及数十个未文档化宿主事件（`activity_update`、`bridge_*`、`resource.changed`、`token_usage`、`error` 等）。伪造宿主事件被拒；自己发明的名字（如 `settings_tool_started`）可用。
- **`ctx.bus.subscribe(callback, filter?)`**：`(event, sessionPath) => void`；`filter.types` / `filter.sessionPath` 可叠加；回调收到**只读投影**（写任意字段抛 TypeError）；回调不保证与 emit 同 tick（跨 RPC）；回调异常只记日志不影响宿主。正式契约事件 = 17 个 Pi 事件 + `session_metadata_updated` + `session_created`/`session_closed`/`session_forked`（另有 `session_deleted`、`input_status_changed` 等也在宿主词表）；隔离会话只带 `isolated:true` 且需显式转发。
- **`ctx.bus.handle(name, handler, { allowCrossApp? })`**：注册 App 自有服务，宿主固定全名 `app:<appId>/<name>`，不能覆盖宿主动词；handler 收 `(payload, { requestId, callerAppId, signal })`；需 `app/services.provide`；调用方需 `app/services.call`（跨 App），默认超时 30s。

---

## 5. 自定义消息渲染（messageRenderers）

【读码：APPS.md §为自定义消息声明一张流内卡；SKILL.md；dynamic-ui.d.ts】

```json
"contributes": {
  "cards": [ { "id": "notice-card", "face": {"image":"assets/…webp"}, "route": "/notice.html" } ],
  "messageRenderers": [ { "customType": "notice", "cardId": "notice-card" } ]
}
```

- **`customType` 命名规则**：短名——非空字符串、**不能含 `/`、不能自带 `app:` 前缀**。投递时只写短名；**宿主盖章完整类型为 `app:<appId>/<短名>`**。历史投影与实时流按完整类型查映射。
- **`cardId`**：必须指向本 App `contributes.cards[]` 里一张**带 `route`** 的卡；指向不存在/无 route 的卡 → 丢掉该映射 + 警告（不炸应用）。
- **生效范围**：只作用于 `display: true` 的 custom message（`session:send-custom` 默认 `display:false`，要显式传 `display:true`）；`session:append-entry` 的自定义条目**不走**这条渲染通道。
- **载荷不由宿主注入卡片**：卡片 iframe 拿不到触发消息的 payload；卡片要自己经 surface / storage / 后端路由读状态。
- **校验**：未知键 / 非数组 / 条目非对象 / 坏 `customType` / 空 `cardId` / 重复 `customType` → **整应用 failed**；坏 `cardId` 走丢条+警告。
- **动态注册**：`hana.messageRenderers.register({customType, cardId})`（需 `app/ui.message-renderers`，仅本 App 已声明 route 卡，覆盖静态映射直到 dispose/撤销）。
- **相关**：`hana.emit` 的消息用宿主固定 `app:<appId>/card-event`（不是自定义名）。

---

## 6. 设置 / 存储 / 沙箱 / 审批

### 6.1 settings（声明式配置）【读码：APPS.md §贡献一个设置页】

- 形态：`contributes.settings = { title?, schema?, ui?: { route } }`；`schema` / `ui` 至少一个；同时声明的场合 `schema` 仍负责 `ctx.config` 的字段校验/默认值/敏感处理。
- schema 词汇：`type`（string/number/integer/boolean/object/array）、`title`、`description`、`default`、`enum`（可配 `ui.enumLabels` 显示文案）、`scope`（`global`/`per-agent`/`per-session`）、`sensitive`（出参掩码 `********`，带掩码回传当"没改"）、`reloadRequired`、`migrationVersion`。`properties` 不能为空。
- **设置页通用表单只画/只存 `global`**；per-agent / per-session 走 `ctx.config`（带 agent/session 把手）。
- 落盘：`<HANA_HOME>/user/preferences.json` 的 `settings_contributions` 块，键 `v2-<appId>`（= cordis entry id）；scoped 值落 `settings_contributions_scoped`。
- 投影：`GET /api/apps/<appId>/settings-schema`（只读）。
- 自定义设置页：`contributes.settings.ui.route`（本 App `ui/` 内页面；与设置卡指向同一 HTML 可共用界面）；React 场景用 `@hana/app-sdk/components`。
- 卡片/FP 打开：`hana.cards.open("settings")`（同 App 已声明卡）。
- `ctx.config`：`get/getAll/getSchema/getState/set/setMany/forkSession/discardSession`；未声明 settings 时 get 空、set 抛 `SettingsContributionValidationError`。

### 6.2 文件存储约定【读码】

- **KV（`ctx.storage` / `hana.storage`）**：两个 scope——`global`（跨该 App 所有 agent）、`agent(agentId?)`（私有于一个 agent；工具调用内省略 id 时宿主按 callToken 解析，`onChanged` 必须显式 id）。落 `app-data/<id>/storage/{global.json|agent-<id>.json}`；**无每键上限**，单 scope 序列化 >512KB 记警告、>16MB 抛 `APP_STORAGE_QUOTA_EXCEEDED`。不占能力词（出不了圈）。宿主是唯一写者；跨门 `onChanged` 经 `app_event` 广播。
- **文件**：`ctx.dataDir`（= `app-data/<id>`）随读随写不查账本；盘外读需 `app/resources.read`、盘外写需 `app/resources.write`；`ctx.resources` 开放 ref 种类：`local-file`/`session-file`/`resource`/`url`/`mount`/`skill`/`recipe`/`agent`/`card-document`（`managed-cache` 不开放）。
- **卡片实例态**：`hana.state` 64KB/卡。
- **媒体产物**：适配器写 `ctx.generatedDir`（`app-data/<id>/generated`），由宿主 poller 登记进会话。
- **活动仓**：`hana.track` → `{HANA_HOME}/app-card-activity/`（环形 500 条）。
- 产物进会话：`ctx.resources.stage` / `session:stage-file` / `session:register-file`（`app/session.stage-file`）。

### 6.3 执行沙箱与文件边界【读码：APPS.md §执行模型与文件边界 / §API 授权、Node 限制与操作系统隔离】

| 路径 | 边界 |
|---|---|
| 默认 AppHost | Node Permission Model：安装目录只读、app-data 可写、禁裸网络/addon/worker/子进程；**这是 Node 限制，不是 OS 沙箱** |
| + `app/process.spawn` | 加 `--allow-child-process`（下次启动生效）；外部命令**不继承** Node 限制 |
| 托管 `scoped` | macOS Seatbelt / Linux Bubblewrap 实施目录与网络范围（Windows 当前不可用，明确拒绝） |
| 托管 `native` | 可跑原生依赖/worker/子进程；网络须显式 `external`；Windows 走专用身份 + Job 回收，仍报告 `partial` |
| 托管 `local-machine` | 用户明示授权后以当前用户权限跑本机程序，**无文件系统隔离**；需 `app/runtime.execute` + `local-machine` + `network`；`enforcement:"none"` |

- **出站网络**：`ctx.network.fetch` 永远在场但需清单 `network` 声明；按序校验：白名单 → 私网默认拒（除非 `allowLocalhost`）→ HTTPS（allowLocalhost 时 HTTP 也可）→ 通配 → 方法（默认 GET）→ 超时 → 响应上限。批准卡展示 `allowedHosts` 白名单。
- **子进程环境**：只给 `PATH`/`HOME`/`TMPDIR`/`LANG` + `HANA_LOCALE_DIR`。

### 6.4 权限账本（capability words）【读码：SDK 各 capabilities 文件 + APPS.md】

- **形态**：`manifest.capabilities` 是申请；实际授权在**权限账本**，用户安装时确认一次，之后在 设置→安全→「应用能力」或扩展详情页逐词开关，即时生效。
- **强制度**：`hard`（没授权=该动作被拒）与 `advisory`（钩子词：没授权时宿主跳过该 App 的裁决者，回合照常）。
- **状态四态**：`always` / `session` / `denied` / `not_asked`（`app:capabilities` 可查）。
- **词表（按域）**：
  - 会话控制：`app/session.start-turn`、`app/session.switch-model`、`app/session.thinking-level`、`app/session.permission-mode`、`app/session.tools.configure`；首用：`app/session.post-message`、`app/session.read-selection`；文件：`app/session.stage-file`
  - 实体读写：`app/sessions.read`、`app/sessions.manage`、`app/sessions.search`、`app/agents.read`、`app/agents.manage`
  - 工具/目录：`app/tools.expose-to-model`、`app/tools.read`、`app/commands.read`
  - UI：`app/ui.open-external`、`app/ui.clipboard-write`、`app/ui.keybindings`、`app/ui.message-renderers`、`app/input.status`、`app/input.panels`
  - 资源：`app/resources.read`、`app/resources.write`
  - 媒体：`app/media.generate`、`app/media.provide`、`app/media.tasks.manage`、`app/media.tasks.read-all`、`app/media.tasks.manage-all`、`app/provider.models.manage`
  - 模型/Provider：`app/models.infer`、`app/models.read`、`app/provider.credentials.read`、`app/provider.provide`、`app/provider.auth`、`app/provider.auth.environment`
  - 任务：`app/tasks.manage`、`app/tasks.read-all`、`app/tasks.manage-all`
  - 运行时：`app/runtime.execute`、`app/runtime.native`、`app/runtime.network`、`app/runtime.local-machine`；进程：`app/process.spawn`；渲染：`app/render.pdf`
  - 事件/通知/服务：`app/events.emit`、`app/notifications.show`、`app/services.provide`、`app/services.call`
  - 窗口/实例/环境：`app/windows.manage`、`app/instances.manage`、`app/environments.manage`
  - 钩子（每个独立开关）：`app/hooks.agent-before-start`、`agent-pre-step`、`tools-pre-execute`、`tools-post-execute`、`provider-before-request`、`provider-before-headers`、`messages-post-assistant`、`messages-post-message`、`session-input`、`session-before-compact`、观察 `app/hooks.observe`、输入图 `app/hooks.session-input-images`
  - 公共数据：`app/public-data.publish`、`app/public-data.read`；MCP：`app/mcp.provide`、`app/mcp.read`、`app/mcp.manage`；用量：`app/usage.read`
- **无 App 主动请求授权的 API**：全部由用户在设置里开关；App 只能查（`app:capabilities`）。
- **批准边界的三个义项**（别混）：
  1. **安装批准**：一次性审查（能力清单逐条展示），之后各词可改；`unregistered→批准` 只对 unregistered 合法；重载扩大权限会重新审查；
  2. **任务审批**：`ctx.tasks.requestApproval({taskId,label,details?,timeoutMs?})` + `respondApproval({approvalId, outcome})` 建立/应答 App 自己的审批（仅 session 任务；父任务结束会拒绝剩余审批）；
  3. **钩子裁决**：每个 hook 词默认 deny，未授权时宿主跳过该 App 的裁决器。

### 6.5 后台任务（补充）【读码：APPS.md §后台任务与审批 / §App 任务处理器与调度】

- `ctx.tasks.create({scope?, callToken?, label, delivery?, ...})`：无令牌默认 `scope:"app"` + `delivery:"none"`；会话模式（有效 callToken）可 `"next-step"`/`"next-turn"`；档位创建时定死。
- 会话任务自动显示在「后台进程」；完成 `complete(taskId,result)` / `fail(taskId,msg)`；`watch(taskId)` 返回有界 SSE。
- `registerHandler(stableKey, {run, abort?})` 每次 apply 重绑（受管 Node 子进程的 `connectAppRuntime` 没有 registerHandler）；`schedule(...)` 支持周期/单次（intervalMs / runAt），重启最多补跑一次。
- `next-step` 结果由宿主持久化 `deliveryId`、去重补发，不重跑副作用。

### 6.6 受管运行时（补充）【读码】

- `ctx.runtime.start({ runtime: "node"|"command", profile?, entry?, command?, args?, cwd?, readRoots?, writeRoots?, network?, service?, callToken?, taskId? })`；`service: {port, readyMarker}` 可注册回环服务，就绪后经 `/api/apps/<appId>/routes/_runtime/<runtimeId>/` 访问（**支持 WebSocket**；每连接缓冲 ≤1MiB）；浏览器用 `hana.api.url("/_runtime/<runtimeId>/...")` 构造相对资源/模块/WS 基地址；**代理不会自动改写 SPA 资源/API 基地址**。
- Node 子进程里用 `connectAppRuntime()` 取得 tasks/models/media/network.fetch 私有 IPC 客户端（不暴露凭据）。
- 路由 body 跨进程走有界 pull 流（块 ≤64KiB、每 peer ≤32 输出流、RPC 并发 128、消息 ≤32MiB）。

---

## 7. Agent 侧接入：工具、技能与钩子

### 7.1 工具（tools）【读码：APPS.md §apply 收到什么（工具段）+ §调用一个 UI 贡献的工具】

- 注册：`ctx.tools.register({ name, description, parameters, execute, invocationStyle?, metadata?, sessionPermission?, isEnabledForAgentConfig?, documentAccess?, view? })`；返回 disposer；**宿主不给名字加前缀**（v1 会加），重名当场拒绝并让整个应用 failed——必须自命名空间。
- **模型循环通道**（开关链条）：
  1. 应用批准 + `app/tools.expose-to-model` 账本词 + 用户在设置里对该 App 打开开关（默认关，**每次调用前重查**）；
  2. 工具名须匹配 `^[a-z][a-z0-9_-]*$`（否则不进模型列表、但按钮通道可用）；
  3. 按 Agent 启用状态、会话可用性、执行时权限检查。
- **调用形态**：单参数 `execute({ ...args, context })`；模型循环时 `messageId/messageText` 恒 null，宿主盖短命 `callToken`（只在本次调用有效；按钮通道无令牌）。长任务把令牌换成 `taskId`；令牌不落盘不写日志明文。
- `sessionPermission`：`readOnly:true`（免审阅）/ `kind`/`auto:"allow"`（routine）/ 其余默认 review；跨进程只认数据字段。
- 目录投影：`ctx.tools.list({scope})`（`all` 需 `app/tools.read`）；`listOwn()` 只列自己。
- **按钮通道（ui-actions）**：`contributes.ui` 声明的按钮点击 → `POST /api/apps/:pluginId/ui-actions/invoke`（贡献方身份调用自己的工具）；keybindings 命中同通道（`messageId:null`）。
- 工具选择：`session:set-active-tools` / `session:tool-selection`（下次请求生效）。
- SDK 封装：`sdk.tools.register`（回执 `ready`/`disposeAsync`）。

### 7.2 命令与快捷键【读码】

- `ctx.commands.register({name, aliases?, description?, usage?, handler})`：进同一斜杠注册表；identity 固定（`source:"app"`）+ permission 固定 `"owner"`；冲突回滚；随主命令移除；`sdk.shortcuts.register({id,key,toolName,args?,title?})` 全局快捷键（需 `app/ui.keybindings`；宿主保留键/重复冲突丢弃并警告；输入框内不触发）。

### 7.3 技能（skills/）【读码：SKILL.md §skills/ + APPS.md】

- 目录约定：App 根下 `skills/`（**非 contributes 键**，宿主装载成功后从磁盘直接探测）——两种形状任一：`skills/` 内直接放 `*.md`，或子目录带自己的 `SKILL.md`。都无 → 正常装载、不注册技能（不是失败）。
- 注册标签 `app:<appId>`（与 v1 的 `plugin:<pluginId>` 前缀不同、待遇相同）：默认**不在用户技能列表显示**（除非显式要求含 plugin/app 技能），运行时仍然可用。
- v2 不拒绝"内置 App 带 skills"（v1 的拒绝原因在 v2 不存在，因为 `apps/<id>/` 路径稳定）。
- 【实测】`llama-monitor` 带 `skills/` 目录，是现存样例。

### 7.4 钩子（hooks）与观察【读码：`app-hook-capabilities.d.ts`】

- **裁决词（10 个，各自独立授权）**：`agent/before-start`（改系统提示/注入消息）、`agent/pre-step`（改本轮消息）、`tools/pre-execute`（拦/改工具调用）、`tools/post-execute`（改工具结果）、`provider/before-request`、`provider/before-headers`、`messages/post-assistant`、`messages/post-message`（保留原始 role）、`session/input`（改用户输入/图片或可见理由拦截）、`session.beforeCompact`。
- **观察事件（6 个，`app/hooks.observe` 单独授权）**：`agent/session-start`、`session.shutdown`、`agent/settled`、`session/compacted`、`session/compact-failed`、`provider/after-response`。
- 语义：注册总是成功；是否真被咨询按账本每次分发实时判定；未授权 = 宿主跳过该裁决者（advisory），不阻断流程。

### 7.5 Agent 类型与实例化【读码：APPS.md §贡献 Agent 类型 / §管理 Agent】

- `contributes.agentTypes[]`：`{id,title?,description?,yuan?,tools?,cards?,capabilities?,privateSession?}`；`id` 格式 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`（App 内命名空间）。
- **如实说明**：`tools`/`cards`/`capabilities` 目前只是声明与投影（宿主不校验、不作为运行时白名单）；`privateSession.enabled` 不影响可见性——created Agent 恒 `visibility:"plugin_private"`。
- `ctx.bus.request("agent:create-from-type", {agentTypeId, name?})` 实例化（只认宿主盖章的调用者身份）；投影 `GET /api/apps/agent-types`。
- 通用管理：`agent:create/list/profile/config/update/update-config/retire/purge`（归属字段宿主写；跨分区读写需 `scope:"all"` + 对应词）。

---

## 8. 可行性评估：嵌入重型 Web 前端（ComfyUI，Vue3 SPA）

### 8.1 硬约束（读码确认的事实）

1. **卡片 iframe 的两条内容来源**：① App `ui/` 静态树（route，宿主服务 + 票据 + surface session）；② **仅 loopback** 的 `embedUrl`（127.0.0.1 / localhost / [::1]，http/https；无票据、无包装页）。**任意外部 URL 不能作为卡 iframe**。
2. **loopback embedUrl iframe 不获得 SDK bridge**："复用主界面的普通 sandbox iframe。它不会获得 App SDK bridge、存储或原生权限"，跨源 DOM 操作明确不可用（Agent 只能发现/管理其生命周期）。
3. **App 路由鉴权**：`app_route` 档（宿主登录或 App surface session）；`hana.api.fetch` 自动处理；**iframe 装载票据 `appIframeTicket` 只管 `ui/` 文档，不能当路由凭证**。
4. **网络**：AppHost 禁裸网络；出站 HTTP 走 `ctx.network.fetch`（清单白名单，可 `allowLocalhost`）；**WebSocket 不在 `ctx.network.fetch` 范围**；受管服务代理（`/_runtime/<runtimeId>/`）支持 WS 且带 surface 凭证——"代理不会自动改写 SPA 资源/API 基地址"。
5. **重资产构建**：`ui/` 下相对路径加载默认继承授权（≥0.928.0）：Vite 分包、懒加载、字体、wasm、byte-range 视频可行；**不要把源码/源码映射/密钥放进 `ui/`**；资产 URL 带凭证不可持久化。
6. **宿主驱动 UI 有限**：`ui_action` 一期只有 describe_dom / click_element / type_text / read_state；无键盘、无拖拽、点击不 focus、拒绝 file input。重型 SPA 的完整交互仍靠用户真手操作，Agent 只能做"轻量查看与点按"。
7. **规模**：整页卡、拆窗（≤4096px）、原生窗口（bounds 自由）、workspace 宿主视图（renderer 内真画布）都能承载大 UI；槽位 iframe 固定 160 不可 resize；FP loopback 固定容器。

### 8.2 候选路径对比（评估用，非设计方案）

| 路径 | 做法 | 优点 | 硬限制 |
|---|---|---|---|
| A. 直嵌 ComfyUI（embedUrl） | 卡片 `embedUrl: "http://127.0.0.1:8188/"`（整页卡 + FP 可选） | 零改造；保留 ComfyUI 原生前端全部功能；ComfyUI 升级自然跟进 | 无 hana bridge（无 emit/storage/主题跟随/标题栏交互区）；跨源无 DOM 检查；要求 ComfyUI 服务已在运行；iframe sandbox 细节 [不确定] |
| B. SPA 打包进 `ui/` | 把 ComfyUI 前端构建产物放进 `<app>/ui/`，卡片 route 加载；静态资源全部相对路径 | 完整 hana 集成（emit/track/storage/theme/envelope/cards.open…）；宿主资源通道工程化支持（分包/wasm/视频）；可被 Agent 通过 ui_action 查看 | `ui/` 里是"拷贝一份"，需自己跟上游升级；后端 API/WS 需经 App 代理（见下）；包体与 256MiB/30k 条目上限 |
| C. 受管服务 + 代理 | `ctx.runtime.start({runtime:"command", command:python, args:main.py, profile:"local-machine", network:"external", service:{port:8188, readyMarker}})` 拉起/管理本机 ComfyUI；页面对 `/_runtime/<runtimeId>/…` 相对寻址（WS 亦走此代理） | 生命周期受 Hana 管理（停止/撤销/回收）；WS 有官方代理路径；凭证不落第三方 | 需 `app/runtime.execute` + `local-machine` + `network` 三个授权（enforcement:none 本机模式）；代理不改写 SPA 基地址——前端必须支持相对基址/统一前缀 [关键验证点]；readRoots/writeRoots 与本机模式互斥（local-machine 不接收 roots） |
| D. 原生窗口 / 拆窗承载 | 同 B 的产物 + `sdk.windows.create({entry:"/index.html"})` 或卡片 `detached.route` | 独立窗口、自有标题栏（custom）、全屏、多窗口 | 需 `app/windows.manage`；仍是 App `ui/` 内页面；无宿主主画布内的"卡壳"集成 |

**路径 B/C 需要解决的两个技术点**（本轮未验证）：
- ComfyUI 前端（Vue3 SPA）在**非根路径 / 非 8188 origin** 下的 API 与图片/预览资源寻址（是否可整体改写为相对路径/统一基址）——代理"不自动改写"意味着这必须由移植方保证。
- WebSocket：`ctx.network.fetch` 无 WS；WS 只能走 ③ 的受管服务代理（或 ④ 直连 loopback 的 embedUrl 场景由 ComfyUI 自己的前端负责）。[不确定]普通卡片 route 页面是否允许浏览器直接 `ws://127.0.0.1:8188`（文档未列出该禁令，但宿主 CSP/沙箱未逐条披露）。

### 8.3 与本项目直接相关的先例【读码+实测】

- `llama-monitor`（`C:\Users\John Galt\.hanako\apps\llama-monitor\`）：**与本项目最接近的已跑通形态**——`defineApp` 后端 + **本地受管程序**（`runtime:"local-machine"` 拉采集引擎并注册服务）+ **App 路由转发**（`/engine/*`）+ **卡片页面**（`ui/monitor.html` 经 `hana.api.fetch` 轮询）+ `network.allowLocalhost` 访问本机 127.0.0.1 + 自备 `sdk/`、`skills/`、`assets/`。它用主页面的常驻卡（非整页/窗口）。
- `dshana`：cards + settings + `local-machine` + `session.start-turn`；`hana-downloader`：cards + messageRenderers + hooks；`hana-builder`：windows/instances/environments 三件套 + homeActions（重型多窗口管理型 UI 的先例）。

### 8.4 其他与本项目有关的可用能力点【读码】

- **Agent-native 面**：`ctx.tools.register` 暴露"提交工作流/查询队列/取结果"等工具给模型（需 `app/tools.expose-to-model`）；模型循环中可用 `callToken` 回投会话（`session:send` / `send-custom` / `stage-file`）；后台任务 + 审批 + `next-step` 投递。
- **媒体管线**：若希望 ComfyUI 产物作为媒体呈现，可注册媒体适配器/能力源（`app/media.provide`；参考内置 `jimeng-cli` 形态）。
- **文件**：`ctx.documents`（预览绑定）、`contributes.previewers`（给 PNG/工作流 JSON 等做查看器）、`hana.resources.saveFile`（导出）。
- **输入面板**：做"生成参数问答/进度常驻页"可走 `app/input.panels`（满宽 iframe，支持折叠）。
- **事件**：`ctx.bus.subscribe` 可观察会话/工具事件（17+ 正式契约事件），用于把 ComfyUI 进度或工作流执行接入会话侧反馈。

### 8.5 未解决问题清单（留给架构阶段）【不确定】

1. 宿主对卡片 iframe 施加的 sandbox 属性白名单（是否 `allow-same-origin/allow-scripts/allow-forms`、是否允许 `allow-popups`、是否禁 `allow-top-navigation`）未在材料中逐条列出。
2. 卡片 route 页面（宿主 origin 下）对 `ws://127.0.0.1:*` 直连、对 `http://127.0.0.1:8188` 跨源 fetch 的 CSP 允许范围。
3. `embedUrl` iframe 在宿主中的 sandbox 是否等于普通 sandbox iframe 的完整属性集。
4. ComfyUI 自身 CORS/`--enable-cors-header` 等对宿主 origin 的兼容程度（取决于 ComfyUI 版本与启动参数）。
5. 受管服务代理对 ComfyUI 前端（含 `/api`、`/view`、`/ws`、分片上传）的路径改写与 WS 行为需在临时完整宿主中实测（官方也要求"通过真实 Hana 运行时代理验证全部动态脚本和资源"）。
6. `ui/` 包体实践：ComfyUI 前端 + 资源的体积 vs 打包上限（压缩 256MiB / 展开 512MiB / 30k 条目）。

---

## 附：本报告采信材料的版本口径

- APPS.md：0.1013.2 服务器产物内版本（2687 行）；`APPS_EN.md` 342KB 同源。
- `@hana/app-sdk`：packedVersion 0.1013.0（`source-manifest.json`），生成自 `shared/app-contract/`。
- `@hana/plugin-sdk` / `@hana/plugin-protocol` / `@hana/plugin-components`：0.0.0（随 Creator 资产分发，未上公开 npm）。
- 本机 Hana：0.1013.2；已装 App 一览（均 v2）：`dshana`(cards,settings) / `hana-builder`(homeActions,settings) / `hana-downloader`(cards,messageRenderers,hooks) / `llama-monitor`(cards) / `powershell-tool`(hooks) / `savetoken`(settings,cards)。
