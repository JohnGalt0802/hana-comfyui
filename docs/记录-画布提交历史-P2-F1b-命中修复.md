# 记录：画布提交历史 P2-F1b — 点击命中 group 的主路径修复

**日期**：2026-10-11
**范围**：只改 `app/bridge/js/hana-bridge-1011095446.js`（就地改，不改文件名/tag）；新增本文档
**纪律**：未碰 Python、未碰 `app/ui/`、未部署、未重启、未 frameReload、未跑实机（ComfyUI 在跑，验证交主脑）
**性质**：修 P2-F1 遗留的真实缺陷（已实测定位，未重新调研）

> ⚠️ **后续更正（2026-10-11）**：主脑真机复验发现弹层根本不弹，根因比本文 §一 所述更深 ——
> 运行时 `g.bounding === undefined`，§一「靠 bounding 兜底在工作」的结论**已作废**。
> 以真机数据为准的修正见**文末 §六**。

---

## 一、缺陷

`historyOnCanvasMouseDown()` 的主命中路径写错了对象：

```js
// 现状（错）：canvas.getGroupOnPos 不存在
if (off && typeof canvas.getGroupOnPos === "function") {
  group = canvas.getGroupOnPos(off[0], off[1]) || null;
}
```

`getGroupOnPos` 不在 canvas 上、而在 graph（LGraph）上。主路径因 `typeof` 判定为 `undefined` 而整段跳过 → 死代码；实际命中靠下面的 bounding 兜底在工作，而兜底是**正序遍历 + bounding 包含**，与官方语义（倒序 + `isPointInside`）不同 → **重叠的框会命中错的**。

---

## 二、改动清单（3 处，全在同一文件）

### 1. 新增 `historyGroupRect(group)` 辅助 + 注释依据（新行 2451–2468）

集中 LGraphGroup 矩形的取法，供「中心锚定」与「兜底命中」共用。读取顺序：`boundingRect` → `bounding`（兼容旧版/序列化形态）→ `pos + size`。

- 行 2451–2459：字段核对依据注释（含前端版本与源码定位）
- 行 2460–2468：`historyGroupRect()` 实现

### 2. `historyGroupCenterScreen(group)` 取字段改为 `historyGroupRect`（改 1 行）

- 行 2476：`const b = historyGroupRect(group); // 字段依据见 historyGroupRect 注释`
- 原 3 行取值表达式（`group.bounding || (group.pos && group.size ? ... )`）删除，校验合并进辅助函数

### 3. `historyOnCanvasMouseDown(e)` 主命中路径修正 + 兜底改倒序（新行 2661–2717）

- 行 2662–2685：主路径改为 `canvas.graph.getGroupOnPos` 优先、`canvas.getGroupOnPos` 兜底（取先存在的那个），并附实测依据与倒序语义理由
- 行 2686–2717：兜底改为**倒序**遍历 `graph._groups`，命中判定优先 `g.isPointInside(x,y)`（存在时），无则退回 `historyGroupRect` 矩形包含；每条 `isPointInside` 调用套 try/catch

净变化：`68 insertions(+), 13 deletions(-)`（`git diff --stat`）。

---

## 三、核对过程与依据

### 3.1 `getGroupOnPos` 在 graph 上（实测 + 源码）

运行实例：ComfyUI `0.39.0` + `comfyui-frontend-package 1.55.14`（`D:\ComfyUI\backend.log` L603/L606
「ComfyUI version: 0.39.0」「comfyui-frontend-package version: 1.55.14」）。

前端包位置：`D:\ComfyUI\venv\Lib\site-packages\comfyui_frontend_package\static\assets\settingStore-X9ZV_dAu.js`
（`grep getGroupOnPos` 命中该文件与 `core-BqXsSkPi.js`；方法**定义体**只在 `settingStore-*.js`）。

方法定义（`class LGraph` 内，源码 offset ≈ 495576，压缩后单行）：

```js
getGroupOnPos(e,t){for(let n=this._groups.length-1;n>=0;n--){let r=this._groups[n];if(r.isPointInside(e,t))return r}}
```

