# 结构普查 · 7 · 历史 UI 渲染与开框入口（Hana-ComfyUI 桥前端）

- 主对象：`app/bridge/js/hana-bridge-15021810.js`（6392 行）
- 普查日期：2026-10-15（只读，未改源码；只落本文件）
- 成色说明贯穿全文：**【事实】** = 代码读到（函数名 + 行号 + 关键语句）；**【推断】** = 基于事实推演、未在本次逐行走查验证。
- 硬约束来源：`docs/代码结构地图.md` §3；`docs/_结构普查-2-桥前端.md` §8。

> ⚠️ 行号基准：旧普查（`_结构普查-2-桥前端.md`）基于旧文件名 `hana-bridge-10131713.js`（5213 行），本文件据**当前活动桥** `hana-bridge-15021810.js`（6392 行）重新核对，**行号较旧普查整体 +约 1100**，凡旧普查标注的行号均已按现文件重定位。

---

## 0. 总览：渲染结构与开框入口的关系

历史 UI 有两套视图，共用同一套「外框 + 内条」母题与同一套回跳链：

| 视图 | 容器 / 触发 | 渲染主体 | 关键函数 |
|---|---|---|---|
| **横轴弹层（bar）** | `historyOnCanvasMouseDown` 命中 group → `historyBarOpen(group)` | `historyBarLoad` → `historyBarTickMake` | L4416 / L4299 / L3994 |
| **底部提交树（tree）** | `historyTreeEnsure` 常驻挂载 | `historyTreeRenderTree` → `node`（内联构造） | L4854 / L5575 / L5665 起 |

两套视图都调用 `historyBarsBuild`（内条堆，L3966）与 `historyTickChangedNames`（气泡名，L3893）；框视角过滤只作用在 **bar**（`historyBarLoad` 内，L4331 起），**tree 不过滤**（扫全量 entries）。

【事实】两视图的「外框」都由各自视图自己画（线型=操作 / 色=谁），「内条堆」共用 `historyNodeStyleEnsure`（L3950）注入的 `.hnode-bars` / `.hnode-bar` 公共类。

---

## 1. 刻度（tick）渲染

### 1.1 构造点
【事实】`hhb-tick` 元素在 **`historyBarTickMake(reqId, ent, ctx)`** 构造，定义于 **L3994**，调用点在 `historyBarLoad` 渲染循环 **L4617**（`const tick = historyBarTickMake(reqId, ent, ctx)`）。

### 1.2 DOM 结构与样式类
【事实】L3994–4047 构造一枚 `<button class="hhb-tick">`，结构如下：

```
<button.hhb-tick  [data-src][data-kind][data-tight?][data-legacy?]  style(--hhb-c,--hhb-tw,--hhb-tw-bulge)>
  ├─ <div.hnode-bars>                  // 内条堆（historyBarsBuild，L4004→L3966）
  │     └─ <i.hnode-bar>[.hnode-bar-on]   // 每全局框一根
  ├─ <span.hhb-runs>                   // 仅合并提交(×N)且 colW>=10（L4017-4022）
  └─ (无独立文字子节点；序号/时间显示在轴下 .hhb-times，非 tick 内)
```

- **样式类**（CSS 在 `historyBarStyleEnsure`，L3048 注入的模板串）：
  - 基础 `.hhb-tick`：**L3206**（`display:flex; flex-direction:column; border:2px solid var(--hhb-c); …`；外框色 `--hhb-c`、线型 `borderStyle` 内联）。
  - `.hhb-tick[data-tight]`：**L3216**（密档降级，padding/border-radius 收紧）。
  - `.hhb-tick:hover`：**L3217**（加亮 + 光晕）。
  - `.hhb-tick-bulge`：**L3222**（合并提交加粗 + 边框 2.5px + 更亮光晕）。
  - `.hhb-tick .hhb-runs`：**L3223**（×N 徽标，默认隐藏、`hover` 才显示，见 L3229）。
  - `.hhb-tick-sel`：**L3230**（选中环 `box-shadow:0 0 0 2px var(--hhb-sel-ring)`）。
  - `.hhb-tick[data-legacy]`：**L3231** + `::after` **L3232**（旧数据：淡化 opacity .55 + 右上小点）。
