# ComfyUI 前端与后端 API 调研：可嵌入性与 Agent 化调度

> **报告编号**：E-comfyui-frontend-api
> **调研日期**：2026-09-21（Asia/Shanghai），所有"当前状态"以此为基准日
> **调研方式**：官方仓库源码直读（web_fetch raw）+ 官方文档 + 本机运行实例实测 + anysearch 社区检索
> **本机实测对象**：ComfyUI `0.37.0`（`deploy_environment: local-git`，RTX 4070 SUPER，启动参数 `main.py --listen 127.0.0.1 --port 8188`），`required_frontend_version=1.53.6`，实测时间 2026-09-21 02:05–02:11 (+08:00)
> **判定标记**：`【资料确认】`= 官方文档/源码/权威一手来源；`【实测】`= 本机实例直接验证；`【推断】`= 基于已核实事实的推理；`[不确定]`= 存疑未证
> **范围**：只陈述技术事实与风险，产品决策由主脑做。

---

## 0. 关键事实速览（便于快速抓取）

1. **前端是 Vue 3 + TS + Vite 工程，全量构建产物约 25MB**，通过 PyPI 包 `comfyui-frontend-package`（默认）、GitHub Release `dist.zip`（可 pin 版本）、或本地目录（`--front-end-root`）三种方式部署；**资源全部相对路径，官方明确支持反向代理子路径部署**。【资料确认】
2. **官方前端当前版本线为 1.x（v1.55.11，2026-09-20）；legacy 前端是 2024-08-15 切换时留的快照**（独立归档仓库，仅回退用）。【资料确认】
3. **响应头层面不阻止 iframe**：默认无 `X-Frame-Options`、无 CSP。【实测】
4. **但默认安全中间件会 403 掉一切 `Sec-Fetch-Site: cross-site` 请求**（含跨站 iframe 的文档加载与 API 调用）——**跨站嵌入默认不可用**，需 `--enable-cors-header` 或同站部署。【实测 + 源码 + 官方 open issue】
5. **后端 API 完整覆盖 Agent 调度**：`/prompt`、`/queue`、`/history`、`/interrupt`、`/free`、`/view`、`/upload/image` + WebSocket `/ws?clientId=`（进度/执行/错误事件齐全），且所有路由自动带 `/api` 前缀孪生。【源码 + 实测】
6. **默认无任何 HTTP 鉴权**（单用户、loopback 假设）；`--multi-user` 模式的用户标识是客户端自报 header，token 鉴权仍是 open 状态的 RFC。【资料确认】
7. **官方已有两套 Agent 侧通道**：本地 `comfy-mcp`（40 工具，基于 comfy-cli）+ 云端 Comfy Cloud MCP；社区还有多个第三方 MCP server。【资料确认】
8. **前后端版本在 `requirements.txt` 里强 pin**（如前端 `1.53.6` 对后端 `0.37.0`），运行时有 `/system_stats` 与特性协商机制。【资料确认 + 实测】

---

## 1. ComfyUI 前端现状（@comfyorg/comfyui-frontend）

### 1.1 仓库与身份

- 仓库：`Comfy-Org/ComfyUI_frontend`（"Official front-end implementation of ComfyUI"）。
  来源：https://github.com/Comfy-Org/ComfyUI_frontend
- 包名 `@comfyorg/comfyui-frontend`，**`"private": true`，未发布到 npm**（npm registry 对该包名 404）。
  【资料确认】https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/package.json ；【实测】https://registry.npmjs.org/@comfyorg/comfyui-frontend → 404
- 许可证：**GPL-3.0-only**（package.json 字段）。用于二次分发/闭源集成时需评估（技术事实陈述）。
- 版本节奏（README "Release Schedule"）：每个 minor 版本走「2 周开发期 + 2 周特性冻结/稳定期」+ 补丁发布；release 以 `vX.Y.Z` tag 发布。
  https://github.com/Comfy-Org/ComfyUI_frontend （README）

### 1.2 技术栈

来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/package.json （main 分支，版本 `1.55.11`，抓取于 2026-09-21）

- 语言/框架：**TypeScript + Vue 3 + Vite**（构建脚本 `vite build --config vite.config.mts`），Pinia、vue-router、vue-i18n。
- UI 层：PrimeVue（Aura 主题）+ Reka UI + Tailwind CSS 4（`@tailwindcss/vite`）+ primeicons。
- 画布/图形：自维护 fork 的 litegraph（`@comfyorg/litegraph` 指向 `Comfy-Org/litegraph.js`），three.js（3D 查看）、TypeGPU。
- 协同/数据：yjs（协作底层）、zod（schema 校验）、axios、firebase（cloud 身份）、posthog/sentry（云/遥测，非本地默认激活）。
- 测试/工具链：Playwright、Storybook、Vitest。

### 1.3 构建产物与部署方式

**构建变体**（vite.config.mts / package.json scripts）：
- 默认 web 构建：`vite build`；云构建 `DISTRIBUTION=cloud`；桌面构建 `DISTRIBUTION=desktop`。
- `base` 配置：`base: DISTRIBUTION === 'cloud' ? '/' : ''` —— **非 cloud 构建使用相对路径 base**。
  来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/vite.config.mts
- 【实测】本机服务的 index.html 引用 `src="./assets/index-CKO20XHW.js"`（相对路径），与上述配置一致。

**发布产物**（GitHub Releases）：
- 每个 release 附 `dist.zip`（web）与 `dist-desktop.zip`（桌面），各约 25MB。
- 当前最新 release：**v1.55.11（2026-09-20）**。
  来源：https://api.github.com/repos/Comfy-Org/ComfyUI_frontend/releases/latest
- `dist.zip` 是 `--front-end-version` 下载机制约定的资产名（见 §5 与 frontend_management.py `download_release_asset_zip`："Download dist.zip from github release"）。

