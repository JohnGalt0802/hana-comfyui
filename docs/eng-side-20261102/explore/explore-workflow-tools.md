# workflow-tools.mjs 公开契约报告

来源：`C:\Users\John Galt\.hanako\apps\comfyui-hana\lib\workflow-tools.mjs`（共 1210 行）
只读探索，未修改任何文件。行号以当前文件为准。

---

## 一、公开 API 签名与返回

### 导出清单（全文件共 7 个 export）
| 导出 | 行号 | 说明 |
|---|---|---|
| `isPlainObject(v)` | 5 | 工具函数 |
| `NOTE_TYPES` | 10 | `Set(["Note", "MarkdownNote"])` |
| `UNSUPPORTED_UI_TYPES` | 11 | 见第三节 |
| `expandSubgraphs(wf, problems, objectInfo, warnings)` | 365 | 子图展开 v1 |
| `convertUiToApi(wf, objectInfo, options)` | 680 | UI→API 转换主体 |
| `applyInputs(prompt, inputs)` | 1177 | 注入 `{"<node_id>.<input>": value}` |
| `summarizeWorkflow(parsed)` | 1197 | 自动识别 ui/api/unknown 格式 |

### `convertUiToApi(wf, objectInfo, options)` — 行 680

**wf**：UI 格式工作流，要求 `wf.nodes` 为数组（缺了直接 throw，行 695）；`wf.links` 为 `[linkId, originId, originSlot, targetId, targetSlot, type]` 六元组数组（行 698-703）；可选 `wf.definitions.subgraphs`（触发子图展开）。转换**不修改入参 wf**：主循环里 `widgets_values` 做了拷贝（行 1103 `[...n.widgets_values]`），子图展开对定义节点做深拷贝后再写（`cloneInner`，行 383-395）。

**objectInfo**：ComfyUI `/object_info` 响应**原样**传入（`objectInfo[type]` → `{ input: { required, optional } }`），不做裁剪。消费方证据：`runtime/comfy-relay.mjs:3769-3771` —— `const oi = await fetchBackendJson("/object_info", 12_000); ... convertUiToApi(parsed, oi.data, { adapters: ... })`。缺失后果：类型不在 objectInfo 的节点报 problem「不在 /object_info」（行 828）；`declaredWidgetSlots` 无 info 时位置回退拿不到任何位置（行 298 注释「可缺」）。

**options**（行 681-686，全部可选）：
- `strict: boolean`（默认 false）— true 时 warnings 并入 errors 参与判定
- `onWarning: (msg: string) => void` — 每条 warning 调一次；回调自身异常被吞（行 1160-1162）
- `adapters: { [nodeType]: { virtual?, passthrough?, bypass?, slots?, pull? } }` — 声明式适配规则，undefined/空时整段逻辑不介入，行为与无 adapters 一致；非法规则不抛错，转 warning 后忽略
- `problemsOut: array` — 传入时把**阻断列表**按顺序推入（strict 下是 problems+warnings 合并列表）；**注意：problemsOut 不携带非 strict 下的 warnings**，warnings 只能经 `onWarning` 单独拿

### 返回值形状（行 1170-1176）
成功时返回 **prompt 对象本身**，不是 `{prompt, problems}`：
```js
{ [nodeId]: { class_type, inputs, _meta?: { title } } }
```
失败表达：**throw 一个 Error**，message = `UI→API 转换遇到不支持的构造：<前 6 条 problem>...请在 ComfyUI 里...`；当传了 `adapters` 时，message 末尾追加 `summarizeProblems` 分类汇总段（行 1167）。结构化取证只能靠 `options.problemsOut`（阻断项）+ `onWarning`（非阻断项）两个旁路通道。

---

## 二、problems / warnings 结构 + code 全表

**容器：纯字符串数组。** 没有任何 `{ code, message }` 结构、没有机器码字段。所有条目是中文人读文案，靠 `problems.push("...")` / `warnings.push("...")` 累积（行 687-688）。

- **problems**（行内注释「即 errors」）：任何一条非空即整份拒绝（throw）。
- **warnings**：仅记录不拒绝（动态槽收编、静音/旁路归因、适配规则降级、子图幽灵键等）。

**最接近"code 枚举"的东西：`summarizeProblems` 的 7 个分类**（行 224-260，未导出，纯函数）。它用正则对文案做归类，不是数据里带的 code：

