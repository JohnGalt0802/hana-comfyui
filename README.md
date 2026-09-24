# Hana-ComfyUI

把本机 ComfyUI（`D:\ComfyUI`，服务在 `127.0.0.1:8188`）接进 HanaAgent 的 **v2 App 项目**（开发工作台 = 本目录）。

## 当前状态

**M0–M2 完成（含 M2.5 能力扩容、M2.6 回执诊断与修复），M3–M9 相继完成，app 可用**；剩余人工验收见 `docs/待办与验收清单.md`：

- 界面：整页工作区（`ui/workspace.html`）嵌入 ComfyUI 官方前端——**零改造**，前端按相对寻址经宿主代理路径加载（HTTP/WS 全通，宿主段已实测）
- 能力：`comfyui` 单工具 8 动作——`status / submit / query / result / cancel / workflows / upload / service`
- 任务：每次提交 = 宿主正式任务（`ctx.tasks`）+ 内联任务卡（`details.card`）+ **next-step 回执**（桌面会话；子代理会话受宿主限制不会自动回执，工具文案会如实标注）
- 服务形态：**attach 模式**——连接外部运行中的 ComfyUI；M9 起左侧面板可**一键启动 / 停止**服务（计划任务拉起，独立于 Hana 存活；不托管其自启/自愈）

## 目录结构

```
D:\HanakoWorks\ComfyUI\
├── README.md                # 本文件
├── research\                # 五路调研报告（A 移植解剖 / B SDK 契约 / C 下载器工程 / D 本机环境 / E 前端生态）
├── docs\                    # 方案与验证记录（见下方"关键文档索引"）
│   ├── 架构方案-v1.md
│   ├── M0-验证记录.md        # 本地段 + 宿主段 V1–V7
│   ├── M2-验证记录.md        # M2 开发/扩容/回执诊断（§9–§10）
│   ├── M3-收尾记录.md        # 日志滚动 / cancel 实测 / 仓库初始化
│   ├── M6-环境引导记录.md     # 环境探测与引导（v0.3）
│   ├── M7-状态面板记录.md     # GPU/CPU/内存图表 + 释放显存（v0.4）
│   ├── M8-安装引导记录.md     # 选位置安装弹窗（v0.5）
│   ├── M9-服务起停记录.md     # 启动/停止 ComfyUI 服务 + 「重启中继」正名（v0.6）
│   ├── 待办与验收清单.md     # ← 当前待办与人工验收项
│   └── m0-results\ m2-results\   # 原始证据（输出摘要、截图）
├── app\                     # ★ v2 App 源码（开发仓；宿主副本 = %HANA_HOME%\apps\comfyui-hana\）
├── tools\                   # 开发/测试工具（见下）
└── _build\                  # 本地构建物（校验 staging；已从 git 排除）
```

工具目录：

