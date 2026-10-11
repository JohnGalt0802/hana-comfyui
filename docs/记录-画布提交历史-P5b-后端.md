# 记录：画布提交历史 P5b · 后端数据模型接线（合并 / 分支 / save / sidecar runs）

**日期**：2026-10-11
**执行方**：A（后端）
**依据契约**：`docs/方案-画布提交历史-P5b-数据模型接线.md` §二（逐字实现）
**范围**：只改 `app/bridge/history_store.py`、`app/bridge/__init__.py`、`app/bridge/history_store.test.py`。**未碰任何 js**、未改 `BRIDGE_BUILD_TAG`。

---

## 一、改动清单（文件 + 行号 + 函数）

### 1. `app/bridge/history_store.py`

| 行号 | 符号 | 变化 |
|---|---|---|
| L604–660 | `# ── 9.5 head 定位（P5b）` 小節：`_find_entry_by_seq` / `_read_graph_from_snapshot_file` / `_head_node_graph` / `_last_node_seq` | **新增**。headSeq→节点快照 graph 读取；线性默认头 = 索引末条**节点主行**（跳过 mergeInto 行） |
| L664–758 | `commit(body, user_dir)` | **改**。接 `source`（缺省 user）/`kind`（缺省 run，白名单）/`parent`；算 `sig`；确定 `headSeq`；合并判定 → 追加 mergeInto 行 |
| L760–842 | `_create_node(...)` | **新增**。commit「新建」分支与 `save_commit` 共用：算 delta → 写快照 → 追加索引主行（带 parent/kind/sig/delta） |
| L844–890 | `save_commit(body, user_dir)` | **新增**。存档 = 永远新建 `kind="save"`、`promptId=null`、不参与合并判定 |
| L893–940 | `list_commits(workflow, user_dir)` | **改**。折叠 mergeInto 行 + 每条 entry 补 `parent/kind/sig/delta/runs/images` |
| L1058–1073 | `_sidecar_obj_to_runs(obj)` | **新增**。sidecar 对象 → runs；新形态 `{runs:[…]}` 归一；旧形态 `{promptId,images,updatedAt}` → 单元素 runs |
| L1075–1089 | `_read_sidecar_runs(dir_path, snapshot)` | **新增**。读 sidecar runs（含旧形态归一） |
| L1091–1111 | `_find_target_entry_by_prompt_id(entries, prompt_id)` | **新增**。按 promptId 定位其**主行节点**：先查主行；未中再查 mergeInto 行 → 解析回目标主行 |
| L1113–1124 | `_entry_snapshot_file(entry)` | **新增**。主行 entry 的快照文件名（带路径穿越防护） |
| L1126–1152 | `read_images_for(workflow, user_dir, prompt_id)` | **改**。改为「按 promptId 定位所属主行节点 → 在 sidecar runs 里取该 run 的 images」 |
| L1154–1191 | `_node_runs(entry, sidecar_runs, merge_rows)` | **新增**。拼节点 runs：主 run → mergeInto 行的 run（按索引序）→ sidecar 其余 run；同 promptId 去重 |
| L1193–末尾 | `attach_images(workflow, user_dir, prompt_id, images, at=None)` | **改**。sidecar 升级为 `{runs:[…]}`：按 promptId 找该 run，去重合并 images；无则新建 run |
| — | `_find_entry_by_prompt_id` / `_read_sidecar_images` | **删除**。前者不识别 mergeInto 行（P5b 已由 `_find_target_entry_by_prompt_id` 取代）；后者无调用点 |

### 2. `app/bridge/__init__.py`

| 行号 | 作用 |
|---|---|
| L63 | 新增 `from .history_store import save_commit as _history_save_commit` |
| L69 | import 失败分支补 `_history_save_commit = None` |
| L595 | 依赖就绪判定纳入 `_history_save_commit` |
| L628–641 | 新增 `POST /hana_bridge/history-save`：body 取 `workflow/graph/at?/source?` → 调 `save_commit(...)` → 按 `status` 出 HTTP。**不校验 token**（与其它 history-* 同口径） |
| L703 | 路由注册日志补 `history-save` |

### 3. `app/bridge/history_store.test.py`

