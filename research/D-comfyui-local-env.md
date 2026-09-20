# 本机 ComfyUI 环境侦查报告

- 侦查时间：2026-09-21 02:03 ~ 02:10（Asia/Shanghai）
- 用途：HanaAgent v2 App 项目「ComfyUI-Hana」移植前环境摸底
- 原则：全程只读侦查，未启动/停止/修改任何服务
- 口径：**实测** = 本次直接观测到的证据；**推断** = 由实测证据推导，未经直接验证

---

## 1. 安装位置、版本、安装方式

| 项 | 结论 | 证据（实测） |
|---|---|---|
| 源码目录 | `D:\ComfyUI\ComfyUI`（仓库根） | 目录含 main.py / comfy/ / custom_nodes/ 等 |
| 外层目录 | `D:\ComfyUI`（venv、日志、脚本、下载脚本在外层） | 实地清点 |
| 版本 | **ComfyUI v0.37.0**（tag `v0.37.0`，2026-09-20） | `comfyui_version.py` = 0.37.0；git log：HEAD `0f74f7f`「Bump back frontend to 1.53.6…」 |
| 安装方式 | **git clone 直装**（非便携包、非 pip 包；不存在独立 `comfyui` pip 包） | `.git` 存在且 shallow；`/system_stats` 报 `deploy_environment: local-git` |
| 克隆形态 | **浅克隆（shallow=true）**；remote 走 ghproxy.net 镜像 | `git rev-parse --is-shallow-repository` = true；`.git/config` remote = `https://ghproxy.net/https://github.com/comfyanonymous/ComfyUI.git` |
| Python 环境 | venv：`D:\ComfyUI\venv`，**CPython 3.12.13**（uv 发行版）；曾从 Anaconda 重指向 | `pyvenv.cfg`（含 `pyvenv.cfg.anaconda-bak`）；解释器本体在 `C:\Users\John Galt\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\` |
| 关键依赖 | torch **2.11.0+cu128** / torchvision 0.26.0+cu128 / torchaudio 2.11.0+cu128；comfy-kitchen 0.2.35、comfy-angle 0.1.1、comfy-aimdo 0.5.5 | venv `pip list`、`/system_stats` |
| 安装时间线 | 2026-08-26 当天完成首装（torch → requirements → core 三步） | 安装日志：`D:\HanakoWorks\_temp\comfy_torch_install.log`（14:54）、`comfy_req_install.log`/`comfy_req_final.log`（16:33~16:41）、`comfy_core_install.log`（16:43） |
| 包源 | torch 走 `download.pytorch.org/whl/cu128`；其余走清华 pypi 镜像（`mirrors.tuna.tsinghua.edu.cn`） | 同上安装日志 |

补充：repo 根有本地未跟踪文件 `requirements.core.txt`（git status 显示 `??`），为自定义精简依赖清单 [推断：为分步安装所写]。本机标准路径无 Anaconda（实测 False），venv 的「re-pointed from Anaconda」系历史状态。

---

## 2. 启动方式与运行现状

**当前状态：正在运行（实测）**

- 端口：`127.0.0.1:8188` LISTENING（仅本机回环，未绑 0.0.0.0）；`GET /system_stats` 返回 200。
- 进程树（实测）：
  - PID 13716 `D:\ComfyUI\venv\Scripts\python.exe`（转发壳）
  - └ PID 27516 `...uv\python\cpython-3.12-windows-x86_64-none\python.exe`（实际执行者，端口监听方）
  - 两者创建时间同为 **2026-09-21 00:59:20**，命令行均为 `main.py --listen 127.0.0.1 --port 8188`。
- 工作目录 = `D:\ComfyUI\ComfyUI` [推断：由启动脚本的 WorkingDirectory 设定]；argv 无任何鉴权/远程参数（实测 `/system_stats`）。
- 资源快照（探测时刻）：VRAM 空闲 ≈ 3.8 GiB / 12.28 GiB；RAM 空闲 ≈ 7.3 GiB / 32 GiB。

**启动机制：无服务化，手工脚本拉起（实测）**

- 无 Windows 服务、无计划任务、无 Startup 文件夹项、HKCU Run 无相关条目。
- 现行启动模式（见 `D:\ComfyUI\_qwen21_go.ps1`）：
  1) 杀残留 main.py 进程 → 2) `Start-Process venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188`（隐藏窗口）→ 3) 轮询 8188 端口直至就绪。
- 日志位置（每次启动重定向，全部在 `D:\ComfyUI\` 下）：
  - 当前实例：`_run21.log`（stdout，空）+ `_run21.err`（**实际运行日志**；ComfyUI 输出走 stderr）
  - 历史：`comfy_web.log` / `comfy_web.err.log`（9-18）、`comfy_run.log` / `comfy_run.log.err`（9-06）、`_comfy.log`（记录了「双开冲突：端口被占 + comfyui.db 锁」的失败启动）
  - 安装日志在 `D:\HanakoWorks\_temp\comfy_*.log`

---

## 3. 前端形态

- **前端 = pip 包**：`comfyui_frontend_package==1.53.6`（装在 venv site-packages），**仓库内没有 `web/` 静态目录**（实测：v0.37.0 起前端与核心完全解耦）。
- 静态资源目录：`D:\ComfyUI\venv\Lib\site-packages\comfyui_frontend_package\static\`
  - 结构：`index.html`、`assets\`（876 个打包资源）、`extensions\core`、`fonts\`、`scripts\`、`cursor\`、`materialdesignicons.min.css`
- 版本关系（实测 `/system_stats`）：required_frontend_version = installed = **1.53.6**（一致 ✓）。
  - user 设置中残留 `Comfy.InstalledVersion: 1.49.6`（首装值，后随仓库更新升级到 1.53.6）[语义推断]。
- 用户设置：`D:\ComfyUI\ComfyUI\user\default\comfy.settings.json`（如 `Comfy.VueNodes.Enabled=true`、教程已完成）；SQLite 库 `user\comfyui.db`（alembic 迁移体系；**单实例锁**，双开会报错）。
- 模板包：comfyui_workflow_templates **0.11.48**，服务端要求 **0.11.66**（存在版本差，会提示升级）。
- custom_nodes：**空**（仅 `example_node.py.example`、`websocket_image_save.py` 示例）——无任何第三方节点。

---

## 4. 模型与输出目录概况

模型根：`D:\ComfyUI\ComfyUI\models\`；**无 `extra_model_paths.yaml`**（模型仅从 repo 内单根加载）。总量 ≈ 51 GB。

| 类别（总量） | 关键文件 |
|---|---|
| diffusion_models（28.53 GB） | `qwen_image_2.1_bf16` 13.25 / `z_image_turbo_bf16` 11.46 / `flux-2-klein-base-4b-fp8` 3.81 |
| text_encoders（16.20 GB） | `qwen3vl_8b_int8_convrot` 8.71 / `qwen_3_4b` 7.49 |
| model_patches（2.89 GB） | `Z-Image-Turbo-Fun-Controlnet-Union` |
| checkpoints（1.79 GB） | `sdpose_wholebody_fp16`（姿态估计） |
| vae（1.49 GB） | `qwen_image_2.1_vae_bf16` / `flux2-vae` / `ae` / `full_encoder_small_decoder` |

- **Qwen-Image 系部署线索（实测）**：从 `Comfy-Org/Qwen-Image-2.1` 仓库经 **hf-mirror.com** 下载（脚本 `D:\ComfyUI\_dl_qwen21.py`；日志 `_dl2.log`，2026-09-21 00:31~00:38 完成；首试官方直连失败见 `_dl_qwen21.log`）。
  - 先下载 int8_convrot 版（6.92 GB），磁盘现只有 **bf16 版（13.25 GB）**；当晚有 int8/bf16 对比运行记录（`_re_int8.log` 55s、`_re_bf16.log` 40s / 25步 1024px）[推断：对比后仅保留 bf16]。
- output/：**149 个文件 / 124.5 MB**；input/：**75 个文件 / 34.1 MB**（含 Flux2 人物迁移参考图、icon 素材等）。
- 近期在用模型组合：Qwen-Image 2.1（模板在 `D:\ComfyUI\_templates\`）、Z-Image Turbo、Flux2 Klein。

---

## 5. 与 `D:\HanakoWorks\ComfyUI` 工作台的关系

**结论：目前零绑定；存量集成全部走「HanakoWorks 客户端脚本 → 127.0.0.1:8188 HTTP API」单向模式。**

实测依据：

1. 工作台目录 `D:\HanakoWorks\ComfyUI` 创建于 **2026-09-21 00:24:03**，当前内容仅 `research/`（本次侦查产物）——无脚本、无配置、无历史。
2. 全盘检索 `HanakoWorks\ComfyUI` 字面引用：**无任何文件命中**；反向检索 D:\ComfyUI 侧文件是否提 HanakoWorks：**无命中**。
3. 既有真实集成通道在 `D:\HanakoWorks\_temp\`：
   - **24 个 .py + 4 个 .ps1** 客户端脚本直接调 `http://127.0.0.1:8188`（/prompt、/history 等），如 `step3_submit*.py`、`shush_submit*.py`、`gen_icon.py`、`submit_v6.ps1`、`co_refine.py` 等；
   - `comfy_object_info.json`（940 KB，9-18）为 /object_info 全量 dump；
   - `comfy_wf_*.json` 系列为 API 格式工作流。
