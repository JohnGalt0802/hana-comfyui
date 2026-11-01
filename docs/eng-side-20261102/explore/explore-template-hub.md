# ComfyUI 官方模板库数据源契约报告

- 实测日期：2026-11-02（UTC）
- 真相源：`https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/`
- 本机 ComfyUI 版本假设：0.43.0
- 所有数字均为当日实测，非推测。抽样副本已落盘本目录（index.mcp.json / index.json / index.zh.json / index.mcp.jsdelivr.json / tree.json / samples\*.json / tpl_*.json）。

---

## 一、索引字段全表（含可选性）

### 1.1 index.mcp.json（MCP 精简索引，597,407 字节）

顶层是**分类对象数组**，共 10 个分类对象，每个对象字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `category` | string | 分类名，实测 10 个：Image(210) / Image Tools(53) / Video(223) / Video Tools(47) / Audio(43) / 3D Model(50) / Vector(9) / Product & Ads(16) / Character & Fashion(28) / Brand & Design(15) |
| `description` | string | 分类描述（英文） |
| `templates` | array | 模板条目，共 **694** 条 |

`templates[]` 每条字段（694 条全覆盖统计）：

| 字段 | 出现次数 | 可选性 | 类型/取值 |
|---|---|---|---|
| `name` | 694 | 必有 | 模板文件名（不含 .json），同时是文件主键 |
| `title` | 694 | 必有 | 英文标题 |
| `task` | 694 | 必有 | 任务名，实测 34 种（Image Edit=109、Text to Image=99、Image to Video=75、Text to Video=55…） |
| `model` | 694 | 必有 | 模型显示名（单值字符串） |
| `freshness` | 694 | 必有 | 枚举：`current / established / new / recent` |
| `usage` | 694 | 必有 | 整数（热度计数，语义未见官方文档 [未验证]） |
| `recommend` | 694 | 必有 | 枚举：`top / highly_recommended / high / medium / low / not_recommended` |
| `description` | 694 | 必有 | 英文长描述 |
| `io` | 694 | 必有 | `{inputs: string[], outputs: string[]}`；元素格式 `"类型: 说明"`，类型 ∈ {text, image, video, audio, model}，多输入用 `×N` 记法（如 `"image×2: ..."`，实测出现过 image×2/3/4/5/8/9、video×2/3/7、text×2、image×64、image×12） |
| `capabilities` | 693 | **可选**（缺 1 条：`utility_sam3d_body`） | 对象，见下 |
| `minComfyUIVersion` | 691 | **可选**（缺 3 条：`api_pixverse6_i2v`、`api_pixverse6_t2v`、`api_fishaudio_text_to_speech`） | semver 字符串 |

`capabilities` 子字段（693 条统计）：

| 字段 | 出现次数 | 结构 |
|---|---|---|
| `workflow` | 693 | string[]，标签集实测 53 种；头部：api=404、image-edit=112、text-to-image=108、image-to-video=87、text-to-video=56、int8=41、flf2v=30、video-edit=29、image-to-3d=29、controlnet=26、image-upscale=26、reference-to-video=23、lora=16、lip-sync=14、text-to-audio=14…（api 标签 = 走官方 API 节点，无需本地权重） |
| `model_options` | 214 | **对象（map）**：键 = 节点类名（如 `GeminiNanoBanana2V2`），值 = 该节点可选择的模型字符串数组（如 `["Gemini Nano Banana 2.1", "Nano Banana 2 (Gemini 3.1 Flash Image)", "Nano Banana 2 Lite"]`）。实测 86 个不同节点键。只出现在带 API 节点的模板上 |

抽样 5 条（Image×3 含有/无 model_options、Video、Audio 各一）均在 `samples`/上文记录中，字段集与上表一致，未见第 12 个字段。

### 1.2 index.json / index.{locale}.json（完整 UI 索引，834,584 字节 / zh 815,651 字节）

顶层也是**对象数组**，共 12 个模块对象：

| 字段 | 说明 |
|---|---|
| `moduleName` | 实测全部为 `"default"` |
| `type` | 模块工作流类型：`image / video / audio / 3d / llm`（12 个模块 = image×7、video×2、audio、3d、llm） |
| `category` | 模块分组：`Foundation / Applied` |
| `icon` | 图标 |
| `title` | 模块标题（本地化语言） |
| `templates` | 模板条目，全索引共 **735** 条 |

`templates[]` 每条字段（735 条全覆盖）：

