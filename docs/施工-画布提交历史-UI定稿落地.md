# 施工：画布提交历史 · UI 定稿落地

**日期**：2026-10-12
**状态**：施工任务书（主脑出；John 已批「开工（框 + 树一次做完）」）
**权威来源**：
- 视觉定稿卡 v2（2026-10-12，含全部数值）
- `docs/调研-画布提交历史-成熟做法与问题清单.md`
- John 拍板四条：① 左旧右新 + 打开滚到最右 ② 合并提交加粗加亮 ③ 多分支休眠折叠 +N ④ 横向滚轮滚动

**红线**（沿用 AGENTS.md / GLOBAL_RULES）：
- 只改桥（`app/bridge/js/`）+ 新增 lib 文件；零改 ComfyUI 源码与前端产物
- 桥改名换版 = **三处 tag 同源**：js 文件名 = js 内 `BUILD_TAG` = `app/bridge/__init__.py` 的 `BRIDGE_BUILD_TAG`
- 同一主题一次改完再交付；禁止中途重启宿主/ComfyUI
- 测试不得使用用户真实工作流（自建带测试前缀的夹具，验完清理）

---

## 〇、分批

| 批 | worker | 任务 | 文件 | 依赖 |
|---|---|---|---|---|
| 1 | W1 | 泳道算法 + 单测 | `app/lib/commit-graph-lanes.mjs`(新) + `.test.mjs`(新) | 无 |
| 1 | W2 | 框视觉落地 | 桥（改名换版 → tagA） | 无 |
| 2 | W3 | 树重写（泳道式） | 桥（基于 tagA → tagB） | W1 + W2 |

> W1 与 W2 不同文件 → 可并行。W3 依赖两者 → 串行。

---

## W1 · 泳道算法（纯函数 + 单测）

**产出**
- `app/lib/commit-graph-lanes.mjs`
- `app/lib/commit-graph-lanes.test.mjs`

**输入**：`entries`（索引行数组，**已按 seq 升序**），每项至少 `{seq:number, parent:number|null}`。
**输出**：
```js
{
  lanes: [{ lane:number, headSeq:number, sleeping:boolean }],  // 按 lane 升序
  nodes: [{ seq:number, lane:number, row:number }],            // row = -1 → 折叠隐藏
  rows: number,           // 显示行数（= 活跃泳道数）
  sleepingCount: number   // 折叠掉（不显示）的泳道数
}
```

**算法（三段，确定性）**

（1）泳道分配（单遍，seq 升序）
```
active = []            // active[L] = 该泳道悬挂末端 seq；只增不回收（我们只分不合）
for c of entries:
  p = c.parent
  lane = -1
  if p != null:
    for L in 0..active.length-1: if active[L] === p: { lane = L; break }
  if lane < 0: { lane = active.length; active.push(null) }
  active[lane] = c.seq
  nodeLane[c.seq] = lane
laneCount = active.length
```
- 同 parent 多 child 时 **seq 最小的 child 先接手** → 输出唯一（确定性）。
- 我们的图是**树**（单 parent、只分不合），故泳道**永不真正回收**，只能靠「休眠折叠」隐藏 → 这正是（2）存在的原因。

（2）休眠判定 + 选显示集
```
latest = max(entries.seq)
MAX_ROWS = 4                 // 最多显示 4 条泳道
headSeq[L] = active[L]       // 各泳道末端
按 headSeq 降序排序泳道 → 取前 MAX_ROWS 条 = 显示集
```

（3）紧凑重映射
```
显示集按 lane 号升序 → row = 0,1,2,...   （行序稳定，连线不乱）
非显示集 → row = -1（折叠）
rows = 显示集大小
sleepingCount = laneCount - rows
```

**边界**
- `entries` 空 → `{lanes:[], nodes:[], rows:0, sleepingCount:0}`
- 同 seq 重复 → 保持输入序，不重排
- `parent` 指向不存在的 seq（孤儿）→ 视同根（新开泳道）
- `parent >= seq`（异常）→ 视同根，**不抛异常**
- 非整数 / 缺失 parent → 视同根

**单测（`node --test`）至少覆盖**
1. 线性 10 条 → 1 泳道、10 节点全部 `row=0`、`sleepingCount=0`
2. 一次分叉（seq3 分出两支）→ 2 泳道
3. 分叉后一支长期不动（末端远落后于 latest）→ 该泳道 `sleeping=true`
4. 泳道数 > 4 → `rows <= 4` 且 `sleepingCount > 0`
5. 确定性：同输入两次结果 `deepEqual`
6. 空 / 孤儿 parent / 异常 parent 不抛
7. 每个节点在 `nodes` 里都有 `row`（含 -1）

**验收**：`node --test app/lib/commit-graph-lanes.test.mjs` 全绿；`node --check` 通过。

---

## W2 · 框视觉落地（提交历史弹层）

**文件**：把 `app/bridge/js/hana-bridge-12021428.js` **改名换版**为新 tag（= 执行时北京时间 `MMDDHHMM`）：
1. 复制为新 `hana-bridge-<newtag>.js`
2. 改文件内 `BUILD_TAG` = `<newtag>`
3. 改 `app/bridge/__init__.py` 的 `BRIDGE_BUILD_TAG` = `<newtag>`
4. 删除旧 `hana-bridge-12021428.js`
5. 确保与上一版 tag 不同（若同一分钟，+1 分钟）

