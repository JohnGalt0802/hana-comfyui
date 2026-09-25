---
name: comfyui-hana
description: Hana-ComfyUI（v2 App）——把本机 ComfyUI（127.0.0.1:8188）接进 Hana：整页工作区嵌官方前端（iframe 直连 8188，自定义节点扩展可用）；comfyui 工具支持提交工作流/跟踪进度/取回产物/取消/上传/服务起停（service）；工作区顶栏与左侧面板均可一键启动/停止 ComfyUI 服务（计划任务拉起，独立于 Hana 存活）；可自定义 ComfyUI 安装目录；环境自举——未安装时引导 agent 完成安装。触发场景：用 ComfyUI 生成图片、提交工作流、查看生成进度、取回产物、取消生成任务、查询队列、上传参考图、启动/停止 ComfyUI 服务、帮我启动 ComfyUI、帮我关掉 ComfyUI、ComfyUI 工作区打不开、中继未就绪/启动失败、ComfyUI 后端不可达（8188）、自定义 ComfyUI 目录/ComfyUI 装在别处、自定义节点不显示/扩展脚本 403、帮我安装 ComfyUI、未检测到 ComfyUI 环境。
---

# Hana-ComfyUI（v0.7）

把本机 ComfyUI（服务在 `127.0.0.1:8188`）接进 Hana 的 v2 App。环境不存在时工作区会弹安装引导（选位置 → 让助手装 / 复制指令 / 自行安装）。

## 架构一句话

受管 runtime 拉起「中继」（`runtime/comfy-relay.mjs`）→ 宿主代理路径提供 HTTP/WS 通道 + 工具/任务/卡片面；
整页工作区的 iframe **直连 `127.0.0.1:8188`**（不经过代理前缀，见下）；`comfyui` 工具经中继操作 8188；
每次提交在宿主建一条正式任务（next-step 回执）并有任务卡。

### 工作区为什么直连 8188（v0.7，2026-09-25 实测定位）

ComfyUI 官方前端的资源引用是**相对路径**，经代理前缀能正常加载；但**自定义节点的扩展脚本**习惯写**绝对路径**
（`/extensions/<node>/*.js`、`/scripts/app.js`、`/scripts/ui.js`），在宿主域下这些请求会绕过 App 前缀、
打到宿主根（不是本 App 路由）→ **403**，表现为“页面能开但节点/面板缺块”。
后端实测这些路径在 8188 上均 200，且无 `X-Frame-Options`，因此工作区 iframe 改为**直连**（manifest 声明 `ui.csp.frameDomains`）。
代价：iframe 跨源 → 壳页摸不到 `contentWindow`。主题改为**改道**：工作区在 iframe 加载**之前**把宿主主题
写成 ComfyUI 的自定义色板（`Comfy.CustomColorPalettes.hana`，键名与壳页 `HANA_CSS_MAP` / `HANA_JS_MAP` 同源）
并选中它（`Comfy.ColorPalette="hana"`），前端一起来就带着宿主配色（面板 + 画布/节点/连线）。
切宿主主题后：写入立即完成，顶栏提示「刷新工作区生效」（不自动重载，避免打断正在编辑的画布）。
路由 `theme`（GET 查 / POST 写）→ 中继 `/_relay/theme`。
工作区「连接方式」下拉保留 `direct` / `auto` / `hana.api.url` / `直接相对路径`，可随时切回代理（代理模式下主题走同源直控，不受此限）。

## 启动 / 停止 ComfyUI 服务（首选，别先去开终端）

App 自己就能拉起和撤下 8188 上的 ComfyUI 本体：

- 工作区**左侧面板**：「启动服务」/「停止服务」按钮（按当前可达性二选一显示）。
- 工作区**顶栏**（v0.7）：服务运行中时常驻「停止服务 / 重启中继」（之前工作区内只能启动、不能关闭）。
- 设置页（v0.7）还有「Hana 启动时自动拉起 ComfyUI」开关（默认关）。
- 工具：`comfyui(action="service", op="status"|"start"|"stop")`，start 可用 `path` 指定安装根。

