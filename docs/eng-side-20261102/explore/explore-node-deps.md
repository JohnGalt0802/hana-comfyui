# 缺包诊断 · 本地映射数据探索报告

实测环境：Windows 11 / ComfyUI 0.43.0（git v0.43.0-24-g6d352802）/ Python 3.12.13 / comfyui-manager pip 包 4.2.2。
实测时间：2026-11-02。所有路径均为本机实测。只读操作，未修改 D:\ComfyUI 任何文件。

---

## 一、映射表 schema 与例外

**结论：schema 严格统一，例外数为 0。**

对两份文件全量遍历验证（PowerShell ConvertFrom-Json -AsHashtable）：

| 文件 | 仓库键数 | value 不是数组 | 长度<2 | 长度>2 | 第0元素不是数组 | 第1元素不是对象 | 类名非字符串 |
|---|---|---|---|---|---|---|---|
| site-packages 版 | 3341 | 0 | 0 | 0 | 0 | 0 | 0 |
| user\__manager\cache 版 | 5718 | 0 | 0 | 0 | 0 | 0 | 0 |

即：每条 value 都是严格的两元组 `[ ["类名", ...], {"title_aux": "..."} ]`，无第三元素、无裸数组例外。伪代码可不做防御分支（或只留一层兜底）。

注意第二元素对象里**不只有** `title_aux` 一个键的情况未逐键枚举（抽样见到的都是 title_aux；个别条目对象里还可能带 `nodename_pattern` 之类——此点 `[不确定]`，解析时应按 dict 整体保留，不要假定只有 title_aux）。

---

## 二、两份表的差异与选取规则

| | `venv\...\comfyui_manager\extension-node-map.json` | `ComfyUI\user\__manager\cache\1742899825_extension-node-map.json` |
|---|---|---|
| 大小 | 1,502,571 B (1.43 MB) | 2,636,998 B (2.51 MB) |
| mtime | 2026-09-27 19:46:45 | 2026-11-01 20:54:40 |
| 仓库键数 | 3341 | 5718 |
| 唯一类名数 | 25,581 | 42,838 |

- **site-packages 版是 pip 包自带的静态快照**（`comfyui_manager` 包数据文件，随包安装日期 9/27 落盘），相当于离线兜底库。
- **cache 版是运行时从 channel 拉取的**。来源已实证：`config.ini` 里 `channel_url = https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main`，缓存文件名 = `simple_hash(channel_url + '/' + filename)`。用 manager 自带的 `simple_hash`（h = h*31+ord(c) mod 2^32）复算该 URI 得 **1742899825**，与文件名前缀完全一致。
- 键差：cache 独有 2518 键，sp 独有 141 键（sp 独有的多为已下架/被移除的仓库）。cache 明显更新、更全。
- 逻辑依据（`comfyui_manager\glob\manager_core.py:2326-2361` `get_data_by_mode`）：非 offline 模式下先拉远端再写 cache；仅 offline 或 pip 包模式下才回落到包内文件。

**选取规则：优先 cache 版（更新、覆盖广）；sp 版仅作离线兜底。两份都读时以 cache 为准、sp 补缺。**

## 三、缓存文件累积问题（对应任务问题 3）

**不需要"挑最新"，同 channel 永远只有一个文件。** 文件名 = `{simple_hash(uri)}_{filename}`，uri 含 channel 地址，同 channel 反复刷新覆盖同名文件。实测 `user\__manager\cache\` 目录仅 6 个文件，每个 `*_extension-node-map.json` 只有一个（hash 前缀各代表一种数据或不同 channel）。只有用户配置了多个 channel 时才会出现多个映射表文件——本机 config.ini 只有一个 channel。稳妥写法：glob `*_extension-node-map.json` 后按 mtime 取最新，一行兜底，不需要更复杂逻辑。

---

## 四（任务三）、已安装判定方案

**第一优先：`.git\config` 的 remote url。** 24 个目录实测：13 个有 `.git`（全部为目录形式，无 `.git` 文件形式），11 个没有。

| 目录名 | .git | git remote url | pyproject name | 判定路径 |
|---|---|---|---|---|
| ComfyUI-Impact-Pack | dir | `https://github.com/ltdrdata/ComfyUI-Impact-Pack.git` | comfyui-impact-pack | git url → map 键精确命中（去 `.git` 后缀后） |
| comfyui-node-organizer | dir | `https://github.com/PBandDev/comfyui-node-organizer.git` | comfyui-node-organizer | git url，**map 中无此仓库**（见第五节） |
| rgthree-comfy | dir | `git@github.com:rgthree/rgthree-comfy.git` | rgthree-comfy | **ssh 形式 url**，需归一化为 `https://github.com/rgthree/rgthree-comfy` 后命中 map/custom-node-list |
| ComfyUI-Easy-Use | 无 | — | comfyui-easy-use (v1.4.1) | 在 custom-node-list.json (6061 条) 中按 reference=`https://github.com/yolain/ComfyUI-Easy-Use` 命中，title "ComfyUI Easy Use" |
| ComfyUI_Comfyroll_CustomNodes | 无 | — | 无 pyproject name | 目录名与 custom-node-list 中 reference `https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes` 尾段一致命中（id: comfyroll） |
| ComfyUI-Custom-Scripts | dir | `git@github.com:pythongosssss/ComfyUI-Custom-Scripts.git` | comfyui-custom-scripts | git url 归一化 |
| was-node-suite-comfyui | 无 | — | `was-ns`（与目录名差异大） | 目录名模糊匹配（`[部分验证]`，未逐条查 cnl） |
| hana_bridge | 无 | — | 无 pyproject | **任何注册表都查不到**：纯前端扩展包，NODE_CLASS_MAPPINGS={}（`custom_nodes\hana_bridge\__init__.py:98`） |
| moss-easycache / moss-gpu-free | 无 | — | 无 pyproject name | 无 git、无 pyproject、无 cnl 命中 → 无法反查仓库，标记为"本地私有包" |

