# T10 · 缺包 action（App 接线）

**交付物一句话**：`comfyui` 工具多一个 `action="deps"`，agent 能问"这张图缺哪些节点包"。

## 依赖

T9（中继路由）。必须等它完成。

## 文件边界

- 允许改：`D:\HanakoWorks\ComfyUI\app\index.js`
- **禁区**：不得改现有 action；不得改中继与 lib；不得改 `manifest.json`；不得改 `ui\`。

## 临时目录

`D:\HanakoWorks\ComfyUI\_temp\t10-deps-action\`，用完删掉。

## 现状锚点（探索实测）

- `sdk.tools.register` 6948-7033；schema 由 `actionBranches()`（6742-6944）拼 oneOf；switch 6976-7026。
- 统一返回 `{content:[text], details:{comfyui:{...}}}`。
- 查询型，不建宿主任务。

## 要做的事

`action="deps"`，参数：

- `workflow`：路径 / `{template:"名字"}` / 对象，三选一
- `classes`：字符串数组，直接给类名（与 `workflow` 二选一）
- 两者都不给时，默认取**当前画布**（走 canvas 的 `get`，再算出类名集合）。这条是可选项，做不了就如实报"需要给 workflow 或 classes"。

### 输出摘要

先给一句总结：

```
3 个类不认识：2 个属于没装的包，1 个查不到来源。
```

再分三块，每块最多 5 条：

```
【没装】
  ComfyUI-Impact-Pack（owner/ComfyUI-Impact-Pack）  缺 2 个类：ImpactSAMLoader, ImpactDetailer

【装了但没加载】
  custom_nodes/rgthree-comfy  缺 1 个类：RgthreePowerLora  → 多半是依赖没装或启动失败，看启动日志

【查不到来源】
  MyCustomNode  → 映射表里没有，可能手写节点或类名拼错
```

多候选时明确写"这类名对应多个包"，把候选都列出来，不要选一个。

## 自检（只做这些）

```powershell
node --check D:\HanakoWorks\ComfyUI\app\index.js
```

reload 后调两次：

```
comfyui(action="deps", classes=["SomeFakeNode","KSampler"])
comfyui(action="deps", workflow={"template":"<某个装过第三方节点的图>"})
```

贴返回摘要。

## 禁止

- 不得自动安装、自动重启。
- 不得把中继的完整 JSON 倒给用户。
- 不得新增设置项。

## 不确定就说不确定

"默认取当前画布"那条如果实现成本高（要跨到 canvas 的桥），直接不做，在报告里写清，让 agent 显式传 workflow。
