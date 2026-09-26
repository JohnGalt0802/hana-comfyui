# Hana-ComfyUI（v2 App，开发仓）· v0.8

把本机 ComfyUI（服务在 `127.0.0.1:8188`）接进 HanaAgent 的 v2 App。
**开发仓**：本目录（`app/`）；**宿主副本**：`<HANA_HOME>/apps/comfyui-hana/`（由 `../tools/sync-to-host.ps1` 同步）。

## 状态（M0–M2 完成，M2.5/M2.6 收尾）

- 工具 `comfyui` 全动作：status / submit / query / result / cancel / workflows / upload / service
- 任务桥：submit → `ctx.tasks.create({callToken, delivery:"next-step"})` → 2s 轮询结算（complete/fail/cancel）
  - 能力已扩容（2026-09-21 批准并生效）：`app/tasks.manage` + `app/session.start-turn`（ledger=always）
  - **子代理会话边界**：宿主可靠投递只写桌面会话；从子代理会话发起的任务不会自动回执（工具文案会如实标注；`query` 的「投递」行可查 `published/delivered`）
- 任务卡：`ui/task.html`（轮询 `GET /comfyui-hana/task?id=`；缩略图经 `_surface` 凭据路径）
- 中继 v0.3：订阅 8188 `/ws` 进度事件缓存（`/_relay/prompts`）、历史摘要（`/_relay/history`）、
  `/_relay/fs/{stat,read}` + `/_relay/upload`（controlKey 保护）、日志落盘（`app-data/comfyui-hana/logs/relay.log`，>5MiB 滚动 `.1`）
- 环境自举（v0.3 新增）：后端不可达时中继附「本机安装探测」（`/_relay/status` 的 `env` 字段；或 `node runtime/comfy-relay.mjs --probe-env` 直看）；
  壳页按「装了没跑 / 未检测到」分流引导（复制引导语→交给 Hana）；安装手册 `skills/comfyui-hana/INSTALL.md`
- 状态面板（v0.4 新增）：整页工作区左侧栏（functionPanel）带 GPU/CPU/内存实时图表（任务管理器风格曲线）
  与「释放显存」按钮（`POST /comfyui-hana/release` → 中继反代后端 `/free`）；指标经中继 `/_relay/metrics`
  （nvidia-smi 4s 缓存 + os 模块 CPU/内存采样；零新增能力）
- 安装引导（v0.5 新增）：检测到「未装 ComfyUI」时弹窗——选安装位置（中继盘位探测给候选 + 剩余空间 + 推荐）/ 自定义目录（宿主目录选择器，写回配置）；
  两个动作：直接发起安装（`session:create` + `session:send` 在默认工作区建会话投递提示词）/ 复制安装指令；
  路由 `install-targets|install-target|install-prompt|install-launch`；中继新增 `/_relay/drives`、`/_relay/custom-roots`；
  能力新增 `app/resources.read`（目录选择器用）
- 服务起停（v0.6 新增，M9）：左侧面板「启动服务 / 停止服务」+ 工具 `comfyui(action="service", op=status|start|stop)`；
  启动经 Windows 计划任务（`HanaComfyUI-Backend`）以当前用户身份拉起——中继自身跑在宿主沙箱 job 里，直接 spawn 的子进程
  会随中继退出被回收（detached 也逃不出），走计划任务才**独立于 Hana 存活**；撤下走 `taskkill /T /F`（受限令牌实测可终止）；
  中继新增 `/_relay/backend/{start,stop,proc}`，App 新增路由 `backend/start|stop|backend`；服务日志 `app-data/comfyui-hana/logs/backend.log`；
  同时把面板原「重试启动」正名为「重启中继」（它只重启受管 runtime，与 ComfyUI 服务本体是两件事）
