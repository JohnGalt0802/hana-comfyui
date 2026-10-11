# 探查：存储层切到 ComfyUI 原生 userdata API 的可行性

> 项目：hui（Hana-ComfyUI，v2 App），开发仓 `D:\HanakoWorks\ComfyUI`
> 探查方式：**只读**源码（不改任何源码）+ **本机实测** 127.0.0.1:8188（写操作只在 `_probe_20261011/` 临时目录，已清理；未触碰 `workflows/` 与 `.history/`）。
> 标签约定：`[实测]` = 本机 curl 实测返回；`[源码]` = 静态读码推断；`[交叉]` = 源码 + 实测一致。

---

## 1. 现有存储实现现状

### 1.1 `app/bridge/history_store.py`（Python 落盘核心）

纯标准库模块（os/re/json/math/datetime），零 ComfyUI 依赖，可单测。负责「提交快照写盘 + 索引追加」。

**关键函数与行号**（文件 `app/bridge/history_store.py`）：

| 函数 | 行号 | 作用 |
|---|---|---|
| `sanitize_workflow_name` | L137 | 净化工作流名：剔控制字符/非法字符/首尾空白与点，超长截 80，空→`untitled` |
| `history_dir` | L166 | 拼 `<user_dir>/workflows/.history/<净化名>`（`os.path.abspath`） |
| `snapshot_file_name` | L176 | 文件名 `<seq 补零4位>-<promptId前8位>.json` |
| `build_snapshot` | L213 | 构造快照对象，含 `strip_heavy_fields` 剥离 base64 的 `blocks`（P2-F2 透传） |
| `strip_heavy_fields` / `_walk_strip` | L243 / L250 | **深拷贝 + 剥离 base64 内嵌图**：正则 `^data:image/...;base64,` 命中即替换为 `STRIPPED_IMAGE_PLACEHOLDER`（空串），不修改入参，记录命中路径 |
| `build_index_line` | L296 | 构造一行 JSONL 索引（不含 graph；P2-F2 块归属写摘要 `blocks:[{name,nodeCount}]`） |
| `parse_index` | L342 | 容错解析 JSONL：空行跳过、坏行计 `badLines`、对象才进 `entries` |
| `next_seq` | L377 | 取 max(seq)+1，空→1 |
| `commit` | L405 | **主落盘函数**：400→读索引→next_seq→构造→体积防护(14 MiB)→mkdir→原子写快照→**追加一行索引** |
| `list_commits` | L503 | 读索引（目录不存在→空 entries，ok=True） |
| `read_snapshot` | L536 | 读某条快照完整 JSON（file 优先防穿越；seq 从索引解析） |

**路径拼接（[源码]）**：
- 目录：`history_dir` L166 → `os.path.join(user_dir, "workflows", ".history", sanitize_workflow_name)`。
- 文件名：`snapshot_file_name` L176 → `"%04d-%s.json" % (seq, promptId前8位净化)`。

**JSONL 追加写（[源码]）**：
- `commit` L487：`with open(index_path, "a", encoding="utf-8", newline="") as fh: fh.write(line + "\n")` —— **纯追加，绝不读全文重写**。
- 快照写盘（L470）：原子写 `.tmp` → `os.replace`（同卷 rename，Windows 亦原子）。

**快照剥 base64（[源码]）**：
- `_BASE64_IMAGE_RE` L55：`re.compile(r"^data:image/[a-z0-9.+-]*;base64,")`。
- `_walk_strip` L250 递归遍历 graph，命中字符串即替换为空串（保持结构、清空体积）。`strip_heavy_fields` L243 做深拷贝，不修改入参。

**体积防护（[源码]）**：`MAX_SNAPSHOT_BYTES = 14*1024*1024`（L46）。超限 → 不建目录、不写盘，返回 413（L443）。

### 1.2 `app/bridge/__init__.py`（Python 路由注册）

**注册路由（`[源码]`，均在 `_ROUTES is not None` 分支内）**：

