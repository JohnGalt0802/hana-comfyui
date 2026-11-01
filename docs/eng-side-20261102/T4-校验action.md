# T4 · 校验 action（App 接线）

**交付物一句话**：`comfyui` 工具多一个 `action="validate"`，agent 能一句话让 hui 检查一张图能不能跑。

## 依赖

T3（`POST /_relay/validate`）。必须等它完成。

## 文件边界

- 允许改：`D:\HanakoWorks\ComfyUI\app\index.js`
- **禁区**：不得改任何现有 action 的分支与行为；不得改 `runtime\comfy-relay.mjs`、不得改 `lib\*`；不得改 `manifest.json` 的 capabilities（本 action 只访问 127.0.0.1，现有白名单够用）。
- 不得改 `ui\`。

## 临时目录

`D:\HanakoWorks\ComfyUI\_temp\t4-validate-action\`，用完删掉。

## 现状锚点（探索实测）

- 工具注册：`sdk.tools.register` 在 6948-7033，工具名 `comfyui`（6949）。
- **schema 由 `actionBranches()`（6742-6944）自动拼成 oneOf（6958-6969）。新增 action 必须同步加分支，否则 schema 里没有它。**
- 分派是 `switch`：6976-7026，default 抛错 7024-7025，统一 catch 7027-7031。
- 现有 12 个 action：`status`（6977，内联）/ `submit`（2307）/ `query`（2864）/ `result`（2961）/ `cancel`（3008）/ `workflows`（3053）/ `upload`（3082）/ `update`（3173）/ `canvas`（4356）/ `service`（5277）/ `window`（5673）/ `llmGateway`（6168）。
- 统一返回 `{ content: [{type:"text", text}], details: { comfyui: { action, ... } } }`。
- 查询型 action 不建宿主任务、不走 `next-step`（`sdk.tasks.create` 那 4 处：2456 / 2551 / 3120 / 6603 都不要动）。
- 失败有两种合法姿势：抛错被 7027 兜住，或正常返回 + `details.comfyui.blocked`（范式函数 `submitStoppedReply` 2252-2273）。

## 要做的事

### 1. schema

在 `actionBranches()` 里加一支 `validate`，参数：

- `workflow`：字符串（文件路径）或对象（工作流本体），可选
- `template`：字符串（userdata 里的工作流名），可选
- `options`：可选对象，透传

三者至少给一个，schema 里写清。

### 2. switch

加 `case "validate":`，行为：

1. 组请求体，调中继 `POST /_relay/validate`，带上 controlKey（参照现有中继调用怎么取 key）。
2. 把 `errors` / `warnings` 渲染成人能读的中文摘要：
   - 通过：`校验通过：27 个节点，30 条连线，12 个枚举值全在范围内。`
   - 不通过：一条一行，格式 `[节点 3 · ckpt_name] 值 "xxx" 不在可选项里；可用：a / b / c`。最多列 10 条，多余的写"另有 N 条"。
3. `details.comfyui` 里放完整的结构化结果，方便 agent 二次判断。

### 3. 不做的事

- 不自动修复，不自动重试，不因为校验失败就改图。
- 不建宿主任务，不投递 `next-step`。
- 不拦 `submit`。校验是独立 action，要不要先校验由 agent 自己决定（这是待拍板项 5，落地前先按"不拦"做）。

## 自检（只做这些）

```powershell
node --check D:\HanakoWorks\ComfyUI\app\index.js
```

然后在宿主里 reload 后调一次：

```
comfyui(action="validate", workflow={"template":"<你保存过的某个工作流>"})
```

把返回贴出来。再故意改坏一个模型名调一次，确认错误信息里有节点 id、字段名和可选项。

## 禁止

- 不得为了"顺手好看"改现有 action 的文案。
- 不得把校验逻辑写在 index.js 里（它在中继和 lib，一层一层调过去）。
- 不得新增设置项（本任务不需要开关）。

## 不确定就说不确定

如果 `actionBranches()` 的结构跟你以为的不一样，先 read 6742-6944 整段再动手。写不进去就报告，不要硬插入一个不符合现有形状的分支。