| 分类键 | 匹配方式（正则，行 228-237） |
|---|---|
| `unknown_type` | `/不在 \/object_info/`，类型名从文案二次正则提取 |
| `value_mismatch` | `/位置值分歧\|widgets_values_named 与 widgets_values\|疑似过期 named/` |
| `mute_bypass` | `/处于静音\|处于旁路\|处于未知 mode/` |
| `missing_link` | `/连线缺失\|不在工作流节点内/` |
| `subgraph` | `/子图格式\|实例\|接口链接\|-10\|-20\|无法展开\|子图/` 或 20+ 位 uuid |
| `pull` | `/按名字\|pull/` |
| `other` | 兜底 |

**给校验函数沿用的"词表"就是这 7 个分类键**，但要明确：它们是正则对中文文案的事后归类，`summarizeProblems` 自己也注明「只拼文案，不参与任何判定」。若校验要机器可读的 code，现有代码没有，需要新建（这属于新能力，本报告只陈述现状）。

另有一组文案级判据可复用：R1 分歧固定含「分歧/疑似过期 named」（行 865-869、1155-1158）；未知 mode 固定含「处于未知 mode」（行 819）；死链固定含「连线缺失」（行 937 等）。

---

## 三、虚拟节点处理策略

**`UNSUPPORTED_UI_TYPES` 完整集合（行 11，共 6 项）：**
```
Reroute, PrimitiveNode, Subgraph, GroupNode, SubgraphInputNode, SubgraphOutputNode
```

**遇到时的行为，按优先级：**

1. **`Subgraph` 类型实例**：若 `wf.definitions.subgraphs` 里有对应定义，`expandSubgraphs`（行 365）在主循环之前先把实例展开为普通节点（id 重映射 `s<实例id>:<内部id>`）；不支持嵌套子图（行 437-441 拒绝）、实例被静音/旁路直接拒绝（行 402）。展开不出来的进 problems。
2. **有适配档案（adapters）的类型**：主循环先查 `droppedIds`（行 815-817），`virtual: true` 的节点在 UNSUPPORTED 检查**之前**就被移除——即 `Reroute` 等配上 `{ virtual: true }` 档案可以走 adapters 旁路而不报错。`lib/node-adapters/` 目录内置 17 份档案（GetNode、SetNode、easy_getNode/easy_setNode、reroute、rgthree 系列等），中继侧经 `loadNodeAdapters` 加载（relay 行 70-73，用户目录同名覆盖内置）。
3. **无档案命中 UNSUPPORTED_UI_TYPES，或类型形如 20+ 位 uuid**（行 820-823）：推 problem「节点 #id 类型 X（子图/环绕节点）」→ 最终整份拒绝。
4. **Note / MarkdownNote**（NOTE_TYPES）：主循环直接跳过，不进 prompt 也不报错（行 814）。
5. **静音 mode 2 / 旁路 mode 4**（2026-10-31 起）：不再整份拒绝。mode 2 断链（下游连线作废），mode 4 按类型穿透到同类型输入（歧义即拒绝）；有档案时按档案 `bypass: "skip" | "passthrough"` 处置。未知 mode 值仍拒绝（行 819）。

---

## 四、缺失能力（值域检查等）

**没有输入值域检查。** 全文 grep `includes(`/COMBO/枚举/值域 确认：

- COMBO 选项是否包含当前值：**无**。`Array.isArray(spec[0])` 只用来判定「这是 COMBO」（行 322、1107），之后仅用于 widget 位序归类，从不拿 `spec[0].includes(value)` 做成员检查。
- INT/FLOAT 的 min/max：**无**。
- named 值与声明类型的匹配：**无**（named 分支跳过 `NON_WIDGET_INPUT_TYPES` 后直接注入，未知类型默认按 widget 注入，测试「回归：named 分支跳过 socket 类型」固化了这一行为）。

**现有的唯一"值检查"是 R1 交叉校验**（行 849-861，2026-10-08 引入）：对 `NAMED_WV_CHECK` 白名单里的 8 个类型（行 48-57：PrimitiveStringMultiline、PrimitiveBoolean、PrimitiveInt、PrimitiveFloat、ComfySwitchNode、LoadImage、LoadImageOutput、CLIPLoader），当 `widgets_values_named` 与 `widgets_values` 双写都存在时，核对 named 主键 == `wv[0]`（JSON 深比较），分歧 → problems。这是**自洽性检查（named vs 位置值）**，不是**与 objectInfo 的值域检查**。子图阶段有同精神的检查（行 568-573，含 1e-9 数值容差的 `subgraphValueEq`）。

即：一个值不在 COMBO 选项里、一个 seed 超出范围，现在都能静默通过转换并提交给后端。这是"提交前校验"最明确的增量空间。

---

## 五、测试约定

