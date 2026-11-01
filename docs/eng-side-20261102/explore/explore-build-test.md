# hui (comfyui-hana) 测试 / 版本 / 同步 / 仓库约定 · 探索报告

> 探索日期：2026-11-02 · 只读，未修改任何现有文件，未执行任何写状态命令。
> 关键文件均给出处；每节末尾标不确定项。

---

## 一、源码真相源与副本关系

**结论：存在两代真相源。当前有效的真相源是 git 仓库 `D:\HanakoWorks\ComfyUI`（app/ 子目录），旧真相源 `D:\HanakoWorks\HanaAgentAPPs\comfyui-hana-app` 已停更（2026-10-22 后无提交）。宿主 `C:\Users\John Galt\.hanako\apps\comfyui-hana` 是同步副本，且当前处于漂移状态（版本比仓库还新，见第七节）。**

证据：

| 位置 | 版本 | git | 说明 |
|---|---|---|---|
| `D:\HanakoWorks\ComfyUI` | manifest v**0.20.1** | 是（`main...origin/main`，remote `git@github.com:JohnGalt0802/hana-comfyui.git`，末次提交 `6ba4bd2 2026-11-01 fix: …副本命名不再叠后缀（v0.20.1）`，工作树干净） | `AGENTS.md` 开头自述：「**开发仓**：`D:\HanakoWorks\ComfyUI`（源）· 运行副本：`~\.hanako\apps\comfyui-hana`」 |
| `D:\HanakoWorks\HanaAgentAPPs\comfyui-hana-app` | manifest v**0.13.3** | 是（无 remote，末次提交 `3ebafdc 2026-10-22`） | 旧真相源；其根下有 `.sync-state.json`（2026-10-22 时间戳） |
| `C:\Users\John Galt\.hanako\apps\comfyui-hana`（宿主） | manifest v**0.21.1** | **不是 git 仓库**（`git rev-parse` 报 `fatal: not a git repository`） | 运行副本；根下也有 `.sync-state.json`（2026-10-22，内容与 HanaAgentAPPs 仓根下那份一致） |

- `D:\HanakoWorks\ComfyUI\AGENTS.md`（项目治理文件，John 定）原文：
  > **开发仓**：`D:\HanakoWorks\ComfyUI`（源）· 运行副本：`~\.hanako\apps\comfyui-hana`
  > 改动生效范围按 `docs/改动生效范围.md`；同步用 `tools/sync-to-host.ps1` 并全量校验
