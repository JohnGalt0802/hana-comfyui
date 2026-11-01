# hui 工程侧三块补齐 · 总计划

> 状态：仅计划，代码未动。等 John 拍板后按批次执行。
> 生成时间：2026-11-02
> 真相源：`D:\HanakoWorks\ComfyUI`（git 仓，代码在 `app/` 子目录）
> 宿主运行副本：`C:\Users\John Galt\.hanako\apps\comfyui-hana`

## 一、要补什么

官方 ComfyUI 本地 MCP 有四类我们没有的能力：模板库、提交前校验、缺节点包诊断、版本与依赖管理。前三个对日常出图影响最直接，本计划只做这三个。

补完之后 agent 的行为链变成：**先去模板库拿一张官方调好的图 → 提交前校验能不能跑 → 跑不了就报缺什么**。

## 二、六条探索结论（原始报告在 `explore\`）

| 线 | 结论 | 报告 |
|---|---|---|
| 中继路由 | 路由是 `pathOnly ===` 的 if 链，入口 `http.createServer` 在 4171 行；只绑 127.0.0.1，写路由走 `controlOk` + 头 `x-comfy-relay-key` | `explore-relay-routes` |
| App 分派 | 工具注册 6948-7033，schema 由 `actionBranches()` 生成 oneOf，分派是 switch 6976-7026；现有 12 个 action | `explore-app-actions` |
| 转换契约 | `convertUiToApi` 成功返回 prompt 对象、失败 throw；`problems` 是中文字符串数组**没有 code**；无任何值域检查 | `explore-workflow-tools` |
| 构建流程 | 真相源是 `D:\HanakoWorks\ComfyUI`，同步脚本 `tools/sync-to-host.ps1`；测试 `node --test`，15 文件约 365 用例；无 lint | `explore-build-test` |
| 模板库 | `index.mcp.json` 10 分类 694 条；完整索引 735 条，mcp 是子集；单模板是 UI 格式，加载节点藏在 `definitions.subgraphs[].nodes[]`；`properties.models` 只有 `name`/`url`/`directory` 三字段 | `explore-template-hub` |
| 缺包映射 | 两份 `extension-node-map.json`，cache 版 5718 键更新；反向 42838 类名，热门名对应十几个仓库**不能取唯一解**；纯前端扩展包不在表里 | `explore-node-deps` |

### 探索带出的三个硬约束

1. **`/object_info` 4.13 MiB，宿主网络响应上限 5 MiB**。App 侧直接拉会随节点包增长撞线，必须走中继且裁剪。
2. **类名到仓库不是一对一**。`PreViewVideo` 对上 18 个仓库，`KSampler` 对上含核心仓库的多个。诊断只能给候选列表，不能断言"就是缺这个包"。
3. **模板的节点不在顶层 `nodes`**。图生图/视频这类模板的加载节点在 `definitions.subgraphs[].nodes[]` 里，顶层是 UUID 引用的 subgraph。校验和上画布都必须先展开。

## 三、任务清单与依赖

```
阶段 0   T0 漂移对账（只读，门禁）
阶段 1   T1 中继 object-info 裁剪与缓存
阶段 2   T2 校验内核(lib) → T3 校验路由(relay) → T4 校验 action(app)
阶段 3   T5 模板内核(lib) → T6 模板路由(relay) → T7 模板 action(app)
阶段 4   T8 缺包内核(lib) → T9 缺包路由(relay) → T10 缺包 action(app)
阶段 5   T11 文档、版本、同步、真机验收
```

**可并行**：T2 / T5 / T8 三个内核都是纯新增文件，互不冲突，可同时开。
**必须串行**：T3 → T6 → T9（同改 `runtime/comfy-relay.mjs`）；T4 → T7 → T10（同改 `index.js`）。

每个任务书都在本目录，文件名前缀即编号。

## 三之二、任务状态（执行时更新这一栏）

