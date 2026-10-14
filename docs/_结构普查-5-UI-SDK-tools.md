# hui 结构普查（5）：UI / SDK / tools

> 只读结构普查，不改任何源码。覆盖 `app/ui/**`（8 页 + 1 共享 SDK）、`app/sdk/**`、`app/manifest.json`、`tools/*.ps1`。
> 生效方式见文末链接引用，不重写 [`docs/改动生效范围.md`](./改动生效范围.md)。

---

## 一、UI 页清单

| 页 | 文件 | 角色 | 宿主落位（manifest） |
|---|---|---|---|
| 工作区壳页 | `app/ui/workspace.html` + `assets/workspace.js` | 整页工作区：三态视图 / iframe 装载 ComfyUI 官方前端 / 模式选择 / 自绘标题栏 / 悬浮按钮 / 探针 / shell 轮询 / 主题同步 / 画布移交 | `contributes.cards[].route=/workspace.html`，realization=`page`，siteNavEntry + fpFullPanel |
| 宿主左栏面板 | `app/ui/panel.html` + `assets/panel-status.js` | `functionPanel`：状态 / 监视器图表 / 服务起停 / 更新 / 重载工作区按钮 | `contributes.cards[].functionPanel.route=/panel.html` |
| 设置页 | `app/ui/settings.html` + `assets/settings.js` | 安装目录 / 服务启动 / 画布授权开关 / 连接状态（只读） | `contributes.settings.ui.route=/settings.html` |
| 环境检查卡 | `app/ui/envcheck.html` + `assets/envcheck.js` | 服务拉起前环境阻断检查卡（GPU/端口占用 → 清理/重试/取消） | 经工具回执 `details.card`（route 静态 `/envcheck.html`）内联投射 |
| 任务卡 | `app/ui/task.html` + `assets/task.js` | ComfyUI 任务进度 / 产物预览卡（轮询） | 经工具回执 `details.card`（route 静态 `/task.html`）内联投射 |
| 共享 SDK | `app/ui/assets/sdk.js` | 宿主 `@hana/plugin-sdk` 运行时包（页面 import 的 `hana` 对象） | — |

> 说明：envcheck/task 不在 manifest `contributes.cards` 里静态声明，而是工具执行时由 `details.card`（带 route）内联投射，属"被动卡"。

---

## 二、工作区壳页（workspace.html / workspace.js）

### 2.1 职责
- 三态视图：`booting` / `ready`（内层 iframe 指向 ComfyUI 前端）/ `error`（中继未就绪）/ `offline`（服务未运行，盖住 iframe 不暴露中继 JSON）。见 `showView()` `workspace.js:500`。
- iframe 装载 + 连接方式（直连 127.0.0.1:8188 / 自动 / sdk / raw），`buildFrameUrl()` `workspace.js:816`。
- 自绘标题栏（仅 App 原生窗口态）：`setupTitlebar()` `workspace.js:1602`；拖动区 + 最小化/最大化/关闭。
- 悬浮按钮「放入 hui 画布」（仅窗口态 ready 时）：`handoffPush()` `workspace.js:1185`。
- 主题同步：壳页自绘色板 + 内层 ComfyUI 色板跟随 + 宿主主题 CSS 变量映射（`syncTheme` `workspace.js:59`、`applyHanaThemeVars` `workspace.js:276`、`syncComfyPalette` `workspace.js:91`）。
- 帧健康校验与退避重载：`frameHealthCheck` `workspace.js:1018`、`requestFrameReload` `workspace.js:947`。
- 离线去抖 + 恢复闸门：`statusTick` `workspace.js:1066`（去抖计数 `OFFLINE_DEBOUNCE_TICKS=3` `workspace.js:35`）。
- 壳页桥：向 App 报到 + 轮询待执行画布 op：`shellTick` `workspace.js:1571`、`shellOp` `workspace.js:1423`。
- 画布移交（窗口↔卡）：`handoffCheckOnce` `workspace.js:1257`、`handoffTakeover` `workspace.js:1290`。