| 行号 | 类 / 用例 |
|---|---|
| L636–848 | **新增** `class TestP5bWiring(TempRootTestCase)`，15 个用例：新字段写入 / 缺省 source=user、kind=run / 同 sig 合并且合并行字段与「不写新快照」/ 不同 sig 不合并 + delta / 分支 parent 传值 / 合并用 given parent / parent 指不存在 seq / save 永远新建（kind、promptId=null、不合并）+ 坏参 400/500 / sidecar runs 升级与 list 合并 / attach 经 merge 行归位 / sidecar 旧形态兼容 + attach 升级 / list 折叠 mergeInto 单 entry / entry 新字段 / 不碰真实 .history |
| L29–`TestCommit` | **改**既有用例中被本次语义变更影响的断言：`test_atomic_write_roundtrip`（source unknown→user、graph 用带 widget 值以区分 sig）、`test_list_commits_after_commits`（两次用不同 graph）、`test_list_commits_merges_sidecar`（不同 graph + 无 sidecar 条目现在返回单 run）、`test_list_commits_no_sidecar_all_empty`（同上）、`test_list_commits_legacy_entries_no_blocks_ok`（旧条目 blocks → `[]` 而非 `None`，因现在过 `normalize_entry`）、`TestAttachImages.test_attach_roundtrip`（sidecar 断言改为 `{runs:[…]}` 形态） |

---

## 二、具体实现说明

### 2.1 合并判定（契约 §2.1）

`commit()`：
1. `sig = graph_sig_ignoring_seed(body["graph"])`（P5a 函数，直接复用；比较两侧都用它才算**同串**可比）。
2. `headSeq`：`parent` 传了 → `_norm_parent(parent)`；否则 `_last_node_seq(entries)`（索引里最后一条**节点主行**的 seq；mergeInto 标记行不入选，因为它不携带快照、不是节点）。**改用 `_last_node_seq` 而非 `latest_entry`**，是为了「连跑 3 次仅改 seed」时第 3 次的线性默认头仍落在同一节点上、能继续合并。
3. `head_graph = _head_node_graph(dir_path, entries, headSeq)`：找 headSeq 行 → 取 `file` → 读快照 `graph`；路径非法 / 文件缺失 / 坏 JSON / 非对象 → `None`（等价「读不到」）。
4. **合并条件**：`kind=="run"` 且 `headSeq is not None` 且 `head_graph is not None` 且 `graph_sig_ignoring_seed(head_graph) == sig`。
   - 合并 → 追加一行（**追加，不改已写行**）：`{"seq": next_seq, "mergeInto": headSeq, "promptId":..., "at":..., "kind":"run", "source":...}`（字段名固定为契约要求的 `seq/mergeInto/promptId/at/kind/source`）；**不写新快照**；返回 `{ok:True, status:200, merged:True, targetSeq:headSeq, dir}`。
5. 否则 → 走 `_create_node`（新建节点）：
   - `delta = compute_delta(head_graph, graph)`（head_graph 读不到 → `None`）。
   - 写新快照（含 delta 不写进快照，delta 只进索引行）→ 追加索引主行，带 `parent=headSeq, kind, sig, source, delta, blocks, nodeCount, linkCount, promptId, at`。
   - 返回 `{ok:True, status:200, merged:False, seq, file, dir}`。

### 2.2 分支（parent 传值）

- `parent` 传值（非 None、非 ""）→ `headSeq = _norm_parent(parent)`，**优先于索引末条**。新建节点时索引主行 `parent` 写该值；合并判定也以该节点为 head（即「回跳到 #N，若画布与 #N 同 sig 则并回 #N；否则新建并以 #N 为父」）。
- `parent` 指向不存在的 seq → `_head_node_graph` 返回 None → 不合并、新建，索引主行 `parent` 仍如实写该 seq（契约未规定校验，保持原样）。

### 2.3 save（契约 §2.2）

`save_commit(body, user_dir)`：
- 校验 `workflow`/`graph`/`user_dir`（400/400/500）。
- `headSeq = _last_node_seq(entries)`；`head_graph` 同法读。
- 调 `_create_node(..., prompt_id=None, kind="save", parent=headSeq, head_graph=head_graph, sig=...)`。
- **不做合并判定**：即使 `kind=="save"` 与 head 同 sig 也永远新建。`promptId=null` → 快照文件名段为 `noid`。
- 端点无 token 校验（与其它 history-* 同口径）。

### 2.4 「如何按 promptId 定位节点」（关键点）

问题：合并场景下，**第二次运行**的 promptId 只出现在 mergeInto 行（主行 promptId 是第一次的），若只查主行会 404 / 落错 sidecar。

`_find_target_entry_by_prompt_id(entries, prompt_id)`：
1. 先遍历找**主行**（`mergeInto is None`）中 promptId 相同者 → 命中即返回该 entry。
2. 未命中再遍历**mergeInto 行**中 promptId 相同者 → 取其 `mergeInto` 值 = 目标 seq → `_find_entry_by_seq` 回目标**主行** entry。
3. 都不中 → None。

