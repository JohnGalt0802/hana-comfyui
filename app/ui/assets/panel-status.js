// ui/assets/panel-status.js — Hana-ComfyUI 功能面板（整页工作区左侧栏）
// 三块：连接状态（/comfyui-hana/status）+ 主机指标图表（/comfyui-hana/metrics）+ 释放显存
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);

// ── 主题跟随 ──────────────────────────────────────────────────────────────
// 2026-10-11 修复：面板主题不跟随（整块白底）。
// 症结：`hana.theme.getSnapshot()` 的值来自宿主注入的 URL 参数，只在宿主推 THEME_CHANGED 时
// 更新；宿主刚更新过卡片/面板系统后本页确实可能拿不到快照（值空）→ 旧逻辑直接落到
// `prefers-color-scheme`，系统浅色就把面板判成浅色 → 白底。
// 改为三级判定（可靠性从高到低）：
//   ① 快照明确给出 appearance / 主题名 → 按原有正则判（保留，不删）；
//   ② 快照不可用 → 直接看色值：拉宿主主题 CSS 取 `--bg`，luma > 0.5 判浅色
//      （抄 workspace.js 的 parseThemeCssVars / cssColorToRgb / themeIsLightByColor。
//       为什么加色值兜底：明暗的权威来源是主题**实际色值**，主题名正则和系统偏好都不可靠——
//       正则覆盖不了全部主题名，系统偏好又与宿主主题无关）；
//   ③ 色值也拿不到 → 才回落 prefers-color-scheme。
// syncTheme() 幂等、可重复调用（宿主推 / 订阅回调 / 低频轮询都会调）：色值解析结果按 URL 缓存，
// 签名不变不重复拉取、不重复写 DOM。
const PANEL_THEME_POLL_MS = 4000;                          // 低频轮询：订阅失效时的最后保险
const PANEL_THEME_CSS_FALLBACK = "/api/apps/theme.css";    // 不带 theme 参数 → 服务端默认主题

let panelThemeVars = null;        // 已解析的宿主主题变量表（含 --bg）
let panelThemeVarsUrl = null;     // 上面这份变量表对应的 CSS URL
let panelThemeVarsFailed = new Set(); // 取不到 --bg 的 CSS URL（不再反复重试）
let panelThemeInflight = null;    // 正在拉的 CSS URL（同一 URL 不并发重复拉）
let lastThemeDecision = null;     // 上一次判定 { dark, tier }：仅变化时打日志

function safeThemeSnapshot() {
  try { return hana.theme?.getSnapshot?.() || null; } catch { return null; }
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// 主题 CSS 候选地址（按可靠性排序）：快照 → 页面 URL 参数 → 端点默认主题
function themeCssUrlCandidates() {
  const out = [];
  const snap = safeThemeSnapshot();
  if (snap && typeof snap.cssUrl === "string" && snap.cssUrl) out.push(snap.cssUrl);
  let params = null;
  try { params = new URLSearchParams(window.location.search); } catch { params = null; }
  if (params) {
    const fromParam = params.get("hana-css");
    if (fromParam) out.push(fromParam);
    const themeId = params.get("hana-theme");
    if (themeId) out.push(`${PANEL_THEME_CSS_FALLBACK}?theme=${encodeURIComponent(themeId)}`);
  }
  out.push(PANEL_THEME_CSS_FALLBACK);
  return out.filter((u, i) => u && out.indexOf(u) === i);
}

// ── 色值工具（与 workspace.js 同一套口径）───────────────────────────────
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

// --bg 实际亮度：luma > 0.5 即浅色；取不到色值返回 null（交给下一级/下一候选）
function themeIsLightByBg(vars) {
  if (!vars) return null;
  const bg = vars["--bg"] || vars["--bg-card"] || vars["--sidebar-bg"];
  const rgb = cssColorToRgb(bg || "");
  if (!rgb) return null;
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luma > 0.5;
}

// 一级判定：快照明确给了 appearance / 主题名才给结果，否则 null（交给二级）
function tier1Decision() {
  const snap = safeThemeSnapshot();
  const label = String(snap?.theme || "");
  const ap = snap && snap.appearance;
  if (ap === "dark") return { dark: true, detail: "appearance=dark" };
  if (ap === "light") return { dark: false, detail: "appearance=light" };
  if (label && label !== "inherit" && label !== "auto") {
    // 保留原有正则：命中暗色关键词判暗；拿到具体主题名但未命中则判亮
    return { dark: /dark|midnight|contrast|深|夜/i.test(label), detail: `theme=${label}` };
  }
  return null;
}

function applyThemeDecision(dark, tier, detail) {
  // 幂等：结果与当前 class 一致就不碰 DOM（宿主推、订阅回调、轮询都会调到）
  const roots = [document.documentElement, document.body];
  if (document.body.classList.contains("t-dark") !== dark) {
    for (const el of roots) if (el) el.classList.toggle("t-dark", dark);
  }
  // 同步根元素 color-scheme（panel.html 里 :root.t-dark 用它换 iframe 画布底色）：
  // 白底块的直接来源就是根元素 color-scheme 与主题不合拍，body.t-dark 管不到它。
  const want = dark ? "dark" : "light";
  try {
    if (document.documentElement && document.documentElement.style.colorScheme !== want) {
      document.documentElement.style.colorScheme = want;
    }
  } catch { /* 忽略 */ }
  // 有宿主 --bg 色值时，直接把面板底涂成宿主底色（一个直接治「白底」的强兜底；无值时保持透明）
  try {
    const bg = panelThemeVars && (panelThemeVars["--bg"] || panelThemeVars["--bg-card"]);
    const cur = document.documentElement.style.background;
    if (bg && cur !== bg) document.documentElement.style.background = bg;
  } catch { /* 忽略 */ }
  if (!lastThemeDecision || lastThemeDecision.dark !== dark || lastThemeDecision.tier !== tier) {
    try { console.debug(`[comfyui-hana] 面板主题判定：dark=${dark} ← 第 ${tier} 级（${detail}）`); } catch { /* 忽略 */ }
  }
  lastThemeDecision = { dark, tier, detail };
  // 自查用：面板页 console 里 `__comfyPanelTheme` 看判定依据/结果，`__comfyPanelThemeRefresh()` 手动重判
  try {
    window.__comfyPanelTheme = { dark, tier, detail, at: new Date().toISOString(), cssUrl: panelThemeVarsUrl, snapshot: safeThemeSnapshot() };
  } catch { /* 忽略 */ }
}

// 二级所需的色值：拉宿主主题 CSS 并缓存；同一 URL 不并发重复拉，成功后重跑一次判定（命中缓存）
function ensureThemeVars(force) {
  const candidates = themeCssUrlCandidates();
  const target = candidates.find((u) => !panelThemeVarsFailed.has(u)) || candidates[0] || null;
  if (!target) return;
  if (!force && panelThemeVars && panelThemeVarsUrl === target) return;                 // 已缓存
  if (panelThemeInflight) return;                                                       // 已有一单在飞
  panelThemeInflight = target;
  fetch(target, { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("theme css HTTP " + r.status))))
    .then((text) => {
      const vars = parseThemeCssVars(text);
      if (themeIsLightByBg(vars) === null) throw new Error("theme css 无可用色值");
      panelThemeVars = vars;
      panelThemeVarsUrl = target;
      panelThemeVarsFailed.delete(target);
      syncTheme(); // 色值就绪 → 重判（此时命中缓存，不再发起请求）
    })
    .catch((e) => {
      panelThemeVarsFailed.add(target);
      if (panelThemeVarsUrl === target) panelThemeVarsUrl = null;
      try { console.warn("[comfyui-hana] 面板主题色值兜底失败：", (e && e.message) || e); } catch { /* 忽略 */ }
    })
    .finally(() => { if (panelThemeInflight === target) panelThemeInflight = null; });
}

