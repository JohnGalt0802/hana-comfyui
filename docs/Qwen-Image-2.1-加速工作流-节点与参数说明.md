# Qwen-Image-2.1 三层加速工作流 · 节点与参数说明

对应工作流：`Qwen21 Turbo EasyCache t2i.json`（hana-comfyui 工作流库 / `qwen21-templates/`）
基底：Viggle 官方 ComfyUI t2i 工作流 + 我方新增 `EasyCache`
环境：ComfyUI 0.37.0 · RTX 4070 SUPER 12G · 实测 6 步 / 1248×832 / 23 秒

---

## 0. 数据流总览

```
UNETLoader ─► ViggleTurboLora ─► EasyCache ─┐
                                             ├─► BasicGuider ─┐
CLIPLoader ─► TextEncodeQwenImage21 ─────────┘                │
                                                              ├─► SamplerCustomAdvanced ─► VAEDecode ─► SaveImage
EmptyLatentImage ───────────────────────────┬─────────────────┘
                                            └─► ViggleTurboSigmas ─┘
RandomNoise ─► SamplerCustomAdvanced
KSamplerSelect ─► SamplerCustomAdvanced

（PE 组：Prompt ─► [可选] TextGenerate 改写 ─► TextEncodeQwenImage21.prompt ）
```

三层加速的落点：

| 层 | 节点 | 作用 |
|---|---|---|
| 1 步数蒸馏 | `ViggleTurboLora` + `ViggleTurboSigmas` | 40 步 → 6 步 |
| 2 跳步缓存 | `EasyCache` | 变化率低的采样步直接复用 |
| 3 量化 | `CLIPLoader`（int8 文本编码器） | 省显存；DiT 本机保留 bf16 |

---

## A. 模型加载

### #2 `UNETLoader` — 扩散主模型
加载 DiT 权重。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `unet_name` | `qwen_image_2.1_bf16.safetensors` | 主模型。可换 `qwen_image_2.1_int8_convrot.safetensors`（约 7.3 GB，更省显存；本机历史实测反而慢，见说明文档）|
| `weight_dtype` | `default` | 权重精度：`default`（按文件）／`fp8_e4m3fn`／`fp8_e4m3fn_fast`／`fp8_e5m2`。用官方文件时保持 default |

### #3 `ViggleTurboLora` — 加速 LoRA（**不可换成普通 LoRA 节点**）
Viggle 专门为 Qwen-Image-2.1 蒸馏的 Turbo LoRA，把 40 步压到 6 步、无需 CFG。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `model` | ← #2 | 上游模型 |
| `lora_name` | `Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors` | r128 版（680 MB）。仓库另有 r256（1.4 GB，质量略高、更慢）|
| `strength` | `1.0` | **保持 1.0**（alpha=rank）。这是该 LoRA 的训练设定 |

> **为什么必须用这个节点而不是 `LoraLoaderModelOnly`**：普通 LoRA 加载器会把权重 **merge 进主模型**，对 bf16 权重只保留约 70% 的更新量（部分早期 MLP 层只有约 40%）；Viggle 这个节点是运行时旁路 `y = Wx + BAx`，无损。代价是每步慢约 10~25%。

### #26 `EasyCache` — 跳步缓存（本工作流新增）
采样过程中，若某步输入变化率低于阈值，直接复用缓存结果，省掉该步的模型前向。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `model` | ← #3 | 上游模型 |
| `reuse_threshold` | `0.2` | 复用阈值，越大越激进、越可能伤质量（0~3.0）|
| `start_percent` | `0.15` | 从采样进度的 15% 处才开始考虑跳步 |
| `end_percent` | `0.95` | 到 95% 处停止 |
| `verbose` | `false` | 开启后控制台打印每个被跳过的步 |

> ⚠️ 6 步 Turbo 下它最多跳 1~2 步，收益有限；要判断值不值，把本节点 `Ctrl+B` 旁路、同 seed 对比。跑 25/40 步基础模型时它的价值才明显。

### #4 `CLIPLoader` — 文本编码器
把提示词编码成 DiT 能吃的条件。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `clip_name` | `qwen3vl_8b_int8_convrot.safetensors` | **Qwen3-VL 8B 的 int8 量化版**（量化层）。可换 `qwen3vl_8b_bf16`（17.5 GB，更占显存）|
| `type` | `qwen_image` | 必须选 `qwen_image`，否则编码语义不对 |
| `device` | `default` | `default`=GPU；`cpu`=放 CPU（极省显存但极慢）|

