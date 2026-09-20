---
name: comfyui-hana
description: ComfyUI-Hana（v2 App）——把本机 ComfyUI（127.0.0.1:8188）接进 Hana：整页工作区嵌官方前端；comfyui 工具支持提交工作流/跟踪进度/取回产物/取消/上传。触发场景：用 ComfyUI 生成图片、提交工作流、查看生成进度、取回产物、取消生成任务、查询队列、上传参考图、ComfyUI 工作区打不开、中继未就绪/启动失败、ComfyUI 后端不可达（8188）。
---

# ComfyUI-Hana（v0.2）

把本机 ComfyUI（`D:\ComfyUI`，服务在 `127.0.0.1:8188`）接进 Hana 的 v2 App。

## 架构一句话

受管 runtime 拉起「中继」（`runtime/comfy-relay.mjs`）→ 宿主代理路径提供 HTTP/WS 通道 → 整页工作区嵌入官方前端；`comfyui` 工具经中继操作 8188；每次提交在宿主建一条正式任务（next-step 回执）并有任务卡。

## 当前能力（v0.2）

| 面 | 内容 |
|----|------|
| 工具 | `comfyui`：**status / submit / query / result / cancel / workflows / upload**（单工具 action 分派） |
| 任务桥 | submit → 宿主任务（`delivery:"next-step"`）→ 2s 轮询结算（完成回执含产物路径；失败/中断给原因） |
| 任务卡 | 每次 submit 返回 `details.card`（进度/队列位/耗时/产物缩略），数据经 `GET /comfyui-hana/task?id=` |
| 路由 | `boot-state` / `status` / `health` / `task` / `relay/start` |
| 中继增强 | 订阅 8188 `/ws` 做进度事件缓存；`/_relay/history` 裁剪历史；日志落盘（`app-data/comfyui-hana/logs/relay.log`，>5MiB 滚动 `.1`） |
| 卡片 | 「ComfyUI 工作区」整页卡（含状态面板）、「ComfyUI 任务卡」 |

## 工具手册

```
comfyui(action="...", ...)
```

| action | 必填 | 语义 | 关键返回 |
|---|---|---|---|
| `status` | — | 服务/中继/队列/运行中任务聚合 | 文本摘要 + `details.comfyui.{phase,backend,queue,events,jobs}` |
| `submit` | `workflow` | 提交工作流三形态（见下）；`inputs` 注入；`clientLabel`；`front` | `details.comfyui.{promptId,taskId,bridge}` + `details.card`（任务卡） |
| `query` | — | `promptId`/`taskId` 查单任务；都不给则列最近 | 状态/进度/错误摘要 |
| `result` | — | `promptId`/`taskId` 取产物：本地路径 + 预览 URL；`stage:true` 尝试入会话文件 | 路径列表 |
| `cancel` | — | `promptId`/`taskId` 定向取消（排队中→删除；执行中→定向中断）；`all:true` 才全清 | 模式说明 |
| `workflows` | — | 无参列 userdata/workflows；`name` 读取节点结构摘要（id/type/title） | 结构清单 |
| `upload` | `path` | 上传本机图片到 input（图生图） | 存储名（供 inputs 引用） |

### submit 的工作流三形态

1. **API 格式 JSON 对象**：`{"3": {"class_type": "KSampler", "inputs": {...}}, ...}` —— 最稳。
2. **文件路径字符串**：本机 `.json`；API 格式直接用；**UI 格式**（含 `nodes` 数组）会尝试自动转换（见下）。
3. **`{"template": "名称"}`**：从 ComfyUI `userdata/workflows` 取（先 `action=workflows` 看有哪些）。

**inputs 注入**：键为 `"<node_id>.<input>"`，如 `{"3.seed": 42, "6.text": "a cat"}`。节点 id 与输入名用 `action=workflows,name=...` 的摘要定位。

**UI→API 自动转换的边界**：支持经典图（普通节点 + 连线 + widget 值）；遇到**子图（Subgraph）/环绕节点/静音或旁路节点/未知节点类型**会明确报错——请改用 ComfyUI「工作流 → 导出（API 格式）」。

### 任务桥与投递

- 提交成功即返回（**回合纪律：不要原地等待**）；完成后（**桌面会话**）宿主按 `next-step` 把产物路径贴回本会话。
- 任务桥依赖能力：`app/tasks.manage` + `app/session.start-turn`。**未授权时自动降级**为仅内存跟踪（工具返回值里会写原因），此时用 `query`/`result` 主动取，不投递。
- 按钮通道（无 callToken）调用同样降级为仅内存跟踪。
- **子代理会话边界（宿主限制，2026-09-21 实测）**：宿主 next-step 可靠投递只写**桌面会话**（`agents/{id}/sessions/*.jsonl`）；从**子代理会话**发起的 submit 得到的宿主任务**不会自动回执**（宿主 `_assertActiveDesktopSessionPath` 静默拒绝、每 30s 重试但永不送达；hana-downloader 已有同类先例）。此时工具返回值会明确标注，请用 `comfyui(action="query")`（含“投递：published（未送达）”探针）与 `action=result` 主动取结果；需要自动回执请从主对话发起提交。

### 典型用法

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

## 任务卡状态（现象 → 怎么办）

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 卡显示"排队中" | 队列里等前面的任务 | 等待；`front:true` 可插队 |
| 卡显示"执行中" + 进度条 | 正在采样 | 等待；节点/步进在卡上实时更新 |
| 卡显示"已完成"+缩略图 | 产物就绪 | 用 `action=result` 取本地路径 |
| 卡显示"失败/已中断/超时" | 见卡上错误行 | `action=query` 看详情；错误信息在 `details` |
| 卡显示"未找到任务 record" | 超出进程记忆（重载后） | 用宿主任务 id 查询，或重新提交 |

## 排错表

| 症状 | 先查 | 说明 |
|---|---|---|
| `中继未就绪` | 等 1-3s；或 `POST /comfyui-hana/relay/start` | 中继自动拉起，失败会自动退避重试 |
| `后端不可达` | ComfyUI 是否在跑（8188） | attach 模式：中继常驻并持续探测，恢复即可用 |
| submit 报 `node_errors` | `action=workflows` 核对节点/输入名 | ComfyUI 的节点校验错误原文在报错里 |
| submit 报"UI→API 转换遇到不支持的构造" | 是否子图/静音节点 | 导出 API 格式再提交 |
| 任务卡缩略图不显示 | 卡的凭据段 | 预览走 `_surface` 凭据路径；老卡或非卡环境可能 403 |
| `result` 说"尚未完成" | 历史未落 | 等几秒重试，或先 `query` 看状态 |
| 提交后没有自动回执 | `query` 的“投递”行 | 桌面会话：`published` = 等下一个输入点送达；子代理会话：永不自动送达，改用 query/result 主动取 |
| `cancel all:true` 慎重 | 会清空整个队列 | 默认只取消指定 prompt |
| 工作区打不开 | `boot-state` 的 note | 见 M0 记录 §8 的宿主段排错 |

## 数据与日志

- 中继日志：**落盘** `app-data/comfyui-hana/logs/relay.log`（>5MiB 滚动到 `relay.log.1`）+ 宿主受管 runtime stdout。
- 私有运行时配置：`app-data/comfyui-hana/integration/relay-*.json`（0600，中继读取后自删；含 controlKey，管理端点 `/_relay/fs/*`、`/_relay/upload` 需该密钥）。
- 产物定位：`D:\ComfyUI\ComfyUI\output\<subfolder>\<filename>`（经 `/_relay/fs/stat` 验证存在）。
- 端口随机（38000-52000）、仅绑定 127.0.0.1。
