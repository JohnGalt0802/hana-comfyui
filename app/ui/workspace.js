// ui/workspace.js — ComfyUI 工作区壳页（v2 App 卡片/ui 静态树）
// 三态：booting / ready / error；ready 时内层 iframe 指向宿主代理路径下的 ComfyUI 官方前端。
// 连接方式两种形式并存（宿主阶段对比验证）：
//   · sdk：hana.api.url("/_runtime/<runtimeId>/") —— 官方推荐，含 surface 凭证段
//   · raw：boot-state.proxyPrefix 直接相对路径 —— 依赖宿主登录态授权
// 凭据不入日志、不落存储（localStorage 只存"模式"这个非敏感枚举）。
import { hana } from "./assets/sdk.js";

const $ = (id) => document.getElementById(id);
const els = {
  bar: $("ws-bar"), barText: $("ws-bar-text"), barAction: $("ws-bar-action"), barAction2: $("ws-bar-action2"),
  barReload: $("ws-bar-reload"), handoffBtn: $("ws-handoff"),
  loading: $("ws-loading"), frameWrap: $("ws-frame-wrap"), frame: $("ws-frame"),
  boot: $("view-booting"), bootNote: $("boot-note"), bootMeta: $("boot-meta"),
  bootRawWrap: $("boot-raw-wrap"), bootRaw: $("boot-raw"),
  err: $("view-error"), errNote: $("err-note"), errMeta: $("err-meta"),
  errRawWrap: $("err-raw-wrap"), errRaw: $("err-raw"),
  offline: $("view-offline"), offNote: $("off-note"), offWait: $("off-wait"), offMeta: $("off-meta"),
};

const MODE_KEY = "comfyui-hana.workspace.urlMode";
let mode = "auto";
try { mode = localStorage.getItem(MODE_KEY) || "auto"; } catch { mode = "auto"; }

let bootTimer = null;
let statusTimer = null;
let frameRuntimeId = null; // 已装载 iframe 对应的 runtimeId；变化即整页重载
let frameLoaded = false;

// ── 服务不可达「去抖」与恢复「重载闸门」（2026-09-29，修「生图中假性未启动 + 进度丢失」）──
// 背景：重负载下后端 /system_stats 迟滞数秒 → 中继探测曾单次即翻 → 覆盖层误报 +
// 恢复时强制重载 iframe 致运行中进度丢失（docs/中继稳定性修复-20260929.md）。
// ① 覆盖层去抖：连续 ≥OFFLINE_DEBOUNCE_TICKS 轮（轮询 3s）不可达才显示；
// ② 重载闸门：仅「离线期间有显式启动请求」或「当前 frame 非已知可达期加载」才重载（§20 场景保留）。
const OFFLINE_DEBOUNCE_TICKS = 3;
let unreachableStreak = 0;   // 连续不可达轮数（可达即清零）
let lastReachKnown = null;   // 最近一次观测到的可达性（null=尚未观测）
let frameLoadOk = false;     // 当前 iframe 文档是否「加载于已知可达期」（或启动加载已被健康状态确认）
let frameBootPending = false; // 启动时加载、可达性未定，等首个健康状态确认
let statusGap = false;       // fetch 失败致盲窗口（2026-10-08，P5 盲区①）：也计入「曾离线」，
                             // 恢复时不得当作「从未离线」，否则坏帧等不到重载
let offlineSince = 0;        // 本轮离线观测起点（2026-10-08）：判定「离线期间有无显式启动请求」用

function offlineDebounced(streak) { return streak >= OFFLINE_DEBOUNCE_TICKS; }
function frameReloadNeeded(askedStart, frameOk) { return askedStart || !frameOk; }

// ── 主题 ──────────────────────────────────────────────────────────────────
function hostThemeIsDark() {
  let snap = null;
  try { snap = hana.theme?.getSnapshot?.() || null; } catch { snap = null; }
  const label = String(snap?.theme || "");
  let dark = snap?.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
  if (!snap?.appearance && (!label || label === "inherit")) {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  return dark;
}

function syncTheme() {
  document.body.classList.toggle("t-dark", hostThemeIsDark());
  ensureComfySync();
  onThemeMaybeChanged(); // 跨源（直连）时：主题走 ComfyUI 服务端设置
}

// ── ComfyUI 前端色板跟随（内层 iframe 同源直控）───────────────────────────
// 壳页与内层 iframe 同在宿主域 → 直接访问 contentWindow 里的 legacy app
// （GraphCanvas 就绪后挂 window.app）→ 用 app.ui.settings 读写 Comfy.ColorPalette。
// 策略：仅当「明暗对立」时切换（宿主 dark ↔ 色板 light 系），用户自选的
// 同明暗色板（nord / 自定义深色等）不打扰；触发时机：壳页加载 / iframe 每次
// load / 宿主主题变化。写入经 ComfyUI 自身设置链路（含服务端持久化）。
const CORE_DARK_PALETTES = new Set(["dark", "solarized", "arc", "nord", "github"]);
const PALETTE_SYNC_TICK_MS = 500;
const PALETTE_SYNC_MAX_TICKS = 48; // 约 24s
let paletteSyncTimer = null;
let paletteSyncTicks = 0;
let paletteSyncBlocked = false;
let paletteJustSwitched = false;

function paletteIsLight(settings, id) {
  if (!id) return null;
  if (id === "light") return true;
  if (CORE_DARK_PALETTES.has(id)) return false;
  try { // 自定义色板：读它的 light_theme 声明；读不到按未知处理
    const customs = settings.getSettingValue("Comfy.CustomColorPalettes") || {};
    const p = customs[id];
    if (p && typeof p.light_theme === "boolean") return p.light_theme;
  } catch { /* 忽略 */ }
  return null;
}

function syncComfyPalette() {
  if (paletteSyncBlocked) return "blocked";
  let settings = null;
  try {
    const win = els.frame && els.frame.contentWindow;
    settings = win && win.app && win.app.ui && win.app.ui.settings;
  } catch (e) {
    paletteSyncBlocked = true; // 跨源被拒：重复尝试无意义
    console.warn("[comfyui-hana] 内层 iframe 不可访问（跨源限制），ComfyUI 主题跟随停用。", e);
    return "blocked";
  }
  if (!settings || typeof settings.setSettingValue !== "function" || typeof settings.getSettingValue !== "function") {
    return "pending"; // 内层前端尚未就绪
  }
  const target = hostThemeIsDark() ? "dark" : "light";
  let current = null;
  try { current = settings.getSettingValue("Comfy.ColorPalette"); } catch { current = null; }
  if (current === target) return "done";
  const currentLight = paletteIsLight(settings, current);
  if (currentLight !== null && currentLight === (target === "light")) return "done"; // 明暗已一致
  try {
    settings.setSettingValue("Comfy.ColorPalette", target);
    paletteJustSwitched = true; // 基座换肤异步落定；下一拍再应用主题色，避免被 loadColorPalette 冲掉
    console.log(`[comfyui-hana] ComfyUI 色板跟随宿主主题：${current || "(未知)"} → ${target}`);
    return "done";
  } catch (e) {
    console.warn("[comfyui-hana] ComfyUI 色板切换失败：", e);
    return "pending"; // 可能是时序问题，留给轮询重试
  }
}

// ── 宿主主题色映射（ComfyUI 使用宿主主题配色）────────────────────────────
// 数据源：宿主主题 CSS（hana-css → /api/apps/theme.css?theme=…，变量为 :root 作用域）。
// 壳页 fetch + 解析出变量表，写入内层 iframe：
//   ① CSS 变量覆盖（!important 压过 ComfyUI 的内联样式）→ 全局/面板/输入框/Vue 节点
//   ② LiteGraph 与 canvas 走 JS 赋值（画布绘制不吃 CSS）→ 节点配色与连线
// 与基座（dark/light 色板）配合：基座提供未映射部分（插槽色/背景图等），本层改造主题色。
const HANA_CSS_MAP = [
  ["--bg-color", "--bg"],
  ["--fg-color", "--text"],
  ["--comfy-menu-bg", "--sidebar-bg"],
  ["--comfy-menu-secondary-bg", "--bg-card"],
  ["--comfy-menu-hover-bg", "--accent-light"],
  ["--comfy-input-bg", "--bg-card"],
  ["--input-text", "--text"],
  ["--descrip-text", "--text-muted"],
  ["--drag-text", "--text-muted"],
  ["--error-text", "--danger"],
  ["--border-color", "--border"],
  ["--tr-even-bg-color", "--bg"],
  ["--tr-odd-bg-color", "--bg-card"],
  ["--content-bg", "--bg-card"],
  ["--content-fg", "--text"],
  ["--content-hover-bg", "--accent-light"],
  ["--content-hover-fg", "--text"],
  // Vue 节点渲染（1.x 组件化节点的样式变量）
  ["--component-node-border", "--border"],
  ["--component-node-background", "--bg-card"],
  ["--component-node-widget-background", "--bg"],
  ["--component-node-foreground", "--text-light"],
  ["--node-component-header", "--text"],
  ["--node-component-header-surface", "--sidebar-bg"],
  ["--node-component-header-icon", "--text-muted"],
  // 新前端（1.x）新增的面板/顶栏变量（2026-09-25 从内置色板键表对比补齐；
  // 缺这几个时“左侧设置栏 / 顶部标签栏”会停在内置色板的原色）
  // 2026-10-11 回归修复（左侧栏不跟随宿主主题）：补 interface-panel-surface / interface-stroke 两条。
  // interface-panel-surface 是这一族的**基底**——内置色板里 hover/selected-surface 都是
  // color-mix(in srgb, var(--interface-panel-surface) …, var(--contrast-mix-color)) 派生，
  // 此前漏映射 → 左侧栏拿内置色板原色（暗色 charcoal/#000 系），与宿主主题脱节；
  // interface-stroke 是面板/栏位的描边色，同属该族基色。
  ["--interface-panel-surface", "--sidebar-bg"],
  ["--interface-stroke", "--border"],
  ["--interface-panel-hover-surface", "--accent-light"],
  ["--interface-panel-selected-surface", "--accent-light"],
  ["--interface-panel-box-shadow", "--shadow"],
  ["--interface-panel-drop-shadow", "--shadow"],
  ["--bar-shadow", "--shadow"],
  ["--contrast-mix-color", "--text-muted"],
];
const HANA_JS_MAP = [
  ["NODE_TITLE_COLOR", "--text"],
  ["NODE_SELECTED_TITLE_COLOR", "--accent"],
  ["NODE_TEXT_COLOR", "--text-light"],
  ["NODE_TEXT_HIGHLIGHT_COLOR", "--text"],
  ["NODE_DEFAULT_COLOR", "--sidebar-bg"],
  ["NODE_DEFAULT_BGCOLOR", "--bg-card"],
  ["NODE_DEFAULT_BOXCOLOR", "--border"],
  ["NODE_BOX_OUTLINE_COLOR", "--border"],
  ["WIDGET_BGCOLOR", "--bg"],
  ["WIDGET_OUTLINE_COLOR", "--border"],
  ["WIDGET_TEXT_COLOR", "--text"],
  ["WIDGET_SECONDARY_TEXT_COLOR", "--text-muted"],
  ["WIDGET_DISABLED_TEXT_COLOR", "--text-muted"],
  ["LINK_COLOR", "--accent"],
  ["EVENT_LINK_COLOR", "--coral"],
  ["CONNECTING_LINK_COLOR", "--accent-hover"],
  ["CLEAR_BACKGROUND_COLOR", "--bg"],
  ["BADGE_BG_COLOR", "--accent"],
  ["BADGE_FG_COLOR", "--bg"],
  ["NODE_ERROR_COLOUR", "--danger"],
  ["NODE_BYPASS_BGCOLOR", "--bg-card"],
  ["DEFAULT_SHADOW_COLOR", "--border"],
];
const HANA_VAR_FALLBACK = { "--coral": "--accent-hover", "--sidebar-bg": "--bg-card", "--shadow": "--border" };
const CANVAS_SHADE_DARK = 0.15;  // 画布底色：深色主题相对 --bg 加深比例（朝黑）
const CANVAS_SHADE_LIGHT = 0.4;  // 浅色主题相对 --bg 提亮比例（朝白）
let hanaThemeVars = null;
let hanaThemeVarsUrl = null;
let hanaThemeVarsInflight = null;

function hostThemeCssUrl() {
  try { return hana.theme?.getSnapshot?.()?.cssUrl || null; } catch { return null; }
}

function parseThemeCssVars(cssText) {
  const vars = {};
  const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)[;}]/g;
  let m;
  while ((m = re.exec(cssText))) {
    const name = m[1];
    const value = m[2].trim();
    if (!value || value.startsWith("url(")) continue; // 跳过背景图等非色值
    vars[name] = value;
  }
  return vars;
}

