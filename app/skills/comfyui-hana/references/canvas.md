# 画布读写（canvas ops）

> **范围**：`comfyui(action="canvas", ...)` 的全部读/写操作——操作人正在看的同一张画布（快照 / 投影 / 体检 / 追踪 / 大纲 / patch 事务 / 排布 / 直接加载）。
> **何时读**：要看/改用户眼前那张画布时；排布画布前；画布写操作前后对账时。
> **前置条件**：读/写走「中继 → 桥（前端扩展 hana_bridge）」到 ComfyUI 前端，**需 ComfyUI 页面在线**；**写入类 op 默认关闸**，需先在设置页开「允许 agent 修改画布」；多页面时用 `workflow` 参数定向（只发给正打开该工作流名的页面；不传则广播）。

链路参考：App → 中继 `/_relay/bridge` → ComfyUI `/api/hana_bridge/call` → 前端扩展。

## 读 ops（读的正是人眼前那张图）

不传 `op` 时默认 `state`。

| op | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `state` | 最近一次画布快照（服务端缓存、零往返；**默认**） | — | 节点/连线摘要 + rev |
| `pages` | 在线页面清单（各自打开的工作流） | — | sid / 工作流名 / 活跃秒数 / 是否脏 |
| `summary` | 画布结构摘要（现抓） | — | nodeCount / linkCount / 节点清单 |
| `get` | 全量 UI 格式 JSON；或投影裁剪（见下） | `select` / `fields` | JSON |
| `check` | 体检：悬空 / 输出未接 / mute·bypass（见下） | — | issues 列表 |
| `trace` | 追踪：某端口的直接来源（up）/ 去向（down）（见下） | `nodeId`、`slot`、`dir` | 来源/去向 + summary |
| `outline` | 大纲：功能块 + 块间连线（见下） | — | blocks / blockEdges / issues |
| `prompt` | 可提交形态（现抓 prompt 对象） | — | 节点数（已就绪） |
| `running` | 当前执行到哪个节点 | — | runningNodeId |
| `revision` | 画布变更序号（只问变没变，轻量） | — | revision / 计数 / 规模 |
| `events` | 画布变更记录（最近若干条） | — | rev / 时间 / 增删节点连线 |

工具 / 自检：

| op | 用途 |
|---|---|
| `probe` | 桥自检（关键 API 存在性；返回 JSON） |
| `commands` | 列前端已注册命令 id（排布插件自检；总计约 109 条） |
| `commandShape` | 探前端命令表形状（自检） |
| `frameReload` | 强制重载工作区内的 ComfyUI iframe（扩展换文件后用） |

## 写 ops（需授权；agent 的改动可用 op=undo 撤）

| op | 用途 | 关键参数 |
|---|---|---|
| `setWidget` | 改一个节点参数 | `nodeId`、`name`、`value` |
| `addNode` | 新建节点入图 | `type`、`pos?`、`title?` |
| `removeNode` | 删除节点（同时移除入线） | `nodeId` |
| `connect` | 连线 | `fromNode`、`fromSlot`、`toNode`、`toSlot` |
| `disconnect` | 断开一条输入连线 | `nodeId`、`slot` |
| `setNodeMode` | mute / bypass / 恢复正常 | `nodeId`、`mode`（0=正常 / 2=mute / 4=bypass） |
| `save` | 把当前图落盘为工作流文件（自动先写同名 `.bak.json`） | `name?`（省略用当前工作流名） |
| `undo` | 撤销 agent 上一步 | — |
| `patch` | 意图级写：多编辑一次提交（见下） | `edits`、`verify`、`dryRun` |
| `loadWorkflowFile` | 按文件路径直接加载工作流（绕过前端列表；异步，画布稍后刷新） | `file`（相对 `user/default/`，如 `workflows/xxx.json`） |
| `openWorkflow` | 打开/切到已保存工作流并推前台（不改图内容） | `name` 或 `path` |
| `organize` | 调前端扩展已注册命令（默认 node-organizer 自动排布） | `command?`（命令名） |
| `queue` | 画布发起执行（等效点 Queue；快返） | `front?` |
| `duplicate` | 复制画布为新页（原布零改动） | — |
| `visual` | 编辑可视化：lock / highlight / clear | `action`、`nodes?`、`edges?`、`note?` |

