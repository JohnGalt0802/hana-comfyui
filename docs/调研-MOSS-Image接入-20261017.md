# MOSS-Image 调研与接入方案（2026-10-17）

> **这是什么**：OpenMOSS 于 2026-10-16 开源的图像生成模型 MOSS-Image 的完整调研，含模型规格、推理参数、ComfyUI 接入方式与本机部署结论。
> **结论先行**：官方自带 ComfyUI 插件，已装到 `custom_nodes/moss-image`；权重约 27GB，落在 `models/diffusers/MOSS-Image-Base`；工作流见 `workflows/moss-image-分组版.json`。

---

## §1 模型身份

| 项 | 内容 |
|---|---|
| 发布方 | OpenMOSS（模思智能 / 复旦 MOSS 团队） |
| 仓库 | https://github.com/OpenMOSS/MOSS-Image |
| 发布日 | 2026-10-16 |
| 许可 | Apache-2.0 |
| 系列 | **MOSS-Image-Base**（纯基座，未做任何后训练/CFG 蒸馏）、**MOSS-Image-SFT**（在 curated 数据上微调，文字分组与版式更规整） |
| 架构 | **5B 单流 DiT**，基于 Muon 训练，异构 GPU 平台训练 |
| 关键能力 | 复杂中英文字渲染、Layout 版式控制、最长 4K token 提示词、动漫/写实双系 |

### 组件构成（实测自 model_index.json）

```
scheduler   : MOSSImageScheduler（pipeline_moss_image 内）
text_encoder: Qwen3_5Model        → Qwen3.5-9B（!! 9B，不是小模型）
tokenizer   : Qwen2Tokenizer
transformer : MOSSImageTransformer → dim 3072 / layers 42 / heads 24 / ffn 8192 / latent 128
vae         : AutoencoderKLFlux2   → latent_channels 32, force_upcast=true（FP32 解码）
```

⚠️ **重点**：文本编码器是 **Qwen3.5-9B**，不是 CLIP/T5。这是显存占用的真正大头。

### 权重体积（实测 ModelScope 文件清单）

| 目录 | 内容 | 体积 |
|---|---|---|
| `transformer/` | 3 片 | 4.99 + 4.98 + 0.19 GB ≈ **10.16 GB**（bf16 的 5B） |
| `text_encoder/` | 4 片 | 4.97 + 4.99 + 4.95 + 1.87 ≈ **16.79 GB**（bf16 的 9B） |
| `vae/` | 1 片 | **0.25 GB** |
| `tokenizer/` | tokenizer.json 19MB 等 | ~20 MB |
| **合计** | | **≈ 27.2 GB** |

---

## §2 推理参数（官方 USERGUIDE）

| 参数 | 推荐值 | 说明 |
|---|---|---|
| **分辨率** | 总像素 1M / 1.5M / 2M；支持 0.25M(512²) ~ 4M(2K) | **宽高必须是 16 的正整数倍**，否则报错 |
| **步数** | ≥ 50 | 官方说 50 步起效果最佳 |
| **CFG** | 3.0（范围 3.0~6.0） | 长提示词 3.0 够；**短提示词要调高** |
| **Shift** | 5.0 | 走 `ModelSamplingSD3` |
| **采样器** | euler + sgm_uniform | sgm_uniform 是 ComfyUI 侧的等价调度 |
| **SLG** | single_layers = **22**（0-indexed） | 22 / 24 / 26 都能提升画质；清空即关闭 |

### 关于 SLG 的重要实现细节（读源码确认）

- MOSS 的 transformer 只有 **single block**（`model.py` L222: `transformer_options["block_type"] = "single"`），所以 **只能用 `single_layers`，`double_layers` 必须留空**。
- 用 `SkipLayerGuidanceDiTSimple`（双趟采样版），不是 `SkipLayerGuidanceDiT`（标准 SLG）。
- `ModelSamplingSD3` 必须在 SLG **之前**，让调度与 SLG 阈值共用同一个 shift。
- 关闭 SLG 画面"非常真实"，但细节可能崩坏。

### 提示词要点

- **推荐英文**（训练量最多），中文也支持良好。
- 官方有效负向标签：`nsfw, worst quality, bad anatomy, watermark, jpeg artifact`
- 标签串顺序：Quality → Score → Meta → Year → Character → Series → Artist → General
- 文字渲染要精确断行时，**直接在提示词里敲真实换行或 `\n`**。

### Layout（布局）提示词 —— 实验性但很强

把正向提示词整段换成 JSON：

