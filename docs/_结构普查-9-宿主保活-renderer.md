# 结构普查 #9 — 宿主 v1.1.7-beta renderer：chalkboard 页卡切走时是否卸载 / App 有无保活口子

> 检索对象：`C:\Users\John Galt\.hanako\artifacts\renderer\1.1.7-beta-win32-x64-07fab433914a57ce-g4d1c9da3b4e195b2\assets\*.js`
> 方法：只读，python `re.finditer` 切片读 minified 单行；未改任何文件（仅新建本交付文档）。
> 成色： 【事实】= 代码直接可见；【推断】= 由代码结构与行为推导，未运行验证。
> 注：压缩文件用 `open(...,errors="replace")`+`re` 切片，offset 为「文件字符偏移」。

---

## 0. 结论速览（先给结论）

- **App 页卡（`realization:"page"` 整页卡，如 hui/ComfyUI 集成）在宿主里落到 `kind:"page"` 的 surface，其 `role` 恒为 `persistent`**（由宿主默认 layout 与页面模板函数写死）。【事实】
- **桌面端：切走一个 page 不会卸载它。** 桌面页宿主 `Su()`（`contributed-keybindings-CWd7VC-R.js` @105779）把 `activePageId` 之外的页面当作 `parked`（`data-parked`），用 CSS 位移/滑出停靠，**保留 DOM 子树与卡片 portal（含 iframe/guest），不移除、不用 `display:none`。**【事实】
- **移动端：有显式“只渲染 active + persistent/floating”的判据 `me()`**（`MobileChalkboardCardPage-CJrJR5oi.js` @2256）。但这是**手机端**渲染函数，不是桌面共享逻辑。
- **卡片语境不存在 `keepMounted` / `keepAlive` / `stayMounted` / `pinToKeepAlive` / `keepAliveCard` 任何保活开关。** `keepMounted` 仅在菜单/浮层/portal 第三方库里出现，**与卡片无关**。【事实】
- **宿主没有提供任何让 App 修改自己 surface 的 `role`/`kind` 的 API。** `dispatchChalkboardLayoutCommand` 的 `updateSurface*` 类命令只处理 `updateSurfaceBounds` 与 `setDetachedSurfacePinMode`（且仅对 `kind:"detached"` 生效），**没有 setSurfaceRole / updateSurfaceRole**。【事实】
- **事实上的“切走不卸载”通道只有一条：把卡片 `detach` 成原生窗口（`kind:"detached", role:"floating"`）。** 原生窗口是独立 Electron WebContents，不进入 page-stage 的“停靠/隐藏”机制，因此不参与“切走卸载”。但这是用户/App 主动 `card.detach` 触发，**不是 App 能让其 docked 页卡自动保活的开关**。【事实 + 推断】
- **结论：v1.1.7 没有给 App 一个“切走不卸载”的口子。** 唯一可用手段是 App 自己请求（或引导用户）`card.detach` 到原生窗口，或接受 docked page 在桌面端以 `parked`（仍挂载）形式存活——后者对 hui 掉线现象的解释是：掉线**不是 renderer 卸载卡片**导致（桌面端 parked 仍挂载），更可能来自 (a) 移动端 `me()` 排除非活动页 / (b) App 自身连接逻辑对 active-page/focus 变化的反应 / (c) 宿主层对 WebContents 可见性或网络生命周期的处理。属【未决】。

---

## 1. surface 渲染 / 卸载判据（me() 及其调用链）

### 1.1 手机端 `me()` — 明确的“只渲染 active + persistent/floating”规则

`MobileChalkboardCardPage-CJrJR5oi.js` @2256（函数体，role 过滤在 @2346/@2369/@2377）：

```
function me(r,n=r.activeSurfaceId,i=de,l={}){
  const u=[n, ...Object.values(r.surfaces)
            .filter(f=>f.id!==n && (f.role==="persistent"||f.role==="floating"))
            .map(f=>f.id)]
          .filter(f=>!!f && !!r.surfaces[f]);
  const c=[];
  for(const f of u) J(r,f,r.surfaces[f].rootNodeId,null,c);   // 收集该 surface 下的 card 节点
  const h=new Set,
        b=c.filter(f=>{
              if(h.has(f.cardId))return!1; h.add(f.cardId);
              const p=r.cards[f.cardId];
              return !p || p.lifecycle!=="active" ? !1   // 仅 lifecycle==="active"
                     : Me(lr(p,l),"phone")              // 且 formFactor 适配手机
        });
  ...
  return D
}
```