| 字段 | 出现 | 可选性 | 说明 |
|---|---|---|---|
| `name` | 735 | 必有 | 文件主键 |
| `title` | 735 | 必有 | 本地化标题 |
| `description` | 735 | 必有 | 本地化描述 |
| `mediaType` / `mediaSubtype` | 735 | 必有 | **指缩略图资产类型，不是工作流类型**（video 模块模板 mediaType 全为 image）。实测分布：mediaType image=724 / audio=11；mediaSubtype webp=724 / mp3=11 |
| `tags` | 735 | 必有 | 本地化标签数组 |
| `models` | 733 | 可选 | 模型显示名数组（如 `["SD3.5","Stability"]`） |
| `date` | 735 | 必有 | `YYYY-MM-DD` |
| `size` | 713 | 可选 | **模型总下载字节数**（本地模型模板才有，API 模板为 0）；实测最大 142.7 GB（all_in_one_image_edit_models） |
| `usage` | 735 | 必有 | 同 mcp |
| `username` | 735 | 必有 | 作者（多为 "ComfyUI"） |
| `openSource` | 684 | 可选 | 布尔（false 多为 API 模板） |
| `searchRank` | 625 | 可选 | 整数 |
| `io` | 654 | 可选 | `{inputs,outputs}`，实测多为**空字符串**（如 `"inputs": ""`），疑似前端展示用的输入/输出示例说明 [语义未验证] |
| `thumbnail` | 371 | 可选 | 路径数组，如 `"output/xxx.png"`、`"thumbnail/xxx-1.png"`、`"thumbnail/xxx.mp4"`、`"input/xxx.png"` |
| `logos` | 338 | 可选 | `[{provider: "ByteDance"}]` 等 |
| `thumbnailVariant` | 215 | 可选 | 如 `hoverDissolve`、`compareSlider` |
| `tutorialUrl` | 159 | 可选 | 教程链接 |
| `requiresCustomNodes` | 79 | 可选 | 自定义节点包名数组（缺模型对账时也要查这个） |
| `includeOnDistributions` | 25 | 可选 | 实测值 `local` / `cloud` |
| `isApp` | 18 | 可选 | 布尔 |

---

## 二、中英文索引差异与取舍

实测结论（index.json vs index.zh.json）：

- 两者结构**完全同构**：同为 12 模块、735 条模板、字段集合逐一相同（无一方独有字段），仅 title/description/tags 为各自语言。moduleName/type 等结构字段一致。
- mcp 与完整索引的关系：**mcp 是完整索引的真子集**。mcp 694 条全部能在 index.json 找到（差集=0）；反向有 **41 条**只在 index.json（如 `image_lens_t2i`、`utility_image_upscale_supir`、`audio_yue2_text2music` 等），筛选标准未在仓库内找到说明 [不确定]。

**不能只拉一份**，取舍：

- 只要检索/推荐（按 task、model、io、recommend 筛）→ **index.mcp.json 一份够**：597 KB、字段规整、无空值字符串、有 capabilities.workflow 与 model_options（完整索引里这两个字段都没有）。
- 中文场景且需要：① 覆盖 mcp 缺的 41 条；② 模型体积（size，做"下载量预估"）；③ 缩略图路径、作者、日期、教程链接、requiresCustomNodes → 拉完整索引。中文用户拉 `index.zh.json`（title/description/tags 全中文），英文兜底用 `index.json`。
- 两份都拉的成本：mcp 597 KB + zh 816 KB ≈ 1.4 MB，不构成负担。推荐组合：**mcp（检索）+ zh（中文展示与 size/缩略图/自定义节点对账）**。
- index.zh-TW.json 存在与未实测：仓库 README 口径有 11 个语言变体，本次未逐一验证 [不确定]。

---

## 三、单模板结构（templates/<name>.json）

实测 2 个：`image_qwen_image_2_1_image_edit.json`（图生图/编辑，96,740 B）与 `video_minimax_h3_i2v.json`（图生视频，71,812 B），另抽 11 个做字段扫描。

顶层键（两个样本一致）：

```
{
  id, revision, last_node_id, last_link_id,
  nodes[], links[], groups[], definitions{subgraphs[]}, config{}, extra{}, version
}
```

- **是 ComfyUI 前端 UI 格式**：`version: "0.4"`，`extra.frontendVersion` 存在，节点含 widgets_values/pos/mode 等前端字段。
- **注意 subgraph**：主力加载节点不在顶层 `nodes[]` 里，而在 `definitions.subgraphs[].nodes[]`。顶层 nodes 的 `type` 可能是 UUID（引用 subgraph），两个样本顶层都是 1 个 UUID 节点 + UI 节点；subgraph 内分别 15 / 21 个节点。做节点遍历必须**递归进 definitions.subgraphs**。
- 精简字段树：

