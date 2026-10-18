// ui/assets/task.js — ComfyUI 任务卡（2026-10-18 重做：两阶段视图）
// 设计要点：
//   ① 跑图阶段（running/pending）= 「过程视图」：进度条 + 一句状态句 + 细节行 + 实时预览
//   ② 出图阶段（completed，且有产物）= 「作品视图」：产物大图 + 动作按钮，过程元素全部退场
//   ③ 失败态 = 状态句标红 + 断点信息 + 可行动提示
//   ④ 撤掉：元信息胶囊行（并入状态句）、节点时间轴段条（与进度条重复）
// 保留：轮询 / 身份解析自愈（cardId）/ 尺寸上报（reportSize）/ 卡内 lightbox
// 主题（2026-10-18 改）：直接用宿主注入的主题变量，不再自判明暗
// 数据：GET /comfyui-hana/task?cardId=<卡实例 id>（轮询）；产物预览经代理路径 + surface 凭据段。
import { hana } from "./sdk.js";

const root = document.getElementById("tk-root");
const lb = document.getElementById("tk-lb");
const lbImg = lb ? lb.querySelector("img") : null;
const CARD_WIDTH = 460;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let session = null;
try { session = new URLSearchParams(location.search).get("appSurfaceSession") || null; } catch { session = null; }

let timer = null;
let tickTimer = null;
let lastData = null;
let lastStage = null;   // "process" | "result" | "bad" —— 阶段切换时重建骨架

// ── 主题（2026-10-18 终稿 v2）──
// 宿主主题变量的注入**不是自动的**：SDK 里 followHostTheme(cssUrl) 只在
// 收到 THEME_CHANGED 推送时才被调用（见 sdk.js 的消息分支）。
// 因此卡片必须主动订阅一次，让宿主推一次主题 → 触发样式表注入；
// 订闻回调本身无需做事（CSS 全用 var()，变量一到位颜色就对了）。
// 教训：之前把 syncTheme/subscribe 全删了，结果变量没注入，文字全落到兵底值（发灰）。