| 路由 | 方法 | 行号 | 请求/响应 | 鉴权 |
|---|---|---|---|---|
| `/hana_bridge/hello` | POST | L313 | 前端上报 sid；返回 `{ok}` | 无（同源前端，只记账本） |
| `/hana_bridge/result` | POST | L326 | 回传调用结果（喂 `_pending` future） | 无 |
| `/hana_bridge/call` | POST | L339 | `{op,args}` → 经 ws 推前端；**校验 `X-Hana-Token`**（L347→`_token_ok` L？/ `secrets.compare_digest`） | **token 必填**（中继→外部入口） |
| `/hana_bridge/state` | POST | L？ | 前端推快照缓存 | 无（同源） |
| `/hana_bridge/diag` | GET | L？ | 自检扩展挂载 | 无 |
| `/hana_bridge/ping` | GET | L？ | 状态 | 无 |
| `/hana_bridge/history-commit` | POST | L（P1-C1 段） | body `{workflow, promptId?, graph, at?, source?}`；返回 `{ok, seq, file, dir}` 或 400/413/500 | **无 token（P1-D1，L：2026-10-11 改为不校验）** |
| `/hana_bridge/history-list` | GET | L（P1-C1 段） | `?workflow=<名>`；返回 `{ok, entries, badLines}` | **无 token（同 P1-D1）** |
| `/hana_bridge/history-snapshot` | GET | L（P1-C1 段） | `?workflow=&seq=` 或 `&file=`；返回 `{ok, snapshot}` | **无 token（同 P1-D1）** |

- 路由注册汇总 log L（末尾）：`call / hello / result / ping / history-commit / history-list / history-snapshot`。
- **鉴权模型（[源码]）**：`/call` 校验 `X-Hana-Token`（`_token_ok` 用 `secrets.compare_digest` 比对 `.token` 文件，L `_load_token`）；`/hello / state / history-*` 不校验 —— 理由是"调用方是 8188 同源页面（桥 js），本机 8188 绑 127.0.0.1，只落盘/只读"。
- **user_dir 解析（[源码]）**：`_history_user_dir`（L P1-C1 段）= `os.path.join(folder_paths.get_user_directory(), _user_manager.default_user)` → 单用户即 `user/default`。依赖缺失时抛 RuntimeError，端点内明确报 500（不猜路径）。

### 1.3 落盘实际路径（[交叉] 源码 + 实测）

源码拼法 → 实测 8188 上 `GET /api/v2/userdata?path=workflows/.history` 返回：
```
workflows/.history/Qwen21 t2i 质量版 (00012)/index.jsonl          (file)
workflows/.history/Qwen21 t2i 质量版 (00012)/NNNN-<promptId8>.json (file)
workflows/.history/Qwen21 t2i 质量版 (00012)/                       (directory)
```
与题述布局完全一致：`<user_dir>/workflows/.history/<工作流名>/{index.jsonl, NNNN-<promptId8>.json}`，且**隐藏目录 `.history` 已被实际使用并可读列**。

---

## 2. 中继 `app/runtime/comfy-relay.mjs` 的 fs 通道

**是否有 `/fs/*` 端点（[源码]）**：有。注释 L15-17 与路由注册 L2993：
- `POST /_relay/fs/stat`（文件 stat）
- `POST /_relay/fs/read`（读文本/二进制，≤8 MiB）
- `POST /_relay/fs/write`（写文本，≤16 MiB，原子写；`app 沙箱外的落盘代做`）
- 三者均**需 `controlKey`**（L2999 `controlOk(req)`，403 否则）。

**现在 history 功能有没有用它（[交叉] 源码 + 桥 js）**：
- 桥前端 `app/bridge/js/hana-bridge-1011095446.js` 的 history 调用**全部指向桥 Python 端点**（`HISTORY_COMMIT_PATH="/hana_bridge/history-commit"` L2166；`HISTORY_LIST_PATH` L2367；`HISTORY_SNAPSHOT_PATH` L2908），**无任何 `/_relay/fs/*` 或 `/_relay/history/commit` 引用**。
- 中继侧虽有 `POST /_relay/history/commit`（L2955，调用 `handleHistoryCommit`）与 `GET /_relay/history`（L2947，代理后端 `/history`），但**当前无前端/App 调用链指向它们**（桥 js 改道 Python 端，见 js L2165 注释"端点由 P1-C1 实现"）。
- 中继 `import { handleHistoryCommit }` 来自 `./history-commit.mjs`（L57），那是**另一套** JSONL 落盘实现（写本机绝对路径 `workflowsDir/.history/...`），与现行 Python 端并存但未被桥前端使用。

