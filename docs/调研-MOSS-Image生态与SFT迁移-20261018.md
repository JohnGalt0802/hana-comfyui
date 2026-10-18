# MOSS-Image 生态调研：SFT vs Base、加速 LoRA 与官方工作流（2026-10-18）

> **这是什么**：MOSS-Image 发布两天后（10-16）的社区生态普查，重点是「出图该用哪个模型」「有没有现成的加速方案」「官方 ComfyUI 工作流怎么配」。
> **结论先行**：一直在 Base 上调参数是方向性错误。Base 是给微调和训 LoRA 用的毛坯，出图该用 **SFT**。社区已有 8 步 DMD 蒸馏 LoRA（3 万下载/月）。官方 ComfyUI 模板用 `er_sde` + 25 步 + CFG 2.5，与我们试的 euler 50 步 / res_multistep 完全不同。

---

## §1 最重要的发现：Base ≠ 出图模型

多个官方来源一致：

| 来源 | 原话 |
|---|---|
| ComfyUI 官方文档 | 「**SFT** 适合更整洁的布局，**Base** 适合微调与 LoRA 工作」 |
| Civitai 官方文章 | 「SFT 是微调版，也是 OpenMOSS 推荐用于**生成**的那个。从它开始。」 |
| HF MOSS-Image-SFT 卡片 | 「OpenMOSS recommends it for generation: cleaner text grouping and more organised layouts」 |
| Reddit 用户实测 | 「SFT 版更稳定，但牺牲了创造力。Base 能输出一堆垃圾，但也能做出一些……」 |

**推论**：2026-10-17 那轮在 Base 上做的采样器实验（euler 50 步 / res_multistep 15 步 / EasyCache / LazyCache），全部建立在一个「不以出图见长」的模型上。结构崩、细节糊，不能全归因于采样器。

---

## §2 社区生态现状（2026-10-18 普查）

### 2.1 ComfyUI 原生支持

- **版本门槛**：0.41.3+。本机当前 **0.41.0**（差 3 个小版本）
- **单文件模型**：`moss_image_sft_int8_convrot.safetensors` / `moss_image_base_int8_convrot.safetensors`（int8），以及 bf16 版本
- **文本编码器**：`qwen3.5_9b_w4a8_gptq.safetensors`，用 `CLIPLoader` 类型 `moss_image` 加载（**注意：本机用的是 HF diffusers 目录加载，不是这条路径**）
- **VAE**：`flux2-vae_small.safetensors`
- **官方模板**：4 个（SFT/Base × 文生图/布局引导），用子图（subgraph）封装

### 2.2 官方模板的采样配置（关键差异）

| 参数 | 官方模板 | 我们试过的 |
|---|---|---|
| 采样器 | **`er_sde`** | euler / res_multistep |
| 步数 | **25** | 50 / 15 |
| CFG | **2.5** | 1 / 3 |
| 说明 | 「模板使用 er_sde、CFG 2.5、25 步以求速度。官方设置是 CFG 3、50 步」 | — |

`er_sde` 属 SDE 类随机采样器，每步注入噪声；res_multistep 是确定性多步法。**两条路线性质相反**，这是之前 res_multistep 试验未能归因的原因之一。

### 2.3 加速 LoRA（重点）

**`lodestones/MOSS-Image-SFT-8-steps-dmd`**

| 项 | 内容 |
|---|---|
| 基础模型 | **MOSS-Image-SFT**（不是 Base） |
| 方法 | Data-space DMD（arXiv 2610.12102），generator 在固定噪声上迭代自己的干净估计 |
| 步数 | **8 步网络评估，无 CFG** |
| LoRA 规格 | rank 128 / alpha 128，覆盖每 block 的 `proj.{q,k,v,o,ffn_up_gate,ffn_down}` |
| 文件 | `lora.safetensors`（强度 1.0）/ `lora_latest.safetensors`（强度 0.7） |
| 训练数据 | compact-JSON `scene_graph` captions |
| 下载量 | 30,751 次/月 |
| Checkpoint | update 2600 (EMA)，float32 权重 |

**硬性精度约束**：蒸馏差值比 bf16 的舍入步长还小。`time_embedding.*` 和 `shared_block_modulation.bias` / `video_head_modulation.bias` 这三个模块**必须保持 fp32**，转 bf16 会丢掉大部分蒸馏效果。

**独立采样器**（不用 ComfyUI 原生 KSampler 时）：
```
ds = load_file("dataspace.safetensors")   # latent_mix.Q [128,128], step_codes [8]
Q, codes = ds["latent_mix.Q"], ds["step_codes"]
z = torch.randn(1, 128, H//16, W//16)     # fp32
x0 = torch.zeros_like(z)
for r in range(8):
    x = z + einsum("oc,bchw->bohw", Q, x0)
    v = transformer(x, codes[r], prompt_embeds, prompt_mask).sample.float()
    x0 = z - v
```

