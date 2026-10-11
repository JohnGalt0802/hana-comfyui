# 待办：画布提交历史 · 非 UI 技术项（2026-10-12）

> UI 相关（树样式微调、弹层跟随手感、选中态联动）**暂缓**，John 说 UI 后面再说。
> 本清单只收**非 UI 的功能缺口与债**。

---

## N1 · 桥不监听工作流切换【真 bug，优先】
**现状**：`setup()` 只装了 queuePrompt 捕获 / 出图捕获 / 树容器 / 点击命中 / pollGraph。
**没有**监听「切换工作流 / 画布换图」事件。
**后果**（已亲眼见）：切工作流后，底部提交树仍显示上一个工作流的计数（新工作流显示「0 节点」），
弹层的 `historyBarLatestEntry` 比对基线也过期。`historyTreeRefresh` 只在 commit/回跳/展开时调。
**修法方向**：监听 ComfyUI 的图切换事件（`litegraph:set-graph` / `api` 的 workflow 事件，
真机先探准事件名），切换后 `void historyTreeRefresh()` + 清理弹层（若有）。

## N2 · `app/runtime/history-commit.mjs` 与 `history_store.py` 脱节【债】
**现状**：P5a/P5b 给 `history_store.py` 加了 `parent/kind/sig/runs/delta/mergeInto/sidecar`；
`app/runtime/history-commit.mjs`（早期中继落盘通道）**无这些字段**（实测 grep 零命中）。
**后果**：两套落盘实现结构不一致；若走中继通道（`/_relay/history/commit`）会写出旧结构。
**调查结论（2026-10-12）**：它有路由（`comfy-relay.mjs` L57 import、L2955-2970 挂 `POST /_relay/history/commit`），
但**无任何调用方**——`app/bridge/__init__.py:578` 注释明说「桥页面够不到中继的 `/_relay/history/commit` → 404」，
P1 最终改道桥 Python 端点。即「路由挂了、没人走」的死通道。
**处置决定**：**标记弃用（不删）** —— 文件头加醒目注释说明「已弃用，改用 /hana_bridge/history-commit；
此中继通道无调用方，勿使用；若将来恢复需补 parent/kind/sig/runs/delta」。

## N3 · 快照重复存 `blocks`【冗余债】
**现状**：方案 §2.4 定「快照不再重复存 blocks，只索引存完整版」；实际 `build_snapshot` 仍
原样透传 `blocks`（`history_store.py:452`），快照+索引两份都带。
**后果**：快照体积白涨（每份含块归属）。
**修法方向**：`build_snapshot` 去掉 blocks（读侧兼容：索引已有完整版）。

## N4 · 中继 43 行未部署【悬空】
**现状**：与 N2 同源（`/_relay/history/commit` 通道），**未部署**且无调用方。
**处置**：随 N2 一起标记弃用；不部署（部署了也是死路由）。

## N5 · 归档 / 清理策略缺失【缺口】
**现状**：`.history/` 目录只增不减；sidecar 不随快照删；无上限、无清理。
**修法方向**：设计清理口径（保留最近 N 条 / 按体积 / 手动清理入口）。

---

## 已在本次会话验过、无需动的
- 合并判定（后端）：真机验证 merged/不合并/分支/save 全通
- 框视角（blockNames）：真机验证精确命中
- 出图回填 + sidecar：重启后缩略图仍在（实测）
- P7 树：真机验证分层/连线/计数

## 优先级建议
1. **N1**（真 bug，用户每天都会碰到切工作流）
2. **N3**（小改动，顺手）
3. **N2 + N4**（一起定去留；先查调用点）
4. **N5**（设计型，最后）
