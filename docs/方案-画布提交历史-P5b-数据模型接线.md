# 方案：画布提交历史 P5b — 数据模型接线（合并 / 分支 / 四色 / 存档）

**日期**：2026-10-11
**状态**：接口定稿（主脑），派工中
**上游**：`方案-画布提交历史-P5-数据模型.md`（数据模型定义）、`方案-画布提交历史-P4修-P6.md`（本批前序）
**前置事实**（实测）：
- 索引真实行只有 8 旧字段（`seq/file/promptId/at/source/nodeCount/linkCount/blocks`）——P5a 的 `build_index_line` 支持新字段，但 `commit()` **调用点没传**。
- 桥里没有 `graphSigIgnoringSeed`（CSP 下不能 import ESM）→ **签名只能后端算**。
- 索引是 **JSONL 追加写**（天然无竞态）→ 合并**不能改已写行**。

> 本文件属项目方案文件，修改需 John 认可。

---

## 一、三个设计决定（先说结论）

### 决定 1：合并判定放**后端**，不放前端
- 桥不能 import ESM，抄一份 `graphSigIgnoringSeed` = 双维护（正是要还的债）
- 后端是唯一写入者（进程内串行），判定与落盘原子
- 前端只负责：上报 graph + 当前 HEAD；**不算 sig、不判合并**

### 决定 2：合并用「追加一条合并行」，不改进已写行
索引保持纯追加。合并时**追加一行**：
```json
{"seq": <新行号>, "mergeInto": <目标节点 seq>, "promptId": "...", "at": "...", "runIndex": <n>}
```
读时（`list_commits`）把 `mergeInto` 行**折叠进**目标节点的 `runs[]`。追加语义不破坏、无竞态。

### 决定 3：`runs[]` 上移到 sidecar，索引只记「节点」
- 索引主行 = 一个**提交节点**（`seq/parent/kind/sig/file/at/source/delta/blocks/...`）
- `runs[]` 明细（每 run 的 promptId + 图）存 **sidecar**（`<file>.images.json` 升级为 `{runs:[{promptId,at,images}]}`）
- 理由：合并要往 runs 里加，而索引不能改行；sidecar 本就是"可独立更新的 per-commit 文件"

---

## 二、接口契约（冻结）

### 2.1 `POST /hana_bridge/history-commit`（改）
**请求新增字段**：
```json
{ "workflow": "...", "promptId": "...", "graph": {...}, "at": "...",
  "source": "user" | "agent",          // 新增（缺省 user）
  "kind": "run" | "save",              // 新增（缺省 run）
  "parent": <number|null> }            // 新增：当前 HEAD 节点 seq；null=线性默认（索引末条）
```
**行为**（后端逻辑，权威）：
```
1. sig = graph_sig_ignoring_seed(graph)
2. headSeq = (parent 传了 ? parent : 索引末条 seq)
3. 若 kind=="run" 且 headSeq 存在 且 headSeq 节点的 sig == 本次 sig：
     → 合并：追加一行 {mergeInto: headSeq, promptId, at}；不写新快照
     → 返回 {merged: true, targetSeq: headSeq}
4. 否则：
     → 新建节点：算 delta = compute_delta(headSnapshot.graph, graph)（headSnapshot 读不到则 null）
     → 写新快照 + 追加索引主行（parent=headSeq, kind, sig, source, delta）
     → 返回 {merged: false, seq: <新>, file: "..."}
```
**响应**：`{ ok, status, merged, seq|targetSeq, file }`

### 2.2 `POST /hana_bridge/history-save`（新，存档工具）
**请求**：`{ workflow, graph, at?, source? }`（**无 promptId**——不运行）
**行为**：同 commit 的"新建节点"分支，但 `kind="save"`、`promptId=null`、**不参与合并判定**（存档永远新建节点）。
**响应**：`{ ok, status, seq, file }`