- 收集待渲染 surface：`[activeSurfaceId] + (id!==active && (role==="persistent"||role==="floating"))`。【事实】
- 即：**非 active 且 role 不是 persistent/floating 的 surface，其下的卡片根本不进入 `b`，不会被渲染。**【事实】
- 桌面端无此同名函数；桌面走 `Su()`/`ku()`（见 §4）。`me()` 内还有 `Qr()`(返回 cardId 列表) 与 `J()`（递归节点收集），均仅用于手机页渲染。【事实】

### 1.2 桌面端卡片挂载机制（关键判据函数）

桌面卡片不按“active 过滤”来卸载，而是**每个 surface 一个 portal 宿主 `jje()`**（`CardShell-DFnq11Qk.js` @1673924）：

```
function jje({surfaceId:n,fixedPresentation:e}){
  const r=y(l=>l.chalkboardLayoutDocument),
        s=x$(r,n),            // 该 surface 当前活跃槽位的 card
        i=R2e(r,n);           // 该 surface 全部 card（含 lineage）
  ...
  return P2e(r,M2e([...A2e(r),...o1()])),
    u.jsx(u.Fragment,{children:a.map(l=>{ ...createPortal( 卡片组件 , hostDiv, l) })})
}
```

- `P2e()`（`CardShell-DFnq11Qk.js` @1673574）里有一段**卸载逻辑**：对 `sb`（portal 宿主 map）中**不再属于该 surface 的卡片做 `c.remove()` 并 `sb.delete(l)`**（DOM 移除）。【事实】
- 但 `jje` 是按 **surfaceId** 挂载的；**parked 的 page surface 仍拥有自己的 surfaceId 与卡片集合**，因此它的卡片**不会**因为“非 active”而被 `P2e` 移除。卸载仅发生在卡片真正离开该 surface（关闭/移动到别的 surface）时。【事实 + 推断】

---

## 2. surface role 的来源与可变性

### 2.1 role 取值集合（代码中出现的字面量）

- `persistent` — home / studio / page surface。
- `floating` — detached（原生窗口）。
- `transient` / `modal` — **代码中未出现任何 `role:"transient"` 或 `role:"modal"` 赋值**（仅在已知线索里被提到是概念集合，源码里无落地）。【事实】

### 2.2 role 在哪里被写死（全部由宿主 layout / 模板函数赋值）

| surface kind | role | 位置 |
|---|---|---|
| `home` | `persistent` | `index-DbjRpadG.js` @344112：`t[ct]={id:ct,kind:"home",role:"persistent",rootNodeId:lc,pageId:Ve,...}` |
| `studio` | `persistent` | `index-DbjRpadG.js` @346020：`surfaces:{...,[Ci]:{id:Ci,kind:"studio",role:"persistent",rootNodeId:cc,pageId:vs,...}}` |
| `page`（默认页模板） | `persistent` | `index-DbjRpadG.js` @346516：`f={...,[o]:{id:o,kind:"page",role:"persistent",rootNodeId:l,pageId:r,...}}`；@347665 同样 `kind:"page",role:"persistent"` |
| `detached`（原生窗口） | `floating` | `index-DbjRpadG.js` @365989 与 @369337：`{id:m,kind:"detached",role:"floating",rootNodeId:f,bounds:n,returnSurfaceId:ct,capabilities:{...canClose:!0}}` |

- 所有 role 都是**宿主在构造 layout 文档时写死的字面量**，不来自 App 清单或运行时可配置字段。【事实】

### 2.3 App 能否改变自己所在 surface 的 role —— 不能

- `dispatchChalkboardLayoutCommand` 的命令分支（`index-DbjRpadG.js` @374221 附近）与桌面副作用（`contributed-keybindings-CWd7VC-R.js` @120280）：
  - `updateSurfaceBounds`（仅 detached，存窗口位置）
  - `setDetachedSurfacePinMode`（仅 detached，钉住模式）
  - 其余为 `moveCard / closeCard / detachCard / dockCard / activateSlotChild / removePage / setFocus ...`
- **全量搜索 `setSurfaceRole` / `updateSurfaceRole` / `surfaceRole` 为零命中**。role 不是任何命令的可变字段。【事实】
- App 侧也没有任何 `realization`/manifest 字段能在运行时把 page surface 改成 floating 或反过来。【事实】

---

## 3. App 页卡打开落在哪个 surface，切走后是否还渲染