**结论（[推断]）**：中继的 fs 通道 + `/_relay/history/commit` 现在是**"保留未用"**状态。桥前端走的是 Python 桥端点的"方案甲"（直接 8188 同源落盘），中继不在 history 落盘链路里。`/_relay/fs/write` 当前只服务 `app/workflow-file.mjs` 的工作流文件落盘与 `submit-file`，与 history 无关。

---

## 3. ComfyUI 原生 userdata API 能力（本机实测 127.0.0.1:8188）

源码位置：`D:\ComfyUI\ComfyUI\app\user_manager.py`（`add_routes`，L123 起）。路由全部挂在 PromptServer 上，单用户默认 `user/default`。

**实测汇总（[实测]，curl 直连 8188，全部 200 除非标注）：**

| 能力 | 实测结果 | 证据 |
|---|---|---|
| `GET /api/userdata?dir=...&recurse=...` 列目录 | ✅ 能列文件（`full_info` 给 `path/size/modified/created`；`recurse=true` 递归） | 实测 `#1`：`dir=workflows&recurse=true&full_info=true` 返回 60+ 文件 |
| `GET /api/v2/userdata?path=...` 列目录（含目录类型） | ✅ **能区分 file/directory**，含隐藏项 | 实测 `#2`/`#11b`/`#7c` 返回 `{name,path,type,...}` |
| `GET /api/userdata/{file}` 读文件 | ✅ 能读（附件下载；user.css 特例 inline） | 实测 `#4`/`#7b`/`#3b` 回读内容 |
| `POST /api/userdata/{file}` 写/新建 | ✅ 能新建、能覆盖（默认 `overwrite=true`） | 实测 `#3`（自动建父目录）、`#5`（覆盖） |
| `POST .../move/{dest}` 移动/重命名 | ✅ 能 move（同目录改名、跨目录移均可，move 也会建父目录） | 实测 `#10b`/`#11` |
| `DELETE /api/userdata/{file}` | ✅ 删除，返回 204 | 实测 `#9` |
| **能否创建子目录** | ✅ **写 `a/b/c.json` 时自动建父目录**（`get_request_user_filepath` 内 `os.makedirs(parent, exist_ok=True)`，L~99）；但**不能独立创建空目录**（无专门建目录端点，POST 以 `/` 结尾 → 405） | 实测 `#3`（sub/ 自动建）、`#7`（.hidden_dir/ 自动建）、`#12`（/ 结尾 405） |
| **能否追加写（JSONL）** | ❌ **只能整文件覆盖**，无追加语义；`POST` 用 `tempfile.mkstemp` + `os.replace` 整体替换 | 实测 `#5b`：覆盖后内容=`{"hello":2}`，原 `{"hello":1}` 被整文件替换，非追加 |
| **隐藏目录/点开头** | ✅ `.history/`、`.secret.json` 均能写、读、列 | 实测 `#7`/`#7b`/`#7c`（`.history` 出现在 v2 列表；`.secret.json` 读回 `secret`） |
| **路径穿越防护** | ✅ `user/default/` 之外不可访问；`..`/`../` 编码后 → 403 | 实测 `#8`：`..%2F..%2Fetc.json` → 403（源码 `commonpath` 校验 L83-92） |
| `overwrite=false` 已存在 | ✅ 返回 409（防误覆盖） | 实测 `#6`：`File already exists` 409 |
| 多段路径（`/`） | ⚠️ `/userdata/{file}` 路由只匹配**单段**，`a/b.json` 必须把 `/` 编码成 `%2F`（否则 405）；中继 `/_relay/userdata` 正是为此编码（L2649 `encodeURIComponent`） | 实测 `#3`/%2F 成功、`#3`初版未编码→405 |

