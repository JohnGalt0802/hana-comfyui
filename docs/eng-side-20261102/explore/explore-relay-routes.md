# hui 中继层（runtime/comfy-relay.mjs）路由机制与基础设施探索报告

- 对象：`C:\Users\John Galt\.hanako\apps\comfyui-hana\runtime\comfy-relay.mjs`（单文件，本次只读未改任何文件）
- 检索时间：2026-11-02
- 行号均指该文件当前版本。

## 与调用方锚点的差异（先报告）

调用方给的锚点行号与实际不符（可能基于旧版本）：

| 项 | 调用方锚点 | 实际行号 |
|---|---|---|
| `resolveTemplateContent` | ~3697 | **3716** |
| `handleSubmitFile` | ~3721 | **3735** |
| `fetchBackendJson("/object_info", 12_000)` | ~3750 | **3750** ✓ 一致 |
| `if (pathOnly === "/_relay/userdata")` | ~3862 | **4226** |
| `handleHistoryCommit` | ~4265 | **import 在 75 行；路由 `/_relay/history/commit` 在 4615** |

结构本身与描述一致：单文件、路径字符串 if 链分派。

---

## 一、路由分派机制（含入口行号）

- **主服务入口**：`const server = http.createServer((req, res) => {...})` — **4171 行**。
- 回调第一行取 `pathOnly = String(req.url || "/").split("?", 1)[0]`（4172）。
- 分派是 **if/else 链（顺序匹配，不是查表）**：
  1. 最先：`llmIsBridgeRoute(pathOnly)` 命中 `/_relay/llm/*` → 交 `llmGatewayHandler(req,res,"bridge")`（4176–4187）。
  2. 之后一串 `if (pathOnly === "/_relay/xxx")` 块，每块内部再判 `req.method`，不匹配方法回 405。
  3. **兜底**：所有分支都没命中 → `proxyHttp(req, res)`（**4689 行**），把请求原样反代到后端 ComfyUI。
- WS 升级走独立事件：`server.on("upgrade", ...)`（约 4691），`pathOnly.startsWith("/_relay/")` 直接 404，其余交 `proxyUpgrade`（3417）。
- 另有**第二只 server**（LLM 网关）：`startLlmGateway()` 在 **4152 行**创建，`http.createServer` 在 4155，监听 127.0.0.1:8790（`config.llmGatewayPort` 可覆盖），handler 是 `llmGatewayHandler`（3940），同一批 `/_relay/llm/*` 桥路由同时挂主 server。

新增路由 = 在 if 链里插一个 `pathOnly === "/_relay/..."` 块，块内自行校验方法、（写操作时）controlOk，再 `void (async () => {...})(); return;`。

## 二、现有路由全表（主 server，监听 config.port）

| 路径 | 方法 | 用途 | 鉴权 | 处理逻辑位置 |
|---|---|---|---|---|
| `/_relay/llm/*`（bridge） | GET/POST | App 桥：config 下发、jobs 长轮询、event/done 回填 | loopback 信任 | `llmGatewayHandler` 3940 起；分发点 4031/4047 等 |
| `/_relay/status` | GET/HEAD | 聚合状态（可达性/队列/计数） | 无 | 4182（内联） |
| `/_relay/health` | GET | 探活 `{ok,pid,uptimeSec}` | 无 | 4195 |
| `/_relay/metrics` | GET/HEAD | 主机指标（GPU/CPU/内存） | 无 | 4199 |
| `/_relay/env` | GET | 环境诊断导出 | 无 | 4207 |
| `/_relay/userdata` | GET/HEAD | 代读后端 userdata 文件（`?file=`） | 无 | 4226（内联，node:http 直连） |
| `/_relay/drives` | GET/HEAD | 安装位置候选与磁盘空间 | 无 | 4271 |
| `/_relay/custom-roots` | GET/HEAD；POST | 自定义安装位置读/写 | POST 需 controlOk | 4279 |
| `/_relay/preview-config` | GET/HEAD；POST | 实时预览配置读/写（落盘） | POST 需 controlOk | 4308 |
| `/_relay/launch-config` | GET/HEAD；POST | 启动参数配置读/写（落盘） | POST 需 controlOk | 4332 |
| `/_relay/bridge` | POST | 画布桥 → ComfyUI hana_bridge | controlOk | 4365 |
| `/_relay/backend/start` \| `/stop` | POST | 拉起/停止 ComfyUI | controlOk | 4428 |
| `/_relay/backend/proc` | GET/HEAD | 后端进程信息 | 无 | 4450 |
| `/_relay/backend/envcheck` \| `/wait` \| `/clear` | GET/HEAD/POST（clear 仅 POST） | 环境检查/等待就绪/快照清理 | controlOk | 4459 |
| `/_relay/theme` | GET/HEAD；POST | 主题跟随读/写 | POST 需 controlOk | 4483 |
| `/_relay/update`；`/_relay/update/status` | GET/HEAD；POST（apply 需 controlOk） | ComfyUI 本体更新（带 TTL 缓存）/进度 | POST 需 controlOk | 4521 |
| `/_relay/prompts` | GET/HEAD | prompt 事件缓存（active+recent） | 无 | 4573 |
| `/_relay/prompts/<id>` | GET/HEAD | 单个 prompt 事件记录 | 无 | `pathOnly.startsWith` 分支，约 4583 [起始行未精确记录] |
| `/_relay/history` | GET/HEAD | 历史摘要（`?id=&max=`） | 无 | 4595 → `handleHistory` 3550 |
| `/_relay/queue-detail` | GET/HEAD | /queue 详情（带缓存） | 无 | 4603 |
| `/_relay/history/commit` | POST | 画布提交快照落盘 | 无 controlOk 检查 [见第七节] | 4615 → `handleHistoryCommit`（`./history-commit.mjs`，import 于 75） |
| `/_relay/submit-file` | POST | 本机文件/userdata 模板 → 转换 → 提交 /prompt | controlOk | 4639 → `handleSubmitFile` 3735 |
| `/_relay/fs/read` \| `/fs/stat` \| `/fs/write` \| `/upload` | POST | 本机文件读/stat/写、上传图片到后端 | controlOk | 4653 → `handleFsRead` 3597 / `handleFsStat` 3644 / `handleFsWrite` 3620 / `handleUpload` 3652 |
| （其余一切路径） | 任意 | 反代到后端 ComfyUI | 无 | 兜底 `proxyHttp` 3332，调用点 4689 |

