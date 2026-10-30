---
name: comfy-node-adapter
description: 转换器转不动的 ComfyUI 节点诊断与适配档案（v1）。当 UI→API 转换报「遇到不支持的构造」、提交后端返回 prompt_outputs_failed_validation / required_input_missing、卡片显示转换失败，或工作流含 SetNode / GetNode / Reroute / PrimitiveNode 等虚拟件、静音（mode=2）/旁路（mode=4）节点、widget 结构与 API 期望不符时使用：按三步取证（/object_info → 前端 JS → 真实样本）定性，落到 app-data/comfyui-hana/node-adapters 的档案（virtual / passthrough / bypass / slots），再做最小工作流验证。子图（节点 type 是 UUID）不手工展开，直接报告。
---

# 转不动的 ComfyUI 节点：诊断 + 写适配档案

面向 agent 的操作手册。每条判定都必须落到命令输出或 JSON 字段上；凭印象写的档案视为无效产出。

## 0. 先固定两个路径

```powershell
$COMFY = "D:\ComfyUI\ComfyUI"          # 后端根（源码安装默认位）
$APP   = "<本 app 根>\app"              # 源码仓 app/ 或已安装 app 目录
$WF    = "$COMFY\user\default\workflows"
```

后端根不确定时：读 `%USERPROFILE%\.hanako\app-data\comfyui-hana\install-target.json`（`path` 为 null → 用上面的默认位），再用 `Test-Path "$COMFY\custom_nodes"` 与 `Test-Path "$COMFY\user\default\workflows"` 双向确认，两个都 True 才算后端根。

## 一、什么时候用这个技能

命中任一即进入本流程：

- `convertUiToApi` 抛错，消息以「UI→API 转换遇到不支持的构造：」开头（工具 `submit` 的结果、卡片「转换失败」、中继 `/_relay/submit-file` 的 422）。
- 转换通过但提交被后端拒：`/prompt` 返回 `error.type = prompt_outputs_failed_validation`，或 `node_errors.<id>.errors[].type` 为 `required_input_missing` / `bad_linked_input` / `return_type_mismatch` / `value_not_in_list`。
- 目标工作流 `/object_info` 查不到某节点类型，或节点 `mode` 非 0。
- 错误文案里出现「旁路/穿透存在歧义映射」（同类型多入口、名字对不上）——这是引擎拒绝猜测，不是 bug。

不进入本流程：文件是 API 格式（顶层是 `{"<id>": {class_type, ...}}`）——那根本不走转换器，问题在后端或参数。

## 二、三步取证（顺序固定，三步都完成才允许写档案）

### a) 查 /object_info：这个类型到底声明了什么

```powershell
$t = [uri]::EscapeDataString("Power Lora Loader (rgthree)")
Invoke-RestMethod "http://127.0.0.1:8188/object_info/$t" | ConvertTo-Json -Depth 8
```

只看这六处，其余字段无关：

| 字段 | 用来判断 |
|---|---|
| `input.required` / `input.optional` | 声明的可枚举输入；**不在这里的槽名 = 动态槽**（类 1） |
| 每个输入的 `spec[0]` | 是 `INT/FLOAT/STRING/BOOLEAN`，还是 `["a","b"]` 数组（COMBO），还是别的字符串（**自定义 widget 类型，类 2**） |
| `spec[1].forceInput` / `spec[1].socketless` | forceInput=true 的项不占 widget 位次；socketless 是纯展示件 |
| `input.hidden` | 后端注入项（prompt / unique_id 等），转换器不填，正常 |
| `output` / `output_name` | 旁路/穿透选入口时要用（类 4：先同名、再唯一同类型，否则拒） |
| `python_module` | 直接给出包路径，如 `custom_nodes.rgthree-comfy` → `$COMFY\custom_nodes\rgthree-comfy`，第 b 步用 |

类型不存在（返回 `{}`）时，先排除「名字写错」（拿工作流里的 `type` 原样复制，别手打）与「节点未装」（`Get-ChildItem $COMFY\custom_nodes`）。

批量核对时先落盘再筛：

```powershell
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8188/object_info" -OutFile "$env:TEMP\oi.json"
node -e "const oi=require(process.env.TEMP+'/oi.json');for(const t of Object.keys(oi).filter(x=>/lora/i.test(x)))console.log(t,'|',JSON.stringify(oi[t].input),'|',oi[t].python_module)"
```