- 倒序遍历（`length-1 → 0`）+ `isPointInside`：**重叠时取最后添加的 group**，且尊重 group 的实际形状。
- 同类里同族的 `getNodeOnPos` 也是 `for(;--i>=0;)` 倒序，口径一致。

官方调用点（同 `settingStore-*.js`）：

```js
// offset ≈ 325368（getCanvasContextMenuTarget）
let{graph:r}=e; ... r.getGroupOnPos(t,n)
// offset ≈ 382778（LGraphCanvas.processMouseDown 命中选区）
let l=r.getGroupOnPos(o,s)   // r = graph
// offset ≈ 393710（鼠标移动 resize 判定）
let r=t.getGroupOnPos(c,l)   // t = graph
```

三处均走 **graph**，无一处走 canvas —— 主路径写 `canvas.getGroupOnPos` 必然为 `undefined`。

### 3.2 LGraphGroup 的位置字段：`bounding` vs `_pos`/`size`

源码（同文件 offset ≈ 290672，`Xu=class LGraphGroup`）：

```js
... id;color;title;font;font_size=Z.GROUP_TEXT_SIZE;
bounds=new El(10,10,minWidth,minHeight); _nodes=[]; _children=new Set; graph; flags={}; ...
_pos=createMutationView(this.bounds.pos, {...});
_size=createMutationView(this.bounds.size, {...});
_bounding=createMutationView(this.bounds, {... mapValue:(e,t)=> e===`pos`?this._pos : e===`size`?this._size : t });
...
get pos(){return this._pos}   set pos(e){this.setBounds(e[0],e[1],this._size[0],this._size[1])}
get size(){return this._size} set size(e){...}
get boundingRect(){ return this.syncBoundsFromStore(), this._bounding }
getBounding(){ return this.syncBoundsFromStore(), this._bounding }
...
isPointInside(e,t){ return isInRect(e,t,this.boundingRect) }     // ← 命中判定用 boundingRect
isPointInTitlebar(e,t){ let n=this.boundingRect; ... }
isInResize(e,t){ let n=this.boundingRect; ... }
resizeTo(...) / configure(...) / serialize()                      // ← 全走 setBounds / _bounding
```

结论（**按实际存在的字段取值**）：

| 字段 | 活动实例上是否存在 | 说明 |
|---|---|---|
| `boundingRect` | **是** | getter，返回内部 `_bounding`（由 `bounds` 派生的 `Float64Array` 视图，可索引 `[x,y,w,h]`） |
| `pos` / `size` | **是** | getter，分别返回 `_pos` / `_size`（同派生视图） |
| `_pos` / `_size` / `_bounding` / `bounds` | **是** | 类体直接声明的私有字段 |
| `bounding` | **否** | 类体未声明该属性；只作为 **configure() 的入参字段**、**serialize() 的输出字段** 出现在**序列化对象**里，不是活动实例属性 |

即：`isPointInside` / `isPointInTitlebar` / `isInResize` 全用 `boundingRect`；`resizeTo` / `configure` / `serialize` 全走 `bounds`/`setBounds`——活动实例上真正可用的是 `boundingRect`（以及等价的 `pos`+`size`）。

**原 `historyGroupCenterScreen` 用 `group.bounding` 取位置是错的**：活动实例上取不到（`undefined`），会落进 `pos && size` 分支（该分支恰好可用，所以锚定之前没暴露出问题）；一旦 group 只有 `bounding` 而没有 `pos/size` 就整体失败。本次改为 `historyGroupRect()`：`boundingRect` → `bounding`（兼容序列化形态/旧版）→ `pos+size` 三级取值。

### 3.3 兜底改倒序的理由

与 `getGroupOnPos` 语义对齐：**后添加的框优先**。原正序 `for (const g of ...)` 命中最先添加的框，与官方口径相反 → 重叠时命中错的。判定优先用 `g.isPointInside`（与官方同源、尊重实际形状），无该方法才退回矩形包含。

---

## 四、验收

### 改了几处、每处行号

3 处，全在 `app/bridge/js/hana-bridge-1011095446.js`：