- **语义来源**：
  - 外框色 `--hhb-c` = `historyTickColor(src)`（L4003，agent→暖紫 `#b189e0` / 否则冷蓝 `#5aa0d8`，定义在 L3923）。
  - 外框线型 `borderStyle` = `historyTickBorderStyle(kind)`（L4004，save→dashed / 其余 solid，定义在 L3929）。
  - 字号/序号不在 tick 内，轴下时间由 `historyBarLoad` 末尾 `times` 段写（L4642–4650）。

### 1.3 候选插入点（加小符号/角标）
【事实·候选】
- **A. 在 `historyBarTickMake` 内、内条堆之后追加徽标**：紧邻合并徽标区块 **L4017-4022** 之后。理由：同处已演示 `document.createElement("span")` + `badge.className` + `tick.appendChild(badge)` 的模式，直接仿写即可，且 tick 已是 `<button>` 容器、CSS 变量/`data-*` 现成。
- **B. 在 `historyBarsBuild` 内、每根 `i.hnode-bar` 上挂角标**：L3966–3989 循环里。理由：若符号需「逐框对应」（每根内条一个角标）而非「整 tick 一个角标」，此处更贴切；但会改变内条语义，需同步 `historyNodeStyleEnsure`（L3959 `.hnode-bar` 规则）。
- **C. 纯 CSS 角标**：走 `.hhb-tick::after`（旧数据已用 `::after`，L3232），在 `historyBarStyleEnsure` 模板串加新规则（注意**只能 `/* */` 注释**，硬约束 §3-2）。
- 【推断】首选 A：侵入最小、与 `×N` 徽标同构，不改内条语义、不碰 CSS 类名体系。

---

## 2. 树节点渲染（底部提交树）

### 2.1 构造点
【事实】提交树节点**无独立工厂函数**，在 `historyTreeRenderTree(entries)` 渲染循环内**内联构造**，定义于 **L5575**，节点 `node` 构造块在 **L5648-5719**。
- 容器挂载：`historyTreeEnsure()`（L4854，setup L5405 调）。
- 渲染：`historyTreeRenderTree`（L5575）；泳道算法 `commitGraphLanes`（L4663，内联版，须与 `app/lib/commit-graph-lanes.mjs` 同步）。

### 2.2 DOM 结构
【事实】L5665 起构造一枚 `<button class="node">`（注意：class 是 `node`，**不是** `hhb-tick`；树与 bar 是两套视觉类）：

```
<button.node  [data-src][data-legacy?][class htr-tick-bulge? htr-tick-head?][data-tight?]
              style(--htr-c,--nw,--nw-bulge,--htr-hot-w,--htr-hot-h, left, top)>
  ├─ <div.hnode-bars>                  // 与 bar 共用同一内条堆（L5701 → historyBarsBuild）
  └─ <span.htr-runs>                   // 仅合并且 colW>=10（L5703-5707）
```

- 外框色 `--htr-c` = `historyTickColor(ent.source)`（L5693）；线型 = `historyTickBorderStyle(ent.kind)`（L5694）。
- HEAD 金点：`htr-tick-head`（L5692，当 `head.seq === nd.seq`）。
- 合并加粗：`htr-tick-bulge`（L5669）；旧数据淡化 `data-legacy`（L5666）。
- 位置：`left/top` 由 `xOf(seq)` + `row` 计算（L5695-5699），绝对定位在 `.lanes` 层。
- 事件：`mouseenter→historyTreeBubbleShow`（L5711）、`mouseleave→historyTreeBubbleHide`（L5712）、`click→historyTreeNodeClick`（L5713，消歧+回跳链）。