机制（2026-09-23 实测，不是推断）：服务由 **Windows 计划任务**（`HanaComfyUI-Backend`）以当前用户身份拉起，
启动器脚本落在 `app-data/comfyui-hana/logs/backend-launcher.cmd`（真正干活）+ `backend-launcher.vbs`（用 wscript 的
`Run(..., 0, False)` 隐藏窗口，否则任务会弹出一个可见 cmd 窗口），服务日志写 `logs/backend.log`。
这么绕是因为中继进程跑在宿主沙箱的 job 里，直接 spawn 的子进程会随中继退出被回收（detached 也逃不出去）；
走计划任务则脱离沙箱，**ComfyUI 独立于 Hana 存活**（Hana 重启/退出都不影响它，实测沙箱退出后 8188 继续服务）。
撤下由中继执行 `taskkill /T /F`（受限令牌下实测可终止）；计划任务只当启动器，不常驻。
首次启动约 30～90 秒（依赖导入），面板与工作区会自行变绿；工作区在服务未跑时显示覆盖层（启动按钮 + 已等待秒数），
不会把中继的 `ECONNREFUSED` JSON 直接抩到界面上。

注意区分：面板的**「重启中继」**只重启本 App 的中继（受管 runtime，随 Hana 生命周期），跟 ComfyUI 服务是两件事。
中继挂了但服务还在跑时，只需重启中继；ComfyUI 没跑时才点「启动服务」。

## 环境不存在时（未安装 / 未启动）

工作区提示「未检测到 ComfyUI 环境」或用户说“帮我装/启动 ComfyUI”时：

**首选**：已装但没跑 → 直接 `comfyui(action="service", op="start")`（或让用户点面板按钮），不要手工开终端。
下面三步侦察用于**启动失败或未安装**时排查：
1. 服务：`Invoke-RestMethod http://127.0.0.1:8188/system_stats`——失败 = 服务没跑。
2. 安装探测（只读）——运行本技能包所在 App 的 `runtime/comfy-relay.mjs`（相对本文件：`../../runtime/comfy-relay.mjs`）：
   `node "<本 App 目录>/runtime/comfy-relay.mjs" --probe-env`
   输出 JSON：`found` / `installs[]`（path、kind=source|portable|desktop、version、hasVenv）。
3. 分流处理：
   - **检测到安装 + 服务没跑 → 先启动**：工作目录 = 安装根，
     `venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188`（隐藏窗口；portable 用 `python_embeded\python.exe`），
     轮询 8188 到就绪。无 venv 说明环境没装好，按 INSTALL.md 补建。
   - **未检测到 → 安装**：照同目录 `INSTALL.md` 全流程执行（Windows 主线，含镜像与逐步骤验证；每阶段完工向用户报一次进展）。
   - **装在非常规位置**：以用户提供的实际路径为准（同样走“启动”流程）。
4. 完成后 `GET /system_stats` 返回 200 → 告诉用户“回工作区刷新即可”（中继每 5s 探测，会自动恢复）。

**安装位置**：工作区安装引导给出的选定路径会写进提示词（并记入 App 配置）；若提示词里指定了位置，以它为准，目录约定 = `<位置>\ComfyUI`（仓库）+ `<位置>\venv`（环境）。装在非常规位置的，让引导记录一次该路径，中继探测会优先检查它。
**已装但探测不到时**（v0.7）：在**设置页 → ComfyUI 安装目录**里手填（存 `app-data/comfyui-hana/install-target.json`，中继 `customRoots` 优先于常见路径；
也可用路由 `install-targets`（候选+当前值）/ `install-target`（保存/清除）），保存即生效，无需重启。

安装步骤、镜像配置与排错表全在同目录 `INSTALL.md`，动手前先读它。

## 当前能力（v0.2）

| 面 | 内容 |
|----|------|
| 工具 | `comfyui`：**status / submit / query / result / cancel / workflows / upload / service**（单工具 action 分派；service 管 8188 服务进程起停） |
| 任务桥 | submit → 宿主任务（`delivery:"next-step"`）→ 2s 轮询结算（完成回执含产物路径；失败/中断给原因） |
| 任务卡 | 每次 submit 返回 `details.card`（进度/队列位/耗时/产物缩略），数据经 `GET /comfyui-hana/task?id=` |
| 路由 | `boot-state` / `status` / `health` / `task` / `relay/start` / `backend/start` / `backend/stop` / `backend` / `install-targets` / `install-target` / `auto-start` / `theme`（v0.7 后三个） |
| 中继增强 | 订阅 8188 `/ws` 做进度事件缓存；`/_relay/history` 裁剪历史；日志落盘（`app-data/comfyui-hana/logs/relay.log`，>5MiB 滚动 `.1`） |
| 卡片 | 「ComfyUI 工作区」整页卡（含状态面板）、「ComfyUI 任务卡」 |

