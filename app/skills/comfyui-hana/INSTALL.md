# ComfyUI 安装引导（Windows 主线）

> 面向：Hana 助手（agent）与动手能力较强的用户；配合 ComfyUI-Hana 工作区使用。
> 场景：本机没有 ComfyUI（或环境损坏需重装），需要装好并以 `127.0.0.1:8188` 提供服务。
> 原则：每步都有「预期结果」与「失败对策」；不确定就停下来问用户，不要连续盲试。
> 环境：Windows 10/11 + NVIDIA 显卡为主线；AMD / Intel / 无独显 / macOS / Linux 见 §10。

**给 agent 的执行提示**：每完成一个阶段（克隆完 / 依赖装完 / 服务起来）向用户简短汇报一次进度；
涉及数 GB 下载的步骤先告知用户大概耗时；装之前与用户确认安装盘与目录；报错先按「失败对策」处理，
仍不通就停下诊断，把错误原文交给用户或主脑，不要连续盲试。

---

## 0. 先判断：装没装？

按顺序执行，任一命中即说明"已装"，直接跳到 §6：

```powershell
# ① 服务是否在跑
Invoke-RestMethod http://127.0.0.1:8188/system_stats

# ② 常见位置探测（ComfyUI-Hana 自带，只读；Hana 数据目录自定义时按实际替换路径）
node "$env:USERPROFILE\.hanako\apps\comfyui-hana\runtime\comfy-relay.mjs" --probe-env

# ③ 粗扫盘补漏（可选）
Get-ChildItem C:\,D:\,E:\ -Directory -ErrorAction SilentlyContinue | Where-Object Name -match 'Comfy'
```

判定：
- ① 成功 → 已装且运行中。
- ② `found=true` → 已装未跑：用 `installs[].mainPy` 的父目录作为「安装根」，跳 §6 启动。
- 都没有 → 从 §1 开始安装。

## 1. 前置准备

### 1.1 目录与磁盘
- 预留 ≥ 20 GB（程序 + 依赖 ≈ 6 GB；模型另算，单个模型 2~20 GB 常见）。
- 路径用纯英文、无空格，建议 `D:\ComfyUI`（盘符按用户实际情况）。

### 1.2 Git
```powershell
git --version
```
没有 → `winget install Git.Git`（或 https://git-scm.com/download/win），装完重开终端。

### 1.3 Python 3.13（或 3.12）
推荐 uv（轻量、可管理多版本）：
```powershell
winget install astral-sh.uv
# 或官方脚本（winget 不可用时）：
# powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv python install 3.13
```
> 官方口径：Python 3.13 支持很好；个别自定义节点不兼容时改用 3.12。3.14 可用但暂不推荐。
> 备选：python.org 安装包（安装时勾选 Add python.exe to PATH）。

### 1.4 NVIDIA 驱动
```powershell
nvidia-smi
```
记录右上角 `CUDA Version`（驱动支持上限），§4 选择 torch 版本要用。

## 2. 获取 ComfyUI 代码

```powershell
New-Item -ItemType Directory -Force D:\ComfyUI | Out-Null
cd D:\ComfyUI
git clone https://github.com/comfyanonymous/ComfyUI
# 直连失败时用镜像（国内实测可用）：
# git clone https://ghproxy.net/https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
git log -1 --oneline
```
预期：克隆完成，`D:\ComfyUI\ComfyUI\main.py` 存在。
> 结构：`D:\ComfyUI\ComfyUI` 是仓库；下一步把 venv 建在兄弟目录 `D:\ComfyUI\venv`（脚本/日志也放外层，保持仓库干净）。

## 3. 创建 Python 环境（venv）

```powershell
cd D:\ComfyUI
uv venv --python 3.13 --seed D:\ComfyUI\venv
D:\ComfyUI\venv\Scripts\python.exe --version
```
预期：打印 `Python 3.13.x`。
> `--seed` 让 venv 自带 pip（后文命令统一用 `venv\Scripts\python.exe -m pip`）。
> 非 uv 路线：`python -m venv D:\ComfyUI\venv`。

## 4. 安装 PyTorch（CUDA 版）

按 §1.4 记录的 `CUDA Version` 选主版本：

| 驱动 CUDA Version | 安装用 cu 版本 | 说明 |
|---|---|---|
| ≥ 13.0 | **cu130** | 官方当前推荐（NVIDIA 20 系及以上） |
| 12.8 ~ 12.9 | cu128 | 驱动略旧时用 |
| 12.6 ~ 12.7 | cu126 | 更旧驱动；或升级驱动后用 cu130 |

```powershell
# 以 cu130 为例（其它版本把结尾 cu130 换掉）：
D:\ComfyUI\venv\Scripts\python.exe -m pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130
```
预期：下载约 3~4 GB 的包（耗时取决于网络；国内直连 pytorch.org 一般可用，很慢就换时段）。
验证：
```powershell
D:\ComfyUI\venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```
预期：`2.x.x+cu130 True`。
失败对策：输出 `False` → 版本与驱动不匹配，`python.exe -m pip uninstall torch torchvision torchaudio` 卸载后换 cu 版本重装。

## 5. 安装其余依赖

```powershell
cd D:\ComfyUI\ComfyUI
D:\ComfyUI\venv\Scripts\python.exe -m pip install -r requirements.txt -i https://mirrors.tuna.tsinghua.edu.cn/pypi/simple
```
预期：全部安装完成，无红色报错（约几分钟）。
> 顺序关键：**先 torch 后 requirements**（requirements 不含 torch，不会互相覆盖）。
> 清华源失败可换阿里源 `https://mirrors.aliyun.com/pypi/simple`。