### 2.3 候选插入点（树节点加符号）
【事实·候选】
- **A. 节点内联构造块 L5665-5713 内**，仿 bar 的 `×N` 徽标（L5703-5707 已是现成范式）。理由：同视图、同母题、模式一致。
- **B. 走 CSS `.node::after`**：在 `historyTreeStyleEnsure`（L4514 起模板串）加规则，**只能 `/* */`**。
- 【推断】若符号仅 bar 需要 → 见 §1.3；若树也要 → 两处都加（bar 用 `.hhb-tick`、树用 `.node`），无共享工厂，需各写各的。

---

## 3. 内条（hnode-bars）渲染

### 3.1 样式注入
【事实】`historyNodeStyleEnsure()`（**L3950**）幂等注入 `<style id="hana-history-node-style">`，规则在 **L3959-3964**：
- `.hnode-bars`（L3959）：`display:flex; flex-direction:column; gap:1.5px; …`（竖排内条堆）。
- `.hnode-bar`（L3960）：`display:block; flex:1 1 0; min-height:2px; border-radius:2px; background:var(--hnode-dim)`（未碰框=中性灰）。
- `.hnode-bar.hnode-bar-on`（L3963）：`background:var(--hnode-bc, #5aa0d8); filter:brightness(1.08)`（碰过的框=框真色）。
- 中性灰 `var(--hnode-dim)` 明暗双主题（L3956-3957：`rgba(0,0,0,.22)` / dark `rgba(255,255,255,.16)`）。
- **调用点**：`historyBarTickMake` 内 **L3318** 处 `historyNodeStyleEnsure()`（bar 渲染前确保母题已注入）；tree 渲染也依赖同一 `id` 样式（L3950 已注入即共用）。

### 3.2 内条生成函数
【事实】`historyBarsBuild(barNames, hitSet, colorMap, singleBar)`（**L3966**）生成 `<div class="hnode-bars">` 及其 `<i class="hnode-bar">` 子节点：
- **L3971** `bars.className = "hnode-bars"`。
- **L3972-3989** 循环：每 `nm` 造一根 `i.hnode-bar`；`singleBar` 真 → 退化单根（有效提交亮、旧数据灰，L3978-3981）；否则 `hitSet.has(nm)` 命中 → 加 `hnode-bar-on` + 设 `--hnode-bc` 为该框色（L3984-3987）。
- **调用点**：
  - bar：`historyBarTickMake` **L4004** `historyBarsBuild(ctx.allBlocks, hitSet, ctx.colorMap, ctx.singleBar)`。
  - tree：`historyTreeRenderTree` **L5701** `historyBarsBuild(globalBlocks, hitSet, liveColors, singleBar)`。

### 3.3 候选插入点（内条相关改动）
【事实·候选】
- 改内条**外观/数量语义**：`historyBarsBuild`（L3966）循环体 **L3972-3989** + 配套 CSS `historyNodeStyleEnsure`（L3950，只能 `/* */`）。
- 改「碰过=亮」取色源：`historyLiveBlockColors()`（L3942，返回 `name→color` Map，已含空图/无框退化空 Map）。
- 【推断】新增「角色块角标」若想挂在内条上 → 在 L3972-3989 每根 `i` 后 append，并扩 `.hnode-bar` CSS（受 §3-2 注释约束）。

---

## 4. 悬停气泡（hover bubble）

### 4.1 内容来源函数
【事实】`historyTickChangedNames(ent)`（**L3893**）产出「变更节点名」数组，是气泡正文与轴下名的共同来源：
- delta 存在且 `d.changed` 非空 → 取 `changed[].title`（L3903-3905）。
- 否则退化 `d.added`/`d.removed` 的 title（L3906-3910）；都空 → 返回 `["无节点变更"]`（L3911）。
- delta 缺失 → 退化到 `ent.blocks[].title`（L3914-3918），再空 → ` "#"+seq`（L3920-3921）。

