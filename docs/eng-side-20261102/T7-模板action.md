# T7 · 模板 action（App 接线）

**交付物一句话**：`comfyui` 工具多一个 `action="templates"`，能检索官方模板库、能把某个模板拉到本地。

## 依赖

T6（两个中继路由）。必须等它完成。

## 文件边界

- 允许改：`D:\HanakoWorks\ComfyUI\app\index.js`
- **禁区**：不得改现有 action；不得改中继与 lib；**不得改 `manifest.json`**（外网请求发生在中继进程里，不经过宿主网络白名单，所以本任务不需要扩 allowedHosts）。
- 不得改 `ui\`。

## 临时目录

`D:\HanakoWorks\ComfyUI\_temp\t7-templates-action\`，用完删掉。

## 现状锚点（探索实测）

- `sdk.tools.register` 6948-7033，工具名 `comfyui` 6949。
- schema 由 `actionBranches()`（6742-6944）拼 oneOf（6958-6969），新增 action 必须加分支。
- switch 6976-7026，default 抛错 7024-7025，统一 catch 7027-7031。
- 统一返回 `{ content:[{type:"text",text}], details:{comfyui:{...}} }`。
- 查询型不建宿主任务。**注意**：`fetch`（拉模板落盘）算写操作，但它不产生出图任务，也不该走 `next-step`。

## 要做的事

一个 action，两个子操作，用 `op` 区分（跟 `canvas` 的风格一致）。

### op = "list"

参数：`q` / `task` / `model` / `mediaType` / `tag` / `limit` / `offset`

输出给人看时压成一行一条：

```
image_qwen_image_2_1_t2i  Qwen Image 2.1：文生图  [image] ●推荐  可跑
image_minimax_h3_t2v      MiniMax H3：文生视频    [video] ○需 0.43.2
```

标记约定：`●` 表示 highly_recommended，`○` 表示版本不满足并附所需版本。中文标题优先，没有中文回落英文并加 `*`。

### op = "fetch"

参数：`name`（必填）、`target`（`hub` 或 `tmp`，默认 `hub`）

返回里要说清四件事：落在哪个文件、多大、需要哪些模型、缺哪几个。给人看的摘要形如：

```
已拉取 image_qwen_image_2_1_t2i → workflows/_hub/image_qwen_image_2_1_t2i.json（96 KB）
需要 3 个模型：diffusion_models/qwen_image_2.1_int8.safetensors ✓、text_encoders/qwen_2.5_vl_7b.safetensors ✗、vae/qwen_image_vae.safetensors ✓
缺 1 个，可跑性：节点齐但缺权重
```

### 不做的事

- 不自动下载模型。
- 不自动打开拉下来的模板（那是 `canvas.openWorkflow` 的事，交给 agent 决定）。
- 不因为缺模型就拒绝落盘。

## 自检（只做这些）

```powershell
node --check D:\HanakoWorks\ComfyUI\app\index.js
```

reload 后调：

```
comfyui(action="templates", op="list", q="qwen")
comfyui(action="templates", op="fetch", name="<上一步某条>")
```

贴两次返回。第二次之后用 `canvas(op="state")` 确认工作流列表里能看到 `_hub/` 下的那个文件（如果 target=hub）。

## 禁止

- 不得把中继的整份 JSON 直接倒给用户看。
- 不得新增设置项。
- 不得改 `manifest.json`（见禁区）。

## 不确定就说不确定

如果 `_hub/` 子目录在 ComfyUI 的工作流列表里显示异常（比如被当成一个工作流），立刻报告，不要自己换目录。