function fetchHostThemeVars(force = false) {
  const url = hostThemeCssUrl();
  if (!url) return;
  if (!force && hanaThemeVars && hanaThemeVarsUrl === url) return;
  if (!force && hanaThemeVarsInflight && hanaThemeVarsInflight.url === url) return; // 已在取
  const promise = fetch(url, { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("theme css HTTP " + r.status))))
    .then((text) => {
      hanaThemeVars = parseThemeCssVars(text);
      hanaThemeVarsUrl = url;
      return hanaThemeVars;
    })
    .catch((e) => { console.warn("[comfyui-hana] 宿主主题变量获取失败：", e); return null; })
    .then((vars) => {
      if (hanaThemeVarsInflight && hanaThemeVarsInflight.promise === promise) hanaThemeVarsInflight = null;
      return vars;
    });
  hanaThemeVarsInflight = { url, promise };
}

function hanaVar(name) {
  if (!hanaThemeVars) return null;
  let v = hanaThemeVars[name];
  if (!v) { const fb = HANA_VAR_FALLBACK[name]; if (fb) v = hanaThemeVars[fb]; }
  return v || null;
}

function cssColorToRgb(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function shadeRgb(rgb, towardBlack, ratio) {
  const target = towardBlack ? 0 : 255;
  const c = rgb.map((val) => Math.round(val + (target - val) * ratio));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function buildHanaOverrideCss() {
  const lines = [":root {"];
  for (const [comfyVar, hostVar] of HANA_CSS_MAP) {
    const v = hanaVar(hostVar);
    if (v) lines.push(`  ${comfyVar}: ${v} !important;`);
  }
  lines.push("}");
  return lines.join("\n");
}

function applyHanaThemeVars() {
  if (paletteSyncBlocked) return true;
  let win = null, doc = null;
  try {
    win = els.frame && els.frame.contentWindow;
    doc = win && win.document;
  } catch { return true; }
  if (!doc || !doc.documentElement) return false; // 内层未就绪
  if (!hanaThemeVars) return false;               // 变量未就绪

  // ① CSS 覆盖（!important 压过 ComfyUI 内联变量）
  const css = buildHanaOverrideCss();
  let el = doc.getElementById("hana-comfy-theme");
  if (!el) {
    el = doc.createElement("style");
    el.id = "hana-comfy-theme";
    (doc.head || doc.documentElement).appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;

  // ② LiteGraph / canvas（画布绘制，CSS 管不到）
  try {
    const LG = win.LiteGraph;
    if (LG) for (const [key, hostVar] of HANA_JS_MAP) {
      const v = hanaVar(hostVar);
      if (v) LG[key] = v;
    }
    const cv = win.app && win.app.canvas;
    if (cv) {
      const t = hanaVar("--text"), a = hanaVar("--accent");
      if (t) cv.node_title_color = t;
      if (a) cv.default_link_color = a;
      // 画布底色：在 --bg 之上再沉一层/提一层，与面板拉开层次（不直接用主题色）
      const bgRgb = cssColorToRgb(hanaVar("--bg") || "");
      if (bgRgb && cv.clear_background_color !== "transparent") {
        const darkCanvas = hostThemeIsDark();
        cv.clear_background_color = shadeRgb(bgRgb, darkCanvas, darkCanvas ? CANVAS_SHADE_DARK : CANVAS_SHADE_LIGHT);
      }
      if (typeof cv.setDirty === "function") cv.setDirty(true, true);
    }
  } catch (e) {
    console.warn("[comfyui-hana] ComfyUI 主题色写入失败：", e);
  }
  return true;
}

// ── 宿主主题 → ComfyUI 服务端（跨源下的主题跟随）─────────────────────────────
// iframe 直连 8188 后跨源：壳页摸不到 contentWindow，applyHanaThemeVars / applyHanaThemeVars 全会被 blocked。
// 改道：把宿主主题写成 ComfyUI 自己的**自定义色板**（id = hana，键名与 HANA_CSS_MAP / HANA_JS_MAP 同源），
// 并在 iframe 加载**之前**推送，前端一起来就带着宿主配色（无需强刷正在编辑的画布）。
// 代价：切换宿主主题后需刷新工作区才生效（不自动重载，避免打断编辑）。
let themePushedFor = null;   // 已推送成功的主题签名（明暗 + cssUrl），避免重复推
let themePushInflight = false;
let themeStaleAfterLoad = false; // 已写入服务端，但当前 iframe 还是旧色板 → 自动重载工作区
let frameIsDirect = false;  // 当前工作区 iframe 是否跨源直连（跨源才需要“推送 + 重载”这条路）
let themeRefreshTimer = null;

function themeSignature() {
  return `${hostThemeIsDark() ? "dark" : "light"}|${hanaVar("--bg") || ""}|${hostThemeCssUrl() || ""}`;
}

// 主题变化检测：不依赖宿主向 App iframe 推送主题变化事件（实测切主题后壳页收不到 subscribe 回调），
// 也不依赖 SDK 快照的实时性——直接重新拉宿主主题 CSS，比对解析后的色值签名。
let themeSigSeen = null;
async function themeWatchTick() {
  const url = hostThemeCssUrl();
  if (!url) return;
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const vars = parseThemeCssVars(await r.text());
    const sig = `${vars["--bg"] || ""}|${hostThemeIsDark() ? "dark" : "light"}`;
    if (!themeSigSeen) { themeSigSeen = sig; hanaThemeVars = vars; hanaThemeVarsUrl = url; return; } // 首帧只记录
    if (sig === themeSigSeen) return;
    themeSigSeen = sig;
    hanaThemeVars = vars;      // 用刚取到的新值，绕开按 URL 的缓存
    hanaThemeVarsUrl = url;
    onThemeMaybeChanged();
  } catch { /* 下一拍再试 */ }
}

// 明暗判定（看色值，不看主题名）：跨源后壳页拿到的快照字段可能缺 appearance，
// 早期实现回落到系统偏好，结果浅色主题被标成 dark（light_theme=false），基座跑深色默认值。
// 改用 --bg 的实际亮度：luma > 0.5 即浅色。
function themeIsLightByColor() {
  const rgb = cssColorToRgb(hanaVar("--bg") || "");
  if (!rgb) return null;
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luma > 0.5;
}

async function pushThemeToComfyServer(force = false) {
  const sig = themeSignature();
  if (!force && sig === themePushedFor) return { ok: true, skipped: "unchanged" };
  // 前一次还在飞就等它落地，不要直接失败：主题钩子常与 iframe 首帧加载的推送撞车
  // （2026-09-25 实测：hook 拿到 inflight 直接放弃 → 主题没写进 ComfyUI，也没触发重载）
  for (let i = 0; i < 30 && themePushInflight; i++) await new Promise((r) => setTimeout(r, 200));
  if (themePushInflight) return { ok: false, error: "inflight-timeout" };
  themePushInflight = true;
  try {
    fetchHostThemeVars(force); // 幂等；force 时强制重取（主题同名换肤时 URL 不变，缓存会拦住）
    if (force) { hanaThemeVars = null; hanaThemeVarsUrl = null; fetchHostThemeVars(true); }
    for (let i = 0; i < 25 && !hanaThemeVars; i++) await new Promise((r) => setTimeout(r, 200));
    const dark = hostThemeIsDark();
    const lightByColor = themeIsLightByColor(); // 色值优先：主题名/系统偏好都不可靠
    const lightTheme = lightByColor === null ? !dark : lightByColor;
    const comfy_base = {};
    const litegraph_base = {};
    // 色板的 comfy_base 键名**不带 `--`**（内置色板就是 "bg-color" 这种写法，应用时才加前缀）。
    // 早前直接照搬 CSS 变量名（--bg-color）导致整块色板对不上号，面板/顶栏停在内置原色（2026-09-25 定位）。
    for (const [k, hostVar] of HANA_CSS_MAP) { const v = hanaVar(hostVar); if (v) comfy_base[k.replace(/^--/, "")] = v; }
    for (const [k, hostVar] of HANA_JS_MAP) { const v = hanaVar(hostVar); if (v) litegraph_base[k] = v; }
    // 拿得到宿主变量 → 自定义色板（面板 + 画布/节点）；拿不到 → 退化为只跟随明暗
    const body = Object.keys(comfy_base).length
      ? { colors: { comfy_base, litegraph_base }, lightTheme }
      : { palette: lightTheme ? "light" : "dark" };
    const r = await hana.api.fetch("/comfyui-hana/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      themePushedFor = sig;
      console.log("[comfyui-hana] 宿主主题已写入 ComfyUI 设置：", j.applied || j);
    } else {
      console.warn("[comfyui-hana] 主题写入失败：", j && j.error);
    }
    return j;
  } catch (e) {
    console.warn("[comfyui-hana] 主题写入异常：", e);
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    themePushInflight = false;
  }
}

// 主题变化时：只在 iframe 已加载且处于直连模式时推服务端，然后刷新工作区。
// 刷新用 location.reload()（等价用户手按 Ctrl+R）——早前只置空 frameRuntimeId 重设 iframe.src，
// 但同一个 src 浏览器不会重新加载，等于按了个空键。
// ComfyUI 的 Comfy.Workflow.Persist 默认 true（“Persist workflow state and restore on page (re)load”），
// 重载会恢复工作流草稿。
function scheduleThemeRefresh() {
  if (themeRefreshTimer) return;
  themeRefreshTimer = setTimeout(() => {
    themeRefreshTimer = null;
    if (!frameIsDirect) return;
    // 只重载 ComfyUI 那层 iframe：同一个 src 浏览器不会重载，加一个无害的时间戳强制刷新
    try {
      const cur = els.frame && els.frame.src;
      if (cur) {
        const u = new URL(cur);
        u.searchParams.set("_hana_t", String(Date.now()));
        console.log("[comfyui-hana] 宿主主题已变，重载 ComfyUI iframe");
        themeStaleAfterLoad = false;
        els.frame.src = u.toString();
        return;
      }
    } catch { /* 落到整页刷新 */ }
    try { location.reload(); } catch { /* 忽略 */ }
  }, 1200);
}

// 宿主主题钩子回调：用快照刷新变量缓存 → 推送色板 → 重载 ComfyUI iframe（仅跨源直连时需要）
function onHostThemeChanged(snap) {
  const url = (snap && snap.cssUrl) || hostThemeCssUrl();
  if (url) { hanaThemeVars = null; hanaThemeVarsUrl = null; fetchHostThemeVars(true); }
  themeSigSeen = null; // 让轮询重新建立基线
  if (!frameRuntimeId || !frameIsDirect) return;
  void (async () => {
    for (let i = 0; i < 15 && !hanaThemeVars; i++) await new Promise((r) => setTimeout(r, 200));
    const r = await pushThemeToComfyServer(true);
    if (r && r.ok) scheduleThemeRefresh();
    else console.warn("[comfyui-hana] 主题写入失败：", (r && r.error) || "unknown");
  })();
}

function onThemeMaybeChanged() {
  if (!frameIsDirect) return; // 代理模式：同源直控，实时生效，无需重载
  if (!frameRuntimeId) return; // 未加载：下次开就带上了
  void (async () => {
    const r = await pushThemeToComfyServer(true);
    if (r && r.ok) {
      themeStaleAfterLoad = true;
      scheduleThemeRefresh();
    }
  })();
}

// 组合同步：基座（dark/light）→ 主题色覆盖；轮询直到两者就绪。
function comfySyncTick() {
  fetchHostThemeVars(); // 发起/复用宿主主题变量获取（幂等）
  const base = syncComfyPalette();
  if (base !== "done") return base;
  if (paletteJustSwitched) {
    paletteJustSwitched = false; // 基座刚换：本拍只等 loadColorPalette 落定，下一拍再应用主题色
    return "pending";
  }
  const url = hostThemeCssUrl();
  if (url && (!hanaThemeVars || hanaThemeVarsUrl !== url)) return "pending"; // 等新主题变量
  return applyHanaThemeVars() ? "done" : "pending";
}

function ensureComfySync() {
  if (paletteSyncBlocked || paletteSyncTimer) return; // 轮询在跑时会自动消费最新主题
  paletteSyncTicks = 0;
  if (comfySyncTick() !== "pending") return;
  paletteSyncTimer = setInterval(() => {
    paletteSyncTicks += 1;
    if (comfySyncTick() !== "pending" || paletteSyncTicks >= PALETTE_SYNC_MAX_TICKS) {
      stopComfySync();
    }
  }, PALETTE_SYNC_TICK_MS);
}

function stopComfySync() {
  if (paletteSyncTimer) { clearInterval(paletteSyncTimer); paletteSyncTimer = null; }
}

// ── 视图切换 ──────────────────────────────────────────────────────────────
// 2026-10-09：「重载工作区」自顶栏移出为 #ws-body 右上角悬浮按钮；ready 态不再常显工具条
// （无操作消息即收起，与其余态一致），原 showReadyBar / currentView 随之移除。
let barHasMessage = false;   // 顶栏当前展示的是否为操作消息（顶栏只在有消息时显示）

function showView(name) {
  els.boot.classList.toggle("show", name === "booting");
  els.err.classList.toggle("show", name === "error");
  els.offline.classList.toggle("show", name === "offline");
  els.frameWrap.classList.toggle("show", name === "ready");
  // 「重载工作区」悬浮按钮：仅 ready 态显示（2026-10-09 自顶栏移出）
  if (els.barReload) els.barReload.style.display = name === "ready" ? "inline-block" : "none";
  // 「放入 hui 画布」悬浮按钮：仅「窗口态 + ready」显示（2026-10-09 画布移交）
  if (els.handoffBtn) els.handoffBtn.style.display = (name === "ready" && IS_NATIVE_WINDOW) ? "inline-block" : "none";
  if (name !== "ready") { els.loading.classList.remove("show"); }
  else if (!frameLoaded) els.loading.classList.add("show");
  // 顶栏缺省态：无操作消息则收起（有消息保留）；ready 态不再常显工具条（2026-10-09）
  if (!barHasMessage) els.bar.classList.remove("show");
}

function setBar(kind, text, actions = []) {
  if (!kind) {
    barHasMessage = false;
    els.bar.classList.remove("show"); // 消息清除 → 收起顶栏（ready 态不再回落到常驻工具条，2026-10-09）
    return;
  }
  barHasMessage = true;
  els.bar.className = `show ${kind}`;
  els.barText.textContent = text;
  [els.barAction, els.barAction2].forEach((btn, i) => {
    const a = actions[i];
    if (a && a.label && a.fn) {
      btn.style.display = "inline-block";
      btn.textContent = a.label;
      btn.onclick = a.fn;
    } else {
      btn.style.display = "none";
      btn.onclick = null;
    }
  });
}

// 复制：优先 clipboard API，旧环境回落 execCommand
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ── 安装引导弹窗（未检测到 ComfyUI 时；现由工作区 offline 覆盖层的「安装引导」按钮触发）──
let guideOpen = false;
let guideSelected = null;
let guideCustomPath = null;

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function guideShow(step) {
  $("guide-mask").classList.add("show");
  guideOpen = true;
  $("guide-step1").hidden = step !== 1;
  $("guide-step2").hidden = step !== 2;
  $("guide-done").hidden = step !== 3;
}
function guideHide() {
  $("guide-mask").classList.remove("show");
  guideOpen = false;
}
function guideDone(title, noteText) {
  $("g-done-title").textContent = title;
  $("g-done-note").textContent = noteText;
  guideShow(3);
}
function guideNote(text) {
  const el = $("g-note");
  if (el) el.textContent = text || "";
}

function renderTargets(j) {
  const box = $("g-targets");
  const list = Array.isArray(j && j.targets) ? j.targets.slice() : [];
  const custom = (j && j.custom) || guideCustomPath;
  if (custom && !list.some((t) => t.path === custom)) {
    list.unshift({ path: custom, label: "自定义", freeGB: null, custom: true, recommended: true });
  }
  if (!list.length) {
    box.innerHTML = '<div class="sub" style="margin:0">未能读取磁盘信息；可点下方「自定义目录…」手动指定。</div>';
  } else {
    const anyRec = list.some((t) => t.recommended);
    box.innerHTML = list.map((t) => {
      const meta = [
        t.freeGB != null ? `剩余 ${t.freeGB} GB` : "",
        t.isSystem ? "系统盘" : "",
        t.exists ? "已存在" : "",
        t.recommended ? "<b>推荐</b>" : "",
      ].filter(Boolean).join(" · ");
      const checked = t.recommended || (!anyRec && t === list[0]);
      return `<label class="tgt ${t.recommended ? "rec" : ""}"><input type="radio" name="g-tgt" value="${escHtml(t.path)}" ${checked ? "checked" : ""}>

      <span class="p">${escHtml(t.path)}</span><span class="m">${meta}</span></label>`;
    }).join("");
  }
  box.insertAdjacentHTML("beforeend", '<button class="tgt-custom" id="g-pick">＋ 自定义目录…</button>');
  box.querySelectorAll('input[name="g-tgt"]').forEach((el) => {
    el.addEventListener("change", () => { guideSelected = el.value; });
  });
  const checked = box.querySelector('input[name="g-tgt"]:checked');
  guideSelected = checked ? checked.value : null;
  const pick = $("g-pick");
  if (pick) pick.addEventListener("click", () => { void pickCustomDir(); });
}

async function loadTargets() {
  const box = $("g-targets");
  box.innerHTML = '<div class="sub" style="margin:0">正在读取磁盘信息…</div>';
  guideNote("");
  try {
    const r = await hana.api.fetch("/comfyui-hana/install-targets", { cache: "no-store" });
    const j = await r.json();
    if (!j || j.ok === false) throw new Error((j && j.error) || `HTTP ${r.status}`);
    renderTargets(j);
  } catch (e) {
    box.innerHTML = `<div class="sub" style="margin:0">磁盘信息读取失败：${escHtml(String((e && e.message) || e))}</div>`;
    box.insertAdjacentHTML("beforeend", '<button class="tgt-custom" id="g-pick">＋ 自定义目录…</button>');
    const pick = $("g-pick");
    if (pick) pick.addEventListener("click", () => { void pickCustomDir(); });
  }
}

// 自定义目录：走宿主目录选择器（resource.pick），选完写回 app 配置
async function pickCustomDir() {
  guideNote("");
  try {
    const res = await hana.resources.pick({ mode: "directory" });
    const ref = res && Array.isArray(res.resources) ? res.resources[0] : null;
    const path = ref && typeof ref.path === "string" ? ref.path.replace(/[\\/]+$/, "") : null;
    if (!path) return; // 用户取消
    guideCustomPath = path;
    const s = await hana.api.fetch("/comfyui-hana/install-target", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
    });
    if (!s.ok) throw new Error(`保存失败（HTTP ${s.status}）`);
    await loadTargets();
  } catch (e) {
    guideNote("选择目录失败：" + String((e && e.message) || e));
  }
}

async function guideLaunch() {
  if (!guideSelected) { guideNote("请先选择一个安装位置"); return; }
  const btn = $("g-launch");
  btn.disabled = true;
  guideNote("正在创建安装会话…");
  try {
    const r = await hana.api.fetch("/comfyui-hana/install-launch", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: guideSelected }),
    });
    const j = await r.json().catch(() => null);
    if (!(r.ok && j && j.ok)) throw new Error((j && j.error) || `HTTP ${r.status}`);
    guideDone("已发起安装", `Hana 正在 ${guideSelected} 安装 ComfyUI（已新建安装会话），进度可在会话列表里查看。装好后本页会自动载入；也可随时点上方「检测安装情况」。`);
  } catch (e) {
    guideNote("发起失败：" + String((e && e.message) || e));
  } finally {
    btn.disabled = false;
  }
}

