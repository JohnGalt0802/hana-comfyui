# 汇总：agent-native 缺口审视（读侧+写侧，2026-10-13）

**来源**：循环任务「重新审视 agent native 的操作工具缺口」。两路只读审视（读侧/写侧各一单）。
**前提**：多标签工作流维度已补齐（见 `docs/规划-agent-native缺口-多标签维度-20261013.md`），**不计入本表**。

---

## 一、合并去重后的候选缺口（按真实痛点排序）

| # | 缺口（合并后） | 来源 | 现状 | 量 | 成色 |
|---|---|---|---|---|---|
| **1** | **中断自愈与断点恢复**：写 op 撞掉线直接报错无等待/重试；跨 patch 序列无事务 ID / checkpoint（逆操作栈是前端内存、重载即清） | 读1 + 写1 | 无 | **中** | 确凿 |
| **2** | **summary 削薄**：节点缺 `color/collapsed/flags/selected/note`；widget 长文本被截 160 字 | 读2 + 读3 | 半 | **小** | 确凿 |
| **3** | **视口与选中**：agent 读不到 `ds.scale/offset`/选中集，也不能聚焦/缩放/框选 | 读4 + 写4 | 无 | 中 | 确凿 |
| **4** | **Note / Markdown 节点**：`addNode` 建不了（note 非 node 类型），"给用户留说明"做不到 | 写3 | 无 | 小 | 确凿 |
| **5** | **分组框 live 编辑**：`group` 仅 `source=file` 通道支持，活画布建不了分组 | 写2 | 半 | 小 | ✅ **已补（2026-10-13）**：桥新增 `canvas.addGroup/setGroup/removeGroup`（活画布分组），已部署（`hana-bridge-10131713`），真机实测加框成功 |
| **6** | **历史版本回滚入口**：`save` 写 `.bak` 但工具面无 versions/rollback 动作 | 写5 | 半 | 中 | 确凿 |
| **7** | **重连原子性**：无 `reconnect`（只改一端点），批量重连跨批不原子 | 写7 | 半 | 小 | 确凿 |
| **8** | **工作流列表元数据**：无 `mtime`/分页/排序 | 读5 | 半 | 小–中 | 确凿 |
| **9** | **产物↔提交关联**：`history-list`/`history-snapshot` 路由已存在但未接成 agent action | 读6 | 半 | 中 | **确凿**（2026-10-13 复核：`app/index.js` 无 history-* 匹配；工具 action 清单里无 history） |
| **10** | **单步写无 visual lock**：仅 `patch/organize/commands` 置锁 | 写9 | 半 | 小 | 确凿（`VISUAL_WRAPPED` `index.js:3052`） |
| **11** | **导出 API 格式到文件** | 写10 | 半 | 小 | 待核 |
| **12** | 子图（subgraph）编辑 | 写6 | 无 | 大 | 确凿（建议标注不支持） |
| **13** | `setWidget` 类型覆盖（隐藏 widget/子图内部） | 写8 | 待核 | 小 | 待核 |

**复核补充**（2026-10-13，主脑只读核实）：
- #2/#3 证：`nodeSummary`（桥 L40）只产 id/type/title/mode/pos/size/inputs/outputs/widgets；`WIDGET_VALUE_MAX=160` + `clip()`（桥 L22-26）→ 长文本被截。**确凿**。
- #9 证：工具 action 清单（`index.js` L4926+）无 history；`app/index.js` 无 `history-list`/`history-snapshot` 引用。**py 路由已存在、未接 agent action —— 确凿**。
- #10 证：`VISUAL_WRAPPED = { patch, organize, commands }`（`index.js:3052`）——单步写（setWidget/addNode/connect…）不置锁。**确凿**。

---

## 二、我的评估（建议优先级）

**高价值、低风险（建议做）**：
- **#2 summary 削薄**（小，纯读侧补字段，风险极低，直接提升 agent 对画布的理解）
- **#4 Note 节点**（小，高频诉求"留说明"）
- **#5 分组框 live**（小，结构化说明）
- **#10 单步写置锁**（小，共驾可见性）

**高价值、中风险（值得做，但需设计）**：
- **#1 中断自愈 + 断点恢复**（中，最痛——昨晚亲历；需设计"等画布回来"的 TTL 短轮询 + patch checkpoint）

**中价值（按需）**：
- #3 视口选中、#6 历史回滚、#7 重连原子、#8 列表元数据

**建议搁置**：#9/#11/#13（待核）、#12（大且非高频）

---

## 三、边界（不擅自扩张）
- 本表是**候选清单**，不是待办。是否补、补哪几个，由 John 定。
- 当前**部署批次已冻结**（多标签五处）——不得在部署前再改代码把它撑大。
- 若 John 要补，另立批次、一次改完、单独部署+重启。
