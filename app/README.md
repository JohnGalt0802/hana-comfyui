# Hana-ComfyUI（v2 App，开发仓）· v0.25.4

把本机 ComfyUI（服务在 `127.0.0.1:8188`）接进 HanaAgent 的 v2 App。
**开发仓**：本目录（`app/`）；**宿主副本**：`<HANA_HOME>/apps/comfyui-hana/`（由 `../tools/sync-to-host.ps1` 同步）。

面向用户的说明见市场 readme 口径（`docs/market/`）；本文件是**开发者视角**：结构在哪、契约是什么、哪些边界不能碰。

## 一、运行结构（三段，各有硬约束）

| 段 | 是什么 | 不能做什么 |
|---|---|---|
| **App 进程**（`index.js`） | 工具面、路由、设置页后端、模型调用执行端 | 宿主 AppHost 子进程**不开 `--allow-net`**，不能监听端口；App 总线白名单只有 `model:list`，`model:stream` 出不去 |
| **中继 runtime**（`runtime/comfy-relay.mjs`，受管 runtime） | 后端代理、文件与提交、画布桥转发、LLM 网关监听、模板索引 | 拿不到宿主模型凭据，不能直接调模型 |
| **ComfyUI 桥**（`bridge/`，装到 `custom_nodes/hana_bridge`） | 画布读写、提交历史与提交树、界面注入 | 不能改 ComfyUI 源码与前端打包产物（零改动铁律） |

三段的边界不是偏好，是宿主契约：想监听端口的只能放中继，想调模型的只能放 App。LLM 网关就是这条约束的产物。

## 二、工具面（`comfyui`，15 个 action）

`status` · `submit` · `query` · `result` · `cancel` · `workflows` · `upload` · `service` · `update` · `canvas` · `window` · `llmGateway` · `validate` · `templates` · `deps`

常用子操作：

- `service` → `op=status|start|stop|envcheck|clear|wait`
- `update` → `op=check|apply|status`
- `window` → `op=open|close|status`（宿主原生窗装载工作区）
- `llmGateway` → `op=start|stop|status`
- `templates` → `op=list|fetch`
- `canvas` → 读向 `state|summary|get|prompt|check|trace|outline|diff|running|progress|revision|events|pages|commands|commandShape`；写向 `patch|setWidget|addNode|removeNode|connect|disconnect|setNodeMode|undo`；执行与共驾 `queue|duplicate|visual|copilot|organize|loadWorkflowFile|openWorkflow|historyDiff`

能力声明（manifest，9 项）：`app/runtime.execute`、`app/runtime.local-machine`、`app/runtime.network`、`app/resources.read`、`app/models.infer`、`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`、`app/windows.manage`。

## 三、工作流转换（`lib/workflow-tools.mjs`，app 与中继同源）

UI 工作流 → API 提交形态的转换器，是这套东西最容易"转换成功但产物错"的地方，因此**宁可拒绝也不猜**。

- **子图展开**（`expandSubgraphs`）：实例 id `s<实例id>:<内部id>`，link `s<实例id>L<原id>`，接口槽走 `-10/-20` 直连。实例槽与定义输入的**按名字对位**（下标对位会在多形态样本上静默错参数，已废弃）。输入槽扇出（一个槽喂多个内部消费端）支持；**嵌套子图不支持**。
- **静音 / 旁路按 ComfyUI 语义**：mute 断链、bypass 走「同名 → 唯一同类型 → 歧义拒绝」穿透。
- **pull 规则引擎**：Set/Get 按名字配对成虚拟节点；配对 Set 静音/旁路视为无值；`keyPath` 支持数组回退；同名多候选整份拒绝。
- **取值按声明序**（`declaredWidgetSlots`）：节点只有部分参数带输入槽时，按声明序而不是槽序取值——按槽序会把参数写进错误槽且不报错（历史 bug，错位 902 处已清零）。
- **`widgets_values`**：数量与对位表相等时按位置对位；**0 项**时回退子图默认值并给 warning；数量不符仍拒绝。
- **适配档案**（`lib/node-adapters/`，18 份）：rgthree 系 12 份纯前端 `virtual:true`，Reroute 走 passthrough（输入槽 `*` 通配穿透）。档案语言可表达 `virtual` / `passthrough` / `bypass` / `slots` / `pull`；`PrimitiveNode` 这类"把常量写进下游 widget"的语义**现有语言表达不了**，少数模板因此如实拒绝。
- **拒绝归因**：按类别汇总并给建议（`value_mismatch` 单独成类），`tools/scan-reject-reasons.mjs` 可批量扫描；`opts.problemsOut` 取结构化结果。
- **量化基线**：668 份官方模板，可转换 **568（85%）**；改前 460（69%）。全量回归要求「原本能成功的不得新增失败」。