### #5 `VAELoader` — VAE
把潜空间解码回图像。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `vae_name` | `qwen_image_2.1_vae_bf16.safetensors` | 2.1 专用（64 通道 RGBA，原生支持透明）|

---

## B. 提示词

### #6 `PrimitiveStringMultiline`「Prompt」— 提示词输入
| 参数 | 当前值 | 说明 |
|---|---|---|
| `value` | 一段英文描述 | 多行文本框。Qwen-Image 2.1 对**英文描述性长句**响应最好 |

### PE 组（#9~#17）— 提示词增强，当前**关闭**
默认 `Enhance prompt = false`，因为本机未装 PE 文本编码器。要用见「PE 调研」文档。

| 节点 | 作用 | 关键参数 |
|---|---|---|
| **#9 `PrimitiveBoolean`**「Enhance prompt」| PE 总开关 | `value`：`true`=走 PE 改写，`false`=直接用原文 |
| **#10 `PrimitiveStringMultiline`**「PE system prompt」| PE 改写的系统提示词 | `value`：官方 Qwen-Image-2.1 T2I 改写规则原文 |
| **#11 `StringFormat`**「PE request」| 把系统提示词 + 画幅拼成完整请求 | `f_string`=模板 `{a}\nAspect ratio: {b}:{c}`；`values`=动态槽 |
| **#12 `TextGenerate`**「Rewrite prompt」| 调用 PE 模型做改写 | `clip`=PE 文本编码器；`prompt`=原始需求；`max_length`=512（最大生成长度）；`sampling_mode`=`off`/`on`（on 展开温度等采样参数）；`thinking`=是否开思考；`use_default_template`=是否用模型内置模板；`mtp`=`auto`/`off`/`2`~`5`（投机解码，**开 MTP 可快 1.4~1.7×**）|
| **#13 `JsonExtractString`** | 从改写结果里抠字段 | `json_string`=PE 输出的 JSON；`key`=`rewritten_prompt` |
| **#14 `StringCompare`**「Rewrite failed?」| 判断改写是否失败 | `string_a`/`string_b`；`mode`=比较方式；`case_sensitive` |
| **#15 `ComfySwitchNode`**「Fall back to the original prompt」| 失败就用原文 | `switch`、`on_true`/`on_false` |
| **#16 `ComfySwitchNode`**「Enhanced or original」| 按总开关二选一 | 出口接 #18 的 `prompt` |
| **#17 `PreviewAny`**「Prompt used」| 预览最终采用的提示词 | `source`（任意类型）|

---

## C. 尺寸

### #7 `ResolutionSelector`「Output size」— 画幅计算器
按「比例 + 总像素」算出宽高，接给 `EmptyLatentImage`。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `aspect_ratio` | `3:2 (Photo)` | 8 选：`1:1 (Square)`／`2:3 (Portrait Photo)`／`3:2 (Photo)`／`3:4 (Portrait Standard)`／`4:3 (Standard)`／`9:16 (Portrait Widescreen)`／`16:9 (Widescreen)`／`21:9 (Ultrawide)` |
| `megapixels` | `1` | 目标总像素（0.1~16.0）。**1.0 MP ≈ 1024×1024**；原生 2K 就把 1:1 调到 ~4.0 |
| `multiple` | `32` | 宽高取整到该倍数（8~128）。**必须 32 的倍数**，别改小 |
| `preview` | — | 前端实时预览（只读）|

> 本工作流 `3:2` + `1 MP` + `multiple 32` → **1248×832**。Viggle 训练尺寸是 1024² / 2048² 面积，别随意偏离太多。

### #8 `EmptyLatentImage` — 起始潜空间
| 参数 | 当前值 | 说明 |
|---|---|---|
| `width` / `height` | ← #7 | 由 ResolutionSelector 驱动 |
| `batch_size` | `1` | 一次出几张 |

---

## D. 条件与采样

