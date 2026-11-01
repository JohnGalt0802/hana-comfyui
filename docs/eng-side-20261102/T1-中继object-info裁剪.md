# T1 · 中继 object-info 裁剪与缓存

**交付物一句话**：中继新增一个路由，把 4.13 MiB 的 `/object_info` 裁成校验够用的精简结构并缓存，供 App 侧随时取。

**为什么必须走中继**：宿主给 App 的网络响应体上限默认 5 MiB（APPS.md 1898 行），而 `/object_info` 已经 4.13 MiB，用户再装两个节点包就超。中继走 node:http，不受这条限制。

## 依赖

无（T2/T5/T8 三个内核都靠它取数据）。建议在 T0 之后、与 T2/T5/T8 之前完成。

## 文件边界

- 允许改：`D:\HanakoWorks\ComfyUI\app\runtime\comfy-relay.mjs`（唯一一个文件）。
- 允许新增：无（本任务不新增文件）。
- **禁区**：不得改 `handleSubmitFile`、`resolveTemplateContent`、`fetchBackendJson`、`proxyHttp` 的任何现有行为；不得改任何已存在的路由分支；不得动 `index.js`。

## 临时目录

`D:\HanakoWorks\ComfyUI\_temp\t1-objectinfo\`，用完删掉。

## 现状锚点（探索实测，若不符先报告）

- 服务入口：`http.createServer` 回调在 4171 行；`llmIsBridgeRoute` 分流 4176。
- 路由写法：`pathOnly === "/_relay/xxx"` 的 if 链。已存在的 `/_relay/userdata` 在 4226。
- 插入位置：handler 函数插在 `handleSubmitFile`（约 3853 行结束）之后、`llmJobView`（3854）之前；路由分支插在 userdata 块之后、drives 块（4271）之前。
- 可复用工具：
  - `jsonOut(res, status, obj, method)` 3326
  - `readBodyJson(req, limit)` 3576
  - `fetchBackendJson(path, timeoutMs)` 3695，返回 `{ok, data}` 形态，后端不可达时按 502 `{ok:false,error:"backend_unreachable",detail}` 处理
  - `controlOk(req)` 3567，校验头 `x-comfy-relay-key`；未配 controlKey 时放行
  - `writeFileAtomic`（import 在 74 行，用例 3635）
  - `resolveWorkflowsDir()` 758（判断安装目录用，可参考其探测逻辑拿到 `custom_nodes` 路径）

## 要做的事

### 1. 裁剪

从 `/object_info` 原始响应里，**每个节点类只保留三样**：

- `required`：输入名 → 类型（类型是数组的 COMBO 取 `options`，单独放 `enums`）
- `optional`：同上
- `outputs`：输出类型数组（可选，用于连线类型校验）

丢掉描述、`tooltip`、`default`、`min/max`、`control_after_generate` 等一切校验用不上的字段。目标是压到 1 MiB 以内。

产出的结构自己定，但必须满足：

```jsonc
{
  "schema": 1,
  "builtAt": "<iso>",
  "source": { "host": "127.0.0.1", "port": 8188, "comfyuiVersion": "0.43.0" },
  "nodeCount": 2549,
  "digest": "<对裁剪结果算的短 hash，用于 App 侧判断要不要重拉>",
  "classes": {
    "<ClassName>": {
      "required": { "<inputName>": "<TYPE>" },
      "optional": { "<inputName>": "<TYPE>" },
      "enums": { "<inputName>": ["<option>", "..."] },
      "outputs": ["<TYPE>"]
    }
  }
}
```

注意两点：

- COMBO 在 `/object_info` 里是 `[[选项...], {...}]` 形态，也可能是 `["COMBO", {options: [...]}]`，两种都要认。**先 read 实际样本确认，不要凭记忆写。**
- 同一节点的 input 可能同时出现在 required 和 optional，不要合并丢信息。

### 2. 缓存

- 内存缓存一份，落盘一份（放在中继自己的目录下，参考 `writeFileAtomic` 已有用例的路径风格）。
- 失效判据：`custom_nodes` 目录 mtime 变了就重建；否则 TTL 24 小时。
- 同时保留一个轻量入口：`GET /_relay/object-info?digest=1` 只回 `{digest, nodeCount, builtAt}`，让 App 侧用极小代价判断要不要重拉全量。

### 3. 路由

新增，默认 GET，用 `jsonOut` 返回：

- `GET /_relay/object-info` → 全量裁剪版
- `GET /_relay/object-info?digest=1` → 摘要

后端不可达时按现有约定返回 502 + `backend_unreachable`，不要静默返回空结构。

**鉴权**：只读路由，参照现有只读路由的做法（不强制 `controlOk`）。但要确认现有只读路由到底有没有鉴权，以实际代码为准，不符就先报告。

## 自检（只做这些，不做验收）

```powershell
node --check D:\HanakoWorks\ComfyUI\app\runtime\comfy-relay.mjs
```

然后起中继，用 curl 调两次，贴返回：

```powershell
# 全量：记录字节数，必须显著小于 4330939
# 摘要：必须只回 digest/nodeCount/builtAt
```

报告三个数字：原始字节数、裁剪后字节数、裁剪后节点类数。**这三个数字是你唯一需要证明的东西。**

## 禁止

- 不得顺手优化现有 `/object_info` 调用点（那是另一个任务的事）。
- 不得把裁剪结果写进 `sdk/` 或任何被同步排除的目录。
- 不得引入第三方依赖。

## 不确定就说不确定

如果发现 COMBO 的实际形态与上面写的两种都不一致，停在报告里，不要自己发明兼容层。