1. **L2451–2468** — 新增 `historyGroupRect(group)` + 字段依据注释
2. **L2476** — `historyGroupCenterScreen()` 内取字段改为 `historyGroupRect(group)`（改 1 行）
3. **L2661–2717** — `historyOnCanvasMouseDown()` 主命中路径修正（L2662–2685）+ 兜底改倒序 & 优先 `isPointInside`（L2686–2717）

### `historyGroupCenterScreen` 用的字段依据

`historyGroupRect(group)`：`group.boundingRect`（活动实例真实存在，getter → `_bounding`）→ 退 `group.bounding`（兼容旧版/序列化形态）→ 退 `group.pos`+`group.size`。依据见 §3.2（源码 offset ≈ 290672 类体声明与 getter 定义）。

### 语法检查输出

```
> node --check D:\HanakoWorks\ComfyUI\app\bridge\js\hana-bridge-1011095446.js
exit=0
```

（无输出即通过；未跑实机，端到端行为由主脑验证。）

---

## 五、未改（约束遵守）

- 文件名 / `BUILD_TAG` 未动（改名牵动三处同源，部署由主脑统一安排）
- 未碰 Python、未碰 `app/ui/`、未部署、未重启、未 frameReload
- `historyBarOpen` / `historyBarLoad` / P3-G1 回跳等其余逻辑零改动

---

## 六、补记（P2-F1b-2）：真机根因落定，命中链按运行时字段重排

**日期**：2026-10-11（同批次补记）
**触发**：主脑真机复验，发现弹层**根本不弹**；上一份诊断（§一～§五）不够准，本节以真机数据为准。

### 6.1 上一份结论作废项

- **§一「实际命中靠 bounding 兜底在工作」— 作废。** 真机确证：运行时 `g.bounding === undefined`，兜底读的也是 `g.bounding`（原始代码为 `const b = g && g.bounding`），**同样取不到** → 主路径与兜底**双双失效**，弹层永远不弹。
- 我的上一版兜底虽改成 `historyGroupRect()`（能读 `boundingRect`），但 §3.2 把 `boundingRect` 列为运行时首选项——真机数据显示运行时首选是 `_bounding`，`boundingRect` 是 getter（会触发 `syncBoundsFromStore()`）；两者值等价，但字段存在性口径以真机为准。
- **「兜底能命中」的旧结论**：源于手工 `new LGraphGroup()` 后赋 `bounding` 数组造出的实例，形态与真实运行时不同，把判定骗过了。此错已认，本节以真机形态为准。

### 6.2 真机运行时字段实测（comfyui_frontend_package 1.55.14）

| 字段 | 运行时实测 |
|---|---|
| `g.bounding` | **`undefined`** ← 桥旧代码读的就是它，永远取不到（根因） |
| `g._bounding` | ✅ 有值，形如 `[520, -90, 396.9, 708]`（数组，含 `_pos`/`_size` 子对象） |
| `g._pos` / `g._size` | ✅ 有（`{0:x, 1:y}` 形态） |
| `g.getBounding()` | ✅ 方法存在 |
| `g.isPointInside(x,y)` | ✅ 方法存在 |
| `graph.getGroupOnPos(x,y)` | ✅ **存在**（在 `graph` 上，不是 `canvas`） |
| `canvas.getGroupOnPos` | ❌ 不存在 |
| 序列化后（落盘 JSON） | `bounding: [520,-90,396.9,708]` ← **只有序列化格式才叫 bounding** |

即：运行时字段名（`_bounding`/`_pos`/`_size`）与序列化字段名（`bounding`）**互斥**——运行时无 `bounding`，序列化无 `_bounding`。

### 6.3 本轮改动（相对 §二 的 delta）

**4 处，全在 `app/bridge/js/hana-bridge-1011095446.js`**：