## 四、提交前校验 / 模板库 / 缺包诊断（v0.24 新增）

- **`validate`**：中继 `/_relay/validate` → 裁剪后的 `/object_info`（原始 4.33 MB → 0.97 MB，schema v2 带 `output_node`；24h TTL，`custom_nodes` 目录 mtime 判失效）。返回结构化 issue，正文带**错误码**、节点 id、字段名与合法可选项，首行按 code 分组。只报警不阻提交；`no_output`（有节点无输出节点）判 error。
- **`templates`**：索引来自上游 GitHub raw（24h 缓存，`refresh=true` 是**后台刷新不阻塞**，本次仍返回当前缓存）；`fetch` 落到 `<ComfyUI>/user/default/hui-templates/<分类>/`，**不在工作流目录内**，不替你下模型。上游索引把视频模板的 `mediaType` 标成 `image`，按视频过滤会得 0 条，用关键词搜。
- **`deps`**：类名 → 候选插件包，三态（没装 / 装了没加载 / 查不到来源）；同名多候选会标「另有已装候选」。

## 五、画布共驾与执行

- 链路：`comfyui(action="canvas")` → 路由 `canvas` → 中继 `/_relay/bridge` → ComfyUI `POST /api/hana_bridge/call` → `send_sync` 经 `/ws` → 前端扩展 → 同源回传。`/call` 校验 `X-Hana-Token`，无 token 403。
- 多页面按工作流名定向，死条目 TTL 15min，全过期明确报 `no_live_page`。
- 写向默认关闭，需设置页打开「允许 agent 修改画布」；撤销是**逆操作栈**（只回退 agent 那一步，不动人的改动）。新版前端撤销栈不记录外部改图，人按 Ctrl+Z 撤不掉 agent 的改动。
- **执行纪律（v0.20 定稿，两分支）**：
  - 副驾驶**开** → 在当前画布就地执行；执行前把当前画布落盘（未保存的画布先另存 `(AgentSaved)`，再**在该文件上重开驾驶位**，否则桥报 `copilot_off`）。
  - 副驾驶**关** → 复制副本执行（副本开副驾驶），原画布零改动。
  - 判定读 `canvas.pages` 的活动页账本（`state` 缓存降级，桥 `copilot_off` 为最终权威）；总闸「允许 Agent 开启画布副驾驶」**只约束副本路径**。
  - 落点断言按分支：副本比页名，同页比「页面身份未变 + 内容已装载」。回执带 `canvasPath` / `preSave` / `copilotSource` / `landingCheck` / `pageIdentityCheck`。

## 六、服务、更新与 LLM 网关

- **服务起停（双闸）**：启动窗口内（150s）停止请求返回 `starting-grace`（用户点按钮可强制穿过）；只终止**确认属于 ComfyUI** 的进程，否则 `foreign-listener` 拒绝；停止内部的探测**静默**，不翻转全局状态（旧行为曾让人误判"中继杀了后端"）；日志带 `src` 与 `force`。启动走计划任务 `HanaComfyUI-Backend`，独立于 Hana 存活。
- **本体更新**：`git fetch` + `git pull --ff-only` + `pip install`，只用 ff-only，本地有改动明确失败，不擅自 merge/reset。
- **更新检查的脏判定**：`git status` 分三类——运行时目录变动算 `noise`、未跟踪文件算 `untracked`（不阻塞 ff 拉取）、只有真改源码算 `dirty`。星标只看「落后远端」，dirty 只影响提示语。解析 `git status` 用正则容忍前导空格（`runExe` 会 trim 掉首行空格，固定偏移切路径会错位）。
- **LLM 网关**：中继在 `127.0.0.1:8790` 开 OpenAI 兼容端点（`/v1/models`、`/v1/chat/completions`，支持流式），Bearer token 鉴权；App `llmGateway` worker 经 `sdk.runtime.fetch` 长轮询取 job，用 `ctx.models.stream` 执行并回填增量。模型调用必须挂**持久 task 身份**，否则 stop/start 后报 `App invocation expired`。`hana/default`、`hana/vision` 是别名，跟设置页选择走；设置页可多选模型并同步进 ComfyUI-Prompt-Assistant 的服务配置。

## 七、桥与提交历史

