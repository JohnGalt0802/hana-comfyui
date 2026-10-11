# 记录：画布提交历史 P5a — 数据模型纯逻辑（`canvas-history.mjs` + `history_store.py`）

**日期**：2026-10-11
**范围**：只改 4 个文件——
`app/lib/canvas-history.mjs`、`app/lib/canvas-history.test.mjs`、
`app/bridge/history_store.py`、`app/bridge/history_store.test.py`。
**依据**：`docs/方案-画布提交历史-P5-数据模型.md` §二（数据模型）/ §四（兼容）/ §五（改动面）。
**纪律**：**不碰**任何其它文件（含 `app/bridge/js/*`、`app/runtime/history-commit.mjs`、`app/bridge/__init__.py`）。
两文件是同一数据模型的双孪生实现，字段与产出结构完全一致。

---

## 一、改动清单

### 1. `app/lib/canvas-history.mjs`（JS 纯模块）

| 函数 / 常量 | 作用 |
|---|---|
| `SCHEMA_VERSION`（1 → **2**） | 快照结构版本换代 |
| `KINDS` = {run, save} | kind 白名单 |
| `isPlainObject(v)` | 内部小工具 |
| `FNV_OFFSET_BASIS` / `FNV_PRIME` / `utf8Bytes` / `fnv1aHex` | 稳定 FNV-1a 32 位 hex（UTF-8 逐字节，8 位小写 hex，左补 0）；注释写明算法，供两侧对齐 |
| `canonValue` / `canonJson` | 跨语言一致取值串（null→""、对象→排序键紧凑 JSON、布尔→"true"/"false"、数值→最短） |
| `SEED_WIDGET_RE` = /seed/i | seed 类 widget 识别 |
| `widgetsPart(node)` | 结点 widget 段串：named 优先（可按名跳 seed）；否则位置 `widget_<i>` |
| `graphSigIgnoringSeed(graph)`（新） | 归一化签名：逐节点 `type + "|" + widget 段` → fnv1a，节点段 `"|"` 串接 → 总体 fnv1a → 8 位 hex；忽略 seed 类 widget |
| `indexNodesById` / `nodeTitle` / `widgetEntries` / `changedWidgetNames` / `cmpId` | `computeDelta` 内部组件 |
| `computeDelta(prevGraph, nextGraph)`（新） | 相对 prev 算 `{changed:[{id,title,fields}], added:[{id,title}], removed:[{id,title}]}`；prev 非法 → null；fields 含 `type` 与变更 widget 名（named 用其名，否则 `widget_<i>`） |
| `shouldMergeWithHead(newSig, headSig)`（新） | 纯字符串比较（相等即 true；非字符串 false） |
| `normKind` / `normParent` / `normImages` / `normRuns` / `normBlock` / `normBlocks` | 新字段归一化 |
| `buildIndexLine`（改） | 新字段：`parent`(null)/`kind`("run")/`sig`("")/`blocks`(完整版 `[{name,source,nodeIds}]`，缺省 [])/`delta`(null)/`runs`([]) |
| `normalizeEntry(entry)`（新） | 旧条目补全新形态；缺 runs 由顶层 `promptId`/`at` 造单元素 runs；不改入参、不改磁盘 |

### 2. `app/bridge/history_store.py`（Python 纯标准库）——同口径孪生

| 函数 / 常量 | 作用 |
|---|---|
| `SCHEMA_VERSION`（1 → **2**） | 同 JS |
| `_KINDS` = ("run","save") | kind 白名单 |
| `_FNV_OFFSET_BASIS` / `_FNV_PRIME` / `_fnv1a_hex` | FNV-1a 32 位 hex（UTF-8 字节上逐字节，8 位小写 hex）；注释写明算法 |
| `_js_num_str` / `_canon_json` / `_canon_value` | 与 JS `String(Number)` 一致的取值串（整数值去小数尾，1 而非 1.0） |
| `_SEED_WIDGET_RE` = `seed`(IGNORECASE) | 同 JS |
| `_widgets_part` / `graph_sig_ignoring_seed`（新） | 同 JS 口径 |
| `_index_nodes_by_id` / `_node_title` / `_widget_entries` / `_changed_widget_names` / `_id_sort_key` / `compute_delta`（新） | 同 JS 口径 |
| `should_merge_with_head`（新） | 同 JS |
| `_norm_kind` / `_norm_parent` / `_norm_images` / `_norm_runs` / `_norm_block` / `_norm_blocks` | 新字段归一化 |
| `build_index_line`（改） | 同 JS；`blocks` 由「摘要」改为**完整版**（`{name,source,nodeIds}`） |
| `normalize_entry`（新） | 同 JS |