## 6. 启动与验证

```powershell
cd D:\ComfyUI\ComfyUI
D:\ComfyUI\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188
```
预期日志末尾出现：`To see the GUI go to: http://127.0.0.1:8188`（首次启动可能多等 30~60 秒）。
另开一个终端验证：
```powershell
Invoke-RestMethod http://127.0.0.1:8188/system_stats
```
预期：返回 JSON，含 `comfyui_version` → 成功，去 §9 接入。

### 6.1 常驻启动脚本（建议）

把下面存为 `D:\ComfyUI\start-comfyui.ps1`，以后一条命令拉起：

```powershell
# start-comfyui.ps1 — 清理残留 → 隐藏窗口启动 → 等就绪（最多 120s）
$ErrorActionPreference = "SilentlyContinue"
$root = "D:\ComfyUI"
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -match "main\.py" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process -FilePath "$root\venv\Scripts\python.exe" `
  -ArgumentList "main.py --listen 127.0.0.1 --port 8188" `
  -WorkingDirectory "$root\ComfyUI" -WindowStyle Hidden `
  -RedirectStandardOutput "$root\comfyui.log" -RedirectStandardError "$root\comfyui.err.log"
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Milliseconds 500
  try { $null = Invoke-RestMethod "http://127.0.0.1:8188/system_stats" -TimeoutSec 2; Write-Output "ComfyUI 已就绪"; exit 0 } catch {}
}
Write-Output "等待超时：请看 $root\comfyui.err.log"; exit 1
```

> 注意：ComfyUI 的运行日志主要走 stderr（落在 `comfyui.err.log`）。

## 7. 模型准备（可选，迟早要用）

- 模型目录：`D:\ComfyUI\ComfyUI\models\<类别>\`（checkpoints / diffusion_models / text_encoders / vae / loras …，放错子目录会"看不到模型"）。
- 国内下载走镜像：先设环境变量 `$env:HF_ENDPOINT = "https://hf-mirror.com"`，再用 huggingface-cli / 下载脚本拉取（官方直连国内常失败）。
- 没有模型也能先验证链路：工作区里跑 `EmptyImage → SaveImage`（纯 CPU、零模型）。
- 具体选什么模型、放哪个子目录：让 Hana 按用途给出清单与目标路径。

## 8. 常见问题

| 症状 | 对策 |
|---|---|
| clone 失败/极慢 | 换 ghproxy.net 镜像；或换时段 |
| pip 安装失败/超时 | 换镜像源；大包失败重试；检查代理 |
| `torch.cuda.is_available()` False | 卸载 torch 三件套，按 §4 选对 cu 版本重装 |
| 启动报端口占用 | 已有实例在跑（`netstat -ano | findstr 8188`），先清理或换 `--port` |
| 启动日志有 triton/xformers 警告 | Windows 正常现象，可忽略 |
| 启动立刻退出 | 看 `comfyui.err.log` 尾巴；常见为依赖缺装/环境损坏 |
| OOM（显存不足） | 换小模型/量化版；默认显存调度会先扛，别急着加参数 |
| 路径含中文/空格出问题 | 换纯英文路径重装（最省事） |
| 杀软拦截 python | 安装目录加白名单 |
| 页面打开但空白 | 等几秒；看浏览器控制台与 `comfyui.err.log` |

## 9. 接入 ComfyUI-Hana 并验证

1. 服务在 `127.0.0.1:8188` 上跑着 → 打开/刷新「ComfyUI 工作区」卡（中继每 5s 探测，自动恢复）。
2. 让 Hana 验证：`comfyui(action="status")` 应显示后端可达。
3. 首次连通测试（纯 CPU、零模型）：
   ```
   comfyui(action="submit",
     workflow={"1":{"class_type":"EmptyImage","inputs":{"width":64,"height":64,"batch_size":1,"color":0}},
               "2":{"class_type":"SaveImage","inputs":{"images":["1",0],"filename_prefix":"comfyui_hana_test"}}})
   ```

## 10. 其他平台 / 显卡变体

- **官方 Desktop 应用**（最省事，但独立生态）：https://comfy.org/download —— 装好后确认它监听的端口与安装位置。
- **官方便携包**（Windows）：release 页下载 `ComfyUI_windows_portable_nvidia.7z`（当前内置 py3.13 + cuda13，需较新驱动；老 GPU 用 cu126 变体）。
- **AMD（Windows）**：AMD 官方 ROCm PyTorch 包（见 AMD 文档，py3.13）。
- **AMD（Linux）**：`pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm7.2`。
- **Intel Arc**：`pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu`。
- **无独显（CPU）**：torch 换 CPU 源 `https://download.pytorch.org/whl/cpu`，出图慢但可用。
- **macOS（Apple Silicon）**：装 PyTorch nightly（MPS 后端），流程同 §2~§6，路径示例 `~/ComfyUI`。
- **Linux**：同流程，把 git/Python 换成发行版方式安装。

## 11. 完成自查清单

- [ ] `git log -1 --oneline` 能输出（仓库完好）
- [ ] `venv\Scripts\python.exe --version` 版本正确
- [ ] `torch.cuda.is_available()` 为 True（NVIDIA 卡）
- [ ] `GET /system_stats` 返回 200
- [ ] ComfyUI-Hana 工作区显示后端可达