- 工作区直连 + 服务控制 + 安装目录（v0.7 新增，M10）：
  - **工作区 iframe 直连 `127.0.0.1:8188`**（auto/direct 默认；manifest 新增 `ui.csp.frameDomains` 放行）。
    原因：自定义节点的扩展脚本习惯用**绝对路径**（`/extensions/<node>/*.js`、`/scripts/app.js`、`/scripts/ui.js`），
    走宿主代理路径时这些请求会绕过 App 前缀、打到宿主根（不是本 App 路由）被 **403**；直连后 ComfyUI 站在自己的根上，
    官方前端与自定义节点全部可用（后端实测：这些路径在 8188 上均 200，且无 `X-Frame-Options`，可被 iframe 嵌入）。
    代价：iframe 跨源 → 壳页摸不到 `contentWindow`。主题改为**改道**：订阅宿主主题钩子
    `hana.theme.subscribe`（回调直给快照）→ `POST /comfyui-hana/theme` → 中继把宿主主题写成
    ComfyUI 的**自定义色板**（`Comfy.CustomColorPalettes.hana`，键名与 `HANA_CSS_MAP`/`HANA_JS_MAP` 同源）
    并选中（`Comfy.ColorPalette = "hana"`）→ **自动重载 ComfyUI 那层 iframe**（加 `_hana_t` 时间戳强制；
    同 src 浏览器不会重载），前端起来即带宿主配色（面板 + 画布/节点/连线），无需手动刷新。
    另有两道兜底：轮询（每 2.5s 重拉宿主主题 CSS 比对色值签名）、iframe 首帧加载前预推送。
    路由 `theme`（GET 查 / POST 写）→ 中继 `/_relay/theme`。
    踩坑：① `POST /settings` 成功是 **200 空 body**，不能按 JSON 解析（`docs/踩坑记录.md` 第 4 条）；
    ② 它是 `{**settings, **new_settings}` **合并写**，实测不动用户其他设置；
    ③ 色板 schema 实测接受 `colors:{comfy_base,litegraph_base,node_slot}`，键名与内置色板一致。
    「连接方式」下拉保留原 `hana.api.url` / 直接相对路径两种代理方式，可随时切回。
  - **服务控制提到工作区顶栏**：服务运行中时顶栏常驻「停止服务 / 重启中继」，与左侧状态面板互为入口（此前工作区内只能启动、不能关闭）。
  - **设置页可自定义 ComfyUI 安装目录**（`ui/settings.html`，v0 只读骨架重做）：复用原有 `install-targets|install-target` 路由，
    支持探测/手填/清除；中继侧 `customRoots` 优先于常见路径检查，保存即生效。
  - **服务自动拉起开关**（默认**关**）：持久化在 `app-data/comfyui-hana/auto-start.json`。Hana 启动且中继就绪后，
    若本机已装 ComfyUI、8188 上没有服务，则自动拉起一次（中继 `startBackendService` 自身幂等，已运行返回 `already`）。
    路由 `auto-start`（GET/POST）；服务由计划任务拉起，仍独立于 Hana 存活。
- ComfyUI 本体更新（v0.8 新增，M11）：
  - **检查**：`GET /comfyui-hana/update` → 中继 `GET /_relay/update`（`git fetch` + 跟 `origin/<branch>` 比 commit，
    给出 `behind/ahead` 与本地/远端 tag 描述；结果 60s TTL 缓存，`?force=1` 绕过）。
  - **执行**：`POST /comfyui-hana/update` `{op:"apply"}` → 中继**后台**跑：停服务 → `git fetch` → `git pull --ff-only`
    → `pip install -r requirements.txt`。用异步 `spawn`（**绝不 spawnSync 卡事件循环**，pip 可数分钟）；
    只用 `--ff-only`（不产生 merge commit；本地有未提交改动会明确失败，**不擅自 merge/reset**）；
    更新前记录旧 commit（与更新后一并写入 `logs/update-state.json`）；更新后**不自动起服务**（交用户决定）。
  - **进度**：`GET /comfyui-hana/update/status`（阶段 stopping/fetching/pulling/installing/done/failed + 步骤 + 日志尾），
    设置页「ComfyUI 更新」区块轮询它；工具面 `comfyui(action="update", op="check"|"apply"|"status")`。