### 2.2 关键 DOM id（workspace.html）
| id | 作用 |
|---|---|
| `ws-root` / `ws-titlebar` / `ws-tb-min` / `ws-tb-max` / `ws-tb-close` | 自绘标题栏（仅原生窗口态 `.on`） |
| `ws-bar` / `ws-bar-text` / `ws-bar-action` / `ws-bar-action2` | 顶栏操作/提示条（无消息时收起） |
| `ws-body` / `ws-loading` / `ws-frame-wrap` / `ws-frame` | iframe 装载区 |
| `ws-handoff` | 「放入 hui 画布」悬浮按钮（窗口态） |
| `view-booting` / `view-offline` / `view-error` | 三态视图容器 |
| `btn-retry` / `btn-retry2` / `btn-reload-boot` / `btn-svc-start` / `btn-svc-guide` / `btn-svc-reload` / `sel-mode` / `sel-mode2` | 启动/重试/模式选择 |
| `guide-mask` / `guide-step1/2/done` / `g-ai` / `g-self` / `g-later` / `g-launch` / `g-copy` | 安装引导弹窗 |

### 2.3 关键函数（workspace.js，带行号）
| 函数 | 行号 | 职责 |
|---|---|---|
| `hostThemeIsDark` | 48 | 宿主是否深色主题 |
| `syncTheme` | 59 | 壳页主题同步入口 |
| `syncComfyPalette` | 91 | ComfyUI 色板跟随宿主明暗 |
| `HANA_CSS_MAP` / `HANA_JS_MAP` | 128 / 170 | 宿主→ComfyUI CSS/JS 变量映射表 |
| `applyHanaThemeVars` | 276 | 把宿主主题变量注入内层 iframe（CSS + LiteGraph JS） |
| `pushThemeToComfyServer` | 367 | 直连时先推宿主色板进 ComfyUI 设置 |
| `readSurfaceSession` | 793 | 取 App surface 会话凭据（URL/appSurfaceSession 或路径 `/ui/_surface/<token>/`） |
| `buildFrameUrl` | 816 | 按 mode 构造 iframe src（直连优先） |
| `tick` | 853 | 主流程：读 boot 状态 → 切三态 / 装载 iframe |
| `startStatusPolling` / `statusTick` | 928 / 1066 | 状态轮询（3s）+ 离线去抖 + 恢复重载闸门 |
| `requestFrameReload` | 947 | 统一重载 iframe 入口（带 `_hr` 时间戳防缓存） |
| `frameHealthCheck` / `frameSuspectTick` | 1018 / 1044 | 帧健康探针 + 退避重载（1s/2s/4s，上限 3 次） |
| `handoffCall` / `handoffPush` / `handoffTakeover` | 1142 / 1185 / 1290 | 画布移交：写盘→让位 / 卡侧接管 |
| `shellTick` | 1571 | 壳页桥轮询 `shell/poll`，执行 ops 并回写 `shell/result` |
| `shellOp` | 1423 | 壳页侧 op 实现（`canvas.openWorkflow` / `canvas.revision` / `exec.running` / `shell.diag` 等） |
| `setupTitlebar` | 1602 | 原生窗口态自绘标题栏 |
| `main` | 1689 | 启动：主题订阅、就绪、tick、shell 轮询（800ms） |

### 2.4 与 app 路由的交互
- 状态/启动类：`getBootState` `workspace.js:698` → 中继 `boot` 端点；`getFullStatus` `workspace.js:703` → `/comfyui-hana/status`；`postRetryStart`/`postBackendStart`/`startBackend`/`postBackendStop`/`stopBackend` `workspace.js:708-738` → 中继重启/服务起停端点。
- shell 桥：`POST /comfyui-hana/shell/hello`（报到）、`GET /comfyui-hana/shell/poll`（轮询，800ms，`SHELL_POLL_MS` `workspace.js:1370`）、`POST /comfyui-hana/shell/result`（回写 op 结果）、`POST /comfyui-hana/shell/reload`（重载 iframe，见 §三）。
- 画布移交：`POST /comfyui-hana/handoff`（op: write/peek/take/close-window）。
- 凭据：`hana.api.fetch` 自动带 surface 凭据（不落存储、不写日志，注释多次强调）。

