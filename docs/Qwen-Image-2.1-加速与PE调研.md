# Qwen-Image-2.1 官方模板下载 + 加速节点与 PE 调研

- 调研时间：2026-09-26 00:2x（北京时间）
- 口径：**实测** = 本次直接观测/抓取到的证据；**推断** = 由实测推导，未经直接验证
- 本机环境：ComfyUI **v0.37.0**（`D:\ComfyUI\ComfyUI`，前端 1.53.6），RTX 4070 SUPER 12GB + 32GB RAM

---

## 一句话结论

- **官方模板**：Qwen-Image-2.1 官方在 ComfyUI 里一共 **3 个**模板（文生图 / 图像编辑 / 去背景），已下载到 `D:\HanakoWorks\ComfyUI\qwen21-templates\`。ComfyUI 自带的 Templates 侧栏里本来就有，本地 `D:\ComfyUI\_templates\` 也早存了两个。
- **"加速节点"没有一个统一节点**，是三层叠加：出图蒸馏（Viggle Turbo LoRA）+ 缓存复用（原生 EasyCache / QwenImage21Cache）+ 量化（int8/w4a8）。
- **PE 不是加速节点，是提示词增强模型**：官方的 `Qwen-Image-2.1-PE-T2I` / `PE-I2I`（Qwen3.5-VL 9B 微调）。ComfyUI **原生**就能用，靠内置的 `TextGenerate` 节点，不需要装任何第三方插件。

---

## 一、官方工作流模板（已下载）

来源（ComfyUI 官方仓库，main 分支）：`https://github.com/Comfy-Org/workflow_templates/tree/main/templates`

| 模板 | 文件名 | 内容 |
|---|---|---|
| 文生图 | `qwen21_official_t2i.json` | UNETLoader + CLIPLoader + TextEncodeQwenImage21 + ResolutionSelector + KSampler + VAEDecode + SaveImageAdvanced |
| 图像编辑 | `qwen21_official_image_edit.json` | 同上，多图片槽位（`image_1..16`）+ **QwenImage21Cache**（prefix KV cache） |
| 去背景 / 透明 | `qwen21_official_background_removal.json` | 利用原生 RGBA 通道做透明背景 |

落盘位置：`D:\HanakoWorks\ComfyUI\qwen21-templates\`
（从 GitHub 走 `ghproxy.net` 镜像直取，三个文件 37KB / 55KB / 52KB，实测 OK）

**官方推荐采样参数（实测自 docs.comfy.org 中文文档）**：`steps=25`、`cfg=1`、`euler` sampler、`simple` scheduler。
- 文生图：`ResolutionSelector` 设画幅，1.0 MP ≈ 1024×1024；原生 2K 就把目标设到 ~4.0 MP（2048×2048）。
- 图像编辑：`resolution=0` 让每张参考图保持自身尺寸。提示词用 `<image1>`、`<image2>` 按槽位索引图片。

想直接用：ComfyUI 里 `Templates`（模板侧栏）搜索 "Qwen Image 2.1" 就能加载，不必手动放文件。要放成自定义工作流：
```powershell
Copy-Item "D:\HanakoWorks\ComfyUI\qwen21-templates\*.json" "D:\ComfyUI\ComfyUI\user\default\workflows\" -Force
```

---

## 二、加速：三层，不冲突，可叠加

### 第 1 层 · 出图步数蒸馏（收益最大）

**Viggle Turbo（官方蒸馏，非第三方 LoRA）** 是目前 2.1 的主力：

| 版本 | 步数 | 文件 | 适用 |
|---|---|---|---|
| v0.1 | 4 步 | `Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors` | 参考留存 |
| v0.2 | 5 步 | `...-v0.2-5step-lora-r256.safetensors` | 参考留存 |
| **v0.2.1** | **6 步** | `Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors` | **推荐用这个** |

- 原始仓库：`https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo`（含 ComfyUI 自定义节点 + 现成工作流）
- **ComfyUI 转换版**（键名已转，直接能加载）：`https://huggingface.co/t8star/Qwen-Image-2.1-viggle-turbo-4step-r64-comfy`
  → 放 `ComfyUI/models/loras/`，接 `LoraLoaderModelOnly`，`strength_model=1.0`，**4 步 / CFG 1.0 / 空负面提示词**
  ⚠️ 该转换版作者自己标注"尚未完成独立的完整出图验收"，属于社区转换，不是官方出品。
- **GGUF 版**（把蒸馏后的完整 transformer 转 GGUF，免堆 LoRA）：`https://huggingface.co/Abiray/Qwen-Image-2.1-viggle-4-steps-turbo-GGUF`

### 第 2 层 · 缓存复用（免训练，挂了就提速）

ComfyUI v0.37.0 **原生就有**（实测 grep 本机源码 `comfy_extras/nodes_easycache.py`）：

| 节点 | 作用 | 关键参数（默认值） |
|---|---|---|
| `EasyCache` | 按输入变化率跳过冗余采样步 | `reuse_threshold=0.2`、`start_percent=0.15`、`end_percent=0.95` |
| `LazyCache` | 同上，另一套缓存策略 | 同上 |
| `QwenImage21Cache` | 编辑任务专用：跨步复用文本+参考图前缀（prefix KV cache） | 官方模板默认即可 |

`QwenImage21Cache` 在官方编辑模板里**已经内建**，不用自己加。EasyCache/LazyCache 是通用 Model 级节点，串在 `UNETLoader` 之后、`KSampler` 之前即可。

### 第 3 层 · 量化

Comfy-Org 官方仓库同时提供多档权重（`https://huggingface.co/Comfy-Org/Qwen-Image-2.1`）：