**部署（服务）方式**（三种，互斥优先级从高到低）：

| 方式 | 参数 | 说明 |
|---|---|---|
| 本地目录 | `--front-end-root PATH` | 指定任意本地前端目录（自定义构建/嵌入改造后的目录），**Overrides `--front-end-version`** |
| GitHub Release | `--front-end-version owner/repo@version` | 从 GitHub release 下载 `dist.zip` 到 `web_custom_versions/<owner>_<repo>/<version>/`；version 可为 `latest` 或 semver |
| 默认（pip 包） | 无参数 | 从 `comfyui_frontend_package/static`（pip 包内）服务 |

来源：
- https://docs.comfy.org/development/comfyui-server/startup-flags （Frontend & API 段落）
- https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/comfy/cli_args.py （`--front-end-root` 定义、`DEFAULT_VERSION_STRING = "comfyanonymous/ComfyUI@latest"`）
- https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/app/frontend_management.py （`CUSTOM_FRONTENDS_ROOT = <ComfyUI>/web_custom_versions`；`default_frontend_path()` → `comfyui_frontend_package/static`；下载失败回退默认前端并告警）

**服务实现**（server.py）：
- `self.web_root = FrontendManager.init_frontend(args.front_end_version) if args.front_end_root is None else args.front_end_root`；启动日志 `[Prompt Server] web root: ...`。
- `@routes.get("/")` 返回 `web_root/index.html`（带 `Cache-Control: no-store`）；末尾 `web.static('/', self.web_root)` 挂载静态资源。
- 另有 `/extensions/<name>`（自定义节点 WEB_DIRECTORY）、`/templates`、`/docs` 等静态挂载。
  来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/server.py

**npm/PyPI 双轨**：
- npm：未发布（见 §1.1）。
- PyPI：`comfyui-frontend-package`（owner Comfy-Org，Python >=3.9），wheel 约 25MB。
  - 【资料确认】PyPI 页面显示最新 **1.53.6（2026-09-17 发布）**：https://pypi.org/project/comfyui-frontend-package/
  - 与 GitHub release 的 1.55.11 对比：**pip 包版本落后于仓库 main 的 release 若干版本**。【推断：pip 包按 ComfyUI 发版节奏同步，滞后数日～数周；未找到官方同步策略文档 [不确定]】
- 同族包（同由 requirements 管理）：`comfyui-workflow-templates`、`comfyui-embedded-docs`。
  【实测】本机 pip 侧：frontend 1.53.6 ✓ 与 required 一致；templates 0.11.48 < required 0.11.66（运行中对不上会告警）。

**本机 ComfyUI 对前端的 pin**（当前 master）：
```
comfyui-frontend-package==1.53.6
comfyui-workflow-templates==0.11.66
comfyui-embedded-docs==0.5.12
```
来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/requirements.txt

### 1.4 1.x 与 legacy 版本线

- **2024-08-15 切换**：官方公告《ComfyUI Frontend Modernization》（ComfyUI issue #4169，2024-08-02 创建、08-15 关闭执行）宣布用新前端（TS+Vue+Vite）替换主仓内置 legacy JS 前端；并保留快照到独立仓库。
  - 公告原文要点："Effective August 15, 2024, we will be replacing the legacy frontend..."；新前端技术栈 "TypeScript, Vue, and Vite"；包含一个 **Vite 构建期自定义 shim** 以兼容既有前端扩展生态。
    来源：https://github.com/Comfy-Org/ComfyUI/issues/4169
- **legacy 回退**：`ComfyUI_legacy_frontend` 仓库（"ComfyUI legacy JS frontend"，**2024-10-07 被所有者归档**），使用方法：
  `--front-end-version Comfy-Org/ComfyUI_legacy_frontend@latest`
  来源：https://github.com/Comfy-Org/ComfyUI_legacy_frontend （README）；归档日期见仓库页标注（2024-10-07，经检索快照确认）。
- 主仓 `master` 已无内置 `web/` 目录（请求 `.../master/web/index.html` 返回 404）。【实测（raw 404）】
- 结论：**legacy 只是回退通道，维护线只有 1.x**；1.x 内部仍在持续 Vue 化迁移（双渲染架构、子图迁移等，见讨论 #6040，检索日期 2026-03）。【资料确认（讨论页）】

---

## 2. 嵌入可行性（iframe / 独立部署 / 改造点）

### 2.1 浏览器头部层面：不阻止 iframe

- 【实测】本机 `GET /`、`GET /system_stats` 响应头**均无 `X-Frame-Options`、无 `Content-Security-Policy`**；index.html 中亦无 CSP meta。
  实测输出（2026-09-21）：`Cache-Control/Pragma/ETag/... /Server: Python/3.12 aiohttp/3.14.3`，没有 frame 相关头。
- 源码佐证：server.py 里唯一的 CSP 出现在 `create_block_external_middleware()`（仅 `--disable-api-nodes` 时启用），内容为 `default-src 'self'; ...; frame-src 'self'; ...`，**没有 `frame-ancestors` 指令**，即它也不阻止被嵌入。
  来源：https://github.com/Comfy-Org/ComfyUI/blob/master/server.py （`create_block_external_middleware`）

### 2.2 真正的拦截点：origin-only 中间件对 `cross-site` 一律 403

server.py 默认中间件链（无 `--enable-cors-header` 时）为 `[cache_control, deprecation_warning, create_origin_only_middleware()]`：

```python
# create_origin_only_middleware
if 'Sec-Fetch-Site' in request.headers:
    if request.headers['Sec-Fetch-Site'] == 'cross-site':
        return web.Response(status=403)
# 另外：loopback Host 与 Origin 域不匹配时也会 403
```
来源：https://github.com/Comfy-Org/ComfyUI/blob/master/server.py

