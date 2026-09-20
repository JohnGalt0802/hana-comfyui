# hana-downloader 工程实现报告（ComfyUI-Hana 参考）

- 报告日期：2026-09-21（会话当日）
- 报告对象：`hana-downloader` v2 App（用户自研、全链路跑通的 v2 App 范例）
- 覆盖路径：
  - 开发仓（工作区）：`D:\HanakoWorks\HanaAgentAPPs\`，App 本体 `D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app\`
  - 宿主运行副本：`C:\Users\John Galt\.hanako\apps\hana-downloader\`
  - 运行数据：`C:\Users\John Galt\.hanako\app-data\hana-downloader\`
  - 公开分发仓：`D:\HanakoWorks\_git\HanaAgent-Plugins-repo`（GitHub `JohnGalt0802/HanaAgent-Apps`）
- 本轮宿主版本：HanaAgent **0.1013.2**（win32-x64）[实测：`server-info.json` 与进程命令行]

### 成色标注约定

| 标注 | 含义 |
| --- | --- |
| `[读码]` | 本轮直接读取源码/文件得到 |
| `[实测]` | 本轮在本机运行命令观察到（只读操作） |
| `[文档]` | 来自仓库既有文档的结论，本轮未逐一复验 |
| `[推断]` | 无直接证据的推断 |

> 本轮未修改任何文件；唯一写入即本报告。

---

## 0. 全景（一页速览）

架构是 3 个进程平面 + 1 个前端平面的四段式：

```
模型/宿主
  │  ① 工具调用（4 个工具：download-file / download-wait / download-cancel / download-command）
  ▼
【App 进程】index.js（defineApp 入口）
  │  ② ctx.runtime.start({ runtime:"node", entry:"engine/server.js", profile:"local-machine", args:[dataDir] })
  │     受管 node 子进程；不注册 runtime.service（有意为之，见 §7-坑4）
  │  ③ ctx.network.fetch("http://127.0.0.1:4317/<path>")  →  受控出网通道
  ▼
【引擎进程】engine/server.js（自监听 127.0.0.1:4317）
  │  HTTP 面（/ping /download /command /wait /cancel /retry /list /bind /register-card …）
  │  + 卡片绑定表（bindings.json）+ 事件落盘（finished/、stalled/）
  ▼
【内核】engine/dlcore.js TaskManager（URL 下载 + git/pnpm/winget/pip 四条命令链路）+ progress-parsers / download-probe / tunnel-agent
  ▼
磁盘（任务记录、产物、.part 半成品）与网络（直连或代理隧道）