### 3.1 `card.open`（App，channel==="app"）落点

`app-host-view-vKO-k31j.js` @22303（手机端 `card.open` 分支）：

```
case"card.open":{
  ...
  const w=S.pluginCards.find(x=>x.pluginId===o.appId&&x.id===o.definitionId&&x.channel==="app");
  const y=g(()=>{
     S.setChalkboardActivePage(o.pageId);               // 切到目标 page
     const x=dt(o.appId,w);                              // 创建/复用 card 实例
     !x.existing && w.realization!=="page" && S.dispatchChalkboardLayoutCommand({kind:"moveCard",...,target:Ye(o.pageId)});
     const L=xe(k.getState().chalkboardLayoutDocument,x.cardInstanceId);
     return {...x, detached:L.kind==="detached"}         // 是否落在 detached 窗口
  });
  return l({cardInstanceId:y.cardInstanceId, existing:y.existing, detached:y.detached})
}
```

- 若 `realization==="page"`（hui 即此类），**不执行 moveCard**，卡片天然属于该 page surface；并 `setChalkboardActivePage(o.pageId)` 使其成为 active。【事实】
- `card.open` 返回 `detached:L.kind==="detached"`：即 App 页卡**也可能**落在 detached 原生窗口（当 `moveCard` 目标为 `kind:"detached"` 时）。【事实】

### 3.2 切走后是否还渲染

- 落到 `page` surface（role persistent）→ 桌面端由 `Su()` 渲染所有 page，**切走后该 surface 变 `parked` 但仍挂载**（§4）。【事实】
- 落到 `detached` 原生窗口（role floating）→ 独立窗口，**永不被停靠/隐藏机制影响**（§4/§5）。【事实】
- 落到其它 role 非 persistent/floating 的 surface（源码中不存在此类由 App 创建的路径）→ 在手机端 `me()` 下非 active 即不渲染；桌面端无此排除。【事实】

### 3.3 关闭保护

`app-host-view-vKO-k31j.js` @23796：
```
case"card.close":{
  const w=de(o.cardId);
  if(sn(w,S.chalkboardLayoutDocument))            // 是 primary page card
     throw K("APP_WORKSPACE_CARD_PRIMARY_PROTECTED","A page card can only be closed together with its page.");
  ...
}
```
- 页卡受保护：不能单独 close，必须连同 page 一起。【事实】

---

## 4. 切换 / 导航时的生命周期（桌面 page-host 行为）

### 4.1 谁是“活动页”的判据：`setChalkboardActivePage`

- reducer：`index-DbjRpadG.js` @702349（`setChalkboardActivePage:T=>...`）改 `activePageId`/`chalkboardActivePageId` 并算 `chalkboardLayoutTransitionEvent`。【事实】
- 调用点极多（`setChalkboardActivePage` 在 `app-host-view` / `CapabilitiesPanel` / `CardShell` / `contributed-keybindings` / `ChatTranscript` 中），均通过改 activePageId 触发转场。【事实】

### 4.2 桌面页宿主：渲染“所有”页面，非活动页 `parked`

`contributed-keybindings-CWd7VC-R.js`：
- `Su()` @105779：取 `e.activePageId, e.pageIds`，用 `Xa()`（转场状态机，含 `leavingId`/`currentId`）、`Ya()`（页面池）算出要渲染的全部 `pageIds`，然后：
```
const d=new Set(n), u=[...s];
a.currentId!==ve && d.has(a.currentId) && !u.includes(a.currentId) && u.push(a.currentId);
a.leavingId!==null && a.leavingId!==ve && d.has(a.leavingId) && !u.includes(a.leavingId) && u.push(a.leavingId);
...
children:[
  o.jsx(Yn,{id:ve, slide:a, settle:r, children:o.jsx(Xn,{viewportActive:Qn(f)})}),  // 当前页
  u.map(h=>o.jsx(Yn,{id:h, ..., children:o.jsx(Xn,{pageId:h, viewportActive:Qn(m)})})) // 其它页（含 parked）
]
```
- `Qn(e)` @105406：`return e==="current"||e==="entering"` → 非 current/entering 即 `viewportActive:false`。
- `Yn()` @105406 给非活动页打 `data-parked` 属性（`"data-parked":i||void 0`），即**停靠/滑出但仍在 DOM 树中**。
- 每页经 `Xn()` → `ku()`（`ku()` @102053）。`ku` 给 `<main data-chalkboard-canvas ... data-chalkboard-viewport-active={n||void 0}>`；非 active 页该属性**缺省（不写 true）**。【事实】