function syncTheme(opts) {
  const force = !!(opts && opts.force);

  // ① 快照明确 → 直接用（判定不依赖 CSS）
  const t1 = tier1Decision();
  if (t1) {
    applyThemeDecision(t1.dark, 1, t1.detail);
    void ensureThemeVars(false); // 后台补一次主题 CSS（每主题一次、缓存）→ 拿到 --bg 好上底色
    return;
  }

  // ② 色值（缓存命中即同步判定；未就绪先按三级给初值，拉取成功后自动重判）
  const best = themeCssUrlCandidates()[0] || null;
  const vars = (panelThemeVars && (!best || panelThemeVarsUrl === best)) ? panelThemeVars : null;
  const light = themeIsLightByBg(vars);
  if (light !== null) {
    applyThemeDecision(!light, 2, `${best || "cached"} --bg=${vars["--bg"] || vars["--bg-card"] || vars["--sidebar-bg"]}`);
    if (!force) return;
  } else {
    // ③ 色值拿不到 → 回落系统偏好
    applyThemeDecision(systemPrefersDark(), 3, "prefers-color-scheme");
  }
  void ensureThemeVars(force);
}

// ── 连接状态 ──────────────────────────────────────────────────────────────
const PHASE_LABEL = { idle: "待启动", starting: "启动中", ready: "就绪", error: "错误", stopped: "已停止" };

function chip(text, cls) {
  return `<span class="chip ${cls || ""}">${text}</span>`;
}

// p-note 操作反馈位：有消息才显示；无消息清空并隐藏（display:none）
function setNote(text) {
  const el = $("p-note");
  const t = text ? String(text) : "";
  el.textContent = t;
  el.style.display = t ? "" : "none";
}