【iframe 前端】ui/card.js（聊天流进度卡）、ui/manager.js（下载管理器）
  └─ 不直连引擎：hana.api.fetch → /api/apps/hana-downloader/routes/engine/* → App 路由转发 → 引擎
```

关键工程决策一句话版（全部有出处，详见对应章节）：

1. **App 进程做"薄"**：只做工具注册、路由、钩子、宿主任务与守望；重活全在受管引擎进程里（§1、§3）。
2. **通信不占 RPC**：App↔引擎用受控 HTTP；引擎→App 的异步事件（终态/卡滞）落盘成文件，App 用 fs 轮询（§3、§7-坑4）。
3. **卡片走工具返回值通道**：`details.card` + `details.bridgedTool`，宿主把 iframe 内联投影到工具调用块下方；`messageRenderers` 只作退路（§2、§7-坑11/13）。
4. **任务身份不靠推断**：App 用 `sha256(appId:taskId)` 前 20 位造稳定 `cardInstanceId`；引擎维护绑定表 `/bind` 认领（§2、§3）。
5. **开发→生效是"副本制"**：宿主从 `~/.hanako/apps/<id>` 副本运行，改动必须同步副本 + 按改动类型 reload / 重装 / 重启宿主（§5）。
6. **命令能力白名单化**：`download-command` 只有四种 kind，数组传参、无 shell、逐项校验；不做任意命令执行（§4）。

---

## 1. 工程布局：目录结构与职责

### 1.1 开发工作区顶层 `D:\HanakoWorks\HanaAgentAPPs\`

```
HanaAgentAPPs/
├── .git/                    工作区仓库（独立于 D:\HanakoWorks 父仓库管理，2026-09-17 分离）
├── .gitignore               已声明：hana-downloader-app/ 拆为独立仓库，本仓库不再跟踪各 App 内容
├── .tools/
│   └── sync-hana-downloader.ps1    ← 工作区通用脚本：开发目录 → 宿主副本同步 + 生效（§5 详解）
├── PRINCIPLES.md             Agent 原生原则（6 条：人类体验优先 / Agent 可感知 / 可控制 / 能力拓展 / 流程优化 / 注意力保护）
├── README.md                 目录约定 + 开发流程（三种同步参数）+ 发布（→ HanaAgent-Apps 仓库 plugins/<id>/）+ 版本管理
└── hana-downloader-app/      独立 git 仓库（自带 .git / .gitattributes / .gitignore）
```

- 工作区仓库 `git log` 顶部：`cf7a5ce chore(tools): sync 脚本排除内层 .git`、`4c82195 chore: hana-downloader-app 拆为独立仓库，本仓库退为工作台` [实测]。
- App 仓库 31 个提交、分支仅 `main`、**无 remote**（未配置推送目标）[实测：`git remote -v` 为空]。
- 工作区 `PRINCIPLES.md` 是硬性设计约定：App 必须"Agent 可感知、可控制"，这条直接决定了本项目的工具面设计（四个工具 + 铁律 + 管理器全可被 Agent 操作）。

### 1.2 App 目录 `hana-downloader-app\`（开发仓 = 宿主副本内容一致）

```
hana-downloader-app/
├── manifest.json          v2 清单（1.7KB）：id/version/minAppVersion=0.978.0、capabilities(11)、network、contributes.cards(2)+messageRenderers(1)
├── index.js               入口（45.8KB）：defineApp 注册 4 个工具、3 条路由、1 个钩子；引擎生命周期；结算/守望
├── sdk/                   官方 SDK dist，76 个 .js（README 记 77，[实测] 计 76），随 app 分发、不装 npm 包
│   ├── app-contract/      入口契约（server-client.js 等）：defineApp / AppSdk bus verb 表 / runtime-client
│   ├── ui.js              官方 UI SDK（与 ui/assets/sdk.js 哈希相同 [实测]）
│   └── ...capabilities.js 各能力域的词汇表与语义（app-grantable-capabilities 等）
├── engine/                受管下载引擎（纯 Node、无宿主依赖）
│   ├── server.js          HTTP 面 + 卡片绑定表 + 终态/停滞落盘（23.8KB）
│   ├── engine-port.js     端口唯一来源（ENGINE_PORT = 4317；index.js 与 server.js 共用）
│   ├── dlcore.js          下载内核 TaskManager（59.3KB）：URL 下载/断点续传/限速/SHA-256 + 四条命令链路框架
│   ├── progress-parsers.js 输出解析（git/pnpm/winget/pip/uv 纯函数 + winget 退出码表）15.3KB
│   ├── download-probe.js  winget 下载进度旁路探测（观测落盘文件增长）8.9KB
│   └── tunnel-agent.js    HTTP CONNECT 隧道 Agent（手写 raw socket + TLS）3.1KB
├── ui/                    iframe 前端（官方 UI SDK：票据/主题/尺寸/路由基址）
│   ├── card.html/js/css   聊天流进度卡（18.1KB 逻辑 + 9.9KB 样式）
│   ├── manager.html/js/css 下载管理器（39KB 逻辑 + 13.9KB 样式）
│   ├── shared/display.js  阶段/单位文案与任务形态判定唯一来源（Node 侧 index.js 也 import）3.9KB
│   ├── assets/sdk.js      官方 UI SDK dist 副本
│   └── face.png           卡片 face 位图（清单 contributes.cards[].face 用）
├── tests/                 离线测试（run-tests.mjs + 5 个 unit-*.mjs + servers/ 本地下载源）约 130 项
├── assets/                icon.png / icon.svg（应用图标；icon/ 下另有设计过程稿与 prompt，generated*/ 不入库）
├── icon/                  图标过程稿：attachments/（宿主 issue 留档）、prompts-小花下载器.md、4 张候选图
├── docs/                  见下
├── .gitattributes         行尾统一 LF（治 autocrlf 假差异）+ 二进制不转换
├── .gitignore             图标过程稿、node_modules、_temp 等
└── README.md              14.7KB：能力/安装/使用/配置/开发/结构/卡片投递机制/已知限制/尺寸/测试/排障
```

docs/ 目录（10 个文档，全部必有用途）：

| 文件 | 内容 | 对本报告价值 |
| --- | --- | --- |
| `改动生效范围.md` | 改哪类文件要不要重启的对照表 + 交付前自查五步 + 成色标注约定 | §5 依据 |
| `踩坑记录.md` | 36 条（现象→排查→根因→解法），含宿主侧通用结论 | §7 依据（67.8KB） |
| `重构说明.md` | v0.90.3→v1.0.0 重构动因/实测结论/新架构/验收记录 | §2、§3、§7 |
| `宿主缺陷-v2应用卡片投影丢工具名.md` | 0.970.9 卡片不出卡的完整定位（bundle 行号级） | §7-坑11/13 |
| `hana-app卡片尺寸与身份反馈.md` | 卡宽/卡身份两处缺口的宿主反馈稿 | §2、§7-坑6/9/10 |
| `七象限测试报告-20260910/0914/0920.md` | 投递能力测试三代（宿主 0.946.2 / 0.978.0 / 0.1013.2） | §3 实证 |
| `规划-winget与pip-20260918.md` | 两条新链路的方案 + 输出实测取证 | §4、§7-坑22~28 |
| `调研-网盘下载通道-20260920.md` | 网盘可行性（评估后不接入） | §8 边界参考 |

### 1.3 宿主运行副本与运行数据（[实测]）

- 宿主从**副本**运行：`C:\Users\John Galt\.hanako\apps\hana-downloader\`
  - 与开发仓做全量 SHA-256 比对：**127 文件 = 127 文件，零差异、零缺失**（排除 `.git` 与图标过程稿）[实测]。
  - 副本里残留一个**旧 `.git`**（历史同步产物，HEAD 停在 `112f25f`，落后于开发仓 `8819053`）。robocopy `/E` 只增不删，排除项是 2026-09-19 后加的，旧 `.git` 就留下了——同步校验时必须显式排除 `.git`，否则误报 [实测]。
- 宿主进程事实（`Get-CimInstance Win32_Process`）[实测]：
  - App 的 host 进程：`hana-server.exe ... --permission --allow-fs-read=<副本目录> --allow-fs-read=<app-data 目录> --allow-fs-read=<locales> --allow-fs-write=<app-data 目录> app-host-entry.js` → 即宿主对 App 进程的 fs 范围：**只读副本、只写 app-data**；App 自己不能写开发目录。
  - 引擎受管进程：`hana-win-sandbox.exe --cwd <app-data> ... -- hana-server.exe <副本>\engine\server.js <app-data>` → 引擎入口来自**副本目录**，dataDir 由 args 传入；端口 4317 处于 `Listen/Established` [实测]。
- app-data 目录 `C:\Users\John Galt\.hana\app-data\hana-downloader\`：

| 文件/目录 | 作用 |
| --- | --- |
| `tasks.json` | 任务记录（内核 restore 用；终态保留最近 100 条，进度不落盘、状态转换才落盘） |
| `finished/<taskId>.json` | 终态快照（App 靠**读文件**结算宿主任务，不走 RPC） |
| `stalled/<taskId>.json` | 卡滞快照（含 sessionPath/sessionId/stalledAt/stallTaskId 字段） |
| `bindings.json` | 卡片绑定表：pending / bind / assigned / rounds / stable 五张子表 |
| `engine-config.json` | defaultSaveDir / agentChooses / stallTimeoutMs / maxConcurrent / speedLimit |
| `downloads/`、`.runtime-tmp/`、`generated/`、`speed-cache.json`(旧版遗留) | 下载目录、受管进程 TEMP 重定向、旧文件 |

- 安装记录（`C:\Users\John Galt\.hanako\extensions\installs.json`）[实测]：`ref=app:hana-downloader`、`origin=user`、`source={type:"local", path:"D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app"}`、`location="apps/hana-downloader"`、`version=1.0.0`、`approval.declarationHash` + `appDeclaration`（能力清单+网络声明的哈希快照）、`integrity={sha256:<manifest 哈希>, checks:["manifest"]}`、`history` 记录了 0.16.0→0.90.3→1.0.0 的历次更新。
  - 注意：`source.path` 是**安装来源**（开发目录），但运行位置是 `location`（副本）——两者别混淆（§7-坑21 的根源）。

---

## 2. 卡片 UI 实现

### 2.1 卡片怎么定义

两类卡都在 `manifest.json` 的 `contributes.cards` 里声明 [读码]：

| 卡 | id | route | 关键声明 | 说明 |
| --- | --- | --- | --- | --- |
| 下载管理器 | `manager` | `/manager.html` | `cardForm: "flush"`、`realization: "page"`、`face.image: "face.png"` | 整页卡（宿主为它开一页放满） |
| 下载进度 | `progress` | `/card.html` | `cardForm: "flush"`、`face.image: "face.png"` | 默认 realization=card（画布/聊天流实例） |

另有退路通道 `contributes.messageRenderers: [{ customType: "download", cardId: "progress" }]`——只在工具结果通道不可用时启用（§3.1、§7-坑11）。

语义（来自官方 SDK `card-kernel.js` 注释 [读码]）：
- `cardForm` 只管"内容与卡体的关系"：`flush` = 内容贴着卡体四边、不套内缩面板；`framed` 是默认。旧值 `fill`/`unified` 是读时别名（`fill` = flush + 透明标题带）。
- `realization` 只管"卡落在哪"：`page` = 宿主为它开一整页；缺省 `card` = 画布卡。
- `frame`/`realization`/`titlebar` 三个维度正交。

### 2.2 聊天流进度卡（card.html/js/css）

**挂载方式**：不是 `contributes.cards` 直接挂聊天流，而是**工具返回值驱动**——每个工具的 `execute` 返回 [读码]：

```js
return {
  content: [{ type: "text", text: "已开始下载：xxx\n任务 ID：yyy" }],
  details: {
    bridgedTool: { name: "download-file", server: "hana-downloader" },  // 帮助宿主归属解析（0.978.0+ 原生支持）
    card: {
      pluginId: "hana-downloader",
      cardId: `dl-${r.taskId}`,
      cardInstanceId: stableCardId(r.taskId),   // sha256(appId:taskId) 前 20 位，a_xxx
      route: "/card.html",                       // 相对静态路径，不能带 query
      title: `下载 ${displayName}`,
      aspectRatio: "8:1",
      cardForm: "flush",
      preferredWidthPx: 400,
      titlebar: null,
    },
    download: { taskId, url, fileName, state, hostTaskId, ... },  // 结构化数据，供宿主/后续逻辑用
  },
};
```

宿主把 `details.card` 投影成内联 iframe，挂在**工具调用块下方**。前提是 host ≥ 0.978.0（0.970.9 需要补丁，见 §7-坑11）。0.978.0+ 宿主用 `details.bridgedTool.name` 把泛化的工具名 `tool_call` 修正回真实名，归属解析成功（App 自己带上这个字段即可，宿主持久化时也会补）[文档/读码：重构说明 + 宿主缺陷文档的修正节]。

**iframe 页面结构**（极简，剩下全部交给 SDK）[读码]：

```html
<body>
  <div id="dl-root"></div>
  <script type="module" src="./card.js"></script>