---

## 三、shell 轮询链路 + 跨页通道（POST /comfyui-hana/shell/reload）

### 3.1 workspace.js 侧（壳页桥轮询）
- 周期：`SHELL_POLL_MS = 800` `workspace.js:1370`；`main()` 内 `setInterval(() => void shellTick(), SHELL_POLL_MS)` `workspace.js:1710`。
- `shellTick()` `workspace.js:1571`：
  1. `GET /comfyui-hana/shell/poll?t=...` 取待执行 ops 队列；
  2. 逐条 `shellOp(op, args)` `workspace.js:1423` 执行（含 `frame.reload` 等）；
  3. `POST /comfyui-hana/shell/result` 回写 `{ rid, ok, data/error }`。
- 单壳页实例约束：注释明确"单桶壳页桥（同刻仅一壳页）"，所以面板触发重载经 App 中转排队，由壳页轮询取到执行。

### 3.2 panel 侧跨页通道（panel.html → POST /comfyui-hana/shell/reload）
- 面板与整页工作区是**两个页面实例**，panel 够不到工作区内层 iframe，故走信令中转：
  1. 按钮 `#p-reload-ws`（`panel.html`）→ `reloadWorkspace()` `panel-status.js:788`；
  2. `POST /comfyui-hana/shell/reload`（body `{}`，走 `hana.api.fetch`，同 `/comfyui-hana/release` 凭据口径）；
  3. App 把 `{ op:"frame.reload" }` 塞进壳页桥队列；
  4. 壳页 `shellTick()` 轮询取到 → `shellOp("frame.reload")` → `requestFrameReload("shell-reload")`（`workspace.js:947`）。
- 失败语义：`j.error === "shell-not-alive"` → 提示"工作区当前未打开，无法重载"。

---

## 四、宿主左栏面板（panel.html / panel-status.js）

### 4.1 职责
- 连接状态折叠区（`#fold-status`）：中继 / 端口 / 后端 / 版本 / 队列 + 更新区（检查/更新按钮）。
- 监视器折叠区（`#fold-mon`）：GPU/CPU/内存/温度/功耗实时曲线（`drawChart` `panel-status.js:337`）。
- 服务起停：`#p-start` / `#p-stop`（`startService` `panel-status.js:502` / `stopService` `panel-status.js:541`）。
- 释放显存：`#m-release`（`releaseVram` `panel-status.js:570`）。
- 重启中继：`#p-retry`（`restartRelay` `panel-status.js:821`）。
- 重载工作区：`#p-reload-ws`（`reloadWorkspace` `panel-status.js:788`，见 §三）。
- 状态信号灯：`#sig-dot`（`applySignal` `panel-status.js:738`，互斥优先级：异常 > 有更新 > 正常）。
- 主题跟随：`syncTheme` `panel-status.js:164`（三级判定，2026-10-11 修复白底）。

### 4.2 关键函数（panel-status.js，带行号）
| 函数 | 行号 | 职责 |
|---|---|---|
| `syncTheme` | 164 | 面板主题三级判定（快照→色值→系统偏好） |
| `render` | 204 | 连接状态三态渲染 |
| `poll` | 309 | 状态轮询（`/comfyui-hana/status`，2s） |
| `drawChart` / `pushPoint` / `redrawAll` | 337 / 369 / 374 | 监视器图表 |
| `metricsTick` | 420 | 主机指标轮询（`/comfyui-hana/metrics`，1s） |
| `startService` / `stopService` | 502 / 541 | 服务起停（120s 等待收尾） |
| `releaseVram` | 570 | 释放显存（`/comfyui-hana/release`） |
| `checkUpdate` / `applyUpdate` / `updStatusTick` | 658 / 682 / 643 | 更新检查/一键更新/状态轮询 |
| `applySignal` | 738 | 状态信号灯（异常/更新/正常） |
| `silentUpdateCheck` | 773 | 启动静默查更新 + 每 10 分钟 + 可见时 |
| `reloadWorkspace` | 788 | 跨页重载工作区（POST `/comfyui-hana/shell/reload`） |
| `restartRelay` | 821 | 重启中继 |
| `main` | 844 | 启动：主题订阅 + 低频轮询兜底 + 各轮询 |

