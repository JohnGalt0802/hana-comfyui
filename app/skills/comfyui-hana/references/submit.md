# 生图与提交（submit / 任务桥）

> **范围**：`comfyui` 工具的生图面——`submit` 的工作流三形态与 inputs 注入、任务桥与回执、`query` / `result` / `cancel` / `workflows` / `upload` 用法。
> **何时读**：要提交工作流出图 / 跟踪任务进度 / 取产物 / 找模板 / 传参考图（图生图）时。

## 工具详表（本域）

| action | 必填 | 语义 | 关键返回 |
|---|---|---|---|
| `submit` | `workflow` | 提交工作流三形态（见下；文件/template 形态走**中继直读直提**，支持 4MiB+ 大文件）；`inputs` 注入；`clientLabel`；`front`；`mode`（执行位置分流，见下） | `details.comfyui.{promptId,taskId,bridge}` |
| `query` | — | `promptId`/`taskId` 查单任务；都不给则列最近 | 状态/进度/错误摘要 |
| `result` | — | `promptId`/`taskId` 取产物：本地路径 + 预览 URL；`stage:true` 尝试入会话文件 | 路径列表 |
| `cancel` | — | `promptId`/`taskId` 定向取消（排队中→删除；执行中→定向中断）；`all:true` 才全清 | 模式说明 |
| `workflows` | — | 无参列 userdata/workflows；`name` 读取节点结构摘要（id/type/title） | 结构清单 |
| `upload` | `path` | 上传本机图片到 input（图生图） | 存储名（供 inputs 引用） |

**进度**：提交后用 `action=query` 查状态（或等完成回执）。

## submit 的工作流三形态

1. **API 格式 JSON 对象**：`{"3": {"class_type": "KSampler", "inputs": {...}}, ...}` —— 最稳。
2. **文件路径字符串**：本机 `.json`；API 格式直接用；**UI 格式**（含 `nodes` 数组）会尝试自动转换（见下）。
3. **`{"template": "名称"}`**：从 ComfyUI `userdata/workflows` 取（先 `action=workflows` 看有哪些）。

**大文件说明（2026-09-29 M13 起）**：文件路径 / template 两形态由**中继侧直读直提**——读文件 → UI→API 转换 → 注入 → 提交全部在中继完成，**不受宿主通道大小限制**，4MiB+ 的 UI 格式工作流可直接提交（经典图）。仅 inline 对象形态仍走原提交链路（大对象建议落盘后传路径）。旧行为（大文件报 `Managed service response exceeds the 4 MiB limit.`）已修复。

**inputs 注入**：键为 `"<node_id>.<input>"`，如 `{"3.seed": 42, "6.text": "a cat"}`。节点 id 与输入名用 `action=workflows,name=...` 的摘要定位。

**UI→API 自动转换的边界**：支持经典图（普通节点 + 连线 + widget 值）；遇到**子图（Subgraph）/环绕节点/静音或旁路节点/未知节点类型**会明确报错——请改用 ComfyUI「工作流 → 导出（API 格式）」。

## 任务桥与投递

- 链路：submit → 宿主任务（`delivery:"next-step"`）→ 2s 轮询结算（完成回执含产物路径；失败/中断给原因）。
- 提交成功即返回（**回合纪律：不要原地等待**）；完成后（**桌面会话**）宿主按 `next-step` 把产物路径贴回本会话。
- 任务桥依赖能力：`app/tasks.manage` + `app/session.start-turn`。**未授权时自动降级**为仅内存跟踪（工具返回值里会写原因），此时用 `query`/`result` 主动取，不投递。
- 按钮通道（无 callToken）调用同样降级为仅内存跟踪。
- **子代理会话边界（宿主限制，2026-09-21 实测）**：宿主 next-step 可靠投递只写**桌面会话**（`agents/{id}/sessions/*.jsonl`）；从**子代理会话**发起的 submit 得到的宿主任务**不会自动回执**（宿主 `_assertActiveDesktopSessionPath` 静默拒绝、每 30s 重试但永不送达；hana-downloader 已有同类先例）。此时工具返回值会明确标注，请用 `comfyui(action="query")`（含"投递：published（未送达）"探针）与 `action=result` 主动取结果；需要自动回执请从主对话发起提交。