- **提交历史**：主键是画布身份 id（改名/移动不丢）；横轴刻度形态（外框色=谁提交、线型=操作、内条堆=碰过的分区、宽块=合并、金点=HEAD）；**提交树**为横向泳道 + 拓扑连线（不交叉、跨泳道固定过渡段）；预览图降分辨率 + 磁盘缓存（`bridge/thumbs.py`）。
- **构建标识三处同源**：js 文件名（`ddHHmmss`）＝ js `BUILD_TAG` ＝ py `BRIDGE_BUILD_TAG`。改动桥 JS 必须换名（浏览器对同一 URL 顽固缓存），用 `tools/bridge-reload.ps1` 或手动改名 + `tools/deploy-bridge.ps1`。
- **主题跟随（v0.25.4 修）**：ComfyUI 前端 1.58.5 起**不再给 `<html>` 加 `dark-theme` 类**，改为往 `documentElement.style` 写内联 `color-scheme`。桥的深色覆盖用共享选择器 `HANA_DARK_SEL`（`dark-theme` / `scheme-dark` / `data-hana-dark` 三路），并由 `hanaSyncDarkFlag()` 读计算出的 `color-scheme` 自行打标记，MutationObserver + matchMedia + 设置订阅驱动。**中性色跟主题，语义色不跟**（谁提交=蓝/紫、HEAD 金点、分区框色是事实）。
- 部署：`tools/deploy-bridge.ps1`（清 js\ 重建、只放活动文件，防双载）；改 `__init__.py` 需重启 ComfyUI，改 JS 只需刷新页面。

## 八、关键口径

- **clientId 配对**：ComfyUI 只把执行事件发给提交方 `client_id` 的 WS 连接；中继订阅与提交共用「每次启动随机」的 clientId（`comfyui-hana-relay-<hex>`），不要复用固定 id。
- **产物定位**：ComfyUI 安装根的 `output/...`（安装根由中继环境探测识别，不硬编码）；预览走代理 `view?`。
- **转换边界**（替代旧版"子图/静音/旁路一律报错"的说法）：子图、扇出、静音、旁路、Reroute 已支持；**不支持**嵌套子图、子图内跨层 Set/Get、`PrimitiveNode` 少数形态、未安装插件的未知节点类型（后者给候选包）。
- **投递诊断**：`ctx.tasks.getDelivery`（`query` 已暴露）；宿主被卡记录在 `%HANA_HOME%\.ephemeral\deferred-tasks.json`。
- **零改动铁律**：不碰 ComfyUI 源码与前端打包产物；一切经 `custom_nodes` 桥与 App 机制。

## 九、本地开发与验证

```powershell
# 静态校验（先 staging 到目录名 = id；脚本在项目根 tools\ 下）
pwsh -NoProfile -File ..\tools\validate-app.ps1

# 单测（app\lib 全部内核，当前 289 项）
node --test lib/*.test.mjs

# 转换器专项
node ..\tools\scan-reject-reasons.mjs          # 批量拒绝归因
node ..\tools\m13-checks\test-submit-file.mjs   # 大工作流中继级提交

# 桥：语法（必须 .mjs 口径，它是 ESM）、部署、重载
node ..\tools\check-bridge-syntax.mjs
pwsh -NoProfile -File ..\tools\deploy-bridge.ps1
pwsh -NoProfile -File ..\tools\bridge-reload.ps1 -NoRestart

# 同步到宿主副本（-DryRun 预览）
pwsh -NoProfile -File ..\tools\sync-to-host.ps1 -DryRun
```

**语法校验必须用 `.mjs` 口径**：桥 JS 由 `<script type="module">` 加载，`node --check xxx.js` 会按 CJS 解析，能过不代表浏览器能加载（历史上因此把整个扩展搞挂过一次）。

## 十、纪律

- 不在用户队列非空时提交测试任务；测试工作流一律极小（纯 CPU）。
- 宿主安装/重启由主脑统一安排；App 级 reload 可自行执行。改 `manifest.json` 后 reload 即可认到新版本，无需重装；`apps/comfyui-hana` 目录被占用时 `install+confirm` 会报 `EPERM`。
- 改 App 前先写方案到 `docs/<主题>-<YYYYMMDD>.md`；交付区分「已生效（实测）」与「待重启」；涉及用户环境的改动先取得同意并登记侵入面。

## 十一、版本线（摘要）

| 版本 | 要点 |
|---|---|
| v0.9–v0.13 | 画布共驾与语义层、大工作流中继直提、提交历史与提交树 |
| v0.18 | pull 规则引擎（Set/Get 配对）+ 适配档案 |
| v0.19 | 子图展开、静音/旁路语义化、拒绝归因 |
| v0.20 | 画布执行两分支（副驾驶同页 / 副本） |
| v0.21–v0.23 | LLM 网关（节点 API 指向 Hana）+ 设置页模型多选 |
| v0.24 | 提交前校验、官方模板库、缺包诊断 |
| v0.25.0 | 子图扇出、`widgets_values` 零值、声明序取值、Reroute 通配、停服务双闸 |
| v0.25.3–.4 | 更新检查脏判定、桥界面主题跟随 |