### 4.3 与 app 路由的交互
`/comfyui-hana/status`、`/comfyui-hana/metrics`、`/comfyui-hana/release`、`/comfyui-hana/relay/start`、`/comfyui-hana/update`（GET 检查 / POST 应用 / `update/status`）、`/comfyui-hana/shell/reload`、`/comfyui-hana/backend/start`、`/comfyui-hana/backend/stop`。

---

## 五、设置页（settings.html / settings.js）

### 5.1 职责
- 安装目录：当前探测 / 自定义目录 / 保存 / 重新探测 / 清除（经 `/comfyui-hana/install-target`）。
- 服务启动：`#s-auto-start`（Hana 启动时自动拉起，经 `/comfyui-hana/auto-start`）。
- 画布（共驾）：`#s-allow-write`（允许 agent 改画布）、`#s-allow-copilot`（允许开副驾驶），分别经 `/comfyui-hana/allow-write` / `/comfyui-hana/allow-copilot`。
- 连接（只读）：后端 / 可达性 / 中继 / App 版本（`/comfyui-hana/status`）。
- 主题：`syncTheme` `settings.js:11`（快照正则 / 系统偏好兜底）。

### 5.2 关键函数（settings.js，带行号）
| 函数 | 行号 | 职责 |
|---|---|---|
| `syncTheme` | 11 | 主题跟随 |
| `poll` | 42 | 连接状态轮询（3s） |
| `loadInstall` / `postInstallTarget` | 88 / 131 | 安装目录读取/保存 |
| `loadAutoStart` | 178 | 自动拉起开关读取 |
| `loadAllowWrite` / `loadAllowCopilot` | 222 / 269 | 画布授权开关读取 |
| `main` | 311 | 启动：全部读取 + 轮询 |

---

## 六、环境检查卡（envcheck.html / envcheck.js）

### 6.1 职责
- 拉起 ComfyUI 前环境阻断检查卡：GPU 计算进程 / 显存 / 8188 端口。
- 状态机：`init → blocked | clean | error | done | canceled`（`S.phase` `envcheck.js`）。
- 操作：`envcheck`（检查）、`clear`（清理勾选进程）、`start`（拉起）、`wait`（就绪轮询）、`cancel`。
- 尺寸自适应上报：`reportSize` `envcheck.js`（宽度 460，高度内容决定；终态强制补报）。

### 6.2 与 app 路由的交互
`POST /comfyui-hana/backend/{envcheck,clear,wait,start}`（凭据由 `hana.api.fetch` 自动带；App 经 controlKey 转发到中继）。

---

## 七、任务卡（task.html / task.js）

### 7.1 职责
- ComfyUI 任务进度 / 产物预览卡：进度条、耗时、队列位、当前/完成节点、prompt/宿主任务 id、缩略图网格、错误。
- 身份解析：`resolveIdentity` `task.js` —— 优先 surface `cardInstanceId`，其次 URL query `?id=/?pid=/?taskId=` 兜底（重试约 1.8s）。
- 轮询：`GET /comfyui-hana/task?cardId=...`（终态 5s、否则 1.5s）。
- 预览图：经代理路径 + surface 凭据段（`thumbUrl` `task.js`）。
- 尺寸上报：`reportSize` `task.js`（同 envcheck 口径）。

### 7.2 与 app 路由的交互
`GET /comfyui-hana/task?cardId=<或 id/pid/taskId>`。

---