消费点：
- `attach_images`：定位到目标主行 → 取其 `file` → sidecar。于是「第二次运行（p2）」的产物图被合并进「第一次运行（p1）」所在节点的同一 sidecar。
- `read_images_for`：定位到目标主行 → 在 sidecar runs 里找 `promptId == pid` 的 run → 返回其 images。

### 2.5 sidecar 升级 `{runs:[…]}`（契约 §2.3）

- `attach_images` 写盘内容 = `{"runs":[{promptId, at, images:[{filename,subfolder,type}]}, …]}`。
- 读取统一走 `_sidecar_obj_to_runs`：新形态直接归一；**旧形态** `{promptId, images, updatedAt}` 归一成单元素 `{promptId, at=updatedAt, images}`；非对象/其余 → `[]`。
- `attach_images` 合并语义：读旧 runs → 按 promptId 找该 run（找不到则新建 run，`at=_to_iso(at)`）→ `_merge_images(existing.images, incoming)` 按 `filename+subfolder+type` 去重 → 原子写回（`.tmp` → `os.replace`）。返回 `{ok,status,file,count}`，`count` = 该 run 累计张数。
- 旧形态上 attach：先归一成 runs，再在（唯一的）run 上合并 → 写回即升级为新形态（旧 run 的图保留）。

### 2.6 `list_commits` 折叠 mergeInto + 新字段（契约 §2.4）

- 预扫一遍索引，把 `mergeInto is not None` 的行按目标 seq 收进 `merge_rows`。
- 遍历索引：mergeInto 行 **continue**（不单独成 entry）。
- 每条主行 entry：`normalize_entry(e)` 补 `parent/kind/sig/delta/blocks`（旧条目缺省补全）；再读该节点 sidecar runs；`_node_runs(e, sidecar_runs, merge_rows[seq])` 拼出该节点的全部 run（主行 promptId → mergeInto 行的 promptId → sidecar 里其余 run，同 promptId 去重，`at` 优先取索引行、缺失用 sidecar）；`images` = runs 里所有 images 的扁平合并。
- 结果只读合并，**不写回索引磁盘**（主行 `runs` 仍为 P5 缺省 `[]`、无 `images` 字段）。

---

## 三、测试运行命令与输出

```
PS> cd D:\HanakoWorks\ComfyUI
PS> D:\ComfyUI\venv\Scripts\python.exe -m py_compile app\bridge\history_store.py app\bridge\history_store.test.py app\bridge\__init__.py
py_compile OK          # 无输出即通过

PS> D:\ComfyUI\venv\Scripts\python.exe app\bridge\history_store.test.py
.................................................................................
----------------------------------------------------------------------
Ran 85 tests in 0.761s

OK
```

全绿（原 70 + 新增 `TestP5bWiring` 15 = 85）。全部落盘经 `TempRootTestCase` 的 `tempfile.mkdtemp` + `shutil.rmtree`，**不碰真实 `.history`**。

---

## 四、未做 / 存疑项

1. **未部署、未重启、未跑真机** —— 按派工要求（「不部署、不重启、不跑真机」）；合并的端到端真机验收由主脑做。
2. **未改 `BRIDGE_BUILD_TAG`** —— 按约束，主脑统一改。
3. **js 侧未接通** —— 桥侧（HEAD 管理 + 提交带参 + 存档按钮）属 B 方（`app/bridge/js/hana-bridge-<tag>.js`），本批零改动；`history-save` 端点已就绪待 js 调。
4. **`save` 的 `delta`** —— 相对线性默认头（索引末条节点）算；契约 §2.2 只说「同 commit 的新建分支」，未另行规定 save 的 parent 语义，此处按「线性默认头」处理（与 commit 无 parent 时一致）。
5. **`parent` 不校验存在性** —— 契约未要求；指向不存在 seq 时不合并、新建、`parent` 如实落盘（`list` 读回即该值，UI 侧如需容错自行处理）。
6. **`runs[].at` 口径** —— 优先取索引行的 `at`（权威运行时间）；仅 sidecar 有、索引无的 run 才用 sidecar 的 `at`（旧形态 `updatedAt`）。
7. **`Kind` 白名单** —— 非 `run`/`save` 一律归一为 `run`（`_norm_kind`，P5a 既有）。
8. **mergeInto 行的 `at`** —— 写 merge 时用 `_to_iso(body.at)`（缺省当前 UTC）；list 折叠时该 merge 行的 `promptId` 进目标节点 runs，`at` 取索引行的该值。