- 真正的 app 源码在仓库的 **`app/` 子目录**（`D:\HanakoWorks\ComfyUI\app\manifest.json` 等），同步脚本以 `app\` 为源（见第二节）。
- [不确定] 宿主 v0.21.1 比仓库 HEAD v0.20.1 还新，仓库内（代码/文档/git log/tag）查不到任何 0.21 痕迹 —— 说明 2026-11-01 之后有人直接改了宿主或经未落盘渠道更新了宿主。这是给调度方的重要警示：**下次按仓库同步会用 v0.20.1 覆盖宿主 v0.21.1**。

---

## 二、同步脚本

有**两个**同步脚本，分属两代真相源：

### 2.1 现行（对应开发仓 D:\HanakoWorks\ComfyUI）：`D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1`

- 用法（脚本头原文）：
  ```
  powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1 -DryRun    # 只打印将发生的差异（不写盘）
  powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1            # 实际同步（副本已存在时）
  powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1 -Create    # 首次创建宿主副本目录
  ```
- 参数：`-Source`（默认 `D:\HanakoWorks\ComfyUI\app`）、`-Target`（默认 `C:\Users\John Galt\.hanako\apps\comfyui-hana`）、`-DryRun`、`-Create`、`-SkipVerify`。
- hash 校验：同步后**全量核对**——对源与副本逐文件算 SHA-256（排除 `.git`），按相对路径比对，报告「缺失/多出/内容不一致」条目（`-SkipVerify` 可跳过）。robocopy 退出码 0-7 视为成功，≥8 报错。
- 排除项：`robocopy /E /XO /XD .git /XF .DS_Store`；**增量非 purge**，宿主副本允许有历史沉积文件。
- 方向守卫：校验源/目标 `manifest.id` 必须是 `comfyui-hana`，否则拒绝覆盖；目标不存在时必须显式 `-Create`。
- 纪律（脚本注释原文）：「宿主安装/重启是独立阶段（由主脑统一安排）；本脚本只负责『复制 + 校验』」。
- 配套：桥部署另有 `tools/deploy-bridge.ps1`（bridge → `D:\ComfyUI\ComfyUI\custom_nodes\hana_bridge`）。

### 2.2 旧版（对应旧真相源）：`D:\HanakoWorks\HanaAgentAPPs\.tools\sync-comfyui-hana.ps1`

- 真相源自述：「仓库 `D:\HanakoWorks\HanaAgentAPPs\comfyui-hana-app` 是唯一真相源」（**已过时**，该仓停在 v0.13.3 / 2026-10-22）。
- 双目标：宿主 App 副本 + ComfyUI 桥（`bridge/ → D:\ComfyUI\ComfyUI\custom_nodes\hana_bridge`）。
- 参数：`-BridgeOnly / -AppOnly / -SkipSync / -RestartComfy / -ReloadHost / -Force / -Adopt / -DryRun`。
- 漂移守卫：同步前比对宿主现状与上次基线（`.sync-state.json`，SHA-256 哈希树），宿主有未回写改动即拒绝同步，`-Adopt` 反向抢救、`-Force` 强制覆盖。
- 版本一致性检查：manifest.json version 与 index.js `APP_VERSION` 必须一致，否则中止（注释称 index.js 的 APP_VERSION「是独立硬编码常量」——**该描述已过时**：现行代码里 `APP_VERSION` 是从 manifest.json 读的 IIFE，两份 index.js 相同）。基线写入 `$repo\.sync-state.json`（即 HanaAgentAPPs 仓根）。
- 排除：宿主同步排除 `.git`、`bridge/`（走桥路）、`*.bak`、`*.bak-*`、`*.pyc`；桥同步排除 `__pycache__`。
- 生效动作：`-ReloadHost` 会向 `http://127.0.0.1:<port>/api/extensions/app:comfyui-hana/reload` POST（token 取自 `C:\Users\John Galt\.hanako\server-info.json`）。
- 排除 `.sync-state.json` 的拷贝路径里没有它 → 每次跑旧脚本会把它带进宿主目录（解释了宿主根下为何有 .sync-state.json）。

**现行口径（AGENTS.md 红线）**：同步用 `tools/sync-to-host.ps1` 并全量校验。旧脚本是否还在用查不到证据 [不确定]。

---

## 三、测试 runner 与命令

**结论：JS 用 Node 自带 `node --test`（node:test），无自研 runner、无 package.json/测试脚本；桥的 Python 用标准库 unittest。无 npm install 依赖——全部自含零依赖。**

- 15 个 `*.test.mjs`（仓库 `app/` 与宿主副本文件清单一致）：
  根 1 个 `workflow-file.test.mjs`；`lib/` 13 个（canvas-analysis / canvas-diff / canvas-edit / canvas-history / canvas-open-workflow / canvas-outline / canvas-perf / canvas-project / canvas-symbol / commit-graph-lanes / history-hide / node-adapter / workflow-tools）；`runtime/` 1 个 `history-commit.test.mjs`。