### 2.4 LoRA 训练

- **Civitai 训练工坊已支持**（10-17 上线），可选 SFT 或 Base 作起点
- OpenMOSS 推荐用 **Base** 训，训出的 LoRA 在 SFT 上**也能用**（"mostly work"）
- 官方提示：训练时**冻结文本编码器**

### 2.5 其他社区资源

| 类型 | 地址 |
|---|---|
| Civitai 模型页 | civitai.com/models/3005406 |
| HF（Comfy-Org 版） | huggingface.co/Comfy-Org/MOSS-Image |
| 官方 USERGUIDE | github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md |
| 8 步 Demo Space | huggingface.co/spaces/hugging-apps/moss-image-8-step-dmd |
| 4 步 turbo Space | huggingface.co/spaces/akhaliq/moss-image-4-step-turbo |

---

## §3 SFT 部署方案（本次执行）

### 3.1 关键节省：text_encoder 与 VAE 可复用

经 HF API 逐文件比对 LFS oid，SFT 与 Base 的 `text_encoder/`、`vae/`、`tokenizer/` **逐字节完全相同**：

| 组件 | SFT oid | Base oid | 是否相同 |
|---|---|---|---|
| text_encoder/model-00001 | `abfaa3d3...` | `abfaa3d3...` | ✅ |
| text_encoder/model-00002 | `9112637f...` | `9112637f...` | ✅ |
| text_encoder/model-00003 | `956f1ef5...` | `956f1ef5...` | ✅ |
| text_encoder/model-00004 | `9e21d20e...` | `9e21d20e...` | ✅ |
| transformer config | 同 | 同 | ✅（仅权重不同） |

**结论**：只需下载 transformer 的 3 个分片（约 **10.2 GB**），另 17 GB 用**硬链接**复用，零拷贝零额外占用。

### 3.2 目录结构与落地方式

```
D:\ComfyUI\ComfyUI\models\diffusers\MOSS-Image-SFT\
├── model_index.json                  （下载）
├── pipeline_moss_image.py            （下载）
├── transformer\                      （下载 10.2GB）
│   ├── config.json
│   ├── diffusion_pytorch_model-0000{1,2,3}-of-00003.safetensors
│   └── diffusion_pytorch_model.safetensors.index.json
├── text_encoder\  ──硬链接──> MOSS-Image-Base
├── tokenizer\     ──硬链接──> MOSS-Image-Base
└── vae\           ──硬链接──> MOSS-Image-Base
```

硬链接建立命令（同卷，零拷贝）：
```powershell
New-Item -ItemType HardLink -Path $target -Target $source
```

### 3.3 ⚠️ 硬链接与删除顺序的强耦合

**必须最后删 Base**。text_encoder 等目录是指向 Base 的硬链接，删了 Base 会导致 SFT 断链（数据实际会保留到最后一个链接消失，但目录结构丢失，需要重建路径）。

**安全顺序**：下 SFT → 验证能出图 → 把 SFT 的复用目录改成实拷贝或重新下载 → 再删 Base。

### 3.4 下载踩坑（复现）

**并发下载大文件会全部停滞**。2026-10-17 下 Base 时踩过，本次下 SFT 又踩了一次：

- 同时发起 3 个 4.99GB 文件 → 全部 `.part` 停在 0 字节
- 改为**一次只下一个**→ 立刻开始推进（8.7MB 起步）

**规则**：MOSS 这类 4~5GB 级大文件，**串行下载**，不并发。

---

## §4 SFT 落地结果（2026-10-18 完成）

### 4.1 下载与校验

经过多次中断与重试后，transformer 三片全部到位。**最终方案：ModelScope 源 + 串行下载**。

| 分片 | 大小 | 状态 |
|---|---|---|
| `diffusion_pytorch_model-00001-of-00003.safetensors` | 4,991,978,016 B（4.65 GB） | ✅ |
| `diffusion_pytorch_model-00002-of-00003.safetensors` | 4,983,137,016 B（4.64 GB） | ✅ |
| `diffusion_pytorch_model-00003-of-00003.safetensors` | 189,549,184 B（0.18 GB） | ✅ |
| **transformer 合计** | **9.47 GB** | ✅ |
| **SFT 目录合计** | 18 文件 / **25.35 GB** | ✅ |

### 4.2 完整性校验（`_scratch/verify_sft.py`）

```
transformer 张量总数: 463
index 声明张量数:   463
index 有但分片无:   0
分片有但 index 无:  0
```

**SFT 与 Base 权重确认为不同模型**（非改名）：

| 张量 | 平均绝对差 |
|---|---|
| `time_embedding.0.bias` | 0.000338 |
| `time_embedding.0.weight` | 0.000207 |
| `time_embedding.2.bias` | 0.000433 |