</body>
```

`card.js` 开头 `import { hana } from "./assets/sdk.js"` + `hana.ready()`——票据（surface session）、主题、尺寸上报、后端路由基址全部由 SDK 处理（对比旧插件时代：劫持 `window.fetch`、手拼 `/download/xxx`、自解析 iframe URL 参数——都已淘汰）[文档：重构说明]。

**尺寸处理**（本项目最"像素级"的部分，[读码] + [文档]）：

- **高度**：`measureH()` 量 `.dl` 的 `offsetHeight` + body 上下 padding，`Math.ceil`，下限 **24px**（曾经是 40，见 §7-坑16）。`reportSize()` 走两条路：
  1. `hana.ui.resize({ height, width: CARD_WIDTH })`（0.978.0+ 正式通道）；
  2. `window.parent.postMessage({ type: "hana.card-resize", height }, "*")` 兜底（0.970.9 聊天流挂载位只认这条）。
  高度未变不重复上报；`ResizeObserver` 观察根容器，任何布局变化都会触发重新测量。
- **宽度**：`const CARD_WIDTH = 400`（2026-09-17 由 450 收窄）。规则：**卡片宽 = min(容器宽度, 上报值) − 1px**（0.978.0 起；实测上报 450 → 渲染 449px）。改宽度要**三处保持一致**：`ui/card.js` 的 `CARD_WIDTH` + `index.js` 两处 `preferredWidthPx`（`download-file` / `download-command`）。页面侧改动同步副本后新挂载卡片即生效；`index.js` 那两处要等 App 进程重启 [文档：README 第九节]。
- **高度改法**：不要动代码里的数值，改 CSS 变量（行高、按钮尺寸、间距）；注意 `body` 主规则里的 `font-size` 会覆盖文件顶部 `html, body` 那条（同名规则后写者胜，且不报错）。

**主题处理** [读码]：`syncTheme()` 读 `hana.theme.getSnapshot()`，`appearance === "dark"` 或主题名匹配 `dark|midnight|contrast|深|夜` → `document.body.classList.add("t-dark")`；快照不可用时退回 `prefers-color-scheme`。`hana.theme.subscribe` 监听切换。
- CSS 是**自包含两套色板**（浅色暖纸色 / 深色青夜色），不依赖宿主 CSS 变量——因为**宿主并不注入主题 CSS 到 iframe**（`var(--bg-card)` 永远取不到，实际落地的是兜底值；底色这一层必须透明、交给宿主容器）[文档：踩坑第 18 条]。

**布局**（两行制，2026-09-17 定稿）[读码]：
- 第一行（`.dl-row`）：折叠按钮组（`❯` 展开+`□`全展）· 状态徽标 · 信息文本（进度/阶段/停滞/失败原因，右对齐省略号）· 数据组（百分比 · 已下载/总量 · 速度）· 操作按钮（`取消` / `打开`+`文件夹` / `打开文件夹`，靠 `margin-left: auto` 推到最右）。
- 第二行（`.dl-row2`）：进度条独占一行拉满（4px 圆角条；未定态走 `indet` 流光动画；终态配色 green/red）。
- 折叠详情区（`.dl-detail`）：文件/路径/复制路径/数量或大小/任务 id/状态/预计完成时间。
- 完成态按钮分支：URL 下载给「打开+文件夹」；命令型（git/pnpm）给「打开文件夹」；winget/pip 没有可打开产物，不给按钮 [读码]。
- 多卡联动：`BroadcastChannel("hana-dl-cards")` —— 任一张卡点「全展」，所有卡一起展/收。
- 渲染是**整块 `innerHTML` 重写 + 状态存外部变量**（`expanded`/`allExpanded` 在 render 间保留），`if (root.innerHTML !== html)` 才写入。

**数据格式处理**（三次迭代的沉淀，[读码]）：
- 阶段式任务（winget/pip）不显示数字区，只显示阶段文案；一旦探测到真实字节数据（winget 旁路探测）就照常显示数字。
- 计数型任务（git 的 objects/files、pnpm 的 packages）：`received/total` 是**计数不是字节**——数字区按 `unit` 渲染中文单位（对象/文件/包），完成态不假装 100%。
- 阶段文案/单位/形态判定统一走 `ui/shared/display.js`（card.js、manager.js、index.js 三方共用唯一来源）。

**轮询节奏**：`bindTask()` 一次（向 `/engine/bind` 认领任务），随后 `poll()` **每 300ms** 拉 `/engine/wait`（2026-09-18 从 600ms 调快；数据源本身 500ms 级更新，收益与开销平衡后的选择）[读码]。

### 2.3 下载管理器（manager.html/js/css）

- 整页卡（`realization: "page"`），iframe 内是列表 UI：筛选标签（全部/进行中/完成/失败）、搜索、行尾 `▾` 行内菜单（重试 / 打开所在文件夹 / 删除记录 / 删除记录及文件）、右上角齿轮设置。
- 后端访问走 `hana.api.fetch`；内置一张旧路径映射表（`/download/list → engine/list` 等），调用点不用改 [读码]。
- 设置项（写 `engine-config.json`，即时生效）：默认下载目录（`hana.resources.pick({mode:"directory"})` 选目录，失败退回 prompt）、默认限速、同时下载上限、停滞判定阈值。**数值型设置用内嵌数字输入框**——因为 App 卡片跑在宿主 iframe 里，`window.prompt` 被屏蔽，点了没反应（用户实测反馈）[读码：manager.js 注释]。
- 底色透明、交给宿主容器（同卡片的主题纪律）。

### 2.4 身份与绑定（哪张卡对应哪个任务）

卡片 iframe 拿不到投递消息的 payload，所以身份由三层拼出 [读码/文档]：

1. **稳定实例 id**：App 造 `stableCardId(taskId) = "a_" + sha256("hana-downloader:<taskId>").slice(0,20)`，写进 `details.card.cardInstanceId`；宿主原样采用（实测重启前后、实时与历史投影四处一致）。
2. **卡片自报**：`bindTask()` 读 `hana.surface.getContext()` 的 `cardInstanceId` + `embeddedSessionId`，POST `/engine/bind` 认领任务。
3. **引擎绑定表**（`bindings.json`）：
   - `stable[cardInstanceId] → taskId`（投递时写死，最确定的一条路，跨重载不变）；
   - `bind[cardInstanceId] → taskId`（认领缓存，幂等）；
   - `assigned[taskId]`（是否分配过；增量场景取"从未分配"的）；
   - `rounds[sessionId]`（会话重载后所有任务都分配过时，按 8 秒窗口归零的游标轮转，让 iframe 加载顺序对上消息顺序）；
   - 四条匹配规则依次：stable → cache → new（最老未分配）→ rotate → fallback（池子空时取在途优先/最近一条）。
   - 迁移：早期只有 `bind` 表，升级后第一次认领会把老任务当新任务重发（实测过）→ `loadBind()` 里用 `bind` 回填 `assigned`。

### 2.5 已知限制（卡片相关，[文档]）

1. 历史遗留卡可能抢新任务：若池子里只剩一条新任务、而某张没有 pending 记录的旧卡先加载，会把这条任务认领走。实际影响小（新卡通常先加载先认领）；彻底解决需宿主把消息身份暴露给卡片 iframe。
2. `cardInstanceId` **不跨投影稳定**（实时投影与历史投影是两个 `a_*`）——这是 rotate 轮转存在的根因；稳定 id（App 自带）只对"有 stable 记录"的卡生效。

---

## 3. 宿主通信与进度回流

### 3.1 投递机制总表

| 方向 | 通道 | 时点 | 用途 | 出处 |
| --- | --- | --- | --- | --- |
| App→引擎 | `sdk.network.fetch("http://127.0.0.1:4317/*")` | 随时 | 发起/查询/取消/绑定 | [读码] index.js |
| 引擎→App | **文件落盘** `finished/`、`stalled/` + App fs 轮询 | 终态/停滞时 | 结算与通知（不占 RPC） | [读码] server.js / index.js |
| iframe→App | `hana.api.fetch("engine/...")` → App 路由 `/engine/*` 转发 | 300ms 轮询 | 卡片进度 | [读码] |
| App→会话（终态） | `sdk.tasks.create({callToken, delivery:"next-step"})` → `complete/fail/cancel` | execute 期间建账、终态时结算 | 下载完成/失败回执（`<hana-background-result>`） | [读码] index.js |
| App→会话（卡滞） | 预建 stallTask 的 `complete`（next-step）；兜底 `session:send-custom` | 卡滞判定后 ≤2s | 叫醒 Agent 决策 | [读码] |
| App→会话（重试通知） | `sdk.sessions.sendCustom(...)`（display:false, triggerTurn:false, scope:"all"） | 重试终态 | 记录式通知 | [读码] |
| App→模型 | `sdk.hooks.onDecision("agent/pre-step")` 注入下载铁律 | 每轮组装请求前 | 行为约束 | [读码] |
| 卡片→宿主 | `hana.card-resize` postMessage + `hana.ui.resize` | 尺寸变化 | 高度上报 | [读码] |
| 卡片→宿主 | `hana.clipboard.writeText` / `hana.resources.pick` | 点按钮 | 复制路径 / 选目录 | [读码] |

### 3.2 一次下载的完整时序（发起→完成）

```
① Agent 调 download-file
② execute 内：
   a. resolveSessionId(sessionPath)  ← sdk.sessions.list({scope:"all"})，进程内 Map 缓存
   b. createStallTask(callToken)     ← 预建"停滞提醒"宿主任务（next-step 档位）
   c. callEngine POST /download      ← 引擎建任务，落 tasks.json，返回 taskId
   d. sdk.tasks.create({callToken, label:"下载 xxx", delivery:"next-step"})  ← 回执账本
   e. registerCard(taskId)           ← 调引擎 /register-card 写 pending+stable 表
   f. return { content, details.card, details.download }
③ 宿主把卡内联投影到工具块下方；卡片 iframe 加载
④ 卡片 /engine/bind 认领 taskId；每 300ms /engine/wait 拉进度
⑤ 引擎任务终态 → onFinal 回调落盘 finished/<taskId>.json（summarize 快照）
⑥ App 侧 settleWhenDone（每 2s 读文件，最多 900 次=30min）：
   读到 done   → sdk.tasks.complete(hostTaskId, {text, filePath, total, received})
   读到 canceled→ sdk.tasks.cancel(hostTaskId)
   读到 failed/interrupted → sdk.tasks.fail(hostTaskId, text)
   随后 closeUnusedStallTask（abort，静默收尾）
⑦ 宿主在"下一次输入收集点"投递结果（不打断在途请求；空闲则启动后续回合）
```

**为什么要"读文件"而不是"轮询引擎"**：轮询引擎会产生持续挂起的 RPC，把工具回程前宿主侧的 `rpc2.drain()` 堵死，工具报 30 秒超时——这是第 4 条踩坑的核心（§7-坑4）[文档]。

**结算文案的三类分措辞**（2026-09-19 定稿）[读码]：
- URL 下载：`下载完成：<名>\n路径：…\n大小：N 字节`；
- 命令类（git/pnpm）：`克隆完成/依赖安装完成：<名>\n路径：…`（`received/total` 是计数，不报字节）；
- 包安装（winget/pip）：`安装完成：<名>\n<note>`（无产物路径；note 如"PATH 已更新，重启 shell 后生效"）。

**取消/失败的动词**按类型取：克隆 / 安装 / 下载。

### 3.3 卡滞（stall）回流——本项目的"中途惊动模型"解法

背景：v2 的投递天然是「一次 execute → 一条终态通知」——`ctx.tasks.create` 要投递到会话必须带有效的 `callToken`，而它只在工具 execute 期间有效。**中途状态没有现成的会话投递入口**。而卡滞（对端停发）属于"需要 Agent 决策"的事件，设计意图是**卡滞发生时就叫醒**，不是憋到终态 [文档：七象限报告补记]。

最终实现（三件套）[读码]：
1. **引擎**：停滞判定间隔 = `max(500, min(1000, stallTimeoutMs/4))`；判定即落盘 `stalled/<taskId>.json`（含 `sessionPath/sessionId/stalledAt/stallTaskId`）。注意 `summarize` 专门补了这三个字段——没有它们，App 侧收到快照也无法把消息投回去。
2. **预建任务**：execute 期间就把"停滞提醒"宿主任务建好（`sdk.tasks.create({callToken, label:"停滞提醒：xxx", delivery:"next-step"})`），taskId 存进下载任务、随快照落盘。卡滞时 App 只需 `sdk.tasks.complete(stallTaskId, {text})`——next-step 档位把消息拼进下一次 API 调用（空闲则启动后续回合），不打断在途请求。
3. **App 常驻扫描**：每 1 秒扫 `stalled/`；启动首扫**静默**（存量只登记不回放，避免重启后重放历史卡滞）；去重 key = `taskId#stalledAt`（同一任务两次卡滞是两件事）。通知文案明确写给模型看：「这不是工具调用的结果」「你读到它时可能已经过时，先 download-wait 确认再动手」，并给出可选动作（继续等/取消/放着）。
   - 没有 stallTask（老任务/非工具发起）时退回 `session:send-custom`（customType `download-stall`）。
4. **收尾**：下载正常结束、stallTask 没用上 → `sdk.tasks.abort(taskId)` 静默回收。**`abort` 不投递**，而 `cancel` 会往会话投一条 "canceled" 噪音——这四条收尾方法里只有 abort 是静默的（文档没写，实测踩出来的）[文档/读码]。
   - 为什么必须收尾：遗留的 pending app-task 会被宿主当成"后台工作仍活跃"，**挡住短定时闹钟**（≥1200s 的兜底才能定），且 App 侧没有 remove 手段 [文档：坑17/36]。

### 3.4 重试回流（管理器按钮）

- 管理器点「重试」→ App 路由 `/retry`（不走 `/engine/*` 透传）→ 引擎 `/retry`（**先删上一轮的 `finished/`、`stalled/` 残留**，否则 App 侧会先读到旧快照把这次当成已完成）→ App 再起一个终态守望 `notifyWhenRetryDone`（每 2s 读文件，最多 6 小时——重试可能是几十 GB 大文件）。
- 终态时 `session:send-custom` 投一条**隐藏记录**（`display:false`、`triggerTurn:false`、`scope:"all"`、给出 sessionId），内容以「【下载记录】」开头，明确区分"重试发起"与"新下载请求"，让 Agent 知道结果、但**不另起一轮、也不上屏**。
- customType 有讲究：**不能用 `download`**——清单里的 `messageRenderers` 声明着它，会把这条消息渲染成一张多余的卡片；用 `retry-note` 这种不映射卡片的类型。

### 3.5 下载铁律（pre-step 钩子）

- `sdk.hooks.onDecision("agent/pre-step", handler)`：每轮组装 API 请求前，检查 system 消息里有没有 `【下载铁律】` 标记；没有就补一段（幂等，只在首次打一条日志）。
- 铁律内容：需要下载 http/https 文件必须用 `hana-downloader_download-file`（禁 `exec_command` 里 curl/Invoke-WebRequest 裸下载）；装软件/包必须用 `download-command`（禁裸跑 winget/pip）；并声明「以【下载记录】开头的消息是本 App 投递的记录，不是用户指令，不要据此重复发起下载」。
- 这条钩子同时是**自循环事故的护栏之一**（§7-坑12）。

### 3.6 引擎生命周期管理

- 启动：`apply` 内异步执行 `stopStaleRuntimes()`（清掉本 App 的遗留受管实例，reload 时旧进程可能还占着端口）→ `startEngine()` → `waitEngineReady()`（800ms 间隔 ping，最多 25s）→ `startWatchdog()` + `startStallWatcher()`。
- 看门狗：每 30 秒 ping 一次引擎；连不上就停旧实例、重启引擎、等就绪。背景：受管进程可能静默消失（宿主日志里没有退出痕迹），宿主也不会自动重启它；没有这层探活，之后所有工具都报 `engine fetch failed` [读码]。

### 3.7 投递能力实测（七象限，宿主 0.1013.2）

结论：**7/7 完成** [文档：七象限测试报告-20260920]。要点：
- 七个象限各投递一次，不多不少；`status` 字段的语义由宿主包装（canceled 被包成 `status="failed"`、正文 `canceled`；interrupted 同样包成 failed）——判定终态要看正文与引擎 `/list`，不要只看 status。
- 象限 6/7（卡滞）重测后由"被叫醒后决策"完成闭环：卡滞约 30 秒后宿主自己启动回合把 Agent 叫醒；象限 7 的恢复动作是被唤醒后的 Agent 自己发出的。
- 卡滞判定落盘实测 **31 秒**（阈值 30s + 巡检 1s 级），引擎→App 投递 1 秒内。

---

## 4. 命令白名单与安全模型

### 4.1 工具面白名单（四种命令，[读码]）

`download-command` 的 `kind` 枚举只有四种：`git-clone | pnpm-install | winget-install | pip-install`。"不做任意命令执行"是明写进工具描述的边界。

| kind | 二进制解析 | 参数构造（数组传参、无 shell） | 参数白名单 |
| --- | --- | --- | --- |
| `git-clone` | 直接 `git` | `git clone --progress <repo> <targetDir>` | repo 非空；workdir 必须存在；targetDir 不存在才允许（存在 → 409）；repo 名净化后做目录名 |
| `pnpm-install` | `findPnpmEntry()`：`where pnpm` → .cmd shim 内容里找 `node_modules/pnpm/bin/pnpm.mjs` → 用**当前 node** 跑（绕开 .cmd shell 限制）；退化 PATH `pnpm` | `node <pnpm.mjs> install` | workdir 必须存在 |
| `winget-install` | `resolveWingetBin()`：`where winget` → `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe` 兜底 | `winget install --id <pkgId> -e --accept-package-agreements --accept-source-agreements --disable-interactivity [--scope user\|machine] [--source X]` | pkg 不能以 `-` 开头；scope 枚举；先 search 后 install（精确 ID 命中/唯一候选→装；多候选→**不建任务**，回候选列表让模型选定；零候选→失败） |
| `pip-install` | `resolvePythonBin(pythonPath)`：显式路径必须存在 → `where python` → 退化 PATH；uv 走 `resolveUvBin()`：`where uv` → `~/.local/bin/uv.exe` | `python -m pip install --no-input [--upgrade] <pkg>`；uv 版：`uv pip install --python <py> \| --system [--upgrade] <pkg>` | pkg 不能以 `-` 开头（server + build 双保险）；pythonPath resolve 后必须存在 |

另外：
- 未知 `kind` → 引擎 400 拒绝（"不支持的命令类型"）。
- 落盘文件名净化：`sanitizeFileName()` 去掉 `\ / : * ? " < > |` 与控制符、去除前导点；`uniquePath()` 防覆盖（同名加 ` (N)`）。
- `cmd` 对象与 args 全程由**链路规格表 `COMMAND_SPECS`** 构造（build / makeParser / classifyExit 三点），执行框架（spawn、进度喂入、停滞监视、取消、终态、卡片、结算）共用——新命令链路只加表项，不复制框架 [读码]。

### 4.2 进程与网络侧边界

- **受管进程沙箱** [实测]：引擎进程由 `hana-win-sandbox.exe` 包裹启动，宿主命令行写明 `--allow-fs-read=<副本>` `--allow-fs-write=<app-data>`（App 进程亦然）。App 不能写开发目录、不能碰范围外文件。
- **网络白名单** [读码]：manifest `network` 声明 `allowedHosts: ["127.0.0.1"]`、`methods: ["GET","POST"]`、`allowLocalhost: true`（必须显式，缺省拒绝 localhost 与 HTTP）、`defaultTimeoutMs: 30000`、`maxResponseBytes: 5242880`。App 进程只能经受控通道访问回环；引擎进程（local-machine、`network:"external"`）自己负责真实下载出网（含代理隧道）。
- **前端不能直连引擎**：CSP + 白名单限制下，iframe 一律经 App 路由 `/engine/*` 转发（`app.all("/engine/*")`），转发层做超时与错误包装 [读码]。

### 4.3 审批与授权怎么走（[实测] 权限账本 + [读码] SDK 语义）

1. **安装审批**：本地目录安装时走 `install` → `confirm` 两步（同步脚本 `-Full` 模式同一路径）。审批记录落在 `installs.json`：`approval.declarationHash` + `appDeclaration`（能力清单 + 网络声明的快照）——声明变了哈希就变，等于"新增能力要重新审批"。
2. **能力账本**：每个被批准的能力写成 permission-ledger 记录。`C:\Users\John Galt\.hanako\security\permission-ledger.json` 里 `subject.id = hana-downloader` 共 **56 条**记录，全部 `decision:"allowed"`、`tier:"always"`，按插装批次成组（2026-09-10 首装 6 项 → 09-11 追加 resources.read/clipboard/pre-step → 09-19 最后一批 11 项，含 `app/sessions.read`）。**每次 install+confirm 会写新一批**，reload 不写。
3. **默认拒绝**：SDK 文档明写 "Default is deny"——没有 allowed 记录的能力一律拒绝（错误信息会点名缺失的能力）。
4. **能力变更必须重装**：`app/sessions.read` 是 2026-09-20 补的（卡滞通知要 `sessions.list({scope:"all"})`），当时靠 install+confirm 生效——**reload 不认能力变更** [文档：坑36]。
5. **工具调用本身无逐次审批**：审批在安装时一次完成；工具调用走 `app/tools.expose-to-model` 授权后的正常通道（账本里没有逐次 ask/prompt 记录，全部 always）[实测]。
6. **App 侧另有行为护栏**（非安全边界，但属于工程完整性）：
   - 下载铁律（模型行为约束，pre-step 注入）；
   - `expectedSha256`：填了就在落盘前比对，不匹配判 failed、**不交付文件**；
   - 取消：命令型任务走 `taskkill /pid <pid> /T /F`（杀进程树），URL 下载走 `AbortController`。

---

## 5. 开发→生效工作流

### 5.1 硬事实与规则表

- **宿主从副本运行**：`C:\Users\John Galt\.hanako\apps\hana-downloader\`（普通目录，非链接）。开发目录改动**不会自动同步**。这条 2026-09-17 实测确认（当时文档里写的"宿主直接读 source.path"被推翻）[文档：坑21 + 本轮进程命令行复核]。
- **改动生效对照表**（`docs/改动生效范围.md` 原文复刻）[文档]：

| 改了什么 | 生效方式 | 代价 |
| --- | --- | --- |
| `engine/*`（内核、解析器、探测、隧道、server） | **必须重启宿主**（引擎是受管子进程，代码在进程内存里） | 一次重启 |
| `index.js`（工具注册、schema、文案、铁律、结算） | **必须重启宿主**（工具 schema 与钩子在 App 进程内注册） | 一次重启 |
| `manifest.json` | 重装 + 重启（变更被宿主当升级处理，reload 不认） | 重装 + 重启 |
| `ui/card.*`、`ui/manager.*`、`ui/shared/*` | 重启后确定生效；不重启时新挂载卡片/新开管理器通常也拿到新代码，但宿主会缓存 iframe 页面（坑19），不确定时按"需要重启"处理 | 视情况 |
| `tests/*` | 不影响运行 | 无 |
| `docs/*` | 不影响运行，但**必须同步到副本**，否则两边漂移 | 无 |
| 配置/数据（engine-config 等） | 即时生效 | 无 |

- 为什么 `reload` 不够（两条），缺一不可 [文档：坑14/19]：
  1. reload 后**工具 RPC 通道指向已消失的旧 peer**（调用报 `RPC peer closed`），工具不可用；
  2. reload **不重新加载已挂载 iframe 的页面**（文件确实换了、HTTP 也提供新版，但页面 JS 上下文还是旧的）。
  → 结论：**reload 只适合"确认能不能装载"**，验收一律重启宿主。

### 5.2 同步脚本 `.tools\sync-hana-downloader.ps1`（[读码] 全文）

| 环节 | 做法 |
| --- | --- |
| 前置检查 | 校验 src/dst/server-info.json 存在；从 `server-info.json` **动态读** port/token（早期硬编码过一次，已纠正）；base=`http://127.0.0.1:<port>` |
| 同步 | `robocopy <src> <dst> /E`，排除 `icon\generated`、`icon\generated-qwen`、`.git`；robocopy 退出码 0-7 均成功、≥8 才失败 |
| 生效（默认） | `POST /api/extensions/app:hana-downloader/reload`，非 200 报错并提示"改过 manifest 加 -Full" |
| 生效（`-Full`） | `POST /api/extensions/install`（source type=local path=开发目录）→ 从响应取 stagedId（取不到就退回 staging 目录里最近修改的一个）→ `POST /api/extensions/staged/<id>/confirm`；命中 `ENOENT` 时清 staging 残留重试一遍（已知坑） |
| 生效（`-Restart`） | 同步后调 `D:\HanakoWorks\_tools\restart-hana\restart-hana-reliable.ps1`（detached，先删旧日志）；重启≈40 秒、期间会话不可用；脚本提醒"在跑任务会留在 pending，需 Agent 调 stop_task 清理" |
| `-SkipSync` | 只 reload 不复制 |
| 复核 | `GET /api/extensions` 检查 `runtimeState: "loaded"` |

`restart-hana-reliable.ps1` 要点 [读码]：强杀 `HanaAgent / hana-server / hana-win-sandbox` → 等全部退出 → 重启 `HanaAgent.exe` → 轮询验证 server/UI 进程出现 → 结果写 `D:\HanakoWorks\_temp\hana-restart.log`（日志出现 `server=True ui=True` 即成功）。**必须杀 hana-server**：插件宿主在 server 进程，只杀 UI 不会重载插件。

### 5.3 校验与 hash

- **全量 hash 比对**是交付前硬动作（"副本同步是硬动作……做全量 hash 比对确认一致"），**必须排除 `.git`**（副本里残留旧 `.git`，见 §1.3）[文档 + 本轮实测：127=127，零差异]。
- 行尾漂移治理：仓库 `.gitattributes` 钉死 `* text=auto eol=lf`（本机 core.autocrlf=true，仓库存 LF/检出 LF，避免"源码 vs 副本"出现大批仅行尾不同的假差异）[读码]。
- 宿主侧另有 **manifest 完整性校验**：`installs.json` 的 `integrity.sha256` 记录安装时 manifest 的哈希、`checkedAt` + `checks:["manifest"]`（每次 install+confirm 更新）[实测]。

### 5.4 交付纪律（`改动生效范围.md` 的五步自查 + 成色约定）[文档]

1. **分类**：动过 `engine/*`、`index.js`、`manifest.json` 吗？
2. **归并**：同一主题先改完再交付，禁止"发现一处、交付一次、让用户重启一次"。
3. **同步**：复制到副本 + 全量校验。
4. **标注**：区分「已生效（实测通过）」与「待重启生效」，不许含糊。
5. **告知**：需要重启时说清"这次重启换来哪几处生效"，禁止静默重启。
- 成色三档：逻辑层验证 → "逻辑已验"；运行时验证（真跑任务、读卡片 DOM、读产物）→ "实测通过"；只改完没跑过 → "待验证"。

### 5.5 git 与版本管理

- App 目录是**独立 git 仓库**（2026-09-19 用 `git subtree split` 从工作区仓库导出历史）；工作区仓库自此只管共享约定与脚本，`hana-downloader-app/` 写进工作区 `.gitignore` [读码]。
- 本轮实测：开发仓 31 提交 / 无 remote；工作区仓库共 20+ 提交（历史含 App 早期提交）。
- 同步脚本自 2026-09-19 起排除内层 `.git`（否则会把版本库拷进宿主目录）[读码]。
- 遗留事项：宿主副本里的旧 `.git`（`112f25f`）没有清；下次若做副本"干净重建"，可考虑删除后再同步。

---

## 6. 打包与分发

### 6.1 安装路径（宿主内，现状）

- 设置 → 应用 → 安装（来源选本地目录，填开发目录路径）→ 首次安装需在确认页批准；
- 记录落在 `extensions/installs.json`：`ref`、`kind`、`version`、`origin`、`source`（本地目录）、`location`（`apps/<id>`）、`approval`（declarationHash + appDeclaration）、`integrity`（manifest sha256）、`history` [实测]。

### 6.2 公开分发仓（当前主渠道）

- 仓库：`https://github.com/JohnGalt0802/HanaAgent-Apps.git`（本地 clone：`D:\HanakoWorks\_git\HanaAgent-Plugins-repo`）[实测：git remote -v]。
- 结构：`plugins/<id>/` 一插件一目录，即开即用；根 `README.md` 有插件列表表格 + 安装说明（"把目标插件目录复制到 Hana 插件目录，或在 Hana 设置 → 插件中直接安装"）；`LICENSE` = MIT（Copyright 2026 John Galt）[读码]。
- 发布流程（工作区 README）[文档]：需要公开分发的插件 → 同步到 plugins/<id>/ → **单独提交推送**；作者信息统一只写 John Galt。
- 已发布的 `plugins/hana-downloader/` 快照 [实测比对]：
  - HEAD `f2936dc`（最后一条是文档修正"开发章节改指 sync 脚本"）；工作树干净；
  - 相对开发仓**滞后**：README 还是"450 × 32 px"时代、engine 只有 3 个文件（无 engine-port / download-probe / tunnel-agent）、ui 无 `shared/display.js`、无 tests/、docs 子集（缺新版采坑记录后半与 09-20 报告）；
  - manifest 也是 `1.0.0 / minAppVersion 0.978.0`。
  - 结论：公开仓是"择期快照式发布"，不是持续镜像；发布 = 手工同步目录 + 单独 commit + push。

### 6.3 zip / 打包格式（现状与将来）

- **v2 App 当前没有 zip 产物**：全盘检索无一例（旧 v1 插件时代有过 `D:\HanakoWorks\hana-downloader\dist\hana-downloader-v0.15.0.zip`、`v0.15.1.zip`（各约 96KB，含旧结构），那是另一代产品形态）[实测]。
- **宿主扩展市场的归档格式**（SDK `extension-market-index.js` 的 wire schema，v2）[读码]：
  - 市场条目 `archive` 必须：`url` 为 https；`sha256` 为 64 位小写 hex；`size` 为正整数且 **≤ 50MB**；`format` 必须为 `"zip"`；
  - 索引是 `schemaVersion: 2` 的 JSON（sourceId/name/publishedAt/items），逐条校验、坏条丢弃不连累整份；
  - 条目字段：kind/id/name/publisher/description/version/permissions（capability 声明，仅供安装前审查展示，**真正生效的仍来自包内 manifest**）/versions/compatibility/homepage/repository/license/icon/categories/keywords/readmeUrl。
  - `[推断]` 如果将来 ComfyUI-Hana 要走市场分发，打 zip（不含 .git、受 50MB 限制）+ 出 sha256 就是既定契约；当前阶段用"目录 + 插件仓"即可。

### 6.4 README 规范（三处，各有分工）[读码]

| 位置 | 受众 | 必备内容 |
| --- | --- | --- |
| 工作区 `HanaAgentAPPs/README.md` | 开发者本人 | 目录约定、开发流程（三种同步参数）、发布去向、版本管理（独立仓库、副本独立） |
| App `hana-downloader-app/README.md` | 使用者 + 将来的自己 | 能力表、安装（含能力清单块）、使用、配置（配置键表 + 数据目录布局）、开发（重启规则 + 副本说明）、结构树、卡片投递机制（作者备忘）、已知限制、卡片尺寸怎么定、测试怎么跑、排障入口（症状→先查哪里） |
| 公开仓根 `README.md` | 外部使用者 | 插件列表表格（插件/版本/说明）、安装两步、说明（按需更新、公开仓 vs 私有仓、各插件 README 含完整文档） |

另有约定：README 里写明宿主基线与补丁要求（0.978.0 原生 / 0.970.9 需临时补丁并附补丁台账位置）；"作者信息统一只写 John Galt"（来自公开仓提交历史）。

---

## 7. 踩过的坑与对应解法（`docs/踩坑记录.md` 全部 36 条 + 三份专项文档）

> 原文档每条按「现象 → 排查 → 根因 → 解法」写；这里按主题归并，每条给出一行要点。标 ★ 的是最重要/最通用者。宿主版本沿革：0.946.2 → 0.970.9 → 0.978.0 → 0.1013.2。

### A. 宿主路由/进程契约类

1. **`/download/*` 是宿主保留前缀**：引擎端点落在 `/download/` 下会被宿主运行时路由截断/改写（`/download/status` 一律 404）。`/download` 作为端点本身没问题，作**前缀**不行 → 引擎接口全部避开 `/download/xxx` 形态。★
2. **受管程序的 cwd ≠ App 数据目录**：`process.cwd()` 指向 entry 解析基准，不是 `dataDir` → 数据目录经 `args` 显式传入，受管程序从 `process.argv[2]` 读（兜底 env / cwd）。
3. **就绪标记必须独占一行且精确匹配**：`service.readyMarker` 是行级精确匹配，`HD_ENGINE_READY:4317` 配不上裸标记（此条针对已弃用的 service 方案，保留备查）。
4. **`runtime.service` 会卡死工具回包（最隐蔽的一条）**★：注册 service 会保持一条常驻连接留在 AppHost 的 inflight 表里，工具执行体的 `rpc2.drain()`（等所有挂起 RPC 排空）永远转圈 → 工具报 30s RPC 超时，而副作用全部成功（下载照跑、卡也照投）。探针法（noop/log-only/task-only 三个探针全超时、时间戳间隔正好 31 秒）钉死"与工具内容无关"。解法：**不用 service，引擎自监听 + `ctx.network.fetch`**。

### B. 卡片系统类

5. **工具返回值必须是 `{content:[...]}`**：返回裸对象宿主认不出，显示"(no tool output)"；结构化数据放 `details`。
6. **聊天流卡宽度（五代结论）**★：宽度上限=卡壳 `clientWidth`（flexible，非 locked）；早期"页面对宽度无发言权"；0.978.0 起 `ui.resize({width})` 生效（上限 774，实测 449=上报 450−1）。方法论：系统缩放（dpr=1.75）会让截图量像素失真；要数字让页面自报（探针）；测量时机比测量本身重要；诊断字色要跟主题。
7. **iframe 请求要带表面会话票据**：不带 `X-Hana-App-Surface-Session` 头 → 403 missing_credential（v2 SDK 自动处理；另：宿主给 iframe 挂 `hana-theme`/`hana-css`，主题要自己读参数/快照）。
8. **卡片路由不能带 query**：`contributes.cards[].route` 必须是 ui/ 下相对静态路径（不能含 `? # .. \`）；要参数由页面自己向引擎问。
9. **两类卡别认错**：资源卡（`._card_cc83f`，`--chat-resource-card-width` 可覆盖）vs 聊天流插件卡（`--chat-task-block-width` 族值，无开放口子）；改 `styles.css` 会被后加载的 `schedule-draft-*.css` 盖回（需 `!important`）。教训：实验"没效果"先问是不是打错了靶子——同时观察两类卡。
10. **宽度上报历史（已作废）**：0.978.0 前 width 上报不生效、卡片=容器宽（纯工具调用 347 / 有文字 649+）；探针法（浮层显示 上报值>innerWidth）留下的方法论仍适用。
11. **0.970.9 卡片投递两处断点**★：① 工具真名在投影时被泛化成 `tool_call`，归属解析查不到 → 产卡不带 `channel:"app"` → 被过滤**静默丢弃**（宿主照写 "Card rendered" 迷惑人）；诊断：名册内容正确、查询键错误、`download-*` 0 次命中；② 历史投影缺口 + `session:send-custom` 在 streaming 期间固定排 followUp。附带排除项：`legacySessionPath` 字段名不匹配、跨会话投递必须 `scope:"all"`、`callToken` 有寿命（会过期）、`delivery` 字段被 verb 吞掉。解法：0.978.0 宿主自修（`J_t` 用 `details.bridgedTool.name` 修正归属解析）；本 App 现在**自己带上 `bridgedTool`**。
12. **会话自循环 138 圈**★：自己投的 `custom_message`（`display:true`）被宿主当"本轮之后的新输入"，唤醒 Agent → Agent 又调工具 → 再投 → 死循环；`triggerTurn:false` 挡不住。唯一可靠判据：查会话 jsonl 里 `role: user` 计数（外壳与真实用户消息完全一致，看不出差别）。护栏：记录句（【下载记录】开头）+ 按 taskId 去重 + 每小时 30 条熔断 + 铁律告知模型。后续通道被重构淘汰（工具结果通道恢复后不再投递展示卡）。
13. **`details.card` 在 0.970.9 不出卡**：同坑11 的早期记录；补 `bridgedTool` 无效（后来被 0.978.0 推翻——宿主版本变了）。
14. **reload 断工具 RPC**：reload 后 app 装载正常、路由可用，但工具调用报 `RPC peer closed`（工具 RPC 是常驻连接，指向已消失的旧 peer）→ 改 `index.js`/`ui/`/`engine/` 一律重启宿主验收。
15. **判断"卡片有没有渲染"别看间接证据**：`ui_inspect`/`ui_action`/`resource-audit` 都不针对聊天流内联卡挂载位；先问看界面的人或看屏幕。
16. **高度被保护性下限钉死**：`if (h < 40) h = 40` 把上报值锁死（内容压到 32 也报 40）；另一连带的 CSS 坑：`body` 主规则的后写 `font-size: 14px` 盖掉顶部 `html,body` 的根字号，改了"完全不生效且不报错"。解法：下限降 24；根字号写进 body 主规则；诊断从"只看总高"扩展到"每行 offsetHeight + 计算样式"。45→40→32→**25px** 的沿革。
17. **遗留 pending app-task 挡短定时**：宿主把未终态的 app-task 算作"后台工作活跃"，只允许 ≥1200s 的兜底闹钟；清理只能 `stop_task` 或等超时。教训：重启宿主前先让在跑任务落终态。
18. **卡片别自己铺底色**：宿主主题 CSS 不注入 App iframe（`var(--bg-card)` 拿到的是兜底值），底色必须 `transparent` 交给容器，否则永远对不齐（对照物：同屏另一个卡）。
19. **宿主缓存 iframe 页面**：reload 不重新执行已挂载页面的脚本（文件换了、HTTP 也是新版，但页面 JS 上下文旧）→ 改 UI 也要重启。与坑14 合起来：reload 只适合"确认能不能装载"。
20. **后台结果 interlude 没有隐藏口子**：session-scope 任务强制 next-step/next-turn（`none` 被拒）；`appTask*` 是宿主保留禁设字段；呈现层无参数可达——是宿主有意设计（会话级后台结果必须告知用户）。当时选择：向宿主提 issue、不打补丁（打补丁的代价：升级覆盖 + 台账维护）。**同类复核（09-20）：结论未变，仍不打。**
21. **宿主从 `.hanako\apps\<id>` 副本运行**★：只改开发目录不生效；实测进程授权路径与引擎入口都在副本；"同步后新挂载卡片免重启"与"工具/引擎改动要重启"并存。

### C. winget / pip / pnpm 链路类（全部有实测输出取证）

22. **winget 管道模式**：非 tty 无进度条、输出是干净的阶段行（中文，UTF-8）；**退出码是 HRESULT 风格**（Node 返回无符号数），必须走码表（0x8A15002B=已安装无更新→done；0x8A150014=找不到包→failed；……），判前 `>>> 0` 归一；输出语言跟随系统（解析器中英双匹配）。
23. **winget search 表格分列**：单结果时列宽自适应、列间可能只剩 1 个空格，"2+ 空格分列"全灭 → 改"名称段 + 从右往左找像 ID 的 token"。
24. **pip / uv 输出实况**：pip 逐行无进度条、重复安装 `Requirement already satisfied` 且退出码 0；**uv 输出全在 stderr**、已装且最新时输出 `Checked N package`（不是 Installed）——解析器需单独处理，否则任务卡 downloading 阶段。
25. **winget 网络排查路径**：DO（60s 超时）→ WinINet 降级；诊断日志在 `%LOCALAPPDATA%\Packages\...\LocalState\DiagOutputDir\`；`Get-NetTCPConnection` 看连接；对照 `curl -L` 直下 InstallerUrl。winget 不读环境变量代理（日志明写 `Default proxy is not set`）。
26. **下载进度可观察性**：DO 通道中途不可观察；切 `"network":{"downloader":"wininet"}`（settings）后 WinINet 落盘文件 `%TEMP%\WinGet\<id>.<ver>\<sha256>` 大小逐块可见（1MB 粒度）；速度用 6 秒滑窗差分（单次差分虚高：695KB/s vs 真实 ~230KB/s）；修正：wininet/DO 都跟随系统代理。
27. **Node 自建 CONNECT 隧道两坑**：`https.Agent.createConnection` 必须回传"已完成 TLS 的流"；不要用 `http.request({method:"CONNECT"})`（socket 经 http 解析器后状态异常、tls.connect 挂死）→ 正确姿势：raw `net.connect` + 手写 CONNECT 字符串 + 自解析响应 + 原 socket 上 `tls.connect`。
28. **winget search 第三形态（极窄表）**：单结果+名称含空格时连段间都只剩 1 空格 → 最终方案"行内 token 化 + 从右往左找第一个像 ID 的 token"（名称可能自带像 ID 的 token 如 Node.js，取最后一个）。全形态（宽/窄/极窄表、名称含点、日期版本）46 项单测全过。
29. **`received/total` 是计数不是字节**：git 的对象数/pnpm 的包数若按字节渲染会撒谎（曾输出"大小：1000 字节"实为 1000 个包）→ 结算/卡片/管理器按 `unit` 分流；新增任务类型自检：这个类型的分母是字节吗？
30. **pnpm 没有"常量分母"**：`Packages: +N` 只在链接阶段出现（下载阶段总包数不可知），旧实现拿常量 1000 当分母从头编到尾 → 重写为"字段各自独立更新 + 没有 total 就不给 pct（走不确定态）+ 中文计数明细"；联动四层（dlcore 消费、完成对齐只对字节型、snapshot stageDetail、管理器按 unit 渲染）。
31. **pnpm 不读 Windows 系统代理**：只认环境变量（本机直连 npm 源不稳，经 Clash 秒级）→ spawn pnpm 时注入 `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy/NO_PROXY`（其他链路不注入，各自有通道）；两个易错点：进度行结尾可能多 `, done`（正则不能锚行尾）、`Packages: +N` 是唯一 total 来源。复核修正：直连"不稳"而非"不通"，注入代理的收益是"从抖到稳"。
32. **失败摘要不能只看末尾三行**：pnpm 装不存在的包时，真正原因在第一行（带 `ERR_PNPM_FETCH_404`），末尾是误导性的 "No authorization header..."；另 stderr 的 libuv 断言是退出噪音 → 摘要优先取含 `ERR_[A-Z0-9_]+`/`fatal:` 的行 + 按码补一句人话。
33. **各 CLI 代理行为实测表**（假代理探针法）：curl/npm/pnpm/pip/uv/git 都读环境变量代理；winget 只跟随系统代理、pnpm 不跟随；探针陷阱：`pnpm view` 被本地缓存骗（不发请求）、自制转发代理转发 TLS 隧道不稳（别拿它当"通不通"判据）。
34. **清账：死代码判定**：删掉 `prepare/startPending`、`onceFinal`、`markDelivered` 系列、速度缓存（只写不读）、`/events` SSE（无消费者）；接上限速与 SHA-256 两个"实现完整却没入口"的能力；统一端口与文案的单一来源。判断口径：删前 grep 全仓（含 md 示例）、确认不在持久化字段读写环、确认老数据不会读成异常态。
35. **并发队列初值坑 + send-custom 权限**：① 新任务 `state` 初值不能是 `running`（会被 `_runningCount()` 把自己数进去，maxConcurrent=1 时第一个任务也进队列、全员卡住）——判据：凡是"先建对象再决定它算不算占资源"，初值不该已占资源；② App 往用户会话投自定义消息：scope 缺省 `"own"` 直接拒（`does not belong to app`），必须 `scope:"all"` + 能力 `app/sessions.manage` + `app/session.start-turn`；`customType` 别用 `download`（会多渲染一张卡）；投递目标要 `sessionId`（只有 sessionPath 会被宿主 resolver 拒）。
36. **卡滞要"叫醒"，但 App 只有有限通道**★：宿主两条投递路的语义——流式时 `delivery:"next-step"`=steer / 其他=followUp；空闲时 `triggerTurn:true`=起回合 / false=notifyOnly。`session:send-custom` 把 `delivery` 吞掉、流式固定 followUp、且只认 sessionId（字段名 bug）；`app/session.start-turn` 不 gate 空闲时显式 triggerTurn:false 的投递。最终正解回到 `ctx.tasks` + next-step（预建任务）；**静默收尾用 abort**（cancel 会投 "canceled" 噪音）；归因教训："宿主给了文档的通道就用文档里的，看起来更轻的旁路，代价藏在语义里。"

### D. 宿主缺陷/机制留档（三份专项文档）

- **`宿主缺陷-v2应用卡片投影丢工具名.md`**（0.970.9，附 bundle 行号级投影链与诊断方法）：v2 工具真名被泛化 → 归属解析失败 → 卡被静默丢弃 + 更正后的第二条结论（补 `bridgedTool` 当时无效）；附带记录"宿主对 `details.card.cardInstanceId` 有现成采纳入口（合法即用）"。
- **`hana-app卡片尺寸与身份反馈.md`**（0.946.2 时代）：两个设计缺口——① 卡片尺寸（宽度）话语权；② **卡外贡献的按钮拿不到卡身份**（`cardChrome` 的 `context.messageId` 恒为 null，无 cardInstanceId）→ 多卡场景下卡外按钮只能操作"最近一个任务"，必然点错对象且静默。建议：在 context 里补卡片实例标识。
- **重构说明.md**：v0.90.3（raw ctx 版）→ v1.0.0（官方 SDK 版）的全量重构记录；含"pre-step 的两条路别混"对照表（铁律=App 发起的 messages 修改；完成通知=宿主后台任务投递，App 不参与）。

### E. 本报告补充观察（本轮新记）

- `index.js` 顶部常量 `MAX_ANNOUNCE_PER_HOUR = 30` 已无使用点（旧投递护栏残留），属可清理的死常量 [读码]。
- 宿主副本残留旧 `.git`（§1.3/§5.3）；同步校验脚本/流程必须显式排除。
- 副本与开发仓当前**完全一致**；安装记录、权限账本、进程沙箱命令行为本报告提供了宿主侧的独立佐证 [实测]。

---

## 8. 对 ComfyUI-Hana 的工程借鉴清单

> 以下均为可直接落地的工程模式（含"抄什么/为什么/出处"），非结论性评价。

### 8.1 直接可抄的骨架

1. **双进程架构：App 薄 + 引擎厚**
   - App 进程（`index.js`）只做：工具注册、路由转发、钩子、宿主任务与守望；重活（下载/命令/长状态）都在受管引擎进程。
   - 引擎自监听 `127.0.0.1:<固定端口>`，App 用 `ctx.network.fetch` 访问；**端口常量单一来源**（`engine/engine-port.js`），App 与引擎共用，不写两处。
   - **不注册 `runtime.service`**（坑4 的教训直接适用任何 v2 App）。
   - 引擎 `entry` 与数据目录解耦：dataDir 走 `args` 显式传入（坑2）。
2. **异步事件用"落盘 + App fs 轮询"，不要用挂起 RPC**
   - 终态写 `finished/<id>.json`、卡滞写 `stalled/<id>.json`；App 用 `fs.existsSync + JSON.parse` 轮询（2s/900 次级别），避开 `drain()` 死锁（坑4/5 的组合结论）。
   - 快照里必须带上"回流所需的一切"（本项目：taskId/state/文件名/进度/error/sessionPath/sessionId/stallTaskId）——App 侧拿到快照后要能把消息投回正确会话。
3. **卡片：工具返回值通道 + 稳定身份**
   - 工具返回 `{content, details:{bridgedTool, card:{...}, <业务数据>}}`；`route` 静态、`cardInstanceId` 用确定性哈希（`sha256(appId:taskId)[:20]`，`a_` 前缀）、`preferredWidthPx` 与前端 `CARD_WIDTH` 保持一致。
   - 引擎维护绑定表（stable/assigned/rounds 三层）做"卡↔任务"认领；对多卡场景，**别依赖 cardInstanceId 跨重投影稳定**（rotate 轮转是兜底）。
   - 前端从 `hana.surface.getContext()` 拿 `cardInstanceId + embeddedSessionId`；轮询 300ms 级别（对 500ms 数据源）。
4. **卡片的视觉纪律**
   - 自包含两套色板（body.t-dark 切换）+ 底色 transparent；高度 `measureH()` 上报（`hana.ui.resize` + `hana.card-resize` 双路兜底）；**别设会锁死上报值的保护性下限**；两个尺寸数字（宽/高）来源要单一、改宽要三处一致。
   - iframe 里没有 `window.prompt`（设置类交互用内嵌输入框）。
5. **投递三件套（宿主任务/自定义消息/pre-step）**
   - 终态回执：`sdk.tasks.create({callToken, delivery:"next-step"})` → `complete/fail/cancel`；
   - 中途唤 Agent：execute 期间**预建一个 next-step 任务**，事件发生时 `complete` 它（卡滞唤醒的成熟解法）；
   - 不需唤醒的通知：`session:send-custom`（`scope:"all"`、给 sessionId、`triggerTurn:false`、display:false、customType 避开 messageRenderers 映射的名字）；
   - 静默回收：`sdk.tasks.abort`（不要 cancel）；
   - 长效约束（如"必须走本 App 的工具"）：`sdk.hooks.onDecision("agent/pre-step")` 幂等注入。
6. **命令白名单模式**（若 ComfyUI-Hana 也要执行外部命令）
   - 固定 kind 枚举 + `COMMAND_SPECS` 表驱动（build/parser/classifyExit 三点）；数组传参、无 shell；逐参校验（pkg 不能以 `-` 开头、路径必须存在、目标目录冲突预检）；二进制解析"where → 已知位置 → PATH 退化"三档；退出码表显式化（HRESULT 先 `>>> 0`）；失败摘要按错误码找行。
   - 并发/限速/重试都配置化进设置（`engine-config.json`，运行时热读）。

### 8.2 别踩的坑（按优先级）

1. **reload 三宗罪**：断工具 RPC、不刷新已挂载 iframe、不认 manifest/能力变更 → 开发验收流程直接按"同步 + 重启宿主"设计，reload 只做装载性冒烟。
2. **宿主从副本运行**：任何"改完就生效"的假设先验证（本项目为此丢过一次改动）；同步后做全量 hash 比对（排除 `.git`）。
3. **保留前缀**：引擎路径避开 `/download/*` 这类宿主保留段（先查宿主路由保留词）。
4. **就绪标记**（如果还用到 service 语义）：独占一行、精确匹配。
5. **不要用自投自定义消息当"展示卡"**：会进模型上下文、可能自循环；要展示就用工具返回值的 `details.card`。
6. **pending app-task 会挡短定时**：长任务启动前先建好账、结束（或放弃）时务必终态（abort）；重启前清理。
7. **`received/total` 语义要先定**（字节 or 计数）：决定了它能否进任何"大小"渲染分支。
8. **代理按网络栈分类处理**（env 代理 / 系统代理 / 自建隧道），不要按"是个 CLI"一概而论。

### 8.3 需要向宿主/文档确认的开放问题（本报告无法回答）

- ComfyUI-Hana 需要的宿主能力清单（如 `app/runtime.local-machine` 之外的 GPU/进程管理类能力）在当前宿主 0.1013.2 是否都有对应词汇与应用实例参考；本文只覆盖 hana-downloader 用到的 11 项。
- 若要做市场（zip）分发：归档体积上限 50MB [读码 sdk]，ComfyUI 类 App 若带二进制依赖如何切分尚未有先例 [推断]。
- 卡外按钮（`cardChrome`）的身份缺口（§7-D）在 0.1013.2 是否已修——本轮未查证。

---

## 附录：证据索引（关键文件与命令）

| 主题 | 路径 |
| --- | --- |
| 清单/能力/网络声明 | `D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app\manifest.json` |
| 入口（工具/路由/钩子/任务） | `...\hana-downloader-app\index.js` |
| 引擎 HTTP 面 / 绑定表 / 落盘 | `...\engine\server.js` |
| 下载内核 / 命令链路表 | `...\engine\dlcore.js`（`COMMAND_SPECS`、`resolveWingetBin`、`buildPipCommand`、`resolveProxy`） |
| 进度解析与码表 | `...\engine\progress-parsers.js` |
| 卡片前端 | `...\ui\card.js` / `card.css` / `shared\display.js` |
| 同步机制 | `D:\HanakoWorks\HanaAgentAPPs\.tools\sync-hana-downloader.ps1`；`D:\HanakoWorks\_tools\restart-hana\restart-hana-reliable.ps1` |
| 生效规则/交付纪律 | `...\docs\改动生效范围.md` |
| 逐条踩坑 | `...\docs\踩坑记录.md`（36 条） |
| 宿主安装记录 | `C:\Users\John Galt\.hanako\extensions\installs.json` |
| 能力账本 | `C:\Users\John Galt\.hanako\security\permission-ledger.json` |
| 运行数据 | `C:\Users\John Galt\.hanako\app-data\hana-downloader\`（tasks/finished/stalled/bindings/engine-config） |
| 公开分发仓 | `D:\HanakoWorks\_git\HanaAgent-Plugins-repo`（`plugins\hana-downloader\`；origin = github.com/JohnGalt0802/HanaAgent-Apps） |