## 工具手册

```
comfyui(action="...", ...)
```

| action | 必填 | 语义 | 关键返回 |
|---|---|---|---|
| `status` | — | 服务/中继/队列/运行中任务聚合 | 文本摘要 + `details.comfyui.{phase,backend,queue,events,jobs}` |
| `submit` | `workflow` | 提交工作流三形态（见下）；`inputs` 注入；`clientLabel`；`front` | `details.comfyui.{promptId,taskId,bridge}` + `details.card`（任务卡） |
| `query` | — | `promptId`/`taskId` 查单任务；都不给则列最近 | 状态/进度/错误摘要 |
| `result` | — | `promptId`/`taskId` 取产物：本地路径 + 预览 URL；`stage:true` 尝试入会话文件 | 路径列表 |
| `cancel` | — | `promptId`/`taskId` 定向取消（排队中→删除；执行中→定向中断）；`all:true` 才全清 | 模式说明 |
| `workflows` | — | 无参列 userdata/workflows；`name` 读取节点结构摘要（id/type/title） | 结构清单 |
| `upload` | `path` | 上传本机图片到 input（图生图） | 存储名（供 inputs 引用） |
| `service` | — | ComfyUI 服务进程起停：`op=status`（默认）查状态/监听 PID/安装根/日志路径；`op=start` 拉起服务（可带 `path` 指定安装根）；`op=stop` 撤下服务（taskkill 8188 上的进程） | `details.comfyui.{reachable,proc,install,python,mainPy,logFile}` |

### submit 的工作流三形态

1. **API 格式 JSON 对象**：`{"3": {"class_type": "KSampler", "inputs": {...}}, ...}` —— 最稳。
2. **文件路径字符串**：本机 `.json`；API 格式直接用；**UI 格式**（含 `nodes` 数组）会尝试自动转换（见下）。
3. **`{"template": "名称"}`**：从 ComfyUI `userdata/workflows` 取（先 `action=workflows` 看有哪些）。

**inputs 注入**：键为 `"<node_id>.<input>"`，如 `{"3.seed": 42, "6.text": "a cat"}`。节点 id 与输入名用 `action=workflows,name=...` 的摘要定位。

**UI→API 自动转换的边界**：支持经典图（普通节点 + 连线 + widget 值）；遇到**子图（Subgraph）/环绕节点/静音或旁路节点/未知节点类型**会明确报错——请改用 ComfyUI「工作流 → 导出（API 格式）」。

### 任务桥与投递

- 提交成功即返回（**回合纪律：不要原地等待**）；完成后（**桌面会话**）宿主按 `next-step` 把产物路径贴回本会话。
- 任务桥依赖能力：`app/tasks.manage` + `app/session.start-turn`。**未授权时自动降级**为仅内存跟踪（工具返回值里会写原因），此时用 `query`/`result` 主动取，不投递。
- 按钮通道（无 callToken）调用同样降级为仅内存跟踪。
- **子代理会话边界（宿主限制，2026-09-21 实测）**：宿主 next-step 可靠投递只写**桌面会话**（`agents/{id}/sessions/*.jsonl`）；从**子代理会话**发起的 submit 得到的宿主任务**不会自动回执**（宿主 `_assertActiveDesktopSessionPath` 静默拒绝、每 30s 重试但永不送达；hana-downloader 已有同类先例）。此时工具返回值会明确标注，请用 `comfyui(action="query")`（含“投递：published（未送达）”探针）与 `action=result` 主动取结果；需要自动回执请从主对话发起提交。

### 典型用法

```
# 1) 看服务与队列
comfyui(action="status")

# 2) 极小测试（纯 CPU，零模型）
comfyui(action="submit", workflow={"1":{"class_type":"EmptyImage","inputs":{"width":64,"height":64,"batch_size":1,"color":0}},
                                  "2":{"class_type":"SaveImage","inputs":{"images":["1",0],"filename_prefix":"comfyui_hana_test"}}},
        clientLabel="测试出图")

# 3) 改参数重跑（找模板）
comfyui(action="workflows", name="我保存的工作流.json")
comfyui(action="submit", workflow={"template":"我保存的工作流.json"}, inputs={"3.seed": 123})

# 4) 跟踪与取产物
comfyui(action="query", promptId="…")
comfyui(action="result", promptId="…")

# 5) 图生图：先传参考图
comfyui(action="upload", path="D:\\pics\\ref.png")
#   → {"1.image": "ref.png"} 注入到 LoadImage 节点
```

