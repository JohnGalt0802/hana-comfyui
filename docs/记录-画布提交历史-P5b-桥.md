# 记录：画布提交历史 P5b — 桥侧（HEAD / 提交带参 / 回跳写 HEAD / 存档按钮）

**日期**：2026-10-11
**范围**：只改一个文件 `app/bridge/js/hana-bridge-11232933.js`（桥前端 B 方）
**契约**：`docs/方案-画布提交历史-P5b-数据模型接线.md` §三（桥侧）
**状态**：代码完成，`node --check` 通过（exit 0）；未部署、未重启、未跑真机。

---

## 一、改动清单（函数 + 行号 + 做了什么）

| # | 位置（改后行号） | 函数/常量 | 改动 |
|---|---|---|---|
| 1 | L2213–2270 | `HISTORY_HEAD_LS_PREFIX`、`historyPageKey()`、`historyHeadKey()`、`historyHeadGet()`、`historyHeadSet()` | 新增 HEAD 管理组（per-workflow localStorage） |
| 2 | L2277–2317 | `reportHistoryCommit({graph, promptId, blocks, source="user", kind="run"})` | 签名加可选参 `source`/`kind`（默认 "user"/"run"）；body 增 `source`/`kind`；读 `historyHeadGet().seq` 作 `parent`（无 HEAD 不传）；`postJson` 改为读响应，未合并（`ok`且`merged!==true`且`seq!=null`）→ `historyHeadSet(seq, at)` |
| 3 | L2541–2543 | `let historySaveBusy`、`let historyBarGroup` | 新增存档防重入状态 + 弹层锚定 group（存档后刷新用） |
| 4 | L2548–2551 | CSS `.hhb-save` | 新增存档按钮样式（含 `:hover` / `[disabled]`） |
| 5 | L2657–2659 | `historyBarClose()` | 关闭时一并清 `historyBarGroup` |
| 6 | L3252–3254 | `historyBarOpen(group)` | 记录 `historyBarGroup = group` |
| 7 | L3312–3327 | `historyBarOpen` foot 区 | 在「回到这一版」旁加「存档当前画布」按钮（`hhb-save`），点击 → `historySaveClick()` |
| 8 | L3779–3785 | `historyRollbackExecute()` | `okGraph !== null` 成功后写 HEAD：`historyHeadSet(回跳 seq, snap.at)` |
| 9 | L3828–3890 | `HISTORY_SAVE_PATH`、`historySaveClick()`、`historyBarReopen()` | 新增存档动作：抓 `app.graph.toJSON()` → POST `/hana_bridge/history-save` → 成功刷新弹层 + `historyRollbackToast("已存档 #NNN")`；失败落弹层红字 |

标签/文件名未改；未加依赖。

---

## 二、HEAD 键设计与读写时机

**键结构**（照抄 copilot 惯例，含 `fnv1aU32`）：
```
hana.history.head.v1:<ws>:<hashPath(pageKey)>
```
- `<ws>` = `copilotWorkspaceId()`（非云 `personal`；云读 `sessionStorage` 的 `Comfy.Workspace.Current`）
- `pageKey` = `historyPageKey()`：`activeWorkflow.path` → fallback `key` → `filename/name`；取不到 → 不发键
- 值 = `{ seq, at }` 最小信息

**读写时机**：
| 时机 | 动作 |
|---|---|
| 提交前（`reportHistoryCommit`） | `historyHeadGet()` 取 `seq` → body.`parent`（无 HEAD → 不传字段，后端线性默认=索引末条） |
| 提交成功、未合并（响应 `ok` 且 `merged !== true`） | `historyHeadSet(新 seq, at)`，HEAD 移到新节点 |
| 提交响应 `merged: true` | HEAD **不变**（仍是目标节点），不写 |
| 回跳成功（`historyRollbackExecute` 中 `okGraph !== null`） | `historyHeadSet(回跳 seq, snap.at)` → 之后「改再提交」的 parent 指向回跳节点 = **分支** |
| 弹层关闭 | 不改 HEAD |

异常（坏 JSON / 无 key / 写失败 / localStorage 不可用）一律 `try/catch` 吞，返回 `null` 或静默。

---

## 三、存档按钮：位置与行为

**位置**：弹层底部 `foot` 区（`historyBarOpen` 内），「回到这一版」按钮右侧、提示行左侧 ——
`foot.append(roll, saveBtn, tip)`。不动 P6 横轴骨架与三态交互，只在既定 foot 区插一个按钮。

**行为**（`historySaveClick`）：
1. 抓当前画布 `app.graph.toJSON()`（失败或空画布 → 弹层红字，直接返回）
2. `POST /hana_bridge/history-save`，body `{workflow, graph, at}`（无 `promptId` —— 不运行）
3. 成功（`resp.ok` 且 `data.ok === true`）→ 顶部 toast「已存档 #NNN」（`seq` 不足 3 位补零）+ 同 group 重开弹层（`historyBarReopen` → `historyBarOpen(historyBarGroup)` 重新 load）
4. 失败 → 弹层内红字「存档失败：…」，画布不动
5. 存档**独立动作**：不读写 `historyBarSelection`，不影响回跳选中态；`historySaveBusy` 防重入

---

## 四、`node --check` 输出

```
$ node --check app/bridge/js/hana-bridge-11232933.js; echo "EXIT=$LASTEXITCODE"
EXIT=0
```

---

## 五、未做 / 存疑项

1. **未部署/未重启/未真机**：按约束，只做静态实现 + `node --check`；合并/分支/存档/四色的真机验收由主脑统一跑（契约 §五 要求真机）。
2. **`source`/`kind` 可选参无调用方改动**：`installQueuePromptCapture` 里调用点仍是 `reportHistoryCommit({graph, promptId, blocks})`，走默认 `"user"`/`"run"`。为 P8 agent 通道预留参数位，本批**故意不改触发方**。
3. **`merged` 判定以后端响应为准**：桥只读 `data.merged`/`data.seq`；连跑两次仅改 seed 时，第二条响应应为 `{merged:true, targetSeq}` → HEAD 不动，桥不做本地 sig 判定（契约决定 1）。
4. **存档成功提示用 toast 而非弹层内提示行**：理由同回跳成功 —— 刷新会重建弹层，提示行会被 load 覆盖；故挂一次性顶层 toast（复用 `historyRollbackToast`）。若主脑要求提示必须留在弹层内，需改为「刷新后回填提示行」的额外状态。
5. **`historyBarGroup` 依赖 `historyBarOpen` 的入参**：`historyBarReopen` 用最后一次 open 的 group 重开；若 group 在两个 open 之间被删除，重开后调用方已有兜底（`historyBarOpen(null)` 走当前工作流名）。