### 4.2 调用点 + 进入 DOM
【事实】bar 侧：
- **构造**：`historyBarBubbleShow(tick, ent)`（**L4024**）在 tick 的 `mouseenter` 上绑定（L4022 `tick.addEventListener("mouseenter", () => historyBarBubbleShow(tick, ent))`）。
- **内容落 DOM**：L4034-4050 构造 `<div class="hhb-bubble">`：
  - `.hhb-bub-time`（L4037-4040）：`#seq · 时间`。
  - `.hhb-bub-names`（L4041-4043）：`names.textContent = historyTickChangedNames(ent).join("、")`（**L4073**，直接调用 §4.1）。
  - `.hhb-bub-legacy`（L4076-4081）：仅 `historyTickIsLegacy(ent)` 时加「历史旧数据」小字。
  - 定位：L4083-4114 算缩放 k、钉在 tick 上方（放不下落下方），`b.style.visibility="visible"`（L4114）。
- **移除**：`historyBarBubbleHide()`（**L4110**），`mouseleave` 绑定（L4022 同行 `mouseleave → historyBarBubbleHide`），`querySelector(".hhb-bubble")` 删除。
- tree 侧同构：`historyTreeBubbleShow(node, ent)`（调用点在 L5711）+ `historyTreeBubbleHide`（L5712），复用同一 `historyTickChangedNames`。

### 4.3 候选插入点（气泡加信息）
【事实·候选】在 `historyBarBubbleShow` 正文构造区 **L4034-4081** 内追加行（同 `.hhb-bub-legacy` 写法）；气泡 CSS 在 `historyBarStyleEnsure`（`.hhb-bubble` 系列，L3239 起，只能 `/* */`）。

---

## 5. 框视角过滤（blockNames 比对）

### 5.1 旧数据判据
【事实】`historyTickIsLegacy(ent)`（**L3563**）：
```js
return !(ent && Array.isArray(ent.blockNames));
```
即 `blockNames` 不是数组（null / 缺失 / 异常）→ 旧数据，不过滤、只标注。

### 5.2 当前框名取用
【事实】`historyBlockNameOf(group)`（**L3573**）：**只吃 group 对象**，返回该 group 在「graphBlocks 块名口径」下的名字（供过滤比对）；无 group → `return null`（L3577）。
- 读活图 `app.graph._groups` + `graph.toJSON()`（L3580-3586）；group 不在活图 → `null`（L3590）；组数/标题对不上 → `null`（L3594-3601，防序列化错位）。
- 归属：节点 `pos` 落在 group `bounding` 内（含边界）、落多组取第一个（L3603-3618）。
- 命名：只对「有归属节点」的组命名，按组序进池去重 `组{i+1}`/`base#k`（L3620-3644）；角色块名在 group 名之后才进池（L3571 注释：group 名不受角色名影响）。
- 返回 `null` 的三处（L3577/L3590/L3594）→ 调用方退化为「不过滤」。

### 5.3 过滤渲染判据（完整读）
【事实】过滤只在 `historyBarLoad`（**L4299**）内，由 `curBlock` 驱动：
- **L4331** `const curBlock = historyBlockNameOf(historyBarGroup);` —— 注意吃的是**弹层持有的 group**（`historyBarGroup`，L4428 由 `historyBarOpen(group)` 写入），不是逐个 ent。
- **L4332-4334**：`historyBarGroup` 存在但 `curBlock` 取不到 → `console.warn`（退化不过滤）。
- **L4336-4350** 过滤主逻辑：
```js
const shown = curBlock
  ? entries.filter((ent) => {
      const bn = ent && ent.blockNames;
      if (bn === null || bn === undefined) return true; // 旧数据：不参与筛选，保留
      if (!Array.isArray(bn)) return true;              // 异常字段：保留
      return bn.includes(curBlock);                     // 关键：ent.blockNames 含当前框名 → 保留
    })
  : entries;                                            // curBlock 为 null → 全量
```
- 只影响渲染（L4352-4356 注释）：不改 `entries`、不改 `historyBarLatestEntry`（比对基线）、不改选中态。
- 空结果文案区分「这个块没有提交记录」vs「这个工作流还没有提交记录」（L4376-4380）。
- **tree 不过滤**：`historyTreeRenderTree`（L5575）直接吃全量 `entries`，无 `curBlock` 比对（已逐行走查 L5575-5719 确认）。

