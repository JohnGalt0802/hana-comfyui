# 提交前校验（validate）

> **范围**：`comfyui(action="validate", ...)` 的用法——什么时候校验、8 个错误码的含义、怎么读结果。
> **何时读**：提交前想确认工作流能跑 / 校验报错看不懂 / 用户问"这张图能不能直接提交"时。
> **前置条件**：ComfyUI 服务在线（校验对照的是该实例的 `/object_info`；服务没起先 `service start` + `wait`）。

## 用法

- `workflow` 三形态（同 submit）：本机文件路径字符串 / 工作流 JSON 对象（API 或 UI 格式）/ `{"template":"名称"}`；或 `template: "userdata 工作流名"`。二者互斥，至少给一个。
- 校验**不提交、不改图、不拦 submit**：`valid:false` 也正常返回，只是告诉你事实。是否修复、是否照提，由你（agent）判断。

## 什么时候该校验

- 用户给了来路不明的 JSON / 第三方分享的工作流，提交前先过一遍。
- 提交被后端拒（validation 类报错）后，用校验拿结构化的错误定位，比原始报错好读。
- 改动较大（补包后重跑、换 checkpoint）想先确认，不想烧一次排队。

## 8 个错误码（code）

| code | 含义 | 典型下一步 |
|---|---|---|
| `unknown_type` | 节点类型不在后端已加载清单里（多半缺包，可跑 `deps` 确认） | 装包 / 用 deps 找候选 |
| `missing_required` | 必填输入既没连线也没值 | 补值或补连线 |
| `enum_mismatch` | 枚举值不在可选项里（如 checkpoint 名不存在） | 从 suggestions 里挑合法值 |
| `type_mismatch` | 连线两端类型对不上 | 改接正确类型的端口 |
| `virtual_node` | 子图/环绕节点且无适配档案，无法提交 | 在 ComfyUI 里展开后导出 API 格式 |
| `subgraph_unexpanded` | 子图实例无法展开（不影响整体判定时可能只是警告） | 看消息里的子图名与实例定位 |
| `no_output` | 整图没有输出节点（或空图），提交必被拒 | 补 PreviewImage / SaveImage 类节点 |
| `internal` | 校验内核自身异常（不是工作流的问题） | 把消息原样上报 |

## 怎么读结果

- 正文是中文摘要（`节点 <id> · <字段>` + 消息）；`details.comfyui` 是完整结构化结果（`valid` / `errors` / `warnings` / `stats`），需要逐条处理时读它，不要让正文倒 JSON。
- `suggestions` 是该字段当前的可选项（如 object_info 里真实存在的 checkpoint 名，最多展示 8 个）——enum_mismatch 时优先从这里挑，别自己编名字。
- 警告（warnings）不算失败，但常是"动态类型输入当前为空"这类需要人工确认的点，别默默略过。

## 校验不通过时该做什么

1. 按 code 分拣：`enum_mismatch` / `missing_required` 多半能直接修（值补上、可选项替换）；`unknown_type` 先跑 `deps` 定位缺包。
2. 有把握的小修可以直接给用户改好再验再提；拿不准的（结构性问题、缺包要下载）先报原因和选项，别替用户拍板。
3. `validate` 只是事前体检，后端仍可能因运行时原因拒——校验通过不等于百分百能出图。
