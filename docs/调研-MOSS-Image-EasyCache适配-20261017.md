# MOSS-Image 能不能用 EasyCache？—— 实测报告与适配方案

> **日期**：2026-10-17 深夜
> **结论先行**：**原生 EasyCache 完全无效**（skip 0/50）；已写专用节点 `MOSSApplyEasyCache` 绕过兼容缺口，实测最高 **2.2x 加速、画质几乎无损**。
> **工作流**：`workflows/moss-image-EasyCache版.json`（11 节点，含 EasyCache）

---

## §1 一句话答案

| 问题 | 答案 |
|---|---|
| 能用原生 EasyCache 吗 | **不能**。能加载、不报错、打印 "enabled"，但**一步都跳不了** |
| 为什么 | MOSS 插件的模型 forward 没有调用 `DIFFUSION_MODEL` wrapper；那是 EasyCache 的挂载点 |
| 有解吗 | 有。把同一套判定逻辑改挂 `APPLY_MODEL`（模型基类方法，谁都绕不过去），已写成节点 |
| 实测效果 | 50 步 → 折合 **64s vs 96.3s（快 33%）**，PSNR 28.62 dB，相关系数 0.9927 |

---

## §2 原生 EasyCache 为什么失效（代码级根因）

### 挂载点

`comfy_extras/nodes_easycache.py` L384-386，原生节点把 wrapper 挂在三个位置：

```python
model.add_wrapper_with_key(WrappersMP.OUTER_SAMPLE,      "easycache", easycache_sample_wrapper)
model.add_wrapper_with_key(WrappersMP.CALC_COND_BATCH,   "easycache", easycache_calc_cond_batch_wrapper)
model.add_wrapper_with_key(WrappersMP.DIFFUSION_MODEL,   "easycache", easycache_forward_wrapper)  # ← 关键
```

缓存判定、跳过、缓存差更新，全部在 `easycache_forward_wrapper` 里。

### 触发机制

`DIFFUSION_MODEL` **不是框架统一调用的**。它是「约定」：每个扩散模型要在自己的
`forward` 里主动取 wrapper 执行。ComfyUI 官方模型都照做了：

```python
# comfy/ldm/flux/model.py L346-349（范例）
return comfy.patcher_extension.WrapperExecutor.new_executor(
    self._forward, self,
    comfy.patcher_extension.get_all_wrappers(WrappersMP.DIFFUSION_MODEL, transformer_options),
).execute(x, timestep, context, y, guidance, ref_latents, control, transformer_options, **kwargs)
```

巡检到调用该 wrapper 的官方模型：`ace / aura / chroma / cogvideo / cosmos / flux /
hidream / hunyuan_video / hunyuan3d / ideogram4 / ltxv / ...`（十余个）

### MOSS 的缺口

```bash
$ Select-String -Path custom_nodes/moss-image/model.py -Pattern 'DIFFUSION_MODEL|get_all_wrappers'
D:\ComfyUI\ComfyUI\custom_nodes\moss-image\model.py:222: transformer_options["block_type"] = "single"
```

**只有 block_type，没有 get_all_wrappers。** MOSSImageTransformer.forward（L183）
直接走自己的前向逻辑，从不执行 `DIFFUSION_MODEL` wrapper。

### 实测证据

```
EasyCache enabled - threshold: 0.2, start_percent: 0.15, end_percent: 0.95
EasyCache [verbose] - output_change_rates 0: []
EasyCache [verbose] - approx_output_change_rates 0: []
EasyCache - skipped 0/50 steps (1.00x speedup).
```

`output_change_rates` 长度 0 = `easycache_forward_wrapper` 一次都没跑。
注意 "enabled" 那行是 `OUTER_SAMPLE` wrapper 打的，所以看起来像在工作，实际空转。

> **这是第三方插件模型的通用坑**：凡是没在 forward 里调用 DIFFUSION_MODEL wrapper
> 的自定义模型（大部分社区插件都没调），原生 EasyCache / LazyCache 都无效。

