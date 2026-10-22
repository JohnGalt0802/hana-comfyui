# 画布功能改造操作手册

> 场景：在 hui 画布上给某张工作流**新增一个可选功能**（开关式支路），并把它收拾干净。
> 来源：2026-10-19 的 MOSS-Image 提示词增强功能实操沉淀。所有结论都标注了实测/推断。

## 一、动手前：三件事必须确认

写类操作失败最常见的原因不是技术，而是前置条件。按顺序确认：

| 前置 | 怎么确认 | 不满足时的表现 |
|---|---|---|
| 桥可达 | `comfyui(action="canvas", op="probe")`，看 `shell.ok` 与 `ext.ok` | 所有 op 报 `timeout · 前端 6s 内未回传` |
| 目标页副驾驶开 | `op="pages"`，看目标页条目的「副驾驶」 | 写类 op 返回 `copilot_off` |
| 写授权 | 设置页「允许 agent 修改画布」 | 写类 op 被拒 |

**实测要点**：`probe` 两条腿（壳页腿 / 扩展腿）任一 `ok` 即可操作。宿主工作区页没开时两条腿都会 timeout，此时**不要反复重试**，先把页面打开。

**实测要点**：`duplicate` 出来的副本页**副驾驶默认是关的**，而原页可能开着。副驾驶状态是**逐页**的，不是全局的。副本上动手前先 `op="copilot", enabled=true`。

## 二、永远在副本上动手

```
comfyui(action="canvas", op="duplicate")        # 复制为新页，原布零改动
comfyui(action="canvas", op="copilot", enabled=true)   # 给副本开副驾驶
```

红线：不覆写用户当前正在编辑的画布。原页哪怕只有一处改动，也不要直接 `patch`。

## 三、先探结构，再设计节点

```
comfyui(action="canvas", op="state")                        # 节点清单（缓存快照，零往返）
comfyui(action="canvas", op="get", select="#4,#16", fields="title,inputs,outputs,widgets_values")
```

**槽位顺序必须查注册表，不能凭常识推断。** UI 格式里的 `inputs` 索引和节点 schema 的 `input_order` **不是一回事**：

```
Invoke-RestMethod http://127.0.0.1:8188/object_info/KSampler
# → input_order.required: model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, denoise
```

实测：KSampler 在 UI 格式的 `inputs` 数组里 `positive` 是**索引 1**（因为 seed/steps/cfg/sampler/scheduler 是 widget 不出现在 inputs 里），但 schema 的 `input_order` 里排第 7。**patch 的 `toSlot` 用名字最稳**，用索引时要对着 `get` 的实际数组来数。

**接线前先 `dryRun`**：

```
comfyui(action="canvas", op="patch", edits=[...], verify=true, dryRun=true)
```

`dryRun` 会给每条编辑打分并报类型兼容性。实测它把 `STRING → BOOLEAN` 的误连提前拦了下来——那次是我按索引推槽位推错了，`on_true` 的位置其实是 2 不是 1。

## 四、开关式功能的标准结构

需求形态：「不打开就走原路，打开就走新路，其他一切不变」。

**推荐接线（CONDITIONING 层切换）**：

```
原分支 ─────────────────────────────→ Switch.on_false ┐
                                                        ├→ Switch → 下游节点
新分支（可含生成节点）→ 新 CLIPTextEncode → Switch.on_true ┘
```

优点：**原提示词节点一个字节都不动**，直出分支和改动前完全等价；新增失败也只是多一个未接的分支，不影响原功能。

**踩过的坑（实测）**：一开始在 STRING 层切换，把原 `#4 CLIPTextEncode` 的 text 输入断开改接 Switch，并且把原文搬进了新节点。结果是——开关默认关闭时走的是新节点的空值，**原提示词实际上被掏空了**，用户看到的就是一张空图。CONDITIONING 层切换没有这个问题。

**为什么不推荐 STRING 层**：会逼你动原节点的输入，一旦搬运出错就是静默失效；而且无法保留原节点的内容作为默认值。

### 用宿主模型做提示词扩写

官方模板（`image_moss_image_t2i.json`）用的是 `TextGenerate` 节点 + 同一次加载的 CLIP：

```
你的想法(PrimitiveStringMultiline) ──prompt────────┐
                                                  ├→ TextGenerate → CLIPTextEncode → Switch.on_true
扩写系统指令(PrimitiveStringMultiline) ─system_prompt┘         ↑
                                                   同一个 CLIP 编码器
```

实测要点：

- `TextGenerate` 复用 `#1` 已经加载的 CLIP，**不额外占显存**。
- `system_prompt` 是 `force_input=True` 的输入，终端节点连不上，必须再接一个 `PrimitiveStringMultiline` 喂文字。
- 扩写会真实执行（多一次 9B 前向），**不是零成本**，文案里不要暗示免费。
- 官方模板里那段 system prompt 建议**原文照搬**，自己改写容易让输出偏离模型训练时的 caption 风格。