```json
{
  "summary": {
    "meta": ["poster"],
    "canvas": "single",
    "caption": "整体场景与风格描述"
  },
  "items": [
    { "label": "text",   "caption": "描述", "text": "要渲染的文字", "bbox": [y1,x1,y2,x2] },
    { "label": "object", "caption": "描述",                     "bbox": [y1,x1,y2,x2] }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- `bbox_format: yxyx` → 坐标顺序 `[y_min, x_min, y_max, x_max]`
- `bbox_coord_space: abs_centralized` → **以画布中心为原点的绝对像素**，1024² 画布范围 -512~+512。常规左上原点坐标减 W/2、H/2 转过来。
- `items[].label` 用 `text` / `object`；渲染文字时必须给 `text` 字段。
- 官方理由：绝对像素比相对坐标更适合不同分辨率/长宽比。

官方还提供了一个 **Prompt Enhancer skill**（`skills/moss-image-prompt-enhancer/`），把自然语言意图编译成 Layout JSON，自带 `scripts/compile_prompt.py` 做坐标换算与校验。注意它是"draft 用 xyxy 左上原点 → 编译成 yxyx 中心原点"。

---

## §3 ComfyUI 接入方式

### 官方插件（`comfyui/moss-image/`，v0.1.1，publisher=mosi）

**不下载 Hub 仓库 ID，只读本地目录**。目录必须含 `transformer/ text_encoder/ tokenizer/ vae/`。

节点清单（7 个）：

| 节点 ID | 显示名 | 输入 | 输出 |
|---|---|---|---|
| `MOSSImageHFLoader` | MOSS-Image HF Loader | model_path / weight_dtype / text_device | **MODEL + CLIP + VAE 三出** |
| `MOSSImageHFDiTLoader` | MOSS-Image HF DiT | model_path / weight_dtype | MODEL |
| `MOSSImageHFTextEncoderLoader` | MOSS-Image HF Text Encoder | model_path / device | CLIP |
| `MOSSImageHFVAELoader` | MOSS-Image HF VAE | model_path | VAE |
| `MOSSImageUNETLoader` | MOSS-Image Load Diffusion Model | unet_name / weight_dtype | MODEL |
| `MOSSImageCLIPLoader` | MOSS-Image Load Qwen3.5 | clip_name / device | CLIP |

`weight_dtype` 可选：`default / bf16 / fp32 / fp8_e4m3fn / fp8_e4m3fn_fast / fp8_e5m2`
`text_device` 可选：`default / cpu`

### 依赖项检查（本机 ComfyUI 0.39.0 全部满足）

| 依赖 | 状态 |
|---|---|
| `comfy.text_encoders.qwen35`（Qwen35Tokenizer / Qwen35） | ✅ 存在 |
| `comfy.sd.TEModel.QWEN35_9B` | ✅ 存在（=26） |
| `comfy.text_encoders.hunyuan_video.llama_detect` | ✅ 存在 |
| `comfy.latent_formats.Flux2` | ✅ 存在 |
| `EmptyFlux2LatentImage`（`comfy_extras/nodes_flux.py`） | ✅ 存在 |
| `SkipLayerGuidanceDiTSimple`（`comfy_extras/nodes_slg.py`） | ✅ 存在 |
| transformers 5.15.1 / diffusers 0.40.0 / torch 2.11.0+cu128 / py3.12.13 | ✅ |
| 插件 import 实测 | ✅ `IMPORT OK`，7 个节点类全部注册 |

> 插件 `pyproject.toml` 声明 `dependencies = []`，因为它复用 ComfyUI 自身依赖，无需 pip 安装。

### 官方示例工作流拓扑

```
MOSSImageHFLoader ─┬─MODEL→ ModelSamplingSD3(shift5) → SkipLayerGuidanceDiTSimple(single=22) ┐
                   ├─CLIP → CLIPTextEncode(+) ───────────────────────────────────────────────┤
                   ├─CLIP → CLIPTextEncode(−) ───────────────────────────────────────────────┤
                   └─VAE  ───────────────────────────────────────────────┐                  │
EmptyFlux2LatentImage(1024²) ─────────────────────────────────────────────┤                  │
                                                                          ↓                  ↓
                                                                       KSampler(50/3/euler/sgm_uniform)
                                                                          ↓
                                              VAEDecode(vae from loader) → SaveImage
