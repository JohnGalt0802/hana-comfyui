# A · DSHana App 解剖报告（宿主运行副本 + 上游源码仓）

- 项目背景：ComfyUI-Hana（把本机 ComfyUI 前端与能力作为原生 v2 App 移植进 Hana，做 Agent-native 适配）；DSHana 为点名的参照案例。
- 解剖对象：**已安装运行副本** `C:\Users\John Galt\.hanako\apps\dshana\`（App 版本 `1.0.0-rc.12+dsh-0.1.5-rc.2`，manifestVersion 2）。
- 上游源码仓（本机无副本，经网络定位）：`https://github.com/Nyasers/DSHana`（MPL-2.0，579 commits，v2 App；包内 `NOTICE` 指向此仓）。
- 调研日期：2026-09-21（会话时）；
- 结论标注约定：`【读码】`=读过实际产物代码/类型/官方文档后确认；`【实测】`=对本机现装产物与数据目录的直接观察（只读）；`【推断】`=由已读材料推导；`[不确定]`=资料未覆盖或无法确认。本轮未启动/驱动任何进程（不做运行时实测），未修改任何文件（除本报告）。
- 姊妹报告：字段/能力契约的完整版在 `D:\HanakoWorks\ComfyUI\research\B-sdk-contract.md`（宿主 0.1013.2 的 `APPS.md` 为准），本报告不重复，只在 DSHana 用到处交叉引用。

## 0. 来源清单