- Runner：**`node:test`** 内置测试器（`import test from "node:test"` + `node:assert/strict`），无第三方依赖。
- 运行方式（文件头注释，行 2）：`node --test app/lib/workflow-tools.test.mjs`（**未实际执行**，按你要求只读头部）。
- 用例数：**27 个 `test()` 块**（grep `^test\(` 全量匹配）。分六组：必拒 6、必放行 4、strict 与 options 容错 3、origin 存在性 3、回归 3、汇总段 8。其中一个用例内含 mode 2/4 双分支 for 循环，实际断言路径多于 27。
- 测试只 import 了 `convertUiToApi`（行 5），其余导出（expandSubgraphs、applyInputs 等）没有本文件的直接测试 [不确定：可能在 node-adapter.test.mjs 或 relay 测试里覆盖]。

---

## 六、校验函数的最小暴露面建议

**方案 A（推荐，零新增导出）**：把 `validateWorkflow(wf, objectInfo, opts)` 写进 workflow-tools.mjs 本文件，实现为对现有私有链路的组合调用：

```js
export function validateWorkflow(wf, objectInfo, opts = {}) {
  const problems = [], warnings = [];
  try {
    convertUiToApi(wf, objectInfo, {
      strict: false,
      adapters: opts.adapters,
      onWarning: (w) => warnings.push(w),
      problemsOut: problems,   // 阻断项全量外带，不需捕获 throw 的文案
    });
  } catch { /* throw 已被 problemsOut 覆盖，吞掉即可 */ }
  return { ok: problems.length === 0, problems, warnings };
}
```

依据：`convertUiToApi` 本身就是纯函数（模块注释明示「不读盘、不做 IO」），`problemsOut` + `onWarning` 两个通道已经把结构化的 problems/warnings 全量带出，throw 的文案反而可以不要。这样校验与转换**必然同源**，天然满足"不能另写一套"。缺点：value 域检查等新能力仍要另写。

**若校验要做转换器之外的独立检查（如 COMBO 值域），当前需要导出的私有件（按必要性排序）：**

| 私有件 | 行号 | 用途 |
|---|---|---|
| `declaredWidgetSlots(info, node)` | 298 | widget 名→位置定位，值域检查按名取值的唯一正确口径（禁止另写槽序近似，注释明令「防两套口径漂移」） |
| `WIDGET_SPEC_TYPES` | 14 | 判定哪些声明类型算 widget（COMBO 值域检查的类型判据） |
| `NON_WIDGET_INPUT_TYPES` | 17-21 | 排除 socket 类输入，避免对连线值做值域检查 |
| `NAMED_WV_CHECK` | 48 | 若要把 R1 白名单外的类型纳入检查，需知道现有边界 |
| `summarizeProblems(list)` | 224 | 若校验报告也要分类汇总（注意它是文案正则归类） |

`normalizeAdapters` / `matchSlotRule` / `expandSubgraphs` 内部件**不必导出**：adapters 规范化随 `convertUiToApi` 自动完成，`expandSubgraphs` 已导出（行 365）且会被 `convertUiToApi` 内部调用（行 692），校验侧无需重复调。若校验想在转换前单独跑子图结构检查（不依赖 objectInfo），可直接用已导出的 `expandSubgraphs(wf, problems, objectInfo, warnings)`。

**关键约束（复用时不能违背）**：`convertUiToApi` 的 problems/warnings 是无 code 的中文字符串数组；任何"提交前校验"的对外接口若想给机器可读 code，只能新增映射层（比如复用 `summarizeProblems` 的 7 分类正则，或在新校验里产码），不能从现有返回值里读到。

---

## 七、不确定项

1. `applyInputs`（行 1177）与 `summarizeWorkflow`（行 1197）只读了源码，未追踪全部调用方；契约按源码陈述。
2. `workflow-tools.test.mjs` 运行命令来自文件头注释，未实际执行验证；`node --test` 的相对路径 `app/lib/...` 前缀与文件实际位置（`<app>/lib/`）的关系未验证（可能需在 app 目录下执行）。
3. expandSubgraphs / adapters 链路是否在 `node-adapter.test.mjs` 等其他测试文件有覆盖：未检查（超出本次文件边界）。
4. `lib/node-adapters/` 17 份 JSON 档案的内部 schema 未逐一读取（行为契约从 workflow-tools.mjs 的 `normalizeAdapters` 注释与代码得出，行 79-190）。
5. 行号基于当前文件快照；`convertUiToApi` 内部各行号（如 815、819、828）来自分段读取的偏移推算，与主锚点行（365/680/1177/1197）交叉一致，但个别内部行号可能有 ±2 行误差。