## 八、共享 SDK（`app/ui/assets/sdk.js`）

- 这是宿主 `@hana/plugin-sdk` 的**运行时打包**（含 host-message-source、ui-actions、input-panel、theme、runtime snapshot、surface、envelope 等模块），页面统一 `import { hana } from "./sdk.js"`。
- 暴露 `hana` 对象：`api.fetch`（带 surface 凭据）、`theme`（getSnapshot/subscribe/cssUrl）、`surface.getContext`、`window`（原生窗口桥：close/control/onRequest）、`state.set`、`track`、`ui.resize`、`ready` 等。
- 不应手改（属宿主契约运行时）；与 `app/sdk/` 的**类型声明**是两套东西（见 §九）。

---

## 九、SDK 分类（`app/sdk/`）

> `app/sdk/` 全部为 `.d.ts`（类型契约）+ `.js`（仅供类型引用/打包），由 `scripts/sync-app-sdk.mjs` 从宿主 `shared/` 生成，**不要手改**。

### 9.1 宿主契约（`app-contract/*`）—— 宿主定义、App 须遵守的接口
| 模块 | 一句话职责 |
|---|---|
| `app-contract/index` | v2 App 契约总入口：ctx 形状 / manifest 形状 / bus 动词 / 可授予能力词全集 |
| `app-contract/context` | App 运行期上下文（ctx）形状 |
| `app-contract/manifest` | manifest 字段类型 |
| `app-contract/windows` / `instances` / `surfaces` | 窗口 / 实例 / 表面（卡/面板/设置槽位）契约 |
| `app-contract/tasks` / `sessions` / `session-search` | 宿主任务 / 会话 / 会话检索契约 |
| `app-contract/runtime` / `runtime-client` | 受管 runtime（execute/network 等）契约 |
| `app-contract/bus-requests` / `app-bus-contract` | App→宿主 bus 请求动词白/黑名单 |
| `app-contract/models` / `providers` / `queries` / `agents` / `environment-agents` | 模型 / Provider / 查询 / 智能体 / 环境智能体契约 |
| `app-contract/registration` / `entry-context` | 注册表 / 入口上下文 |
| `app-contract/canvas` / `workspace` | 画布共驾 / 工作区契约（hui 重度使用） |
| `app-contract/input-panels` / `input-status` / `notifications` / `dynamic-ui` | 输入面板 / 输入状态 / 通知 / 动态 UI 契约 |
| `app-contract/mcp` / `catalog` / `cli` / `app-services` | MCP / 卡市场目录 / CLI / App 服务契约 |
| `app-contract/public-data` / `config-state` / `media` / `model-stream` / `environments` / `settings` | 公共数据 / 配置态 / 媒体 / 模型流 / 环境 / 设置契约 |
| `app-contract/sdk-error` / `rpc-error` | 契约层错误类型 |

### 9.2 App 自带能力声明（`app-*-capabilities`）—— 各域能力词常量/类型
| 模块 | 一句话职责 |
|---|---|
| `app-tool-exposure` | `app/tools.expose-to-model` 能力词（向模型暴露 `comfyui` 工具） |
| `app-process-capabilities` | `app/runtime.execute` / spawn 能力词 |
| `app-resource-capabilities` | `app/resources.read` / write 能力词 |
| `app-session-control-capabilities` | `app/session.start-turn` 等会话控制能力词 |
| `app-input-panel-capabilities` / `app-input-status-capabilities` | 输入面板 / 输入状态能力词 |
| `app-ui-capabilities` | `app/ui.open-external` / clipboard-write 等 UI 能力词 |
| `app-entity-capabilities` / `app-query-capabilities` / `app-catalog-capabilities` | 实体/查询/目录能力词 |
| `app-media-capabilities` / `app-mcp-capabilities` / `app-provider-capabilities` | 媒体/MCP/Provider 能力词 |
| `app-render-capabilities` / `app-session-file-capabilities` / `app-hook-capabilities` | 渲染/会话文件/hook 能力词 |
| `app-grantable-capabilities` | 可授予能力词全集（`APP_GRANTABLE_CAPABILITIES`） |
| `app-capability-introspection` | 能力内省辅助 |
| `app-bus-contract` / `app-tool-exposure` 等 `*_icons` | bus 契约 / 图标名 |