async function guideCopyPrompt() {
  if (!guideSelected) { guideNote("请先选择一个安装位置"); return; }
  try {
    const r = await hana.api.fetch(`/comfyui-hana/install-prompt?path=${encodeURIComponent(guideSelected)}`);
    const j = await r.json();
    if (!(r.ok && j && j.ok)) throw new Error((j && j.error) || `HTTP ${r.status}`);
    const ok = await copyText(j.prompt);
    if (ok) guideDone("安装指令已复制", "把这段指令粘给任意 Hana 会话（或你的 agent），它就会按选定的位置安装。");
    else { guideNote("复制失败（可在浏览器控制台取文本）"); console.log(j.prompt); }
  } catch (e) {
    guideNote("复制失败：" + String((e && e.message) || e));
  }
}

async function guideSelfInstall() {
  const lines = [
    "ComfyUI 官方仓库：https://github.com/comfyanonymous/ComfyUI",
    "国内镜像：https://ghproxy.net/https://github.com/comfyanonymous/ComfyUI.git",
    "安装文档：Hana-ComfyUI 技能目录下的 INSTALL.md（Windows 主线）",
    "装好后以 127.0.0.1:8188 启动服务，本工作区会自动识别。",
  ];
  const ok = await copyText(lines.join("\n"));
  if (ok) guideDone("仓库地址已复制", "包含官方地址、国内镜像与启动说明。装完回到本页点「检测安装情况」即可接入。");
  else guideNote("复制失败，请手动获取地址。");
}