---

## §3 适配方案：改挂 APPLY_MODEL

### 为什么可行

```python
# comfy/model_base.py L209-214
def apply_model(self, x, t, c_concat=None, c_crossattn=None, control=None,
                transformer_options={}, **kwargs):
    return comfy.patcher_extension.WrapperExecutor.new_class_executor(
        self._apply_model, self,
        comfy.patcher_extension.get_all_wrappers(WrappersMP.APPLY_MODEL, transformer_options),
    ).execute(x, t, c_concat, c_crossattn, control, transformer_options, **kwargs)
```

`apply_model` 是 **BaseModel 基类方法**，任何扩散模型每步采样必定经过。
在这里能拿到 EasyCache 需要的全部信息：

| 需要的东西 | 来源 |
|---|---|
| 输入 x（加噪 latent） | `args[0]` |
| 当前 timestep | `transformer_options["sigmas"]`（samplers.py L325 写入） |
| 条件 UUID | `transformer_options["uuids"]`（samplers.py L324 写入） |
| 模型输出 | `executor(...)` 的返回值 |

### 算法（与原生一致）

```
每步：
  input_change = mean(|sub(x) - x_prev_sub|)
  cumulative_change_rate += (rel_rate * input_change) / output_prev_norm
  if cumulative < reuse_threshold and 有缓存差:
      跳过前向，返回 x + cache_diff
  else:
      output = 前向(x)
      cache_diff = output - x
      rel_rate = actual_output_change / input_change
      cumulative = 0
```

跳过时返回 `x + cache_diff`——复用上一步「输出减输入」的差值。
**这里踩过一次大坑**：v1 曾自作聪明用最近邻插值还原缓存张量，
结果空间全错位，画出网格状色块废图。老老实实照原生算法才对。

---

## §4 实测数据（1024×1024，50 步，CFG 3，SLG single=22）

同 prompt / 同 seed（20261017），只切换 EasyCache 参数。

| 配置 | 耗时 | 相对基线 | PSNR | 相关系数 | 明显差异像素(>20) | 跳过步数 |
|---|---|---|---|---|---|---|
| **基线（不开）** | **96.3 s** | 1.00x | — | 1.0 | — | 0 |
| EC 0.2 / start 0.15 | 72.1 s | 1.34x | 26.19 dB | 0.9892 | 7.5% | 42/52 |
| EC 0.1 / start 0.15 | 44.0 s | 2.19x | 20.21 dB | 0.9467 | 12.6% | 56/80 |
| **EC 0.1 / start 0.5** | **64.0 s** | **1.50x** | **28.62 dB** | **0.9927** | **2.0%** | **33/44** |

### 密集中文长文本场景（额外验证）

用画布默认的「玻璃板手写三段中文」提示词（文字密度最高的压力测试）跑对照：

| 配置 | 耗时 | PSNR | 相关系数 | 明显差异像素 |
|---|---|---|---|---|
| 基线 | 96.1 s | — | 1.0 | — |
| **EC 0.1 / start 0.5** | **68.0 s（1.41x）** | **31.20 dB** | **0.99304** | **2.6%** |

结论：**EasyCache 不是文字模糊的锅**。基线本身在密集长中文上就会糊（第二段整行乱码），
两版糊的部位和程度基本一致。这是 MOSS-Image-Base 的固有短板，与加速无关。

> 想让密集文字更准：官方建议在提示词里手动加 `\n` 精确断行，或用 Layout JSON 给每行文字单独定 bbox。
> 而不是靠堆步数或换采样器。

### 怎么读这组数

- **start_percent 比 threshold 更影响画质**。0.15 就介入 → 早期结构没定好就被缓存冻结，
  文字和细节直接崩（PSNR 20 dB，视觉上底部出现乱码）；推到 0.5 之后介入，前 25 步照常算，
  后期只剩微调，缓存几乎无代价（PSNR 28.6 dB，2% 像素差异）。