```

---

## §4 本机部署结论

| 项 | 实测值 | 影响 |
|---|---|---|
| GPU | RTX 4070 SUPER **12GB** | DiT 10GB 可放，9B 文本编码器放不下 |
| RAM | 31.8GB（空闲约 5.8GB） | 9B bf16 编码器 16.8GB 需内存承载 |
| 磁盘 D | 空闲 401GB | 27GB 权重无压力 |
| ComfyUI | 0.39.0，venv py3.12，torch 2.11+cu128 | 兼容 |

**显存策略**：
1. 默认 `weight_dtype=default`（bf16），ComfyUI 用 `CoreModelPatcher` 动态加载 + offload，DiT 能在 12GB 上跑。
2. `text_device=default` 时文本编码器会尽量上卡，**12GB 会紧张**；如果 OOM，改成 `cpu`。
3. 还有一条路：`weight_dtype=fp8_e4m3fn` 把 DiT 压到 ~5GB，给文本编码器腾空间。**画质有轻微损失，先试默认值**。
4. VAE 固定 FP32（官方设计，`force_upcast=true`）。

**注意**：这台机器 ComfyUI 是计划任务 `HanaComfyUI-Backend` 拉起的常驻服务，进程 PID 17364（uv python，占 8188）。新增 custom_nodes 后**必须重启 ComfyUI 后端服务**才会注册节点。

---

## §5 已落地产物

| 产物 | 路径 |
|---|---|
| 官方插件 | `D:\ComfyUI\ComfyUI\custom_nodes\moss-image\`（7 文件 + example_workflows） |
| 权重 | `D:\ComfyUI\ComfyUI\models\diffusers\MOSS-Image-Base\`（**25.35 GB**，8 个 safetensors） |
| 分组工作流 | `D:\ComfyUI\ComfyUI\user\default\workflows\moss-image-分组版.json` |
| 官方原版工作流 | `D:\ComfyUI\ComfyUI\user\default\workflows\moss-image-官方原版.json` |
| 工作流仓库副本 | `D:\HanakoWorks\ComfyUI\workflows\moss-image-分组版.json` |
| 成品样张 | `D:\HanakoWorks\ComfyUI\outputs\moss-poster-1024x1024-50steps.png` |
| 冒烟样张 | `D:\HanakoWorks\ComfyUI\outputs\moss-smoketest-768x768-12steps.png` |
| 生成 / 验证脚本 | `D:\HanakoWorks\ComfyUI\_scratch\build_moss_workflow.py`、`verify_moss.py`、`verify_moss_final.py` |

### 工作流分组结构（6 箱）

| # | 分组 | 内容 |
|---|---|---|
| ① | 模型加载 | MOSSImageHFLoader（指向 diffusers 目录） |
| ② | 提示词 | CLIPTextEncode 正 / 负 |
| ③ | 画布 | EmptyFlux2LatentImage（尺寸 + 批量） |
| ④ | 采样 | ModelSamplingSD3(shift) → SkipLayerGuidanceDiTSimple(SLG) → KSampler |
| ⑤ | 解码输出 | VAEDecode → SaveImage |
| 📖 | 使用要点 | Note 节点，参数速查 |

---

## §6 实测结果（2026-10-17 22:19 / 22:22）

### 冒烟测试

| 项 | 值 |
|---|---|
| 配置 | 768×768 · 12 步 · CFG 3 · euler/sgm_uniform · shift 5 · SLG single=22 |
| `text_device` | `cpu` |
| 总耗时 | **75.1 秒**（含首次权重加载与模型初始化 7.9s） |
| 采样速度 | **≈ 1.05 it/s**（0.95 s/step） |
| 产物 | `moss-verify_00001_.png` |

### 正式参数验证

| 项 | 值 |
|---|---|
| 配置 | **1024×1024 · 50 步 · CFG 3** · euler/sgm_uniform · shift 5 · SLG single=22 |
| `text_device` | **`default`（上卡，显存够用）** |
| 总耗时 | **114.1 秒** |
| 产物 | `moss-poster_00001_.png` |

### 文字渲染实测

中文海报场景（标题「苔藓」+ 副标题「微小之处，自有宇宙」+ 英文角标「MOSS-IMAGE · 5B DiT」）：

- **三处文字全部正确**，无错字、无乱码、无糊字
- 中英文混排、字号层级、位置关系都符合提示词描述
- 自动按提示词里的换行做了排版

这是 MOSS-Image 相对其他开源模型的真正差异点：**文字即内容**，不是装饰。

### 12GB 显存结论

**能跑，不需要 fp8 量化**。`weight_dtype=default`（bf16）+ `text_device=default` 在 RTX 4070 SUPER 12GB 上跑 1024²/50 步无 OOM，峰值显存占用可控（ComfyUI 的 CoreModelPatcher 动态加载兜住了）。

---

## §7 踩坑记录

| # | 坑 | 正解 |
|---|---|---|
| 1 | **ModelScope 仓库 git clone 会卡死**：26 个对象拉完，27GB LFS 权重一个不下 | 改用 `resolve/master/<path>` 直链逐文件下载 |
| 2 | **并发下载 7 个大文件会全部停滞**（.part 停在 0 字节） | 一次只下一个大文件；小文件可并发 |
| 3 | `hf.py` 的 `read_weights()` **校验极严**：每个分片内容必须与 index 声明的 key 集合完全一致 | 分片必须下全，缺一片或半片直接报 `Shard contents do not match index` |
| 4 | 暂停/中断下载会留 0 字节 `.part` | 重新发起前先清 `.part` |
| 5 | `double_layers` 不能填值 | MOSS 只有 single block，填了会静默失效 |
| 6 | HuggingFace 直连不通（本机），ModelScope 正常 | 权重走 ModelScope 镜像 |
| 7 | 新装 custom_nodes **必须重启 ComfyUI 后端**才注册节点（计划任务拉起，独立于 Hana） | 用 hui 的 `service` op=stop 再 op=start，约 26s 就绪 |
| 8 | 节点/分组的 `color` 字段用 3 位简写（`#88a`）有解析风险 | 统一写 6 位（`#8888aa`） |