// ── 数据读取 ──────────────────────────────────────────────────────────────
async function getBootState() {
  const r = await hana.api.fetch("/comfyui-hana/boot-state", { cache: "no-store" });
  if (!r.ok) throw new Error(`boot-state HTTP ${r.status}`);
  return r.json();
}
async function getFullStatus() {
  const r = await hana.api.fetch("/comfyui-hana/status", { cache: "no-store" });
  if (!r.ok) throw new Error(`status HTTP ${r.status}`);
  return r.json();
}
async function postRetryStart() {
  const r = await hana.api.fetch("/comfyui-hana/relay/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return r.json().catch(() => ({}));
}
// 启动/停止 8188 上的 ComfyUI 本体（与重启中继是两件事）
async function postBackendStart() {
  const r = await hana.api.fetch("/comfyui-hana/backend/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return r.json().catch(() => ({}));
}
async function startBackend() {
  svcRequestedAt = Date.now();
  setBar("info", "已请求启动 ComfyUI 服务，等待就绪（首次约 30～90 秒）…", []);
  try {
    const j = await postBackendStart();
    if (j && j.ok === false) {
      setBar("warn", `启动失败：${j.error || "未知原因"}`, [{ label: "重启中继", fn: () => { void statusTick(); void postRetryStart().catch(() => {}); } }]);
      return;
    }
  } catch (e) {
    setBar("warn", `启动失败：${String((e && e.message) || e)}`, []);
    return;
  }
  setTimeout(() => { void statusTick(); }, 1500);
}

// 停止 8188 上的 ComfyUI 本体（与「重启中继」是两件事；正在跑的任务会中断）
async function postBackendStop() {
  const r = await hana.api.fetch("/comfyui-hana/backend/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return r.json().catch(() => ({}));
}
async function stopBackend() {
  setBar("info", "正在停止 ComfyUI 服务…", []);
  try {
    const j = await postBackendStop();
    if (j && j.ok === false) {
      setBar("warn", `停止失败：${j.error || "未知原因"}`, [{ label: "重试", fn: () => { void stopBackend(); } }]);
      return;
    }
    setBar("info", "已请求停止服务，等待退出…", []);
  } catch (e) {
    setBar("warn", `停止失败：${String((e && e.message) || e)}`, []);
  }
  setTimeout(() => { void statusTick(); }, 1500);
}

// 服务不可达时的覆盖层（盖住 iframe，不让用户直接看到中继的 ECONNREFUSED JSON）
let svcRequestedAt = 0;
function showOffline(st) {
  const relay = (st && st.relay) || null;
  const env = relay ? relay.env : null;
  const proc = relay && relay.backend ? relay.backend.proc || null : null;
  const hit = env && Array.isArray(env.installs) && env.installs.length ? env.installs[0] : null;
  $("btn-svc-start").style.display = hit ? "" : "none";
  $("btn-svc-guide").style.display = hit ? "none" : "";
  const bits = [];
  bits.push(hit ? `安装根 ${hit.path}` : "未检测到可启动的安装");
  if (proc && proc.startedAt) bits.push(`上次由本 App 拉起：${String(proc.startedAt).replace("T", " ").slice(0, 19)}`);
  if (proc && proc.lastError) bits.push(`上次错误：${proc.lastError}`);
  els.offMeta.textContent = bits.join(" · ");
  // 「已等待 XX 秒」独立成行（accent 色、13.5px，一眼可见）；无等待时隐藏
  if (svcRequestedAt) {
    els.offWait.textContent = `已等待 ${Math.round((Date.now() - svcRequestedAt) / 1000)} 秒`;
    els.offWait.hidden = false;
  } else {
    els.offWait.hidden = true;
    els.offWait.textContent = "";
  }
  if (!els.offline.classList.contains("show")) {
    els.offNote.textContent = "点「启动服务」开始；首次启动约 30～90 秒（依赖导入）。";
    showView("offline");
  }
}

// ── iframe 目标构造（两种形式；auto = sdk → 凭据路径 → raw 逐级回落）──────
// 说明（宿主段实测发现并修复，2026-09-21）：
//   hana.api.url("/_runtime/<rid>/") 会抛 "Invalid managed service API path"——
//   SDK 要求 <rid>/ 之后必须还有非空入口路径，故入口固定为 index.html（8188 与代理链路均 200，
//   前端相对寻址基于所在目录，结果与根路径一致）。
//   若 SDK 分支不可用（无 surface session 等），auto 会先回落"手工凭据路径"
//   （proxyPrefix + _surface/<appSurfaceSession>/，与宿主/SDK 同款形态），最后才回落到无凭据 raw。
// 凭据读取（B 前置 · 窗口入口兜底，2026-10-08）：
//   query 优先；原生窗 entry 无 query（宿主只构造 /ui/_surface/<token>/ 路径段），故缺 query 时从路径段提取，
//   并把凭据回填进当前 URL（history.replaceState）——SDK（hana.api.fetch / hana.api.url）只认 query，
//   回填后窗口页与 iframe 场景行为一致；回填幂等；两处都取不到时给可读提示（console.warn，仅一次）。
let surfaceSessionWarned = false;
function readSurfaceSession() {
  try {
    const fromQuery = new URLSearchParams(location.search).get("appSurfaceSession");
    if (fromQuery) return fromQuery;
    const m = /\/ui\/_surface\/([^/]+)\//.exec(location.pathname || "");
    if (m) {
      let token = m[1];
      try { token = decodeURIComponent(token) || token; } catch { /* 原样使用 */ }
      try {
        const u = new URL(location.href);
        u.searchParams.set("appSurfaceSession", token);
        history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
      } catch { /* 回填失败不挡本次取用 */ }
      return token;
    }
    if (!surfaceSessionWarned) {
      surfaceSessionWarned = true;
      console.warn("[comfyui-hana] 未取得 App surface 会话凭据（URL 无 appSurfaceSession、路径无 /ui/_surface/<token>/ 段）：请从卡中心 / 工作区入口重新打开本页。");
    }
    return null;
  } catch { return null; }
}

function buildFrameUrl(boot) {
  if (!boot || !boot.proxyPrefix || !boot.runtimeId) return null;
  const rid = encodeURIComponent(boot.runtimeId);
  const session = readSurfaceSession();
  const notes = [];
  // 直连（auto 首选）：ComfyUI 站在自己的根路径上 —— 自定义节点的扩展脚本习惯用绝对路径
  // （/extensions/<node>/*.js、/scripts/app.js、/scripts/ui.js），只有直连才走得通；
  // 走宿主代理路径时这些绝对路径会绕过 App 前缀、打到宿主根（不是本 App 的路由）被 403。
  // 代价：iframe 变跨源，壳页同源直控的「主题跟随」自动停用（色板改由 ComfyUI 自身设置持久化）。
  if (mode === "direct" || mode === "auto") {
    const origin = String(boot.backendUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
    return { url: `${origin}/`, kind: "direct", note: "跨源直连，宿主主题跟随停用" };
  }
  if (mode === "sdk" || mode === "auto") {
    try {
      return { url: hana.api.url(`/_runtime/${rid}/index.html`), kind: "sdk" };
    } catch (e) {
      notes.push("sdk: " + String((e && e.message) || e));
    }
  }
  if (mode === "auto" && session) {
    return { url: `${boot.proxyPrefix}_surface/${encodeURIComponent(session)}/`, kind: "credential-path", note: notes.join(" | ") };
  }
  if (mode === "raw" || mode === "auto") {
    return { url: boot.proxyPrefix, kind: "raw", note: notes.join(" | ") };
  }
  return { url: null, kind: mode, error: notes.join(" | ") || "unavailable" };
}

function describeBoot(boot) {
  const bits = [`phase=${boot.phase}`];
  if (boot.runtimeId) bits.push(`runtimeId=${String(boot.runtimeId).slice(0, 18)}…`);
  if (boot.service) bits.push(`service=${boot.service.state || "-"}:${boot.service.port ?? "-"}`);
  return bits.join(" · ");
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function tick() {
  let boot;
  try {
    boot = await getBootState();
  } catch (e) {
    showView("error");
    els.errNote.textContent = "读取 App 状态失败（路由不可达）：" + String(e && e.message || e);
    els.errMeta.textContent = "";
    els.errRawWrap.style.display = "";
    els.errRaw.textContent = String(e && e.stack || e);
    return;
  }

  if (boot.phase === "ready" && boot.proxyPrefix && boot.runtimeId) {
    if (frameRuntimeId && frameRuntimeId !== boot.runtimeId) {
      // 中继换了实例（重启/重载）：整页重载，避免半新半旧的文档状态
      try { location.reload(); } catch { /* 忽略 */ }
      return;
    }
    const built = buildFrameUrl(boot);
    if (!built || !built.url) {
      showView("error");
      els.errNote.textContent = "中继已就绪，但代理路径构造失败：" + (built && built.error ? built.error : "未知");
      els.errMeta.textContent = describeBoot(boot);
      return;
    }
    if (built.error) console.warn("[comfyui-hana] 代理路径构造失败：", built.error);
    showView("ready");
    if (frameRuntimeId !== boot.runtimeId) {
      frameRuntimeId = boot.runtimeId;
      frameLoaded = false;
      els.loading.classList.add("show");
      // 直连（跨源）：先把宿主主题写进 ComfyUI 设置，iframe 一起来就带着宿主配色
      if (built.kind === "direct") {
        frameIsDirect = true;
        try { await pushThemeToComfyServer(); } catch { /* 主题失败不阻塞加载 */ }
      } else {
        frameIsDirect = false;
      }
      themeStaleAfterLoad = false; // 新文档会读到刚推送的色板
      // 重载闸门记账（2026-09-29）：本次加载是否处于「已知可达」期；启动加载（未知）待首个健康状态确认
      frameLoadOk = lastReachKnown === true;
      frameBootPending = lastReachKnown === null;
      els.frame.src = built.url; // 含短期凭证，不落存储、不写日志
      console.log("[comfyui-hana] iframe 连接方式：", built.kind, built.note ? `（${built.note}）` : "");
    }
    startStatusPolling();
    stopBootPolling();
    return;
  }

  stopStatusPolling();
  startBootPolling();
  if (boot.phase === "error") {
    showView("error");
    els.errNote.textContent = boot.note || "中继启动失败。";
    els.errMeta.textContent = describeBoot(boot) + (boot.error ? ` · code=${boot.error.code}` : "");
    els.errRawWrap.style.display = "";
    els.errRaw.textContent = JSON.stringify(boot, null, 2);
  } else {
    showView("booting");
    els.bootNote.textContent = boot.note || "正在启动……";
    els.bootMeta.textContent = describeBoot(boot);
    els.bootRawWrap.style.display = "";
    els.bootRaw.textContent = JSON.stringify(boot, null, 2);
  }
}

function startBootPolling() {
  if (bootTimer) return;
  bootTimer = setInterval(() => { void tick(); }, 1500);
}
function stopBootPolling() {
  if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
}
function startStatusPolling() {
  if (statusTimer) return;
  unreachableStreak = 0; // 新一轮状态轮询，去抖计数归零（2026-09-29）
  statusTimer = setInterval(() => { void statusTick(); }, 3000);
  void statusTick();
}
function stopStatusPolling() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  unreachableStreak = 0; // 退出状态轮询，去抖计数不跨段累计（2026-09-29）
  setBar(null);
}

// 统一重载内层 iframe 入口（2026-10-08，P5）：三处复用 —— ① 帧健康校验的自动重载
// （退避/收敛）；② statusTick 恢复闸门；③ 壳页桥 op frame.reload。统一记账
// （frameLoaded/frameLoadOk/frameBootPending）：不再无条件标「已知可达期加载」
// （2026-09-29 一次性记账的盲区③——服务不在时发起的重载会把坏帧记成健康帧，
// 之后永远得不到自动重载）；新文档一律先记 pending，等健康状态确认（statusTick
// 认证路径），可疑帧另由帧健康校验持续盯住。带 `_hr` 时间戳强制刷新：同一 src
// 浏览器不会重新加载。（§20 场景保留：服务不在时 iframe 加载必为空白页。）
function requestFrameReload(reason, url) {
  let target = url ? String(url) : null;
  if (!target) target = currentFrameSrc();
  if (!target) return false;
  let finalUrl;
  try {
    const u = new URL(target, location.href);
    u.searchParams.set("_hr", String(Date.now()));
    finalUrl = u.toString();
  } catch {
    finalUrl = target + (target.indexOf("?") >= 0 ? "&" : "?") + "_hr=" + Date.now();
  }
  frameLoaded = false;
  frameLoadOk = false;
  frameBootPending = true;   // 「加载于已知可达期」待健康状态确认
  if (frameSuspectTimer) { clearTimeout(frameSuspectTimer); frameSuspectTimer = null; } // 旧循环止步，新文档重新评估
  els.loading.classList.add("show");
  els.frame.src = finalUrl;  // 含短期凭证，不落存储、不写日志
  console.log(`[comfyui-hana] 重载工作区 iframe（${reason}）`);
  return true;
}

// ── 帧健康校验与退避重载（2026-10-08，P5：工作区冷启动/断连自愈）──────────────
// 背景：iframe 加载失败页（chrome-error）与正常页都以 load 收场，壳页无法据此区分（跨源更不能）。
// 校验：load 后对帧源做 no-cors 探针——跨源直连同样适用，「跨源」本身是预期结果
// （no-cors 不会因跨源被拒），不会以跨源失败误判坏帧；再与中继观测（lastReachKnown）交叉判定。
// 判定「可疑坏帧」：探针失败（连接被拒/超时，错误页的典型成因）＋ 帧非「已知可达期加载」
// ＋ 中继也未看到可达（中继看到可达时探针失败不作为坏帧依据——可能是探测环境限制）。
// 处置：退避 1s/2s/4s 自动重载（上限 3 次）；预算用尽后低频复探等待源恢复，探针翻正即
// 收敛重载一次；探针翻正即清零。「已知可达期正常加载」的帧绝不自动重载（保留
// 2026-09-29 闸门初衷：不轻清运行中进度）。
const FRAME_HEALTH_SETTLE_MS = 700;                   // load 后静置（让网络错误先落定）
const FRAME_PROBE_TIMEOUT_MS = 3000;                  // 探针超时（挂起的端口不拖死检查循环）
const FRAME_SUSPECT_BACKOFF_MS = [1000, 2000, 4000];  // 退避重载间隔（上限 = 数组长度 3 次）
const FRAME_SUSPECT_WATCH_MS = 4000;                  // 复探节拍（等源恢复/复核）
let frameSuspect = false;                             // 当前文档疑似坏帧
let frameReloadAttempts = 0;                          // 本轮可疑期的自动重载计数
let frameHealthTimer = null;                          // load 后健康校验 one-shot
let frameSuspectTimer = null;                         // 可疑循环计时器

function frameTimersClear() {
  if (frameHealthTimer) { clearTimeout(frameHealthTimer); frameHealthTimer = null; }
  if (frameSuspectTimer) { clearTimeout(frameSuspectTimer); frameSuspectTimer = null; }
}
function frameSuspectReset() {
  frameSuspect = false;
  frameReloadAttempts = 0;
}
function currentFrameSrc() {
  try { return els.frame && els.frame.src ? String(els.frame.src) : null; } catch { return null; }
}

// no-cors 探针：得到（不透明）响应即「源可达」；网络层失败（被拒/超时）＝「源不可达」
async function probeFrameSrc(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch { /* 忽略 */ } }, FRAME_PROBE_TIMEOUT_MS);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function scheduleFrameHealthCheck() {
  frameTimersClear();
  frameHealthTimer = setTimeout(() => { frameHealthTimer = null; void frameHealthCheck(); }, FRAME_HEALTH_SETTLE_MS);
}

async function frameHealthCheck() {
  if (!frameLoaded) return;
  const src = currentFrameSrc();
  if (!src) return;
  const ok = await probeFrameSrc(src);
  if (!frameLoaded) return; // 期间发生了重载：本次结果作废，交给新文档的校验
  if (ok) { frameSuspectReset(); return; } // 帧源可达：当前文档视为健康
  // 探针失败。交叉判定：中继看到「可达」时，探针失败不作为坏帧依据（可能是探针环境限制）；
  // 「已知可达期加载」的帧同样不动——服务掉线后的恢复交给 statusTick 恢复闸门。
  if (frameLoadOk || lastReachKnown === true) {
    if (frameSuspect) scheduleFrameSuspectTick(FRAME_SUSPECT_WATCH_MS); // 未清的可疑保持复探
    return;
  }
  // 可疑坏帧：进入退避重载循环（1s/2s/4s，上限 3 次）
  frameSuspect = true;
  const due = frameReloadAttempts < FRAME_SUSPECT_BACKOFF_MS.length
    ? FRAME_SUSPECT_BACKOFF_MS[frameReloadAttempts]
    : FRAME_SUSPECT_WATCH_MS;
  scheduleFrameSuspectTick(due);
}

function scheduleFrameSuspectTick(delayMs) {
  if (frameSuspectTimer) { clearTimeout(frameSuspectTimer); frameSuspectTimer = null; }
  frameSuspectTimer = setTimeout(() => { frameSuspectTimer = null; void frameSuspectTick(); }, delayMs);
}

async function frameSuspectTick() {
  if (!frameSuspect || !frameLoaded) return;
  const src = currentFrameSrc();
  if (!src) return;
  const ok = await probeFrameSrc(src);
  if (!frameLoaded) return; // 期间发生了重载：本次结果作废
  if (ok) { // 源已恢复可达：收敛重载一次（与恢复闸门同语义：源确认可达才动作）
    frameSuspectReset();
    requestFrameReload("source-recovered");
    return;
  }
  // 仍不可达：中继已见可达时不盲重载（可能是探测环境限制）；服务确不可达且预算未用尽 →
  // 按退避重载；否则低频复探等待源恢复。
  if (lastReachKnown !== true && frameReloadAttempts < FRAME_SUSPECT_BACKOFF_MS.length) {
    frameReloadAttempts += 1;
    console.warn(`[comfyui-hana] 帧健康校验：疑似坏帧，自动重载（第 ${frameReloadAttempts}/${FRAME_SUSPECT_BACKOFF_MS.length} 次）`);
    if (!requestFrameReload(`health-check #${frameReloadAttempts}`)) scheduleFrameSuspectTick(FRAME_SUSPECT_WATCH_MS);
    return;
  }
  scheduleFrameSuspectTick(FRAME_SUSPECT_WATCH_MS);
}

async function statusTick() {
  try {
    const st = await getFullStatus();
    const boot = st.boot || {};
    if (boot.phase !== "ready") { // 状态回退（中继掉了）→ 回到三态判定
      stopStatusPolling();
      void tick();
      return;
    }
    const backend = st.relay && st.relay.backend ? st.relay.backend : null;
    const reachable = !!(backend && backend.reachable);
    lastReachKnown = reachable;
    if (!reachable) {
      // ① 覆盖层去抖（2026-09-29）：连续 ≥OFFLINE_DEBOUNCE_TICKS 轮不可达才显示，
      //    单次负载抖动不再误报「服务未运行」；覆盖层出现时才清 bar，避免抖动期闪没提示
      unreachableStreak += 1;
      if (!offlineSince) offlineSince = Date.now(); // 本轮离线窗口起点（2026-10-08）
      if (offlineDebounced(unreachableStreak)) {
        // 覆盖层承担提示（比顶栏更清楚），避免 iframe 直接渲染中继的 ECONNREFUSED JSON
        setBar(null);
        showOffline(st);
      }
    } else {
      const wasGap = statusGap; // fetch 失败窗口（2026-10-08，盲区①）
      statusGap = false;
      const wasUnreachable = unreachableStreak > 0 || wasGap; // 失败窗口不得当「从未离线」
      unreachableStreak = 0;
      // 启动期加载（可达性未知）被首个未遇离线的健康状态确认 → 记为「已知可达期加载」；
      // 疑似坏帧（frameSuspect）不予确认（2026-10-08）
      if (frameBootPending && !wasUnreachable && !frameSuspect) { frameLoadOk = true; frameBootPending = false; }
      if (wasUnreachable) {
        // ② 重载闸门（2026-10-08 修订）：「frame 非已知可达期加载」或「离线期有显式启动请求」重载；
        //    显式启动请求 = 本页 svcRequestedAt ∪ 服务端权威字段（proc.starting / 离线期内的
        //    lastStartResult.ok）——覆盖「从左侧面板启动不置位 svcRequestedAt」的盲区②；
        //    纯探测抖动直接放行，不清运行中进度（§20 重载语义保留）。
        const proc = backend && backend.proc ? backend.proc : null;
        const lr = proc && proc.lastStartResult ? proc.lastStartResult : null;
        const lrAt = lr && lr.at ? Date.parse(lr.at) : NaN;
        const askedStart = svcRequestedAt > 0
          || !!(proc && proc.starting === true)
          || !!(lr && lr.ok === true && Number.isFinite(lrAt) && lrAt >= (offlineSince || 0) - 5000);
        const didReload = frameReloadNeeded(askedStart, frameLoadOk);
        if (didReload) {
          const built = buildFrameUrl(boot);
          requestFrameReload("status-recovery", built && built.url ? built.url : null);
        }
        if (didReload || els.offline.classList.contains("show")) {
          showView("ready");
          ensureComfySync(); // 服务刚回来，重新对齐主题
        }
        setBar(null); // 清掉「已请求启动…」等操作提示
        offlineSince = 0; // 本轮离线窗口关闭
      }
      if (svcRequestedAt) { svcRequestedAt = 0; $("off-note").textContent = ""; els.offWait.hidden = true; }
      // 服务运行中的常驻控制条已移除（2026-09-27）：服务控制只留左侧状态面板
      // 宿主主题变更提示条已移除（2026-10-11）：刷新动作由 scheduleThemeRefresh 自行完成，
      // 该提示不消失（重载的是内层 iframe、外层壳页不重载，标志位留在 true 上），属视觉噪声。
    }
  } catch {
    // fetch 失败窗口（2026-10-08，盲区①）：参与「曾离线」判定——恢复时照常走闸门，
    // 不得当作「从未离线」；界面提示由覆盖层/左侧面板承担，此处静默。
    statusGap = true;
    if (!offlineSince) offlineSince = Date.now();
  }
}

// ── 画布移交（2026-10-09 首版；2026-10-09 晚修订 1：非破坏加入 + 任意次序接管）────
// 方案：docs/画布移交-外开窗口到主工作区-20261009.md（含「⚠ 修订 1」节）。单桶壳页桥
// （同刻仅一壳页）下不做实时接力，本移交为一次性「保存 → 让位 → 接管」状态转移：
//   · 窗口侧：handoff/write（服务端取全量画布 → 落盘工作流文件 → 写标记）→ 提示 → 关窗让位；
//   · 卡侧：短窗轮询 + 活跃重查 → handoff/take【新开页装载】（快照开为一张新画布页，
//     不触碰当前活动页）→ 顶栏短提示。
// 辨识：宿主原生窗为裸窗口（top===self）；卡态为宿主内嵌 iframe（top!==self）。
const IS_NATIVE_WINDOW = (() => { try { return window.top === window; } catch { return false; } })();

// handoff 路由调用（本 App 自有路由，与 shell/* 同域；随 hana.api.fetch 自带 surface 凭据）
async function handoffCall(op, extra) {
  const r = await hana.api.fetch("/comfyui-hana/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ op }, extra || {})),
    cache: "no-store",
  });
  let j = null;
  try { j = await r.json(); } catch { /* 统一按不可解析处理 */ }
  if (!j || typeof j !== "object") throw new Error(`handoff/${op} 响应不可解析（HTTP ${r && r.status}）`);
  return j;
}

// ── 壳内实例身份（修订 1.2）：iframe 里的桥经 postMessage 把本实例 clientId 推给本壳页 ──────
// 验收环境 iframe 为跨源直连（auto 首选 direct，见 buildFrameUrl），壳页读不到 iframe 内容
// （comfyWin() 属性读取被跨源拦）；postMessage 是该条件下唯一可得的「本壳实例 sid」来源。
// 用途：「放入 hui 画布」定向直发——卡壳页随 peek 上报（窗壳页收到也不使用，handoff 逻辑只跑在卡侧）。
// 只认自家 iframe 的来讯（source 校验）；iframe 新文档加载时作废（等新桥重新宣告）。
let frameInstance = null; // { clientId, href, build, at }
window.addEventListener("message", (e) => {
  try {
    const d = e && e.data;
    if (!d || typeof d !== "object" || d.type !== "hana.bridge.announce") return;
    if (!els.frame || e.source !== els.frame.contentWindow) return; // 只认自家 iframe
    const clientId = typeof d.clientId === "string" && d.clientId.trim() ? d.clientId.trim() : null;
    frameInstance = { clientId, href: typeof d.href === "string" ? d.href : null, build: typeof d.build === "string" ? d.build : null, at: Date.now() };
  } catch { /* 忽略 */ }
});
// 主动问询（自愈）：身份缺位时向 iframe 发一次 whoami（桥侧仅认 parent 来讯并回推宣告）。
let frameWhoamiAt = 0;
function askFrameWhoami() {
  const now = Date.now();
  if (now - frameWhoamiAt < 10_000) return; // 节流
  frameWhoamiAt = now;
  try {
    const w = els.frame && els.frame.contentWindow;
    if (w) w.postMessage({ type: "hana.bridge.whoami" }, "*");
  } catch { /* 忽略 */ }
}

let handoffBusy = false;    // 窗口侧防重入
let handoffWritten = false; // 本窗口已落盘（关窗失败重试时不再重复写）
let handoffDelivered = false; // 修订 1.2：write 回执的「定向直发」结果（关窗失败重试时文案保持一致）
async function handoffPush() {
  if (handoffBusy) return;
  if (!frameLoaded) { setBar("warn", "画布尚未加载完成，请稍候再试「放入 hui 画布」", []); return; }
  handoffBusy = true;
  try {
    if (!handoffWritten) {
      setBar("info", "正在放入 hui 画布（取画布 → 保存 → 直送 hui）…", []);
      const j = await handoffCall("write", { from: "window" });
      if (!j.ok) throw new Error(j.error || "服务端返回失败");
      handoffWritten = true;
      handoffDelivered = j.delivered === true; // 修订 1.2：在线（已直发）与离线（兜底）分档文案
    }
    // 修订 1.2 文案（回执驱动）：在线＝已直发进入 hui；离线/直发未达＝打开 hui 后自动接住
    setBar("info", handoffDelivered
      ? "已放入（已进入 hui）。本窗口即将关闭……"
      : "已放入；打开 hui 后自动接住。本窗口即将关闭……");
    await new Promise((res) => setTimeout(res, 1500)); // 先让提示可见，再让位（释放单桶）
    const closed = await handoffCloseSelf();
    if (!closed) setBar("warn", "已放入；自动关窗通道不可用——请手动关闭本窗口。", []);
  } catch (e) {
    setBar("warn", "放入 hui 画布失败：" + String((e && e.message) || e), []);
  } finally {
    handoffBusy = false;
  }
}

// 关闭本窗口（让位）：① 宿主窗口 API（原生窗页面直控，最精确）；② 降级 app 路由代关（复用「工作区自开」close 通道）
async function handoffCloseSelf() {
  try {
    if (window.hanaAppWindow && hana.window && typeof hana.window.close === "function") {
      await hana.window.close();
      return true;
    }
  } catch { /* 落到降级通道 */ }
  try {
    const j = await handoffCall("close-window");
    return !!(j.ok && j.closed);
  } catch { return false; }
}

// ── 卡侧接管（修订 1）：非破坏加入 + 任意操作次序 ─────────────────────────────
// 接住 = 请求服务端经桥「新开页装载」（canvas.loadWorkflowNewPage）——快照成为一张【新】画布页；
// 不触碰当前活动页（内容/dirty 无关，故无 dirty 分支）。触发（修订 1.2：在线=定向直发；离线=卡侧兜底）：
//   · 在线主路径【定向直发】（修订 1.2）：按钮 write 时服务端按卡壳页上报的实例 sid 单发
//     「新开页装载」——秒级进入 hui，不经过卡侧轮询（详见 app/index.js tryDirectDeliver）；
//   · 卡页加载后短窗轮询（2.5s 间隔、60s 窗口）——“先开卡、后按钮”在数秒内接住；
//   · 常驻低频巡检（修订 1.1；1.2 降级为离线兜底：60s 一拍，不设终止）——直发未达时保底接住；
//   · 页面可见性 / 焦点变化时重查（节流；加速路径，其失效属宿主嵌套环境观测项）；
//   · 无标记零打扰（巡检/重查均静默跳过）；同一标记只接一次（标记清除 + 服务端互斥 + 桥侧去重）。
const HANDOFF_POLL_MS = 2500;          // 短窗轮询间隔（修订 1：约 2~3s）
const HANDOFF_POLL_WINDOW_MS = 60_000; // 短窗窗口（修订 1：约 60s）
const HANDOFF_PATROL_MS = 60_000;      // 常驻低频巡检间隔（修订 1.1；修订 1.2 降级为「离线兜底」30s→60s）——
                                       // 在线场景由「定向直发」秒级接住（见 handoffPush / 服务端 tryDirectDeliver）；
                                       // 巡检只保底：直发不可达（壳页身份缺位/瞬断）时 ≤1 拍内接住
const HANDOFF_SETTLE_MS = 2000;        // 发现标记后缓一拍：先让窗口侧走完自动关窗「让位」（按钮后 1.5s
                                       // 关窗），再发起装载——把「窗/卡并存」的广播双执行压到常态之外。
const HANDOFF_WAKE_MIN_MS = 2000;      // 活跃重查节流

let handoffPollStarted = false; // 短窗轮询已启动（一页一次；活跃重查常驻不受此限）
let handoffCheckBusy = false;   // 单次检查/接住防重入（轮询与重查共用）
let handoffWakeAt = 0;          // 上次活跃重查时间（节流用）
let handoffSawMarker = false;   // 曾探测到待接标记且未接住成功（供短窗收尾时的「未成功」提示判断）

function handoffNotice(kind, text, autoHideMs = 0) {
  setBar(kind, text, []);
  if (autoHideMs > 0) {
    const cur = els.barText.textContent;
    setTimeout(() => { if (barHasMessage && els.barText.textContent === cur) setBar(null); }, autoHideMs); // 短提示自动收起
  }
}

// 单次检查 + 接住：peek（轻量探标记）→ 有标记则缓一拍 → take。返回 "taken" | "none" | "retry" | "skip"
async function handoffCheckOnce() {
  if (IS_NATIVE_WINDOW || handoffCheckBusy) return "skip";
  handoffCheckBusy = true;
  try {
    let peek = null;
    try {
      // 修订 1.2：顺带把本壳实例的 sid 报给服务端（定向直发目标）；身份缺位时先问一次（自愈）
      const cardSid = frameInstance && frameInstance.clientId ? frameInstance.clientId : null;
      if (!cardSid) askFrameWhoami();
      peek = await handoffCall("peek", cardSid ? { cardSid } : undefined);
    } catch { return "retry"; }
    if (!peek || !peek.ok) return "retry";
    if (!peek.has) return "none"; // 无标记：零打扰
    handoffSawMarker = true;
    await new Promise((res) => setTimeout(res, HANDOFF_SETTLE_MS)); // 让位窗口：等窗侧关窗完成再接
    let j = null;
    try { j = await handoffCall("take"); } catch { return "retry"; }
    if (j && j.ok && j.taken) {
      handoffSawMarker = false;
      const n = j.nodeCount != null ? `（${j.nodeCount} 个节点）` : "";
      handoffNotice("info", `已接住来自独立窗口的画布${n}，已在新画布页打开`, 10_000);
      return "taken";
    }
    if (j && j.ok && j.taken === false && j.absent) { handoffSawMarker = false; return "none"; } // 竞态：标记已被别处清掉
    return "retry"; // inFlight / 中继桥未就绪 / 装载失败：下一拍再试
  } finally {
    handoffCheckBusy = false;
  }
}

// 接管循环（一页一次启动）：① 短窗轮询——加载后 60s 内每 2.5s 一拍（首拍前留 1.5s 给中继/桥起立）；
// ② 常驻低频巡检（修订 1.1；1.2 降级为离线兜底）——短窗过后接续，60s 一拍、不设终止：有标记走接住路径，
// 无标记静默跳过，接住成功后回归静默（巡检继续，服务于下一次移交）。
async function handoffTakeover() {
  if (handoffPollStarted || IS_NATIVE_WINDOW) return;
  handoffPollStarted = true;
  await new Promise((res) => setTimeout(res, 1500)); // 首拍前留 1.5s 给中继/桥起立
  const dawn = Date.now() + HANDOFF_POLL_WINDOW_MS;
  while (Date.now() < dawn) {
    await handoffCheckOnce();
    await new Promise((res) => setTimeout(res, HANDOFF_POLL_MS));
  }
  if (handoffSawMarker) {
    handoffNotice("warn", "检测到待接的移交画布，但自动接住未成功（工作区或桥未就绪）；稍后自动重试");
  }
  for (;;) { // 常驻巡检：不设终止（随页面生命周期）；互斥（不重叠）由 handoffCheckOnce 的 busy 兜底
    await new Promise((res) => setTimeout(res, HANDOFF_PATROL_MS));
    await handoffCheckOnce();
  }
}

// 活跃重查（常驻）：页面可见性 / 焦点变化 → 立即检查一次（节流）。
// 修订 1.1 后定位＝「加速路径」：常驻巡检已保证 ≤1 拍（30s）内接住；事件送达时做到秒级加速。
// （真机实测该二事件在宿主嵌套环境未送达＝观测项；保留不删、不强行修。）
function handoffWakeCheck() {
  if (IS_NATIVE_WINDOW) return;
  const now = Date.now();
  if (now - handoffWakeAt < HANDOFF_WAKE_MIN_MS) return;
  handoffWakeAt = now;
  void handoffCheckOnce();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") handoffWakeCheck();
});
window.addEventListener("focus", handoffWakeCheck);

// ── 交互绑定 ──────────────────────────────────────────────────────────────
function bindModeSelect(sel) {
  sel.value = mode;
  sel.addEventListener("change", () => {
    mode = sel.value || "auto";
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 忽略 */ }
    if (frameRuntimeId) { try { location.reload(); } catch { /* 忽略 */ } }
    else { frameRuntimeId = null; void tick(); }
  });
}
// ── 安装引导弹窗交互 ──────────────────────────────────────────────────────
$("g-ai").addEventListener("click", () => { guideShow(2); void loadTargets(); });
$("g-self").addEventListener("click", () => { void guideSelfInstall(); });
$("g-later").addEventListener("click", () => { guideHide(); });
$("g-back").addEventListener("click", () => { guideShow(1); });
$("g-close").addEventListener("click", () => { guideHide(); });
$("g-launch").addEventListener("click", () => { void guideLaunch(); });
$("g-copy").addEventListener("click", () => { void guideCopyPrompt(); });
$("guide-mask").addEventListener("click", (e) => { if (e.target === $("guide-mask")) guideHide(); });