## 五、两个必须知道的提交层限制

### 1. 子图无法提交

实测：`submit` 一个含子图（subgraph）的工作流会直接失败：

```
UI→API 转换遇到不支持的构造：节点 #18 类型 <uuid>（子图/环绕节点）。
请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。
```

官方模板 `image_moss_image_t2i.json` 就是子图结构。要参考它，**把子图展开成平铺节点**再搬。

### 2. 动态组合框（DynamicCombo）转换会丢子参数

实测：`TextGenerate.sampling_mode` 是 `COMFY_DYNAMICCOMBO_V3`。走 UI→API 转换后提交，后端报：

```
node "26": required_input_missing: sampling_mode.temperature / top_p / min_p / repetition_penalty / seed
```

UI 的扁平 `widgets_values` 没有正确落成 APIP 的嵌套 dict，转换链在这一层断了。

**绕过办法**：用画布原生执行（`op="queue"`），前端自己生成 prompt，不经过 host 的转换层。

```
comfyui(action="canvas", op="save")    # 先落盘
comfyui(action="canvas", op="queue")   # 画布原生执行
```

实测这条路能正常跑通。如果必须走 `submit` 且带动态组合框，只能自己构造 API 格式 prompt。

## 六、超时与异常的正确处理

**实测事故**：一次 `patch`（3 条 removeNode）RPC 报 `timed out after 30000ms`。当时的处理是对的——**没有直接重试**，而是先查状态。

```
comfyui(action="canvas", op="state")     # 快照仍显示旧结构
comfyui(action="canvas", op="revision")  # 报 timeout → 说明前端当时已卡
```

后果：残留了 3 个节点（`#25 #26 #27`），连线回了原位。**undo 只还原连线，不还原节点增删**，所以残留要单独 `removeNode` 清掉。

纪律：

1. 超时**不等于**失败，也不等于成功。
2. 先 `state` / `revision` 对账，再决定重试还是清理。
3. 宁可换一条更确定的路（改文件 + `openWorkflow` 装载），也不要在卡住的前端上反复施加写操作。

**更稳的替代路径**：在磁盘上构造好完整工作流 JSON，然后

```
comfyui(action="canvas", op="openWorkflow", path="workflows/xxx.json")
```

实测返回「已打开并装载（16 节点）；落定校验通过」，比在卡住的页面上打补丁可靠得多。构造文件时必须做完三件事：分配 `id` 避开现有节点、维护 `links` 双向引用（源节点 `outputs[].links` 与目标节点 `inputs[].link` 都要写）、更新 `last_node_id` 与 `last_link_id`。

## 七、归置与布局

### 分组

```
comfyui(action="canvas", op="addGroup", nodeIds=[25,26,29,27,28])
comfyui(action="canvas", op="setGroup", groupId=<id>, title="② 提示词增强")
```

按**功能区**分组，不是把所有新节点堆一堆。同一功能涉及的输入、处理、开关归在一框里，主采样链保持原样。

### 手工落位（addNode / moveNode）的五条硬约束

插件排不了、或只需挪几个节点时才会手工摆位置。2026-10-23 两次实测事故：按 `get` 的 `size` 算坐标，七个节点排完互相压住、组框标题被盖、开关跑出框。必须照下面做：

1. **组框标题留 ≥ 40 画布单位。** `setGroup(nodeIds=[…])` 自动算的框只外扩 20px，标题条约 30px 高 → 节点贴上去就压标题。要显式 `setGroup(index=…, bounds=[x, y, w, h])`，让 `y ≤ min(节点 y) − 40`。
2. **`size` 不可信。** 节点会被 widget 撑高、被长中文标题撑宽：实测 `MOSSLLMAutoLoad` 报 270×178 实际 390×300、`PromptExpand` 报 400×286 实际 371×432、`ShowText` 报 428×647 实际 444×681、`ComfySwitchNode` 报 270×78 被标题撑到 430 宽。
3. **顺序：先移完所有节点 → 最后一次 `setGroup(bounds)` → 不再 move。** 前端会在节点移动后重算组框（包围盒 + 20），会覆盖你刚设的 bounds。
4. **出框判据：** 每个节点 `x ≥ 框.x+20`、`x+实宽 ≤ 框.x+框.w−20`、`y ≥ 框.y+40`、`y+实高 ≤ 框.y+框.h−20`，四条全过。
5. **必须目视闭环。** `check` 不查重叠/出框/压标题。改完开工作区原生窗（`window op=open`）或截图看一眼，按画面调一轮再交。

