// ui/workspace.js — ComfyUI 工作区壳页（v2 App 卡片/ui 静态树）
// 三态：booting / ready / error；ready 时内层 iframe 指向宿主代理路径下的 ComfyUI 官方前端。
// 连接方式两种形式并存（宿主阶段对比验证）：
//   · sdk：hana.api.url("/_runtime/<runtimeId>/") —— 官方推荐，含 surface 凭证段
//   · raw：boot-state.proxyPrefix 直接相对路径 —— 依赖宿主登录态授权
// 凭据不入日志、不落存储（localStorage 只存"模式"这个非敏感枚举）。
import { hana } from "./assets/sdk.js";

const $ = (id) => document.getElementById(id);
const els = {
  bar: $("ws-bar"), barText: $("ws-bar-text"), barAction: $("ws-bar-action"),
  loading: $("ws-loading"), frameWrap: $("ws-frame-wrap"), frame: $("ws-frame"),
  boot: $("view-booting"), bootNote: $("boot-note"), bootMeta: $("boot-meta"),
  bootRawWrap: $("boot-raw-wrap"), bootRaw: $("boot-raw"),
  err: $("view-error"), errNote: $("err-note"), errMeta: $("err-meta"),
  errRawWrap: $("err-raw-wrap"), errRaw: $("err-raw"),
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
];
const HANA_VAR_FALLBACK = { "--coral": "--accent-hover", "--sidebar-bg": "--bg-card" };
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

function fetchHostThemeVars() {
  const url = hostThemeCssUrl();
  if (!url) return;
  if (hanaThemeVars && hanaThemeVarsUrl === url) return;
  if (hanaThemeVarsInflight && hanaThemeVarsInflight.url === url) return; // 已在取
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
      if (typeof cv.setDirty === "function") cv.setDirty(true, true);
    }
  } catch (e) {
    console.warn("[comfyui-hana] ComfyUI 主题色写入失败：", e);
  }
  return true;
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
  els.frameWrap.classList.toggle("show", name === "ready");
  if (name !== "ready") { els.loading.classList.remove("show"); }
  if (name === "ready" && !frameLoaded) els.loading.classList.add("show");
}

function setBar(kind, text, actionLabel, actionFn) {
  if (!kind) { els.bar.classList.remove("show"); return; }
  els.bar.className = `show ${kind}`;
  els.barText.textContent = text;
  if (actionLabel && actionFn) {
    els.barAction.style.display = "inline-block";
    els.barAction.textContent = actionLabel;
    els.barAction.onclick = actionFn;
  } else {
    els.barAction.style.display = "none";
    els.barAction.onclick = null;
  }
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
      setBar("warn", `ComfyUI 后端（127.0.0.1:8188）不可达：${(backend && backend.lastError) || "连接失败"}`, "重试", () => { void statusTick(); void postRetryStart().catch(() => {}); });
    } else {
      setBar(null);
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
bindModeSelect($("sel-mode"));
bindModeSelect($("sel-mode2"));
$("btn-retry").addEventListener("click", () => { void postRetryStart().catch(() => {}); els.bootNote.textContent = "已请求启动，等待中继就绪……"; });
$("btn-retry2").addEventListener("click", () => { void postRetryStart().catch(() => {}); els.errNote.textContent = "已请求启动，等待中继就绪……"; });
$("btn-reload-boot").addEventListener("click", () => { void tick(); });
$("btn-reload2").addEventListener("click", () => { try { location.reload(); } catch { /* 忽略 */ } });
els.frame.addEventListener("load", () => {
  frameLoaded = true;
  els.loading.classList.remove("show");
  ensureComfySync(); // 内层文档（重）载入 → 重新对齐基座色板与主题色
});

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 订阅不可用则保留首帧 */ }
  try { await hana.ready(); } catch (e) { console.warn("[comfyui-hana] hana.ready 失败：", e); }
  void tick();
}
void main();
