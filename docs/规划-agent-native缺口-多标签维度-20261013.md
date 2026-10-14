# 规划：agent native 操作工具缺口 · 多标签工作流维度（2026-10-13）

**触发**：循环任务——「借此机会重新审视 agent native 的操作工具缺口，从类似刚才的真实需求入手，做好规划，一次性补齐」。
**起点**：刚发生的真实需求（往 `Qwen21 t2i 质量版 (00001)  (Copy)` 加差分放大支路）暴露的核心缺口。
**性质**：审计 + 规划；确认后一次性补齐。

---

## 一、缺口总览（以"刚才那个真实需求"为标尺）

刚才我要往「非前台标签」写画布，链条在**每一步**都断了：

| 环节 | agent 现状 | 缺口 | 对应能力 |
|---|---|---|---|
| **看得见** | 桥只上报 `activeWorkflow`（当前标签） | 同页其它打开的工作流**完全看不见** | 采集 `openWorkflows` |
| **列得出** | `canvas.pages` 按 sid 一页一条，名=前台标签 | 同页多标签只显示一条、看不到全部 | pages 展开 |
| **寻得着** | py 定向按 `workflow` 名 = 前台标签名匹配 | 命不中非前台标签；同页同名多开歧义 | 定向支持标签级寻址 |
| **动得了** | 写 op 只能作用于前台标签 | 非前台标签**写不进去** | 轻量切前台 |
| **切得动** | 无轻量切标签原语（只有重装载 `openWorkflow`，带 dirty 保护） | 想让非前台标签上前台，要么用户手点，要么强切重载 | 轻量 `activateWorkflow` |

**一句话**：**agent 对"工作流多标签"这个维度是结构性失明的**——不是配置问题，是桥从未采集、路由从未寻址。

---

## 二、已改（未部署）的部分

| 层 | 改动 | 状态 |
|---|---|---|
| 桥 js | `openWorkflowsInfo()` @ L222；state 推 `openWorkflows` @ L765；diag 探针 @ L1342 | ✅ 已改，PARSE OK，**未部署** |
| py | `_note_frontend` 记 `openWorkflows` @ L228；`_open_workflows_brief` @ L347；`_pages_payload` 每页挂 @ L306；`_pages_brief` 加 `openCount` | ✅ 已改，AST OK，**未部署** |
| app | `canvas pages` 展开「└ 打开 N 个：▸当前 · …」@ L3305-3328 | ✅ 已改，ESM OK，**未部署** |

→ 这部分解决「**看得见 / 列得出**」。**还差「寻得着 / 动得了 / 切得动」**。

---

## 三、待补（本次循环要做）

### 缺口 3 · 寻得着 —— 定向支持"标签级"寻址
**现状**：`py` 用 `_frontends[sid].workflow == want_wf` 匹配。这个字段只有前台标签名。
**改法**：定向时**同时扫 `openWorkflows` 数组里的每一项**——若目标名命中某页**任一打开标签**，该页即为目标（但**只有当它就是前台标签时才可直接操作**；否则需先切）。
**产出**：`canvas.pages` / 定向错误文案能区分「没开这页」vs「开着但没在前台」。

### 缺口 4 · 切得动 —— 新增轻量 `canvas.activateWorkflow`
**已查实**（读前端源码）：
- 前端点 Tab 走 `store.openWorkflow(wf)` → **改 `activeWorkflow` 引用 + `loadGraphData` 重绘**（数据来自目标标签自己的 `activeState`，**切标签不丢数据**）。
- 桥现有 `canvas.openWorkflow` 把这条路包成"轻激活+完整装载+dirty 保护"，所以重、且会拦。
**改法**：新增 op `canvas.activateWorkflow { path }`——内部直接 `svc.openWorkflow(wf)`；对**已打开**的工作流就是"切前台"。带 `?autoRevert` 选项（John 已选：**不自动切回**）。
**副驾驶**：切前台属"打开看布"，对齐 `openWorkflow` 加入 `COPILOT_WRITE_EXEMPT`（无副驾驶也能切去看）。

### 缺口 4·补 · activateWorkflow 的路由（方案定：py 按 op 名特殊匹配，无需 app 透传 sid）
**问题（鸡生蛋）**：`activateWorkflow` 的作用正是「把非前台标签拉到前台」，但它自己也走 `want_wf` 定向——py 会把它判成 `target_not_foreground` 拒绝，永远切不过去。
**已核实的死路**：app 侧 `bridgeArgs` 白名单**无 `sid`**，走 sid 定向要改透传链，绕。
**采纳解法**：py 的 `/call` 已知 `op`——当 `op == "canvas.activateWorkflow"` 时，把「仅后台命中」（`hits_bg`）也归入可定向目标（取其一 sid）。语义自洽：切标签的目标本就是后台标签。**只改 py 一处，app 无需透传 sid。**
**自动切换？** 定为**不自动**：写/读 op 撞 `target_not_foreground` 时，app 报**明确指引**（告知可调 `canvas.activateWorkflow workflow=<名>` 切前台）——切不切由 agent 自主（视线移动要显式），不对读 op 静默动视线。