### 5.4 候选插入点（改过滤判据）
【事实·候选】过滤唯一入口 `historyBarLoad` L4331-4350：改 `curBlock` 来源（§8 讨论）或 `bn.includes(curBlock)` 比对式。若要「按角色块过滤」，需在此处把 `curBlock` 换成角色块名，并改 `ent.blockNames` 比对键（当前 ent 存的是 group 框名，见 §8）。

---

## 6. 开框入口命中链 `historyOnCanvasMouseDown`

### 6.1 安装与去重
【事实】函数 `historyOnCanvasMouseDown(e)` 定义于 **L4535**；由 `installHistoryGroupClick`（L4620）→ `installHistoryGroupProto`（L4637 包 `LGraphCanvas.prototype.processMouseDown`）+ `installHistoryGroupCanvasBind`（L4675 实例/元素 capture 监听）安装；同一事件多入口经 `historyGroupHookSeenEvents`（WeakSet，L3031）去重（L4538-4539）。
- 只读透传：包裹内 `try { historyOnCanvasMouseDown(e) } catch { warn }` 后再 `orig.apply`，不改原生行为（L4645-4658 注释与实现）。

### 6.2 完整命中链（按代码顺序）
1. **L4536-4539** 守卫：`e` 空 / 已见事件 → 返回；`e.button !== 0`（非左键）→ 返回（L4540-4541）。
2. **L4542-4548** 取画布：`canvas = app.canvas`；`off = canvas.convertEventToCanvasOffset(e)`（**L4545**，反算画布坐标；异常吞掉置 null）。
3. **主命中路径（L4550-4572）**：`getOnPos` = `graph.getGroupOnPos`（graph 优先，L4561-4562）/ 否则 `canvas.getGroupOnPos`（L4563-4564，兼容未来版本）/ 否则 null；`group = getOnPos(off[0], off[1]) || null`（L4569）。注释 L4553-4557 标注真机为 `graph.getGroupOnPos`（**不在 canvas 上**），官方口径「倒序遍历 + isPointInside，重叠取最后添加框」。
4. **兜底倒序遍历（L4574-4601）**：当 `!group && off && canvas.graph._groups` 时，倒序 `for (i = groups.length-1; i>=0; i--)`（L4577）：先 `g.isPointInside(off[0],off[1])`（L4585），否则 `historyGroupRect(g)` 矩形命中（L4590-4597）；命中即 `group=g; break`（L4598-4600）。注释 L4574-4575 强调正序会错（与官方口径相反）。
5. **无 group 分支（L4603-4606）**：`if (!group) { if (historyBarEl) historyBarClose(); return; }` —— **点空白/未命中任何框 → 收起已开弹层后直接返回，不再开框**。
6. **同框再点=关（L4608-4612）**：`if (historyBarEl && historyBarGroup === group) { historyBarClose(); return; }`。
7. **开框（L4614）**：`historyBarOpen(group)`（锚定由 `historyBarOpen` 内部算框顶，L4614 注释）。

### 6.3 关键结论
【事实】`historyOnCanvasMouseDown` **严格依赖 group 命中**才开框；「无 group」只有两条出路：① 收起已有弹层（L4604）② 同框关（L4609）。**没有「无框→按节点所属角色块开框」的任何分支**（任务第 8 条目标即新增此分支）。

---

## 7. `historyBarOpen(group)` 内部

### 7.1 函数与主体
【事实】`historyBarOpen(group)` 定义于 **L4416**，注释 L4412-4415 标注「参数由 anchor 点改为 group 本体；锚定框矩形顶部上方」。
- **L4417** `historyBarStyleEnsure()`（确保样式表，含 `.hhb-tick`/`.hhb-bubble`/确认框 CSS，见 §1.2/§4.2）。
- **L4418** `historyTickStateClear()`；**L4419** `historyRollbackStateReset()`；**L4420-4421** 清 `historyBarSelection`/`historyBarLatestEntry`。
- **L4423-4425** 先拆旧弹层（若存在）。
- **L4427** 建 `bar` 设 `bar.id = HISTORY_BAR_ID`（L4426）。
- **L4428** `historyBarGroup = group || null;` —— **group 对象本身被存为模块级状态**（L3038 声明），供 §5.3 `historyBlockNameOf(historyBarGroup)` 与 `historyBarReopen`（L5166）复用。

