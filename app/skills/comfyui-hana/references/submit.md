# 生图与提交（submit / 任务桥 / 任务卡）

> **范围**：`comfyui` 工具的生图面——`submit` 的工作流三形态与 inputs 注入、任务桥与回执、任务卡状态、`query` / `result` / `cancel` / `workflows` / `upload` 用法。
> **何时读**：要提交工作流出图 / 跟踪任务进度 / 取产物 / 找模板 / 传参考图（图生图）时。

## 工具详表（本域）

| action | 必填 | 语义 | 关键返回 |
|---|---|---|---|
| `submit` | `workflow` | 提交工作流三形态（见下；文件/template 形态走**中继直读直提**，支持 4MiB+ 大文件）；`inputs` 注入；`clientLabel`；`front`；`mode`（执行位置分流，见下） | `details.comfyui.{promptId,taskId,bridge}` + `details.card`（任务卡） |
| `query` | — | `promptId`/`taskId` 查单任务；都不给则列最近 | 状态/进度/错误摘要 |
| `result` | — | `promptId`/`taskId` 取产物：本地路径 + 预览 URL；`stage:true` 尝试入会话文件 | 路径列表 |
| `cancel` | — | `promptId`/`taskId` 定向取消（排队中→删除；执行中→定向中断）；`all:true` 才全清 | 模式说明 |
| `workflows` | — | 无参列 userdata/workflows；`name` 读取节点结构摘要（id/type/title） | 结构清单 |
| `upload` | `path` | 上传本机图片到 input（图生图） | 存储名（供 inputs 引用） |

**任务卡**：每次 submit 返回 `details.card`（进度/队列位/耗时/产物缩略），数据经 `GET /comfyui-hana/task?id=`。

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

## 任务卡状态（现象 → 怎么办）

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 卡显示"排队中" | 队列里等前面的任务 | 等待；`front:true` 可插队 |
| 卡显示"执行中" + 进度条 | 正在采样 | 等待；节点/步进在卡上实时更新 |
| 卡显示"已完成"+缩略图 | 产物就绪 | 用 `action=result` 取本地路径 |
| 卡显示"失败/已中断/超时" | 见卡上错误行 | `action=query` 看详情；错误信息在 `details` |
| 卡显示"未找到任务 record" | 超出进程记忆（重载后） | 用宿主任务 id 查询，或重新提交 |

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

- **auto 判定**：画布在线（shell alive + 扩展桥可达）**且已授权** → 画布流程；不满足（离线 / 未授权 / inputs 注入 / inline 对象形态等）→ backend 路径 + 待同步记账（结果注明 `degradeNote`）。
- **例外 · 画布忙**：画布有执行中任务 → **报错退出**（不抢占、不降级、不静默改走后端；确需后端请显式 `mode=backend`）。
- **copilot 分流**：开 = **共编同页**（跳过复制）/ 关（默认）= **复制副本**（`canvas.duplicate`；红线：不覆写用户当前画布）→ 装载 → `canvas.queue`（快返）。
- `mode=canvas`：强制画布流程（**不降级**，前置不满足直接报错）；`mode=backend`：直接走后端（同样记待同步——"未上画布"统一口径）。

### 待同步（pending-canvas.json）与惰性回填

- **记账**：backend 产出（未上画布）→ 记 `pending-canvas.json`（app 数据目录）：`{createdAt, workflowRef, promptId, note}`。
- **惰性回填**：app 在 canvas 类 op / 状态 / shell 查询时惰性检测——画布恢复（shell alive + 桥可达）且已授权 → 复制副本并装载该工作流 → 清标记；任一步不满足 / 失败 → 保留记录并附原因，下次触发再试。