### 缺口 5 · 动得了 —— 写非前台画布的流程
**已定口径**（John 2026-10-13）：**写非前台工作流必须该工作流自己开着副驾驶**；流程 = 切到目标标签 → 写门按该标签自己的 copilot 判定 → 操作 → （John 选：不自动切回）。
**改法**：app 层在写 op 前，若目标不在前台 → 先 `activateWorkflow` 切过去；写门（桥的 `copilotWriteBlocked`）读的是 `copilotPageKey()`=**当前 activeWorkflow 的 path**，切过去后**自动**用目标标签自己的 copilot 状态判——**无需新增权限机制**（已有设计天然满足）。

---

## 四、交付批次（一次改完，单次部署 + 单次重启）

| 批 | 内容 | 层 | 依赖 |
|---|---|---|---|
| **A** | 已改的三处（采集/py 账本/app 展示）—— 审计确认在位 | 桥/py/app | — |
| **B** | 桥：新增 `canvas.activateWorkflow` op + 进 `WRITE_OPS`/`COPILOT_WRITE_EXEMPT` | 桥 js | — |
| **C** | py：定向支持扫 `openWorkflows`（标签级寻址） | py | A |
| **D** | py：`canvas.activateWorkflow` op 特殊匹配（`hits_bg` 也算可定向）；app：登记 op 到 `CANVAS_OPS` + 工具描述 + `target_not_foreground` 友好文案 | py+app | B/C |
| **E** | 部署（桥 js + py → custom_nodes；app → 宿主同步）+ **重启 ComfyUI**（py 改动必须）+ 宿主 reload | 部署 | 全部 |
| **F** | 独立验证：只读夹具（不碰用户画布）验证 pages 展开/定向命中/切换原语 | 验证 | E |

**纪律**：A+B+C+D 一次改完再部署（禁分批）；部署前告知 John 重启收益；E 与 F 分单。

---

## 六、执行进度（2026-10-13 05:xx 更新）

| 批 | 状态 | 证据 |
|---|---|---|
| **A** 采集/py 账本/app 展示 | ✅ 已改 | 三处 grep 在位 |
| **B** 桥 `canvas.activateWorkflow` | ✅ 已改，PARSE OK | OPS L1595 / WRITE_OPS L5442 / COPILOT_WRITE_EXEMPT L5470 |
| **C** py 标签级寻址 | ✅ 已改，AST OK | `_norm_wf_name`/`_match_open_workflows` L370-402；三分支 L486-550 |
| **D-py** activateWorkflow 特殊定向 | ✅ 已改，AST OK | `allow_bg` L492 / 分支 L505-510 |
| **D-app** 登记 + 文案 + candidates 透传 | ✅ 已改，ESM OK | CANVAS_OPS L2059 / 文案 L3107 / candidates L2159 |
| **核查** 五环一致性（独立单） | ✅ 完成 | 抽出 2 个问题（见下） |
| **修1** 桥 `activateWorkflow` 认 `workflow` 参数 | 🔄 在跑 | subagent-1791839606584-xginvg |
| **修2** 壳页腿 `pages` 遮蔽探修 | 🔄 在跑 | subagent-1791839606676-raiqkq |
| **E** 部署 + 重启 ComfyUI | ⏳ 待 John 定时机 | — |
| **F** 独立真机验证 | ⏳ 待 E 完成 | — |

### 核查抽出的两个真问题（已派修）
1. **桥 `activateWorkflow` 只认 `path`/`name`，不认 `workflow`**（L1597）——而 py 定向/app 文案都用顶层 `workflow` 调用 → 按指引调用时桥侧 `target=""` 抛错，**“切得动”整环不可用**。（修1）
2. **壳页腿 `canvas.pages` 疑为单页简化 payload**（`app/ui/workspace.js` ~L1455），而 `canvasBridgeInvoke` 优先壳页腿 → 壳页存活时多标签“列得出”被遮蔽。需探明“壳页腿到底支不支持 pages”（不支持则回退扩展腿、无遮蔽）。（修2）

**关键设计定案**：activateWorkflow 的路由靠 py 按 op 名特殊匹配（`allow_bg`），**无需 app 透传 sid**（bridgeArgs 白名单无 sid）。写/读 op 撞 `target_not_foreground` 时**不自动切**，只给可行动指引（切不切由 agent 自主，视线移动要显式）。

---

## 五、边界（不越界）
- **写非前台画布**：必须该画布自己开副驾驶（沿用既有 copilot 门，不新增机制）。
- **切前台**：会移动用户视线——John 已选"不自动切回"，即接受"停在目标画布"。仅在有明确目标时切，不静默乱切。
- 读不限。
- 不碰 ComfyUI 源码/打包产物。