LLM 网关 server（127.0.0.1:8790）上的路由（同一 `llmGatewayHandler`，scope="public"）：`/healthz`（3961，免鉴权）、`/v1/models`（3972，Bearer）、`/v1/chat/completions`（3980，Bearer）。

## 三、可复用基础设施（签名 + 行号）

- `fetchBackendJson(path, timeoutMs = 15_000)` — **3695**。`fetch("http://backend:port"+path)`，读全文尝试 `JSON.parse`。**返回** `{ status, ok, data, text }`，绝不主动抛 HTTP 层错误；JSON 解析失败 `data=null`，调用方按 `ok` 判定。**网络异常/超时会向上抛**（fetch reject），调用方需自包 try/catch（现有用法均在 try 内）。
- `readBackendText(path, timeoutMs = 15_000)` — **3706**。返回 `{ status, ok, text }`，不解析 JSON；网络异常同样上抛。
- `backendJsonOrNull(path, method="GET", body=null)` — **1982**。可达性兜底版：不可达/非 2xx/异常一律返回 `null`，空体/非 JSON 视为 `{}`。固定 10s 超时。支持 POST body。
- `jsonOut(res, status, body, method="GET")` — **3326**。统一 JSON 响应：写 `content-type: application/json; charset=utf-8` + content-length；`method==="HEAD"` 时不写 body。
- `readBodyJson(req, limit = JSON_BODY_MAX_BYTES)` — **3576**。收集请求体并 `JSON.parse`；超限抛错（默认上限 `JSON_BODY_MAX_BYTES = 256KiB`，**102 行**）；空体返回 `{}`；非法 JSON 抛错。惯例：调用处 `try { body = await readBodyJson(req, N) } catch (e) { return jsonOut(res, 400, { ok:false, error }) }`（见 3737）。
- `resolveTemplateContent(name)` — **3716**。列 `/userdata?dir=workflows&recurse=true&full_info=true`（15s），按 `path` 全等 / 文件名 / 大小写不敏感三档匹配；找不到 **throw**（错误消息带可用清单）；找到后再 `readBackendText("/userdata/<file>")` 读内容，返回 `{ content, path }`。**模板检索/读取的现成核心，两个新路由可直接复用。**
- `safeStat(p)` — **3588**。返回 `{ exists, isFile, isDirectory, size, mtimeMs, code }`，不抛异常。**mtime 判断可用它。**
- `controlOk(req)` — **3567**。鉴权函数，见第四节。
- `writeFileAtomic` — 从 `../workflow-file.mjs` import（**74 行**），使用例 3635（fs/write 落盘）。**写文件的现成原子实现。**
- `markBackendDown(errText)` — **457**；`backend.reachable` / `backend.checkedAt` 为全局可达性状态。

**响应约定**：成功 `jsonOut(res, 200, { ok:true, ... })`；业务失败 `jsonOut(res, 4xx/5xx, { ok:false, error: "..." })`（422 转换失败、413 超限、502 上游失败等）；方法不匹配 `jsonOut(res, 405, { error: "method not allowed" }, req.method)`；鉴权失败 `jsonOut(res, 403, { error: "comfy-relay: control key required" })`。

## 四、鉴权与可达性