bindModeSelect($("sel-mode"));
bindModeSelect($("sel-mode2"));
$("btn-retry").addEventListener("click", () => { void postRetryStart().catch(() => {}); els.bootNote.textContent = "已请求启动，等待中继就绪……"; });
$("btn-retry2").addEventListener("click", () => { void postRetryStart().catch(() => {}); els.errNote.textContent = "已请求启动，等待中继就绪……"; });
$("btn-reload-boot").addEventListener("click", () => { void tick(); });
$("btn-svc-start").addEventListener("click", () => { void startBackend(); });
$("btn-svc-guide").addEventListener("click", () => { guideShow(1); });
$("btn-svc-reload").addEventListener("click", () => { try { location.reload(); } catch { /* 忽略 */ } });
$("btn-reload2").addEventListener("click", () => { try { location.reload(); } catch { /* 忽略 */ } });
$("ws-bar-reload").addEventListener("click", () => { requestFrameReload("manual"); }); // 悬浮重载按钮（ready 态右上角）：走统一重载入口 requestFrameReload（2026-10-08 P5）
$("ws-handoff").addEventListener("click", () => { void handoffPush(); }); // 「放入 hui 画布」：仅窗口态显示（2026-10-09 画布移交）
els.frame.addEventListener("load", () => {
  frameLoaded = true;
  frameInstance = null; // 修订 1.2：iframe 新文档，上一实例身份作废（等新桥重新宣告）
  els.loading.classList.remove("show");
  ensureComfySync(); // 内层文档（重）载入 → 重新对齐基座色板与主题色
  scheduleFrameHealthCheck(); // 帧健康校验（2026-10-08，P5）：load 区分不了正常页与错误页，探针复核
  if (!IS_NATIVE_WINDOW) void handoffTakeover(); // 启动接管：短窗轮询 + 常驻低频巡检（修订 1.1：任意时刻自动接住）
});