function render(st) {
  const boot = st.boot || {};
  const relay = st.relay || null;
  const backend = relay && relay.backend ? relay.backend : null;
  // ── 三态判定（2026-10-08，P5）：① 中继不可达（st.relayError）② 服务未跑（backend 存在且不可达）③ 就绪 ──
  // 中继不可达时快照可能陈旧：后端可达性不可信 → 不判就绪、不显示「启动服务」（请求也送不到中继）。
  const relayDown = st.relayError != null;
  $("p-phase").innerHTML = relayDown
    ? chip("中继不可达", "bad")
    : chip(PHASE_LABEL[boot.phase] || String(boot.phase || "?"), boot.phase === "ready" ? "ok" : (boot.phase === "error" ? "bad" : "warn"));
  if (backend && !relayDown) {
    $("p-backend").innerHTML = backend.reachable ? chip("可达", "ok") : chip("服务未跑", "bad");
  } else {
    $("p-backend").textContent = "—";
  }
  const sys = backend && !relayDown && backend.system ? backend.system : null;
  const verText = sys && sys.comfyui_version
    ? `${sys.comfyui_version}${sys.installed_frontend_version ? " · 前端 " + sys.installed_frontend_version : ""}`
    : "";
  $("p-ver").textContent = verText || "—";
  // 空值不占行（2026-10-16）：服务未跑时版本行、队列胶囊都隐藏，不留“—”占位
  const verRow = $("row-ver");
  if (verRow) verRow.hidden = !verText;
  const q = !relayDown && relay && relay.queue ? relay.queue : null;
  const qText = q ? `${q.running} 运行 · ${q.pending} 排队` : "";
  const qEl = $("p-queue");
  if (qEl) { qEl.textContent = qText; qEl.hidden = !qText; }

  // ── 主状态句（2026-10-16）：把三态判定的结论用一句话写在最上面，
  //    替代原先「五行流水账里自己找哪行是红的」。判定与下方 chip / 信号灯同源（同一份 st）。
  const mainEl = $("p-main");
  if (mainEl) {
    let text = "读取中…", cls = "";
    if (relayDown) { text = "中继不可达"; cls = "bad"; }
    else if (boot.phase === "error") { text = "中继启动失败"; cls = "bad"; }
    else if (boot.phase === "starting") { text = "中继启动中…"; cls = "warn"; }
    else if (boot.phase === "idle" || boot.phase === "stopped") { text = "中继待启动"; cls = "warn"; }
    else if (boot.phase !== "ready") { text = "中继状态未知"; cls = "warn"; }
    else if (!(backend && backend.reachable)) { text = "ComfyUI 服务未运行"; cls = "bad"; }
    else { text = "服务运行中"; cls = "ok"; }
    mainEl.textContent = text;
    mainEl.className = "sc-main" + (cls ? " " + cls : "");
  }

  lastStatus = st; // 信号灯推导用

  // 服务起停（2026-10-16 合并为单按钮）：同一时刻服务只可能是「开着」或「关着」，
  // 文案与语义随 reachable 切换：就绪 → 「停止服务」（danger）；未跑 → 「启动服务」（primary）；
  // 中继不可达 → 按钮禁用（请求送不到中继），引导去「维护 → 重启中继」。
  const reachable = !!(backend && backend.reachable) && !relayDown; // 保守：中继不可达时后端可达性不可信
  const proc = backend && backend.proc ? backend.proc : null;
  const svcBtn = $("p-svc");
  // 启动等待：本左栏等待态（svcStarting）∪ 服务端权威启动中（proc.starting）——
  // 后者覆盖「从壳页点启动」，使本左栏也显示秒表（2026-10-14 两侧同源）。
  const waiting = svcStarting || !!(proc && proc.starting === true);
  const waitStart = svcWaitStart(proc, svcStartAt); // 同源起点（服务端 startedAt 优先）
  // 启动等待收尾（2026-10-08 三态扩展）：
  //  · 观测到 reachable（且中继在线）→ 就绪收尾；
  //  · 中继不可达 → 结束等待（无法确认），文案改「已受理，待中继恢复确认」；
  //  · 服务端权威失败（lastStartResult.ok=false 且晚于本次等待起点）→ 失败收尾，不等 120s。
  const justReady = waiting && reachable;
  if (justReady) endSvcStart();
  else if (waiting && relayDown) {
    endSvcStart();
    svcNoteMsg = "已受理，待中继恢复确认。";
    svcNoteRelay = true;
    showSvcRetry();
  } else if (waiting && proc && !relayDown) {
    const lr = proc.lastStartResult;
    const lrAt = lr && lr.at ? Date.parse(lr.at) : NaN;
    if (lr && lr.ok === false && Number.isFinite(lrAt) && lrAt >= waitStart - 2000) {
      svcFail("启动失败：" + (lr.error || "服务端报告启动未成功"));
    }
  }
  if (reachable) { svcNoteMsg = ""; svcNoteRelay = false; hideSvcRetry(); }
  else if (!relayDown && svcNoteRelay) { svcNoteMsg = ""; svcNoteRelay = false; hideSvcRetry(); } // 中继已恢复：撤下「待中继恢复确认」
  if (!svcBusy) {
    if (relayDown) {
      // 中继不可达：请求送不到中继 → 按钮禁用，由「维护 → 重启中继」负责恢复
      svcBtn.disabled = true;
      svcBtn.className = "primary";
      svcBtn.textContent = "启动服务";
      svcBtn.title = "中继不可达：请先在「维护」里重启中继";
    } else {
      svcBtn.disabled = false;
      if (svcStarting && !reachable) { // 持久「启动中」：保持禁用，待就绪/失败/超时收尾
        svcBtn.disabled = true;
        svcBtn.className = "primary";
        svcBtn.textContent = "启动中…";
        svcBtn.title = "正在启动 ComfyUI 服务…";
      } else if (reachable) {
        // 就绪 → 这个按钮变成「停止」（同一位置同一按钮，不另占一行）
        svcBtn.className = "danger";
        svcBtn.textContent = "停止服务";
        svcBtn.title = "终止 8188 上的 ComfyUI 进程（正在跑的任务会中断）";
      } else {
        svcBtn.className = "primary";
        svcBtn.textContent = "启动服务";
        const hasInstall = !!(proc && (proc.install || proc.python || proc.mainPy));
        svcBtn.title = hasInstall
          ? `启动 ComfyUI：${proc.python || proc.mainPy || ""}`
          : "按本机安装探测结果拉起 ComfyUI（由计划任务以当前用户身份起，独立于 Hana 存活）";
      }
    }
  }

  // ── 诊断详情（2026-10-16）：安装根 / 进程 / 拉起时间逐行列出，不再挤成一行长句；
  //    归入「维护」折叠区，默认不占版面。空值不占行。
  const diagLines = [];
  if (boot.note) diagLines.push(boot.note);
  if (proc) {
    if (proc.install) diagLines.push(`安装根 ${proc.install}`);
    if (reachable && Array.isArray(proc.pids) && proc.pids.length) diagLines.push(`监听进程 ${proc.pids.join(", ")}`);
    const stamp = (iso) => String(iso).replace("T", " ").slice(0, 19);
    if (proc.startedAt) diagLines.push(reachable ? `本 App 拉起于 ${stamp(proc.startedAt)}` : `上次由本 App 拉起：${stamp(proc.startedAt)}`);
    if (!reachable && proc.lastStop && proc.lastStop.at) diagLines.push(`上次停止：${stamp(proc.lastStop.at)}`);
  }
  const detailEl = $("p-detail");
  if (detailEl) {
    detailEl.replaceChildren();
    for (const line of diagLines) {
      const d = document.createElement("div");
      d.textContent = line;
      d.title = line; // 长路径截断后悬停可看全
      detailEl.appendChild(d);
    }
  }
  // p-note：仅操作反馈（启动等待/失败/已运行/停止结果等即时消息）；无消息 → 清空并隐藏
  if (justReady) {
    setNote("ComfyUI 服务已就绪。");
    setWait("");
  } else if (waiting) {
    // 等待就绪中：秒表由 renderSvcWaitNote 维护（写 #p-wait），此处不覆盖
  } else if (svcNoteMsg) {
    setNote(svcNoteMsg);
  } else if (relayDown) {
    setNote("中继不可达，可点「重启中继」尝试恢复。"); // 三态① 的常驻提示（2026-10-08）
    showSvcRetry();
  } else {
    setNote("");
    hideSvcRetry(); // 无消息且中继在线 → 清掉遗留的快捷操作
  }
  const errText = (boot.error && boot.error.userText) || st.relayError || (backend && !backend.reachable ? backend.lastError : "");
  const procErr = proc && proc.lastError ? `服务：${proc.lastError}` : "";
  $("p-err").textContent = [errText ? `${(boot.error && boot.error.code) || "err"}：${errText}` : "", procErr].filter(Boolean).join("\n");
  // 秒表 tick 生命周期（复用既有 1s interval，不新增常驻定时器）：等待中确保运行、否则停掉并清空计时行。
  // reachable 排除收尾帧（justReady 已 endSvcStart，但同帧 proc.starting 可能仍为 true）。
  const waitingNow = !reachable && (svcStarting || !!(proc && proc.starting === true));
  syncSvcWaitTimer(waitingNow);
  if (waitingNow) renderSvcWaitNote();
  else setWait("");
  applySignal();
}

