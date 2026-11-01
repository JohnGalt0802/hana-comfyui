# 官方模板库（templates）

> **范围**：`comfyui(action="templates", op="list"|"fetch", ...)` 的用法——检索、拉取落盘、上画布。
> **何时读**：用户要"找个官方模板 / 用现成工作流"、想从零快速搭一条流程时。
> **前置条件**：检索与拉取走中继访问 GitHub（Comfy-Org/workflow_templates），需要外网；服务不必在线（落盘写的是本机目录）。

## 检索（op="list"，默认）

- 过滤参数：`q`（关键词，匹配名称/中文标题/描述/模型族，中英文都能搜）、`task`（任务类型，如 Text to Image）、`model`（模型族）、`mediaType`（image/video/audio/3d）、`tag`、`recommend`（如 highly_recommended）；`limit`（默认 20，上限 200）/ `offset` 分页。
- 返回按中文标题优先排序，●=推荐、○=版本不满足。记下要拉的模板的 `name` 列。
- **mediaType 数据现状**：上游模板索引里视频类模板的 `mediaType` 目前被标成 `image`，按 `mediaType=video` 过滤会命中 0 条——找视频模板用 `q` 关键词搜（如 "video"），别依赖 mediaType。

## 拉取（op="fetch"）

- `name` 必填（来自 list 的 name 列）；`target` 默认 `hub`，`tmp` 落系统临时目录（不想留档时用）。
- 返回落盘路径、大小、所需/缺失模型清单和可跑性判断。**不自动下载模型、不自动打开模板、不因缺模型拒绝落盘**。
- **落盘位置**：`<ComfyUI>/user/default/hui-templates/<分类>/<name>.json`。刻意避开 `workflows/`，所以**不会出现在 ComfyUI 的工作流列表里**，`{"template":...}` 也取不到它。

## 拉下来之后怎么上画布

模板 JSON 落在 `hui-templates/`，要用**绝对路径**走画布装载：`comfyui(action="canvas", op="openWorkflow", ...)` 传 fetch 返回的落盘路径（装载前注意画布纪律：副驾驶开关决定原地装载还是复制副本，见 `copilot.md`）。提交则直接把同一绝对路径作为 `workflow` 传给 `submit`（UI 格式自动转换）。

## 缺模型怎么处理

fetch 返回的缺失模型清单会带下载线索：优先告诉用户缺什么、多大、放哪个目录，让用户决定是否下载（模型动辄几个 GB，不替用户拍板）；模型齐了之前不必急着上画布。装好模型后可先跑 `validate` 确认 checkpoint 名能对上再提交。