### 4.3 是“隐藏”还是“移除”？—— 桌面是「停靠/隐藏（parked，CSS 位移）」，不是移除

- 代码层面：parked 页仍被 `Yn` 渲染、`ku` 仍挂载 `<main data-chalkboard-canvas>` 与卡片 portal（`jje` 按 surfaceId 挂载且不被 `P2e` 移除，见 §1.2）。没有 `display:none`、没有 `remove()`。【事实】
- 非 active 页的“停泊”是 **CSS transform/translate 滑出停靠**（`pageSlideMs` 转场，见 `Xa`/`Vt` 的 `slideLeaveToLeft/Right`），不是 DOM 卸载。【事实 + 推断】
- 这与“Electron `display:none` 冻结 guest”那类现象**不同**：本宿主用的是 offscreen 位移停靠，从 renderer 角度 iframe/guest 仍挂载存活。【推断】

### 4.4 未决 / 风险点

- 页面池 `Ya()`（`contributed-keybindings-CWd7VC-R.js` @68242）有容量参数 `On=4`（`const On=4;`），超出容量的页面可能被移出 `alive` 池从而**卸载**。正常 2~3 个页面（如 hui 页 + 聊天页）不会触发；但若同时开 >4 个 page，久不访问的 page 可能被 evict。【推断 / 未决】

---

## 5. 有没有“保活 / 常驻”机制

### 5.1 卡片语境的保活开关 —— 没有

- 全量文件搜索：`keepAlive` / `keepAliveCard` / `stayMounted` / `pinToKeepAlive` 在**卡片语境为零命中**。`keepMounted` 仅出现在 `ChatTranscript` / `SettingsForm.module` / `model-favorites-actions` 的**菜单/portal/浮层**库（`keepMounted:r=!1`）里，**与卡片无关**。【事实】

### 5.2 surface 层面的“常驻” = role persistent / floating（内部写死，App 不可改）

- `persistent`：home/studio/page 默认即 persistent → 手机端 `me()` 中“非 active 但 persistent 仍渲染”。【事实】
- `floating`：detached 原生窗口 → 手机端 `me()` 中“非 active 但 floating 仍渲染”，桌面端则根本不进 page-stage。【事实】

### 5.3 detached（原生窗口）是否“不参与切走卸载” —— 是

- `kind:"detached"` surface 在 `ub()`（`index-DbjRpadG.js` @369079）创建：`{id:m,kind:"detached",role:"floating",rootNodeId:f,bounds:n,returnSurfaceId:l.id,...}`，它**带真实窗口 bounds**，且：
  - 桌面 `Su()` 的 page-stage **只渲染 page 类型**（经 `vu()`/`Mr()` 解析），detached 走独立 `Au()` 原生窗口宿主（`contributed-keybindings-CWd7VC-R.js` @36924 附近，用 `window.hana.chalkboardMinimizeDetached` 等宿主桥）。【事实】
  - 切到别的 page 时，detached 窗口**不在 page-stage 内**，因此从不被 parked/隐藏；它是独立 Electron WebContents，只有用户关闭窗口才销毁。【事实 + 推断】
- 所以：**detached 是唯一“切走不卸载”的通道**，但它是用户/App 主动 `card.detach`（见 §3.1 的 `detached:L.kind==="detached"`、`app-host-view` 的 `case"card.detach"` @24521）产生的，**不是 docked 页卡的自动保活**。

---

## 6. 结论：新版 renderer 有没有给 App 一个“切走不卸载”的口子

**没有。**【事实 + 推断】

- **没有任何卡片级保活 API**：无 `keepMounted`/`keepAlive`/`stayMounted`/`pinToKeepAlive`/`keepAliveCard`（§5.1）。
- **App 不能改 surface 的 role/kind**：`role` 由宿主 layout 写死（§2.2），无 `setSurfaceRole`/`updateSurfaceRole`，`updateSurface*` 命令只处理 detached 的 bounds/pin（§2.3）。
- **App 页卡默认落在 `page`(persistent) surface**：桌面端切走后只是 `parked`（仍挂载），从 renderer 看并未卸载（§1.2/§4.2/§4.3）；但这是宿主布局决定，**App 没有“强制保持 active/不被 parked”的手段**。
- **唯一可用手段（非“口子”而是既定机制）**：App 自行（或引导用户）把卡片 `card.detach` 到原生窗口（`role:"floating"`），使其脱离 page-stage 停靠机制，从而切走页面也不会被 parked；但这需要 detached 窗口自身独立存活，且是主动操作而非自动保活（§5.3）。