### #18 `TextEncodeQwenImage21` — 文生图/编辑统一编码
| 参数 | 当前值 | 说明 |
|---|---|---|
| `clip` | ← #4 | 文本编码器 |
| `prompt` | ← #16 | 正向提示词 |
| `negative_prompt` | 空 | 负面提示词。**6 步 Turbo 下无 CFG，留空** |
| `resolution` | `1024` | 输出分辨率锚点。**编辑任务**：输出按第一张参考图宽高比缩放到该值；设 `0` 则保持各参考图原尺寸 |
| `images` | 空（t2i 不接）| 参考图槽位（`image_1`…`image_16`，提示词里用 `<image1>` 引用），编辑才用 |
| `vae` | 空 | 可选，编辑模式编码参考图时需要 |

### #19 `BasicGuider`「BasicGuider (CFG off)」— 无 CFG 引导器
把模型 + 条件打包成引导器。**不做分类器自由引导**（即无负面提示词、无 CFG 权重），正是 Turbo 的要求。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `model` | ← #26 | 模型（含 LoRA + 缓存）|
| `conditioning` | ← #18 | 条件 |

### #20 `RandomNoise` — 噪声种子
| 参数 | 当前值 | 说明 |
|---|---|---|
| `noise_seed` | `42` | 换种子＝换构图 |

### #21 `KSamplerSelect` — 采样器选择
| 参数 | 当前值 | 说明 |
|---|---|---|
| `sampler_name` | `euler` | Qwen-Image 官方指定 euler，**别换** |

### #22 `ViggleTurboSigmas` — 6 步噪声表（**改动高风险**）
输出 Turbo 训练时用的 sigma 调度（按分辨率做动态 shift），替代普通 KSampler 的 scheduler。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `latent` | ← #8 | 从 latent 尺寸推算分辨率 shift |
| `nodes` | `1.0, 0.9375, 0.875, 0.75, 0.5, 0.25` | 6 步的原始 sigma 节点 |

> **改动规则**（Viggle 官方）：只能在高噪端加减。
> - 5 步：`1.0, 0.875, 0.75, 0.5, 0.25`
> - 7 步：`1.0, 0.9583, 0.9167, 0.875, 0.75, 0.5, 0.25`
> - 8 步（小字更清晰）：`1.0, 0.9375, 0.875, 0.75, 0.625, 0.5, 0.25, 0.125`
> - **`0.875, 0.75, 0.5, 0.25` 这四个低噪点不能动**，动了整张图会明显发糊。
> - 别用均匀 linspace 或 CFG，对蒸馏学生没用。

### #23 `SamplerCustomAdvanced` — 分离式采样器
把噪声、引导器、采样器、sigma 表、latent 组装起来执行采样（与 `ViggleTurboSigmas` 配套，不是普通 KSampler）。

| 参数 | 当前值 | 说明 |
|---|---|---|
| `noise` | ← #20 | 噪声 |
| `guider` | ← #19 | 引导器 |
| `sampler` | ← #21 | 采样器 |
| `sigmas` | ← #22 | sigma 调度 |
| `latent_image` | ← #8 | 起始 latent |

---

## E. 解码与输出

### #24 `VAEDecode`
| 参数 | 当前值 | 说明 |
|---|---|---|
| `samples` | ← #23 | 采样结果 |
| `vae` | ← #5 | VAE |

### #25 `SaveImage`
| 参数 | 当前值 | 说明 |
|---|---|---|
| `images` | ← #24 | 图像 |
| `filename_prefix` | `Qwen_image_2.1` | 输出文件名前缀，落在 ComfyUI `output/` |

### #1 `MarkdownNote` — 官方说明
只读便签，记模型下载链接与用法，无功能。

---

## 何时该动哪个旋钮

| 想做的事 | 动哪里 |
|---|---|
| 换画幅/分辨率 | #7 `aspect_ratio` + `megapixels` |
| 换提示词 | #6 `value`（PE 关闭时）/ #9 打开 PE |
| 更快 | #22 降到 5 步；或 r128→ 关掉 EasyCache 对比 |
| 小字更清楚 | #22 改 8 步表 |
| 省显存（更慢） | #2 换 int8 主模型；#4 换更小编码器 |
| 换种子 | #20 |

**不要动**：#3 `strength`（保持 1.0）、#21 采样器（euler）、#22 的四个低噪点、#7 的 `multiple`（保持 32 的倍数）。