- 用例数（按 `test(`/`it(` 行计数，近似值）：共 **≈365** 条。大户：node-adapter 87、canvas-history 79、canvas-edit 40、canvas-analysis 33、workflow-file 34、workflow-tools 27、history-hide 23、canvas-project 19、canvas-outline 16、commit-graph-lanes 12、canvas-open-workflow 10、canvas-diff 7、canvas-symbol 5、history-commit 5、canvas-perf 2。
- 确切命令（`_结构普查-6-历史签名与块归属.md:231-232`、`记录-画布提交历史-P5a-数据模型纯逻辑.md:67` 等多处文档原文，cwd = `D:\HanakoWorks\ComfyUI`）：
  ```
  node --test app/lib/canvas-history.test.mjs
  node --test app/runtime/history-commit.test.mjs
  node --test app/lib/commit-graph-lanes.test.mjs
  ```
- 特例：`app/workflow-file.test.mjs` 文件头原文「运行：`node app/workflow-file.test.mjs`」（自含可执行，非 node --test 形式；两者应兼容，未实测 [不确定]）。
- Python 桥测试：`app/bridge/history_store.test.py` 文件头原文「运行：`python -m unittest app.bridge.history_store.test -v`（或直接 `python app/bridge/history_store.test.py`，以 `D:\HanakoWorks\ComfyUI` 为 cwd）」。
- 文档另提及验收含 `node --check` 语法检查（`施工-画布提交历史-UI定稿落地.md:97`：「`node --test app/lib/commit-graph-lanes.test.mjs` 全绿；`node --check` 通过」）。

**全量跑法没有文档化的单条命令**（查不到 `node --test app` 之类整目录写法）；文档惯例是逐文件跑改动对应的测试。

---

## 四、版本与变更记录

### 4.1 manifest.json 关键字段（宿主副本，v0.21.1）

```json
{
  "manifestVersion": 2,
  "id": "comfyui-hana",
  "name": "Hana-ComfyUI",
  "version": "0.21.1",
  "entry": "index.js",
  "minAppVersion": "0.1013.0",
  "capabilities": [
    "app/runtime.execute",
    "app/runtime.local-machine",
    "app/runtime.network",
    "app/resources.read",
    "app/models.infer",
    "app/tools.expose-to-model",
    "app/tasks.manage",
    "app/session.start-turn",
    "app/windows.manage"
  ]
}
```
（另含 `network` 白名单 127.0.0.1、`ui.csp` frameDomains/connectDomains 8188、`contributes.cards` workspace 页卡 + settings 页。）

### 4.2 版本号约定

- **没有成文的「何时抬版本」文档**（全部 docs/AGENTS/README 检索「版本号/抬版本/version」无命中）。
- 实际惯例可从 git log 直接读出（**版本号写进 commit message 括号里**，并打 git tag）：
  - feat → minor +0.1：`4f35f66 feat: 画布执行路径二选一…（v0.20.0）`、`858bab2 feat: 子图展开 v1…（v0.19.0）`
  - fix → patch +0.0.1：`b2b351f fix: 拒绝汇总按类别给建议…（v0.19.1）`、`6ba4bd2 fix: 未保存画布的同页执行…（v0.20.1）`
  - 已有 tag：`v0.13.0 / v0.13.1 / v0.14.2 / v0.14.4 / v0.20.1`（不是每个版本都打 tag）。
- `index.js` 的 `const APP_VERSION` 是从 `manifest.json` 的 `version` 读出来的（IIFE），**单一事实来源是 manifest.json**。
- 待办文档有半句口径：`docs/待办与验收清单.md:77`「版本号：当前 0.2.0；打包时按流程提升并复核 minAppVersion」（早期文档，版本口径已远远走过）。

### 4.3 CHANGELOG

**没有 CHANGELOG 文件**（三个相关根目录均查无）。版本历史的实际载体是：
1. git commit message 里的 `(vX.Y.Z)` 后缀 + git tag；
2. `docs/修复-*.md`（如 `修复-issue1-3-4-20261030.md` 标题即「修复 issue #1/#3/#4（v0.16.0 ~ v0.16.2，2026-10-30）」）——按修复批次记录版本。

---

## 五、生效方式（宿主运行的就是 `C:\Users\John Galt\.hanako\apps\comfyui-hana` 这份）