| 编号 | 任务 | 改哪个文件 | 状态 |
|---|---|---|---|
| T0 | 漂移对账 | 只读 | 已完成（`7640206`，三处哈希一致） |
| T1 | 中继 object-info 裁剪 | `runtime/comfy-relay.mjs` | 已完成（4,331,637 → 974,681 B，2549 类） |
| T2 | 校验内核 | 新增 `lib/validate-workflow.mjs` | 已完成（11 用例） |
| T3 | 校验路由 | `runtime/comfy-relay.mjs` | 已完成（真机四条 curl 通过） |
| T4 | 校验 action | `index.js` | 已完成（真机正常图/坏 ckpt 均正确） |
| T5 | 模板内核 | 新增 `lib/template-hub.mjs` | 已完成（18 用例，169 个模板模型只在 subgraph 内） |
| T6 | 模板路由 | `runtime/comfy-relay.mjs` | 已完成（真机检索 38 条、拉取落 hui-templates） |
| T7 | 模板 action | `index.js` | 已完成（真机 list/fetch 通过） |
| T8 | 缺包内核 | 新增 `lib/node-deps.mjs` | 已完成（11 用例） |
| T9 | 缺包路由 | `runtime/comfy-relay.mjs` | 已完成（三态实测） |
| T10 | 缺包 action | `index.js` | 已完成（真机 classes 与 workflow 两条路径通过） |
| T11 | 收尾 | 文档 + manifest | 已完成（v0.24.0，三份 references + 验收清单） |

### 执行中做过、与计划不同的决定（记录在案）

1. **模板落盘位置**：计划写 `workflows\_hub\`，John 改为**工作流目录之外**，实际落 `<ComfyUI>\user\default\hui-templates\<Category>\<name>.json`，不进工作流列表。
2. **T1 裁剪结构新增 `output_node`**：T2 复核指出没有它就无法把「有节点但没输出节点」判成 error。加字段同时把裁剪 schema 从 1 升到 2，否则 24 小时缓存内新字段读不到（已踩过）。
3. **T6 索引数据现状**：上游 `index.zh.json` 把 wan 系视频模板的 `mediaType` 全标成 `image`（683 image / 11 audio / 0 video），所以按 `mediaType=video` 过滤命中 0 条，属上游数据问题。
4. **T6 环境事实**：node 直连 jsDelivr 首连超时、重试可通；raw.githubusercontent.com 稳定。未加任何代理逻辑。
5. **T10 请求体形状**：中继 `/_relay/node-deps` 的 `workflow` 只认「字符串或内联对象」，App 侧最初按 `validate` 的形状发了 `{workflow:{template}}`，真机 400；已改为拍平成字符串。

## 四、通用约束（每份任务书都适用）

1. **真相源只有一处**：`D:\HanakoWorks\ComfyUI`。改代码在那里改，改完同步到宿主副本，禁止反向操作。
2. **自检不等于验收**。执行者只做语法检查、单测、接口自测。是否达标由独立复核与 John 真机验收判定。
3. **禁止越界**。交付时用 `git status --short` 证明只动了自己负责的文件。
4. **不确定就说不确定**。允许回"做不到/需要拍板"，禁止用"应该可以"糊过去。
5. **用 codemode 批量执行**，不要一次一个工具调用。
6. 临时目录各任务独立，用完删掉自己的，不碰别人的。

## 五、待拍板（开工前需要 John 定）

1. **T0 的处置**：宿主 v0.21.1 比仓库 v0.20.1 新，`index.js` 修改时间是今天 1:58。是回写仓库，还是用仓库覆盖宿主？
2. **模板落盘目录**：`user/default/workflows/_hub/`（能直接上画布，工作流列表会多一层）还是工作流目录之外（不污染列表，上画布时再搬）？
3. **缺包诊断深度**：只报"没装/可能是什么包"，还是连"装了但加载失败"一起判定（要读 custom_nodes 的 git remote 与启动日志）？
4. **是否同意把外网请求放中继**：模板库要拉 GitHub，我们打算让中继进程去拉（绕过宿主的 5 MiB 响应上限与 allowedHosts 白名单，`manifest.json` 不用改）。这等于给中继开了一条对外的出站通道，要你确认。
5. **校验的失败策略**：校验不通过时，是硬拦提交，还是只警告由 agent 自己决定？

## 六、验收总则

单一功能的"完成"需要同时满足：

- 语法检查通过（`node --check`）
- 本任务相关的 `node --test` 全绿
- 有一条真实的接口自测记录（curl 或工具调用，贴返回）
- `git status` 只含本任务文件
- 独立复核（不同模型实例）确认逻辑与边界，执行者不得自审

真机验收由 John 自己做：reload 后在真实画布上看效果、拍板收不收。