## 任务状态速查

排队中 → 等待（`front:true` 可插队）；执行中 → 等待；完成后用 `action=result` 取本地路径；失败/中断/超时 → `action=query` 看详情；"未找到 record" ＝ 超出进程记忆（重载后），用宿主任务 id 查询或重新提交。

## 典型用法

```
# 1) 看服务与队列
comfyui(action="status")

# 2) 极小测试（纯 CPU，零模型）
comfyui(action="submit", workflow={"1":{"class_type":"EmptyImage","inputs":{"width":64,"height":64,"batch_size":1,"color":0}},
                                  "2":{"class_type":"SaveImage","inputs":{"images":["1",0],"filename_prefix":"comfyui_hana_test"}}},
        clientLabel="测试出图")

# 3) 改参数重跑（找模板）
comfyui(action="workflows", name="我保存的工作流.json")
comfyui(action="submit", workflow={"template":"我保存的工作流.json"}, inputs={"3.seed": 123})

# 4) 跟踪与取产物
comfyui(action="query", promptId="…")
comfyui(action="result", promptId="…")

# 5) 图生图：先传参考图
comfyui(action="upload", path="D:\\pics\\ref.png")
#   → {"1.image": "ref.png"} 注入到 LoadImage 节点
```

## mode 参数（执行位置分流 · 已交付）

`submit` 可用 `mode: "auto" | "canvas" | "backend"`（默认 `auto`）：

- **auto 判定**：画布在线（shell alive + 扩展桥可达）**且两个授权闸都开**（「允许 agent 修改画布」＋「允许 Agent 开启画布副驾驶」）→ 画布流程。不满足时**停下**（正常返回 + `details.comfyui.blocked: true` 含失败码 / 原因 / 选项摘要；**不静默改走后台**）：
  - 授权缺（任一开关）→ 停下 + 选项：① 去设置页开对应开关后说「继续」；② 显式 `mode=backend` 重新提交（附风险说明）；③ 先不跑。
  - 环境缺（服务 / 中继 / 工作区页面）→ 停下 + 指引：请启动 ComfyUI 服务 / 打开工作区（自举在后续批次升级）。
  - 装载 / 执行失败（`canvas-unloadable` / `canvas-failed`）与其余未知错误 → 停下 + 原因。
- **结构性豁免**：`workflow` 为 inline 对象（非 `{template}` 单键形态）或带非空 `inputs` → 形态判定前置（先于探测）、**直接走 backend**；回执注明「未上画布：inline/inputs 形态直走后台提交」。
- **例外 · 画布忙**：画布有执行中任务 → **报错退出**（不抢占、不静默改走后端；确需后端请显式 `mode=backend`）。
- **v2「复制工作台」五步**（2026-10-08）：`duplicate`（复制副本；原布零改动）→ `save`（副本落盘：`<原名去尾> (AgentCopy) YYYYMMDD-HHmm`，重名递增 ` (2)`）→ `canvas.copilot {enabled:true}`（开副本副驾驶）→ `loadWorkflowFile`（装载到副本）→ settle（落点断言：活动页＝副本页）→ `canvas.queue`（快返）。
  「copilot 开＝共编同页」自动分支已去除（共编同页降为「用户明确要求」的人工例外，不走本流程）；副驾驶总闸关时无法在副本上开副驾驶 → 画布路径不可走。
- `mode=canvas`：强制画布流程（前置不满足直接报错）；`mode=backend`：显式后台直提（**唯一**会记待同步的路径；回执带风险说明——后端丢值先例）。

### 待同步（pending-canvas.json）与惰性回填

- **记账**：仅**显式 `mode=backend`** 的产出记 `pending-canvas.json`（app 数据目录）：`{createdAt, workflowRef, promptId, note}`；auto 停下与结构豁免直提不记。
- **惰性回填**：app 在 canvas 类 op / 状态 / shell 查询时惰性检测——画布恢复（shell alive + 桥可达）且两个授权闸都开（写授权＋副驾驶总闸）→ 复制副本 → 副本落盘（AgentCopy）→ 开副本副驾驶 → 装载该工作流 → 清标记；任一步不满足 / 失败 → 保留记录并附原因，下次触发再试。