### b) 查前端 JS：它 addWidget / addInput 成什么形态

目录事实（本机实测）：

- 第三方节点前端代码在 `$COMFY\custom_nodes\<包>\web\`（新式，rgthree / KJNodes 等）或 `$COMFY\custom_nodes\<包>\js\`（旧式）。
- 核心虚拟件（Reroute / PrimitiveNode / Note）在前端包里，不在 custom_nodes：`<venv>\Lib\site-packages\comfyui_frontend_package\static\assets\*.js`。
- `$COMFY\web\extensions\` 只放宿主注入的扩展（本机只有 `pysssss`），不是第三方节点主入口。

典型 grep 方向（`rg` 已装，直接用）：

```powershell
rg -n --glob '*.js' 'Power Lora Loader|comfyClass\s*=' "$COMFY\custom_nodes\rgthree-comfy"
rg -n --glob '*.js' 'addInput\(|addWidget\(|addCustomWidget\(' "$COMFY\custom_nodes\rgthree-comfy"
rg -n --glob '*.js' '"lora_"|lora_\$'  "$COMFY\custom_nodes\rgthree-comfy"
rg -n --glob '*.py' 'INPUT_TYPES|FlexibleOptionalInputType|\*args|\*\*kwargs' "$COMFY\custom_nodes\rgthree-comfy"
```

要读出来的结论只有三条：**槽名是怎么拼的**（`"lora_" + counter` → `lora_1/lora_2`）、**是 addInput 还是 addWidget**（前者是连线槽，后者是 widget 值）、**后端 python 侧用什么收**（`FlexibleOptionalInputType` / `**kwargs` 表示服务端接受任意键，这正是动态槽合法的根据）。

参考实例（已核）：`custom_nodes\rgthree-comfy\web\comfyui\power_lora_loader.js:87` 为 `this.addCustomWidget(new PowerLoraLoaderWidget("lora_" + this.loraWidgetsCounter))`；`py\power_lora_loader.py:27` 的 `optional` 用 `FlexibleOptionalInputType(...)` —— 所以 `/object_info` 只报 `model` / `clip`，而 `lora_*` 必须照连线原样收编。

### c) 查真实样本：UI 里它实际存成什么样

```powershell
rg -l '"type": "SetNode"' "$WF" | Select-Object -First 5
node -e "const w=require(process.argv[1]);for(const n of w.nodes.filter(x=>x.type==='SetNode').slice(0,3))console.log(JSON.stringify({id:n.id,mode:n.mode,inputs:n.inputs,outputs:n.outputs,wv:n.widgets_values,named:n.widgets_values_named}))" "<上一步的路径>"
```

节点侧看六个字段：`type` / `mode` / `inputs[].{name,link,widget}` / `outputs[].links` / `widgets_values` / `widgets_values_named`。
连线侧一律以 `links` 数组为准（六元组 `[link_id, origin_id, origin_slot, target_id, target_slot, type]`），不要只信 `inputs[].link`——语料里有 `inputs[].link` 为 null 但 links 里存在指向它的记录的脏文件。

`widgets_values_named` 与 `widgets_values` 的关系：正常文件两者同源（named 有键、位置数组同序）；`widgets_values_named` 里会出现 `control_after_generate` 这类前端副键，它不在 `/object_info` 的声明里，无害。
本机语料基数（2026-10-30 实测）：`$WF` 下 2827 份，UI 格式 32 份（其余为 API 格式），API 模式跑下来 19 份可转换、13 份被拒。

## 三、分类决策树（对每个转不动的节点，按顺序问一遍）

1. 它的输入槽名（`inputs[].name`）**不在** `input.required ∪ input.optional`，但该槽 `link` 有值，且上游 id 在工作流节点表里 → **类 1 动态输入槽**。
2. 槽名在 `required/optional` 里，但 `spec[0]` 是白名单外的字符串（不是 `INT/FLOAT/STRING/BOOLEAN/COMBO`，例如 `AUTOCOMPLETE_TEXT_LORAS`）→ **类 2 自定义 widget 类型**。
3. `type` 在 `/object_info` 里查不到，且工作流 `nodes[]` 里确实存在这个 type 的实例 → **类 3 虚拟节点**。
4. 该节点 `mode === 2` 或 `mode === 4` → **类 4 静音 / 旁路**。
5. `type` 匹配 `/^[0-9a-fA-F-]{20,}$/`，且 `wf.definitions.subgraphs[]` 里有 `id === type` → **类 5 子图**。
6. 转换不报错，但进后端的 `inputs` 结构和后端期望不符（`required_input_missing`、值错位、槽名对不上 API 键名），只能靠读前端 JS 现场推断 → **类 6 widget 结构怪异**。
   语料里已出现过的一种：`widgets_values_named.clip_name ≠ widgets_values[0]`（R1 分歧，被拒），属值脏，不属结构问题。

## 四、每类怎么办

### 类 1 / 类 2 —— 已修，不写档案

转换器已按有警告模式收编（`app/lib/workflow-tools.mjs`：动态槽降级为 warning、named 分支黑名单兼容未知 widget 类型）。只做一件事：**确认 warning 点名的槽名确实无害**。

判定标准（三条全满足才算无害）：槽名在 python 侧被 `FlexibleOptionalInputType` / `**kwargs` / `*args` 接收；该槽收编后进 `inputs` 的形态是 `["<上游id>", <slot>]`（连线）而不是空值；后端没对它回 `value_not_in_list` / `custom_validation_failed`。任一不满足 → 当类 6 处理。

### 类 3 —— 写档案（virtual / passthrough）

| 虚拟件 | 实测形态 | 档案规则 |
|---|---|---|
| `Reroute` | `inputs[0].type="*"`，`outputs[0].links` 有下游 | **已有内置档案**（`app/lib/node-adapters/reroute.json`，`virtual+passthrough`），不用再写；它不在语料出现时也不用管 |
| `SetNode` + `GetNode` | `widgets_values_named.Constant` = 变量名；Set 有 `inputs[0].link`，Get 只有 `outputs[].links`、`inputs` 为空 | **当前不支持自动处理**：引擎里没有任何按 key 配对的机制。GetNode 没有 `inputs`，写 `{"virtual":true,"passthrough":true}` 也解析不到上游，结果是下游报「输入 X 的连线缺失（link N）」（实测） |
| `Label (rgthree)`、`Fast Groups Bypasser (rgthree)`、`Fast Groups Muter (rgthree)` | 不在 `/object_info`，`links` 为空（语料实测 Label 4 个实例、Fast Groups Bypasser 2 个） | `{"virtual":true}`：直接丢弃，无连线可穿透 |
| `PrimitiveNode` | 上游是它、下游是某个 widget 槽的 `link` | **v1 收编不了**：它是「把常量写进下游 widget」，不是连线穿透。停下来报告，让用户在画布右键「转换为输入」或改填原始值 |

语义硬要求：`virtual:true` = 节点不进 prompt；`passthrough:true` = 把下游引用改接到它的上游（必须配合 `virtual:true`，单写会被规则引擎告警丢弃）。直通拿不到上游（悬空、成环）时按「连线缺失」报错，不许写成悬空引用。

**SetNode / GetNode 的人工处理**（当前唯一可靠做法）：

1. 在 `nodes[]` 里按 `widgets_values_named.Constant`（没有 named 就看 `widgets_values[0]`）找到同 key 的 SetNode；
2. 取该 SetNode 的 `inputs[0].link`，在 `wf.links` 里查出 `origin_id` / `origin_slot`；
3. 把引用该 GetNode 输出的每条下游连线的 `origin_id` / `origin_slot` 改成上一步的真实源（`link_id`、`target_id`、`target_slot` 不动）；
4. SetNode 与 GetNode 都从 `nodes[]` 删掉，SetNode 的入边也一并删。

改出来的是**展开后的副本**（另存新文件），不要覆盖用户原件。不想手改就直说：这两类需要转换器版本支持按 key 配对，当前的错误呈现是下游「连线缺失」，不是档案能修好的。

### 类 4 —— 写档案（bypass）

`rules.bypass` **只接受字符串** `"skip"` | `"passthrough"`，且**只作用于 mode 4（bypass）**：

- 写对象形式（如 `{"mute":"skip","bypass":"passthrough"}`）会被引擎告警「不接受 { mute, bypass } 对象形式…已忽略」，整条规则作废，节点回到旧路径被拒（实测）。
- `mode:2`（mute）**没有单独配置项**：该类型只要有档案（`slots` 也算，不必有 `bypass`），mute 节点就恒按 skip 丢弃（mute 在 ComfyUI 里是断链）。走 `passthrough` 的档案（`virtual+passthrough` 或 `bypass:"passthrough"`）碰上 mute 时会额外 warn「mute 是断链，… 不适用，已按 skip 处理」，实际就是 skip（下游随报「连线缺失」）。
- **档案治 mute 与治 bypass 的力度不同，别当成一件事**：
  - `mode:2`（mute）：该类型**只要有档案就治**——哪怕只写了 `slots`，mute 节点也会被直接丢弃、不进 prompt，**不会报「处于静音/旁路状态」**（实测：只写 `slots` 时 mute 节点静默消失，下游随报「连线缺失」；该节点没有任何下游时整份转换照样成功）。想保留「静音一律拒绝」的行为，就别给这个类型写任何档案。
  - `mode:4`（bypass）：只有 `virtual` 或 `bypass` 字段治得住；只写 `slots` 时仍按旧行为整份拒绝（「处于静音/旁路状态」，实测）。
  - `virtual:true` 最彻底：跳过判定排在静音检查之前，该类型的节点无论 `mode` 是 0/2/4 都被直接跳过，一个静音/旁路错误都不报（实测 mode 0/2/4 三种都跳过）。需要保留「静音/旁路一律拒绝」的旧行为，就不要给它写 `virtual`。

两个值的真实差别（别以为 skip 也能跑通）：

| 值 | 节点 | 连线 | 结果 |
|---|---|---|---|
| `"skip"` | 不进 prompt | 不改写，引用它的链路作废 | 下游报「输入 X 的连线缺失（link N）」，**整份被拒** |
| `"passthrough"` | 不进 prompt | 下游改接到它的入口上游 | 通过；实测 `SkipLayerGuidanceDiTSimple` 的 `15→13→24` 收成 `24.model=["15",0]` |

判定问句：**它的输出类型里，有没有哪个出现在它自己的输入类型里？** 有 → `"passthrough"`；没有 → `"skip"`。

**入口选择规则（返工后，实测）**：以「被消费的那个输出槽」为准读 `outputs[originSlot].name/type`，在节点 `inputs[]` 里按「同名配对 → 唯一同类型入边 → 否则拒绝」选入口；只看 `inputs[]` 顺序，**与 `wf.links` 数组顺序无关**（槽上 `link` 优先，槽上没写 link 时按 `target_id/target_slot` 反查且必须唯一）。

**同类型候选多于一个且名字对不上时不做猜测**：整份拒绝，报

> 节点 #5 <Type> 的旁路/穿透存在歧义映射：输出槽 0 对应多个同类型入口（「positive」/「negative」），无法确定上游来源，已拒绝

（实测，`ControlNetApplyAdvanced` 这类双同类型入边的形态就是这样被抓到的。）拿不到入口（该节点没有连线）时也不猜，按「连线缺失」处理。

### 类 5 —— 子图，不展开、不写档案

`definitions.subgraphs[]` 每项含 `id/version/config/name/inputNode/outputNode/inputs/outputs/widgets/nodes/groups/links`；内联展开要做 id 重映射与作用域隔离，不是手工能可靠完成的。本机语料 5 份（MOSS-Image、MiniMax-H3 系列）。

固定话术，原样回给用户：

> 这是子图（节点 type 是 UUID，定义在 workflow 的 definitions.subgraphs 里），需要转换器支持内联展开，手工适配会出错。请把这份工作流作为样本反馈，或先在 ComfyUI 里把子图拆成普通节点再导出。

### 类 6 —— 写档案（slots）

`slots` 是逐槽规则，`match` 支持 `*` 通配（`image*` = 前缀匹配），数组顺序**先匹配先生效**。规则同时作用于两条路径：**有连线的槽**与**只有 widget、没有连线的槽**——后者是治「widget 结构怪异」的核心能力。

三种 action 的真实语义：

- `alias`：把值写进 `as` 指定的键名。连线槽 = 换个键名收编；**widget 槽 = 把 widget 的值注入到新键名**。`as` 只是产物里的键名，引擎**不校验**它是否出现在 `/object_info`——动态槽场景本来就要求 `as` 不在声明里（实测：`as:"switch_flag"` 未声明也照写进 `inputs`）。
  撞键：widget 槽撞上已占用的键（连线占位或另一个真 widget）会 warn「该键已被占用（连线或另一个 widget），已跳过别名注入」并**保留原值**，结果与 `object_info` 的声明顺序无关（两阶段写入，实测）。**连线槽的 alias 目前没有撞键检查**：两个连线槽 alias 到同一个键时后写覆盖先写、不告警（实测，v1 已知缺口）。
- `ignore`：该槽不收——连线不收、widget 值也不注入。用于纯前端展示 / 控制件（分组标题、计数器、UI 副键）。
- `passthrough`：**不等于「走默认路径」——具体行为取决于槽是动态槽还是已声明槽**：
  - 动态槽（槽名不在 `required ∪ optional`）：确实等于默认动态槽路径收编，只是不记那条「不对应任何声明输入」的 warning，没有额外转换能力。
  - 已声明槽（槽名在 `required/optional` 里）：走的是适配分支，比默认路径**多一道校验**——上游 id 必须真会发射进 prompt（`emittableIds`），默认的声明槽路径不查这一条。所以给一个本来能过的已声明槽加 `passthrough`，可能从放行变成拒绝（实测：上游是 `Note` 时，不加规则得到 `["1",0]`，加了 passthrough 直接报「连线 origin 1 不在工作流节点内」）。
  - 两种情况都修不了值错位，别指望它。

按现象选规则：

| 现象 | 规则 |
|---|---|
| widget 名与 API key 不同名（`toggle` → `switch`） | `{"match":"toggle","action":"alias","as":"switch"}` |
| API 里根本没有这一项（UI 副键、分组头、计数器） | `{"match":"header*","action":"ignore"}` |
| 槽名合法，只是动态子槽（`images.image_1`） | `{"match":"images.*","action":"passthrough"}` |

实测（无连线 widget 槽）：`widgets_values_named={toggle:true, whatever:"x"}` + `slots=[{toggle→alias as:switch},{whatever→ignore}]` → `inputs={"switch":true}`（`whatever` 被丢弃）。
冲突检测：同一槽命中多条规则且 action 或 `as` 不同 → 后一条记为「被遮蔽」并告警（同 action 同 `as` 不报）；`match:"*"` 兜底被前面的具体规则遮住属正常，反过来（`*` 写在前）就算冲突。别把泛规则写在前面。

## 五、档案格式与落盘位置

- 两个目录：内置 `$APP\lib\node-adapters\*.json`（随仓库分发，已内置 `reroute.json`；只有被明确要求改仓库时才写这里）；用户 / agent 新档案 `$env:USERPROFILE\.hanako\app-data\comfyui-hana\node-adapters\<文件名>.json`（agent 默认写这里）。
- 优先级：**用户档同名覆盖内置档**（同一 `nodeType` 以用户那份为准）；同目录内按文件名排序，后者覆盖前者。
- 加载链路（已接，2026-10-30 实测）：`app/lib/node-adapter-store.mjs` 扫两个目录 → 合并成 `adapters` 映射 → `convertUiToApi(wf, objectInfo, { adapters })`；`app/index.js` 与中继的 `/_relay/submit-file` 都已接上。转换器只读档案的 `nodeType` 与 `rules` 两个字段，`schema`/`title`/`source`/`verifiedAt`/`evidence` 是给人看的元信息。
- 生效时机：加载器按「目录 + 文件 mtime/size」缓存 5 秒，改完档案最多 5 秒后自动生效，**不用重启**；想立即确认就重启中继/宿主或直接看转换结果。
- 容错：目录不存在 = 无档案（静默）；JSON 坏、缺 `nodeType`、`rules` 不是对象 → 告警并跳过该文件（不报错、不影响主流程）。所以“写完没反应”先看告警，再核 `nodeType` 是否与工作流里的 `type` 逐字符一致。
- 文件名：`nodeType` 去掉括号与非法字符、空格换下划线，如 `Power_Lora_Loader_rgthree.json`。

格式 v1：

```json
{
  "schema": 1,
  "nodeType": "Power Lora Loader (rgthree)",
  "title": "一句话说明这个节点为什么需要适配",
  "source": "agent",
  "verifiedAt": "2026-10-30",
  "rules": {
    "virtual": false,
    "passthrough": false,
    "bypass": "skip",
    "slots": [
      { "match": "lora_*", "action": "passthrough" },
      { "match": "header", "action": "ignore" }
    ]
  },
  "evidence": "判定依据：object_info 里 optional 只有 model/clip；前端 JS 在 xxx.js 里 addInput lora_N；样本 workflows/xxx.json 里 widgets_values_named 有 lora_1"
}
```

字段纪律：

- `schema` 固定 1；`nodeType` 必须与工作流里 `type` 逐字符一致（含空格、括号、结尾的 `(rgthree)`）。
- `source` 固定 `"agent"`（内置档写 `"builtin"`，不代写）；`verifiedAt` 写实际验证日期 `YYYY-MM-DD`。
- `rules` 只有四种键：`virtual` / `passthrough` / `bypass` / `slots`。`bypass` **只能是字符串** `"skip"` | `"passthrough"`（写对象形式 = 整条规则被告警丢弃）。不写无关字段，不臆造新规则类型。
- `evidence` 是硬要求：必须同时给出 **/object_info 的字段事实 + 前端 JS 的文件:行 + 样本工作流的路径与字段**。三项缺一，档案作废，回去补取证。

## 六、验证闭环（写完档案必须走完）

1）构造最小工作流：只留目标节点 + 一个上游来源 + 一个下游消费，其余删掉。

```json
{ "last_node_id": 2, "last_link_id": 1,
  "nodes": [
    { "id": 1, "type": "PrimitiveStringMultiline", "pos": [0,0], "size": [200,80],
      "inputs": [], "outputs": [{"name":"STRING","type":"STRING","links":[1]}],
      "widgets_values": ["selftest"], "widgets_values_named": {"value":"selftest"}, "mode": 0 },
    { "id": 2, "type": "PreviewAny", "pos": [300,0], "size": [200,80],
      "inputs": [{"name":"source","type":"*","link":1}], "outputs": [], "mode": 0 }
  ],
  "links": [[1, 1, 0, 2, 0, "STRING"]], "groups": [], "config": {}, "extra": {}, "version": 0.4 }