## 任务卡状态（现象 → 怎么办）

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 卡显示"排队中" | 队列里等前面的任务 | 等待；`front:true` 可插队 |
| 卡显示"执行中" + 进度条 | 正在采样 | 等待；节点/步进在卡上实时更新 |
| 卡显示"已完成"+缩略图 | 产物就绪 | 用 `action=result` 取本地路径 |
| 卡显示"失败/已中断/超时" | 见卡上错误行 | `action=query` 看详情；错误信息在 `details` |
| 卡显示"未找到任务 record" | 超出进程记忆（重载后） | 用宿主任务 id 查询，或重新提交 |

## 排错表

| 症状 | 先查 | 说明 |
|---|---|---|
| `中继未就绪` | 等 1-3s；或 `POST /comfyui-hana/relay/start` | 中继自动拉起，失败会自动退避重试 |
| `后端不可达` | 先走上文「环境不存在时」三步侦察 | attach 模式：中继常驻并持续探测，恢复即可用；未装/未启动时按引导流程处理 |
| submit 报 `node_errors` | `action=workflows` 核对节点/输入名 | ComfyUI 的节点校验错误原文在报错里 |
| submit 报"UI→API 转换遇到不支持的构造" | 是否子图/静音节点 | 导出 API 格式再提交 |
| 任务卡缩略图不显示 | 卡的凭据段 | 预览走 `_surface` 凭据路径；老卡或非卡环境可能 403 |
| `result` 说"尚未完成" | 历史未落 | 等几秒重试，或先 `query` 看状态 |
| 提交后没有自动回执 | `query` 的“投递”行 | 桌面会话：`published` = 等下一个输入点送达；子代理会话：永不自动送达，改用 query/result 主动取 |
| 点了「启动服务」没反应 | `comfyui(action="service", op="status")` 的 `lastError` + `logs/backend.log` | 常见：无 venv python / 计划任务创建失败（启动器路径含空格必须带引号，已在代码里处理）/ 端口 8188 被别的进程占 |
| 服务起不来但日志为空 | 计划任务 `HanaComfyUI-Backend` 的 Last Result | 非 0 就是任务层失败（如 0x800704C1=启动器路径解析失败）；任务只作启动器，手动 `schtasks /run /tn HanaComfyUI-Backend` 等价 |
| `cancel all:true` 慎重 | 会清空整个队列 | 默认只取消指定 prompt |
| 工作区打不开 | `boot-state` 的 note | 见 M0 记录 §8 的宿主段排错 |
| 工作区能开但**节点面板/扩展缺块**，控制台报 `/scripts/app.js`、`/extensions/...` 403 | 工作区「连接方式」下拉 | 自定义节点扩展用绝对路径，代理前缀下会打到宿主根被 403；选 `direct`（默认）或 `auto` 直连 8188 即可（v0.7） |
| 探测不到已装的 ComfyUI | 设置页「ComfyUI 安装目录」/ `install-targets` | 手填安装根（含 `main.py` 的那层或其外层），保存即生效 |

## 数据与日志

- 中继日志：**落盘** `app-data/comfyui-hana/logs/relay.log`（>5MiB 滚动到 `relay.log.1`）+ 宿主受管 runtime stdout。
- 服务本体日志：`app-data/comfyui-hana/logs/backend.log`（启动器重定向；由计划任务拉起的 ComfyUI 的 stdout/stderr）。
- 服务起停状态：`app-data/comfyui-hana/logs/backend-state.json`（上次由谁拉起、安装根、启动时间，跨中继重启保留）。
- 私有运行时配置：`app-data/comfyui-hana/integration/relay-*.json`（0600，中继读取后自删；含 controlKey，管理端点 `/_relay/fs/*`、`/_relay/upload` 需该密钥）。
- 产物定位：ComfyUI 安装根的 `output\<subfolder>\<filename>`（安装根由本机环境探测自动识别，不硬编码；经 `/_relay/fs/stat` 验证存在）。
- 端口随机（38000-52000）、仅绑定 127.0.0.1。
- 配置文件（v0.7，均在 `app-data/comfyui-hana/`）：`install-target.json`（自定义安装根）、`auto-start.json`（服务自动拉起开关，默认关）。