无 git 目录的识别次序（实测有效）：
1. `pyproject.toml` 的 `project.name`（如 `comfyui-easy-use`）→ 与 map 的 `title_aux` / cnl 的 title 做归一化模糊匹配；
2. 目录名本身 → 与 cnl `reference`/`files` 的 URL 尾段（去 `ComfyUI-` 前缀、忽略大小写与 `_`/`-`）匹配；
3. 都不中 → 视为私有/手工放置包，缺包诊断时应跳过（它不可能出现在映射表里，也就不存在"缺它"的问题）。

归一化要点（实测踩到）：`git@github.com:owner/repo.git` 与 `https://github.com/owner/repo` 与 `.../repo.git` 三种写法都存在，统一成 `owner/repo` 小写后再比对。

---

## 五（任务四）、反向索引规模

把 repo→classes 反转成 class→repos（去重 repo）：

| | sp 版 | cache 版 |
|---|---|---|
| 唯一类名 | 25,581 | 42,838 |
| 类名条目总数（含重复） | 26,786 | 45,197 |
| 平均每类仓库数 | 1.05 | 1.06 |
| 对应 ≥2 个仓库的类 | 885 | 1,727 |

**对应仓库最多的前 5 个类（cache 版）**：
1. `PreViewVideo` — 18 个仓库（几乎全是 AIFSH 系列的复制粘贴节点）
2. `LoadVideo` — 11
3. `KSampler` — 9（**注意：含核心仓库 `comfyanonymous/ComfyUI`**，映射表把核心节点也收录了）
4. `PreViewAudio` — 9
5. `CheckpointLoaderSimple` — 9（同样含核心仓库）

含义：类名撞车是常态（约 4% 的类对应多仓库，热门名可达 9~18 个）。"类名→仓库"一步**不能取唯一解**，应：先减去 object_info 里已存在的类；剩多个候选仓库时按"是否已安装"过滤（已装的不报缺），仍多解则全部列出待人工判断。

---

## 六（任务五）、反查实测结果

**先说实测到的限制**：`hana_bridge` 与 `comfyui-node-organizer` **都注册零个节点类**（两者 `__init__.py` 的 `NODE_CLASS_MAPPINGS = {}`），且两者仓库**都不在映射表 5718 个键里**（按 `hana`/`PBandDev`/`organizer` 检索 map 键均无命中；map 中 PBandDev 名下只有另外 3 个仓库）。所以这两个包无法作为"类名→仓库"反查的测试样本——它们本身反证了：**映射表覆盖不了纯前端扩展包，这类包不走节点类注册，缺包诊断对它们应走 custom-node-list.json 或直接跳过。**

改用 Comfyroll（已装、在 map 中）做正反实测：

- map 中 Comfyroll 仓库登记 207 个类，其中 **199 个出现在 object_info（2549 个类）里，8 个不在**：`CR Arabic Text RTL`、`CR Draw Perspective Text`、`CR Input Text List`、`CR Load Prompt Style`、`CR Load Scheduled ControlNets`、`CR Load Value List`、`CR Schedule To ScheduleList`、`CR Simple Binary Pattern Simple`。
- 反查这 8 个类名 → 全部唯一命中 `https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes`。

**结论：能查出来。** 流程"object_info 缺的类名 → map 反查 → 得到仓库"实测可行；8 个缺失类名的成因是 map（11/1 数据）比本机安装的 Comfyroll 版本新（登记了上游新增节点），这正好就是缺包诊断要覆盖的场景，反查方向正确。

## 七（任务六）、manager 未启用时的降级路径

实测 `main.py`（ComfyUI 0.43.0）：