```
root
├─ version: "0.4"
├─ extra { frontendVersion, VHS_*, ds, ... }
├─ nodes[]                      ← 顶层 UI 节点 + subgraph 引用(UUID type)
│   └─ { id, type, pos, mode, properties{...}, widgets_values[] }
├─ links[]
├─ groups[]
├─ config {}
├─ definitions
│   └─ subgraphs[]
│       ├─ { id, version, state, revision, config, name,
│       │    inputNode, outputNode, inputs[], outputs[], widgets[],
│       │    nodes[], groups[], links[], extra }
│       └─ nodes[]
│           └─ { id, type(真实类名), properties{
│               "Node name for S&R": "UNETLoader",
│               cnr_id?, ver?,
│               models?: [ {name,url,directory} ]   ← 见第四节
│             }, widgets_values[] }
```

---

## 四、properties.models 契约（缺模型对账依据）

对 13 个模板（图生图/编辑、视频 i2v/t2v、音频、API 类、SD3.5、Flux 等）全文递归扫描，共命中 **40 个**带 `properties.models` 的加载节点。

**models[] 每个元素恰好 3 个字段，40/40 无一例外：**

| 字段 | 类型 | 含义 | 实例 |
|---|---|---|---|
| `name` | string | 落盘文件名（含扩展名） | `"qwen_image_2.1_int8_convrot.safetensors"` |
| `url` | string | 完整下载直链，几乎全是 huggingface.co `.../resolve/main/...` | `"https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors"` |
| `directory` | string | ComfyUI models 下目标子目录 | 实测值：`diffusion_models / text_encoders / vae / loras` |

**没有 sha256、没有 size 字段**（40 个元素均未出现）。对账只能按 `name`（或 name+directory）与本机 `models/<directory>/` 比对；如需哈希校验得另外从 HF API 拿 [仓库内无此数据]。

**`cnr_id` / `ver` 的含义**（同一 `properties` 对象内，与 models 平级，可选）：

- `cnr_id`：节点来源包在 ComfyUI Node Registry 中的包名。本机 40 个命中里 34 个为 `"comfy-core"`（即原生节点），其余节点没有该字段。
- `ver`：该节点对应包的**版本号**（工作流作者使用的版本）。实测值如 `0.33.0`、`0.3.73`、`0.11.0` 等，与 cnr_id 成对出现。
- 用途：对账"缺模型"之外还要对账"缺节点/节点版本"——非 comfy-core 的 cnr_id + ver 指向需要安装的 custom node 包；index.json 的 `requiresCustomNodes`（79 条）是同一问题的另一个线索。
- 缺模型对账遍历路径：`definitions.subgraphs[].nodes[]` 与顶层 `nodes[]` 都要扫，判据 = `node.properties.models` 存在。

---

## 五、缓存与条件请求实测结果

对 `raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.mcp.json`：

| 项 | 实测值 |
|---|---|
| HEAD 状态 | 200（Fastly 边缘，X-Cache: HIT） |
| `ETag` | `W/"a3ca8a0b58d05fac4823eaed7fb807ecd08b8e7131186cbbf3ec4d029264c60d"`（弱 ETag = git blob SHA） |
| `Cache-Control` | `max-age=300` |
| `Last-Modified` | **不存在**（HEAD 响应头中无此字段，If-Modified-Since 路线不可用） |
| `Content-Length` | **未返回**（HEAD 响应中观察不到；有 `Accept-Ranges: bytes`） |
| `Access-Control-Allow-Origin` | `*` |
| 条件请求 If-None-Match | **确认返回 304**（回传同一 ETag 实测 `304 Not Modified`） |

结论：**ETag 条件请求可用**（强一致，git blob SHA 级），Last-Modified 不可用。缓存策略建议：本地存 ETag，启动时带 If-None-Match 发条件 GET，304 即用缓存；max-age=300 意味着无脑轮询最多 5 分钟即可感知更新，但 ETag 路线更省流量。

---

## 六、镜像实测结果

`https://cdn.jsdelivr.net/gh/Comfy-Org/workflow_templates@main/templates/index.mcp.json`：

| 项 | 实测值 |
|---|---|
| 可访问性 | 200 |
| 内容一致性 | **SHA256 与 raw 完全一致**（`0805344F…C760`，597,407 字节逐字节相同） |
| CORS | `Access-Control-Allow-Origin: *`，且 `Access-Control-Expose-Headers: *`、`Timing-Allow-Origin: *` |
| 缓存策略 | `Cache-Control: public, max-age=604800, s-maxage=43200`（浏览器 7 天、CDN 12 小时） |
| Content-Type | `application/json; charset=utf-8`（raw 是 `text/plain`） |
| ETag / 条件请求 | `W/"91d9f-2298709b8a571359"`；If-None-Match 回传后实测 **304** |
| 版本头 | `x-jsd-version: main`、`x-jsd-version-type: branch` |