### 7.2 锚定逻辑
【事实】
- **L4515-4516** 起 `historyBarFollowStart()` 启动 rAF 跟随循环；真正定位在 `historyBarFollowApply`（L3501）读 `app.canvas.ds.scale/offset`，锚点由 `historyGroupTopScreen(historyBarGroup)`（**L3414**，取框顶中心屏幕坐标）经 `historyBarClampLeft` 钳制后写 `style.left/top` + `transform: scale(k)`。
- `historyGroupTopScreen`（L3414-3444）：`historyGroupRect(group)`（L3371）取框几何 → `convertOffsetToCanvas` 反算屏幕（缺则手写同式逆变换兜底，L3428-3437）→ `+ el.getBoundingClientRect()`。

### 7.3 group 为 null 会怎样 / 有无「无框」分支
【事实】
- **group 为 null**：`historyBarOpen(null)` 仍可开（函数不要求 group 非 null）；L4428 `historyBarGroup = null`。
  - 标题分支 L4438-4447：`if (group)` 用 `historyGroupName(group)`，否则取 `currentWorkflowInfo().name`（**无框→整工作流名**，L4441-4445）。
  - **过滤判据受影响**：`historyBarLoad` L4331 `historyBlockNameOf(historyBarGroup)` 因 `historyBarGroup=null` → `historyBlockNameOf` 首行 `if(!group) return null`（L3577）→ `curBlock=null` → **L4336 退化为不过滤（全量渲染）**（L4350 `: entries`）。即「无框开框 = 显示整工作流全部提交（按框过滤失效）」。
- **无「无框」专用分支**：`historyBarOpen` 本身对 group 是 null/非 null 走同一路径，仅标题与过滤语义不同（见上）。**不存在**「按角色块名自动开框」的分支——`curBlock` 只来自 `historyBlockNameOf(group)`（group 视角），不吃节点/角色块。

---

## 8. 候选改动点清单（目标：无 group 时单击节点 → 取该节点所属角色块名 → 以该块名开历史框）

> 目标行为：单击画布某节点（当前 `historyOnCanvasMouseDown` 只认 group，点节点=空白）时，若命中节点，取其「所属角色块」名，调用 `historyBarOpen` 并以该角色块名做过滤（只显示碰过该块的提交）。

### 8.1 角色块名取得的现有路径（关键前提）
【事实】
- `graphBlocks(graph)`（**L2904**）是唯一块名口径源：它产出 `rawBlocks`，`source === "group"`（框，L2999）与 `source === "role"`（角色兜底，L3003，规则 `ROLE_RULES` L2910-2914：Loader/LoadImage→加载、TextEncode/TextGenerate/StringFormat→文本、Sampler/Scheduler/Guider/Noise→采样、`^(Save|Preview)`→输出，其余「其他」）。
- `historyBlockNameOf(group)`（L3573）**只吃 group 对象、只对 group 命名**（L3571 注释明确「角色块名在 group 名之后才进 pool，此处无需模拟角色桶」）。→ **当前没有「节点→角色块名」的直接函数**。
- 角色块名可由 `graphBlocks(g.toJSON())` 反推：扫 `roleBuckets`（L2957-2964），对每个 role 找其 node 集合，命中目标节点即取 `name = dedupName(role)`（L3003）。**推断**：需新增一个 `historyRoleBlockNameOfNode(node)` 或复用 `graphBlocks` 输出（按 `nodeIds` 反查 `source==="role"` 的块名）。

### 8.2 需要动的函数 / 新增判断（候选插入点）