### 9.3 其余契约模块（宿主定义，App 引用）
| 模块 | 一句话职责 |
|---|---|
| `ui-contribution-points` | 宿主 UI 贡献槽位词汇表（messageActions / cardChrome / slots / contextMenus / keybindings 等）；App 在 manifest `contributes.ui` 里填的"座位"由宿主固定，插件不能自创位置 |
| `card-kernel` | 卡形态/落地/全站声明契约：`cardForm`(framed/flush)、`realization`(card/page)、`siteNavEntry`/`fpFullPanel`、`functionPanel` 声明、`titlebar`、`CARD_RENDERER_LANES` |
| `chalkboard-layout` | 黑板页面 id 与 scope-key 助手（`CHALKBOARD_MAIN_LAYOUT_SCOPE_KEY`、`workspaceScopeKey` 等，页面身份/布局持久化契约） |
| `index` | re-export `app-contract/index`（契约入口） |
| `extension-contract` / `extension-market-index` | 扩展种类 / 市场索引契约（App 打包相关） |
| `preview/app-view-contract` / `preview/document-contract` | 宿主视图/文档契约预览类型 |
| `annotations` / `components` / `ui` / `plugin-panel-descriptor` | 注解/组件/UI 辅助/插件面板描述类型 |
| `app-*-types` / `_app-types` / `_ui-*` | 配套类型声明 |

---

## 十、manifest.json 逐字段

| 字段 | 声明内容 |
|---|---|
| `manifestVersion` | `2`（v2 App 格式） |
| `id` | `comfyui-hana` |
| `name` | `Hana-ComfyUI` |
| `version` | `0.12.0` |
| `description` | 一句话描述：本机 ComfyUI 接进 Hana、iframe 嵌入官方前端、comfyui 工具、服务起停/更新、画布共驾、左侧面板、安装引导等 |
| `entry` | `index.js`（App 主进程入口） |
| `icon` | `assets/icon.png` |
| `minAppVersion` | `0.1013.0`（宿主最低版本要求） |
| `network` | 网络白名单：`allowedHosts:[127.0.0.1]`、`methods:[GET]`、`allowLocalhost:true`、`defaultTimeoutMs:5000`、`maxResponseBytes:1MiB` |
| `capabilities` | 声明需宿主授予的能力词：`app/runtime.execute`、`app/runtime.local-machine`、`app/runtime.network`、`app/resources.read`、`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`、`app/windows.manage` |
| `ui.csp` | 内容安全策略：`frameDomains:[http://127.0.0.1:8188]`、`connectDomains:[http://127.0.0.1:8188, ws://127.0.0.1:8188]`（直连 iframe / WS 放行） |
| `contributes.cards` | 一张卡 `workspace`：title=ComfyUI 工作区、route=/workspace.html、realization=`page`、siteNavEntry=true、fpFullPanel=true、closable=false、cardForm=`flush`、titlebar=`solid`、`functionPanel`(id=status,label=ComfyUI 状态,route=/panel.html)、`detached`(route=/workspace.html 外开窗口)、`face.image`=assets/cover.png |
| `contributes.settings` | 设置页：title=Hana-ComfyUI、`ui.route=/settings.html` |

> `capabilities` 与 `ui.csp` 是"向宿主要权限/放行"的声明；`contributes` 是"向宿主贡献什么 UI"的声明。envcheck/task 卡不在 `contributes.cards` 里（被动内联投射，见 §一）。

---

## 十一、tools 脚本表

