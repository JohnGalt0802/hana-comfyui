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
  loading: $("ws-loading"), frameWrap: $("ws-frame-wrap"), frame: $("ws-frame"),
  boot: $("view-booting"), bootNote: $("boot-note"), bootMeta: $("boot-meta"),
  bootRawWrap: $("boot-raw-wrap"), bootRaw: $("boot-raw"),
  err: $("view-error"), errNote: $("err-note"), errMeta: $("err-meta"),
  errRawWrap: $("err-raw-wrap"), errRaw: $("err-raw"),
  offline: $("view-offline"), offNote: $("off-note"), offMeta: $("off-meta"),
};

const MODE_KEY = "comfyui-hana.workspace.urlMode";
let mode = "auto";
try { mode = localStorage.getItem(MODE_KEY) || "auto"; } catch { mode = "auto"; }

let bootTimer = null;
let statusTimer = null;
let frameRuntimeId = null; // 已装载 iframe 对应的 runtimeId；变化即整页重载
let frameLoaded = false;

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
let themeHeartbeatAt = 0;
async function themeWatchTick() {
  const url = hostThemeCssUrl();
  if (!url) return;
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const vars = parseThemeCssVars(await r.text());
    const sig = `${vars["--bg"] || ""}|${hostThemeIsDark() ? "dark" : "light"}`;
    if (!themeSigSeen) { themeSigSeen = sig; hanaThemeVars = vars; hanaThemeVarsUrl = url; return; } // 首帧只记录
    if (Date.now() - themeHeartbeatAt > 30_000) { // 心跳：确认轮询在跑且看到什么值
      themeHeartbeatAt = Date.now();
      void reportDiag({ at: "themePollHeartbeat", sig, seen: themeSigSeen, vars: Object.keys(vars).length, direct: frameIsDirect, frame: !!frameRuntimeId });
    }
    if (sig === themeSigSeen) return;
    themeSigSeen = sig;
    hanaThemeVars = vars;      // 用刚取到的新值，绕开按 URL 的缓存
    hanaThemeVarsUrl = url;
    void reportDiag({ at: "themePollChanged", sig, direct: frameIsDirect, frame: !!frameRuntimeId });
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
        void reportDiag({ at: "themeReloadIframe", url: u.origin + u.pathname });
        return;
      }
    } catch { /* 落到整页刷新 */ }
    try { location.reload(); } catch { /* 忽略 */ }
  }, 1200);
}

// 诊断上报（临时）：把主题链路的关键状态写给中继日志。定位完可删。
function reportDiag(payload) {
  try {
    void hana.api.fetch("/comfyui-hana/diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).catch(() => {});
  } catch { /* 忽略 */ }
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
    else void reportDiag({ at: "themeHookPushFailed", err: (r && r.error) || "unknown" });
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
function showView(name) {
  els.boot.classList.toggle("show", name === "booting");
  els.err.classList.toggle("show", name === "error");
  els.offline.classList.toggle("show", name === "offline");
  els.frameWrap.classList.toggle("show", name === "ready");
  if (name !== "ready") { els.loading.classList.remove("show"); }
  if (name === "ready" && !frameLoaded) els.loading.classList.add("show");
}

function setBar(kind, text, actions = []) {
  if (!kind) { els.bar.classList.remove("show"); return; }
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
  if (svcRequestedAt) bits.push(`已等待 ${Math.round((Date.now() - svcRequestedAt) / 1000)} 秒`);
  if (proc && proc.lastError) bits.push(`上次错误：${proc.lastError}`);
  els.offMeta.textContent = bits.join(" · ");
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
function readSurfaceSession() {
  try { return new URLSearchParams(location.search).get("appSurfaceSession") || null; } catch { return null; }
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
  statusTimer = setInterval(() => { void statusTick(); }, 3000);
  void statusTick();
}
function stopStatusPolling() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  setBar(null);
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
    if (!reachable) {
      // 覆盖层承担提示（比顶栏更清楚），避免 iframe 直接渲染中继的 ECONNREFUSED JSON
      setBar(null);
      showOffline(st);
    } else {
      if (svcRequestedAt) { svcRequestedAt = 0; $("off-note").textContent = ""; }
      if (els.offline.classList.contains("show")) {
        showView("ready");
        ensureComfySync(); // 服务刚回来，重新对齐主题
      }
      // 服务运行中：顶栏常驻服务控制（与左侧状态面板互为入口，工作区内也能直接关）
      if (themeStaleAfterLoad) {
        setBar("info", "宿主主题已更新，正在刷新工作区…", []);
      } else {
        setBar("info", "ComfyUI 服务运行中", [
          { label: "停止服务", fn: () => { void stopBackend(); } },
          { label: "重启中继", fn: () => { void postRetryStart().catch(() => {}); } },
        ]);
      }
    }
  } catch { /* 状态读取失败不打扰界面 */ }
}

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
els.frame.addEventListener("load", () => {
  frameLoaded = true;
  els.loading.classList.remove("show");
  ensureComfySync(); // 内层文档（重）载入 → 重新对齐基座色板与主题色
});

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  // 宿主主题钩子：回调直接给主题快照（theme/cssUrl/appearance/palettes），比自己嗅 CSS 可靠
  try {
    hana.theme?.subscribe?.((snap) => {
      console.log("[comfyui-hana] 宿主主题钩子触发", snap && snap.theme, snap && snap.appearance);
      void reportDiag({
        at: "themeHook",
        theme: (snap && snap.theme) || null,
        appearance: (snap && snap.appearance) || null,
        cssUrl: (snap && snap.cssUrl) || null,
        direct: frameIsDirect,
        frame: !!frameRuntimeId,
      });
      onHostThemeChanged(snap);
      syncTheme();
    });
  } catch { /* 订阅不可用则靠下面的轮询兜底 */ }
  try { await hana.ready(); } catch (e) { console.warn("[comfyui-hana] hana.ready 失败：", e); }
  void tick();
  // 主题变化轮询：不依赖宿主向 App iframe 推送主题变化事件
  setInterval(() => { void themeWatchTick(); }, 2500);
}
void main();