async function poll() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/status", { cache: "no-store" });
    const st = await r.json();
    // 乐观覆盖退场校验：仅当快照晚于操作时刻（确为「停止之后」的数据）才交还给真实数据，
    // 防止 app 侧快照尚未刷新的陈旧一帧把红点误刷回绿。
    if (sigOpt) {
      const snapAt = st && st.snapshotAt ? Date.parse(st.snapshotAt) : NaN;
      if (Number.isFinite(snapAt) && snapAt > sigOpt.at) sigOpt = null;
    }
    lastStatusOkAt = Date.now(); // 自愈判定用：最近一次成功取数时刻
    render(st);
  } catch (e) {
    if (!svcStarting) setNote("状态读取失败：" + String((e && e.message) || e)); // 等待态由秒表维护，不覆盖
  }
}
let lastStatusOkAt = 0; // 最近一次 /comfyui-hana/status 成功取数时刻（2026-10-16 自愈用）

// 快速轮询波：start/stop 请求结束后，在 0/0.8/1.6/3/5s 各拉一次状态（替换原先的单次 poll），
// 让「停止→不可达」「启动中→就绪」的翻转尽快被捕捉。与 2s 常规轮询并行、互为补充。
const POLL_BURST_DELAYS_MS = [0, 800, 1600, 3000, 5000];
function pollBurst() {
  for (const ms of POLL_BURST_DELAYS_MS) setTimeout(() => { void poll(); }, ms);
}

// ── 主机指标图表（任务管理器风格：右对齐滚动；数据来自 /comfyui-hana/metrics）──
const MAX_POINTS = 60;
const COLORS = { util: "#537d96", vram: "#6a8b52", temp: "#9D5F4D", pwr: "#8a6fb5", cpu: "#5a7fb0", ram: "#a8843f" };
const hist = { util: [], vram: [], temp: [], pwr: [], cpu: [], ram: [] };

function drawChart(canvasId, series, color) {
  try {
    const cv = $(canvasId);
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const W = cv.width = cv.clientWidth || 180;
    const H = cv.height = cv.clientHeight || 38;
    ctx.clearRect(0, 0, W, H);
    const padB = 2;
    let maxV = 1;
    for (let i = 0; i < series.length; i++) if (series[i] > maxV) maxV = series[i];
    const x = (i) => W - (series.length - i) * (W / MAX_POINTS);
    const y = (v) => (H - padB) - (v / maxV) * (H - padB);
    ctx.strokeStyle = "rgba(127,127,127,.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - padB); ctx.lineTo(W, H - padB); ctx.stroke();
    if (!series.length) return;
    ctx.fillStyle = color + "22";
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    for (let j = 0; j < series.length; j++) ctx.lineTo(x(j), y(series[j]));
    ctx.lineTo(x(series.length - 1), y(0));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k < series.length; k++) {
      if (k === 0) ctx.moveTo(x(k), y(series[k])); else ctx.lineTo(x(k), y(series[k]));
    }
    ctx.stroke();
  } catch { /* 绘制失败不影响其它区 */ }
}

function pushPoint(arr, v) {
  arr.push(Number.isFinite(v) ? v : 0);
  if (arr.length > MAX_POINTS) arr.shift();
}

function redrawAll() {
  drawChart("c-util", hist.util, COLORS.util);
  drawChart("c-vram", hist.vram, COLORS.vram);
  drawChart("c-temp", hist.temp, COLORS.temp);
  drawChart("c-pwr", hist.pwr, COLORS.pwr);
  drawChart("c-cpu", hist.cpu, COLORS.cpu);
  drawChart("c-ram", hist.ram, COLORS.ram);
}

function fmtPct(v) { return v == null ? "—" : `${Number(v).toFixed(0)}%`; }
function fmtGB(mib) { return mib == null ? "—" : `${(mib / 1024).toFixed(1)} GB`; }

function renderMetrics(m) {
  if (!m || m.ok === false) {
    $("m-note").textContent = m && m.error ? `指标不可用：${m.error}` : "指标读取中…";
    return;
  }
  $("m-note").textContent = "";
  const g = m.gpu || null;
  const cpu = m.cpu || null;
  const mem = m.mem || null;
  if (g) {
    $("m-gpu-name").textContent = g.name || "GPU";
    $("v-util").textContent = fmtPct(g.utilPct);
    $("v-vram").textContent = g.memoryTotalMiB
      ? `${(g.memoryUsedMiB / 1024).toFixed(1)}/${(g.memoryTotalMiB / 1024).toFixed(1)} GB`
      : "—";
    $("v-temp").textContent = g.tempC == null ? "—" : `${g.tempC}°C`;
    $("mon-temp-v").textContent = g.tempC == null ? "—" : `${g.tempC}°C`; // 折叠态一行温度（与 v-temp 同源）
    $("v-pwr").textContent = g.powerW == null ? "—" : `${Math.round(g.powerW)}W`;
    pushPoint(hist.util, g.utilPct);
    pushPoint(hist.vram, g.memoryTotalMiB ? (g.memoryUsedMiB / g.memoryTotalMiB) * 100 : null);
    pushPoint(hist.temp, g.tempC);
    pushPoint(hist.pwr, g.powerW);
  } else {
    $("m-gpu-name").textContent = "GPU 不可用";
    $("mon-temp-v").textContent = "—";
    if (m.gpuError) $("m-note").textContent = `GPU 采集失败：${m.gpuError}`;
  }
  $("v-cpu").textContent = cpu ? `${fmtPct(cpu.usagePct)}${cpu.cores ? ` · ${cpu.cores}核` : ""}` : "—";
  $("v-ram").textContent = mem ? `${(mem.usedMiB / 1024).toFixed(1)}/${(mem.totalMiB / 1024).toFixed(1)} GB` : "—";
  pushPoint(hist.cpu, cpu ? cpu.usagePct : null);
  pushPoint(hist.ram, mem ? mem.usedPct : null);
  redrawAll();
}

async function metricsTick() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/metrics", { cache: "no-store" });
    renderMetrics(await r.json());
  } catch (e) {
    $("m-note").textContent = "指标读取失败：" + String((e && e.message) || e);
  }
}