`loadWorkflowFile` / `openWorkflow` 自带未保存保护（dirty 时返回 `blocked:"dirty"`，`force:true` 可强切）。

## 用法与示例

### get（投影裁剪：别直接拉全量）

大图全量 `get` 动辄几万字符（曾实测 53,617 字符 / 27 节点）。先选子图、再砍字段：

```
comfyui(action="canvas", op="get", select="#8,#27,#28", fields="inputs,widgets_values")
```

- `select`：`#8` / `#8,#27`（逗号并集）/ `type=PrimitiveInt` / `title~尺寸`
- `fields`：`title,type,mode,inputs,outputs,widgets_values,pos,size`（逗号分隔；`id` 始终保留）
- 写操作后的对账核验也用 `get`（如 connect 后看 `input.link` 是否真连上）

### check（体检）

```
comfyui(action="canvas", op="check")
```

- 检查项：`DANGLING`（悬空：无任何连线）/ `OUTPUT_UNWIRED`（Save*/Preview* 输出未接）/ `MUTED_BYPASSED`（mute/bypass，info）
- 互斥口径：每节点最多一条 issue（`DANGLING` > `OUTPUT_UNWIRED` > `MUTED_BYPASSED`）；Note 类节点整体跳过
- 返回示例：`{"issues":[{"level":"warn","code":"DANGLING","node":7,"title":"Output size","msg":"悬空：无任何连线"}]}`

### trace（追踪来源 / 去向）

```
comfyui(action="canvas", op="trace", nodeId=8, slot="width")         # 向上游（默认）
comfyui(action="canvas", op="trace", nodeId=25, slot=0, dir="down")  # 向下游
```

- `slot`：名字优先，不中回退数字索引；`dir`：`up`（默认）/ `down`
- summary 示例：`#8.width ← #27（PrimitiveInt「宽度」，value=1248）`
- 找不到节点/槽/连线不报错：返回 `resolved:"none"` + note（含可用槽名提示）

### outline（大纲）

```
comfyui(action="canvas", op="outline")
```

- 块识别两级：① 画布自带 groups（组框）优先；② 角色兜底（Loader→加载 / TextEncode→文本 / Sampler→采样 / Save·Preview→输出 / 其余→其他）
- 返回：`blocks`（块内节点按 id 升序）、`blockEdges`（跨块连线）、`issues`（复用 check）
- 典型输出：27 节点的大图压成几块一屏读完（块名示意：`尺寸{…} 文本{…} 采样{…} 加载{…}`）

### patch（意图级写：多编辑一次提交）

```
comfyui(action="canvas", op="patch", edits=[
  {"disconnect":{"nodeId":8,"slot":"width"}},
  {"addNode":{"type":"PrimitiveInt","title":"宽度","as":"w"}},
  {"setWidget":{"nodeId":"$w","name":"value","value":1248}},
  {"connect":{"fromNode":"$w","fromSlot":"INT","toNode":8,"toSlot":"width"}},
  {"save":{}}
], verify=true, dryRun=false)
```

- `edits`：顺序执行、**原子回滚**（任一步失败逆序还原）；每条恰一个 key，可用 `addNode / setWidget / connect / disconnect / setNodeMode / removeNode / save`（`save` 仅限最后一条；`undo / loadWorkflowFile / openWorkflow / organize` 明确拒绝）
- `as` / `$`：`as` 给新建节点起名（仅 addNode，重名拒绝）；`$` 只在 `nodeId / fromNode / toNode` 里解析（同批引用新建节点）
- `verify`（默认 true）：每条执行后即时核验；`dryRun:true` 只做预检（槽存在性 / 类型兼容），零图变更
- 一次 patch = 一步撤销（压一条复合逆操作）；同页并发 patch 直接拒绝；前端等待默认 6s，超时（504）≠ 未生效——重试前先对账 `revision`

### organize / commands（排布：node-organizer 插件）

排画布一律用已装的 `comfyui-node-organizer` 前端扩展，**不要自己算坐标**（用户 2026-09-27 叮嘱：「每次排画布，记得摸一下自动排画布的插件」）：