// 把当前主题样式表注入本卡片文档（与 sdk.js 的 applyHostThemeStylesheet 同口径）。
let themeInjected = false;
function injectThemeCss(cssUrl) {
  if (!cssUrl || themeInjected) return;
  themeInjected = true;
  fetch(cssUrl, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((css) => {
      const head = document.head || document.documentElement;
      if (!head) return;
      let el = document.querySelector("style[data-hana-theme-style]");
      if (!el) {
        el = document.createElement("style");
        el.setAttribute("data-hana-theme-style", "");
        head.appendChild(el);
      }
      el.textContent = css;
    })
    .catch(() => { themeInjected = false; /* 交给订阅路径再试 */ });
}

// 自查探针（2026-10-18）：把主题判定依据写进 DOM，便于从外部读回。
// 仅诊断用，不参与渲染；移除时删本函数 + main() 里的调用。
function writeThemeProbe() {
  try {
    let snap = null;
    try { snap = hana.theme?.getSnapshot?.() || null; } catch { snap = null; }
    let param = "";
    try { param = new URLSearchParams(location.search).get("hana-css") || ""; } catch { /* 忽略 */ }
    const dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const old = document.getElementById("tk-probe");
    if (old) old.remove();
    const st = document.createElement("div");
    st.id = "tk-probe";
    st.style.display = "none";
    st.textContent = JSON.stringify({
      matchDark: dark,
      snapAppearance: (snap && snap.appearance) || null,
      snapTheme: (snap && snap.theme) || null,
      snapCss: (snap && snap.cssUrl) || null,
      urlCss: param || null,
      hasStyleTag: !!document.querySelector("style[data-hana-theme-style]"),
    });
    document.body.appendChild(st);
  } catch { /* 忽略 */ }
}

function ensureHostTheme() {
  // ① 订阅：宿主推 THEME_CHANGED 时带 cssUrl；subscribe 会同步回调一次当前快照。
  // 回调内任何抛错都会打断 main()（曾导致卡片卡在“正在读取…”），故双层 try。
  try {
    hana.theme?.subscribe?.((snap) => {
      try { if (snap && snap.cssUrl) injectThemeCss(snap.cssUrl); } catch { /* 不上抛 */ }
    });
  } catch { /* 订阅不可用 */ }

  // ② 初始快照里就有 cssUrl → 立即注入（不等推送）
  // ② 初始快照里就有 cssUrl → 立即注入（不等推送）
  try {
    const snap = hana.theme?.getSnapshot?.();
    if (snap && snap.cssUrl) injectThemeCss(snap.cssUrl);
  } catch { /* 忽略 */ }

  // ③ 再兑底：URL 参数 hana-css（快照拿不到时的最后一条路）
  try {
    const p = new URLSearchParams(location.search).get("hana-css");
    if (p) injectThemeCss(p);
  } catch { /* 忽略 */ }
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

const isTerminal = (s) => ["completed", "error", "interrupted", "canceled", "timeout"].includes(s);
const isActive = (s) => s === "running" || s === "pending";
const isFailed = (s) => s === "error" || s === "interrupted" || s === "canceled" || s === "timeout";

function thumbUrl(proxyPrefix, viewPath) {
  if (!proxyPrefix || !viewPath) return null;
  if (session) return `${proxyPrefix}_surface/${encodeURIComponent(session)}/${viewPath}`;
  return `${proxyPrefix}${viewPath}`;
}

// ── 状态句（整张卡的主角）────────────────────────────────────────────────
// 把原来分散在「胶囊行 + 时间轴说明行」的信息压成两句：
//   主句：现在在干什么（动词短语）
//   细节：可量化事实（第 N/M 步 · 节点 x/y · 队列前 N）
function stateLine(t) {
  const st = t.state;
  const p = t.progress;
  const total = totalNodes(t);
  const done = Math.trunc(num(t.nodesDone) || 0);

  if (st === "completed") return { main: "已完成", detail: "" };
  if (isFailed(st)) return { main: t.stateText || "任务失败", detail: "" };

  if (st === "pending") {
    const q = t.queuePosition;
    return { main: "排队中", detail: q != null ? `队列第 ${q} 位` : "" };
  }

  // running：优先「采样中 · 第 N/M 步」
  const step = p && num(p.value) != null && num(p.max) != null ? `${p.value}/${p.max}` : null;
  const nodeName = t.currentNode != null ? nodeLabel(t.currentNode, t) : "";
  let main = "运行中";
  if (step) main = `采样中 · 第 ${step} 步`;
  else if (nodeName) main = `${nodeName}`;

  const bits = [];
  if (step && nodeName) bits.push(nodeName);
  if (total) bits.push(`节点 ${done}/${total}`);
  else if (done) bits.push(`已跑 ${done} 个节点`);
  return { main, detail: bits.join(" · ") };
}

// ── 节点名（拿不到就如实显示编号，不编）──
function nodeLabel(id, t) {
  if (id == null || id === "") return "";
  const key = String(id);
  const map = (t && (t.nodeNames || t.nodeTitles || t.nodeLabels)) || null;
  if (map && typeof map === "object" && typeof map[key] === "string" && map[key].trim()) {
    return map[key].trim();
  }
  return `节点 #${key}`;
}

// 总节点数：显式字段 → label「（N 节点）」→ null
function totalNodes(t) {
  const direct = num(t.nodeCount) ?? num(t.totalNodes) ?? num(t.nodesTotal);
  if (direct && direct > 0) return Math.trunc(direct);
  const m = /(\d+)\s*节点/.exec(String(t.label || ""));
  if (m) { const n = Number(m[1]); if (n > 0) return n; }
  return null;
}

// ── 失败态提示 ──
function errorText(t) {
  const e = t.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  return `${e.type || ""} ${e.message || ""}`.trim() || JSON.stringify(e);
}
function errorHint(t) {
  const msg = errorText(t);
  if (/allocat|out of memory|\boom\b|cuda.*memory|显存|内存不足/i.test(msg)) {
    return "疑似显存不足：降低分辨率或批量，或先释放显存（关掉其它占 GPU 的程序、清空队列）后重跑。";
  }
  if (/interrupt|cancel|取消|中断/i.test(msg)) return "任务被中断或取消；需继续请重新提交。";
  return "可到 ComfyUI 控制台看完整堆栈，修正后重新提交。";
}

// ── DOM 骨架：按阶段建不同的树 ───────────────────────────────────────────
const el = {};
function ensureProcessShell() {
  if (el.stage === "process" && el.title && el.title.isConnected) return;
  el.stage = "process";
  root.innerHTML = `
    <div class="tk-top">
      <span class="tk-dot"></span>
      <span class="tk-title"></span>
      <span class="tk-time"></span>
    </div>
    <div class="tk-bar"><i></i></div>
    <div class="tk-state"></div>
    <div class="tk-detail"></div>
    <div class="tk-pv">
      <div class="tk-pv-wrap"><img class="tk-pv-img" alt="实时预览"></div>
    </div>
    <div class="tk-err"></div>
    <div class="tk-hint"></div>`;
  el.dot = root.querySelector(".tk-dot");
  el.title = root.querySelector(".tk-title");
  el.time = root.querySelector(".tk-time");
  el.bar = root.querySelector(".tk-bar");
  el.barFill = el.bar.querySelector("i");
  el.state = root.querySelector(".tk-state");
  el.detail = root.querySelector(".tk-detail");
  el.pv = root.querySelector(".tk-pv");
  el.pvWrap = root.querySelector(".tk-pv-wrap");
  el.pvImg = root.querySelector(".tk-pv-img");
  el.err = root.querySelector(".tk-err");
  el.hint = root.querySelector(".tk-hint");
  el.pvWrap.addEventListener("click", () => { const s = el.pvImg.getAttribute("src"); if (s) openLightbox(s); });
}

function ensureResultShell() {
  if (el.stage === "result" && el.title && el.title.isConnected) return;
  el.stage = "result";
  root.innerHTML = `
    <div class="tk-top">
      <span class="tk-dot"></span>
      <span class="tk-title"></span>
      <span class="tk-time"></span>
    </div>
    <div class="tk-out"></div>
    <div class="tk-acts">
      <button type="button" class="tk-btn pri" data-act="dir">打开目录</button>
    </div>`;
  el.dot = root.querySelector(".tk-dot");
  el.title = root.querySelector(".tk-title");
  el.time = root.querySelector(".tk-time");
  el.out = root.querySelector(".tk-out");
  el.acts = root.querySelector(".tk-acts");
  thumbEls = []; lastOutKey = "";
}

function renderNote(text) {
  el.stage = null; el.title = null;
  root.innerHTML = `
    <div class="tk-top">
      <span class="tk-dot"></span>
      <span class="tk-title">ComfyUI 任务</span>
      <span class="tk-time"></span>
    </div>
    <div class="tk-note">${esc(text)}</div>`;
  reportSize(true);
}

// ── 进度条 ──
function renderBar(t) {
  const p = t.progress;
  const total = totalNodes(t);
  const done = Math.trunc(num(t.nodesDone) || 0);
  let pct = 0;
  let indet = false;
  if (t.state === "completed") pct = 100;
  else if (p && num(p.value) != null && num(p.max) != null && p.max > 0) pct = clamp((p.value / p.max) * 100, 0, 100);
  else if (isActive(t.state) && total && done) pct = clamp((done / total) * 100, 0, 100);
  else if (isActive(t.state)) indet = true;
  el.bar.className = `tk-bar${indet ? " indet" : ""}`;
  el.barFill.style.width = `${pct}%`;
}

// ── 实时预览（最新帧 + 胶片点选回放）──
// ── 实时预览：只显示最新降噪帧（2026-10-18 按用户要求去掉采样帧回放小图条）──
// 小图条只用于「出图后的同批成品图」，不再承担采样过程回放。
const frameSrc = (f) => (/^data:/.test(f) ? f : `data:image/jpeg;base64,${f}`);

function renderPreview(t) {
  const raw = Array.isArray(t.previewFrames) ? t.previewFrames.filter((f) => typeof f === "string" && f) : [];
  const show = raw.length > 0;
  el.pv.hidden = !show;
  if (!show) return;
  const src = frameSrc(raw[raw.length - 1]);   // 永远取最新一帧
  if (el.pvImg.getAttribute("src") !== src) el.pvImg.src = src;
}

// ── 产物：一张大图 + 下方同批小图条（2026-10-18 定稿）──
// 交互：点小图 -> 大图切到那张；点大图 -> 开 lightbox 放大到满屏。
// 单张时不出小图条；一张不丢，小图条在卡宽内自动缩尺寸（不滚、不裁）。
const OUT_GAP = 6;
let thumbEls = [];
let lastOutKey = "";
let outUrls = [];      // 当前一批产物的 url 列表
let outIndex = 0;      // 大图当前显示第几张

function applyOutLayout(count) {
  el.out.classList.toggle("single", count <= 1);
  // 小图尺寸随张数递减：<=4 张 64px，5-8 张 52px，9+ 张 42px
  const sz = count <= 4 ? 64 : count <= 8 ? 52 : 42;
  el.out.style.setProperty("--thumb-size", `${sz}px`);
}

function selectOutput(i) {
  if (!outUrls.length) return;
  const idx = clamp(i, 0, outUrls.length - 1);
  outIndex = idx;
  if (el.bigImg) el.bigImg.src = outUrls[idx];
  thumbEls.forEach((b, j) => b.classList.toggle("on", j === idx));
}

function renderOutputs(outputs, proxyPrefix) {
  const urls = outputs.map((o) => thumbUrl(proxyPrefix, o.viewPath)).filter(Boolean);
  const labels = outputs.map((o) => o.filename || "");
  const key = urls.join("|");
  if (key === lastOutKey) return 0;   // 无变化不重建

  lastOutKey = key;
  outUrls = urls;
  outIndex = 0;
  el.out.innerHTML = "";
  applyOutLayout(urls.length);
  if (!urls.length) { thumbEls = []; return 0; }

  // 大图
  const big = document.createElement("div");
  big.className = "tk-big";
  const bigImg = document.createElement("img");
  bigImg.alt = labels[0] || "产物";
  bigImg.addEventListener("load", () => reportSize(true));
  bigImg.src = urls[0];
  big.appendChild(bigImg);
  // 点大图：开 lightbox 看更大（取当前选中的那张）
  big.addEventListener("click", () => openLightbox(outUrls[outIndex]));
  el.bigImg = bigImg;
  el.out.appendChild(big);

  // 小图条（单张时不出）
  if (urls.length > 1) {
    const strip = document.createElement("div");
    strip.className = "tk-strip";
    thumbEls = urls.map((u, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tk-mini${i === 0 ? " on" : ""}`;
      b.title = labels[i] || `第 ${i + 1} 张`;
      const im = document.createElement("img");
      im.loading = "lazy";
      im.alt = labels[i] || `第 ${i + 1} 张`;
      im.src = u;
      b.appendChild(im);
      b.addEventListener("click", () => selectOutput(i));
      strip.appendChild(b);
      return b;
    });
    el.out.appendChild(strip);
  } else {
    thumbEls = [];
  }
  reportSize(true);
  return 0;   // 全部展示，永不截断
}

// ── 卡内 lightbox ──
function openLightbox(url) {
  if (!lb || !lbImg) return;
  lbImg.src = url;
  lb.hidden = false;
}
function closeLightbox() { if (lb) { lb.hidden = true; if (lbImg) lbImg.removeAttribute("src"); } }
if (lb) lb.addEventListener("click", closeLightbox);
try { window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); }); } catch { /* 忽略 */ }

// ── 主渲染：按阶段分派 ──
function render(data) {
  lastData = data;
  if (!data || !data.ok) { renderNote(`读取失败：${data && data.error ? data.error : "未知错误"}`); return; }
  if (!data.found) {
    renderNote(`未找到任务记录：${identity ? identity.value : "?"}\n（可能已超出本进程记忆；提交后短时间内可用，或改用 comfyui action=query/result）`);
    return;
  }
  const t = data.task;
  const outputs = Array.isArray(t.outputs) ? t.outputs : [];
  const failed = isFailed(t.state);
  // 阶段判定：完成且有产物 → 作品视图；其余（含失败）→ 过程视图（失败在过程视图里标红）
  const stage = (t.state === "completed" && outputs.length > 0) ? "result" : "process";

  if (stage !== el.stage) {
    if (stage === "result") ensureResultShell(); else ensureProcessShell();
  }

  if (stage === "result") {
    el.dot.className = "tk-dot ok";
    el.title.textContent = t.label || "ComfyUI 任务";
    el.title.title = t.label || "";
    el.time.textContent = fmtDur(t.elapsedMs);
    const more = renderOutputs(outputs, data.proxyPrefix);
    // 2026-10-18：不再截断，全部展示；more 恒为 0，保留分支以便未来需要时启用。
    if (more > 0) {
      if (!el.more) {
        el.more = document.createElement("div");
        el.more.className = "tk-detail";
        el.more.style.marginTop = "6px";
        el.out.parentNode.insertBefore(el.more, el.acts);
      }
      el.more.textContent = `另有 ${more} 张（用 comfyui action=result 取完整清单）`;
    } else if (el.more) { el.more.remove(); el.more = null; }
    bindActions(outputs, data.proxyPrefix);
  } else {
    el.dot.className = `tk-dot ${failed ? "bad" : "run"}`;
    el.title.textContent = t.label || "ComfyUI 任务";
    el.title.title = t.label || "";
    const elapsedVal = isActive(t.state) && t.submittedAt ? Date.now() - t.submittedAt : t.elapsedMs;
    el.time.textContent = fmtDur(elapsedVal);

    renderBar(t);
    const sl = stateLine(t);
    el.state.innerHTML = failed
      ? `<b style="color:var(--bad)">${esc(sl.main)}</b>`
      : `<b>${esc(sl.main)}</b>`;
    el.detail.textContent = sl.detail || "";

    // 完成后无产物：预览仍可看（此时预览就是唯一结果）
    renderPreview(t);

    const errText = failed ? errorText(t) : "";
    el.err.textContent = errText;
    el.err.hidden = !errText;
    el.hint.textContent = errText ? errorHint(t) : "";
    el.hint.hidden = !errText;
  }

  const terminal = isTerminal(t.state);
  if (terminal && !render._terminalReported) {
    render._terminalReported = true;
    [0, 1000, 2500].forEach((d) => setTimeout(() => reportSize(true), d));
  }
  reportSize();
}

// 动作绑定（作品视图）
// 「全部下载」：<a download> 逐个触发，不依赖宿主权限
// 「打开目录」：卡片自己打不开本地目录（宿主 external.open 只放行 http(s)），
//   改为请 App 后端代开——后端持有 app/runtime.execute，能 spawn explorer.exe。
function bindActions(outputs, proxyPrefix) {
  if (!el.acts || el.acts._bound) return;
  el.acts._bound = true;
  el.acts.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.getAttribute("data-act") === "dir") void openDir(btn);
  });
}

// 打开产物目录：走 App 自有路由（后端 spawn explorer.exe）。
async function openDir(btn) {
  const prev = btn.textContent;
  btn.textContent = "打开中…";
  btn.disabled = true;
  try {
    const r = await hana.api.fetch("/comfyui-hana/open-output-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) {
      throw new Error((j && j.error) || `HTTP ${r.status}`);
    }
    btn.textContent = prev;
  } catch (err) {
    // 失败：把目录路径复制到剪贴板作降级（仍不能开窗时至少拿得到路径）
    const dir = lastData && typeof lastData.outputDir === "string" ? lastData.outputDir : "";
    try { if (dir) await hana.clipboard.writeText(dir); } catch { /* 忽略 */ }
    flashBtn(btn, dir ? "已复制路径" : "打开失败", dir || String((err && err.message) || err));
    try { console.warn("[task] 打开目录失败：", err, dir); } catch { /* 忽略 */ }
  } finally {
    btn.disabled = false;
  }
}

function flashBtn(btn, text, title) {
  const prev = btn.getAttribute("data-label") || btn.textContent;
  btn.setAttribute("data-label", prev);
  btn.textContent = text;
  if (title) btn.title = title;
  setTimeout(() => { btn.textContent = prev; }, 1800);
}

// ── 尺寸上报（宽度上报 + 高度随内容；启动期自愈收敛）──
// 2026-10-18 修正：body 加了 overflow:hidden 之后，body.scrollHeight 被压成
// 等于当前可视高度，内容变高它也不涨 → 上报高度永远偏小，卡片底部被裁。
// 改为量 #tk-root 的边界盒（不受 body 裁剪影响）。
var lastReportedH = 0;
function contentHeight() {
  let h = 0;
  try {
    const rootEl = document.getElementById('tk-root');
    if (rootEl) {
      const r = rootEl.getBoundingClientRect();
      h = Math.ceil(r.height);
    }
  } catch { /* 忽略 */ }
  if (!h) {
    try {
      const b = document.body;
      if (b) h = Math.ceil(Math.max(b.scrollHeight, b.offsetHeight));
    } catch { /* 忽略 */ }
  }
  // 加上 body 的上下 padding（11 + 13），让卡片恰好包住内容
  try {
    const cs = getComputedStyle(document.body);
    h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  } catch { /* 忽略 */ }
  return h;
}
function reportSize(force) {
  try {
    const h = contentHeight();
    if (!h || h < 40) return;
    if (!force && h === lastReportedH) return;
    lastReportedH = h;
    // 2026-10-18：只上报高度，不报宽度。
    // 原来报 width:460 等于替宿主定卡宽，用户看到「卡片为什么这么宽」。
    // 宽度交给宿主（preferredWidthPx / 布局），我们只管把高度贴到内容。
    try { hana.ui?.resize?.({ height: h }); } catch { /* 老宿主无此路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}
(function bootSettle() {
  if (typeof setInterval !== "function") return;
  const adopted = () => { try { return Math.abs(window.innerWidth - CARD_WIDTH) <= 2; } catch { return true; } };
  reportSize(true);
  try { window.addEventListener("resize", () => { if (!adopted()) reportSize(true); }); } catch { /* 忽略 */ }
  let n = 0;
  const t2 = setInterval(() => {
    n += 1;
    if (adopted()) { clearInterval(t2); return; }
    reportSize(true);
    if (n >= 6) clearInterval(t2);
  }, 1500);
})();

// ── 身份与轮询（自愈式）──
let identity = null;
let resolving = null;
let lastReshowAt = 0;

// 2026-10-18：原来这里是 40 × 150ms ≈ 6 秒的阻塞等待，
// 拿不到 cardInstanceId 时首屏白等 6 秒（用户感知为「渲染极慢」）。
// 改为：短快轮（最多 400ms），拿不到就走 latest=1 先出画面，
// 同时 onContextChanged 订阅仍在后台等，一旦拿到就切精确匹配。
async function resolveIdentity() {
  let q = null;
  try { q = new URLSearchParams(location.search); } catch { q = null; }
  const qid = q ? (q.get("id") || q.get("pid") || q.get("taskId") || "").trim() : "";
  if (qid) return { kind: "id", value: qid };
  for (let i = 0; i < 4; i += 1) {
    if (identity) return identity;
    let ctx = null;
    try { ctx = hana.surface?.getContext?.() || null; } catch { ctx = null; }
    if (ctx && typeof ctx.cardInstanceId === "string" && ctx.cardInstanceId.trim()) {
      return { kind: "cardId", value: ctx.cardInstanceId.trim() };
    }
    if (i < 3) await sleep(100);
  }
  return null;
}

function retryIdentity() {
  if (identity) return Promise.resolve(identity);
  if (!resolving) {
    resolving = resolveIdentity().then(
      (v) => { resolving = null; if (v) identity = v; return v; },
      () => { resolving = null; return null; },
    );
  }
  return resolving;
}

function subscribeContext() {
  try {
    hana.surface?.onContextChanged?.((ctx) => {
      const id = ctx && typeof ctx.cardInstanceId === "string" ? ctx.cardInstanceId.trim() : "";
      if (!id || identity) return;
      identity = { kind: "cardId", value: id };
      void poll();
    });
  } catch { /* 订阅不可用：交给自愈轮询 */ }
}

function onReshow() {
  try {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (identity) return;
    const now = Date.now();
    if (now - lastReshowAt < 400) return;
    lastReshowAt = now;
    setTimeout(() => { void retryIdentity(); }, 0);
  } catch { /* 忽略 */ }
}
try {
  document.addEventListener("visibilitychange", onReshow);
  window.addEventListener("pageshow", onReshow);
} catch { /* 忽略 */ }

const FETCH_TIMEOUT_MS = 15000;
function fetchWithTimeout(url, ms) {
  let to = null;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(Object.assign(new Error("timeout"), { __timeout: true })), ms);
  });
  const req = hana.api.fetch(url, { cache: "no-store" });
  req.catch(() => {});
  return Promise.race([req, timeout]).finally(() => { if (to) clearTimeout(to); });
}

let pollInFlight = false;
let ctxMisses = 0;   // 连续拿不到上下文的轮数（超过阈值后改走 latest 兑底）
async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    if (!identity) identity = await retryIdentity();
    // 兑底（2026-10-18）：拿不到 surface 上下文时不死等。
    // 原因：宿主没注入 cardInstanceId（流内卡创建得过早/会话切换）→ getContext() 恒 null，
    // 原逻辑会永久停在「正在等待卡片上下文…」。改为两轮后直接用 latest=1，
    // 先显示最近一条任务（总比空白好），同时继续后台等上下文。
    ctxMisses += 1;
    let qs;
    if (identity) {
      qs = identity.kind === "cardId"
        ? `cardId=${encodeURIComponent(identity.value)}`
        : `id=${encodeURIComponent(identity.value)}`;
      ctxMisses = 0;
    } else if (ctxMisses >= 2) {
      qs = "latest=1";
    } else {
      renderNote("正在等待卡片上下文…");
      schedule(null);
      return;
    }
    try {
      const r = await fetchWithTimeout(`/comfyui-hana/task?${qs}`, FETCH_TIMEOUT_MS);
      const data = await r.json();
      render(data);
      schedule(data);
    } catch (e) {
      renderNote(e && e.__timeout ? "与宿主通讯超时，正在重试…" : `读取失败：${(e && e.message) || e}`);
      schedule(null);
    }
  } finally {
    pollInFlight = false;
  }
}

function schedule(data) {
  const done = data && data.ok && data.found && isTerminal(data.task.state);
  const next = done ? 5000 : 1500;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void poll(); }, next);
}

// 2026-10-18：兜底——任何未捕获异常都显示在卡上，不再白屏。
// 背景：reload 后旧卡引用的 JS 失效、或某处静默抛错时，用户只看到一块空白。
try {
  window.addEventListener("error", (e) => {
    try { renderNote(`卡片脚本出错：${(e && e.message) || "未知"}\n（可刷新页面重试）`); } catch { /* 忽略 */ }
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    try { renderNote(`卡片异步出错：${(r && r.message) || r || "未知"}\n（可刷新页面重试）`); } catch { /* 忽略 */ }
  });
} catch { /* 忽略 */ }

async function main() {
  // 首屏立刻给骨架，不等身份/网络——避免一片空白。
  try { renderNote("正在读取任务状态…"); } catch { /* 忽略 */ }
  ensureHostTheme();   // 主动订阅一次，逼迫宿主注入主题变量（否则 var() 全落兵底值）
  writeThemeProbe();   // 自查探针：把判定依据写进 DOM
  try { await hana.ready(); } catch { /* 忽略 */ }
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(() => reportSize()).observe(root); } catch { /* 忽略 */ }
  }
  tickTimer = setInterval(() => {
    try {
      const t = lastData?.task;
      if (!el.time || !el.time.isConnected || !t) return;
      if (isActive(t.state) && t.submittedAt) el.time.textContent = fmtDur(Date.now() - t.submittedAt);
    } catch { /* 忽略 */ }
  }, 1000);
  subscribeContext();
  void poll();
}
void main();