| # | 行号 | 改动 | 支持的字段形态（按尝试顺序） |
|---|---|---|---|
| 1 | **L2451–2480** | `historyGroupRect()` 取值链重排：`boundingRect` → `_bounding` → `_pos`/`_size`（兼容 `pos`/`size`）→ `bounding`；注释改为「真机实测 [A] + 源码核对 [B]」双层依据 | ① `boundingRect`（getter）② **`_bounding`**（运行时实测有值）③ `_pos`+`_size`（运行时存在）④ `bounding`（旧版/序列化形态） |
| 2 | **L2488** | `historyGroupCenterScreen()` 取字段继续走 `historyGroupRect(group)`（弹层锚点与命中判定同一取值链） | 同上 4 种形态 |
| 3 | **L2675–2698** | `historyOnCanvasMouseDown()` 主路径：`canvas.graph.getGroupOnPos` 优先 → `canvas.getGroupOnPos` 次之（取先存在者）；注释改为真机实测口径 | 主：`graph.getGroupOnPos`（✅ 确证存在）；次：`canvas.getGroupOnPos`（兼容未来挪回 canvas） |
| 4 | **L2699–2728** | 兜底：倒序遍历 `graph._groups`；命中判定 `g.isPointInside(x,y)` 首选 → 否则 `historyGroupRect(g)` 矩形包含 | ① `g.isPointInside` ② `boundingRect` ③ `_bounding` ④ `_pos`/`_size` ⑤ `bounding` |

净变化：`79 insertions(+), 13 deletions(-)`（`git diff --stat`，相对改动前基线）。

### 6.4 命中链的一致性核对（graph.getGroupOnPos vs 兜底）

**已读前端实现，回答：一致。**

源码（`settingStore-X9ZV_dAu.js`，`class LGraph` 内，offset≈495576）：

```js
getGroupOnPos(e,t){for(let n=this._groups.length-1;n>=0;n--){let r=this._groups[n];if(r.isPointInside(e,t))return r}}
```

- **遍历方向**：官方为 `length-1 → 0` **倒序**；本轮兜底亦为 `for (let i = groups.length - 1; i >= 0; i--)` **倒序** → 一致（后添加的框优先，重叠时取最后添加的）。
- **命中判定**：官方用 `r.isPointInside(e,t)`；本轮兜底首选 `g.isPointInside(off[0], off[1])` → 一致（LGraphGroup.isPointInside = `isInRect(e, t, this.boundingRect)`，与 `historyGroupRect()` 的 `boundingRect` 分支同源同值）。
- **差异**：兜底在 `isPointInside` 缺失/抛错时才退回矩形包含（官方无此分支），属「降级兼容」，不影响两者在正常形态下的一致性。

### 6.5 真实运行时下第一级能否命中（推断）

**推断：能。**

依据真机字段表（§6.2）：`graph.getGroupOnPos` 确证存在 → 主路径第一级（`canvas.graph.getGroupOnPos.bind(canvas.graph)`）即被选中并调用；其内部 `isPointInside` 也确证存在，而 group 的 `boundingRect` 由 `_bounding` 派生（真机 `_bounding` 有值）→ 返回非空。故**正常情况下第一级就命中，不会落到兜底**。

**标注**：以上为**按已读字段形态与源码推断**，非实机运行验证（实机由主脑跑）。理论上只有在 `graph` 未挂载（如初始化中）或 `getGroupOnPos` 抛错时，才降级到第二级/兜底。

### 6.6 语法检查

```
> node --check D:\HanakoWorks\ComfyUI\app\bridge\js\hana-bridge-1011095446.js
node_check_exit=0
```

### 6.7 约束遵守（同 §五）

只改该 js；未改文件名/tag；未碰 Python / `app/ui/`；未部署、未重启；未跑实机。

---

## 七、补记（P2-F1b-3）：真正根因 —— 事件到不了（实例回调在 bindEvents 时被冻结）

**日期**：2026-10-11（同批次第二份补记）
**触发**：主脑真机 CDP 定位铁证：`installHistoryGroupClick()` 只包了原型，事件触发走的却是 bindEvents 时冻结的旧函数 → 包装被完全绕过。**不再重新调研，按铁证修。**

### 7.1 根因（真机铁证，主脑给）

litegraph 的 `bindEvents()` 在**绑事件那一刻**就做：