- **【实测】纯请求级验证**（本机 0.37.0）：
  - `GET /` + `Sec-Fetch-Site: cross-site` → **403**
  - `GET /api/queue` + `Sec-Fetch-Site: cross-site` → **403**
  - `GET /` + `Sec-Fetch-Site: same-origin` → 200
  - `GET /api/queue` + `Origin: http://127.0.0.1:8188`（与 Host 匹配）→ 200
  - `GET /api/queue` + `Origin: http://localhost:8188`（与 Host=127.0.0.1 不匹配）→ 403
  - OPTIONS 预检（带不匹配 Origin）→ 403
- **官方 open issue 佐证**：ComfyUI #16203（2026-09-09，open）标题即 "origin_only_middleware returns 403 for any Sec-Fetch-Site: cross-site request"，确认**跨站导航（top-level navigation）也会被拦**，并列出社区 workaround：`--enable-cors-header`、代理层剥离 `Sec-Fetch-Site` header、或手动刷新。
  来源：https://github.com/Comfy-Org/ComfyUI/issues/16203
- 相关社区报告：ComfyUI #13450（更新后 HTTP 403，2026-04-17）、ComfyUI-Manager #2453（2026-01-01，指出"ComfyUI 对 PATCH/POST/PUT 等有 403 行为"）。
  来源：https://github.com/Comfy-Org/ComfyUI/issues/13450 ；https://github.com/Comfy-Org/ComfyUI-Manager/issues/2453

**对 iframe 嵌入的直接含义**【推断，依据上列实测+issue】：
- 父页面在**其他站点**（任何非同一 site 的 origin，含 https 站点嵌 `http://127.0.0.1:8188`）→ iframe 文档请求带 `cross-site` → **被 403，嵌入失败**（除非下述对策）。
- 父页面与 ComfyUI **同站**（如宿主 app 也跑在 `http://127.0.0.1:<port>`，scheme 相同、同一 IP/域）→ `same-site` 不被拦（代码只拦 `cross-site`）→ 可嵌入。【推断：代码逻辑明确；未做真浏览器 iframe 实测】
- 若宿主为 **Electron 壳**：主窗口直接顶层加载 ComfyUI URL（同 Comfy Desktop 式）→ 导航为 `none`，不受影响；若在 `file://` 或自定义协议文档里嵌 iframe → 大概率判为 cross-site，需要 `--enable-cors-header` 或剥离 header。【推断】
- 开启 `--enable-cors-header` 的代价（官方代码注释）：它会**替换掉** origin-only 中间件，从而放宽"防止任意网站 POST 127.0.0.1"的防护，同时提供 CORS 响应头（`Access-Control-Allow-Origin` 等，含 `Access-Control-Allow-Credentials: true`）。【资料确认（代码）】

### 2.3 路径 / base path / WS / API 前缀配置

**前端运行时寻址规则**（src/scripts/api.ts 与 src/router.ts，main 分支）：