- DiT：`qwen_image_2.1_bf16.safetensors`（13.25GB）/ `qwen_image_2.1_int8_convrot.safetensors`
- 文本编码器：`qwen3vl_8b_bf16` / `qwen3vl_8b_int8_convrot` / `qwen3vl_8b_w4a8`
- **本机现有 = bf16 DiT + int8_convrot 文本编码器**（对应 `qwen3vl_8b_int8_convrot`）

### 框架级（非 ComfyUI，供了解）
- **LightX2V**（ModelTC）Day-0 支持 2.1，走 Docker，是 CLI / HTTP 服务方案，**不是 ComfyUI LoRA**。KPI（5090、40 步、CFG off）：1K T2I 5.6s、2K 30.3s。`https://github.com/ModelTC/LightX2V/tree/main/scripts/qwen_image_21`
- **vLLM-Omni / SGLang** 同样 Day-0 支持，属服务端高吞吐方案。
- **Nunchaku（SVDQuant 4-bit）**：目前确认支持的是 Qwen-Image / Qwen-Image-2512，**2.1 是否已支持未确认**（推断：尚无官方发布）。

---

## 三、PE（Prompt Enhancement）怎么搞

**PE = 官方的提示词增强模型**，把短提示词扩写成详细的、带画幅建议的高质量提示词。两个九B模型（Qwen3.5-VL 微调）：

- T2I：`Qwen/Qwen-Image-2.1-PE-T2I`（`https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I`）
- I2I（看图改写）：`Qwen/Qwen-Image-2.1-PE-I2I`（`https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I`）

输出结构：`{"rewritten_prompt": "...", "wh_ratio": "16:9", "ratio_follow": "<image1>"}`（二者互斥）。

### 路线 A · ComfyUI 原生（推荐，本机可直接上）

Comfy-Org 已把 PE **打包成 ComfyUI text encoder**（int8_convrot），配 **内置 `TextGenerate` 节点**（本机实测存在：`comfy_extras/nodes_textgen.py`，display name "Generate Text"，category `text`）。

1. 下载（走 hf-mirror）：
   - `text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors`
   - `text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors`
   基础 URL：`https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/`
2. 放 `D:\ComfyUI\ComfyUI\models\text_encoders\`
3. 工作流：`CLIPLoader`（选 PE text encoder）→ `TextGenerate`（`prompt` 填原始需求，编辑任务接 `image` 输入）→ 输出的 `generated_text` 接 `TextEncodeQwenImage21` 的文本输入。

`TextGenerate` 有个 **`mtp` 参数**（multi-token prediction 投机解码，`auto`/`off`/`2`~`5`）：PE 模型带 MTP 头时开启可把提示词生成快 **1.4~1.7×**（社区实测）。这正是 Reddit 那个帖子标题的来源。默认 `auto` 即可。

### 路线 B · 第三方 GGUF（省显存）

- 节点：`https://github.com/T8mars/Comfyui-Qwen-Image-Prompt-Rewrite-T8`（ComfyUI Registry: `t8star/qwen-image-prompt-rewrite-t8`）
- GGUF 权重镜像：`https://huggingface.co/t8star/qwen-image-2.1-comfy`（Q4_K_M，约 5~6GB）
- 需要额外装 `llama-server`（节点目录跑 `tools/download_runtime.ps1`）
- 节点：`PE Rewrite T8` / `PE Canvas T8` / `PE Unload T8` / `PE Local Models T8`
- 优点：Q4 量化省显存；缺点：多一个 llama-server 进程，I2I 必须配对应 BF16 mmproj 视觉组件

### 路线 C · 官方脚本（不用 ComfyUI）
`https://github.com/QwenLM/Qwen-Image-2.1` 的 `prompt_rewrite/` 目录，`run_transformers.py` 或 `run_vllm.py`，`--task t2i|edit`。

### ⚠️ 12GB 显存注意
PE 是 9B 模型，**和 DiT 是两个独立的动态模型**。社区实测：一个动态模型已在 VRAM 时，第二个会被迫也挤在 VRAM 里 → 12GB 卡上需要靠 offload 兜。本机跑 bf16 DiT 本来就已经是 offload 状态（历史记录 25 步 1024px ≈ 40s），加 PE 后建议：用 int8 版 PE，或走路线 B 的 GGUF 让 PE 独立跑在 llama-server 上不占主进程显存。

---

## 四、本机现状与建议动作

**已有**（实测 `D:\ComfyUI\ComfyUI\models\`）：
- `diffusion_models/qwen_image_2.1_bf16.safetensors`、`text_encoders/qwen3vl_8b_int8_convrot`（8.71GB）、`vae/qwen_image_2.1_vae_bf16` ✅ 出图链路完整

**缺 / 可选补**：
1. PE text encoder ×2（约 9GB/个）→ 要 PE 就下路线 A 的两个 int8 文件
2. Viggle Turbo 6 步 LoRA（约 1~2GB）→ 要出图提速就下
3. 模板已在 `qwen21-templates\`，无需再下

---

## 五、来源

- 官方文档（中文）：https://docs.comfy.org/zh/tutorials/image/qwen/qwen-image-2-1
- 官方仓库：https://github.com/QwenLM/Qwen-Image-2.1
- ComfyUI 权重重打包：https://huggingface.co/Comfy-Org/Qwen-Image-2.1
- 官方模板源：https://github.com/Comfy-Org/workflow_templates/tree/main/templates
- Viggle Turbo：https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo
- T8 PE 节点：https://github.com/T8mars/Comfyui-Qwen-Image-Prompt-Rewrite-T8
- LightX2V 部署：https://github.com/ModelTC/LightX2V/tree/main/scripts/qwen_image_21