**只改框相关段**（`#hana-history-bar`）：`historyBarStyleEnsure` / `historyBarTickMake` / `historyBarLoad` / `historyBarOpen`。
**不碰**：树段、弹层交互逻辑（三态/回跳/存档）、后端。

**改点**

① `historyBarStyleEnsure()` CSS：
- `#hana-history-bar` 面板 → 玻璃质感（去硬白边）：
```css
background: linear-gradient(180deg, rgba(38,44,54,.94) 0%, rgba(27,32,40,.95) 100%);
border: 0;
border-radius: 13px;
box-shadow:
  inset 0 1px 0 rgba(255,255,255,.075),
  inset 0 0 0 1px rgba(255,255,255,.05),
  0 10px 30px rgba(0,0,0,.5),
  0 2px 6px rgba(0,0,0,.4);
backdrop-filter: blur(6px);
```
- `.hhb-tick` → 渐变胶囊（用现有 `--hhb-c` 色变量）：
```css
width: var(--hhb-tw, 9px); height: 23px; border-radius: 3px; border: 0;
background: linear-gradient(180deg,
  color-mix(in oklab, var(--hhb-c, #5aa0d8) 68%, white) 0%,
  var(--hhb-c, #5aa0d8) 42%,
  color-mix(in oklab, var(--hhb-c, #5aa0d8) 70%, #080a0d) 100%);
box-shadow: inset 0 0 0 1px rgba(255,255,255,.15), 0 1.5px 4px rgba(0,0,0,.55);
transition: transform .14s, box-shadow .14s, filter .14s;
```
- `.hhb-tick:hover` → `transform: translateY(-1.5px); filter: brightness(1.12);` + 同色微光 `0 0 12px color-mix(in oklab, var(--hhb-c) 45%, transparent)`
- `.hhb-tick[data-kind="save"]` → 空心改内描边：`background: transparent; box-shadow: inset 0 0 0 1.5px var(--hhb-c, #5aa0d8), 0 1.5px 4px rgba(0,0,0,.5);`
- `.hhb-tick.hhb-tick-bulge` → `width: calc(var(--hhb-tw, 9px) + 3px);`（合并提交加粗）
- 新增 `.hhb-tick .hhb-runs` → ×N 徽标：绝对定位右上；`font-size:8.5px; font-weight:700; color:#0d1014; background:#dfe8f2; border-radius:5px; padding:0 3px; line-height:11px; box-shadow:0 1px 3px rgba(0,0,0,.5); pointer-events:none;`
- `.hhb-axis` → 保持 `overflow-x:auto`，**隐藏滚动条**（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`）
- 新增 `.hhb-axiswrap{position:relative}` + `.hhb-fade{position:absolute;top:0;bottom:0;width:18px;pointer-events:none;z-index:2;opacity:0;transition:opacity .2s}`、`.hhb-fade.l{left:0;background:linear-gradient(90deg,rgba(31,37,46,.95),transparent)}`、`.hhb-fade.r{right:0;background:linear-gradient(270deg,rgba(31,37,46,.95),transparent)}`、`.hhb-fade.hhb-fade-on{opacity:1}`

② `historyBarTickMake()`：`ent.runs.length > 1` 时加 class `hhb-tick-bulge`；`colW >= 10` 时追加 `.hhb-runs`（文本 `×` + runs 数）。

③ `historyBarLoad()`：
- `availW = axis.clientWidth`；`n = shown.length`
- `colW = Math.min(44, Math.max(11, availW / n))`
- `tw = Math.min(11, Math.max(3, colW * 0.45))`；再 `tw = Math.min(tw, colW * 0.85)`
- `gap = Math.max(2, colW - tw)`
- 设 `axis.style.gap = gap + "px"`；每刻度 `tick.style.setProperty("--hhb-tw", tw + "px")`
- 渲染后 `axis.scrollLeft = axis.scrollWidth`（打开定位到最新）
- 更新两端渐隐（调到 `updateAxisFade`）

④ `historyBarOpen()`：
- 轴外层包 `.hhb-axiswrap`，内含 `.hhb-fade.l/.r`
- 绑 `wheel`（`{ passive:false }`）：`scrollLeft += (|ΔX| > |ΔY| ? ΔX : ΔY)`；**到两端时 return（放行，不 preventDefault）**；容器不可滚时 return
- 绑 `scroll` → 更新渐隐（`scrollLeft>1` 显左、`scrollLeft+clientWidth < scrollWidth-1` 显右）

**数值汇总见定稿卡「照抄用 · 关键数值」栏。**

**验收**
- `node --check <新桥>` 通过
- 真机 CDP：玻璃质感、刻度渐变胶囊、宽自适应（少宽 / 多窄 + 横滚）、打开滚到最右、合并刻度 +3px 且带 ×N、两端渐隐
- 3 档截图（稀疏 / 中 / 密）
- **不得**使用用户真实工作流做验证

**产出格式**：改动清单（函数 + 行号）+ `node --check` 输出 + 截图路径 + 未决项 + 回滚方式。

---

## W3 · 树重写（泳道式）

**依赖**：W1 的 `commit-graph-lanes.mjs`（**内联**进桥，逻辑逐条一致）+ W2 的 tagA 桥文件。
**文件**：桥（基于 tagA 改名换版 → tagB，规则同 W2）。

**改点**（`#hana-history-tree` 段）