- **先摸**：`op="commands"` —— 命令表里应能看到 `node-organizer.organize` / `.organize-workflow` / `.organize-groups`（总计约 109 条命令）
- **再排**：`op="organize"` —— 默认走智能命令（选中了组就只排选中的组，没选就排全图）；`command` 参数可指定其它命令名
- 纪律：**不要主动重排**（尊重用户手调的布局）；插件不可用时才退备用（插件自带纯函数库 `lib/core.js` 可算坐标）

底层通道：桥 op `canvas.organize` / `canvas.commands` / `canvas.commandShape`（前端扩展执行 `app.extensionManager.command.execute(id)`；实测入口名是 `execute`，不是 `executeCommand`）。

## 写操作纪律

- 写入类 op 默认关闸：设置页「允许 agent 修改画布」打开才能写；页面不在线写不了。
- agent 的改动用 `op=undo` 撤（新版前端的 Ctrl+Z 撤不掉外部改动）。
- 改动后拉 `get` 核对（connect 看 `input.link`、setWidget 看值），别只看桥回执。
- 大动作先说话、小动作直接做（尺度详见 `copilot.md`）。

## 画布执行与视觉标记（D1 · 2026-10-03 实机验收）

三条均为写类 op（需授权、页面在线）。

### queue（画布发起执行）

```
comfyui(action="canvas", op="queue")               # 跑当前画布（等效点 Queue）
comfyui(action="canvas", op="queue", front=true)   # 插队首（等效 Queue Prompt Front）
```

- **快返**：只提交、不等执行（实测 95ms）；执行进度以画布原生 UI 为准。
- 返回 `{queued, promptId?, number?, via}`（`via` 恒为 `app.queuePrompt`）：promptId 优先经猴补捕获；捕获不到时用 /queue 前后差集反查（仅取唯一新增项，不猜）；仍拿不到就**如实返回不带 `promptId`**（≠ 未提交）。
- **空图**（无输出节点）：提交会被服务端校验拒绝（`prompt_no_outputs`："Prompt has no outputs"），op 如实报"提交被拒：…"——不静默假成功。
- **画布忙**：op 层不拦——有任务执行中也可照常入队（等效再点一次 Queue）；前端处理循环忙时立即返回、项已入队（由在跑的循环消化），promptId 可能缺失（差集兜底）。（`submit` 流程层的"画布忙不抢占"是另一层纪律，见 `submit.md`）

### duplicate（复制画布）

```
comfyui(action="canvas", op="duplicate")   # 以当前画布复制为新页（实测 195ms / 10 节点图）
```

- 把当前活动工作流（含未保存改动）复制为**新临时页**：命名 = 原名去 `.json` / 去尾部 `(N)` 后加 `" (Copy).json"`；返回 `{ok, page, key}`（如 `page="workflows/Unsaved Workflow (Copy).json"`）。
- **原布零改动**（实测全节点 id 对账不变）；副本是临时页，刷新即清理、无落盘影响。
- 用途：agent 生图默认在副本上工作（copilot 关时）；红线 = 不覆写用户当前画布。

### visual（编辑可视化：lock / highlight / clear）

```
comfyui(action="canvas", op="visual", action="lock", note="…")
comfyui(action="canvas", op="visual", action="highlight", nodes=["8","27"], edges=[["27","8"]])
comfyui(action="canvas", op="visual", action="clear")
```

- `lock`（实测 56ms）：撤旧高亮 → 画布罩**灰膜**（含「小花正在操作…」+ 可选 `note` 副提示行）＋ `read_only` 置位；膜吃指针事件、阻断误操作（键盘不拦，已知边界）。
- `highlight`（实测 18ms）：**先撤锁与旧高亮** → 节点金色描边（`strokeStyles['hana.copilot']`：#FFD700 / 宽 3 / padding 8）＋连线金标（色覆盖、宽 ≥3）→ 重绘。返回 `{ok, nodes, edges, missedNodes, missedEdges}`——定位不到的节点 / 边如实记入 `missedNodes` / `missedEdges`。
- `clear`（实测 5ms）：全撤（膜 / 只还原本桥改过的 read_only / 全部标记）→ 重绘。
- app 侧写类 op（patch / organize / commands）自动做 lock → 操作 → highlight 包裹（异常 clear；`dryRun` 除外），**包裹不分 copilot 开关**。
