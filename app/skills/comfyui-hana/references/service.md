# 服务管理（起停 / 环境检查 / 就绪等待 / 安装分流）

> **范围**：ComfyUI 服务进程（8188）的起停、环境检查卡流程、就绪等待、未安装 / 未启动时的侦察分流、本体更新（`update`）、`status` 聚合。
> **何时读**：用户说"帮我启动/关掉 ComfyUI"、服务起不来、启动被暂缓、点按钮没反应、要装或更新 ComfyUI 时。

## 首选路径（别先去开终端）

App 自己就能拉起和撤下 8188 上的 ComfyUI 本体；**拉起前会自动做环境检查**：发现其他模型占用 GPU（如 llama-server）时暂缓拉起，并给出「环境检查卡」（[重试]/[清除其他进程]/[取消]，卡内按钮直接走 App 路由）；环境干净则直接拉起：

```
comfyui(action="service", op="start")     # 拉起（起始自动 envcheck；blocked → 按卡处理）
comfyui(action="service", op="wait")      # 轮询就绪（单次 ≤25s，总时限 120–150s，超时只报不杀）
comfyui(action="service", op="status")    # 查状态（默认 op）
```

- 工作区**左侧面板**：「启动服务」/「停止服务」按钮（按当前可达性二选一显示）。
- 工作区**顶栏**（v0.7）：服务运行中时常驻「停止服务 / 重启中继」（之前工作区内只能启动、不能关闭）。
- 设置页（v0.7）：「Hana 启动时自动拉起 ComfyUI」开关（默认关）。
- 首次启动约 30～90 秒（依赖导入），面板与工作区会自行变绿；工作区在服务未跑时显示覆盖层（启动按钮 + 已等待秒数），不会把中继的 `ECONNREFUSED` JSON 直接抛到界面上。

## service op 详表

| op | 语义 | 关键返回 |
|---|---|---|
| `status`（默认） | 聚合视图：服务 / 中继 / 队列 / 运行中任务（含监听 PID / 安装根 / 日志路径） | 文本摘要 + `details.comfyui.{phase,backend,queue,events,jobs}` |
| `start` | 拉起服务（**起始自动 envcheck**，有阻断暂缓并挂检查卡；可带 `path` 指定安装根） | `{python,mainPy,logFile,...}` |
| `stop` | 撤下服务（taskkill 8188 上的进程） | `{already,alive,stopped,pids}` |
| `envcheck` | 环境检查（GPU 占用 / 端口残留 → **180s 一次性快照**） | `{blockers,warnings,gpu,snapshotId}` |
| `clear` | 按快照清理阻断进程（带 `snapshotId`+`pids`；**列表外全拒、自身不可清**） | `{cleared,refused,recheck}` |
| `wait` | 轮询就绪（单次 ≤25s；ready / starting / timeout；**不杀进程**） | `{state,readyInMs,detail}` |

## 环境检查卡流程（blocked 之后）

- 触发：`start` 的自动检查发现阻断项；或显式 `op="envcheck"`。
- 卡上三键：**[重试]** / **[清除其他进程]** / **[取消]**；卡随消息给出，按钮直接走 App 路由。
- 纪律：清除只按快照走（列表外一律拒绝、自身不可清；优先优雅停，防 supervisor 打地鼠）；清完 `op="wait"` 轮询到就绪再继续。

## 机制（为什么这么绕）

服务由 **Windows 计划任务**（`HanaComfyUI-Backend`）以当前用户身份拉起（2026-09-23 实测，不是推断）；启动器脚本落在 `app-data/comfyui-hana/logs/backend-launcher.cmd`（真正干活）+ `backend-launcher.vbs`（用 wscript 的 `Run(..., 0, False)` 隐藏窗口，否则任务会弹出一个可见 cmd 窗口），服务日志写 `logs/backend.log`。这么绕是因为中继进程跑在宿主沙箱的 job 里，直接 spawn 的子进程会随中继退出被回收（detached 也逃不出去）；走计划任务则脱离沙箱，**ComfyUI 独立于 Hana 存活**（Hana 重启/退出都不影响它，实测沙箱退出后 8188 继续服务）。撤下由中继执行 `taskkill /T /F`（受限令牌下实测可终止）；计划任务只当启动器，不常驻。

注意区分：面板的**「重启中继」**只重启本 App 的中继（受管 runtime，随 Hana 生命周期），跟 ComfyUI 服务是两件事。中继挂了但服务还在跑时，只需重启中继；ComfyUI 没跑时才点「启动服务」。

## 环境不存在时（未安装 / 未启动）

工作区提示「未检测到 ComfyUI 环境」或用户说"帮我装/启动 ComfyUI"时：

**首选**：已装但没跑 → 直接 `comfyui(action="service", op="start")`（或让用户点面板按钮），不要手工开终端。若返回 `blocked`（其他模型占 GPU）→ 操作卡会随消息给出，按卡处理（清除后用 `op=wait` 轮询到就绪再继续）。
下面三步侦察用于**启动失败或未安装**时排查：
1. 服务：`Invoke-RestMethod http://127.0.0.1:8188/system_stats`——失败 = 服务没跑。
2. 安装探测（只读）——运行本技能包所在 App 的 `runtime/comfy-relay.mjs`（相对本文件：`../../../runtime/comfy-relay.mjs`）：
   `node "<本 App 目录>/runtime/comfy-relay.mjs" --probe-env`
   输出 JSON：`found` / `installs[]`（path、kind=source|portable|desktop、version、hasVenv）。
3. 分流处理：
   - **检测到安装 + 服务没跑 → 先启动**：工作目录 = 安装根，
     `venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188`（隐藏窗口；portable 用 `python_embeded\python.exe`），
     轮询 8188 到就绪。无 venv 说明环境没装好，按 INSTALL.md 补建。
   - **未检测到 → 安装**：照同技能包 `../INSTALL.md` 全流程执行（Windows 主线，含镜像与逐步骤验证；每阶段完工向用户报一次进展）。
   - **装在非常规位置**：以用户提供的实际路径为准（同样走"启动"流程）。
4. 完成后 `GET /system_stats` 返回 200 → 告诉用户"回工作区刷新即可"（中继每 5s 探测，会自动恢复）。

**安装位置**：工作区安装引导给出的选定路径会写进提示词（并记入 App 配置）；若提示词里指定了位置，以它为准，目录约定 = `<位置>\ComfyUI`（仓库）+ `<位置>\venv`（环境）。装在非常规位置的，让引导记录一次该路径，中继探测会优先检查它。
**已装但探测不到时**（v0.7）：在**设置页 → ComfyUI 安装目录**里手填（存 `app-data/comfyui-hana/install-target.json`，中继 `customRoots` 优先于常见路径；也可用路由 `install-targets`（候选+当前值）/ `install-target`（保存/清除）），保存即生效，无需重启。

安装步骤、镜像配置与排错表全在 `../INSTALL.md`，动手前先读它。

## update（本体更新 · 仅源码安装）

| op | 语义 | 关键返回 |
|---|---|---|
| `check`（默认） | 检查：git fetch + 比 commit | `{behind,ahead,local,remote}` |
| `apply` | 执行：停服务 → `git pull --ff-only` → `pip install -r requirements.txt`（后台跑） | `{accepted,phase}` |
| `status` | 查进度 | `{running,phase,steps,logTail,lastError}` |

- 更新前自动停服务；完成后需用「启动服务」重新拉起（或 `service start`）。
- 仅源码安装（git 仓）支持；portable / desktop 形态会返回"无法代为更新"。