| 路径 | 用途 |
|---|---|
| `tools/sync-to-host.ps1` | 开发仓 → 宿主副本同步（robocopy + SHA-256 核对；`-DryRun` 预览；首次建副本 `-Create`） |
| `tools/validate-app.ps1` | 官方静态校验包装（自动 staging 到目录名=id 后调用 `validate-app.mjs`） |
| `tools/m0-checks\` | M0 测试：中继 HTTP/WS/退出码/剥前缀预演 + electron-smoke-blocker 复现材料 |
| `tools/m2-checks\` | M2 测试：中继 v0.2 新端点 / 中继级 E2E / 宿主段工具全动作（host-stage.mjs） |
| `tools/m3-checks\` | M3 测试：日志滚动 / cancel 定向中断（test-cancel.mjs，走宿主真实工具） |
| `tools/make-placeholder-assets.py` | 占位图生成（icon/cover，纯标准库） |

## app 简述（`app/`）

```
app\
├── manifest.json            # v2 清单：6 能力词（runtime.execute/local-machine/network + tools.expose-to-model + tasks.manage + session.start-turn）
├── index.js                 # 入口：受管 runtime 控制器 + 工具面(8动作) + 任务桥 + 路由面
├── runtime\comfy-relay.mjs  # 中继（Node 单文件零依赖）：HTTP/WS 反代 + 进度事件缓存 + fs/upload + 日志落盘
├── ui\                      # workspace（整页工作区）/ panel（状态面板）/ settings / task（任务卡）
├── skills\comfyui-hana\     # 随包技能（工具手册 + 排错表）
├── sdk\                     # 随包官方 SDK 拷贝（脚手架产物，无 npm 依赖）
└── assets\icon.png
```

三条链路（细节见 `docs/架构方案-v1.md`）：

1. **界面流**：整页卡 → 壳页（三态）→ 内层 iframe（`…/_runtime/<rid>/_surface/<票据>/index.html`）→ 中继 → 8188 前端；
2. **工具流**：agent `comfyui(action=…)` → App → 中继 → 8188（submit/queue/history/upload…）；
3. **状态流**：中继 `/_relay/status|prompts|history` ← App 1.5s 轮询 → boot-state / 任务卡 / 工具输出。

## 开发流程（改动如何生效）

| 改了什么 | 生效方式 |
|---|---|
| `ui/*`（静态页/js） | 同步后**刷新页面**即生效（宿主按请求读盘）；已挂载 iframe 需手动刷新 |
| `index.js` / `runtime/*` | 同步 → **App 级 reload**（`POST /api/extensions/app:comfyui-hana/reload`）；reload 后工具 RPC 指向新实例 |
| `manifest.json`（含能力声明） | 同步 → reload（扩大能力会转 `awaiting_confirmation`，`POST /api/extensions/staged/<id>/confirm` 确认） |
| 宿主重启 | **本工作台流程禁止擅自重启**；如需重启必须先告知用户（由主脑统一安排） |

常用命令：

```powershell
pwsh -File tools\validate-app.ps1                 # 静态校验（必须 ok:true）
pwsh -File tools\sync-to-host.ps1 -DryRun         # 同步预览
pwsh -File tools\sync-to-host.ps1                 # 同步 + hash 核对
node tools\m2-checks\host-stage.mjs               # 宿主段工具全动作回归（17 项，需宿主 loaded）
node tools\m3-checks\test-cancel.mjs              # cancel 实测（需队列为空）
```

边界纪律：8188 只做可控极小测试（纯 CPU 工作流；提交前核对队列为空）；不动用户文件；宿主副本只由同步脚本写入。

## 关键文档索引

| 文档 | 内容 |
|---|---|
| `docs/架构方案-v1.md` | 定稿架构（D1–D8 决策、M0–M4 里程碑、风险登记） |
| `docs/M0-验证记录.md` | 本地段中继实测 + 宿主段 V1–V7（§8 起为宿主实测） |
| `docs/M2-验证记录.md` | M2 工具面/任务桥/任务卡实测、M2.5 能力扩容流程、§10 回执未送达诊断（宿主子代理会话边界） |
| `docs/M3-收尾记录.md` | 日志滚动验证、cancel 定向中断实测、git 仓库初始化 |
| `docs/待办与验收清单.md` | **当前待办（含两项人工验收）与已完成项一览** |
| `research/B-sdk-contract.md` | v2 App SDK 契约（manifest/路由/卡片/权限/运行时）——开发主要依据 |
| `research/D-comfyui-local-env.md` | 本机 ComfyUI 环境事实（路径/启动方式/前端版本/模型） |

## 验证状态与待办一览（摘要）

- ✅ 静态校验、同步 hash、本地中继全套、宿主段 V1–V7、工具全动作 17/17、任务卡视觉、日志落盘、**cancel 定向中断**（M3）
- ⏳ 待用户：整页卡视觉确认（V6）、桌面会话回执终极验证（方法见待办清单）
- ⏳ 记录级遗留：宿主对子代理会话的 next-step 投递限制（被卡记录 `app:comfyui-hana:ab3736a5…` 静默重试，无副作用）；`HANA_APP_ELECTRON` smoke 复跑（可选）

（详细清单与验收方法 → `docs/待办与验收清单.md`）

## 仓库

本目录是独立 git 仓库（无远端）。首次提交见 `git log`。`.gitignore` 排除 `_build/` 与测试运行日志；`.gitattributes` 钉 `* text=auto eol=lf`（避免跨平台行尾漂移）。