// ── 折叠区开合记忆（监视器/更新/维护默认折叠；选择记忆到 localStorage，各工作区共享一份）──
// 2026-10-18：补 null 保护——版面调整后 id 可能被移除/改名，缺元素时静默跳过而不是抛错
// （曾因此整份模块在顶层抛错 → 宿主左栏显示「App 面板加载失败」）。
function bindFold(id, key, onToggle) {
  const el = $(id);
  if (!el) return;
  try { el.open = localStorage.getItem(key) === "1"; } catch { /* 忽略 */ }
  el.addEventListener("toggle", () => {
    try { localStorage.setItem(key, el.open ? "1" : "0"); } catch { /* 忽略 */ }
    if (onToggle) onToggle();
  });
}
bindFold("fold-mon", "comfyui-hana.panel.monitorOpen", () => redrawAll()); // 展开/收起即重绘（隐藏期画布宽度不可靠）

// ── 服务起停（启动/停止 8188 上的 ComfyUI 本体）─────────────────────────
// 启动体验对齐工作区弹窗（2026-10-03）：点击即进入持久「启动中」态 —— 按钮禁用 +
// note 等待文案 + 每秒「已等待 XX 秒」；poll 观测到 reachable 自动收尾；失败/超时
// （120s）给明确提示 + 「重启中继」快捷操作。此前实现中请求一返回按钮即复原、note
// 被 2s 轮询立刻覆盖 —— 30～90 秒等待期零反馈（「点了像没反应」的成因）。
let svcBusy = false;      // 请求瞬态（防双击）
let svcStarting = false;  // 持久等待态：请求受理后 → reachable / 失败 / 超时 收尾
let svcStartAt = 0;
let svcWaitTimer = null;
let svcNoteMsg = "";      // 粘性提示（启动失败等）：非空时优先于常规状态文本
let svcNoteRelay = false; // 该粘性提示是「中继不可达」收尾文案（2026-10-08）：中继恢复后自动撤下
let svcWaitFailStart = 0; // 已对哪个起点报过超时/失败（防服务端仍在途时反复重报）
const SVC_START_TIMEOUT_MS = 120_000;
const SVC_START_NOTE = "已请求启动 ComfyUI 服务，等待就绪（首次约 30～90 秒）…";

// 启动等待起点（两侧共享契约，与 workspace.js 逐字一致，2026-10-14）：
// 服务端权威优先（proc.startedAt，跨页一致、中继重启可恢复），本地起点仅作「点击瞬间到快照刷新之间」的兜底。
function svcWaitStart(proc, localStart) {
  if (proc && proc.starting === true && proc.startedAt) {
    const t = Date.parse(proc.startedAt);
    if (Number.isFinite(t)) return t;      // 服务端权威（跨页一致）
  }
  return localStart || 0;                   // 本地兜底
}

// 等待计时行（#p-wait）：等待期显示即占位，非等待期 hidden 不占位
function setWait(text) {
  const el = $("p-wait");
  if (!el) return;
  const t = text ? String(text) : "";
  el.textContent = t;
  el.hidden = !t;
}

// 秒表 tick 生命周期：需要等待（本地态 ∪ 服务端 starting）且未跑时启动；不再需要时停掉。
// 复用既有 1s interval，不新增常驻定时器（本文件 setInterval 计数不变）。
function syncSvcWaitTimer(need) {
  if (need) {
    if (!svcWaitTimer) svcWaitTimer = setInterval(() => { svcWaitTick(); }, 1000);
  } else if (svcWaitTimer) {
    clearInterval(svcWaitTimer);
    svcWaitTimer = null;
  }
}

function setSvcBusy(on, label) {
  svcBusy = on;
  const btn = $("p-svc");
  if (on) { btn.disabled = true; btn.textContent = label || "处理中…"; }
  else { btn.disabled = false; pollBurst(); } // 起停请求收尾：文案由下一轮 render 按 reachable 重写；并快速轮询波
}

function showSvcRetry() { $("p-note-actions").style.display = ""; }
function hideSvcRetry() { $("p-note-actions").style.display = "none"; }

function renderSvcWaitNote() {
  // 叠加服务端权威字段（2026-10-08）：proc.starting=true 说明启动确在途，等待可继续放心
  const proc = lastStatus && lastStatus.relay && lastStatus.relay.backend ? lastStatus.relay.backend.proc : null;
  const startAt = svcWaitStart(proc, svcStartAt); // 起点同源：服务端 startedAt 优先，本地兜底
  // 主句与壳页覆盖层（workspace.js showOffline）逐字一致
  setWait(`已等待 ${Math.max(0, Math.round((Date.now() - startAt) / 1000))} 秒`);
  setNote(`${SVC_START_NOTE}${proc && proc.starting === true ? "\n（服务端标记：启动中）" : ""}`);
}

function endSvcStart() {
  svcStarting = false;
  if (svcWaitTimer) { clearInterval(svcWaitTimer); svcWaitTimer = null; }
}

function svcFail(msg) {
  endSvcStart();
  svcNoteMsg = msg;
  setNote(msg);
  const btn = $("p-svc");
  btn.disabled = false;
  btn.className = "primary";
  btn.textContent = "启动服务";
  showSvcRetry();
}

function svcWaitTick() {
  const st = lastStatus || {};
  const proc = st.relay && st.relay.backend ? st.relay.backend.proc : null;
  const waiting = svcStarting || !!(proc && proc.starting === true); // 显示条件（与 render 一致）
  if (!waiting) { syncSvcWaitTimer(false); return; }
  const startAt = svcWaitStart(proc, svcStartAt); // 超时也按同源起点算（服务端 startedAt 优先）
  if (startAt && Date.now() - startAt >= SVC_START_TIMEOUT_MS) {
    // 超时文案按态区分（2026-10-08，P5 三态）；同一起点只报一次（服务端仍在途时不重报）
    if (svcWaitFailStart !== startAt) {
      svcWaitFailStart = startAt;
      const relayDown = st.relayError != null;
      if (relayDown) svcFail("启动超时：已等待 120 秒，中继不可达，无法确认服务状态（可尝试「重启中继」）。");
      else if (proc && proc.starting === true) svcFail("启动超时：已等待 120 秒，服务端仍标记「启动中」（稍后可用状态复查）。");
      else svcFail("启动超时：已等待 120 秒，服务仍未就绪。");
    }
    syncSvcWaitTimer(false);
    return;
  }
  renderSvcWaitNote();
}

