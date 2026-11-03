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
| `subgraph_unexpanded` | 子图实例展不开（接口槽对应多条链接），静态校验到此为止 | 看消息里的子图名与实例定位，展开后导出 API 格式 |
| `no_output` | 整图没有输出节点（或空图），提交必被拒 | 补 PreviewImage / SaveImage 类节点 |
| `internal` | 校验内核自身异常（不是工作流的问题） | 把消息原样上报 |

## 怎么读结果

- 正文是中文摘要，**每条都带 code**：`[节点 459 · ckpt_name · enum_mismatch] 消息；可用：a / b`；整图级的写成 `[整图 · <字段或 code> · <code>]`（如 `[整图 · definitions.subgraphs · subgraph_unexpanded]`）。
- 首行按 code 分组给条数：`校验未通过（3 个错误：subgraph_unexpanded ×1、enum_mismatch ×1、virtual_node ×1）：`；只有一种 code 时保持「3 个错误」原样。
- 完整结构化结果在 `details.comfyui`（`valid` / `errors` / `warnings` / `stats`，每条含 `code` / `node` / `field` / `message`），要逐条处理时读它，不要让正文倒 JSON。
- `suggestions` 是该字段当前的可选项（如 object_info 里真实存在的 checkpoint 名，最多展示 8 个）——enum_mismatch 时优先从这里挑，别自己编名字。
- 子图展开失败（`subgraph_unexpanded`）时，它引发的连带问题会挂在根因的 `derived` 里（每条同样是 `code` / `node` / `message`），不再重复计数：顶层 `errors` 只留根因一条，别把 `derived` 里的 `virtual_node` 当成另一个独立故障去修。
- 警告（warnings）不算失败，但常是"动态类型输入当前为空"这类需要人工确认的点，别默默略过。

## 官方模板拉下来的预告

`templates` 拉回来的官方 UI 工作流，直接 `validate` 很可能报这两类**结构性问题，不是模板坏了**：

- `subgraph_unexpanded`：模板带子图，子图接口槽对应多条链接，静态展不开；
- `enum_mismatch`：模板引用了本机不存在的输入图片 / checkpoint。

出路：在 ComfyUI 里打开 → 展开子图 → 导出 API 格式再提交；或换掉输入图（先 `upload` 再改对应节点的输入）。

## 校验不通过时该做什么

**先分清硬伤与可修项**：`no_output` / `subgraph_unexpanded` / `virtual_node` 属整图结构错误，**提交必被拒**，别当成"警告一下、照提即可"——先修结构（补输出节点 / 展开子图 / 处理环绕节点）再提交。

1. 按 code 分拣：`enum_mismatch` / `missing_required` 多半能直接修（值补上、可选项替换）；`unknown_type` 先跑 `deps` 定位缺包。
2. 有把握的小修可以直接给用户改好再验再提；拿不准的（结构性问题、缺包要下载）先报原因和选项，别替用户拍板。
3. `validate` 只是事前体检，后端仍可能因运行时原因拒——校验通过不等于百分百能出图。
