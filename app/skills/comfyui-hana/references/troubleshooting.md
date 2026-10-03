# 排障（中继 / 桥 / 页面状态 / 常见坑）

> **范围**：常见报错与症状的处置、工作区直连 8188 与主题跟随的实现背景（页面状态）、中继与桥、路由面、数据 / 日志 / 配置文件位置。
> **何时读**：遇到报错、状态异常、页面 / 节点缺块、没有回执、服务起不来等问题时。

## 排错表

| 症状 | 先查 | 说明 |
|---|---|---|
| `中继未就绪` | 等 1-3s；或 `POST /comfyui-hana/relay/start` | 中继自动拉起，失败会自动退避重试 |
| `后端不可达` | 先走 `service.md`「环境不存在时」三步侦察 | attach 模式：中继常驻并持续探测，恢复即可用；未装/未启动时按引导流程处理 |
| submit 报 `node_errors` | `action=workflows` 核对节点/输入名 | ComfyUI 的节点校验错误原文在报错里 |
| submit 报"UI→API 转换遇到不支持的构造" | 是否子图/静音节点 | 导出 API 格式再提交 |
| submit 报 `Managed service response exceeds the 4 MiB limit.` | 宿主副本是否为 v0.10+ | 旧版行为（文件/template 拿到大文件后经宿主通道拉回，超 4MiB 被拒）；M13 起这两种形态走中继直读直提，不再受限；若仍复现，检查宿主副本是否已同步 + reload（见 `docs/大工作流提交修复-20260929.md`） |
| 任务卡缩略图不显示 | 卡的凭据段 | 预览走 `_surface` 凭据路径；老卡或非卡环境可能 403 |
| `result` 说"尚未完成" | 历史未落 | 等几秒重试，或先 `query` 看状态 |
| 提交后没有自动回执 | `query` 的"投递"行 | 桌面会话：`published` = 等下一个输入点送达；子代理会话：永不自动送达，改用 query/result 主动取 |
| 点了「启动服务」没反应 | `comfyui(action="service", op="status")` 的 `lastError` + `logs/backend.log` | 常见：无 venv python / 计划任务创建失败（启动器路径含空格必须带引号，已在代码里处理）/ 端口 8188 被别的进程占 |
| 服务起不来但日志为空 | 计划任务 `HanaComfyUI-Backend` 的 Last Result | 非 0 就是任务层失败（如 0x800704C1=启动器路径解析失败）；任务只作启动器，手动 `schtasks /run /tn HanaComfyUI-Backend` 等价 |
| `cancel all:true` 慎重 | 会清空整个队列 | 默认只取消指定 prompt |
| 工作区打不开 | `boot-state` 的 note | 见 M0 记录 §8 的宿主段排错 |
| 工作区能开但**节点面板/扩展缺块**，控制台报 `/scripts/app.js`、`/extensions/...` 403 | 工作区「连接方式」下拉 | 自定义节点扩展用绝对路径，代理前缀下会打到宿主根被 403；选 `direct`（默认）或 `auto` 直连 8188 即可（v0.7） |
| 探测不到已装的 ComfyUI | 设置页「ComfyUI 安装目录」/ `install-targets` | 手填安装根（含 `main.py` 的那层或其外层），保存即生效 |

## 页面状态：工作区为什么直连 8188（v0.7，2026-09-25 实测定位）

ComfyUI 官方前端的资源引用是**相对路径**，经代理前缀能正常加载；但**自定义节点的扩展脚本**习惯写**绝对路径**
（`/extensions/<node>/*.js`、`/scripts/app.js`、`/scripts/ui.js`），在宿主域下这些请求会绕过 App 前缀、
打到宿主根（不是本 App 路由）→ **403**，表现为"页面能开但节点/面板缺块"。
后端实测这些路径在 8188 上均 200，且无 `X-Frame-Options`，因此工作区 iframe 改为**直连**（manifest 声明 `ui.csp.frameDomains`）。
代价：iframe 跨源 → 壳页摸不到 `contentWindow`。主题改为**改道**：订阅宿主主题钩子 `hana.theme.subscribe`
（回调直给快照：theme/appearance/cssUrl/palettes）→ `POST /comfyui-hana/theme` → 中继把宿主主题写成
ComfyUI 的自定义色板（`Comfy.CustomColorPalettes.hana`，键名与壳页 `HANA_CSS_MAP`/`HANA_JS_MAP` 同源）
并选中（`Comfy.ColorPalette="hana"`）→ **自动重载 ComfyUI 那层 iframe**（`_hana_t` 时间戳强制；同 src 不会重载），
前端起来即带宿主配色。兜底：轮询（2.5s 重拉宿主主题 CSS 比对色值签名）、首帧加载前预推送。
路由 `theme`（GET 查 / POST 写）→ 中继 `/_relay/theme`。
坑：`POST /settings` 成功是 **200 空 body**（不能按 JSON 解析）；色板 comfy_base 键名**不带 `--`**。
工作区「连接方式」下拉保留 `direct` / `auto` / `hana.api.url` / `直接相对路径`，可随时切回代理（代理模式下主题走同源直控，不受此限）。

## 中继与桥

- **中继**：本 App 的受管 runtime（`runtime/comfy-relay.mjs`，随 Hana 生命周期）——给 8188 提供 HTTP/WS 通道 + 工具/任务/卡片面。**未就绪**时等 1-3s，或 `POST /comfyui-hana/relay/start`（自动拉起，失败自动退避重试）。
- **中继增强**：订阅 8188 `/ws` 做进度事件缓存；`/_relay/history` 裁剪历史；日志落盘（见下"数据、日志与配置文件"）。
- **画布桥两条腿**（壳页 / 前端扩展）互补：直连模式下壳页跨源够不到 app；代理模式下扩展脚本可能加载不了——app 先试壳页，失败自动回退扩展；两条腿都不可达时报"工作区壳页未在超时内回传"类错误。
- **桥自检**：`comfyui(action="canvas", op="probe")`（关键 API 存在性）。

## 路由面速查（v0.7-0.9）

`boot-state` / `status` / `health` / `task` / `relay/start` / `backend/start` / `backend/stop` / `backend` / `install-targets` / `install-target` / `auto-start` / `theme` / `update` / `update/status`（均在 `/comfyui-hana/` 下）。

## 数据、日志与配置文件

- 中继日志：**落盘** `app-data/comfyui-hana/logs/relay.log`（>5MiB 滚动到 `relay.log.1`）+ 宿主受管 runtime stdout。
- 服务本体日志：`app-data/comfyui-hana/logs/backend.log`（启动器重定向；由计划任务拉起的 ComfyUI 的 stdout/stderr）。
- 服务起停状态：`app-data/comfyui-hana/logs/backend-state.json`（上次由谁拉起、安装根、启动时间，跨中继重启保留）。
- 私有运行时配置：`app-data/comfyui-hana/integration/relay-*.json`（0600，中继读取后自删；含 controlKey，管理端点 `/_relay/fs/*`、`/_relay/upload` 需该密钥）。
- 产物定位：ComfyUI 安装根的 `output\<subfolder>\<filename>`（安装根由本机环境探测自动识别，不硬编码；经 `/_relay/fs/stat` 验证存在）。
- 端口随机（38000-52000）、仅绑定 127.0.0.1。
- 配置文件（v0.7，均在 `app-data/comfyui-hana/`）：`install-target.json`（自定义安装根）、`auto-start.json`（服务自动拉起开关，默认关）。