① `historyTreeStyleEnsure()` → 玻璃质感（同框口径）+ 泳道式布局 + 渐隐 + 折叠条：
- `#hana-history-tree .htr-collapsed` 与 `.htr-panel` → 玻璃板（`linear-gradient(180deg,rgba(38,44,54,.94),rgba(27,32,40,.95))` + 内高光 + 柔影；圆角 `.htr-panel` 顶部 13px）
- `.htr-tree` → 换成 `.tcanvas`（`overflow-x:auto`，隐藏滚动条，`cursor:grab`）
- 色条 `.htr-bar` → `width:var(--nw); height:2.5px; border-radius:1.5px;`；命中 `.htr-bar-on`（`background:var(--htr-c); box-shadow:0 0 6px color-mix(in oklab,var(--htr-c) 55%,transparent)`）；未命中 `rgba(255,255,255,.11)`
- 合并节点 `.htr-tick-bulge` → 命中条 `height:4px; box-shadow:0 0 9px color-mix(in oklab,var(--htr-c) 75%,transparent)`
- 新增 `.htr-runs`（×N 徽标，同框）；`colW < 10` 不渲染
- 连线 `.htr-edges path` → `stroke: rgba(150,172,198,.28); stroke-width:1.3; stroke-linecap:round; stroke-linejoin:round; fill:none`
- 新增泳道基准线 `.htr-laneaxis`（1px `rgba(255,255,255,.032)`）
- 新增 `.htr-fade.l/.r`（同框口径）+ `.htr-sleep`（休眠折叠条：虚线框 + `+N` + 展开箭头）

② `historyTreeRenderTree(entries)` → **改用泳道算法**：
- 内联 `commitGraphLanes(entries)`（与 `app/lib/commit-graph-lanes.mjs` 逐逻辑一致）→ `{lanes, nodes, rows, sleepingCount}`
- `H = rows * laneH + 6`；`W = max(n * colW, availW - 4)`；`colW = max(4.2, min(34, (availW-28) / n))`；`nw = min(cfg.nw, colW*0.8)`
- `X(seq) = (seq - 0.5) * colW`；`Y(row) = row * laneH + laneH/2 + 3`
- 只渲染 `row >= 0` 的节点；`row === -1` 跳过
- 每显示泳道画一条 `.htr-laneaxis`
- 节点保留现有：色条堆（globalBlocks，命中/未命中）+ stem（run 实线 / save 虚线）+ HEAD 金点；合并加 `htr-tick-bulge` + ×N
- 返回 `nodeEls`（seq → 元素）供连线测量

③ `historyTreeDrawEdges(nodeEls, graph)` → 按真实位置：
- 同 `row` → 水平直线
- 跨 `row` → 圆角贝塞尔（同卡：`M x1,y1 C mx,y1 mx,y2 x2,y2`）
- 一端在折叠泳道（`row === -1`）→ 淡出为水平短线 `opacity .18`（表示"此处有分支被折叠"）

④ `historyTreeEnsure()` → 面板结构：
```
.htr-panel
  .tcanvas (横滚)
    .lanes (相对定位, 宽 W 高 H)
      svg.htr-edges
      .htr-laneaxis × rows
      .node × ...
  .htr-fade.l / .htr-fade.r
  .htr-sleep (+N 休眠分支 · 展开 ▸)
```
- 绑 `wheel` 横滚 + `scroll` 渐隐 + 打开滚到最右（同框口径）
- `.htr-sleep` 点击态（本期可先只显示 + 计数；展开折叠分支为后续，任务书注明）

⑤ `historyTreeUpdateCounts(entries)` → 由算法结果补「· K 泳道」；折叠时显示 `+N 休眠分支`。

**验收**
- `node --check`
- 真机 CDP：泳道式、>4 泳道折叠 +N、横滚、合并加粗、贝塞尔连线、HEAD 金点
- **cross-check**（写 `_temp` 脚本）：从桥内联函数体抽出 `eval`，与 `app/lib/commit-graph-lanes.mjs` 同输入 `deepEqual`
- 3 档截图

---

## 交付与收尾

- 两批完成 → 主脑验收（对标准、查证据）
- 同步两副本：`tools/deploy-bridge.ps1`（→ ComfyUI 侧）+ `tools/sync-to-host.ps1`（→ 宿主副本，含哈希核对；**删旧 js**）
- 交付 John：区分「已生效（实测）」与「待重启」；需重启则给收益清单、由 John 定时机
- 记录：`docs/记录-画布提交历史-UI定稿.md`；踩坑即时进 `docs/踩坑记录.md`
- 未提交项：`app/ui/workspace.js`（提示条删除）攒着，本次不动