结论：镜像可用且内容一致，CORS 与缓存策略均利于浏览器/应用内直连。**注意**：jsdelivr 按 branch 镜像且 CDN 缓存 12 小时，`@main` 可能比 raw 慢数小时；要强一致用 raw+ETag，要高可用低延迟用 jsdelivr。

---

## 七、规模统计

**index.mcp.json 内部**：
- 模板总数 **694**；分类分布见第一节表。
- mediaType：mcp 索引里没有该字段（那是完整索引的缩略图字段）。按完整索引 735 条的模块 type 分布：image≈348、video=271、audio=46、3d=50、llm=20（mcp 的 694 是其子集）。
- minComfyUIVersion：113 个不同值；**min = 0.0.1，max = 0.43.2**；3 条缺失。
- **本机 0.43.0 对照**：满足 684 条；**不满足 7 条**（4 条要求 0.43.2：`api_ideogram_v4_5_precise_image_edit`、`video_pika_h3_flex_t2v`；3 条要求 0.43.1：`api_veed_dubbing`、`api_patina_material_t2m`、`api_patina_material_i2m`、`api_patina_pbr_maps`、`api_patina_material_extract`）；3 条无版本要求视为满足。版本不满足率仅 1%。
- `capabilities.workflow` 含 `api` 标签的有 **404 条**（58%）——这些不需要本地模型权重。

**模板文件体积**（git tree API 全量 751 个 templates/*.json，含 13 个索引文件）：
- 工作流 json 总量 **≈37.8 MB**，均值 51.5 KB。
- 分布：<10KB 306 个、10–50KB 263 个、50–200KB 149 个、>200KB 33 个。
- **最大 1,063 KB**（`templates-sprite_sheet.json`）。
- 一致性：694 个 mcp 名称与 735 个 index 名称**全部**有对应 json 文件（0 缺失）。
- 缩略图：templates/*.webp 共 942 个，命名 `<name>-1.webp` 起（多页递增）。
- 结论：**一次性全量缓存完全可行**（json 共 ~38 MB；缩略图另计，未测总体积）。

---

## 八、不确定项

1. `usage` 与 `searchRank` 的确切语义（周活？总使用？）未见官方文档 [未验证]。
2. `capabilities.model_options` 的语义（节点类名 → 该节点 widget 可选模型列表）是从 86 个键与节点类名对应关系归纳的，未在官方文档核对映射规则。
3. `io` 字段中 `image×2` 等记法是字符串内嵌的（如 `"image×2: Reference images"`），数量后缀的解析规则未见文档；`index.json` 里的 `io.inputs/outputs` 常为空字符串，语义不明。
4. mcp 相对完整索引剔除 41 条的标准不明（疑似非精选/社区模板）。
5. `cnr_id`/`ver` 语义按 ComfyUI Node Registry 惯例 + 实测值（全部为 `comfy-core`）归纳，未遇到第三方包样本。
6. index.zh-TW.json 等 11 个语言变体未逐一拉取验证，仅验证了 zh。
7. raw HEAD 未返回 Content-Length（GitHub raw 行为），无法用 HEAD 的体积做变更检测；ETag 可用。
8. 本机 0.43.0 的对比以字符串转 [version] 的 semver 比较为准，未考虑预发布/构建元数据后缀（数据中未出现）。
9. 模板 json 内 links/groups/config 的完整 schema 未逐字段枚举（对"检索+拉取+对账"三段不需要）。

## 附：三段伪代码所需的一切都已具备

- 检索：mcp（或 zh）数组遍历，字段见第一节；排序可用 usage/recommend/freshness，过滤用 task/workflow/model_options。
- 拉取：`templates/{name}.json`（raw 或 jsdelivr），解析后递归 `definitions.subgraphs[].nodes[]` + 顶层 `nodes[]`。
- 缺模型对账：收集 `properties.models[]` 的 `{name,url,directory}`，对照本机 `ComfyUI/models/{directory}/{name}`；同时收集 `properties.cnr_id/ver`（非 comfy-core 即需装 custom node），辅以 index.json 的 `requiresCustomNodes` 与 `size`（下载量预估）。
- 缓存：ETag 条件请求（raw 强一致）或 jsdelivr 镜像（7 天浏览器缓存）。