**对“hui 切出掉线”的解释建议（未决，待运行时/宿主层确认）**：renderer 层面 docked page 在桌面端不会因切走而卸载（仅 parked 仍挂载），故“掉线”更可能来自：
1. 用户若处于**移动端**场景 → `me()` 会排除非 active 且非 persistent/floating 的页（但 hui 是 page=persistent，理论上仍渲染；除非 hui 卡片 `lifecycle!=="active"` 或 formFactor 不适配手机）；
2. **App 自身连接逻辑**对 activePageId/focus 变化作出断连反应；
3. **宿主/Electron 层**对 parked 页里 WebContents 的可见性或网络生命周期处理（renderer 代码看不出，属宿主实现未决项）。

---

## 7. 关键证据清单（文件 : 偏移）

| 主题 | 文件 : 偏移 | 成色 |
|---|---|---|
| `me()` 渲染判据（active + persistent/floating） | `MobileChalkboardCardPage-CJrJR5oi.js` @2256（role 过滤 @2346/@2369/@2377） | 【事实】 |
| desktop 卡片 portal 宿主 + 卸载逻辑 `jje`/`P2e` | `CardShell-DFnq11Qk.js` @1673924 / @1673574 | 【事实】 |
| home surface role=persistent | `index-DbjRpadG.js` @344112 | 【事实】 |
| studio surface role=persistent | `index-DbjRpadG.js` @346020 | 【事实】 |
| page surface role=persistent（两份模板） | `index-DbjRpadG.js` @346516 / @347665 | 【事实】 |
| detached surface role=floating | `index-DbjRpadG.js` @365989 / @369337 | 【事实】 |
| `card.open`（App）落点与 detached 判定 | `app-host-view-vKO-k31j.js` @22303 / @22398 | 【事实】 |
| `card.close` 抛 PRIMARY_PROTECTED | `app-host-view-vKO-k31j.js` @23796 | 【事实】 |
| `setChalkboardActivePage` reducer | `index-DbjRpadG.js` @702349 | 【事实】 |
| desktop 页宿主（渲染所有页 + parked）`Su` | `contributed-keybindings-CWd7VC-R.js` @105779 | 【事实】 |
| `parked`/viewportActive 判定 `Yn`/`Qn` | `contributed-keybindings-CWd7VC-R.js` @105406 | 【事实】 |
| `ku` 每页 canvas + `data-chalkboard-viewport-active` | `contributed-keybindings-CWd7VC-R.js` @102053 / @103742 | 【事实】 |
| 页面池容量 `On=4` | `contributed-keybindings-CWd7VC-R.js` @68038 | 【事实】 |
| `updateSurface*` 仅 bounds/pin（detached） | `index-DbjRpadG.js` @374221；`contributed-keybindings-CWd7VC-R.js` @120280 | 【事实】 |
| 无 keepAlive/stayMounted/keepAliveCard（卡片语境） | 全量扫描：零命中（keepMounted 仅菜单/portal 库） | 【事实】 |
| detached 原生窗口创建 `ub` | `index-DbjRpadG.js` @369079 | 【事实】 |
| `card.detach` / `card.dock` 命令 | `app-host-view-vKO-k31j.js` @24521 / @24825 | 【事实】 |
| 宿主桥 raise detached | `ChatTranscript-BxBnKgs8.js` @647332 | 【事实】 |

---

## 8. 未决（需进一步确认）

1. **parked 页的 WebContents 是否仍“在线”**：renderer 保留 DOM/portal，但 Electron 在 parked/offscreen 的 `<webview>`/BrowserView 是否仍保活由宿主决定，renderer 不可见。需查宿主（main 进程 / AppUiSurface）实现。
2. **页面池容量 `On=4` 的 evict 行为**：开 >4 page 时久不访问页是否真卸载；hui 双页场景不受影响，但需明确。
3. **App 连接逻辑对 active-page 的反应**：hui/ComfyUI 集成是否监听 `activePageId`/`focus` 并主动断连——属 App 侧代码（非本 renderer 普查范围）。
4. **移动端 `me()` 对 hui 的实际影响**：若用户在移动端，需确认 hui 卡片 `formFactor("phone")` 是否与 `lifecycle:"active"` 同时满足，否则仍会被排除。