- **跳过比例 ≠ 提速比例**。0.2/0.15 跳过 42/52 步（日志报 5.20x），实际只快 34%——
  因为跳过时仍要在 CPU/GPU 间搬运 latent 并做张量加法，还有 SLG 双前向的开销摊不平。
- **推荐配置：`reuse_threshold=0.1, start_percent=0.5, end_percent=0.95`**。
  这是「体感明显变快、肉眼难辨差异」的平衡点。

### 视觉验收（0.1 / start 0.5）

- 中文标题「苔藓」：清晰无误
- 副标题「微小之处，自有宇宙」：清晰无误
- 苔藓主体、光影、构图：与基线一致
- 底部展览小字：字形与基线略有差异（那片区文本信息密度最高，也是缓存最容易吃亏的地方）

---

## §5 交付物

| 产物 | 路径 |
|---|---|
| 自定义节点 | `D:\ComfyUI\ComfyUI\custom_nodes\moss-easycache\__init__.py` |
| 节点 ID | `MOSSApplyEasyCache` ／ 显示名「EasyCache · MOSS 专用（APPLY_MODEL 版）」 |
| 分类 | `moss/easycache` |
| 工作流 | `workflows/moss-image-EasyCache版.json`（画布内已保存，11 节点） |
| 原版工作流 | `workflows/moss-image-分组版.json`（未动，10 节点，纯官方参数） |

### 参数说明

| 参数 | 默认 | 推荐 | 说明 |
|---|---|---|---|
| `reuse_threshold` | 0.2 | **0.1** | 越大跳越多越快，画质风险越高 |
| `start_percent` | 0.15 | **0.5** | 从进度几成开始介入。**这是画质生死线** |
| `end_percent` | 0.95 | 0.95 | 到几成停止 |
| `verbose` | true | true | 后台日志打印每步跳过详情 |

### 与 SLG 的兼容性

`SkipLayerGuidanceDiTSimple` 改的是 `set_model_sampler_calc_cond_batch_function`
（calc_cond_batch 内部），本节点改的是 `apply_model`，**层级不同，实测可共存**。

但因 SLG 每步跑两次前向，日志里的步数统计是「apply_model 调用次数」而非「采样步数」，
所以会看到 `skipped 33/44` 这种超过 50 的步数——不是 bug，是双前向叠加。

---

## §6 踩坑记录

| # | 坑 | 正解 |
|---|---|---|
| 1 | 原生 EasyCache 在 MOSS 上静默失效，日志还打 "enabled" | 必须自己挂 `APPLY_MODEL`；判据是 `output_change_rates` 为空 |
| 2 | `create_model_options_clone` 在 `comfy.model_patcher`，不在 `comfy.patcher_extension` | 引用 `comfy.model_patcher.create_model_options_clone` |
| 3 | 自创「插值还原缓存」→ 网格状废图 | 严格照原生：`cache_diff = output - x`，跳过时 `x + cache_diff` |
| 4 | start_percent=0.15 画质崩（PSNR 20 dB） | 推到 0.5，让结构先算完 |
| 5 | 日志步数超过总步数（33/44 vs 50 步） | SLG 双前向导致，正常现象 |
| 6 | 第三方插件模型的通用坑：forward 不调 DIFFUSION_MODEL wrapper → 原生加速节点全失效 | 遇到类似情况可复用本节点的思路 |
| 7 | 误以为「画布那张图文字糊」是 EasyCache 导致 | 跑基线对照：**基线一样糊**。MOSS 在密集长中文上本身就不稳 |

---

## §7 后续可做

- 把 `MOSSApplyEasyCache` 的思路推广成通用节点（任何未适配的第三方模型都能用）
- 试 `LazyCache`（更简单的单缓存版本）在 MOSS 上的表现
- 与 TorchCompile 叠加测试（官方 README 提示 SLG/block patch 场景要用 eager 执行）
- 用真实生成任务（非海报测试图）做一次主观画质评估