```ts
// api.ts 构造函数
this.api_host = location.host
this.api_base = isCloud ? '' : location.pathname.split('/').slice(0, -1).join('/')
// apiURL: api_base + '/api' + route；fileURL: api_base + route
// createSocket: `${ws|wss}://${api_host}${api_base}/ws?clientId=...`
```
```ts
// router.ts getBasePath()
// - Electron: always root
// - Cloud: use Vite's BASE_URL (build time)
// - Standard web (including reverse proxy subpaths): use window.location.pathname
//   注释示例: http://mysite.com/ComfyUI/
// isFileProtocol → createWebHashHistory()
```
来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/src/scripts/api.ts ；https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/src/router.ts

**由此可确认的设计意图**：
- **官方支持"反代子路径部署"**（router base = pathname；资源相对路径；API = 同源 `${子路径}/api/*`）。
- **前端不能指向"另一个 origin 的后端"**：API/WS 地址永远从"当前被服务的路径"推导。若要三方宿主直接托管 dist 文件而不反代 `/api`、`/ws`、`/view`、`/internal`，前端将请求宿主自身的这些路径 → 需要宿主侧代理转发到 ComfyUI。【资料确认（源码）+ 推断】

**后端对前缀的配合**（server.py `add_routes()`）：
- 所有动态路由**自动注册 `/api` 前缀孪生**：
  > "Prefix every route with /api for easier matching for delegation. This is very useful for frontend dev server, which need to forward everything except serving of static files. Currently both the old endpoints without prefix and new endpoints with prefix are supported."
- /ws 同样有 `/api/ws`（因为它是 RouteDef）；静态挂载（`web.static('/')`）**不**做前缀复制；但有 `/api/` 返回 index.html 的巧合（根路由 "/" 的孪生是 "/api/"）。
  【实测】`/api/queue`、`/api/features`、`/api/system_stats` → 200；`/api/` → 200（index.html）；`/api/nonexistent-xyz` → 404。
- 子路径部署的已知坑（社区）：
  - kaanlabs 2026-03-13 文章：nginx 子目录反代 ComfyUI 需特殊配置，且 **workflow 保存/`user_manager.py` 查询串处理需打补丁**才正常；否则出现 405 / 刷新问题。
    来源：https://kaanlabs.com/how-to-route-comfyui-in-a-subdirectory-behind-a-nginx-reverse-proxy/
  - ComfyUI #9664 "Save flow 405"（2025-09-01，open）：子路径下 `/comfyui/api/userdata/workflows/*.json` 访问异常（中文文件名/查询串），与上文的补丁点一致。
    来源：https://github.com/Comfy-Org/ComfyUI/issues/9664

**WS 地址**：无需配置项——固定 `ws(s)://<当前 host><base>/ws?clientId=<uuid>`。clientId 首次由服务器在 `status` 消息中下发（`data.sid`），前端存 `window.name`/`sessionStorage` 复用；重连时重发同一 clientId，服务端会把当前 executing 节点补发给该客户端。
来源：api.ts（createSocket / status 处理）；server.py `websocket_handler`（`sid = query.get('clientId', '')`；连接即发 `status: {status, sid}`；`self.client_id == sid` 时补发 `executing`）。

### 2.4 浏览器侧新变量：Local Network Access（PNA 后继）

- Chrome 团队现方案 **Local Network Access**（WICG explainer）：**公有站点访问用户本地网络（含 localhost/私网 IP）从"直接可用"改为"需要用户权限提示"**；该方案"builds on top of Chrome's previously paused Private Network Access (PNA) work"，并明确"permission also exempts requests that are known to be `local` or `loopback` from mixed content blocking"。
  来源：https://github.com/WICG/local-network-access/blob/main/explainer.md
- 落地状态（检索快照）：Chrome 官方博客《New permission prompt for Local Network Access》（2025-06-09）介绍可通过 `chrome://flags#local-network-access-check` 预览；Chrome Platform Status 条目："Chrome 142 restricted the ability to make requests to the user's local network, gated behind a permission prompt"；blink-dev 有"Intent to Extend Experiment"讨论。
  来源：https://developer.chrome.com/blog/local-network-access ；https://cr-status.appspot.com/feature/5152728072060928 ；https://groups.google.com/a/chromium.org/g/blink-dev/c/lRnFRIfzDMU
  （注：上述页面本次直取部分超时/失败，信息来自检索结果摘要，**具体生效版本与豁免范围 [不确定]，需按目标浏览器版本复核**。）
- **含义**：浏览器（非桌面壳）场景下，"公网页面（含 iframe）访问本机 ComfyUI"可能触发权限提示甚至被默认拦；**桌面/Electron 壳不受浏览器 LNA 限制**（由壳内网络栈决定）。【推断】

### 2.5 社区"嵌入/包裹 ComfyUI"先例与坑

| 先例 | 形态 | 要点 | 来源 |
|---|---|---|---|
| ComfyUI Desktop / Comfy-Desktop | Electron 壳（非 iframe） | 官方桌面 app："electron app is a simple wrapper around the existing ComfyUI web application"（早期社区说明）；新仓库 Comfy-Org/Comfy-Desktop | https://github.com/Comfy-Org/Comfy-Desktop ；https://www.reddit.com/r/comfyui/comments/1ggm0qx/ |
| 前端内置宿主桥 | 例：`window.__comfyDesktop2?.Telemetry`、桌面登录兑换逻辑 | 前端为桌面宿主预留了窗口级桥接；iframe 嵌入没有官方等价物 | src/main.ts（main 分支） |
| React 应用 iframe 嵌 ComfyUI | 第三方应用 iframe | 2023-12 社区帖：'embed the comfyui web app in the react app by using an iframe. That part is very easy' —— **旧版时代经验；当时尚无 origin-only 中间件，照搬到新版可能撞 403** | https://www.reddit.com/r/StableDiffusion/comments/18k6oob/ |
| 自研前端 + API（大量） | 替代 UI 生态 | SwarmUI、Comflowy、Minimalistic Comfy Wrapper WebUI（也可独立 serve）、ComfyUI Mobile Frontend（自定义节点内挂 React app）、niknah/presentation-ComfyUI（workflow→nuxt/vue 站点）、ViewComfy（把自家 app 用 iframe 嵌到客户网站） | https://github.com/light-and-ray/awesome-alternative-uis-for-comfyui ；https://github.com/niknah/presentation-ComfyUI ；https://www.comflowy.com/change-log ；https://www.viewcomfy.com/blog/build-and-deploy-a-comfyui-powered-app-a-complete-guide |
| 子目录反代 | nginx + 子路径 | 见 §2.3；需要配置 + 已知补丁点 | 同 §2.3 |

**iframe 嵌入的其它实操限制（通用浏览器行为，[推断]，非 ComfyUI 特有）**：第三方存储分区（localStorage/sessionStorage 按顶层站隔离）→ 设置不共享；下载（导出 workflow）/剪贴板/全屏/通知在 iframe 中需要宿主页授予相应 permission policy；跨站 iframe 的 WebSocket 可用但同样受上方中间件影响；`window.name` 可用。文档无阻止。以上为设计时需预留的验证项。

---

## 3. 后端 API 契约（server.py + 官方文档 + 实测）

### 3.1 路由总表（核心）

官方路由文档（部分字段标注新变化，采自本机源码核对）：
来源：https://docs.comfy.org/development/comfyui-server/comms_routes ；https://github.com/Comfy-Org/ComfyUI/blob/master/server.py

| 路径 | 方法 | 用途与关键参数（源码级核对） |
|---|---|---|
| `/prompt` | GET | 队列状态（`{"exec_info":{"queue_remaining":n}}`） |
| `/prompt` | POST | 提交工作流；Body：`{"prompt": {API格式图}, "client_id"?, "number"?, "front"?, "extra_data"?, "prompt_id"?（客户端自选 UUID，需规范格式）, "partial_execution_targets"?}`；返回 `{"prompt_id","number","node_errors"}`；非法时 400 `{"error","node_errors"}` |
| `/queue` | GET | `{"queue_running":[...],"queue_pending":[...]}` |
| `/queue` | POST | `{"clear":true}` 或 `{"delete":[prompt_id,...]}` |
| `/history` | GET | `?max_items=&offset=`；返回 `{prompt_id: {...}}` 映射 |
| `/history/{prompt_id}` | GET | 单任务历史 |
| `/history` | POST | `{"clear":true}` / `{"delete":[...]}` |
| `/interrupt` | POST | 中断当前执行；可带 `{"prompt_id": "..."}` 定向中断（不匹配则跳过） |
| `/free` | POST | `{"unload_models":bool,"free_memory":bool}` |
| `/view` | GET | `?filename=&type=(output/input/temp)&subfolder=`；**支持 `blake3:` 资产哈希**（新版 assets 体系） |
| `/view_metadata/{folder}` | GET | 模型元数据 |
| `/upload/image` | POST | multipart：`image` 文件 + `type/subfolder/overwrite` |
| `/upload/mask` | POST | 上传 mask（与 original_ref 关联） |
| `/object_info`（/`{node_class}`） | GET | 全部/单节点定义（Agent 校验参数用） |
| `/system_stats` | GET | 系统信息，**含 `comfyui_version`、`required_frontend_version`、各 comfy 包 installed/required 对照** |
| `/features` | GET | 服务器特性旗标：实测 `{"supports_preview_metadata":true,"supports_model_type_tags":true,"max_upload_size":104857600,"extension":{"manager":{"supports_v4":true}},"node_replacements":true,"assets":false}` |
| `/models` `/models/{folder}` `/embeddings` `/extensions` | GET | 模型/嵌入/扩展清单 |
| `/workflow_templates` | GET | 模板映射 |
| `/userdata` `/v2/userdata` `/userdata/{file}`… | GET/POST/DELETE | 用户数据文件（设置、workflow json 等；**多用户模式下的隔离点**） |
| `/users` | GET/POST | 用户信息；POST 建用户（多用户模式）；【实测】单用户返回 `{"storage":"server","migrated":true}` |
| `/api/jobs`、`/api/jobs/{id}`、`/api/jobs/{id}/cancel`、`/api/jobs/cancel` | GET/POST | **新版 Jobs API**（分页/过滤/排序、单条/批量取消、幂等语义）——Agent 轮询的现代化替代 |
| `/internal/*` | 子应用 | 仅内部使用，"may change at any time"（源码 README 明示） |
| `/ws` | WS | 实时通道，见下 |

- 所有动态路由都有 `/api/*` 前缀孪生（§2.3）；`OPTIONS` 在 cors 模式下返回空 200。
- 参考文档（Server Routes / Messages / Examples / Startup Flags）：
  - https://docs.comfy.org/development/comfyui-server/comms_overview
  - https://docs.comfy.org/development/comfyui-server/comms_routes
  - https://docs.comfy.org/development/comfyui-server/comms_messages
  - https://docs.comfy.org/development/comfyui-server/api-examples
  - https://docs.comfy.org/development/comfyui-server/startup-flags

### 3.2 WebSocket `/ws?clientId=<id>`

服务端行为（server.py `websocket_handler`）：
- `clientId` 可选；缺省则服务器 `uuid4` 生成并作为 `sid` 下发。
- 连接建立即发 `status`：`{"type":"status","data":{"status":{"exec_info":{"queue_remaining":n}},"sid":"..."}}`。
- 若该 clientId 正是当前执行者且已有执行中的节点，重连时补发 `executing`。
- 客户端惯例第一步发 `{"type":"feature_flags","data":{...}}`，服务器回发服务器特性旗标（特性协商）。
- 断开清理：`self.sockets.pop(sid)`。

事件类型（官方文档 + 前端类型定义；前端对二进制帧另处理预览）：
- JSON 文本事件：`status`、`execution_start`、`execution_cached`、`executing`、`executed`、`progress`、`progress_state`（新，`{prompt_id, nodes:{id:{value,max,state,...}}}`）、`progress_text`、`execution_error`、`execution_interrupted`、`execution_success`、`notification`、`logs`、`feature_flags`、`asset_download`/`asset_export` 等。
- 二进制帧（前端解码）：type=1 预览图（jpeg/png）、type=3 进度文本、type=4 带元数据的预览图。
- 字段细节（executed.output.images 等）见：
  https://raw.githubusercontent.com/Comfy-Org/ComfyUI_frontend/main/src/platform/remote/comfyui/execution/types.ts
- 官方文档消息表：https://docs.comfy.org/development/comfyui-server/comms_messages （executing 的 `node:null` 表示结束等语义）
- 前端断线兜底：WS 失败时每 1s 轮询 `GET /api/prompt` 兜底状态（api.ts `_pollQueue`）。

### 3.3 鉴权现状

- **默认（单用户）无鉴权**：所有 API 可被本机/网络内任意客户端调用；安全假设 = loopback + origin-only 中间件（防浏览器跨站调用）。无 token、无密码。【资料确认（源码/文档）+ 实测（无 401/407 机制）】
- **`--multi-user` 模式**：`app/user_manager.py` 提供多用户档案；但用户身份来自客户端自报的 `comfy-user` HTTP header，**不做签名校验**；`GET /users` 可匿名枚举用户 ID。
  - open RFC：#15822《Implement Token Authentication for --multi-user mode...》（2026-08-23）：现状描述+提议 `Authorization: Bearer <token>`；**尚未实现**。
    来源：https://github.com/Comfy-Org/ComfyUI/issues/15822
- **典型加固 = 外部反代**（Cloudflare Access / oauth2-proxy / Authelia 等）——注意与 §2.2 中间件的冲突（#16203 即此场景）。
- 第三方插件式鉴权：`ComfyUI-Login`、`ComfyUI-Basic-Auth` 等（社区）。
  来源：https://github.com/liusida/ComfyUI-Login ；https://comfy.icu/extension/fofr__comfyui-basic-auth
- **CORS 现状**：默认关闭（无 `Access-Control-Allow-Origin`）；`--enable-cors-header [ORIGIN]` 打开（ACAO + `Allow-Methods: POST, GET, DELETE, PUT, OPTIONS, PATCH` + `Allow-Headers: Content-Type, Authorization` + `Allow-Credentials: true`；OPTIONS 一律空 200）。
  【实测】无 CORS 头；不匹配 Origin 的请求 403（origin-only 中间件所致）。
- 云端（另一体系，非本地）：Comfy Cloud / Developer Platform 使用 API key（`comfyui-` 前缀）+ OAuth；Partner/API 节点需 Comfy 账号。前端有 `authToken`/`apiKey` 字段但"现在只用于 queuePrompt"（api.ts 注释）。
  来源：https://docs.comfy.org/agent-tools/mcp ；https://docs.comfy.org/interface/user

### 3.4 API 格式工作流 vs 节点图（UI）JSON

官方对照（https://docs.comfy.org/development/api-development/workflow-api-format）：

| 维度 | Save 格式（UI） | API 格式 |
|---|---|---|
| 导出入口 | `File → Save` / Ctrl+S | `File → Export Workflow (API)` |
| 结构 | `nodes[]`/`links[]` 图文档 | `{ "<nodeId>": { "class_type": "...", "inputs": {...}, "_meta": {"title"}} }` |
| 布局/颜色/分组 | 有 | **无**（更小、更适合程序处理） |
| 前端可再加载 | 是 | 可以（无布局） |
| 用途 | 前端编辑 | **API 提交（/prompt 的 prompt 字段）** |

- 转换：无官方 CLI 转换器；惯用路径是前端加载后 `Export (API)`；comfy-mcp 声明**同时接受两种导出**（README：'run a workflow JSON (API-format or a UI export)'）。
  来源：https://github.com/Comfy-Org/comfy-mcp
- 实例样例（KSampler 工作流 API JSON）见官方文档页。
- 执行→取产物链路（官方推荐 Method 2 "WebSocket + History"）：
  1) `POST /prompt`（body `{"prompt": {API格式}}`）
  2) 连接 `ws://host/ws?clientId=...` 等 `executing`/`executed`/`execution_success`
  3) `GET /history/{prompt_id}` 取 `outputs`（如 `{"images":[{"filename","subfolder","type"}]}`）
  4) `GET /view?filename=...&subfolder=...&type=output` 下载图像
  - Method 3（`SaveImageWebsocket` 节点）可在 WS 内直接收 PNG 字节流（免落盘）。官方 Python 示例：`script_examples/basic_api_example.py` 等。
  来源：https://docs.comfy.org/development/comfyui-server/api-examples
- 进阶：官方另有 "Execution Model Inversion"（反转执行模型）文档与 `/api/jobs` 体系，供更复杂的程序化控制。
  来源：https://docs.comfy.org/development/comfyui-server/comms_overview （章节列表）

---

## 4. Agent 化实践（现有通道与集成案例）

### 4.1 官方通道

- **comfy-mcp（本地，一行官方）**：`Comfy-Org/comfy-mcp`，基于 `comfy-cli` 的 stdio MCP server；状态 beta，**40 个工具**；核心链路 `server_info → run_workflow → fetch_outputs`（PNG 落盘）；支持 `COMFYUI_URL` 指向远程受控 ComfyUI；许可证 AGPL-3.0-or-later OR Commercial。
  来源：https://github.com/Comfy-Org/comfy-mcp ；https://docs.comfy.org/agent-tools/mcp
- **Comfy Cloud MCP（托管）**：`https://cloud.comfy.org/mcp`（remote HTTP，OAuth 或 API key `X-API-Key`/Bearer）；工具例：`search_templates`、`submit_workflow`、`get_output`。
  来源：https://docs.comfy.org/agent-tools/mcp
- **comfy-cli**：安装/启动/更新 ComfyUI、装自定义节点；`comfy run`/`comfy jobs`/`comfy validate`（跑工作流）、`comfy templates`/`comfy workflow`（模板与 slot 编辑）、`comfy nodes`/`comfy models`（盘点）、`--json` 信封供 agent 消费；另附 `comfy skills install`（comfy, comfy-fragments, comfy-debug, comfy-relay, comfy-director）。
  来源：https://docs.comfy.org/agent-tools/cli ；https://github.com/Comfy-Org/comfy-cli
- **官方 API 示例族**（HTTP-only / WS+History / SaveImageWebsocket）：见 §3.4。

### 4.2 社区集成案例

| 项目 | 形态 | 要点 |
|---|---|---|
| `joenorton/comfyui-mcp-server` | 独立 Python MCP server（streamable-http，默认 `127.0.0.1:9000/mcp`） | `generate_image` 等首发工具 + 目录内 workflow JSON 自动注册为工具（`PARAM_PROMPT`/`PARAM_INT_STEPS` 占位符）；`publish_asset` 发布产物；配置分层 |
| `samuraibuddha/mcp-comfyui`（Enhanced） | MCP server | lobehub 收录，Claude↔ComfyUI 桥 |
| `comfyui-mcp`(local-first control plane) | MCP + 侧栏 agent | 见 skillsllm 收录（2026-06） |
| ComfyUI_Skills_OpenClaw | 自定义节点/技能 | "把 ComfyUI 里构建并以 API 格式导出的工作流变成 Agent 可用技能"（awesome 列表条目） |
| niknah/presentation-ComfyUI | 自定义节点 | 把 workflow 转成 nuxt/vue 普通网站 UI |
| ViewComfy 等平台 | SaaS | 自研前端 + API，并支持把生成的 app 由 iframe 嵌入客户站点 |

来源：https://github.com/joenorton/comfyui-mcp-server ；https://lobehub.com/mcp/samuraibuddha-mcp-comfyui ；https://skillsllm.com/skill/comfyui-mcp ；https://github.com/light-and-ray/awesome-alternative-uis-for-comfyui ；https://github.com/niknah/presentation-ComfyUI ；https://www.viewcomfy.com/blog/build-and-deploy-a-comfyui-powered-app-a-complete-guide

### 4.3 与本项目相关的其它事实

- **App Mode**（前端 1.41.13+ 正式支持）：把工作流配置成"仅暴露必要输入/输出"的简化界面，供分享/使用；Share 链接目前仅支持 Comfy Cloud。
  来源：https://docs.comfy.org/interface/app-mode
- 前端仓库存在面向 agent 的测试与"run permissions popover"等 PR 痕迹（release notes），说明上游在推进 agent 相关 UI 能力。【资料确认（release notes 条目）】
- MCP 对接为成熟路线：HanaAgent 侧既可直接消费 `comfy-mcp`（作为现成子代理工具面），也可绕开 MCP 直接走 REST+WS（§3）。【推断（对接可行性）】

---

## 5. 版本兼容（前端 ↔ 后端）

1. **强 pin 机制**：ComfyUI 的 `requirements.txt` 精确 pin `comfyui-frontend-package==X.Y.Z`（当前 master：`1.53.6`）；运行时有 `app/frontend_management.py::check_comfy_packages_versions()` 对"installed < required"逐包告警。
   来源：https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/requirements.txt ；https://github.com/Comfy-Org/ComfyUI/blob/master/app/frontend_management.py
2. **运行时对照**：`GET /system_stats` 返回 `required_frontend_version` 与各 comfy 包 `installed/required` 对照表。
   【实测】本机返回：`comfyui_version 0.37.0`；`required_frontend_version 1.53.6`；frontend installed=1.53.6/required=1.53.6；templates installed=0.11.48/required=0.11.66（不一致会告警）。
3. **覆盖与回退**：`--front-end-version owner/repo@ver`（可 pin、可指向 fork 的自发布 release）；`--front-end-root`（本地目录，最高优先级）；下载/初始化失败会自动**回退默认 pip 前端**并告警；legacy 快照可作最终回退（§1.4）。
4. **特性协商（松耦合点）**：服务器 `/features` + WS `feature_flags`；前端以 `serverSupportsFeature()`（支持 dot path 与 session/dev 覆盖）决定是否启用依赖新后端的逻辑（例：`supports_progress_text_metadata` 影响 progress_text 二进制帧解析）。后端较旧时前端降级而非崩溃。
   来源：https://docs.comfy.org/development/comfyui-server/comms_routes （/features）；src/scripts/api.ts（serverSupportsFeature）
5. **嵌入场景注意事项**（汇总）：
   - 前端对"新后端"的期望以 requirements pin 为准；**自行升级/替换前端（含嵌入改造版）时要同步核对 required 版本**，尤其是 assets 体系（本机 `assets:false`）、userdata、subgraph 等新路由。
   - pip 包与 GitHub release 版本号**不同步**（1.53.6 vs 1.55.11，见 §1.3）；依赖 `--front-end-version` 拉 release 时注意 `dist.zip` 资产名是硬契约。
   - 前端"云"构建（DISTRIBUTION=cloud）**base=/ 且走云身份/Firebase 逻辑**，不适合本地嵌入；嵌入应使用默认/桌面构建（相对路径）。
   - 官方承认的兼容包袱：新前端通过 Vite shim 兼容 legacy 扩展生态（#4169）；自定义节点对前端 DOM/全局（`app.`、`api.`）的依赖是嵌入改造时的主要兼容风险面。【资料确认（#4169）+ 推断】
   - 许可证：前端 GPL-3.0-only；后端主仓 GPL-3.0；comfy-mcp AGPL-3.0-or-Commercial —— 分发/闭源集成需评估。【资料确认（各仓库文件）】

---

## 6. 嵌入方案 A / B 技术对比

> 两项均只列技术事实与风险；工作量为量级评估 [推断]，以"能跑通并可持续维护"为口径。

### 6.1 方案 A：整嵌官方前端（iframe / 独立部署）

**两种子形态**：
- **A1 同源直服**：宿主直接以 ComfyUI 自身为 source（iframe 指向 `http://127.0.0.1:8188`；或壳内顶层加载）。零改造。
- **A2 自托管 dist + 反代**：宿主托管 `dist.zip` 构建产物，自建反向代理把 `<子路径>/api`、`/ws`、`/view`、`/templates`、`/extensions`、`/internal` 等转发到 ComfyUI（配合 §2.3 的前缀机制）。

| 维度 | 评估 |
|---|---|
| **可行性**【资料确认+实测】 | 头部无禁止（无 XFO/CSP）；官方支持子路径与自定义前端部署（`--front-end-root`/`--front-end-version`）；**关键限制 = 默认中间件拦 `cross-site`**：跨站 iframe 必须 `--enable-cors-header` 或同站（同 scheme 的同 IP/域）部署；浏览器侧另有 Chrome LNA 权限、第三方存储分区等环境约束 |
| **工作量**【推断】 | A1：低（部署+启动参数+iframe 集成，1 个原型级工作量）；A2：中（反代路由矩阵 + 子路径坑规避/补丁 + 版本 pin 与升级流程） |
| **风险**【资料确认+推断】 | ① 上游中间件/寻址逻辑变更（#16203 仍在 open，修复方向未定）；② 跨站限制与 `--enable-cors-header` 的防护降级取舍；③ 子路径已知坑（userdata/查询串：#9664、kaanlabs）；④ GPL-3.0 分发合规；⑤ iframe 内下载/剪贴板/通知等能力需宿主授权；⑥ 需要跟进"前端 pin 版本"升级节奏（2 周/次）

### 6.2 方案 B：自研轻前端（API 桥接）

**两种深度**：
- **B1 纯 Agent 桥**（无图编辑 UI）：HanaAgent 直接以 REST+WS 驱动后端（相当于自建 comfy-cli/comfy-mcp 等价层）。
- **B2 用户轻 UI**：另做面向人的简化界面（表单/画廊），可选参考 comfy-mcp 的"workflow 即工具"、App Mode 的输入输出收敛思路。

| 维度 | 评估 |
|---|---|
| **可行性**【资料确认】 | 后端契约完备且文档化：提交（/prompt）、排队（/queue）、历史（/history）、取消（/interrupt、/api/jobs cancel）、释放（/free）、产物（/history→/view、`SaveImageWebsocket`）、事件（/ws 全事件）；官方已有 comfy-cli/comfy-mcp 证明该路线生产可用 |
| **工作量**【推断】 | B1：中低（REST+WS 客户端 + 产物落盘 + 错误处理；两周级起步）；B2：中高（另需工作流管理、参数表单、进度 UI；节点图编辑体验重做成本极高，通常做减法） |
| **风险**【资料确认+推断】 | ① 无鉴权默认（loopback 假设）——宿主侧需自控网络边界；CORS 默认关闭（本机壳内直连不受限，浏览器形态需 `--enable-cors-header` 或代理）；② 自定义节点生态的 UI 能力（widgets、扩展面板）无法完全复刻；③ API/事件存在演进（/api/jobs、progress_state 等为新近添加），需跟随升级；④ 与官方前端功能面（App Mode、模板、i18n、协作）脱节；⑤ 若嵌入方需要人为编辑节点图，B 路线基本要放弃图编辑或退回 A |

### 6.3 对比总表

| 对比项 | A：整嵌官方前端 | B：自研轻前端（API 桥） |
|---|---|---|
| 技术可行性 | 高（有条件：同站或开 CORS；头部层面无阻止） | 高（API 完备，官方/社区均有成熟先例） |
| 主要前置条件 | 部署方式选择（A1/A2）+ 启动参数（`--enable-cors-header` 或同站）+ 版本 pin | 自建 REST+WS 客户端与产物管理；网络边界自控 |
| 工作量量级 [推断] | 低～中 | 中～高（取决于是否做人类 UI） |
| 核心风险 | 跨站 403 策略、子路径坑、上游漂移、GPL 合规、iframe 能力受限 | 无鉴权/CORS 默认值、图编辑缺失、生态 UI 复刻缺口、API 演进跟随 |
| 已有先例 | Comfy Desktop（壳）、社区 iframe 旧例、子目录反代（有补丁点） | comfy-cli、comfy-mcp、大量替代 UI、ViewComfy 等 SaaS |
| 与 Agent-native 的关系 | UI 归 UI；Agent 仍需并行走 API/MCP（前端无官方 agent 控制接口） | Agent 与 UI 同栈，控制器即产品本体 |

---

## 附录 A：本机实测记录（2026-09-21 02:05–02:11 +08:00）

- 实例：`127.0.0.1:8188`，`Server: Python/3.12 aiohttp/3.14.3`，ComfyUI `0.37.0`，`deploy_environment=local-git`，argv `main.py --listen 127.0.0.1 --port 8188`；GPU RTX 4070 SUPER 12GB。
- 头部：`/`、`/system_stats` 无 XFO/CSP；index.html 无 CSP meta；`./assets/index-CKO20XHW.js`（相对路径）。
- 路由：`/api/queue`、`/api/features`、`/api/system_stats`、`/api/` → 200；`/api/nonexistent`、`/some-nonexistent-route` → 404。
- fetch-metadata：`Sec-Fetch-Site: cross-site` → `/` 与 `/api/queue` 均 403；`same-origin` → 200；Origin 与 Host 不匹配（localhost vs 127.0.0.1）→ 403；OPTIONS 预检（不匹配 Origin）→ 403。
- `/queue` → `{"queue_running":[],"queue_pending":[]}`；`/history` → 25KB 历史（含 prompt 图与 outputs）；`/users` → `{"storage":"server","migrated":true}`；`/features` → `{... "assets":false}`。
- 未执行任何写操作与工作流提交（保持只读）。

## 附录 B：主要来源清单（按主题）

**前端仓库与产物**：`Comfy-Org/ComfyUI_frontend`（README / package.json / vite.config.mts / index.html / src/scripts/api.ts / src/router.ts / src/main.ts / src/platform/remote/comfyui/execution/types.ts，main 分支 @ v1.55.11）；Releases API（dist.zip / dist-desktop.zip）；PyPI `comfyui-frontend-package`（1.53.6，2026-09-17）；`Comfy-Org/ComfyUI_legacy_frontend`；issue #4169（2024-08-15 切换公告）。
**后端**：`Comfy-Org/ComfyUI` master 的 `server.py` / `main.py` / `comfy/cli_args.py` / `app/frontend_management.py` / `requirements.txt`。
**官方文档**：comms_overview、comms_routes、comms_messages、api-examples、workflow-api-format、startup-flags、app-mode、agent-tools/mcp、agent-tools/cli、interface/user（docs.comfy.org）。
**Issue/RFC**：#16203（cross-site 403，open，2026-09-09）、#15822（multi-user token auth RFC，open，2026-08-23）、#9664（Save flow 405，open）、#13450（403 报告）、ComfyUI-Manager #2453。
**社区**：kaanlabs（nginx 子目录，2026-03-13）；WICG local-network-access explainer；developer.chrome.com LNA 博客（2025-06-09）；blink-dev intent；cr-status 条目；awesome-alternative-uis-for-comfyui；joenorton/comfyui-mcp-server；comfy-mcp；Comflowy；niknah/presentation-ComfyUI；ViewComfy 博客；Reddit 相关贴（React iframe 旧例、App Mode 讨论）。

> 注：本报告所有联网检索均通过 anysearch 完成（搜索）；已知 URL 均以 web_fetch 直取（部分站点如 GitHub Issue HTML、Reddit、groups.google.com 存在超时，改用 GitHub API JSON 或检索摘要，已在正文标注）。