```js
this._mousedown_callback = this.processMouseDown.bind(this)
```

即**回调里冻结的是绑定时的那个函数**。桥在这之后才替换原型 → 事件触发时走的仍是**旧函数**，包装被完全绕过。

```
LGraphCanvas.prototype.processMouseDown  含我们的包装 = true      ← 原型改成功
canvas._mousedown_callback 含我们的包装      = false     ← 但事件回调是旧的！
canvas._events_binded                        = true      ← 事件早已绑定
```

附带印证：直接 `proto.processMouseDown.call(canvas, e)` 手工调用，命中链完全正确（`convertEventToCanvasOffset` → `graph.getGroupOnPos` → 命中目标 group，`hitIsTarget=true`）→ **判定逻辑本身没问题，问题只在「事件到不了」**。原 `installHistoryGroupClick()` 因此等于死代码。

### 7.2 读到的 `bindEvents` 原文（`settingStore-X9ZV_dAu.js`，`LGraphCanvas.bindEvents`，offset≈373756）

```js
bindEvents(){ if(this._events_binded){ console.warn(`LGraphCanvas: events already bound`); return }
  let{canvas:e}=this,{document:t}=this.getCanvasWindow();
  this._mousedown_callback   = this.processMouseDown.bind(this),
  this._mousewheel_callback  = this.processMouseWheel.bind(this),
  this._mousemove_callback   = this.processMouseMove.bind(this),
  this._mouseup_callback     = this.processMouseUp.bind(this),
  this._mouseout_callback    = this.processMouseOut.bind(this),
  this._mousecancel_callback = this.processMouseCancel.bind(this),
  e.addEventListener(`pointerdown`,   this._mousedown_callback,   !0),
  e.addEventListener(`wheel`,         this._mousewheel_callback,  !1),
  e.addEventListener(`pointerup`,     this._mouseup_callback,    !0),
  e.addEventListener(`pointermove`,   this._mousemove_callback),      // 无第三参 → bubble
  e.addEventListener(`pointerout`,    this._mouseout_callback),
  e.addEventListener(`pointercancel`, this._mousecancel_callback, !0),
  e.addEventListener(`contextmenu`,   this._doNothing),
  e.addEventListener(`auxclick`,      this._preventMiddleAuxClick),
  this._key_callback=this.processKey.bind(this),
  e.addEventListener(`keydown`, this._key_callback, !0),
  t.addEventListener(`keyup`,   this._key_callback, !0),
  e.addEventListener(`dragover`,this._doNothing,!1), e.addEventListener(`dragend`,this._doNothing,!1), e.addEventListener(`dragenter`,this._doReturnTrue,!1),
  this._events_binded=!0 }
```

摘出与重绑对齐的四条事实：

| # | 事实 | 我的对齐方式 |
|---|---|---|
| ① | **按下事件名是 `pointerdown`**（全包没有 `mousedown` 监听；旧注释里说的 mousedown 不存在） | 重绑/自挂都按 `pointerdown` |
| ② | 该监听 **capture = `!0` = true** | `removeEventListener` / `addEventListener` **都带第三参 `true`**（DOM 事件身份含 capture，摘除标志必须一致，否则摘不掉） |
| ③ | **未使用 `AbortController`**，摘除完全依赖实例字段 `this._mousedown_callback` | 重绑时**同步更新 `c._mousedown_callback = next`**，否则日后 `unbindEvents` 摘不到新回调 |
| ④ | `unbindEvents()` 里 `t.removeEventListener('pointerdown', this._mousedown_callback)` **未带 capture 标志**（默认 false） | 属 litegraph 自身的口径瑕疵（add=true/remove=false 按 DOM 匹配规则会摘不掉）。我这边摘旧回调**带 `true`**，能真正摘掉；不影响功能 |

`unbindEvents()` 关键行（同文件，offset≈374891）：`t.removeEventListener('pointerdown', this._mousedown_callback), ... this._mousedown_callback=void 0, this._events_binded=!1`。

结论：**重新指向实例回调是必修**；且因为「同事件同 capture 的自挂监听」独立于 litegraph 内部绑定，是最稳的一条路。

