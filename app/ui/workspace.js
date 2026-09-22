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

// ── 安装引导弹窗（未检测到 ComfyUI 时）─────────────────────────────────────
// 流程：step1 选方式（助手装 / 自己装）→ step2 选位置 + 动作（直接发起 / 复制指令）→ step3 完成
const GUIDE_SEEN_KEY = "comfyui-hana.install-guide.seen";
let guideOpen = false;
let guideSelected = null;
let guideCustomPath = null;

function guideSeen() { try { return localStorage.getItem(GUIDE_SEEN_KEY) === "1"; } catch { return false; } }
function markGuideSeen() { try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* 忽略 */ } }

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
    "安装文档：ComfyUI-Hana 技能目录下的 INSTALL.md（Windows 主线）",
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
      const env = st.relay && st.relay.env ? st.relay.env : null;
      const hit = env && Array.isArray(env.installs) && env.installs.length ? env.installs[0] : null;
      const retryRelay = { label: "重启中继", fn: () => { void statusTick(); void postRetryStart().catch(() => {}); } };
      if (hit) {
        setBar("warn", `ComfyUI 服务未运行（已检测到安装：${hit.path}）。`, [
          { label: "启动服务", fn: () => { void startBackend(); } },
          retryRelay,
        ]);
      } else {
        setBar("warn", "未检测到 ComfyUI 环境。", [
          { label: "安装引导", fn: () => { guideShow(1); } },
          retryRelay,
        ]);
        // 首次检测到「未安装」自动弹引导（每浏览器一次；关掉后可从顶栏重开）
        if (env && env.found === false && !guideSeen() && !guideOpen) {
          markGuideSeen();
          guideShow(1);
        }
      }
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