### 3. 测试文件

| 文件 | 新增/调整 |
|---|---|
| `app/lib/canvas-history.test.mjs` | 新增 P5a 组：新字段默认值/写入归一化、`graphSigIgnoringSeed`（稳定 hex + 忽略 seed + 对非 seed 敏感）、`computeDelta` 三类 + type/位置 widget + 非法 prev、`shouldMergeWithHead`、`normalizeEntry` 兼容、`SCHEMA_VERSION=2`、跨语言 fixture、组合链路 |
| `app/bridge/history_store.test.py` | 新增 `TestP5Purity` 类（同覆盖）；原 `test_build_index_line_no_graph` 键集断言扩到 13 字段；`test_build_index_line_blocks_*` 改为完整版；schemaVersion 断言 1→2 |

---

## 二、验证（输出原文）

### 2.1 JS 语法 + 单测

```
PS> node --check app/lib/canvas-history.mjs
（无输出 = OK）

PS> node --test app/lib/canvas-history.test.mjs
ℹ tests 50
ℹ pass 50
ℹ fail 0
ℹ duration_ms 108.95
```

（其中 P5a 新增：`buildIndexLine：新字段默认值` / `buildIndexLine：新字段写入 / 归一化` /
 `graphSigIgnoringSeed：稳定 8 位 hex，且与固定期望一致` / `graphSigIgnoringSeed：忽略 seed 类 widget，对非 seed 变化敏感` /
 `computeDelta：changed / added / removed 三类` / `computeDelta：type 变化计入 fields；title 缺失用 type；无 widgets 用 widget_<i>` /
 `computeDelta：prevGraph 为 null/非法 → null` / `shouldMergeWithHead：相等即 true，非字符串 false` /
 `normalizeEntry：旧条目补全新字段` / `normalizeEntry：promptId 缺失 → runs 为空；已有新字段原样保留` /
 `SCHEMA_VERSION：P5 换代后为 2` / `graphSigIgnoringSeed：跨语言 fixture 与 Python 侧同串` /
 `组合：buildIndexLine 新字段 → parseIndex → normalizeEntry 读回` 全 pass）

### 2.2 PY 语法 + 单测

```
PS> D:\ComfyUI\venv\Scripts\python.exe -m py_compile app/bridge/history_store.py
（无输出 = OK）

PS> D:\ComfyUI\venv\Scripts\python.exe app/bridge/history_store.test.py
Ran 56 tests in 0.287s
OK
```

### 2.3 回归：`app/runtime/history-commit.mjs` 未受影响（未改，仅验证其既有测试仍绿）

```
PS> node --test app/runtime/history-commit.test.mjs
ℹ tests 5 / pass 5 / fail 0
```

### 2.4 跨语言签名一致性（实测）

同一 graph，两侧各自算 `graphSigIgnoringSeed` / `graph_sig_ignoring_seed`：

**fixture A**（落进两侧正式单测的基准）：
```json
{"nodes":[
  {"id":1,"type":"CheckpointLoaderSimple","widgets_values":["model.safetensors"]},
  {"id":2,"type":"KSampler","widgets_values_named":{"seed":42,"steps":20,"cfg":7}},
  {"id":3,"type":"EmptyLatentImage","widgets_values_named":{"width":512,"height":512}}
],"links":[[1,1,0,2,0,"MODEL"]]}
```
```
JS_SIG   c1271398
PY_SIG   c1271398      ← 一致
```

**fixture B**（额外对拍，混合位置/命名 widget）：
```json
{"nodes":[
  {"id":1,"type":"PrimitiveInt","widgets_values":[1024]},
  {"id":2,"type":"KSampler","widgets_values_named":{"seed":123,"sampler_name":"euler","steps":20}}
]}
```
```
JS_FIX2  cac7e860
PY_FIX2  cac7e860      ← 一致
```

---

## 三、跨语言算法冻结（供两侧对齐 / 后续 P5b 桥侧复用）