### 7.3 选了哪条主路径

**三条一起上**（互补，不是二选一）：

1. **包原型**（保留，`installHistoryGroupProto()`，全局只做一次）—— 兼容将来某时刻重新 `bindEvents` / 未来版本。
2. **重绑实例事件回调**（`installHistoryGroupCanvasBind()` §②-b）—— 直接对准根因：换掉 `c._mousedown_callback` 并把元素上的 `pointerdown` 监听同步换成新回调（旧的回调带着 capture=true 一起摘除）。
3. **元素上自挂 capture 监听**（§②-c，`#graph-canvas-container` 内的那个 `<canvas>` 元素，用 `c.canvas || c.canvasEl`）—— **不依赖 litegraph 的任何内部绑定**，最稳；与 litegraph 同元素同事件（`pointerdown`）+ 同 capture 标志，必定随事件到。

另有 §②-a：**实例若自持 `processMouseDown` 覆盖**（`hasOwnProperty` 命中），原型包装会被绕过 → 就地再包一层。

**主路径口径**：以 **③ 元素 capture 监听为绝对保险**，②-b 为直击根因的正解，① 为兼容层；三条对同一事件都可能到达 → 由 `historyGroupHookSeenEvents`（WeakSet，事件对象）**去重，保证一次按下只处理一次**（不会重复弹层/重复 fetch）。

### 7.4 幂等与重试时机

**幂等（四层各自哨兵，重复调用不重复绑定/包裹）**：

| 哨兵 | 保护对象 |
|---|---|
| `historyGroupProtoWrapped = false` | ① 原型包装（全局一次） |
| `historyGroupInstanceWrapped = new WeakSet()` | ②-a 实例自持覆盖的就地再包（按实例） |
| `historyGroupBoundCanvases = new WeakSet()` | ②-b `_mousedown_callback` 重绑（按实例） |
| `historyGroupBoundElements = new WeakSet()` | ②-c 元素 capture 监听（按元素） |
| `historyGroupHookSeenEvents = new WeakSet()` | 同事件多入口去重（一次按下只处理一次） |

（旧哨兵 `historyGroupClickInstalled` 已删除 —— 它是「全局一次」，会挡住延迟重试对后出现的实例/元素补绑。）

**重试时机（两档）**：

1. `setup()` 里照旧**首次调用 `installHistoryGroupClick()`** 并新增 `scheduleHistoryGroupInstallRetries()`；
2. `scheduleHistoryGroupInstallRetries()` 用 `setTimeout` 在 **500 / 1500 / 3000 / 6000 ms** 各重入一次。理由：`setup()` 执行时 `app.canvas` / canvas 元素可能尚未就绪（实测两种都出现过），且启动期间实例/元素可能被重建 —— WeakSet 按对象区分，重入会针对新对象**自愈补绑**，已绑的则整体跳过。

**未挂 litegraph 内部钩子**：读了源码后确认 `bindEvents` 之后**没有稳定可挂的事件/钩子**（无 AbortController、无 `events-binded` 事件广播）→ 故**不走「挂稳定时点」这条**，改用上述延迟重试 + 元素 capture 监听兜底。

### 7.5 改动清单（相对上一版的 delta，4 处，全在同一文件 `app/bridge/js/hana-bridge-1011095446.js`）

| # | 行号 | 改动 |
|---|---|---|
| 1 | **L2373–2378** | 哨兵重排：删 `historyGroupClickInstalled`，新增 4 个 WeakSet + `historyGroupProtoWrapped`；附四层语义注释 |
| 2 | **L2670–2673** | `historyOnCanvasMouseDown()` 开头新增**同事件去重**（`historyGroupHookSeenEvents`），防多入口重复处理；紧接原有的左键判定 |
| 3 | **L2744–2885** | `installHistoryGroupClick()` 整体重写并拆分为 `installHistoryGroupProto()` / `installHistoryGroupCanvasBind()` / `scheduleHistoryGroupInstallRetries()`；含 `bindEvents` 原文与四条对齐依据注释 |
| 4 | **L3210–3213** | `setup()` 调用点：注释更新 + 追加 `scheduleHistoryGroupInstallRetries()` |