- **画布共驾（v0.9 新增，M12）：只读桥 + 变更感知 + 写入**：让 agent 读/改**人正在看的同一张画布**。
  - 链路：`comfyui(action="canvas", op=…)` → 路由 `canvas` → 中继 `/_relay/bridge` → ComfyUI
    `POST /api/hana_bridge/call` → `send_sync` 经自带 `/ws` → 前端扩展读 `window.app.graph` → 同源回传。
  - 默认 op `state`：读**服务端缓存**的最近一次画布快照（零往返，**ComfyUI 页面没开着也能拿到**）。
    快照由前端在画布变化后主动推（debounce 1.5s）缓在 ComfyUI 侧，带 `ageSec` 时间戳；
    无快照或过期时改用 `op=summary` 现抓（需页面在线）。
  - 只读 op：`summary`（现抓结构摘要）/ `get`（全量 UI JSON）/ `prompt`（可提交形态）/ `running`（当前执行节点）/ `probe`（自检）/
    `revision`（变更序号，只问变没变）/ `events`（变更记录，可按 `since` 增量查，含按节点的 added/removed/changed）。
  - 变更感知为 500ms 轮询签名比对（新版 LiteGraph 没有可用的变更事件），签名**不含节点位置**。
  - 写入 op（v0.9 新增，P3 最小集）：`setWidget`（改某节点参数，返回 before/after）/ `undo`（撤销 agent 上一步写入，最多 20 步）。
    **默认关闭**，需在设置页打开「允许 agent 修改画布」才可用；未授权时直接报错。
    注意：新版前端的撤销栈**不记录**外部直接改图，所以人的 Ctrl+Z 撤不掉 agent 的改动，要用 `op=undo`。
  - **前置**：`custom_nodes/hana_bridge/`，用 `tools/deploy-bridge.ps1` 装 / 卸 / 查；
    改 `__init__.py` 需重启 ComfyUI，改 JS 只需刷新页面（静态服务带 `Cache-Control: no-store`）。
  - 安全：`/call` 校验 `X-Hana-Token`（token 由 Python 侧首启生成、中继读同一文件），无 token → 403。
  - 记录 `docs/M12-画布共驾-P1记录.md`；方案 `docs/画布共驾方案-20260926.md`。
  - 边界：仅**源码安装**（Git 仓库）可代为更新；便携包/手工解压会明确回报“无法代为更新”。
- 已实测：中继端点 11/11；中继级 E2E（EmptyImage→SaveImage 纯 CPU）9/9 ×3；宿主段工具全动作 17/17；
  cancel 定向中断 10/10（M3）；静态校验 ok

## 开发流程（2026-09-26 起生效）

1. **改 App 前先写方案**：落 `docs/<主题>-<YYYYMMDD>.md`，日期结尾，便于对账。
2. 方案写清：动机 → 边界 → 架构依据（**实测与推断分开**）→ 分期 → 风险。
3. 交付时区分「已生效（实测）」与「待重启」；需要重启先告知。
4. 涉及用户环境（ComfyUI 安装、宿主补丁等）的改动，先取得同意再动，并登记侵入面。

## 关键口径

- **clientId 配对**：ComfyUI 只把执行事件发给提交方 `client_id` 的 WS 连接；中继订阅与提交共用
  同一个「每次启动随机」的 clientId（`comfyui-hana-relay-<hex>`）——不要复用固定 id（旧连接关闭时 Host 侧按 sid 清理，会误删新连接）。
- **产物定位**：ComfyUI 安装根的 `output/...`（安装根由中继环境探测自动识别，不硬编码；`/_relay/fs/stat` 校验存在）；预览 URL 走代理 `view?`。
- submit 不支持「UI 格式 → API」的完整转换：子图/环绕/静音/旁路节点会明确报错，改用「导出（API 格式）」。
- 投递诊断：`ctx.tasks.getDelivery`（`query` 已暴露）；宿主被卡记录在 `%HANA_HOME%\.ephemeral\deferred-tasks.json`。

## 本地开发

```powershell
# 静态校验（先 staging 到目录名=id；脚本在项目根 tools/ 下）
pwsh -NoProfile -File ..\tools\validate-app.ps1

# 测试（按需；脚本在项目根 tools/ 下）
node .\runtime\comfy-relay.mjs --probe-env          # 安装探测（应输出本机 ComfyUI 安装 JSON）
node ..\tools\m2-checks\test-relay-v02.mjs          # 中继新端点
node ..\tools\m2-checks\test-e2e-relay.mjs          # 中继级 E2E（前置：8188 队列为空）
node ..\tools\m2-checks\host-stage.mjs              # 宿主段工具全动作
node ..\tools\m3-checks\test-cancel.mjs             # cancel 定向取消

# 同步到宿主副本（-DryRun 预览）
pwsh -NoProfile -File ..\tools\sync-to-host.ps1 -DryRun
```

## 纪律

- 不在用户队列非空时提交测试任务；测试工作流一律极小（纯 CPU）。
- 宿主安装/重启由主脑统一安排；App 级 reload 可自行执行（本仓流程）。
- 改 `manifest.json` 后走 `reload` 即可让宿主认到新版本（实测：reload 响应 `record.version` 会更新）；**无需**重装。
  但若 `apps/comfyui-hana` 目录被占用，`install+confirm` 重装会报 `EPERM`（详见 `docs/踩坑记录.md`）。
- 项目全景与待办见 `..\README.md` 与 `..\docs\待办与验收清单.md`。