// ── 启动 ──────────────────────────────────────────────────────────────────
// ── 壳页桥：把 iframe 里的 ComfyUI 画布暴露给 Hana agent ──────────────────
//
// 为何在壳页做：代理模式下 iframe 挂在宿主 …/routes/_runtime/<id>/ 下，源是宿主；
// ComfyUI 前端加载扩展用的绝对路径（/extensions/…）会丢前缀而 403，旧桥在 hui 里够不着画布。
// 壳页与 iframe 同源（主题跟随就是这么做的），够得到 iframe.contentWindow.app。
const SHELL_POLL_MS = 800;

function comfyWin() {
  try {
    return (els.frame && els.frame.contentWindow) || null;
  } catch {
    return null; // 跨源（直连模式）时会抛，此时本桥不适用
  }
}

// 新版前端把 app 挂在哪：优先 window.app，其次 comfyAPI.app.app
function comfyApp() {
  const w = comfyWin();
  if (!w) return null;
  try {
    if (w.app) return w.app;
    if (w.comfyAPI && w.comfyAPI.app && w.comfyAPI.app.app) return w.comfyAPI.app.app;
  } catch { /* 忽略 */ }
  return null;
}

// 诊断：壳页到底看到了什么（排查"够不到 app"用）
function shellDiag() {
  const w = comfyWin();
  let keys = [];
  try { keys = w ? Object.keys(w).slice(0, 60) : []; } catch { keys = ["<keys 读取失败>"]; }
  let hasApp = false, hasComfyAPI = false, appKeys = [];
  try { hasApp = !!(w && w.app); } catch { /* 忽略 */ }
  try { hasComfyAPI = !!(w && w.comfyAPI); } catch { /* 忽略 */ }
  try { appKeys = (w && w.app) ? Object.keys(w.app).slice(0, 40) : []; } catch { /* 忽略 */ }
  return {
    via: "shell",
    hasFrame: !!els.frame,
    hasContentWindow: !!w,
    frameSrc: (() => { try { return els.frame ? els.frame.src : null; } catch { return null; } })(),
    hasWindowApp: hasApp,
    hasComfyAPI: hasComfyAPI,
    windowKeys: keys,
    appKeys: appKeys,
    href: location.href,
  };
}

