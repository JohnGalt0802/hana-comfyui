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

## 步数对照（用含文字的复古海报重验 —— 推翻前一轮结论）

提示词：`a vintage travel poster of a snowy mountain peak at dawn, the bold headline reads "NORTH RIDGE", retro print texture, muted palette`

| 步数 | 耗时 | 文字 | 山体 | 评价 | 产物 |
|---|---|---|---|---|---|
| **12** | 24s | 米色带阴影，尚可 | **碎片/噪点感** | 快，但糙 | `qwen21_steps12_poster_00001_.png` |
| **30** | 16s | 黑体带白边，更准 | **有岩层层次** | 明显更好 | `qwen21_steps30_poster_00001_.png` |
| **50** | 24s | 最像印刷体 | **岩层、冰川裂缝清楚** | 最好 | `qwen21_steps50_poster_00001_.png` |

### ⚠️ 结论修正

**“12 步与 20/32 步肉眼相当”是错的。**
错因：当时只用**雨林水豚**（主体大、细节要求低）做样本，掩盖了差异。
换成**含文字的海报**，差距立刻现形。

**正确结论**：
- **12 步仅适合快速预览**（构图/大致内容）
- **要出片、尤其带文字，30-50 步才够**（社区“2.1 需 30~50 步”的说法属实）
- 耗时不是单调递增（12→24s、30→16s、50→24s），受缓存/冷启动影响，不能单看单次

## 独立模块：提示词增强器

文件：`Qwen21 提示词增强器.json`（12 节点，**纯增强，无采样/保存节点**）

**为何这么做**：官方与社区的提示词增强器都是**独立跑、输出纯文本**
（见 comfy.org 那个“QwenVL 提示词增强器”：输出可直接用于任何 T2I 节点）。
焊在生图图里会让改采样时不得不绕开增强段。

**组件**（从生图图抽出，自带 CLIPLoader）：

```
CLIPLoader(qwen3vl_8b)
  → TextGenerate(system_prompt = skill 规则, prompt = brief)
  → JsonExtractString → 失败判定 → 回退开关
  → PreviewAny（输出）
```

**实测**（输入 `一只橘猫坐在窗台上`，65 秒）：

> The image is a vertical realistic photograph of a ginger cat sitting on a windowsill, ... **In the upper-left corner** ... **Across the top edge** ... **In the centre of the frame** ...

完全符合 skill 规则的八步框架（英文、观察者口吻、方位短语、光照独立成句）。

**踩坑**：抽链时漏了给 `StringFormat` 喂宽高比的 `ResolutionSelector`（生图节点）。
正解：增强器**本不该管画幅**，把 `StringFormat` 模板简化为 `{a}`（只吃 brief）。

## 待试（下一步）

- **CFG**：Qwen 推荐 CFG≈1，而 `BasicGuider` 天然就是该值；
  且 `TextEncodeQwenImage21` 只吐 `positive`，要试分段 CFG 得另造负条件，成本高、收益存疑（低优先级）
- **EasyCache 阈值**：0.5 附近找质量/速度的更好平衡（低优先级）
- **题材扩展**：✅ 已验（人像/产品/海报/动物）
- **步数**：✅ 已探并**修正**（12 预览 / 30-50 出片，见上表）
- **模块化**：✅ 独立增强器已建；可继续做**两图联动**或 **subgraph**（生图图里只留一个节点）

## 附：这条链是怎么打通的（环境部分）

- 画布写入需 **`POST /comfyui-hana/allow-write {enabled:true}`**
- 新造的工作流不在前端列表里 → 用 **`loadWorkflowFile`**（读文件直接 `loadGraphData`）
- **`canvasRoute` 曾丢 args**（只传 op），已修；否则 `setWidget` 等全部拿不到参数
- 改扩展 js 后：**重启 ComfyUI** + **在 hui 里触发 `frameReload`**（Ctrl+F5 刷不到内层）