async function startService() {
  if (svcBusy || svcStarting) return;
  svcBusy = true;
  svcStarting = true;
  svcStartAt = Date.now();
  svcWaitFailStart = 0;
  svcNoteMsg = "";
  svcNoteRelay = false;
  hideSvcRetry();
  const startBtn = $("p-svc");
  startBtn.disabled = true;
  startBtn.textContent = "启动中…";
  renderSvcWaitNote();
  syncSvcWaitTimer(true);
  let failMsg = "";
  try {
    const r = await hana.api.fetch("/comfyui-hana/backend/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.ok !== false) {
      if (j.already && !j.starting) { // 服务确已在运行（非「启动在途」的去重应答）
        endSvcStart();
        svcNoteMsg = "服务已在运行。";
        setNote(svcNoteMsg);
      }
      // 其余（含 already && starting：已有启动在途）：保持等待态，由 poll 观测 reachable 收尾
    } else {
      failMsg = "启动失败：" + ((j && j.error) || `HTTP ${r.status}`);
    }
  } catch (e) {
    failMsg = "启动失败：" + String((e && e.message) || e);
  } finally {
    svcBusy = false;
  }
  if (failMsg) svcFail(failMsg);
  else pollBurst(); // 请求已受理：快速轮询波（0/0.8/1.6/3/5s），尽快捕捉「就绪」翻转
}

async function stopService() {
  if (svcBusy || svcStarting) return;
  // 一点即停（与顶栏原行为一致）："停止服务"是随时可重新拉起的可逆操作，不做二次确认。
  // （二次确认仅在沙箱下替代 window.confirm 的权宜；实测用户预期是点一下即停。）
  setSvcBusy(true, "停止中…");
  let msg = "";
  try {
    const r = await hana.api.fetch("/comfyui-hana/backend/stop", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) msg = "停止失败：" + ((j && j.error) || `HTTP ${r.status}`);
    else if (j && j.already) msg = "服务本来就没在运行";
    else if (j && j.alive) msg = "已发出停止请求，服务仍在响应（可能正在退出，稍后重查）";
    else {
      msg = `已停止服务（进程 ${JSON.stringify((j && j.stopped) || [])}）`;
      sigOpt = { at: Date.now(), title: "已停止服务" }; // 乐观置红：停止已确认（!alive），不等下轮轮询
      applySignal();
    }
  } catch (e) {
    msg = "停止失败：" + String((e && e.message) || e);
  } finally {
    setNote(msg);
    setSvcBusy(false, "停止服务");
  }
}

// ── 释放显存（POST /comfyui-hana/release → 中继反代后端 /free）──────────────
let releasing = false;
async function releaseVram() {
  if (releasing) return;
  releasing = true;
  const btn = $("m-release");
  btn.classList.add("loading");
  btn.textContent = "释放中…";
  let msg = "已请求卸载模型，显存会在数秒内回落";
  try {
    const r = await hana.api.fetch("/comfyui-hana/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (!(r.ok && j && j.ok)) {
      msg = "释放失败：" + ((j && (j.error || (j.backend && j.backend.error))) || `HTTP ${r.status}`);
      btn.textContent = "释放失败";
    } else {
      btn.textContent = "已释放 ✓";
      void poll();
      setTimeout(() => { void metricsTick(); void metricsTick(); }, 900);
    }
  } catch (e) {
    msg = "释放失败：" + String((e && e.message) || e);
    btn.textContent = "释放失败";
  } finally {
    $("m-note").textContent = msg;
    releasing = false;
    setTimeout(() => {
      btn.classList.remove("loading");
      btn.textContent = "释放显存";
    }, 2200);
  }
}

// ── ComfyUI 更新（版本检查 / 一键更新；仅源码安装）────────────────────────
// 机制：中继 GET /_relay/update（git fetch 比对）/ POST（停服务→pull→pip，后台跑）/ status。
let updTimer = null;
let updUntil = 0;
let updStartedAt = null; // 前端记的发起到刻，用于显示已耗时
// 二次确认不能靠 window.confirm：工作区是沙箱 iframe，confirm 会被静默拦掉
// （返回 false，函数一声不响 return）——那样“点了等于没点”。改用按钮自身承载。
let updArmed = false;
let updArmTimer = null;