function wfListOf(svc) {
  try {
    const l = svc.workflows;
    if (Array.isArray(l)) return l;
    if (l && typeof l[Symbol.iterator] === "function") return [...l];
    if (l && typeof l === "object") return Object.values(l);
  } catch { /* 忽略 */ }
  return [];
}

async function shellOp(op, args) {
  const a = args || {};

  // 内层重载：壳页能重设 iframe.src，是唯一能穿透套娃的手。
  // 用途：扩展换了新文件后，已开页面不会自动重载 js，这里强制重载一次。
  // 2026-10-08（P5 盲区③）：改走 requestFrameReload 统一记账——此前旁路重设 src 不记账，
  // 服务不在时落下的坏帧会被当成「已知可达期加载」，之后永远得不到自动重载。
  if (op === "frame.reload") {
    const ok = requestFrameReload("bridge-op");
    return ok
      ? { reloaded: true, src: els.frame.src }
      : { reloaded: false, error: "工作区 iframe 尚未装载，无帧可重载" };
  }

  // 诊断类：不要求 app 就绪，否则"够不到 app"这种问题永远查不出来
  if (op === "shell.diag" || op === "api.probe") {
    const app0 = comfyApp();
    const diag = shellDiag();
    if (op === "shell.diag") return diag;
    return Object.assign({}, diag, {
      hasApp: !!app0,
      hasGraph: !!(app0 && app0.graph),
      hasWorkflowManager: !!(app0 && app0.workflowManager),
      hasExtensionManager: !!(app0 && app0.extensionManager),
      hasOpenWorkflow: !!(app0 && app0.extensionManager && app0.extensionManager.workflow && typeof app0.extensionManager.workflow.openWorkflow === "function"),
      nodeCount: app0 && app0.graph && Array.isArray(app0.graph._nodes) ? app0.graph._nodes.length : null,
    });
  }

  const app = comfyApp();
  if (!app) throw new Error("工作区 iframe 未就绪或不可访问（ComfyUI 前端还没起来？）");

  if (op === "canvas.pages") {
    const wf = app.workflowManager && app.workflowManager.activeWorkflow;
    return {
      pages: [{ workflow: wf ? (wf.filename || wf.name || "(未命名)") : "(未命名)", href: location.href }],
      count: 1,
    };
  }

  if (op === "canvas.summary") {
    const g = app.graph;
    return {
      nodeCount: g && Array.isArray(g._nodes) ? g._nodes.length : null,
      linkCount: g && g.links ? Object.keys(g.links).length : null,
      runningNodeId: typeof app.runningNodeId === "number" ? app.runningNodeId : null,
    };
  }

  // P1 落定数据链（2026-10-08，v2 批）：壳页腿补两个读 op——app 层 waitCanvasTargetArrive /
  // waitCanvasLoadSettled 需要「活动页 + 节点数」读数；扩展腿不可达时（代理模式）由壳页腿供数。
  if (op === "exec.running") {
    const svc = app.extensionManager && app.extensionManager.workflow;
    const wf = svc ? svc.activeWorkflow : null;
    return {
      runningNodeId: typeof app.runningNodeId === "number" ? app.runningNodeId : null,
      activeWorkflow: wf ? String(wf.filename || wf.name || "").trim() || null : null,
    };
  }

  if (op === "canvas.revision") {
    // 壳页侧没有桥的变更序号机制（pollGraph 在扩展腿）：不给 revision（调用方按 null 处理）；
    // 只报规模读数；settle 判定退化为「节点数稳定」路径（与桥侧缺字段时同口径）。
    // 拿不到的字段给 undefined（JSON 序列化时被丢弃 → 远端读作 null，避免 null→0 的误读）。
    const g = app.graph;
    return {
      nodes: g && Array.isArray(g._nodes) ? g._nodes.length : undefined,
      links: g && g.links ? Object.keys(g.links).length : undefined,
      lastChangeAt: null,
    };
  }

  if (op === "shell.diag") {
    return shellDiag();
  }

  if (op === "canvas.openWorkflow") {
    const target = String(a.path || a.name || "").trim();
    if (!target) throw new Error("需要 name 或 path");
    const svc = app.extensionManager && app.extensionManager.workflow;
    if (!svc || typeof svc.openWorkflow !== "function") {
      throw new Error("前端没有 workflowService.openWorkflow（版本不支持）");
    }
    const aw0 = svc.activeWorkflow || null;
    const before = aw0 ? (aw0.filename || aw0.path || aw0.name || null) : null;
    // 脏判定双形态（2026-10-08，v2 批；对齐补丁批 workflowDirty）：v1.55.14 isModified 为布尔 getter
    // （ComfyWorkflow._isModified），旧版为函数——原判定只认 function，getter 形态下未保存保护实际失效。
    let dirty = false;
    try {
      const m = aw0 ? aw0.isModified : null;
      if (typeof m === "boolean") dirty = m;
      else if (typeof m === "function") dirty = !!aw0.isModified();
    } catch { dirty = false; }
    if (dirty && a.force !== true) {
      return { opened: false, blocked: "dirty", activeBefore: before };
    }
    const list = wfListOf(svc);
    const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
    const t = norm(target);
    const tNoExt = t.replace(/\.json$/, "");
    let hit = null;
    for (const w of list) {
      if (!w) continue;
      const p = norm(w.path), f = norm(w.filename), n = norm(w.name);
      if (t === p || t === f || t === n) { hit = w; break; }
      if (tNoExt === p.replace(/\.json$/, "") || tNoExt === f.replace(/\.json$/, "") || tNoExt === n) { hit = w; break; }
    }
    if (!hit) {
      return {
        opened: false,
        blocked: "not_found",
        activeBefore: before,
        candidates: list.slice(0, 40).map((w) => w && (w.path || w.filename || w.name)).filter(Boolean),
      };
    }
    // P1 对齐（2026-10-08，v2 批）：原实现调 store 版 svc.openWorkflow(hit)——它只做「激活」
    // （push path → load → activeWorkflow.value 赋值），从不触发画布重绘（半状态、无失败信号；
    // 「只激活不重绘」经 v1.55.14 打包产物核对坐实）。这里对齐桥侧 P1「完整装载」序列：
    //   load → prepareForSave（刷齐 tracker）→ clone activeState → app.loadGraphData(st,true,true,hit,{…})
    // 快返（不等重绘），返回 pending:true + nodeCount + activeAfter（期望值），由 app 层
    //（waitCanvasTargetArrive）按「活动页到达 + 节点数」落定校验后才算成功。
    const wasLoaded = !!hit.isLoaded;
    if (!wasLoaded) await hit.load();
    try { hit.changeTracker?.prepareForSave?.(); } catch { /* 刷不动时按现有 activeState 装载 */ }
    const st = JSON.parse(JSON.stringify(hit.activeState));
    if (!st || typeof st !== "object") throw new Error("取不到 activeState（无法装载）");
    const nodeCount = Array.isArray(st.nodes) ? st.nodes.length : null;
    const expectAfter = hit.filename || hit.name || hit.path || null;
    void Promise.resolve(app.loadGraphData(st, true, true, hit, {
      checkForRerouteMigration: false,
      deferWarnings: false,
      skipAssetScans: wasLoaded && a.force !== true, // 对齐前端：已加载且非 force 时跳过资产扫描
    })).catch((e) => console.warn("[comfyui-hana] openWorkflow loadGraphData 失败", e));
    return {
      opened: true,
      pending: true, // 快返：装载在页面内继续，app 层按 nodeCount / activeAfter 落定校验
      via: "shell",
      matched: (hit && (hit.path || hit.filename || hit.name)) || null,
      activeBefore: before,
      activeAfter: expectAfter,
      nodeCount,
      note: "已发起完整装载（异步）：装载完成后画布刷新并激活该工作流，调用方按 nodeCount / activeAfter 落定校验确认",
    };
  }

  throw new Error(`壳页桥暂不支持的 op：${op}`);
}