```

2）转换并打印目标节点的 API 结构：

```powershell
@'
import {readFileSync} from "node:fs";
import {convertUiToApi} from "file:///<app 根>/lib/workflow-tools.mjs";
const [file,nodeId,archive]=process.argv.slice(2);
const wf=JSON.parse(readFileSync(file,"utf8"));
const adapters={};if(archive){const a=JSON.parse(readFileSync(archive,"utf8"));adapters[a.nodeType]=a.rules;}
const oi=await(await fetch("http://127.0.0.1:8188/object_info")).json();
const w=[];try{const p=convertUiToApi(wf,oi,{adapters,onWarning:x=>w.push(x)});console.log("OK nodes="+Object.keys(p).length);console.log(JSON.stringify(p[nodeId],null,1))}catch(e){console.log("FAIL "+e.message)};w.forEach(x=>console.log("warn "+x));
'@ | Set-Content "$env:TEMP\conv-check.mjs" -Encoding utf8
node "$env:TEMP\conv-check.mjs" "<最小工作流路径>" "<目标节点 id>" "<档案路径>"
```

第三参可省略（等于不带档案的对照组）；带上它就是「档案生效后」的结果。它是**手工注入**（`adapters[nodeType]=rules`），与加载器组装出来的映射等价；走真实链路的验证（app `submit` / 中继 `/_relay/submit-file`）会自动读两个目录，无需再传。带档案跑出 `warn` 多半是规则写法无效（`normalizeAdapters` 会把非法的 `virtual` / `bypass` / `slots` 转成 warning 并退回默认行为）——先修档案，别改工作流。

3）判定通过的三条（缺一条不算通过）：`inputs` 里每个键都 ∈ `required ∪ optional` 或属动态槽；连线项形态是 `["<上游 id>", <上游 slot>]` 且上游 id 是**会真正发射进 prompt** 的节点（不是被丢掉的虚拟件）；widget 值来自 `widgets_values_named`（有 named 时不该走到位置回退）。

4）必要（结果仍可疑、或节点带自定义校验）时真提交一次小图：

```powershell
@'
import {readFileSync} from "node:fs";
import {convertUiToApi} from "file:///<app 根>/lib/workflow-tools.mjs";
const [file,archive]=process.argv.slice(2);
const adapters={};if(archive){const a=JSON.parse(readFileSync(archive,"utf8"));adapters[a.nodeType]=a.rules;}
const oi=await(await fetch("http://127.0.0.1:8188/object_info")).json();
const prompt=convertUiToApi(JSON.parse(readFileSync(file,"utf8")),oi,{adapters});
const r=await fetch("http://127.0.0.1:8188/prompt",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt,client_id:"node-adapter-verify"})});
console.log(JSON.stringify({status:r.status,...(await r.json())},null,1).slice(0,1500));
'@ | Set-Content "$env:TEMP\conv-submit.mjs" -Encoding utf8
node "$env:TEMP\conv-submit.mjs" "<最小工作流路径>" "<档案路径>"
```

它同样接受（可省略的）档案参数——不接受就只是在验证「手工展开后的图能跑」，证明不了档案生效。

通过判据：`status` 200 且 `prompt_id` 有值、`node_errors` 为 `{}`。有输出节点时可再查 `Invoke-RestMethod "http://127.0.0.1:8188/history/<prompt_id>"`；纯预览类节点可能不进 history（实测为空），此时以 `/prompt` 的返回为准。
自建任务要收尾：`Invoke-RestMethod -Method Post "http://127.0.0.1:8188/queue" -ContentType "application/json" -Body '{"delete":["<prompt_id>"]}'` 删掉自己排的测试图，别把测试任务留在用户队列里。

## 七、档案写完仍转不动：还剩这几种可能

按序排查，逐条给出结论，不要重修一次档案碰运气：

1. **子图**：仍有 UUID 类型节点 → 类 5，交回用户。
2. **SetNode / GetNode**：当前引擎没有按 key 配对机制，写了 `virtual+passthrough` 也会因解析不到上游而报「连线缺失」→ 按类 3 的人工步骤展开副本，或写明「需转换器版本支持」。
3. **旁路/穿透歧义映射**：报「输出槽 N 对应多个同类型入口（「a」/「b」），无法确定上游来源」→ 引擎拒猜，档案层无解（v1 没有给入口命名的规则）；只能让用户在工作流里把同类型入口改名/改用专节点，或反馈。
4. **PrimitiveNode 常量注入**：下游 widget 槽的 `link` 指向 PrimitiveNode → v1 表达不了。
5. **R1 值分叉**：`widgets_values_named` 与 `widgets_values[0]` 不一致（如 `CLIPLoader.clip_name`）→ 是文件脏，不是适配问题；让用户在画布里重存并导出。
6. **节点没装 / 文件缺失**：`type` 在任何 `/object_info` 里都查不到 → 装对应 custom_nodes；`value_not_in_list` 指向文件名 → 补模型 / 文本文件。两者都不是适配问题。
7. **后端自定义校验**：`custom_validation_failed`，看 `node_errors.<id>.errors[0].extra_info` → 是节点自己的 `VALIDATE_INPUTS`，档案改不到，报告原文。
8. **档案未被读取 / 规则被忽略**：先看 `warn`（加载器：JSON 坏、缺 `nodeType`、`rules` 不是对象、目录读失败；引擎：`virtual` 非布尔、`passthrough` 没配 `virtual`、`bypass` 写成对象形式或取值非法、`alias` 缺 `as`、`slots` 不是数组）。都没问题又不生效时，核三件事：`nodeType` 与工作流 `type` 是否逐字符一致（含空格与 `(rgthree)`）、文件是否 `.json` 且在用户档案目录下、是否等了超过 5 秒（缓存 TTL）。仍不生效就报告「档案已落盘但未生效」，**不许说成已修好**。

## 八、边界

只写档案文件；不改 `workflow-tools.mjs`、`node-adapter-store.mjs`、不改用户工作流原件、不动 git。一次只处理一类节点；同一份工作流里出现两类以上问题时，先报清单再动手。实测与推断分开写：跑过什么命令、看到什么输出，就只写这些；没跑过的结论标「未验证」。