| # | 改动点 | 函数 + 行号 | 理由 |
|---|---|---|---|
| 1 | **新增「节点命中」分支**：在 `historyOnCanvasMouseDown` 主/兜底命中 group 之后、无 group 收起之前，加「用 `off` 反查节点」逻辑 | `historyOnCanvasMouseDown` **L4603 之前**（即 `if(!group){…}` 之前插入节点命中） | 当前点节点走 L4603-4606 直接收起；要支持点节点开框必须在此前拦截 |
| 2 | **节点→角色块名** 取用 | 新增函数（如 `historyRoleBlockNameOfNode`，参考 `graphBlocks` L2904-3009 的 `roleBuckets`/`nodeIds`） | `historyBlockNameOf`（L3573）不吃节点、不产角色名；第 8.1 已论证无现成路径 |
| 3 | **新增「按角色块开框」入口**：区分「按 group 开」与「按角色块开」 | `historyBarOpen(group)` **L4416 起** 需参数扩展（如 `openByRole(blockName)`）或新增 `historyBarOpenRole(roleName)` | 现 `historyBarOpen` 只存 `historyBarGroup`（L4428）吃 `historyBlockNameOf`（L3573）；角色块无 group 对象，需新状态位（如 `historyBarRoleName`）喂给过滤 |
| 4 | **过滤判据改为支持角色块名** | `historyBarLoad` **L4331** `const curBlock = historyBlockNameOf(historyBarGroup)` 改为「有角色块名则从 `ent.blockNames` 比对角色块名」 | 当前 `curBlock` 仅来自 group；`ent.blockNames`（提交时落盘）存的是 group 框名（见 `historyTickIsLegacy` 依赖的 `blockNames` 字段）——**推断**：角色块过滤需提交时也落 `roleBlockNames`，或前端用 `ent.blocks[].source` 反查 |
| 5 | **标题展示** | `historyBarOpen` 标题分支 **L4438-4447** 新增「角色块模式」文案（`角色块：<名>` 而非 group 名/工作流名） | 与 group 模式（L4439）对称 |
| 6 | **去重/状态** | 模块级状态新增（仿 `historyBarGroup` L3038）如 `historyBarRoleName`；`historyBarReopen`（L5166）同步 | 存档后重开需记当前是「角色块视角」还是「group 视角」 |

### 8.3 数据层缺口（必须同步解决，否则过滤无据）
【事实·推断】`historyBarLoad` 过滤比对键是 `ent.blockNames`（提交落盘字段，见 `reportHistoryCommit` 的 `blocks` 入参 L2289；落盘纯模块 `history_store.py` 写 `blocks`）。**当前 `blocks` 是否含 `source` 角色信息未在本普查走查 `history_store.py`**（见 `docs/_结构普查-3-桥后端与中继.md`）。
- 【推断】若 `ent.blocks` 已逐块带 `source`（group/role），则前端过滤可用 `ent.blocks.filter(b=>b.source==="role" && b.name===roleName)` 替代 `blockNames.includes`，第 4 项改动即落在 `historyBarLoad` L4336-4350 的比对式。
- 【推断】若 `blocks` 只含 group 框名、不含角色块，则需在 `reportHistoryCommit`/`history_store.py` 补落 `roleBlockNames`（属后端改动，超出本桥前端普查范围，需另开后端普查）。

### 8.4 硬约束核对（改动生效前必读）
【事实·硬约束，来源 `docs/代码结构地图.md` §3 + `_结构普查-2-桥前端.md` §8】
1. **CSS 注释只能 `/* */`**：本桥所有 CSS 在 JS 模板串（如 `historyBarStyleEnsure` L3048、`historyNodeStyleEnsure` L3950、`historyTreeStyleEnsure` L4514）。任何改动加注释必须用 `/* */`，**用 `//` 会破坏 CSS**（§3-2）。
2. **`node --check` 假绿**：桥含 `import`，`node --check` 漏报重复声明。改完必须用 `node tools/check-bridge-syntax.mjs <桥>` 校验（§3-1 / 踩坑 #42）。
3. **泳道算法双份同步**：若第 8 条改动触及 `commitGraphLanes`（L4663）或 `graphBlocks`（L2904）——`graphBlocks` 被 `historyBlockNameOf`（L3573）与 `historyLiveBlockColors`（L3942）复用，且其逻辑与 `app/lib/commit-graph-lanes.mjs` 同源；改 `graphBlocks`/`commitGraphLanes` 须同步 lib 版 + `.test.mjs` 断言（§3-3）。注意：本目标（节点→角色块）**主要改 `graphBlocks` 消费侧与 `historyBarLoad` 过滤**，未必动算法本体，但新增「节点→角色块名」若复用 `graphBlocks` 输出则仅消费、不改其逻辑。
4. **零改动铁律**：不碰 ComfyUI 源码/打包产物；一切经桥 + App 机制（§3-5）。
5. **`BRIDGE_BUILD_TAG` 三处同源**：若改动换版，js 文件名 = js `BUILD_TAG` = py `BRIDGE_BUILD_TAG` 同改（§3-4）。

