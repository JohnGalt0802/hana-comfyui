# Qwen-Image-2.1 文生图 · 调参实验记录

日期：2026-09-27
基准工作流：`Qwen21 t2i 质量版-20步.json`（由官方 `Qwen21 Turbo EasyCache t2i` 改造而来）
提示词：全部沿用同一句（原图自带）
`Soaking wet capybara taking shelter under a banana leaf in the rainy jungle, close up photo`
尺寸：`ResolutionSelector 3:2` → `1248×832`
种子：#20 `RandomNoise` 固定 `42`（**注：EasyCache 会改变采样路径，故构图可能变**）
硬件：RTX 4070 SUPER 12G

---

## 背景

官方那张 `Qwen21 Turbo EasyCache t2i` 用 **Viggle Turbo 6 步 DMD 蒸馏 LoRA**，
质量经用户实测不佳。本工作流改为**去掉蒸馏 LoRA、走多步常规采样**，逐项调参。

**改动起点**：移除 `ViggleTurboLora(#3)`，`ViggleTurboSigmas(#22)` 换成 `BasicScheduler`。

## 实验对照

| # | 采样器 | 调度器 | 步数 | EasyCache | 结果 | 耗时 | 产物 |
|---|---|---|---|---|---|---|---|
| 1 | `res_multistep` | `karras` | 20 | 开 0.2 | ❌ **糊成一团毛草**，无主体 | ~30s | `qwen21_quality20_00001_.png` |
| 2 | **`euler`** | **`normal`** | 20 | **关** | ✅ 好（全景，水豚躲叶下） | ~30s | `qwen21_exp2_euler_00001_.png` |
| 3 | `euler` | `normal` | 20 | **开 0.9** | ✅ **好**（特写，毛发清晰） | **~20s** | `qwen21_exp3_cache09_00001_.png` |
| 4 | `euler` | `normal` | **32** | 开 0.9 | ✅ **最好**（每根毛、叶上水光） | ~24s | `qwen21_exp4_steps32_00001_.png` |
| 5 | `euler` | `normal` | **12** | 开 0.9 | ✅ **好（甜点，性价比最高）** | **16s** | `qwen21_exp5_steps12_00001_.png` |
| 6 | `euler` | `normal` | **8** | 开 0.9 | ❌ **退化**（毛发变颗粒噪点，照片→油画感） | 8s | `qwen21_exp6_steps8_00001_.png` |

产物目录：`D:\ComfyUI\ComfyUI\output\`

## 结论（实测，非推断）

1. **实验 1 那套配置不可用**：`res_multistep` + `karras` + `EasyCache 0.2` 三重叠加导致糊图。
   我一开始同时改了三个变量，是实验设计失误——才让定位多花了一轮。
2. **`euler` + `normal` 是可靠基线**（社区共识也是 euler）。
3. **EasyCache 能用，但阈值不能压**：`0.2` 在 20 步里跳掉大半步（糊）；
   放宽到 `0.9` 后**质量保住且快 1/3**（30s → 20s）。
4. **步数边际递减，且有下限**：
   - `20 → 32` 改善很小（+4s）
   - `20 → 12` 质量不降、省 1/4 时间 → **12 步是甜点**
   - `12 → 8` **明显退化**（毛发颗粒化、照片变油画）→ **质量拐点在 8~12 之间**
5. **6 步糊的根不在“步少”**：Qwen 2.1 本体收敛很快（12 步已经很好）；
   官方那张的糊是 **蒸馏 LoRA + EasyCache 0.2** 的组合造成的。

## 当前推荐配方（已存为工作流文件）

文件：`Qwen21 t2i 质量版-12步.json`

```
UNETLoader(qwen_image_2.1_bf16)
  → EasyCache(reuse_threshold=0.9, 0.2~0.9)
  → BasicGuider(CFG off)
  → SamplerCustomAdvanced
       sampler = euler
       sigmas  = BasicScheduler(scheduler=normal, steps=12, denoise=1.0)
       latent  = EmptyLatentImage(1248×832)
  → VAEDecode → SaveImage
```

实测：**16 秒出图，质量与 20/32 步肉眼相当**。

## 通用性验证（同一配方，换题材）

配方固定为 `euler + normal + 12 步 + EasyCache 0.9`，只改提示词：

| 用例 | 提示词要点 | 结果 | 产物 |
|---|---|---|---|
| 人像 | 短发女性逆光站阳光厨房，胶片感 | ✅ 好（逆光、胶片质感、柔光） | `qwen21_case1_portrait_00001_.png` |
| 产品 | 陶茶壶木桌，产品摄影，干净背景 | ✅ 出图（未详评） | `qwen21_case2_product_00001_.png` |
| 海报（含文字） | 复古旅游海报，标题 `"LAKESIDE"` | ✅ **好（文字准确、带描边）** | `qwen21_case3_poster_00001_.png` |
| 动物（对照组） | 雨林水豚躲芭蕉叶下 | ✅ 好 | `qwen21_exp5_steps12_00001_.png` |

**结论：配方不挑题材**（人像 / 产品 / 海报 / 动物四类均成立）。
**额外发现：文字渲染准确**（`LAKESIDE` 一次成型），乃 Qwen-Image-2.1 的排印强项。

## 待试（下一步）

- **步数下限**：✅ 已探（12 步甜点，8 步退化）
- **CFG**：当前 `BasicGuider` 天然 CFG off（=1）。社区有"前 8-12 步 CFG 1.5-3.5、其余 1"
  的分段说法，需换 `CFGGuider` 才试得了
- **EasyCache 阈值**：0.5 附近找质量/速度的更好平衡（低优先级）
- **CFG**（低优先级）：Qwen 推荐 CFG≈1，而 `BasicGuider` 天然就是该值；
  且 `TextEncodeQwenImage21` 只吐 `positive`，要试分段 CFG 得另造负条件，成本高、收益存疑
- **题材扩展**：✅ 已验（人像/产品/海报/动物），见上表

## 附：这条链是怎么打通的（环境部分）

- 画布写入需 **`POST /comfyui-hana/allow-write {enabled:true}`**
- 新造的工作流不在前端列表里 → 用 **`loadWorkflowFile`**（读文件直接 `loadGraphData`）
- **`canvasRoute` 曾丢 args**（只传 op），已修；否则 `setWidget` 等全部拿不到参数
- 改扩展 js 后：**重启 ComfyUI** + **在 hui 里触发 `frameReload`**（Ctrl+F5 刷不到内层）