- **监听**：主 server `server.listen(config.port, "127.0.0.1")`（**4753**）——**只绑 loopback**，外部网络不能直接访问。LLM 网关 `gwServer.listen(gwPort, "127.0.0.1")`（**4164**，默认 8790）同样只绑 loopback。
- **端口来源**：managed 模式由运行时配置 JSON 的 `port` 给定（App 经 `ctx.runtime.start` 拉起，配置文件读后即删，288/298）；standalone 模式默认 `port: 0`（随机端口，303），可用 `--port` 覆盖（319）。后端默认 `127.0.0.1:8188`。
- **鉴权中间件**：没有统一中间件，是**每路由手工调 `controlOk(req)`**（调用点 4285/4315/4341/4373/4433/4465/4502/4545/4644/4658）。`controlOk`（3567）：比较请求头 **`x-comfy-relay-key`** 与 `config.controlKey`（timingSafeEqual）；**未配置 controlKey 时直接放行**（启动时有 warn，4725–4733）。controlKey 需 ≥16 字符（333/352）。
- 现有 GET 类 `/_relay/*` 大多无鉴权；**所有写状态/写盘/停止服务的 POST 都有 controlOk**。新增 POST 路由若落盘，按惯例应加 controlOk。
- 宿主链路：App 经 `ctx.runtime.fetch` 隧道只能到主 server 端口（文件头注释 27、4174）。

## 五、外网请求能力现状

**有出站 HTTP 能力，用 Node 内置全局 `fetch`**（文件头自称"无第三方依赖"，63–75 的 import 里没有 http/https 客户端库之外的网络库）：

- 全局 `fetch` 使用点：470、1774、1985、2788、3556、3670、3696、3707、3796、4408 —— 全部指向 `http://${backend.host}:${backend.port}`（即本机 ComfyUI），并用 `AbortSignal.timeout(ms)` 控超时。
- `http.request` 使用点：3350（proxyHttp 反代）、4244（/_relay/userdata 直连）。
- 代理：`resolveProxyUrl()`（2189）+ `withGitProxy()`（2212）只用于 git 出站；**fetch 没有接代理** [未验证 fetch 是否吃环境变量代理——Node 原生 fetch 默认不吃]。
- 结论：中继里发起外网请求技术上是现成的（内置 fetch + AbortSignal.timeout），但**现有所有出站都只打本机后端，尚无真正访问公网的先例**；代理只有 git 一条路有接线。

## 六、新增两路由的最小改动清单（仅 comfy-relay.mjs 一个文件）

假设两路由都走后端/本机数据，不真出公网。

1. **新增 handler 函数 ×2**：插在 `handleSubmitFile` 结束之后、`llmJobView`（3854）之前，即 **约 3853 行**处。
   - `handleTemplatesList(req, res)`（GET）：复用 `fetchBackendJson("/userdata?dir=workflows&recurse=true&full_info=true", 15_000)` 取全量列表 → 内存里做检索/分页 → `jsonOut` 返回。分页参数用 `new URL(req.url).searchParams`（参照 handleHistory 3551–3553 的写法）。
   - `handleTemplateFetch(req, res)`（POST）：`readBodyJson` → `resolveTemplateContent(body.template)`（3716，直接复用）→ `writeFileAtomic`（import 74）落盘 → `jsonOut` 返回 `{ ok:true, path, ... }`。落盘目标目录如需 workflows 目录，用 `resolveWorkflowsDir()`（758）。
2. **路由分派 ×2**：插在主 server 回调 if 链中 `/_relay/userdata` 块结束（约 **4269**）之后、`/_relay/drives`（**4271**）之前。每个块：方法不匹配回 405；`/_relay/template-fetch` 额外加 `if (!controlOk(req))` 403（对齐 submit-file 4639–4651 的写法）；然后 `void handler(req,res).catch(...); return;`。
3. **（可选）文件头路由注释**（17–40 行的业务面清单）补两行说明——纯文档，不影响行为。
4. 若 `/_relay/template-fetch` 的入参走 query 而非 body，可省 readBodyJson；按调用方"POST 拉单个模板落盘"描述，走 body。

不推荐动 `proxyHttp` 兜底或 upgrade 分支——`/_relay/*` 前缀在 upgrade 已被 404（约 4693），if 链命中后也不会落到反代。

## 七、不确定项

1. `/_relay/prompts/<id>` 分支（`pathOnly.startsWith`）的**精确起始行**未记录（在 4573 与 4595 之间，约 4583）。
2. `/_relay/history/commit`（4615）**未见 controlOk 检查**——从读取的代码看它只验 POST 与 body，是否属有意开放未查实（可能因 body 可达 40MiB，靠 readBodyJson 上限控制）。
3. 模板列表数据源是否只限 `dir=workflows`（`resolveTemplateContent` 语义如此），新路由若要别的 dir 需另行确认 ComfyUI /userdata 接口语义（本报告未读 ComfyUI 侧代码）。
4. Node 原生 fetch 是否遵循 `HTTP(S)_PROXY` 环境变量未验证（若 template-fetch 真要出公网且需代理，这是缺口）。
5. 调用方行号锚点与本文件版本差异约 ±360 行，未核查是否存在多版本 comfy-relay.mjs（本次只读了指定路径这一个文件）。