- `--enable-manager` 是 `comfy/cli_args.py:162` 的开关；`main.py:242-249`：**只有** `args.enable_manager` 为真时才 `import comfyui_manager`；找不到包则 `handle_comfyui_manager_unavailable()` 打 warning 并把开关置回 False（`main.py:119-129`）。
- 未启用时：manager 的 API 端点不注册、不拉远端、不刷新 cache。**但两份文件都还在磁盘上**：
  - sp 版随 pip 包安装，只要 venv 里装过 `comfyui-manager` 就存在（本机 pip show: comfyui-manager 4.2.2，Location 就是该 venv）；
  - cache 版是上次启用 manager 时写下的，`user\__manager\cache\` 目录持久存在。
- 降级方案（本机事实支撑）：manager 关闭时直接读这两份静态文件，配 `object_info` 判"已加载"，静态表只用于"类名→仓库→给安装指引"，不再期望它反映运行时状态。数据新鲜度以文件 mtime 为准并如实上报。

## 八（任务七）、models 目录对齐

`D:\ComfyUI\ComfyUI\models` 实测子目录（27 个）：
`audio_encoders, background_removal, checkpoints, clip, clip_vision, configs, controlnet, detection, diffusers, diffusion_models, embeddings, frame_interpolation, geometry_estimation, gligen, hypernetworks, latent_upscale_models, loras, model_patches, optical_flow, photomaker, style_models, text_encoders, unet, upscale_models, vae, vae_approx, vosr2`

模板 JSON 实测（`comfyui_workflow_templates_json\templates\*.json`，模板本体在 `comfyui_workflow_templates_json` 子包，wrapper 包 `comfyui_workflow_templates` 只剩 941 字节的转发 `__init__.py`）：

- 节点的 `properties.models[]` 实际形如：`{"name":"hunyuan3d-dit-v2-mv-turbo_fp16.safetensors","url":"https://huggingface.com/...","directory":"checkpoints"}`。
- 全部模板 JSON 中出现的 `directory` 值共 18 种：audio_encoders, background_removal, checkpoints, clip_vision, controlnet, detection, diffusion_models, embeddings, frame_interpolation, geometry_estimation, latent_upscale_models, loras, model_patches, optical_flow, style_models, text_encoders, upscale_models, vae —— **全部在本地 models 子目录中直接命中，可对上，无需映射转换**。
- 另外 index.json 顶层模板条目还有 `models: ["Nano Banana"]` 这类**模型名而非目录**的字段，与 `properties.models[].directory` 是两回事，解析时别混。

## 九（任务八）、版本比较规则

实测：

- `/system_stats` → `"comfyui_version": "0.43.0"`，纯三段数字；`python_version`、`pytorch_version: "2.11.0+cu128"`（pytorch 带 `+cu128` 后缀，但 comfyui_version 本身干净）。
- `comfyui_version.py` → `__version__ = "0.43.0"`，与 /system_stats 一致。
- git describe 为 `v0.43.0-24-g6d352802`（tag 后 24 个提交），但**版本字符串不体现这 24 个提交**，仍报 0.43.0。
- 模板 `minComfyUIVersion`：index.json 652 个模板中 649 个带此字段，取值全部是 `X.Y.Z` 三段数字（实测全集含 0.0.1 ~ 0.43.2，无 rc/nightly/后缀格式）。
- 未发现任何夜间版/预发布格式出现在本机两侧的版本字符串里；上游是否可能出现 `[不确定]`。

**最稳妥规则：把两侧字符串按 `.` 切成 int 元组逐段比较（semver 三段，缺段补 0）。绝不能用字符串序比较**——实测两侧都存在 `0.10.0` 与 `0.9.2` 这类值，字典序会判错。比较基准取 `/system_stats` 的 `comfyui_version`（运行中的真实版本），不要取 pip 包名或 git tag。

---

## 十、不确定项

1. map 第二元素 dict 是否恒为 `{title_aux}` 单键——未逐键枚举，按整 dict 保留即可。
2. `was-node-suite-comfyui`、`ComfyUI-Prompt-Assistant`、`ComfyUI-VOSR2`、`efficiency-nodes-comfyui`、`moss-image` 等 5 个无 git 目录未逐一在 cnl 中确认命中（Easy-Use / Comfyroll 已确认命中；was 仅有目录名模糊匹配线索）。
3. 上游模板/映射表未来是否引入非三段版本号：本机未见，标 `[不确定]`。
4. 多 channel 场景下 cache 目录会出现多个映射表文件：本机只有 1 个 channel，未实测多 channel 行为，结论来自文件命名逻辑推断。
5. `moss-easycache`、`moss-gpu-free`、`hana_bridge`、`__pycache__` 4 个目录无任何注册表痕迹，来源无法反查（本地私有包）。

## 附：三步伪代码（每步均有上文实测支撑）

```text
# 1) 运行时缺失类
installed_classes = keys(GET /object_info)          # 2549 个，实测

# 2) 类名 → 仓库
map = load(user/__manager/cache/*_extension-node-map.json 取 mtime 最新)   # 5718 键
      并用 venv/.../comfyui_manager/extension-node-map.json 补缺            # 3341 键兜底
candidate_repos = [repo for repo,(classes,_) in map if missing_class in classes]
# 多解时：排除本机已装仓库；仍多解全列（热门类名最多 18 个仓库，实测）

# 3) 是否已装
for d in custom_nodes/*/:
    repo = git_config_remote(d)                     # 13/24 有 git，含 ssh 形式需归一化
          or pyproject_name/directory_name 模糊匹配 custom-node-list.json   # 6061 条
    归一化 owner/repo 后与 candidate_repos 比对
# 匹配不上且无节点类的包（前端扩展如 hana_bridge）→ 跳过，不在本诊断范围
```
