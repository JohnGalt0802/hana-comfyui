---
name: comfyui-hana
description: Hana-ComfyUI（v2 App）——把本机 ComfyUI（127.0.0.1:8188）接进 Hana：整页工作区嵌官方前端（iframe 直连 8188，自定义节点扩展可用）；comfyui 工具支持提交工作流/跟踪进度/取回产物/取消/上传/服务起停（service）；画布读写——读/改人正在看的同一张画布（投影 get / 体检 / 追踪 / 大纲 / patch 事务 / 自动排布）；画布执行与副驾驶（queue 画布执行 / duplicate 复制 / visual 锁与高亮 / 共编开关）；工作区顶栏与左侧面板均可一键启动/停止 ComfyUI 服务（计划任务拉起，独立于 Hana 存活）；可自定义 ComfyUI 安装目录；环境自举——未安装时引导 agent 完成安装。触发场景：用 ComfyUI 生成图片、提交工作流、查看生成进度、取回产物、取消生成任务、查询队列、上传参考图、启动/停止 ComfyUI 服务、帮我启动 ComfyUI、帮我关掉 ComfyUI、ComfyUI 工作区打不开、中继未就绪/启动失败、ComfyUI 后端不可达（8188）、自定义 ComfyUI 目录/ComfyUI 装在别处、自定义节点不显示/扩展脚本 403、帮我安装 ComfyUI、未检测到 ComfyUI 环境、画布执行、在画布上跑工作流、复制画布、副驾驶、共编画布、小花副驾驶。
---

# Hana-ComfyUI（v0.11）

把本机 ComfyUI（服务在 `127.0.0.1:8188`）接进 Hana 的 v2 App。本文件是**入口**（保持短）；细节按下方主题索引**按需加载** `references/` 子文档。环境不存在时工作区会弹安装引导（选位置 → 让助手装 / 复制指令 / 自行安装）。

## 这是什么

- **整页工作区**：内嵌官方前端，iframe **直连 `127.0.0.1:8188`**（自定义节点扩展可用）；主题跟随宿主。
- **`comfyui` 工具**（单工具 action 分派）：经「中继」操作 8188；每次提交在宿主建一条正式任务（`next-step` 回执）并挂任务卡。
- **服务独立存活**：8188 由 Windows 计划任务拉起，独立于 Hana；顶栏 / 左侧面板 / 工具均可起停。
- 卡片：「ComfyUI 工作区」整页卡（含状态面板）、「ComfyUI 任务卡」、拉起前的「服务检查卡」。

## 快速上手（最短路径）

**起服务**（别先去开终端）——自动先做环境检查；返回 `blocked` 时按随消息的「环境检查卡」处理：

```
comfyui(action="service", op="start")
comfyui(action="service", op="wait")    # 轮询就绪（单次 ≤25s，总时限 120–150s）
```

**生图**（提交即返回——**回合纪律：不要原地等待**；产物回执与任务卡见 `references/submit.md`）：

```
comfyui(action="submit", workflow={"template":"我保存的工作流.json"}, inputs={"3.seed": 123})
```

**改画布**（写入类先在设置页开「允许 agent 修改画布」；全表见 `references/canvas.md`）：

```
comfyui(action="canvas", op="state")      # 先摸现状（服务端缓存快照，零往返）
comfyui(action="canvas", op="commands")   # 排布前先摸命令表（node-organizer 自检）
comfyui(action="canvas", op="organize")   # 再排（不要主动重排——尊重用户手调的布局）
```

未装 / 未启动 ComfyUI → `references/service.md`（三步侦察与 `INSTALL.md` 分工）。

## 主题索引（何时读哪份）

| 何时读 | 子文档 |
|---|---|
| 要看/改人正在看的画布：读 ops 全表、投影 get、check/trace/outline、patch 事务、排布、画布执行 / 复制 / 视觉标记 | `references/canvas.md` |
| 生图与提交：submit 三形态、inputs 注入、任务桥与回执、任务卡状态、mode 分流（auto/canvas/backend） | `references/submit.md` |
| 服务管理：起停、环境检查卡、就绪等待、未安装分流、本体更新 | `references/service.md` |
| 副驾驶（共编）与行为准则：大动作/小动作尺度、锁/高亮、开关细则 | `references/copilot.md` |
| 排障：中继/桥/页面状态/常见坑/路由与日志位置 | `references/troubleshooting.md` |
| 未安装 ComfyUI：完整安装流程（Windows 主线） | `INSTALL.md` |

## 工具面速览

`comfyui(action="...", ...)` 单工具分派：

| action | 一句话 | 细节 |
|---|---|---|
| `status` | 服务/中继/队列/运行中任务聚合 | `references/service.md` |
| `submit` / `query` / `result` / `cancel` | 提交工作流；查任务；取产物；定向取消（`all:true` 才全清） | `references/submit.md` |
| `workflows` / `upload` | 列/读已保存工作流；上传参考图（图生图） | `references/submit.md` |
| `service` / `update` | 8188 服务进程起停与环境检查；本体更新（仅源码安装） | `references/service.md` |
| `canvas` | 读/改人正在看的同一张画布（写入需授权） | `references/canvas.md` |