另：备份文件不要放 `workflows/`（`.json.bak-xxx` 会变成工作流列表条目，还会把当前页身份改过去导致 `save` 写错文件）；交付前看 `save` 回执里的 `saved` 字段确认落点。

### 自动排布

```
comfyui(action="canvas", op="commands")   # 先确认 node-organizer 命令存在
comfyui(action="canvas", op="organize")   # 默认走智能命令
```

**不要主动重排**（尊重用户手调的布局）。用户明确要求优化布局时才调用。

## 八、验收清单

改动完成后逐条过：

- [ ] `op="get"` 核对每条新连线（看 `inputs[].link` 真的有值）
- [ ] 全量悬空校验：所有 `link` 引用都能在 `links` 表里找到
- [ ] **开关关闭**跑一次，确认与改动前效果一致（这是最容易漏的一条）
- [ ] **开关打开**跑一次，确认新分支生效
- [ ] 记录两次的实际耗时差，把成本说给用户
- [ ] 目视/截图确认：节点互不重叠、不压组框标题（组框顶到最近节点 ≥30px）、不越出组框
- [ ] `op="save"` 落盘，确认 `dirty` 清零

## 九、提交历史 diff（historyDiff）

> 2026-10-20 实施。回答「这两个提交之间到底改了什么」。

### 为什么需要它

`source=file` 的 `diff` 比的是**两个磁盘文件**，而真正想看的常是**两个历史提交**：
「上次跑得好好的，这次为什么崩了」。历史库（`bridge/history_store.py`）本就有
`list_commits` / `read_snapshot`，语义 diff 本就有 `diffGraph`（`lib/canvas-diff.mjs`），
缺的只是接出口。

### 调用

```
comfyui(action="canvas", op="historyDiff",
        workflowName="<工作流名>", workflowId="<uuid>",   # 见下方陷阱
        base="HEAD~1", next="HEAD")
```

- `base` / `next` 支持四种引用：`seq` 数字、`HEAD`、`HEAD~n`、`promptId`
- 缺省都是 `HEAD`
- 免闸门（纯读），**不要求画布在线**，也不要求副驾驶开着
- 只比语义：节点 title/type/mode/widgets_values、连线（按目标槽配对）、分组

### 陷阱：历史按 uuid 建目录，名字查不到

实测：`history-list?workflow=<中文名>` 返回 `entries: 0`。历史目录是
`workflows/.history/<uuid>/`，用名字查必须同时传 `workflowId`。

```
# 正确
comfyui(action="canvas", op="historyDiff",
        workflowName="moss-image-SFT版-增强-量化",
        workflowId="96dd27ac-51f8-46fa-b9aa-ed5d6b8df48c",
        base=1150, next=1178)
```

### 输出里的布局噪音

`diffGraph` **刻意忽略 pos/size**（源码注释：「位置/尺寸等布局字段不参与 diff（布局噪音）」）。
这是对的——布局差异交给排布 skill，diff 只看语义。但目前没有开关能让布局差异出现；
真要比较布局，用 `source=file` 加两个快照文件路径。

### 实测样本

比对某工作流 seq 1150 → 1178（42 节点 / 57 连线）：

```
clean: false
summary: 节点 +0/-0/改3；连线 +0/-0/直替0；组 +0/-0/改0；rev 0
```

命中的是 `#6 PrimitiveStringMultiline "Prompt"` 的 `widgets_values` 变化，
`from` / `to` 都完整给出来了。

### 改这里的生效方式（实测）

| 改什么 | reload 够不够 |
|---|---|
| `index.js` 里的 **函数实现** | 够（`defineApp` 工厂会重跑） |
| `index.js` 里的 **工具 schema**（op 枚举 / fields） | **不够，要重启宿主** |

实测：reload 返回成功、`node --check` 通过，但调用新 op 报
`Validation failed ... must not have additional properties`——宿主缓存的工具定义没有随 reload 刷新。

## 十、这次沉淀的坑位速查

| 坑 | 症状 | 正解 |
|---|---|---|
| 副驾驶逐页独立 | 副本写操作被拒 | 给副本单独 `copilot enabled=true` |
| UI 索引 ≠ schema 顺序 | 连到错误槽 | 用 `toSlot` 传名字，或对照 `get` 数组 |
| STRING 层加开关 | 默认走空值，原提示词失效 | 改在 CONDITIONING 层切 |
| undo 不还原节点增删 | 残留幽灵节点 | 单独 `removeNode` 清理 |
| 子图工作流 | `submit` 直接失败 | 展开成平铺节点 |
| 动态组合框 | `required_input_missing` | 走 `canvas queue`，别走 `submit` |
| RPC 超时 | 不知成没成 | 先 `state`/`revision` 对账，再决定重试 |
| 前端卡死 | 所有 op timeout | 改文件 + `openWorkflow`，别硬打补丁 |