### 8.5 最小侵入建议（推断）
- 不动 `commitGraphLanes`/`graphBlocks` 本体；新增 `historyRoleBlockNameOfNode(node)` 独立函数（消费 `graphBlocks` 返回的 `role` 块 `nodeIds`）。
- 在 `historyOnCanvasMouseDown` L4603 前插节点命中分支；命中后 `historyBarOpenRole(roleName)`（轻封装 `historyBarOpen`，新增 `historyBarRoleName` 状态位）。
- 过滤改动集中在 `historyBarLoad` L4331-4350（用角色块名比对 `ent.blocks`/`ent.blockNames`），其余视图（tick/tree/气泡）已共用母题，无需改渲染结构，仅可能加一个「角色块视角」角标（§1.3/§2.3）。

---

## 附：关键函数 / 行号速查（现桥 hana-bridge-15021810.js）

| 主题 | 函数 | 行号 |
|---|---|---|
| 块名口径（group+role） | `graphBlocks` | L2904 |
| 弹层样式注入（含 tick/bubble CSS） | `historyBarStyleEnsure` | L3048 |
| 旧数据判据 | `historyTickIsLegacy` | L3563 |
| 当前框名（只吃 group） | `historyBlockNameOf` | L3573 |
| 框几何 | `historyGroupRect` | L3371 |
| 框顶屏幕坐标（锚定） | `historyGroupTopScreen` | L3414 |
| 内条样式注入 | `historyNodeStyleEnsure` | L3950 |
| 内条堆生成 | `historyBarsBuild` | L3966 |
| 气泡内容源 | `historyTickChangedNames` | L3893 |
| tick 构造 | `historyBarTickMake` | L3994 |
| 气泡显示/隐藏（bar） | `historyBarBubbleShow` / `historyBarBubbleHide` | L4024 / L4110 |
| 弹层装载+过滤 | `historyBarLoad` | L4299（过滤 L4331-4350） |
| 弹层打开（锚定框顶） | `historyBarOpen` | L4416 |
| 开框入口命中链 | `historyOnCanvasMouseDown` | L4535（无 group L4603 / 同框关 L4608 / 开 L4614） |
| 安装点击钩子 | `installHistoryGroupClick` / `installHistoryGroupProto` / `installHistoryGroupCanvasBind` | L4620 / L4637 / L4675 |
| 树渲染 | `historyTreeRenderTree` | L5575（节点内联 L5665-5719） |
| 树节点样式注入 | `historyTreeStyleEnsure` | L4514 起 |
| 泳道算法（内联） | `commitGraphLanes` | L4663 |
| 存档后重开 | `historyBarReopen` | L5166 |

## 成色声明
- **【事实】**：以上行号、函数名、DOM 结构、CSS 类名、关键语句均经 `read` 工具逐段核对当前文件 `hana-bridge-15021810.js`（6392 行），引用处标注 `Lxxxx`。
- **【推断】**：角色块名取得路径（§8.1/§8.3）、最小侵入方案（§8.5）、`ent.blocks` 是否含角色字段（§8.3）为基于事实的推演，未在本次走查 `history_store.py` 与 `reportHistoryCommit` 内部，落地前须另查后端普查（`docs/_结构普查-3-桥后端与中继.md`）确认 `blocks` 字段结构。
- **未改动任何代码**：仅新建本普查文档；桥文件、`history_store.py`、ComfyUI 源码均未触碰。