4. 文档引用（`D:\HanakoWorks` 内，仅 3 处实质）：
   - `_delivery\flux2klein_人物迁移_配方与踩坑.md`（引用 `D:\ComfyUI\ComfyUI\input\`、`output\`，2026-09-18）
   - `_git\HanaAgent-Plugins-repo\plugins\hana-downloader\icon\prompts-小花下载器.md`（Z-Image-Turbo 本地复现参数）
   - `AI日报归档\ai-daily-2026-07/08*.md`（新闻顺带提及，无操作价值）

**给项目的直接含义**：D:\ComfyUI 是「存量后端」，新工作台是「新客户端空壳」。移植项目实际要做的是建立"新客户端 ↔ 既有后端"的对接层，而不是从零建环境；对接协议事实标准 = ComfyUI 本地 HTTP/WS API。

---

## 6. 对移植方案的环境硬约束清单

1. **源安装 + 独立 venv + 无进程托管**：程序 `D:\ComfyUI\ComfyUI\main.py`、解释器 `D:\ComfyUI\venv\Scripts\python.exe`；无服务/自启/守护。App 必须自建「拉起 → 健康检查（轮询 8188）→ 日志重定向（stderr）→ 清理残留进程」这条链路。
2. **前端是 pip 包且服务端校验版本**：静态资源在 venv site-packages（非仓库）；当前 required==installed==1.53.6。移植前端必须锁定该版本并对齐其运行时契约（/object_info 节点元数据、/ws 进度流等）。
3. **仅本机明文 HTTP、无鉴权**：`--listen 127.0.0.1` + 8188；集成协议 = REST + WebSocket；当前无任何远程访问能力。若 App 需要远程/多端，必须另加层（改绑、反代），不可假定现成。
4. **单机 GPU 硬约束**：RTX 4070 SUPER 12 GB VRAM + 32 GiB RAM；torch cu128（启动警告：优化 CUDA 内核需 cu130+；Windows 被强制单 GPU 模式；triton 缺失、comfy-kitchen 的 CUDA 后端 disabled、eager 后端可用）；Qwen-Image 2.1 bf16（13.25 GB）超 VRAM，依赖 offload（async weight offloading / pinned memory ~13 GB / aimdo 动态显存），出图分钟级。
5. **扩展面为空 + 单模型根**：custom_nodes 无第三方节点；无 extra_model_paths.yaml。App 不能假设 Manager/三方节点或外挂模型目录存在，能力设计以核心节点集为准。
6. **网络下载面必须带镜像适配**：git 走 ghproxy.net、HF 走 hf-mirror.com（官方直连实测失败）、pypi 走清华源；大文件下载实测 14~21 MB/s。任何"拉模型/更新"功能需内置镜像配置。
7. **数据面集中在 repo 内**：`user/comfyui.db`（SQLite + 单实例锁）、`user/default/comfy.settings.json`、`output/input/temp` 全在 `D:\ComfyUI\ComfyUI\` 下——备份/迁移/清理的最小单位 = 该目录 + venv。
8. **小隐患**：workflow templates 0.11.48 < 要求 0.11.66（升级提示）；克隆为 shallow（App 做"版本更新"需处理 fetch 深度）。

---

## 附：侦查台账（本次实际动过的检查）

- 目录扫描：`D:\HanakoWorks`、`D:\` 根、`D:\syc`、`C:\Users\John Galt`（find/glob）、桌面/下载/文档、开始菜单
- 运行态：`netstat -ano`（8188）、`GET /system_stats`、`Get-CimInstance Win32_Process`、HKCU Run、Startup、计划任务
- 仓库核查：git log/branch/remote/status/shallow、`comfyui_version.py`、pip list、site-packages 结构、user 设置
- 文卷线索：`D:\HanakoWorks\_temp` 脚本群与安装日志、`_delivery` 配方、hana-downloader 提示词、AI日报归档
- 已排除：桌面/开始菜单快捷方式（无）、其他 Python 环境的 comfyui 包（无）、D:\ 内其他 ComfyUI 副本（仅 `D:\ComfyUI` 一处）