- **FNV-1a 32 位 hex**：offset basis `2166136261`、prime `16777619`；输入 `str.encode("utf-8")` 逐字节 `h ^= byte; h = (h * prime) mod 2^32`；输出右对齐补 0 的 8 位小写十六进制。
- **取值串**：`null`/缺失 → `""`；对象/数组 → 键排序的紧凑 JSON（无空格）；布尔 → `"true"`/`"false"`；数值 → 整数去小数尾（`1` 而非 `1.0`），非有限 → `"null"`。
- **widget 段**：`widgets_values_named` 非空则按其键序（跳过名匹配 `/seed/i` 的项），否则按 `widgets_values` 位置（`widget_<i>`；若 `widgets_values` 是对象则按键序亦跳 seed）。结点段串 `type + "|" + widget 段`。
- **整体签名**：逐节点段先各自 fnv1a（8 位 hex），再以 `|` 串接整体 fnv1a → 8 位 hex。顺序 = `graph.nodes` 数组顺序；不含 id / mode / title / 位置 / 连线数。

---

## 四、兼容读取（方案 §四）

- `parseIndex` / `parse_index` **本身不下判断**，保持容错（缺字段照样进 entries）。
- `normalizeEntry` / `normalize_entry` 负责补全：`parent→null`、`kind→"run"`、`sig→""`、`delta→null`、`blocks→[]`、`runs→`（缺则用顶层 `promptId`/`at` 造单元素 runs；`promptId` 为 null → `[]`）。
- 新提交按 v2 写（`SCHEMA_VERSION=2`）；**不做一次性迁移**，读时兼容。
- ⚠️ `buildIndexLine`/`build_index_line` 生成的**新索引行恒含** `parent/kind/sig/blocks/delta/runs` 全部字段（缺省值写显式默认），与「旧条目字段缺失」在 JSON 语义上等价。

---

## 五、未做 / 存疑项

1. **未接桥**：`app/bridge/js/*` 零改动。P5b 才做「捕获时算 sig、父节点比对、HEAD 回跳」；本层只提供 `graphSigIgnoringSeed` + `shouldMergeWithHead` + `computeDelta` 纯函数。
2. **`computeDelta` 与 JS `canvas-diff.mjs` 不同族**：本层 `computeDelta` 只按「同 id + widget 位置值 / type」出变化 widget **名列表**（供悬停显示），**不产出 from/to**；`canvas-diff.mjs` 的 `widgets_values_named.<key>` 细粒度差异是另一套，两者不合并（本层为 P5 索引行瘦身口径）。
3. **签名与桥 `graphSignature()` 非同串**：桥版含 `mode`/`title`/widget **name**/连线数，本层为简化可复现版（不含这些）。规格 §2.6 合并判定要求同口径——P5b 桥侧须用本层 `graphSigIgnoringSeed` **同时**算「当前画布」与「最近提交快照」，才能同串可比（不可拿旧 `graphSignature()` 值直接比，已知偏差）。
4. **`app/runtime/history-commit.mjs` 未同步新字段**：属方案 §七-2 遗留（落盘双实现），本批按范围规定**只改两文件**，未动它；其既有 5 项单测仍绿（见 2.3）。P5b 需决定是否同步或标记废弃。
5. **`blocks` 快照侧去冗余未做**：方案 §2.4「快照不再重复存 blocks」涉及 `buildSnapshot`，而 `buildSnapshot` 本批未在改动面内（§五只列 `buildIndexLine`），故快照仍可能带 blocks（由桥/`commit` 传入时）。索引行已改完整版，读侧兼容已就位。
6. **Python `_norm_parent` 的 `v == ""` 判定**：对 `0` 安全（`0 == ""` 为 False），对 `False`（bool）会返回 `None`（`False == ""` 为 False，但 `float(False)`=0.0 有限 → 返回 0）——实际不会传入 bool，未额外防御。
7. **PY 包路径跑法**（`python -m unittest app.bridge.history_store.test`）会连带 import `__init__.py`（依赖 aiohttp）而失败——与本批无关的既有形态，沿用测试文件头声明的直接脚本跑法（`python app/bridge/history_store.test.py`）。

---

## 六、边界

未部署、未重启、未 frameReload、未触碰画布；单测全程 tempfile，不写任何真实用户数据；`app/bridge/js/*`、`app/runtime/*`、`app/bridge/__init__.py`、`app/ui/*` 零改动。