宿主侧无 git、无构建产物，index.js 等 `.mjs` 直接被宿主加载，运行时路径即 `C:\Users\John Galt\.hanako\apps\comfyui-hana`（manifest `entry: "index.js"`；能力清单描述「可自定义 ComfyUI 安装目录」指的是 ComfyUI 本体，不是 App 代码）。

生效规则原文出处：`docs/改动生效范围.md`（AGENTS.md §三 红线引用它）：

| 改动位置 | 生效方式 |
|---|---|
| `app/bridge/__init__.py`（py 桥） | `tools/deploy-bridge.ps1` + **重启 ComfyUI 服务**（py 由服务进程加载，热更不生效） |
| `app/bridge/js/**` | 部署（改名绕缓存）+ **重载工作区页面**（免重启服务） |
| `app/index.js` | 同步宿主副本（`tools/sync-to-host.ps1`）+ **宿主重载/重启**；「reload 后工具 RPC 可能需要重启恢复」（M6 记录） |
| `app/ui/**` | 同步 + 宿主重载/重启；「ui 受宿主 iframe 缓存，**重启最稳**」 |
| `app/lib/**` | 同步 + 宿主重载/重启（随 index.js） |
| `skills/**`、`docs/**` | 随仓库同步；不影响运行态 |
| 配置/数据 json | 即时生效 |

重启纪律（同文件原文）：「涉及宿主重启 / 服务重启 / 工作区重载的动作一律『先说再动』，**禁止静默重启**」。

reload 的具体做法（旧脚本 `-ReloadHost` 分支可作参考实现）：`POST http://127.0.0.1:<宿主port>/api/extensions/app:comfyui-hana/reload`（Bearer token 取自 `C:\Users\John Galt\.hanako\server-info.json`）。现行 AGENTS.md 口径下 reload/重启由主脑统一安排，不归执行者。

---

## 六、执行者自检命令（一句话版）

> **改了哪个文件就跑它对应的测试，外加 `node --check` 语法检查；cwd 全部是 `D:\HanakoWorks\ComfyUI`。**

```powershell
# 1) 语法检查（改动任何 .mjs/.js 后）
node --check app/index.js

# 2) 跑对应单测（示例；改成实际改动的测试文件）
node --test app/lib/canvas-history.test.mjs
node --test app/lib/node-adapter.test.mjs
node --test app/runtime/history-commit.test.mjs

# 3) workflow-file 专项（文件头钦定写法）
node app/workflow-file.test.mjs

# 4) 改了 bridge py 时
python app/bridge/history_store.test.py
```

改完后**不要自行同步/重启**：同步走 `tools/sync-to-host.ps1`（先 `-DryRun`）、reload/重启由主脑安排（AGENTS.md 红线）。

---

## 七、不确定项

1. **宿主 v0.21.1 > 仓库 v0.20.1 的来历不明**：仓库内查不到 0.21 任何痕迹（代码、docs、git log、tag 均无）。宿主自 2026-10-22 之后是否有人绕过 `tools/sync-to-host.ps1` 直接改动，查不到记录。**下次同步前必须先弄清这份 v0.21.1 差异**，否则会覆盖丢失。
2. 旧脚本 `sync-comfyui-hana.ps1` 是否仍在使用：查不到证据。其 `-ReloadHost` 能力现行脚本没有，但 AGENTS.md 现行口径只认 `tools/sync-to-host.ps1`。
3. `node app/workflow-file.test.mjs` 与 `node --test app/workflow-file.test.mjs` 是否等价：未实测（文件本身用了 node:assert，自含可执行，大概率两者都能跑）。
4. 全量测试是否存在一条文档化命令（如整目录 `node --test`）：未找到，本报告只给逐文件写法。
5. 用例总数 365 为按 `test(`/`it(` 行数近似，个别文件（如 canvas-perf 2 条）可能存在子测试嵌套计数偏差。
