# Qwen-Image-2.1 三层加速工作流 · 使用说明

生成时间：2026-09-26
基底：Viggle 官方 ComfyUI t2i 工作流（`Qwen-Image-2.1-viggle-turbo-t2i.json`）
产物：`D:\HanakoWorks\ComfyUI\qwen21-templates\qwen21-viggle-turbo-easycache.json`

---

## 一、三层加速分别落在哪

| 层 | 机制 | 工作流里的落点 | 当前状态 |
|---|---|---|---|
| **1 · 步数蒸馏** | Viggle Turbo DMD 蒸馏，40 步 → **6 步**，无 CFG | `ViggleTurboLora`（unmerged 加载 LoRA）+ `ViggleTurboSigmas`（6 步 sigma 表） | 需装节点 + 下 LoRA（见下）|
| **2 · 跳步缓存** | 跳过变化率低于阈值的采样步 | 新增的 **`EasyCache`** 节点，串在 LoRA 与 BasicGuider 之间 | 已接入，默认启用 |
| **3 · 量化** | int8 权重减小显存占用 / 传输量 | `UNETLoader` 的模型文件 + `CLIPLoader` | 文本编码器已是 int8；DiT 用 bf16 |

链路（改造后）：`UNETLoader → ViggleTurboLora → EasyCache → BasicGuider → SamplerCustomAdvanced`

---

## 二、安装三步

1. **自定义节点**（已放好）：`viggle_turbo.py` → `D:\ComfyUI\ComfyUI\custom_nodes\`
   ⚠️ 是直接放在 custom_nodes 根下，不要套子目录。
2. **LoRA**（已下好，679,604,800 字节）：
   `Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors`
   → `D:\ComfyUI\ComfyUI\models\loras\`
   源（走 hana-downloader 的 `download-file`，hf-mirror 源实测 ~24 MB/s）：`https://hf-mirror.com/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/main/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors`
3. **重启 ComfyUI**（加载自定义节点与新 LoRA 列表）。

工作流拖进 ComfyUI 即可。

---

## 三、运行参数（不能乱改）

出自 Viggle 官方 README，改动前先读它的 "Rules that matter"：

- `steps = 6`，sigma 表 `1.0, 0.9375, 0.875, 0.75, 0.5, 0.25`（由 `ViggleTurboSigmas` 节点产出）
- **CFG 关闭**，负面提示词留空（工作流用 `BasicGuider`，本来就没有 CFG）
- LoRA `strength = 1.0`
- **LoRA 必须走 `ViggleTurboLora`，不要换成普通的 `LoraLoaderModelOnly`**。普通 loader 会把 LoRA merge 进权重，对 bf16 只保留约 70% 的更新量；Viggle 这个节点是运行时旁路（`y = Wx + BAx`），无损。
- 改步数时**只在噪声高端加/减**：6 步固定，或 5 步 `1.0, 0.875, 0.75, 0.5, 0.25`、8 步 `1.0, 0.9375, 0.875, 0.75, 0.625, 0.5, 0.25, 0.125`（8 步对小字更清楚）。`0.875, 0.75, 0.5, 0.25` 这四个低噪点不能动。

---

## 四、三个必须知道的注意点

### 1. 缓存层和蒸馏层在原理上是打架的
Turbo 已经把步数压到 6，`EasyCache` 再跳步，能省的很有限（6 步里顶多跳 1~2 步），而且 6 步 schedule 是蒸馏训练时精心设计的，跳步可能伤质量。
**建议**：先用默认（缓存开着）出图，再选中 `EasyCache` 按 `Ctrl+B` 旁路，同一 seed 对比。质量下降就保持旁路；`EasyCache` 真正的用武之地是跑 25/40 步基础模型时。

### 2. 量化层在你这台机器上历史上是负收益
本机 9-21 实测过一轮：25 步 1024px，**int8 55s / bf16 40s**，int8 反而更慢，当时因此只留了 bf16。
所以工作流默认用 `qwen_image_2.1_bf16.safetensors`。想自己复测就把 `UNETLoader` 换成 `qwen_image_2.1_int8_convrot.safetensors`（需先下载，约 7.3GB）。这条结论只在 12GB 卡 + offload 场景下成立，不代表 int8 本身不好。
**已经生效的量化**：`CLIPLoader` 用的是 `qwen3vl_8b_int8_convrot`，文本编码器这一半本来就是 int8。

### 3. PE 组是关着的
工作流里带了 Viggle 的提示词增强组（`TextGenerate`），默认 `Enhance prompt = false`，因为本机还没装 PE 文本编码器。要用 PE 见另一份调研文档的「PE 怎么搞」。

另：Viggle README 提到，NVIDIA 驱动低于 580 时 `TextGenerate` 可能因 comfy_kitchen 的 CUDA 13 kernel 报错——这也是先关着的一个理由。

---

## 五、想要编辑版？

Viggle 也提供了 `Qwen-Image-2.1-viggle-turbo-edit.json`（带 1~3 张参考图），它的编辑链路自带 `QwenImage21Cache`（另一个缓存层）。需要的话照同一路子改：装节点 → 下 LoRA → 补一层 `EasyCache`。