async function shellTick() {
  let r;
  try {
    r = await hana.api.fetch("/comfyui-hana/shell/poll?t=" + Date.now(), { cache: "no-store" });
  } catch {
    return; // 工作区还没起来或网络抖动
  }
  if (!r || !r.ok) return;
  let j = null;
  try { j = await r.json(); } catch { return; }
  const ops = (j && j.ops) || [];
  for (const item of ops) {
    let payload;
    try {
      payload = { ok: true, data: await shellOp(item.op, item.args) };
    } catch (e) {
      payload = { ok: false, error: String((e && e.message) || e) };
    }
    try {
      await hana.api.fetch("/comfyui-hana/shell/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rid: item.rid, ...payload }),
      });
    } catch { /* 单条回传失败不影响后续 */ }
  }
}

// ── 窗口标题栏（拖动 + 三键；2026-10-09）────────────────────────────────────
// 仅 App 原生窗口态：window.hanaAppWindow 存在 ⇔ 原生窗口页（卡/iframe 均无；照 hana-builder 先例）。
// 三键直调宿主桥（control/close），不经 backend、不建协议；失败仅 console.warn，不炸页。
function setupTitlebar() {
  const appWin = window.hanaAppWindow;
  if (!appWin) return; // 卡 / iframe 形态：不加显示类，DOM 与样式零变化
  const bar = $("ws-titlebar");
  if (!bar) return;
  bar.classList.add("on");
  const call = (what, fn) => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") r.then(undefined, (e) => console.warn(`[comfyui-hana] 窗口${what}失败：`, e));
    } catch (e) {
      console.warn(`[comfyui-hana] 窗口${what}失败：`, e);
    }
  };
  const tbMin = $("ws-tb-min"), tbMax = $("ws-tb-max"), tbClose = $("ws-tb-close");
  if (tbMin) tbMin.addEventListener("click", () => call("最小化", () => appWin.control("minimize")));
  if (tbMax) tbMax.addEventListener("click", () => call("最大化", () => appWin.control("maximize")));
  if (tbClose) tbClose.addEventListener("click", () => call("关闭", () => appWin.close()));
  // 拖动区双击 → 最大化（Windows 惯例；落在三键上的双击不触发）
  bar.addEventListener("dblclick", (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("button")) return;
    call("最大化", () => appWin.control("maximize"));
  });
}

// ── TODO 踹探针实验（临时代码，验证完按结论处理）──────────────────────────────
// 应答端：主进程（app/index.js 的踹循环）每 10s 经 ctx.windows.request 踹一发 { type:"poke" }，
// 本页收到后【立即同步返回】{ seq, t1: Date.now(), visibility: document.visibilityState }——
// 纯测量，不掺任何异步/耗时逻辑。仅 App 原生窗口态存在（window.hanaAppWindow 桥；卡/iframe 均无
//——照 setupTitlebar 同款防御模式）；全链路 try/catch 静默，注册失败绝不影响正常业务。
// 摘除：删除本块 + main() 内调用行（主进程侧配套见 app/index.js KEEPALIVE_PROBE 实验块）。
function setupKeepalivePokeListener() {
  if (!window.hanaAppWindow) return; // 仅窗口态：无桥则静默跳过
  try {
    if (!hana.window || typeof hana.window.onRequest !== "function") return;
    hana.window.onRequest((message) => {
      if (!message || message.type !== "poke") return undefined; // 非本实验消息：不处理
      return { seq: message.seq, t1: Date.now(), visibility: document.visibilityState };
    });
  } catch { /* 静默：监听注册失败不影响正常业务 */ }
}

// ── TODO 节流探针实验（临时代码，验证完按结论处理）──────────────────────────────
// 心跳端：本页每 10s 把 { t: Date.now(), n, vis: document.visibilityState } 走两条通道：
// ① state 通道：写入探针键 "throttle-probe"（主通道 hana.state.set 实例态——随卡实例持久化、
//    可读回；fallback 走 hana.track 安静日志）；
// ② 网络直采通道：同一心跳经「页面→路由请求」模式（hana.api.fetch，同 syncTheme 的 POST
//    用法）报给 /comfyui-hana/keepalive-probe-ping，后端 append 到
//    app-data/keepalive-probe/hui-page-pulse.jsonl——数据必达，不依赖 state 通道读回。
// 宿主主窗切后台/minimize 时本页若被 Chromium 节流（timer 降频），两条通道的更新都会明显
// 变稀或停摆——外部读回探针记录 / 落盘文件即可判定。窗口态/卡页通用（不做
// window.hanaAppWindow 限制）；全链路 try/catch 静默（含 Promise 拒绝兜底，不留未处理拒绝）。
// 摘除：删除本块 + main() 内调用行 + 网络直采路由（app/index.js keepalive-probe-ping）。
function setupThrottleProbe() {
  const PROBE_KEY = "throttle-probe";
  const PING_ROUTE = "/comfyui-hana/keepalive-probe-ping"; // TODO 实验：网络直采通道
  let n = 0;
  const writeFallback = (rec) => {
    try {
      const p = hana.track?.(PROBE_KEY, rec); // fallback 通道：安静日志（不可用则静默跳过）
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* 静默 */ }
  };
  const sendPing = (rec) => { // TODO 实验：网络直采——失败静默；不重试、不刷屏（Promise 拒绝一并吞掉）
    try {
      const p = hana.api.fetch(PING_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rec),
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* 静默：凭据/网络不可用时不报错 */ }
  };
  setInterval(() => {
    n += 1;
    const rec = { t: Date.now(), n, vis: document.visibilityState };
    try {
      const p = hana.state.set(PROBE_KEY, rec); // 主通道：卡实例态（窗口态不可用时静默兜底）
      if (p && typeof p.catch === "function") p.catch(() => writeFallback(rec));
    } catch {
      writeFallback(rec); // 主通道同步不可用：直接走 fallback
    }
    sendPing(rec); // TODO 实验：网络直采（与 state 同拍、同一 rec，便于两通道对表）
  }, 10000);
}

async function main() {
  readSurfaceSession(); // 窗口 entry 兜底：先把路径段凭据回填进 URL（幂等），再进入任何 hana.api.fetch
  setupTitlebar(); // 自绘标题栏：仅 App 原生窗口态显示（拖动 + 三键；卡/iframe 零变化）
  setupKeepalivePokeListener(); // TODO 踹探针实验（临时代码，验证完按结论处理）：原生窗口态注册踹应答
  setupThrottleProbe(); // TODO 节流探针实验（临时代码，验证完按结论处理）：每 10s 心跳探针（state 写入 + 网络直采报数；窗口态/卡页通用）
  syncTheme();
  // 宿主主题钩子：回调直接给主题快照（theme/cssUrl/appearance/palettes），比自己嗅 CSS 可靠
  try {
    hana.theme?.subscribe?.((snap) => {
      onHostThemeChanged(snap);
      syncTheme();
    });
  } catch { /* 订阅不可用则靠下面的轮询兜底 */ }
  try { await hana.ready(); } catch (e) { console.warn("[comfyui-hana] hana.ready 失败：", e); }
  void tick();
  // 主题变化轮询：不依赖宿主向 App iframe 推送主题变化事件
  setInterval(() => { void themeWatchTick(); }, 2500);
// 壳页桥：向 App 报到并开始轮询待执行的画布 op
try {
  void hana.api.fetch("/comfyui-hana/shell/hello", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
} catch { /* 忽略 */ }
setInterval(() => { void shellTick(); }, SHELL_POLL_MS);
}
void main();