function fmtVer(v) {
  return v ? `${v.describe || v.commit || "?"}${v.dirty ? "（有改动）" : ""}` : "—";
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function renderUpdateStatus(st) {
  if (!st) return false;
  const phaseText = { idle: "空闲", stopping: "停服务", fetching: "抓取", pulling: "拉取", installing: "装依赖", done: "已完成", failed: "失败" }[st.phase] || st.phase;
  $("u-state").innerHTML = st.running
    ? chip(`进行中 ${updStartedAt ? fmtAgo(Date.now() - updStartedAt) : ""}`.trim(), "warn")
    : (st.phase === "failed" ? chip("失败", "bad") : (st.phase === "done" ? chip("已完成", "ok") : chip(phaseText)));
  // 本地 / 远端 分两行（2026-10-16）：原先一行「本地 → 远端」在窄栏里横向溢出被截。
  if (st.before) $("u-local").textContent = fmtVer(st.before);
  const remoteEl = $("u-remote");
  if (remoteEl) remoteEl.textContent = st.after ? fmtVer(st.after) : "—";
  const steps = (st.steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `：${String(s.detail).split("\n").slice(-1)[0]}` : ""}`);
  // 日志尾给到 30 行：git pull / pip install 的输出更有参考价值
  $("u-log").textContent = [...steps, ...(st.logTail || []).slice(-30)].filter(Boolean).join("\n");
  if (st.lastError) $("u-note").textContent = `更新失败：${st.lastError}`;
  else if (st.phase === "done") $("u-note").textContent = "更新完成。点「启动服务」重新拉起 ComfyUI。";
  if (st.phase === "done" && updStartedAt) { // 本次会话发起的更新已落定：信号灯同步为「无更新」
    updInfo = { behind: 0, dirty: false, upToDate: true, at: Date.now() };
    applySignal();
  }
  return !!st.running;
}

async function updStatusTick() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/update/status", { cache: "no-store" });
    const running = renderUpdateStatus(await r.json());
    if (!running && updTimer && Date.now() > updUntil) { clearInterval(updTimer); updTimer = null; }
  } catch { /* 下一拍再试 */ }
}

function startUpdPolling() {
  if (updTimer) return;
  updUntil = Date.now() + 30 * 60_000; // 上限 30 分钟（pip 可能很久）
  updTimer = setInterval(() => { void updStatusTick(); }, 2000);
  void updStatusTick();
}

async function checkUpdate() {
  const btn = $("u-check");
  btn.disabled = true; btn.textContent = "检查中…";
  try {
    const r = await hana.api.fetch("/comfyui-hana/update?force=1", { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (!d || d.ok === false) { $("u-note").textContent = `检查失败：${(d && d.error) || `HTTP ${r.status}`}`; return; }
    if (d.isGit === false) {
      if (d.local) $("u-local").textContent = fmtVer(d.local);
      $("u-note").textContent = d.note || "该安装不是 Git 仓库，无法代为更新。";
      return;
    }
    $("u-local").textContent = fmtVer(d.local);
    noteUpdInfo(d); // 手动检查结果同步给信号灯
    const remoteEl = $("u-remote");
    if (remoteEl) remoteEl.textContent = d.remote ? fmtVer(d.remote) : "—";
    if (d.local && d.local.dirty) $("u-note").textContent = "本地有未提交改动，git 会拒绝拉取（不擅自 merge/reset）。";
    else if (d.upToDate) $("u-note").textContent = `已是最新（${d.local?.describe || ""}）。`;
    else $("u-note").textContent = `落后 ${d.behind} 个提交：${fmtVer(d.local)} → ${fmtVer(d.remote)}`;
  } catch (e) {
    $("u-note").textContent = `检查失败：${String((e && e.message) || e)}`;
  } finally {
    btn.disabled = false; btn.textContent = "检查更新";
  }
}

async function applyUpdate() {
  const btn = $("u-apply");
  // 二次确认由按钮自身承载（沙箱下 window.confirm 会被静默拦掉）
  if (!updArmed) {
    updArmed = true;
    btn.textContent = "再点一次确认更新";
    btn.classList.add("danger");
    $("u-note").textContent =
      "更新会先停止 ComfyUI 服务，然后 git pull --ff-only + pip install -r requirements.txt。确认请再点一次（3 秒内）。";
    if (updArmTimer) clearTimeout(updArmTimer);
    updArmTimer = setTimeout(() => {
      updArmed = false;
      updArmTimer = null;
      btn.textContent = "更新";
      btn.classList.remove("danger");
      $("u-note").textContent = "";
    }, 3000);
    return;
  }
  updArmed = false;
  if (updArmTimer) { clearTimeout(updArmTimer); updArmTimer = null; }
  btn.classList.remove("danger");
  // 立即给反馈（不再有任何前置分支）
  btn.disabled = true;
  btn.textContent = "更新中…";
  $("u-note").textContent = "已发起更新（先停服务）…";
  updStartedAt = Date.now();
  try {
    const r = await hana.api.fetch("/comfyui-hana/update", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "apply" }),
    });
    const d = await r.json().catch(() => null);
    if (!d || d.accepted !== true) {
      $("u-note").textContent = `发起失败：${(d && (d.reason || d.error)) || `HTTP ${r.status}`}`;
      return;
    }
    startUpdPolling();
    void poll();
  } catch (e) {
    $("u-note").textContent = `发起失败：${String((e && e.message) || e)}`;
  } finally {
    btn.disabled = false; btn.textContent = "更新";
    // 若确实跑起来了，轮询会接管显示；没跑起来就清掉计时
    setTimeout(() => { if (!updTimer) updStartedAt = null; }, 4000);
  }
}

// ── 状态信号灯（标题行旁；互斥优先级：异常 > 有更新 > 正常）──────────────────
// 异常（红点）：中继不可达（relayError）/ 后端不可达 / 中继非 ready（含 boot.phase=error）；有更新（金色 ✦）：
// 更新检查得 behind>0 且非 dirty；正常（绿点）：其余。更新检查自动化：启动静默查
// 一次 + 每 10 分钟一次 + 页面变可见时一次（GET /comfyui-hana/update，带 TTL 缓存——
// 中继侧 UPDATE_CHECK_TTL_MS=60s，监听间隔远大于 TTL，每次静默检查都是真实比对；失败静默不打扰）。
let lastStatus = null; // 最近一次 /comfyui-hana/status 结果（信号灯推导）
let updInfo = null;    // 最近一次更新检查结论 { behind, dirty, upToDate, at }
let sigOpt = null;     // 「乐观覆盖」{ at, title }：停止确认后立即置红，待晚于 at 的真实快照校验替换

function applySignal() {
  const el = $("sig-dot");
  if (!el) return;
  let cls = "", title = "读取中…";
  if (sigOpt) { // 乐观覆盖优先：基于「停止已确认」的操作事实先置红
    cls = "bad";
    title = sigOpt.title;
  } else if (lastStatus) {
    const boot = lastStatus.boot || {};
    const backend = lastStatus.relay && lastStatus.relay.backend ? lastStatus.relay.backend : null;
    const reachable = !!(backend && backend.reachable);
    if (lastStatus.relayError != null) { // 三态①：中继不可达（2026-10-08）
      cls = "bad";
      title = "中继不可达";
    } else if (boot.phase !== "ready" || !reachable) {
      cls = "bad";
      title = boot.phase !== "ready" ? `中继${PHASE_LABEL[boot.phase] || String(boot.phase || "")}` : "服务未跑";
    } else if (updInfo && updInfo.behind > 0 && !updInfo.dirty) {
      cls = "update";
      title = `有更新：落后远端 ${updInfo.behind} 个提交`;
    } else {
      cls = "ok";
      title = "正常";
    }
  }
  el.className = "sig" + (cls ? " " + cls : "");
  el.textContent = cls === "update" ? "✦" : "";
  el.title = "状态信号：" + title;
}

function noteUpdInfo(d) {
  updInfo = { behind: Number(d.behind || 0), dirty: !!(d.local && d.local.dirty), upToDate: !!d.upToDate, at: Date.now() };
  applySignal();
}

async function silentUpdateCheck() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/update", { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (d && d.ok !== false && d.isGit !== false) noteUpdInfo(d);
  } catch { /* 静默：更新检查失败不打扰 */ }
}

// ── 重载工作区（2026-10-12）────────────────────────────────────────
// 面板与整页工作区是两个页面实例：panel 够不到工作区的内层 ComfyUI iframe。
// 通道：POST /comfyui-hana/shell/reload → app 把 { op:"frame.reload" } 塞进壳页桥队列
// → 工作区壳页 shellTick() 轮询（shell/poll）取到并执行（workspace.js shellOp frame.reload
// → requestFrameReload）。与 /comfyui-hana/release 同口径、同凭据（hana.api.fetch）。
// 壳页不在线时如实报错，不硬凑。
let reloadingWs = false;
async function reloadWorkspace() {
  if (reloadingWs) return;
  reloadingWs = true;
  const btn = $("p-reload-ws");
  btn.disabled = true;
  btn.textContent = "重载中…";
  let msg = "已请求重载工作区。";
  try {
    const r = await hana.api.fetch("/comfyui-hana/shell/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (!(r.ok && j && j.ok)) {
      const err = (j && (j.error || j.reason)) || `HTTP ${r.status}`;
      msg = j && j.error === "shell-not-alive" ? "工作区当前未打开，无法重载。" : "重载失败：" + err;
      btn.textContent = "重载失败";
    } else {
      btn.textContent = "已请求 ✓";
    }
  } catch (e) {
    msg = "重载失败：" + String((e && e.message) || e);
    btn.textContent = "重载失败";
  } finally {
    setNote(msg);
    reloadingWs = false;
    setTimeout(() => { btn.disabled = false; btn.textContent = "重载工作区"; }, 1800);
  }
}
$("p-reload-ws").addEventListener("click", () => { void reloadWorkspace(); });

// ── 交互 ──────────────────────────────────────────────────────────────────
async function restartRelay() {
  svcNoteMsg = "";
  svcNoteRelay = false;
  hideSvcRetry();
  setNote("已请求重启中继，等待就绪……");
  try {
    await hana.api.fetch("/comfyui-hana/relay/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch (e) {
    setNote("重启请求失败：" + String((e && e.message) || e));
    return;
  }
  setTimeout(() => { void poll(); }, 800);
}
$("p-retry").addEventListener("click", () => { void restartRelay(); });
$("p-note-retry").addEventListener("click", () => { void restartRelay(); });
$("p-svc").addEventListener("click", () => {
  // 单按钮双职（2026-10-16）：按当前快照决定点下去是「启动」还是「停止」。
  // 依据 lastStatus（最近一次成功快照）而非 DOM 文案，避免文案与真实状态错位。
  const st = lastStatus || {};
  const relayDown = st.relayError != null;
  const backend = st.relay && st.relay.backend ? st.relay.backend : null;
  const reachable = !!(backend && backend.reachable) && !relayDown;
  if (reachable) void stopService();
  else void startService();
});
$("m-release").addEventListener("click", () => { void releaseVram(); });
$("u-check").addEventListener("click", () => { void checkUpdate(); });
$("u-apply").addEventListener("click", () => { void applyUpdate(); });
window.addEventListener("resize", () => { redrawAll(); });

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => { syncTheme(); redrawAll(); }); } catch { /* 忽略 */ }
  // 订阅兜底（2026-10-11）：宿主快照恒空时 subscribe 回调也可能不来，低频重跑判定（含重新拉主题 CSS）。
  // 频率 4s；退出条件：页面卸载（interval 随文档销毁）。只有非一级判定（快照不可用）才轮询，
  // 即一级已经给了结果就不再定期拉 CSS；判定结果不变时不写 DOM、不打日志。
  setInterval(() => {
    if (!lastThemeDecision || lastThemeDecision.tier !== 1) syncTheme({ force: true });
  }, PANEL_THEME_POLL_MS);
  // 三级（系统偏好）状态下，系统明暗切换也要重判
  try {
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => syncTheme());
  } catch { /* 忽略 */ }
  // 自查入口：console 里手动重判并打印依据
  try { window.__comfyPanelThemeRefresh = () => { syncTheme({ force: true }); return window.__comfyPanelTheme; }; } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  setInterval(() => { void poll(); }, 2000);
  void metricsTick();
  setInterval(() => { void metricsTick(); }, 1000);
  void updStatusTick(); // 初始显示当前版本 / 上次更新结果
  void silentUpdateCheck(); // 信号灯：启动静默查一次更新（失败不打扰）
  setInterval(() => { void silentUpdateCheck(); }, 10 * 60_000); // …此后每 10 分钟一次
  // 自愈（2026-10-16）：宿主 park 不可见页面时 Chromium 会节流/暂停定时器，
  // 期间发生的服务状态变化（如 10:47 那次后端短暂不可达→10:49 恢复）就永远不会被后续 poll
  // 捕捉到，于是面板定格在红点 + 「中继 ?」，而 App 本体早已正常。
  // 对策：页面重新可见、窗口重新获得焦点、页面从 bfcache 恢复——三种回到前台的时机都强制补一轮
  // （状态 + 指标 + 更新状态 + 主题）；另加一道「陈旧兜底」：若距上次成功取数超过 STALE_MS 就补一轮，
  // 这样即便某些宿主/浏览器不发 visibilitychange 也能自愈。
  const STALE_MS = 6000;
  // 记录「最近一次成功取数」的时刻（lastStatusOkAt 在 poll() 成功时回写）：
  function revalidate(reason) {
    void poll();
    void metricsTick();
    void updStatusTick();
    syncTheme({ force: true });
    if (reason) { try { console.debug("[comfyui-hana] 面板自愈重拉：", reason); } catch { /* 忽略 */ } }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidate("visibility");
  });
  window.addEventListener("focus", () => { if (Date.now() - lastStatusOkAt > STALE_MS) revalidate("focus-stale"); });
  window.addEventListener("pageshow", (e) => { if (e && e.persisted) revalidate("bfcache"); });
  // 陈旧兜底：定时器被节流时段会被拉长，这里只做「发现陈旧就补」，不做无条件重推。
  setInterval(() => { if (Date.now() - lastStatusOkAt > STALE_MS) revalidate("stale-timer"); }, 2000);
}
void main();