**关键源码依据（[源码] `app/user_manager.py`）：**
- 路由：`listuserdata` L150（GET `/userdata`）、`list_userdata_v2` L214（GET `/v2/userdata`）、`getuserdata` L334（GET）、`post_userdata` L364（POST）、`delete_userdata` L427（DELETE）、`move_userdata` L437（POST `/move/{dest}`）。
- 路径约束 `get_request_user_filepath` L72：`root_dir=folder_paths.get_user_directory()`；`commonpath((root_dir, user_root)) != root_dir` → 返回 None（403）；file 段再 `commonpath((user_root, path)) != user_root` → None（403）。即**只允许 `user/<当前用户>/` 之下**。
- 写：`post_userdata` L364：`overwrite` 默认 true；`tempfile.mkstemp` + 写 + `os.replace`（原子覆盖）；`dir_name=os.path.dirname(path)` 前已 `get_request_user_filepath(..., create_dir=True)` 建父目录（L99）。
- 读：`getuserdata` L334：强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`（防存储 XSS）；`user.css` 例外 inline。

**鉴权（[源码]）**：`get_request_user_id` L~65：非 multi_user 时 `user="default"`；multi_user 时取 `comfy-user` header，并以 `SYSTEM_USER_PREFIX` 拦截系统用户。本机单用户部署下 **userdata 端点不需要任何 token/Authorization**，靠同源 + 127.0.0.1 绑定。中继调后端 userdata 也只带 `accept` 头、无 token（L2451/2462 `fetchBackendJson/readBackendText`）。

---

## 4. 从 ComfyUI 页面内（iframe 直连 8188）调用 userdata API 的鉴权

- **前端 `api.fetchApi('/userdata/...')` 行为（[推断/源码]）**：ComfyUI 前端 `api.fetchApi` 自动拼 `/api` 前缀（`api.api_base` 默认 `/api`）。在 iframe 直连 8188 的同源页面里调用，请求落在 8188 同源，与桥 Python 端点（`/api/hana_bridge/*`）**同源同信任模型**。
- **是否带 token**：userdata 端点（§3 末）按 `comfy-user` header 区分用户、无需 Bearer/token。单用户下连 header 都可省。桥 js 现已实测用 `fetchApi` 调 `/hana_bridge/history-list` 等并"已实测等价"带 `/api` 前缀（js L2367 注释），故换 userdata 同样可直接 `api.fetchApi('/userdata/...')`，**无额外鉴权负担**。
- **桥 Python 端点现在怎么鉴权（[源码]）**：`/history-commit|list|snapshot` 自 P1-D1（2026-10-11）起**不校验 token**（仅 `/call` 校验 `X-Hana-Token`）。两者信任模型一致：8188 同源 + 本机-only。

---

## 5. 沙箱/权限

- 写 `user/default/workflows/.history/` 是否受 ComfyUI 限制：**受约束但约束正好是"够用"**（`[交叉]` 源码 + 实测）：
  - 允许范围：`user/<用户>/` 之下（`get_request_user_filepath` 的 `commonpath` 校验 L83-92）。
  - `.history/` 点开头隐藏目录：**实测证明可写可读可列**（§3、§1.3），无特殊屏蔽。
  - 不允许：`user/default/` 之外（实测穿越 → 403）、不能用 `/userdata/{file}` 直建空目录。
- 结论：目标落盘位置 `user/default/workflows/.history/<名>/{index.jsonl, NNNN-*.json}` 完全落在允许范围内，且隐藏目录已被现行实现实际使用（§1.3），权限层面无障碍。

---

## 给存储切换的结论

### 原生 userdata API 能覆盖哪些
- ✅ **快照文件写/读/删**：`POST/GET/DELETE /userdata/<workflow>/.history/<名>/NNNN-*.json`（父目录自动建）。
- ✅ **隐藏目录 `.history/`**：实测可写可读可列，无需特殊处理。
- ✅ **权限边界**：目标路径 `user/default/...` 内，无穿越风险；同源 + 127.0.0.1 即够用，无需 token（与现行桥端点同信任模型）。
- ✅ **列表/枚举**：`GET /v2/userdata?path=...` 返回 file/directory 结构，可替代"读目录"，回跳/历史浏览够用。
- ✅ **防误覆盖**：`overwrite=false` → 409，可作为快照"写一次不可变"的保护。

### 覆盖不了哪些（原生 API 的硬限制）
- ❌ **追加写（JSONL）**：原生只有"整文件覆盖"（`tempfile`+`os.replace`）。现行 Python 端的 `index.jsonl` **追加写**语义无法直接映射——每次提交不能 `>>` 一行，只能把整个 `index.jsonl` 读回、追加、整文件回写。
- ❌ **独立创建空目录**：无建目录端点；只能"写文件时顺带建父目录"。现行实现里 `index.jsonl` 与首个快照同批创建，问题不大；但若想"先建目录再陆续写"则不行（不过可通过首次 POST 快照时自动建父目录解决）。
- ⚠️ **多段路径需 `%2F` 编码**：`/userdata/{file}` 仅匹配单段。`workflows/.history/名/文件` 必须把 `/` 编码为 `%2F`，否则 405。需在调用层统一编码（中继已有先例 L2649）。
- ⚠️ **原子性只在单文件级**：原生 `os.replace` 是单文件原子覆盖；但"读 index.jsonl → 追一行 → 写回"这一步**不是原子的**（并发提交可能丢行）。现行 Python 端靠进程内串行 + 追加写规避；切到 userdata 后需自行加锁/串行化提交，否则多标签并发提交有竞态。

### 覆盖不了的用什么兜底
- **索引（index.jsonl）**：放弃"纯追加"语义，改为**整文件读改写**（read → append entry → 整文件 POST 覆盖）。代价：每次提交多一次整文件读+写；但索引体量小（实测 17 条 ~6 KB），可接受。**并发兜底**：提交通道收口到单一写入者（要么仍是桥 Python 端点，要么前端串行 Promise），或在桥端用 `overwrite=true` 前先 GET 当前索引——但 GET+POST 间仍有窗口，更稳的是保留一个进程内串行队列。
- **空目录**：不依赖"先建目录"，首次提交直接 POST 快照（父目录自动建），索引文件随首次提交一并建立。

### 明确判断：**能切，但 index.jsonl 的追加写要改成整文件读改写 + 串行化**

- 快照本体（占存储与体积防护逻辑 90% 的工作）可 1:1 平移到 userdata，路径/隐藏目录/权限全满足，且这正是"一鱼两吃"成 cui 插件的关键（脱离桥 Python 端点、用 ComfyUI 原生存储）。
- 唯一实质改动：索引从"进程内 `open(a)` 追加"改成"GET 索引 → 追行 → POST 覆盖"，并加提交串行化（防并发丢行）。体积防护（14 MiB）、base64 剥离、文件名净化、seq 计数逻辑全部可原样保留（它们与落盘介质无关）。
- 推荐落地姿势：**保留桥 Python 端点的"提交收口"角色**（它已在 ComfyUI 进程内，天然单写入者、零并发窗口），仅把其内部的 `os` 直写替换为对 userdata 的 `POST/GET/DELETE` 调用；前端仍调 `/hana_bridge/history-*`（同源、无 token），对外接口不变。这样既切到原生存储，又不动前端与信任模型——"一鱼两吃"的 cui 插件版则直接调 userdata，复用同一套 history_store 纯逻辑（把 `os` IO 换 userdata client 即可）。

### 实测 vs 推断标记
- `[实测]`：§1.3、§3 全部表格项、§5 约束（均 curl 直连 8188 确认，探针目录 `_probe_20261011/` 已 DELETE 清理，真实 `workflows/.history` 未触碰）。
- `[源码]`：§1.1/§1.2 行号、§3 源码依据、§4 鉴权模型。
- `[推断]`：§2 中继"保留未用"结论（基于桥 js 无引用 + 路由存在但无调用链）、§4 前端 `fetchApi` 行为（基于桥 js 已实测 `/api/hana_bridge/*` 等价 + 同源）。
- `[交叉]`：§1.3（源码拼法 + 实测目录一致）、§2（源码路由 + 桥 js 无引用）、§5（源码 commonpath + 实测 403/隐藏目录）。

---

> 探针清理确认（[实测]）：`DELETE _probe_20261011/.hidden_dir/.secret.json` 204、`DELETE _probe_20261011/newsub/d.json` 204；`v2/userdata?path=_probe_20261011` 仅剩 3 个空目录；`v2/userdata?path=workflows/.history` 仍含 17 条真实提交，证明未触碰用户数据。