`git diff --stat`（相对改动前基线）：`1 file changed, 215 insertions(+), 19 deletions(-)`。

### 7.6 只读保证（capture 阶段不吞原生交互）

capture 监听与重绑回调都**只读**：不 `preventDefault()`、不 `stopPropagation()`、不改 `e`、不返回值、不动 `this`；命中即弹层、点空白收起，其余分支原样放行。钩子自身异常一律 try/catch → 只 `console.warn`，绝不影响 litegraph 的原生按下处理。

### 7.7 语法检查

```
> node --check D:\HanakoWorks\ComfyUI\app\bridge\js\hana-bridge-1011095446.js
node_check_exit=0
```

### 7.8 约束遵守（同 §五 / §6.7）

只改该 js；未改文件名/tag；未碰 Python / `app/ui/`；未部署、未重启；**未跑实机**（真机验证由主脑跑）。

---

## 八、真机验证通过（主脑，2026-10-11 20:5x）—— 弹层首次真正弹出

### 8.1 部署
- `tools/deploy-bridge.ps1` → `D:\ComfyUI\ComfyUI\custom_nodes\hana_bridge\js\`（活动桥替换，哈希两处一致）
- **无需重启 ComfyUI**：桥是静态前端扩展，路由 `GET /extensions/hana_bridge/hana-bridge-1011095446.js` 直接给出新内容（已核 `installHistoryGroupCanvasBind` / `scheduleHistoryGroupInstallRetries` 均在）。刷新页面即生效。
- 宿主副本 `C:\Users\John Galt\.hanako\apps\comfyui-hana\bridge\js\...` 已由 `tools/sync-to-host.ps1` 同步（0 缺失、0 内容不一致）。

### 8.2 验证方法（真实事件路径，非构造）
headless Chrome（CDP `--remote-debugging-port`）→ 载入含 group 的真实工作流 → **用 CDP `Input.dispatchMouseEvent` 发原生 pointer 事件**点画布。
- 关键校准：CDP 事件只会投给 `document.elementFromPoint(x,y)` 的**最顶层元素**；先前多次「点击无效」实为坐标落在被浮层（SPAN 工具条）遮挡处。扫描 `elementFromPoint===canvas` 且在 group 内的坐标后才命中。
- 本次实测事件确实到达 canvas（元素级探针 `pointerdown:2 / pointerup:2 / click:2`）。

### 8.3 结果
```
=== 桥安装状态 ===
protoWrapped: true    （原型包装在位）
build: "2026-10-11 hana-bridge-1011095446"

=== 真实 CDP 点击 group 中心后 ===
barVisible: true
barText: "Qwen21 t2i 质量版 (00012)  14 条提交  ✕  ... 回到这一版"
cardCount: 14
firstCard: "1 #001 10-11 20:10"
lastCard:  "14 #014 10-11 20:27"
```
截图存档：`_temp/hhb-popup.png`。

### 8.4 结论
P2-F1b-3 三路修复（① 包原型 ② 重指实例回调 ③ 元素 capture 监听）**在真实事件路径下生效**，弹层从「从未弹出」变为「点分组框即弹、列出该工作流全部提交」。§七 §7.1 的根因（实例回调在 `bindEvents` 时被 `.bind()` 冻结）得到实机闭环印证。

### 8.5 遗留（未验）
- P3 二次确认交互「回到这一版」单击后是否进确认态：本次点了 1 次按钮文案未变化，疑似**画布未修改时单击直接执行**（设计如此：未 dirty → 单选即执行；dirty → 二次确认）。未做完整回跳验证（回跳是画布写操作，留用户手测）。
- 「0 条提交」场景（用 loadGraphData 载入时桥认的名字是临时页 "Unsaved Workflow"）：属**工作流身份对齐**问题，非本缺陷；用 `ComfyWorkflow` + `openWorkflow(path)` 打开正式文件后名字与历史目录一致（已实测 14 条）。