差的量级符合 SFT 微调预期（bf16 权重，小步长调整）。463 个张量名与结构完全一致，只换权重即可。

### 4.3 加载验证（`_scratch/verify_sft_load.py`）

- `model_index.json` 五个组件全部解析正常
- text_encoder 四个分片齐全（4.97 / 4.99 / 4.95 / 1.87 GB）
- transformer config 与 Base 逐字段相同（dim 3072 / layers 42 / heads 24 / ffn 8192 / latent 128）
- **VAE 实测加载成功**：`AutoencoderKLFlux2`，62.4M 参数，dtype=float32
- 显存：free 11.61 GB / total 12.88 GB

### 4.4 画布工作流

已生成 `workflows/moss-image-SFT版.json`（11 节点，分组沿用）：

| 节点 | 原值 | 新值 |
|---|---|---|
| #1 `MOSSImageHFLoader.model_path` | `...\MOSS-Image-Base` | `...\MOSS-Image-SFT` |
| #24 `MOSSCacheSelector.strategy` | `lazycache` | `off`（先看纯 SFT 效果） |
| Note | Base 说明 | 改写为 SFT/Base 定位差异 |

其余节点（提示词、尺寸、采样参数、SLG）原样保留，链路不变。

---

## §5 待验证事项

- [x] SFT 权重下载完整性（463 张量全对，index 无缺口）
- [x] SFT 文件结构可加载（VAE 实测通过，config 解析正常）
- [ ] **SFT vs Base 同种子同参数对照**（验证「结构崩」是否由 Base 引起）——最关键的一项
- [ ] `er_sde` + 25 步 + CFG 2.5 vs euler 50 步 + CFG 3 的实际差异
- [ ] 8 步 DMD LoRA 在 SFT 上的实际表现（含 fp32 time_embedding 约束的影响）
- [ ] ComfyUI 0.41.0 → 0.41.3+ 升级的成本与风险
- [ ] 删除 Base 的时机（须先把 SFT 的硬链接目录转为实拷贝或重新下载）

---

## §6 踩坑补充（本次新增）

### 坑 1：HF 直连速度只有 0.12 MB/s

- HuggingFace 直连：**0.12 MB/s**，4.99GB 要 11 小时
- ModelScope 镜像：**20~40 MB/s**，单片 2~4 分钟
- **40 倍差距**。以后下 MOSS/国产模型权重，先试 ModelScope。

```
https://modelscope.cn/models/openmoss/MOSS-Image-SFT/resolve/master/<路径>
```

### 坑 2：并发下载大文件会全部停滞

同时发起 3 个 4.99GB 下载 → 全部 `.part` 停在 0 字节，互相拖死。取消后串行下，立刻恢复到 20MB/s 以上。**规则：4GB 以上文件一律串行下载。**

### 坑 3：下载中断报「应用重启」是误报

`download-wait` 多次返回 `interrupted｜下载被中断（应用重启）`，但 `tasks.json` 里 `state` 仍是 `running`、`received` 持续增长，磁盘文件也在长大。**判断真实状态看 `tasks.json` 的 `state` 字段 + 磁盘文件大小，不要只信 `download-wait` 的回执。**

### 坑 4：`Get-ChildItem -Filter '*.part' | Select-Object -First 1` 抓到错误文件

目录里有多个残留 `.part` 时，`-First 1` 可能拿到 0 字节的那个，导致误判「下载没进展」。**要用精确文件名，不要用通配 + First。**

### 坑 5：画布 `setWidget` 改完立刻 `save` 会被旧状态覆盖

2026-10-18 实测：切页后立刻 `setWidget` 改 #4 提示词和 #6 尺寸，回执都是「已修改」，但 `save` 后文件里仍是旧值——只有 KSampler 的三个参数落盘。**改动后必须用 `canvas.op=prompt` 或读文件校验实际值，不能只信 setWidget 的回执。**

### 坑 6：`canvas.op` 没有 `open`，要用 `openWorkflow`

可用 op 列表见报错信息。打开工作流用 `openWorkflow`（带 `force=true` 才能丢弃未保存改动）。

### 坑 7：误开用户画布副驾驶

前端恢复后当前页可能是用户的 Qwen 画布（带未保存改动）。`op=copilot enabled=true` 会直接开在**当前页**上，不是你以为的那张。**开副驾驶前先 `op=pages` 确认当前页是哪张。**

---

## §5 参考链接

- ComfyUI 官方中文教程：https://docs.comfy.org/zh/tutorials/image/moss-image/moss-image
- HF SFT 模型卡：https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT
- HF 8 步 DMD：https://huggingface.co/lodestones/MOSS-Image-SFT-8-steps-dmd
- Civitai 文章：https://civitai.com/articles/36843/moss-image-text-that-reads-right-prompts-up-to-4k-tokens
- 官方仓库：https://github.com/OpenMOSS/MOSS-Image
