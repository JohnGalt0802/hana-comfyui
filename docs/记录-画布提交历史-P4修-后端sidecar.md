# 记录：画布提交历史 P4 修 · 后端 sidecar（产物图持久化）

**日期**：2026-10-11
**执行方**：A（后端）
**依据契约**：`docs/方案-画布提交历史-P4修-P6.md` §二（逐字实现）
**范围**：只改 `app/bridge/history_store.py`、`app/bridge/__init__.py`、`app/bridge/history_store.test.py`；未碰任何 js。

---

## 一、为什么这么做（背景，继承自契约）

P4 缩略图取图走 `GET /history/{promptId}`，是 ComfyUI **内存态，重启即空**（实测 17 个
promptId 全返回 `{}`，磁盘图仍在）。改为：出图后把**产物文件名**持久化到 sidecar 文件，
UI 直接读磁盘拼 URL，彻底不碰 `/history`。

选 sidecar 而非改索引行：索引是 JSONL 追加写（天然无竞态），回填要改已写行会破坏追加语义；
sidecar 是 per-commit 独立小文件，可独立更新、无并发竞态。

---

## 二、改动清单（文件 + 行号 + 作用）

### 1. `app/bridge/history_store.py`

| 位置 | 符号 | 作用 |
|---|---|---|
| L50 | `IMAGES_SUFFIX = ".images.json"` | 新增常量：sidecar 后缀（保留快照名 `.json` 再追加，避与快照同基名冲突） |
| L709–745 | `list_commits(workflow, user_dir)` | 改写：每条 entry **只读合并** `runs`（有 sidecar → 单元素 `[{promptId,at,images}]`，无 → `[]`）与 `images`（runs 扁平合并，无 → `[]`）。**不改索引磁盘内容**；`runs[].at` 取该 entry 的提交 `at`（P5a 形态），非 sidecar.updatedAt |
| L808 起 | `# ── 13. 产物图 sidecar（P4 修）` | 新增小节 |
| L811 | `_sidecar_file_name(snapshot_file)` | `<快照文件名>.images.json` |
| L816 | `_norm_image_item(im)` | 图项规范化：只留 `filename`(str,非空)/`subfolder`(str,缺省"")/`type`(str,缺省"output")；无有效 filename → None |
| L836 | `_image_key(im)` | 去重键：`filename+subfolder+type`（NUL 分隔） |
| L841 | `_merge_images(existing, incoming)` | 按去重键合并（先 existing 后 incoming，保持首次出现顺序） |
| L862 | `_find_entry_by_prompt_id(entries, prompt_id)` | 按 promptId 找 entry（首个匹配） |
| L871 | `_read_sidecar_images(dir_path, snapshot_file)` | 读 sidecar `images`；无/坏/非对象 → `[]` |
| L889 | `read_images_for(workflow, user_dir, prompt_id)` | 内部用：读 sidecar → list；无 → `[]` |
| L918 | `attach_images(workflow, user_dir, prompt_id, images, at=None)` | 主入口：校验→找 entry→去重合并→**原子写**（`.tmp`→`os.replace`）；返回 `{ok,status,file,count}` |

`attach_images` 校验/状态码：
- `400`：`workflow` 空/非串；`promptId` 空/None；`images` 非数组或空数组；任一图项无有效 `filename`
- `404`：索引里无该 `promptId`
- `500`：`user_dir` 未就绪；索引读取失败；索引 entry 缺 `file` 或 `file` 含路径；序列化/写盘失败

### 2. `app/bridge/__init__.py`

| 位置 | 作用 |
|---|---|
| L65 | 新增 `from .history_store import attach_images as _history_attach_images` |
| L70 | import 失败分支补 `_history_attach_images = None` |
| L626–644 | 新增 `POST /hana_bridge/history-attach-images`：body 取 `workflow/promptId/images/at` → 调 `attach_images(...)` → 按 `status` 出 HTTP。**不校验 token**（与其它 history-* 端点同口径） |
| L687 | 路由注册日志补 `history-attach-images` |

### 3. `app/bridge/history_store.test.py`

新增 `class TestAttachImages(TempRootTestCase)`（L635 起，13 个用例，全部 tempfile 隔离）：

- `test_suffix_constant` — 常量值
- `test_attach_roundtrip` — sidecar 写读往返（文件名 `<快照名>.images.json`、`.tmp` 已被消费、内容含 promptId/updatedAt/images）
- `test_attach_normalizes_and_drops_extra_fields` — 只留 filename/subfolder/type，多余字段丢弃；缺省补 `""`/`"output"`
- `test_attach_idempotent_same_and_append_new` — 幂等：同图重复上报不累加；新图追加；批内去重
- `test_attach_same_filename_diff_subfolder_not_deduped` — 同 filename 不同 subfolder 不视为重复
- `test_attach_404_unknown_prompt_id` — 索引无该 promptId → 404，且不写 sidecar
- `test_attach_404_unknown_workflow` — 未知工作流 → 404
- `test_attach_400_missing_fields` — 缺 workflow/promptId、images 非数组/空、图项无 filename → 400，且不落 sidecar
- `test_attach_500_missing_user_dir` — user_dir 空 → 500
- `test_read_images_for_absent` — 无 sidecar / 未知 workflow / 未知 promptId → `[]`
- `test_list_commits_merges_sidecar` — 有 sidecar 的 entry 带 `runs`/`images`；无 sidecar 的为空数组；索引磁盘内容未被改（`runs` 仍 `[]`、无 `images` 字段）
- `test_list_commits_no_sidecar_all_empty` — 全无 sidecar → 全空数组
- `test_sidecar_bad_json_reads_empty` — sidecar 坏 JSON → 读作空，不抛异常
- `test_attach_does_not_touch_real_history_dir` — 落盘全在 tempfile 根下，不碰真实 `.history`

---

## 三、测试运行命令与输出

```
D:\ComfyUI\venv\Scripts\python.exe app\bridge\history_store.test.py   # cwd: D:\HanakoWorks\ComfyUI
```

输出（末尾）：
```
Ran 70 tests in 0.473s
OK
```

全绿（原 57 + 新增 13 = 70）。

编译校验：
```
D:\ComfyUI\venv\Scripts\python.exe -m py_compile app\bridge\history_store.py app\bridge\history_store.test.py app\bridge\__init__.py
→ py_compile OK
```

---

## 四、未做 / 存疑项

1. **未部署、未重启、未跑真机** —— 按派工要求，验证由主脑做（含「重启后 sidecar 仍可读」的端到端判据）。
2. **未改 `BRIDGE_BUILD_TAG`** —— 按派工要求，主脑统一改。
3. **本批 entry 恒单 run** —— `list_commits` 的同 promptId 多 run 合并语义（P5b）不在本批；本批有 sidecar 即单元素 runs。
4. **`runs[].at` 口径** —— 取 entry 的提交 `at`（P5a 定义），非 sidecar 的 `updatedAt`；UI 若需要回填时刻可读 sidecar 文件的 `updatedAt`（未并入 list 返回字段）。
5. **sidecar 未纳入版本/清理策略** —— 快照被删/回滚时 sidecar 不会自动清（本批未涉及），留待后续。