| 来源 | 位置 | 说明 |
|---|---|---|
| 已安装 App 全量产物 | `C:\Users\John Galt\.hanako\apps\dshana\`（`index.js`、`runtime\dsh-host.mjs`、`ui\*`、`cordis\*`、`manifest.json`、`skills\dshana\SKILL.md`） | 本报告主要依据；`index.js` / `dsh-host.mjs` / `ui\app-shell.js` 为**压缩打包产物**（单行、变量名混淆），阅读方式为分片解压后逐段读 |
| App 运行数据目录 | `C:\Users\John Galt\.hanako\app-data\dshana\`（`.dsh\`、`integration\`、`storage\`、`generated\`、`.runtime-tmp\`）【实测】 | 观察到的运行痕迹（含 `.dsh\profiles\dshana\node_modules\@dshana` 软链、`.dsh\settings.yaml`） |
| 上游源码仓 | `github.com/Nyasers/DSHana`（`src/`、`src-cordis/`、`scripts/`、`dshana-install-skill/`、`vendor/`） | 通过 GitHub API 拉取到完整文件树（`git/trees/master?recursive=1`），用于把打包产物映射回源码模块 |
| 官方开发指南 | `...\artifacts\server\0.1013.2-win32-x64-...\APPS.md`（contributes.cards 段） | manifest 字段语义的权威解释 |
| 作者 SDK 类型 | `D:\HanakoWorks\_temp\hana-app-sdk\package\dist\card-kernel.d.ts`、`app-contract\manifest.d.ts`、`_ui-protocol.d.ts` | 整页卡/功能面板/形态声明的精确语义 |
| 公开检索（anysearch） | DSHana README、DSH 上游（`deepseek-ai/deepseek-harness`） | 只用于确认仓库存在与 README 事实 |

判定：未在 `D:\HanakoWorks\` 及其他位置发现 DSHana 的本地源码仓或开发文档（按名检索 `dshana*` 目录、在 `_docs` / `docs` / `_research` / `HanaAgentAPPs` 内按内容检索，均无命中）；唯一"源码面"为安装副本 + 上游 GitHub 仓。

---

## 1. 目录结构总览

### 1.1 安装副本（每个条目一句话职责）【读码】

```
apps\dshana\
├─ manifest.json            v2 清单：id/能力/网络白名单/contributes（一张整页卡 + 设置页）
├─ index.js    (66 KB)      【宿主侧插件入口】apply(ctx)：注册 dshana 工具、注册 /dshana/* 路由、
│                           受管 runtime 生命周期控制器、DSH RPC 客户端、任务绑定/取消链、
│                           open/reply/get/approve 五个动作、数据来源设置读写
├─ runtime\
│  └─ dsh-host.mjs (67 KB)  【受管 Node runtime 入口】解析私有运行时配置 → 定位/种子化 DSH profile →
│                           在进程内 boot DSH（runProfile）→ 等 webserver 真监听 → 交换 BrowserAuth 凭据 →
│                           起中继桥（HTTP 反代 + WS/分块 mux + /_control）→ 挂 task-bridge / approval-bridge →
│                           暴露 globalThis.__dshanaHana（宿主 IPC 客户端）→ 打印 readyMarker 退出码收敛
├─ cordis\                  【随包分发的 DSH 侧 cordis 插件（会被链接进 DSH profile 的 @dshana scope）】
│  ├─ dshana\cordis.patch.yml  定制 bundle patch：覆盖官方 web-runtime 行 + insert 三个 @dshana/* 插件
│  ├─ provider\index.js   【@dshana/provider】把 DSH 的模型调用接到宿主 hana.models（LlmAdapter 适配器）
│  ├─ theme\index.js      【@dshana/theme】用 webServer.tapIndex 往 DSH index 注入主题桥脚本
│  ├─ theme\client.js     DSH 客户端插件：把 DSH 主题偏好镜像到 documentElement 属性，供主题桥读取
│  └─ clipboard\index.js  空壳（apply 为空函数）——占位插件
├─ ui\                      【App 自己的页面（经宿主 App 路由面装载）】
│  ├─ main.html            整页卡主页面（meta role=main）
│  ├─ default.html         拆窗页面（meta role=default）
│  ├─ sidebar.html         功能面板页面（meta role=sidebar，内联样式含"作用域选择器"踩坑注释）
│  ├─ stream.html          每个子代理任务的会话卡页面（meta role=stream，含卡状态条样式契约）
│  ├─ settings.html/.js    设置页（React 19 + 宿主组件库，697 KB bundle）：审批超时/任务超时/默认模型/推理强度
│  ├─ app-shell.js (72 KB) 【所有页面共用的壳】：宿主 Plugin UI 桥 + boot-state 三态轮询 +
│  │                       DSH 前端"同文档注入" + 传输层 shim + 主题桥 + 剪贴板桥 + 卡状态条
│  ├─ face-stage.css       壳页样式（加载态/诊断面板）
│  └─ assets\cover.png     卡片封面（2.6 MB）
├─ skills\dshana\SKILL.md   给 Agent 的使用/排错手册（12.6 KB，随包分发）
├─ assets\icon.png          App 图标
├─ package.json             开发期清单（构建脚本、原依赖、engines: node ^22.18.0 || >=23.6.0）
├─ NOTICE                   MPL-2.0 + 上游仓地址（github.com/Nyasers/DSHana）
├─ THIRD_PARTY_NOTICES.md   随包第三方依赖许可
└─ node_modules\            DSH 及其完整依赖树（随包物化，运行时零安装）
```

### 1.2 上游源码仓目录（用于把产物映射回模块）【读码·GitHub API】

- `src\index.ts` → 打包为 `index.js`；`src\lib\*` 为宿主侧库（`managed-runtime` / `controller` / `boot-state` / `task-binding` / `task-ownership` / `session-run` / `session-serialize` / `cancel-chain` / `dsh-rpc` / `rpc-envelope` / `mux-chunks` / `ws-frames` / `watch-sse` / `model-settings` / `model-requests` / `profile-seed` / `data-source` / `source-switch` / `face-role` / `legacy-migrate` / `seed-tokens` / `config` / `app-runtime`）
- `src\routes\dshana-routes.ts` → `/dshana/*` 路由；`src\runtime\{main,bridge,mux-relay,approval-bridge,task-bridge,seed,locate,options,log}.ts` → `runtime\dsh-host.mjs`
- `src\tools\{index.ts, actions\{open,reply,close,get,approve,list}.ts, shared\{card,target,query,types}.ts}` → 工具面
- `src\ui\{app-shell,dsh-inject,clipboard-shadow,settings}.ts(x)` + `*.html` → `ui\*`
- `src-cordis\plugins\{provider,theme,clipboard}\*` → `cordis\*`；`src-cordis\cordis.patch.yml` → `cordis\dshana\cordis.patch.yml`
- `scripts\{build,derive,integrations,release\pack,release\market-index,vendor}*` → 打包/派生/市场索引流水线；`dshana-install-skill\SKILL.md` → Agent 侧安装流程（取 `index.v2.json` → 选 target → 核 sha256 → 卸载旧版 → 走宿主端点安装 → 验证）

---

## 2. manifest.json 全字段解读【读码】

```json
{
  "manifestVersion": 2,
  "id": "dshana",
  "name": "DSHana",
  "version": "1.0.0-rc.12+dsh-0.1.5-rc.2",
  "description": "把 DeepSeek Harness 变成 HanaAgent 的子代理",
  "entry": "index.js",
  "icon": "assets/icon.png",
  "minAppVersion": "0.1011.8",
  "capabilities": [ ... 10 项 ... ],
  "network": { ... },
  "contributes": { "cards": [ ... ], "settings": { ... } }
}
```

| 字段 | 值 | 解读 |
|---|---|---|
| `manifestVersion` | `2` | 恰好为 2（v2 装载机制）；格式/校验规则见 `B-sdk-contract.md` §1.2 |
| `id` | `dshana` | 必须与目录名一致；本 App 用它拼路由前缀 `/api/apps/dshana/routes/...`、`pluginId` |
| `name` / `description` | DSHana / 一句话中文 | 批准弹窗与市场文案 |
| `version` | `1.0.0-rc.12+dsh-0.1.5-rc.2` | 【推断】`<App 版本>+dsh-<内嵌 DSH 版本>` 的组合版本——与依赖 `@deepseek-ai/dsh@0.1.5-rc.2`、`package.json` 版本一致；宿主不解析语义（B 报告 §1.2） |
| `entry` | `index.js` | `apply(ctx)` 宿主侧插件入口（`index.js` 尾部导出 `apply`/`default`） |
| `icon` | `assets/icon.png` | 宿主生成展示图 |
| `minAppVersion` | `0.1011.8` | 宿主低于此版本装载失败；App 内代码对低版本宿主做了**能力探测降级**：`ctx.routes.register` 缺失时告警"宿主低于 0.930.1？壳页诊断面不可用"，`ctx.runtime.fetch` 缺失时提示"需要 Hana 0.944+" |
| `capabilities` | `app/tools.expose-to-model`（注册模型可见工具）、`app/tasks.manage`（宿主任务面：create/update/complete/fail/cancel/requestApproval/respondApproval/watch）、`app/session.start-turn`（`callToken` 来源会话绑定）、`app/models.infer`（宿主推理）、`app/resources.read`（校验 shared 数据目录）、`app/runtime.execute`、`app/runtime.local-machine`（受管 Node runtime + 无文件系统隔离档）、`app/runtime.network`（受管 runtime 出网）、`app/ui.clipboard-write`、`app/ui.open-external` | 与"拉起本机进程 + 用宿主模型 + 用宿主任务面 + 卡片 UI 桥"这套形态一一对应；README 强调安装审阅卡会如实标注"本机运行档位无文件系统隔离" |
| `network` | `allowedHosts:["127.0.0.1"]`、`methods:["GET","POST"]`、`allowLocalhost:true`、`defaultTimeoutMs:60000`、`maxResponseBytes:8388608` | 宿主侧 `ctx.network.fetch` 的出站白名单：只允许回环（用于和本 App 受管 runtime 的中继口说话）；未知键会整应用拒载（B 报告 §1.2） |
| `contributes.cards[0]` | 见下 | 一张**整页卡**（不是黑板卡） |
| `contributes.settings` | `{title:"DSHana", ui:{route:"/settings.html"}}` | 设置页由 App 自绘（未声明 `schema`，能力项走自绘页面 + 自有路由读写） |

`contributes.cards[0]` 逐键（DSHana 只声明一张卡，全部键都用到）：

| 键 | 值 | 语义（来源：`APPS.md` 卡片段 + `card-kernel.d.ts`） |
|---|---|---|
| `id` / `title` / `description` | `dshana` / DSHana / "DSHana bootstrap and workspace" | 卡片身份与展示名；`description` 面向模型（消费侧回退 `title`） |
| `route` | `/main.html` | 卡体页面；与 `embedUrl` 互斥 |
| `realization` | `"page"` | **整页卡**：宿主为它开一整页、放它一张卡占满，页面切换器多一项（不是画布上的一张卡） |
| `functionPanel` | `{id:"sidebar", label:"DSHana", route:"/sidebar.html"}` | 向功能面板贡献一块面板；面板**跟着卡走**（卡在哪页，面板在哪页；卡关/插件停用即不在场）。`main` 与 `sidebar` 共享同一 `cardInstanceId`（`hana.surface.getContext()` 语义） |
| `siteNavEntry` / `fpFullPanel` | `true` / `true` | 仅整页卡有意义：入口常驻全站导航（点击=打开/聚焦，不新建）+ 切到本页时功能面板由本页内容全占（隐掉系统区） |
| `closable` | `false` | 仅整页主卡：用户不能单独关主卡，只能删整页（防止"关掉卡但 DSH 还在跑"的悬空态） |
| `detached` | `{route:"/default.html"}` | 完整拆窗页面：拆窗时装载另一份文档（README 明确"拆窗、钉回、切页面都不停 DSH 后台"） |
| `cardForm` | `"flush"` | 内容形态：无卡片内边距/自带底色，交给页面自己铺满（DSH UI 要整块让位） |
| `titlebar` | `"solid"` | 标题带材质：实色（省略=同观感但保留"没说"语义） |
| `face` | `{image:"assets/cover.png"}` | **必填**卡片封面：目录/导航里那张脸 |

> 对照启发：DSHana 把"一个 App = 一整页 + 一块功能面板 + 一个拆窗口 + 一个设置页"这套宿主槽位用满；ComfyUI-Hana 若要"前端整块移植"，`realization:"page"` 是最贴近的载体。

---

## 3. 生命周期与进程管理

### 3.1 宿主侧控制器（`index.js` / `src\lib\{managed-runtime,controller,config}.ts`）【读码】

- **apply 阶段**（同步）：校验 `ctx.dataDir` → 注册工具 `dshana` → 注册 `/dshana/*` 路由（失败即中止 App 加载）→ 之后用 `Promise.resolve().then(() => ensureManagedRuntime())` 在**微任务**里自动拉起 DSH（不占 apply 同步栈；single-flight）。
- **端口/密钥/就绪标记**：`bridgePort`、`dshPort` 各取 `randomInt(38000, 52000)` 且互不相同（端口占用可自动换随机端口重试，≤3 次）；`bridgeKey`、`controlKey` 各 `randomBytes(24).toString("base64url")`；`readyMarker = "DSH_READY:" + randomBytes(18)`（宿主按整行匹配子进程 stdout）。
- **配置传递**：写一份私有运行时配置 JSON 到 `<dataDir>\integration\runtime-<hex>.json`（mode 0600），作为**唯一参数**传给 `runtime/dsh-host.mjs`；启动后立即删除（失败也删）。注释明确"端口/凭据一律走私有配置文件，不经 argv／环境变量／日志传递"（argv 只出现文件路径）。
- **启动调用**：`ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs", profile:"local-machine", network:"external", cwd:<dataDir>, args:[configPath], service:{ port: bridgePort, readyMarker } })`。宿主拒绝（如未授权 `local-machine`）→ 归一为 `not-authorized` 文案。
- **就绪判定**：拿到 `runtimeId` 后每 300 ms 轮询 `ctx.runtime.get(runtimeId)`，最多 **240 s**；`state==="ready"` 或 `service.state==="ready"` 即就绪。终态 `failed/exited/stopped` 按**退出码语义化**：`7`→端口占用、`4`→依赖缺失、`5`→profile 种子化失败、`6`→boot 失败，其余归 unknown，并回写 `lastError` 给状态面。
- **失败自愈**：启动失败 → 清理失败实例（`runtime.stop` + 等待 ≤15 s 确认）→ 退避重试 `[5s,15s,30s,60s,120s,300s]` 后封顶重复（定时器 `unref`，不阻退出）；用户手动 stop 后置位停止重试。多次启动尝试会打日志"无需手动操作"。
- **停止/回收**：`disposer`（App 停用/卸载时）→ `ctx.runtime.stop` + 状态归零；`POST /dshana/stop` → 同样路径。**卡片关闭、拆窗、页面切换都不触发停止**——生命周期由宿主受管 runtime 持有（SKILL 明示；与"卡片只是视图、runtime 是后台服务"的分层一致）。

### 3.2 受管 runtime 内部（`runtime\dsh-host.mjs` / `src\runtime\*.ts`）【读码】

启动链（`main.ts`）：

1. **配置校验**：`dshPort ≠ bridgePort`、密钥 ≥16 字符、`readyMarker` 不含换行；`--help` / `--preflight`（预检模式：只做定位+种子化，把结果 JSON 写到 `resultPath`，供"数据源切换"入口预检）两条旁路。
2. **定位依赖**：从入口向上找 `manifest.json` 定安装根 → `depsRoot` 默认 `<安装根>\node_modules` → 动态 `import` 包内 `@deepseek-ai\dsh` 的 `lib\profile-boot-*.js` 取官方 `runProfile`，并解析 `@deepseek-ai\dsh-app-boot`（拿 `initProfile`）。失败 → 退出码 4（deps），文案"依赖应随包物化，请重新安装本 App"。
3. **profile 种子化**（`seed.ts` + `profile-seed.ts`）：`DSH_HOME` 默认 `<App 数据目录>\.dsh`；对 `profiles\dshana` 做 `initProfile`，把随包 `cordis\` 目录**软链**（win32 用 junction，失败回落拷贝）到 `<profile>\node_modules\@dshana`；处理"老整树 junction"与形态异常（`refused`）。失败 → 退出码 5。
4. **boot**：`appBoot.loadLayeredEnv("dsh")` + `profileBoot.runProfile({ environment, profile:"dshana", patchFiles:[], args:["--port", <dshPort>, "--no-open"] })`（**进程内启动**，非再 spawn 子进程）；`EADDRINUSE` → 退出码 7。
5. **等真实监听**：轮询 `ctx.get("webServer").port` 并用回环 HTTP 探测 `/`，上限 **60 s**（`READY_TIMEOUT_MS`）；不符则 `port-unreachable` → 退出码 7。
6. **凭据交换**：取官方 `connection.authenticatedUrl(origin)` → `fetch(redirect:"manual")` → 抓 `Set-Cookie`（DSH BrowserAuth cookie）供中继带往上游；失败退出码 7（`auth-exchange`）。
7. **中继桥**（`bridge.ts`）：起 HTTP 服务（绑定 127.0.0.1:`bridgePort`）反代到 `127.0.0.1:<dshPort>`；鉴权：普通请求用 `x-hana-dsh-bridge` 头或 `/_hana/<key>/…` 路径段，WS 升级用 `?dshBridge=<key>`；另实现 `dshanaMuxChunks=1` 的**分块 mux**（把 WS 帧塞进 HTTP body 流，供不支持 upgrade 的链路）。控制面 `/_control`（`x-hana-dsh-control` 头 + controlKey）：动作 `resume` / `prepare-switch`（先查 DSH agents 是否忙，忙则拒）/ `rpc`（把宿主的 DSH client-request 信封转发到 `/api/<method>`）。
8. **task-bridge**（`task-bridge.ts`）：订阅 DSH cordis 事件（`api-session/status|error|activity`、`session/event`）→ 按会话建跟踪器 → 宿主任务 `status=running`（`progress{phase:"running", dshSessionId}`）→ `turn/end` 无错 → `hana.tasks.complete(taskId,{dsh:{...}})`；有错 → `fail`；aborted → 中止分支；同时反向 watch 宿主任务记录，发现 `canceled/aborted` → 反向发 DSH `session/cancel` + 取消在途模型请求。
9. **approval-bridge**（`approval-bridge.ts`）：挂 DSH `approval/request` 全局 waterfall（`prepend`）→ 由会话找到任务绑定 → **由工具 args 生成给人类看的操作摘要**（"执行命令 X" / "改文件 Y（替换 A → B）" / "写文件 Y（N 字符）" / "访问 Z" / "请求 URL"）+ 权限档识别（`danger-full-access` / `require_escalated` / `workspace-write` / `read-only`）→ 调宿主 `hana.tasks.requestApproval({taskId,label,details:{…,kind:"dsh-approval"},timeoutMs})` → 校验返回的 `parentTaskId` 与绑定一致（不一致 fail-closed 拒绝）→ watch 审批记录终态 → 把 `allowed-once` / `rejected` / `cancelled` 回给 DSH 等待者；桥停止时未结算审批一律 `rejected`。
10. **就绪信号**：`process.stdout.write(readyMarker + "\n")`（宿主按整行捕获）。退出码表：`OK:0, INTERNAL:1, USAGE:2, IPC_UNAVAILABLE:3, DEPS:4, SEED:5, BOOT:6, PORT:7, DISCONNECT:8`。
11. **IPC 前置检查**：`connectAppRuntime()` 只认父进程 IPC fd（`process.send`）；直接 `node runtime/dsh-host.mjs` 跑会以退出码 3 提示"只能由 `ctx.runtime.start({runtime:"node"})` 启动"。

### 3.3 健康检查 / 日志 / 错误处理

- **健康面**：路由 `GET /dshana/boot-state`（壳页与 Agent 共用的唯一状态出口：`phase/ready/runtimeId/proxyPrefix/service{state,port}/error{code,userText}/note/updatedAt`）、`GET /dshana/health`（`{ok,app{id,version},ts}`）、`GET /dshana/card-state?sessionId=`（返回 HTML 片段）。
- **日志**：App **不写文件日志**——宿主侧全走 `ctx.logger`（`info/warn/error`，`src\lib\log.ts`），受管 runtime 的 stdout/stderr 由宿主受管 runtime 层捕获（SKILL 明示）。壳页从 `boot-state` 的 `logTail` 渲染"最近日志"。【不确定】`logTail` 未出现在 App 包内字符串中（`index.js` 检索为 0 命中），推测由宿主侧对 App 路由响应或受管 runtime 服务信息附加，或壳页为防御性读取。
- **错误分类文案**：`index.js` 内置一张 code→中文 userText 表（`port-busy / port-unreachable / boot-failed / deps / seed / not-authorized / unknown`），保证"卡上给的是人话 + 原始错误可展开"。
- **失败不静默**：启动失败、设置写入冲突（`SETTINGS_CONFLICT`，409）、数据源切换（`/dshana/settings/restart` 固定 503 `SWITCH_DISABLED`——"功能未完成，入口暂时撤下"）都有显式返回。

---

## 4. 卡片机制

### 4.1 卡的形态与页面【读码】

- 一张整页卡（§2）+ 4 个页面角色，共享一个壳 `ui\app-shell.js`。角色由 `<meta name="hana-dshana-role">` 声明，映射到宿主 surface 槽位：`default→standalone`、`main→workspace`、`sidebar→navigation`、`stream→stream`、`settings→workspace`。
- 页面职责：`main.html` 整页工作区（装载 DSH 全前端）、`sidebar.html` 功能面板（同一份 DSH 前端的侧栏位）、`stream.html` **每个子代理任务一张会话卡**、`default.html` 拆窗、`settings.html` 设置。
- **surface 票据**：壳页启动时从自身 URL 取 `appSurfaceSession`（或 `/_surface/<token>/` 路径段）；缺失即拒绝运行并提示"请从 Card Center 重新打开本卡"——宿主对卡文档的 surface 授权是硬前提。

### 4.2 渲染方式：同文档注入（不是 iframe）【读码】

`ui\app-shell.js` 的注入流程（对应 `src\ui\dsh-inject.ts`）：

1. 经 App 路由面 `Q.api.fetch(<channel> + "index.html")` 取 DSH 首页 HTML（channel = `boot-state.proxyPrefix` + 插入的 `_surface/<票据>/`；`proxyPrefix` 形如 `/api/apps/dshana/routes/_runtime/<runtimeId>/_hana/<bridgeKey>/`）。
2. `DOMParser` 解析后**搬进当前文档**：`#root` 容器 `replaceChildren()`；head 里前置 `<base href>`；复制 `<link rel=stylesheet|modulepreload>`、`<style>`、执行内联 `<script>`；最后动态 append `<script type="module" src="<改写后的入口>">`（`he()` 助手）。资源 URL 经 `ae()/se()/ue()` 改写：只接受 DSH 自身 origin（伪 origin `http://dsh.internal`）或 App 路由前缀，**外部 origin 直接抛错**。
3. **传输层 shim**（`v.dispose`）：把 `window.fetch`、`XMLHttpRequest.prototype.open`、`EventSource`、`WebSocket`、`navigator.sendBeacon` 全部包一层，把 DSH 客户端发出的请求改写到中继前缀（`_surface/<票据>/_hana/<bridgeKey>/…`）；WebSocket 走 `api/remote.mux?dshanaMuxChunks=1`（分块 mux）。
4. 附带：`navigator.clipboard` 桥（`window.__DSHANA__`，宿主 `clipboard.writeText` 优先，原生回落）、尺寸/滚动/MutationObserver 同步。
5. 注入失败：页面切到 `data-view="action"`，展示"DSH 前端注入失败：<原因> … 检查中继前缀与 surface 票据"的诊断块。

### 4.3 状态流转（三态 + 卡状态条）【读码】

- 壳页轮询 `dshana/boot-state`（`booting` 时 1.5 s、其余 3 s 一次），渲染四态：`idle`（说明 + 「启动 DSH」按钮）、`booting/starting`（阶段时间线 + 日志尾滚动）、`ready`（执行 4.2 注入）、`error/stopped`（"需要处理"：原因 + 原始错误折叠 + runtimeId/port/日志尾 + 「停止」）。手动动作直接 `POST dshana/start|stop`。
- **runtimeId 变化 → `location.reload()`**：DSH 换了实例就整页重注入（避免半新半旧的文档状态）。
- **会话卡状态条**：`stream.html` 在 `#root` 上方插一条 31 px 的 `#dshana-card-strip`，内容从 `GET dshana/card-state?sessionId=<dshSessionId>` 取 HTML 片段（渲染契约：`.state/.dot/.detail` 类名 + `data-state` 取值 `tracked/ended/cancelling/unknown`）。数据源是宿主任务记录里本会话的绑定（`readCardState` → 任务 status/cancel/completedAt）。
- **卡内 UI 状态**：用宿主 `Q.storage.global` 按 `dshana.card.<cardInstanceId>.<key>` 存取（同一张卡的多个视图片共享；设置页的展开态等）。

### 4.4 用户交互回传路径

| 交互 | 路径 |
|---|---|
| 卡上「启动 DSH / 停止」 | 卡页 → `POST /dshana/start`（202 接受，异步启动）/ `POST /dshana/stop` → 宿主控制器 → `ctx.runtime.start/stop` |
| 设置页读写 | `GET/POST /dshana/settings`、`GET/POST /dshana/model`（带 `expectedRevision` 乐观并发；冲突 409 `SETTINGS_CONFLICT`） |
| 复制（DSH 前端内） | shim → 宿主 `hana.clipboard.writeText`（能力 `app/ui.clipboard-write`） |
| **审批** | **不在卡上做**：DSH 审批 → approval-bridge → 宿主审批记录 + 回合边界通知 → Agent 用 `dshana(action="approve", approvalId, outcome)` 应答；卡只展示任务状态 |
| 任务终态展示 | task-bridge 回投宿主任务 → `card-state` 片段 → 卡状态条 |

---

## 5. 宿主通信

DSHana 用了四层通道，各司其职：

| 层 | 机制 | 证据/代码位置 |
|---|---|---|
| ① 宿主插件 ↔ 宿主内核 | `ctx.tools.register` / `ctx.routes.register` / `ctx.runtime.{start,get,stop,fetch}` / `ctx.tasks.{create,get,update,complete,fail,cancel,requestApproval,respondApproval,watch}` / `ctx.network.fetch`（回环白名单）/ `ctx.storage.global.set("dshana:settings")` / `ctx.resources.stat` / `ctx.logger` / `ctx.config.get` / `ctx.dataDir` `appId` | `index.js` 全文；能力项见 manifest（§2） |
| ② 宿主插件 ↔ 受管 runtime | 两条路：(a) `ctx.runtime.fetch(runtimeId, "/_control", {action:"rpc", args:{body}})`（经 runtime service 代理走控制面）；(b) `ctx.network.fetch("http://127.0.0.1:<bridgePort>/api/<method>", {headers:{"x-hana-dsh-bridge":key}})` 直连中继 | `index.js`（`fe`/`me`/`pe` 函数簇） |
| ③ runtime ↔ 宿主内核 | **`process.send` 上的 JSON-RPC 2.0**：`app.domain.call{domain,method,args}`（domain=`tasks|models|media|network`），流式响应走 `http.body.read`（64 KiB/块），`http.body.cancel` 收尾；32 MiB 单消息上限、128 并发上限 | `dsh-host.mjs` IPC 客户端段；`src\lib\app-runtime.ts` |
| ④ 卡文档 ↔ 宿主 | 浏览器侧 Plugin UI 协议 `hana.plugin.ui`（v1，kinds=`event/request/response/error`）：`Q.api.fetch` / `Q.storage.global` / `Q.theme.getSnapshot|subscribe` / `Q.surface.getContext` / `Q.clipboard.writeText`；宿主推送 `hana.theme.changed`、`hana.surface.*`、`hana.sessions.active-changed`、`hana.storage.changed` | `ui\app-shell.js` 前段（协议校验器 + 客户端） |

**消息格式**（②③ 的共同信封，`src\lib\rpc-envelope.ts`）：请求 `{type:"client-request", rpcId, method, payload:{args|request:{…,requestId}}}`（`method` 前缀 `session.` 走 `request` 包装，其余平铺 args），响应 `{result:{ok:true,value}|{ok:false,error:{code,message}}}`；客户端校验 `rpcId` 回环。用到的 DSH 方法：`session/create`、`session/list`、`session/prompt`（`mode:"queue"` + `content:[{type:"text",text}]`）、`session/cancel`、`session/selectModel`、`session/modelCatalog`、`session/page`、`settings/describe`、`settings/replace` 等。

**执行器输出 → 卡片与通知**（Agent 面回执）：

- 工具返回 `{content:[{type:"text",text:"已开启 DSH 子代理…"}], details:{dsh:{action,taskId,sessionId,rpcId,status,delivery,cwd}, card:{pluginId:"dshana", route:"/stream.html?ts=<ms>&sid=<dshSessionId>&cwd=…", title:"DSHana 子代理已开启", description:"<sid 前 12 位>… · <cwd> · taskId …", aspectRatio:"16:9"}}}` —— `details.card` 即"这次调用渲染哪张卡"的声明（指向该会话的 stream 卡页）。
- 任务侧：`ctx.tasks.create({callToken, label, scope:"session", delivery:"next-step", metadata:{dsh:{action,cwd,sessionId,timeoutSec}}})` → `ctx.tasks.update` 回写 `metadata.dsh{rpcId,timeoutSec,approvalTimeoutMs}`（**宿主任务记录是句柄/会话绑定的事实源**）→ 终态由 task-bridge 回投（`complete/fail/cancel`）。`delivery` 档位在 create 时定死：`next-step`=结果在下一个输入点贴回（不打断在途请求、也不要求结束回合等待）。
- **无 `session:send-custom`**：本 App 不用自定义会话总线消息，Agent 侧通知全靠宿主任务面 + 审批记录（`app-task-approval-requested` 这类宿主事件由 `ctx.tasks.requestApproval` 触发）。【读码：`index.js` 检索 `session:send` 为 0 命中】

---

## 6. Agent native 设计

### 6.1 工具面：一个 App 一个同名工具，CLI subcommand 式【读码】

- `ctx.tools.register({ name:"dshana", description:"<长段中文使用说明>", parameters:<oneOf 5 分支>, execute })`；`parameters` 为 `{type:"object", oneOf:[…].map(分支=>({type:"object", additionalProperties:false, required:["action", …该动作必填], properties:{action:{const:"open"}, …fields}}))}` —— 每个动作**只认自己的字段**（`open` 的 schema 里没有 `approvalId`）。
- 5 个已注册动作与必填：

| action | 必填 | 语义 | 关键链路 |
|---|---|---|---|
| `open` | task, cwd | 开子代理并交首件活（固定异步：立即返回回执，任务后台跑） | `ctx.tasks.create` → 等 runtime 就绪 → `session/create` →（显式给了 provider/model 才 `selectModel`）→ 回写绑定 → `session/prompt` |
| `reply` | task（+ taskId 或 sessionId 二选一） | 续同一子代理；同会话多次 reply **App 侧串行化** | `session/list` 查 cwd → `session/create` resume → `session/prompt` |
| `close` | taskId/sessionId 至少一个 | 取消在跑任务（不影响共享 runtime 上其它会话） | 通知 DSH `session/cancel` → 轮询任务终态 15 s（500 ms 间隔）→ 未收敛则升级 `ctx.tasks.cancel` |
| `get` | taskId/sessionId | 回看最近一轮结论 | `session/list` 取 `projections.asOfSeq` → `session/page` 取窗口记录 → "最后一次 user 消息之后、最后一次 assistant 输出"；异常口径（无输出/被中断/错误收尾/更早轮次未读）显式标注，文本截断 ≤4000 |
| `approve` | approvalId | 应答挂起审批（`outcome: allowed-once|rejected`） | 校验 approvalId 归属（`parentTaskId` → 绑定会话一致）→ 已应答/已回收 fail-closed → `ctx.tasks.respondApproval` |

- `list` 动作：源码保留（`src\tools\actions\list.ts`）但**未注册**（2026-09-13 冻结）——SKILL 明确"需要列会话时改走宿主内置任务查询工具"（模型侧如 `check_pending_tasks`），避免再开一扇只读门。
- 参数默认值由 App 设置兜底：`timeout` 缺省用 `defaultTimeoutSec`（1800 s）；`approvalTimeoutSec`（30 s）随绑定写入宿主记录。

### 6.2 句柄 vs 凭证（归属模型）【读码】

- `taskId`（句柄，`open`/`reply` 返回值）与 `approvalId`（审批唯一句柄）由**工具自己解析**：读宿主任务记录 `metadata.dsh.sessionId` → 比对记录的 `parentSessionPath` 与本次调用的 `context.sessionPath`；不一致 → `session-mismatch` 拒绝（fail-closed）。记录缺字段也拒绝（`record-missing-parent-session`）。
- `sessionId`（形如 `session-<uuid>`）= **凭证路径**：显式传入即视为"我要跨对话"，跳过归属校验。
- `callToken`（`context.callToken`）是任务与来源会话的绑定依据；缺失即报错"请在模型工具调用路径下执行本工具"。

### 6.3 Skill 如何教 Agent

- 随包分发 `skills\dshana\SKILL.md`（安装副本路径 `C:\Users\John Galt\.hanako\apps\dshana\skills\dshana\SKILL.md`，宿主直接把它挂进可用技能表；同机制见 `apps\llama-monitor\skills\…`）。【实测】
- 内容结构：架构一句话 → 首次安装（无需配置）→ **卡三态表**（现象/怎么办）→ 工具手册（参数契约表、句柄与凭证、每个动作的语义与链路、投递档位）→ 主题 → 排错表 → 已知限制。
- description 里写死触发场景（"提交/查询/取消 DSH 任务、应答审批、卡显示未启动/启动中/需要处理…"），工具描述里也点名"完整调用手册见 SKILL"——形成"工具描述负责当下决策、SKILL 负责全景"的双层教学。

### 6.4 回合与审批边界（本项目最贵的经验）【读码 + SKILL】

- 审批通知**只在回合边界送达**：`open`/`reply` 提交后必须结束回合；下一回合才会拿到含 `approvalId` 的通知。同回合内空等或连续重发会撞**宿主工具回调 30 s 上限**（`RPC callback.tools.execute timed out after 30000ms`），并可能把会话卡死（后续 `reply` 一律超时、`close` 也难确认）——SKILL 排错表直接写"不要原地重试，换新会话"。
- 审批超时策略在 App 侧：缺省 30 s 自动拒绝（显式 0 禁用）；宿主自身 `timeoutMs` 缺省 0（不超时），所以"30 秒"是 App 的显式策略。
- 决策纪律写在工具描述与 SKILL 里：**决策看 `args`（要执行什么），不听 `reason`（模型自述）**；审批 `label` 与 `details`（`operation`/`escalationMode`/`escalationNote`/`approvalTimeoutMs`）同源，供人/Agent 判断。

---

## 7. 借鉴清单

### 7.1 可直接复用（附文件位置）

| # | 机制 | 为什么值得抄 | 位置 |
|---|---|---|---|
| 1 | **整页卡 + 功能面板 + 拆窗 + 设置页的槽位组合**；`realization:"page"` + `siteNavEntry` + `fpFullPanel` + `closable:false` + `cardForm:"flush"` + `face` | ComfyUI 前端也是"一整块工作区 + 侧栏"，槽位需求几乎同构；`closable:false` 避免"关了卡但服务还在跑"的语义悬空 | `apps\dshana\manifest.json`；语义：`...\APPS.md` 卡片段、`card-kernel.d.ts` |
| 2 | **受管 runtime 控制器**：随机端口对 + 随机密钥 + readyMarker + 0600 私有配置文件（启动即删）+ single-flight + 240 s 就绪轮询 + 退出码语义化 + 退避自愈重试 + disposer 回收 | 这是"把本机长驻服务塞进 App 生命周期"的整套骨架；ComfyUI 本机服务（若自管进程）可直接照搬参数与状态机 | `index.js`（`R/I/G/B/W` 函数簇）、`src\lib\{managed-runtime,controller}.ts` |
| 3 | **boot-state 单一状态出口 + 壳页三态轮询 UI** | 卡面与 Agent 面共用同一份快照（含人话 `note` 与原始 `error`），排错体验的根因 | `index.js`（`je`/`Z`）、`ui\app-shell.js` 轮询段、`src\lib\boot-state.ts`、`src\routes\dshana-routes.ts` |
| 4 | **同文档注入 + 传输层 shim**：`<base>` + head 资源搬运 + 动态 module 入口 + fetch/XHR/EventSource/WS/sendBeacon 改写 + 外源拒绝 | ComfyUI 前端同为 SPA：这条能免去 iframe 的跨文档限制（剪贴板、快捷键、尺寸），代价是样式冲突必须自己收（见 §7.3 坑位） | `ui\app-shell.js`（注入与 `v.dispose` 段）、`src\ui\dsh-inject.ts`、`src\lib\{mux-chunks,ws-frames}.ts` |
| 5 | **loopback 中继桥**：路径/头双鉴权 + `_control` 控制面（`rpc`/`prepare-switch`/`resume`）+ WS upgrade 反代 + 分块 mux 兜底 + 崩溃即关流 | 是"浏览器面 ↔ 本机服务"的唯一咽喉，也解释了端口/密钥为什么要随机 | `runtime\dsh-host.mjs`（`E`/`P` 函数）、`src\runtime\{bridge,mux-relay}.ts` |
| 6 | **凭据/推理不出宿主**：宿主 IPC 客户端 + DSH 侧 LlmAdapter 把模型调用回路到宿主 `ctx.models`；provider 凭据不进子进程 | ComfyUI 版对应物=把"执行引擎/模型/API Key"留在宿主，App 只做 UI 与编排 | `runtime\dsh-host.mjs`（`connectAppRuntime` 段）、`cordis\provider\index.js`、`src-cordis\plugins\provider\*` |
| 7 | **任务桥 + 审批桥双向收敛**：DSH 事件→宿主任务终态（running/complete/fail/cancel）；宿主取消→反向 `session/cancel` + 取消在途请求；DSH 审批→宿主审批记录→Agent 应答→回写 DSH 等待者 | "子代理生命周期 = 宿主任务生命周期"的完整映射；ComfyUI 侧对应"prompt_id 生命周期 → 宿主任务" | `src\runtime\{task-bridge,approval-bridge}.ts`、`runtime\dsh-host.mjs` 尾段 |
| 8 | **主题桥**：`webServer.tapIndex` 注入脚本 + token-map（上百条 DSH 变量映射到宿主 `--bg/--accent` 等）+ postMessage 请求/应答 + `data-dsh-theme-preference` 守卫（DSH 显式选 light/dark 时不介入） | 让"外来前端看起来像 Hana 的一部分"的最省力做法；ComfyUI 前端变量体系不同但套路可照搬 | `cordis\theme\{index,client}.js`、`src-cordis\plugins\theme\{token-map,client}.ts` |
| 9 | **Agent 面封装**：单工具 + `action` oneOf（`additionalProperties:false`）+ 句柄/凭证双路径归属校验 + 随包 SKILL + `details.card` 指向会话卡页 | 直接对应"一个 App 一个工具 + 一张卡 + 一份手册"的 v2 惯例；`details.card` 是"把执行器输出变成卡片"的官方姿势 | `index.js` 工具段、`skills\dshana\SKILL.md`、`src\tools\*` |
| 10 | **设置页自绘 + 自有路由承载**（无 schema，React 页面 + `/dshana/settings|model` + `expectedRevision` 乐观并发） | 需要复杂设置（模型选择、目录选择）时的可复用形态 | `ui\settings.html`、`ui\settings.js`、`index.js` 路由段 |
| 11 | **打包/发布流水线**：平台分包 + sha256 + 市场 index + 随包 vendor（`scripts\release\pack\*`、`scripts\derive\*`）+ Agent 侧安装 skill（`dshana-install-skill\SKILL.md`） | 若 ComfyUI-Hana 要随包分发大依赖（ComfyUI 本体/前端），这套"物化依赖 + 分包 + 校验"是现成参考 | 上游仓 `scripts\`、`dshana-install-skill\` |

### 7.2 属于 DSH/DeepSeek Harness 专属、不可照搬

- **DSH 的 profile/bundle/patch 体系**：`cordis.patch.yml` 层序（`dsh-base → dsh-web-app → @dshana/dshana`）、`runProfile` / `initProfile` / `loadLayeredEnv`、`webServer.tapIndex`、`connection.authenticatedUrl`（BrowserAuth）——全是 `@deepseek-ai/dsh-*` 包内契约。
- **DSH RPC 方法名与信封业务语义**：`session/create|list|prompt|cancel|selectModel|page`、`settings/describe|replace`、`session/modelCatalog`；DSH 会话 V3 日志与投影（`projections.asOfSeq`）。
- **DSH 的 cordis 事件与钩子**：`api-session/status|error|activity`、`session/event`（`turn/end` / `assistant/message`）、`approval/request` 全局 waterfall、`llm.registerAdapter`（`LlmAdapter`/`LlmError` 来自包内导出）。
- **DSH 前端注入的细节适配**：DSH 的 asset 布局、模块入口、`?dshanaMuxChunks=1` 帧协议（`g=[72,78,75,49]` 魔数、帧编解码）是为 DSH 前端 WS 量身定做的；ComfyUI 的 `/ws` 协议（`progress`/`executing`/`executed`/`status` 事件）需另写适配层而不是复用帧协议。
- **具体业务概念**：`agentPreset`（standard/ptc/cordis/minimal）、`reasoningEffort` 档位、DSH 的 `agent-default-model` settings 段名。
- 可迁移的是**结构与纪律**（状态机、鉴权、桥、任务映射、审批协议），不是这些名字与包。

### 7.3 移植时要盯住的坑（DSHana 已踩）

1. **同文档注入的样式污染是双向的**：`ui\sidebar.html` 里留有真机记录（2026-09-12）——无作用域的 `button` 规则会把 DSH 输入栏 28×28 的圆形按钮拉成椭圆，最终改成 `.panel button { … }`。ComfyUI 前端（组件众多、样式体量大）冲突面更大，必须提前规划**选择器作用域/影子隔离或 iframe 兜底**。
2. **宿主工具回调 30 s 上限**：任何"同回合内等外部审批/进度"的设计都会卡死会话（§6.4）。长任务要按"提交即返回 + 回合边界通知"设计。
3. **卡与进程生命周期解耦**：卡关/拆窗/切页不停服务，只有 App 停用/卸载才回收 → 状态面必须能在"卡重新打开"时自愈（DSHana 靠 boot-state 轮询 + runtimeId 变化即 reload）。
4. **凭据一律走私有配置文件（0600、启动即删）**，不进 argv/env/日志；端口/密钥随机化，避免固定端口与令牌泄漏面。
5. **诊断信息要人话 + 原始错误双层**：App 内置 code→中文映射 + `boot-state.note`，卡上折叠原始错误；排错入口只有一个（boot-state）。
6. **数据源切换这类"半成品"要显式下线**：`/dshana/settings/restart` 固定回 503 `SWITCH_DISABLED`，比留一个坏入口好。

---

## 附：本机运行痕迹（只读观察，供排错/对齐参考）【实测】

- `C:\Users\John Galt\.hanako\app-data\dshana\` 下：`.dsh\`（DSH_HOME，含 `profiles\dshana\` 与 `profiles\node_modules\@deepseek-ai\…`、`settings.yaml` 目前只有 `ui-onboarding` 段——**未设置 `agent-default-model`**，所以默认模型要显式传或在 DSH 内设置）、`integration\`（运行时私有配置与 `settings.json` 的落点）、`storage\`、`generated\`、`.runtime-tmp\`。
- `.dsh\profiles\dshana\node_modules\@dshana` 为**链接**（与代码里的 junction/symlink 行为一致），`profiles\dshana\{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml}` 为种子化产物。
- 本机另有可用开发资料（一并列出，便于 ComfyUI-Hana 立项）：`C:\Users\John Galt\.hanako\artifacts\server\0.1013.2-…\APPS.md`、技能 `hana-app-creator` / `hana-plugin-dev` / `plugin-dev-guide` / `hana-card-debug`、SDK 类型副本 `D:\HanakoWorks\_temp\hana-app-sdk\package\dist\*.d.ts`。

## 未覆盖 / 待确认

- 未做运行时实测（未启动 App、未跑工具），所有"行为"结论来自代码与文档；`logTail` 的产生位置 [不确定]。
- 上游仓最新提交时间与 changelog 未取（只取了文件树与 README）；安装副本对应的 commit 未对账（推断为 `rc.12` 发布点）。
- `src\tools\actions\list.ts` 的冻结细节以 SKILL 陈述为准（源码未逐行读）。
- 宿主 0.1013.2 与本 App 的 `minAppVersion 0.1011.8` 之间的版本差异未逐项比对（B 报告覆盖宿主侧契约）。