| 脚本 | 用途 | 何时用 | 关键参数 |
|---|---|---|---|
| `tools/deploy-bridge.ps1` | 把 `app/bridge`（hana_bridge：py + js）部署到本机 ComfyUI `custom_nodes/hana_bridge`；js 子目录清空重建防双载 | 改了桥（前端扩展/py）后部署 | `-Status`（只报状态）、`-Remove`（卸载）、`-ComfyRoot <根>`（显式指定含 main.py 的目录；省略时自动探测） |
| `tools/sync-to-host.ps1` | 开发仓 `app/` → 宿主副本（`C:\Users\John Galt\.hanako\apps\comfyui-hana`）增量同步 + SHA-256 全量核对 | 改了 `app/`（index.js/ui/lib）后推宿主副本 | `-DryRun`（只列差异不写盘）、`-Create`（首建副本）、`-SkipVerify`（跳过核对）、`Source`/`Target`（默认已定） |
| `tools/bridge-reload.ps1` | 给桥 js 换时间戳文件名（绕浏览器缓存）→ 部署 → 重启 ComfyUI → 开无痕页定向冒烟 | 改了桥 js 后免手敲一键重载验证 | `-Op <op>`（冒烟 op，默认 api.probe）、`-ArgsJson`、`-NoRestart`、`-NoOpen` |
| `tools/validate-app.ps1` | 对开发仓做官方 App 校验（先 robocopy 到 staging 再跑 `hana-app-creator` 校验器） | 提交/发布前静态校验 | `-Smoke`（加隔离 AppHost 启动校验）、`-Electron <exe>`（smoke 用 Electron 路径）、`Stage`/`Source`（默认已定） |
| `tools/check-bridge-syntax.mjs` | 桥 js「真解析」检查（剥 import 后 `new Function`）——抓 `node --check` 漏报的重复声明 | CI/提交前查桥语法 | `<path/to/bridge.js>`（默认活动 hana-bridge-*.js） |
| `tools/test-history-commit.ps1` | 画布提交历史 HTTP 级回归（针对运行中的 8188，测试专用 `__selftest__` 名，含 A/B/C/D 组用例） | 改了 history-commit/list 后实机回归 | `-BaseUrl`（默认 127.0.0.1:8188）、`-HistoryRoot`（落盘根，默认 D:\ComfyUI\...\workflows\.history） |
| `tools/make-placeholder-assets.py` | 生成占位图：`app/assets/icon.png`(256) + `app/ui/assets/cover.png`(640×400)，纯标准库幂等 | 缺图标/封面或重画占位图时 | 无参（路径写死相对仓库根） |
| `tools/m0-checks/` `m2-checks/` `m3-checks/` `m13-checks/` | 各里程碑（M0/M2/M3/M13）的专项测试/诊断脚本集（relay / e2e / submit-file 等） | 对应里程碑回归/排障时 | 见各子目录脚本内 `param`/`EXAMPLE` |
| `tools/*-checks/run-all-tests.ps1` 等 | 测试集合驱动 / 主机模拟 / 日志 | 批量跑检查或重放 | — |

---

## 十二、生效方式（链接引用）

UI / SDK / tools 的改动如何生效（部署、同步、重启纪律），**以 [`docs/改动生效范围.md`](./改动生效范围.md) 为准，本文不重写**。要点速记：

- `app/bridge/**`（py/js）→ 部署 + **重启 ComfyUI 服务**（py 热更不生效；js 改名绕缓存 + 重载工作区）。
- `app/index.js` / `app/ui/**` / `app/lib/**` → `sync-to-host.ps1` 同步 + 宿主重载/重启（ui 受 iframe 缓存，重启最稳）。
- `app/sdk/**` 与 `docs/**` → 随仓库同步，不影响运行态；`app/sdk` 由宿主 `sync-app-sdk` 生成，手改无效。
- 配置/数据（app 数据目录 json）→ 即时生效。
- 涉及宿主重启 / 服务重启 / 工作区重载一律"先说再动"，禁止静默重启。

---

*普查范围：`D:\HanakoWorks\ComfyUI\app\ui`、`app\sdk`、`app\manifest.json`、`tools`。未改动任何源码，未联网。*