### 2.3 sidecar 升级 `{runs:[...]}`
`<file>.images.json` 内容升级为：
```json
{ "runs": [ { "promptId": "...", "at": "...", "images": [{filename,subfolder,type}] } ] }
```
**兼容旧形态**：旧文件是 `{promptId, images, updatedAt}` → 读时归一成 `{runs:[{promptId, at:updatedAt, images}]}`。

### 2.4 `GET /hana_bridge/history-list`（改）
每条 entry（节点）**新增**：
- `parent`: number|null
- `kind`: "run" | "save"
- `sig`: string
- `delta`: object|null
- `runs`: `[{promptId, at, images[]}]`（从 sidecar 读；merge 行的 run 也并进来）
- `images`: runs 里所有 images 的扁平合并

**折叠规则**：`mergeInto` 行不单独成 entry，其 `promptId` 并入目标节点的 runs。

---

## 三、桥侧（前端）

### 3.1 HEAD 管理（per-workflow localStorage）
- 键：`hana.history.head.v1:<workflowKey>`（沿用 copilot 的 localStorage 惯例：`fnv1aU32` 哈希路径）
- 值：`{ seq, at }`
- 提交成功后 → 写新 seq；回跳成功后 → 写回跳到的 seq
- 提交时读它作 `parent`（无 → 不传，后端用线性默认）

### 3.2 提交上报带参
`reportHistoryCommit` 增 `source`/`kind`/`parent`：
- `source`：默认 `"user"`（人点运行）；**为 P8 的 agent 通道留参数位**（本批不改触发方）
- `kind`：默认 `"run"`
- `parent`：读 HEAD

### 3.3 存档触发（UI 入口）
给"人"一个存档入口：弹层底部加一个「存档当前画布」按钮（或复用现有位置），点击 → `POST /hana_bridge/history-save`（带当前 graph）→ 成功后刷新弹层。
- **agent 通道**（op）留到 P8；本批只做人的按钮。

### 3.4 四色生效
P6 已按 `(source, kind)` 2×2 实现色相/形态。本批数据打通后：
- `source="user"` + `kind="run"` → 冷色实心（人提交）
- `source="user"` + `kind="save"` → 冷色空心（人保存）
- `source="agent"` + `kind="run"` → 暖紫实心（agent 提交）
- `source="agent"` + `kind="save"` → 暖紫空心（agent 保存）
**UI 代码不改**（P6 已就绪），只验数据打通后颜色正确。

---

## 四、改动面

| 文件 | 改动 | 执行方 |
|---|---|---|
| `app/bridge/history_store.py` | commit 接新字段 + 合并判定 + save_commit + sidecar 升级为 runs | A |
| `app/bridge/__init__.py` | commit 传新字段 + 新端点 `history-save` | A |
| `app/bridge/history_store.test.py` | 合并/分支/save/sidecar runs/兼容旧形态 | A |
| `app/bridge/js/hana-bridge-<tag>.js` | HEAD 管理 + 提交带参 + 存档按钮 + 回跳写 HEAD | B |

**A、B 改不同文件，可并行。** 接口以本文件为准。

---

## 五、验收

| 项 | 判据 |
|---|---|
| 合并 | 连跑两次**仅改 seed** → 索引只多 1 个节点；该节点 runs 有 2 条 |
| 不误合并 | 改 steps/提示词再跑 → 新建节点（sig 不同） |
| 分支 | 回跳到 #N → 改 → 提交 → 新节点 `parent == N` |
| 存档 | 点「存档」→ 新增 `kind="save"` 节点（`source` 按触发者） |
| 四色 | user/run 冷实心、user/save 冷空心（agent 两色待 P8 通道） |
| delta | 新建节点的 delta 含真实变更节点名 |
| 兼容 | 旧 17 条记录仍能正常显示（无 parent/kind/sig/runs → 缺省） |

**验证纪律**：本批**必须真机**（跑真生成验合并）。测试用**自建测试件**，不得消费 John 的工作流。

---

## 六、不在本批

- **P7**：提交树 UI（hui 底部）
- **P8**：agent native（op 通道、副驾驶暴露、存档的 agent 入口）
- **P9**：插件拆分
