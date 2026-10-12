# 探索：宿主如何管理 App 卡（工作区卡 / iframe）的生命周期

**项目**：hui（Hana-ComfyUI，`comfyui-hana` v0.12.0）
**宿主**：HanaAgent（Electron，渲染层 `1.0.16-beta-win32-x64-8cd261f5e250c427-g4766b18a7fa3eb5a`）
**探索时间**：2026-10-12
**成色**：`[实测]` 亲手核实过的文件/行 · `[未证实]` 未能取证

---

## 一、判决性证据（主脑独立复核过）

### 1. 宿主对「看不见的对话内卡片」明确 unload + 按 saved state 重建 `[实测]`
> `C:\Users\John Galt\.hanako\card-guide\guide.md:180`（原文）：
> "the host starts a card only once it first comes into view; while it is out of view its tool channel stays closed… and **once it has been scrolled far enough away the host unloads it and starts it again from its saved state when it returns**. Your card does not need to detect or work around any of this. **Keep whatever must survive in `state`, not in script variables**…"

**这是宿主亲口写在契约里的策略**：看不见 → 卸载 → 回来按 saved state 重建。
`guide.md:184` 补充：「`state.set` 被宿主保存，**survives the card being unloaded and started again**, and the app restarting」。

→ 直接印证排查判据「n 归零 = 页面被销毁重建」。**宿主是主动方**，不是 Chromium 自作主张（M1 占优）。

### 2. 宿主**懂得**保活式隐藏，但那是另一分支 `[实测]`
> `browser-viewer.html` 内联注释：「全部 tab 常驻 DOM，仅激活 tab 可见……**隐藏一律走 visibility（`display:none` 会冻结 guest，禁止使用）**」

宿主对 browser viewer 有"保活不销毁"的先例。但这条作用于 browser viewer，**不是 App 工作区卡**——说明宿主有两套口径，工作区卡（卡态）走的是「卸载」那套。

### 3. 工作区卡在 manifest 里声明为「持久整面卡」 `[实测]`
> `apps/comfyui-hana/manifest.json`：`"id":"workspace", "realization":"page", "fpFullPanel":true, "closable":false, "detached":{"route":"/workspace.html"}`

渲染层代码确认该声明被消费（`CardShell-ys_Cgkwf.js`：`cO(f?.fpFullPanel===!0 && f.realization==="page")`）。
**但**：`realization:"page"` 只描述"整页"形态，**并不等于"常驻不卸载"**——宿主未在渲染层暴露任何 keepAlive 字段给它。

### 4. App 卡渲染在 sandboxed-iframe 内 `[实测]`
> `ChatTranscript-BztDPXYb.js:970-973`：`webViewSurface: { officialName:'WebView', implementation:'sandboxed-iframe', source:'current-card-frame' }`
> `card-guide/guide.md:3`：「render inside an iframe in Hana's chat」

### 5. 全 `.hanako` 域无「卡保活 / 后台节流」开关 `[实测]`
`backgroundThrottling` / `keepAlive` / `keep-alive` / 宿主级 `throttle` 全量 JSON 检索：**均未命中**。
→ **不存在**任何宿主层可调的"卡挂载保持"配置。

---

## 二、渲染层抠包结果（App 卡挂载路径）`[实测]`

`CardShell-ys_Cgkwf.js`（1.58 MB 单行）关键词扫描：
- `realization` x1、`fpFullPanel` x1 → 命中卡片形态判定（见上 §1.3）
- `detached` x38 → 全是"卡拖出成独立窗"的布局命令（`detachCard` / `createChalkboardCardInstance`），**与卡 iframe 的隐藏/销毁无关**
- `visibility` x41 → 全是 `document.visibilityState` 的**预览/媒体**用途（`preview.mediaPausedInactive`），非卡的隐藏机制
- `removeChild` x20 / `unmount` x5 → **全部落在 ProseMirror 富文本编辑器**（`ProseMirror-gapcursor`、`editorView.destroy`），与卡挂载无关
- `APP_WORKSPACE_CARD_STATE_TOO_LARGE`、`APP_WORKSPACE_SLOT_OWNER_INVALID` → 命中了 `APP_WORKSPACE_*` 错误码族

→ **卡的 iframe 挂载/卸载具体代码路径未在此 bundle 抽出**（压缩单行，字符级上下文不可靠）；**未证实**。

---

## 三、未证实（不编造）

1. **`APP_WINDOW_UI_OPERATION_UNAVAILABLE` 错误码**：渲染层 `assets/*.js` 全量 grep **未命中**。该码与 `hana.cards.open("workspace")` 的拦截逻辑应在 **preload / main 进程**（本渲染层快照不含 preload/main）→ **未证实**。（衔接踩坑记录 §38：agent 无法程序化打开整页卡，10-10 实测。）
2. **App 整页工作区卡是否走 guide.md:180 的 unload 路径**：宿主是 60KB~1.58MB 单行压缩包，只读工具有 50KB 上限 + grep 500 字截断 → 无法抽取判据 → **未证实**。
   但**心跳数据（另一线）已从现象侧坐实**：宿主大卡确实反复 n 归零重建。
3. **官方文档 / issue**：openhanako.com 仅营销页，无技术文档；GitHub issue 未检索到相关条目 → **未证实**。

---

## 四、对 hui 的直接提示

- 工作区卡虽声明 `realization:"page"` 持久卡，但**宿主未给它任何保活承诺**；实测（心跳数据）它会被反复销毁重建。
- 宿主对「看不见的卡」的统一口径就是 **unload + saved-state 重建**（guide.md:180），且明言"**卡片不要把必须存活的东西放在脚本变量里，要放 `state`**"。
- 所以 hui 侧的页内心跳探针（`setupThrottleProbe`，把 `n` 存脚本闭包变量）**天然保不住**——页面一被卸载，闭包与 timer 全没了，这正是 n 归零的机理。
- **保活的正确方向不在 App 侧（App 无法阻止宿主卸载自己）**，而在：
  (a) 宿主侧需求——给 `realization:"page"` 或工作区卡一个"常驻/不卸载"选项；
  (b) 或改用宿主**不会卸载**的形态（原生窗口 `detached`，已实测 hidden 下 1~3ms 应答）。
