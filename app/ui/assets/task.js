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
// 尺寸基准（2026-10-21）：卡宽 460 与 index.js 的 preferredWidthPx 一致；
// body 左右 padding 各 13（见 task.html 的 body { padding: 11px 13px 13px }）。
const CONTENT_W = CARD_WIDTH - 26;                  // 内容区 434
const BIG_MAX = Math.round(CARD_WIDTH * 1.5);      // 大图最大边长 690（用户口径：卡宽×1.5）
const THUMB_SIZE = Math.round(BIG_MAX / 4);        // 小图 = 大图 1/4 ≈ 173

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
// 尺寸基准尽早写入（预览可能比产物先出现，不能依赖 applyOutLayout）
// 卡宽 460 → 大图最大边长 690（卡宽×1.5），小图 = 690/4 ≈ 173
try {
  document.documentElement.style.setProperty("--big-max", `${BIG_MAX}px`);
  document.documentElement.style.setProperty("--thumb-size", `${THUMB_SIZE}px`);
} catch { /* 忽略 */ }
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

// 尺寸基准见文件顶部（CARD_WIDTH / CONTENT_W / BIG_MAX / THUMB_SIZE）

function applyOutLayout(count) {
  el.out.classList.toggle("single", count <= 1);
  // 大图高度预算：卡宽×1.5
  el.out.style.setProperty("--big-max", `${BIG_MAX}px`);
  // 小图 = 大图尺寸的 1/4（用户口径）。
  // 大图的「参考尺寸」取它的最大边长（竖图取高、横图取宽，统一按预算算），
  // 这样与图本身长短无关，小图尺寸稳定。
  el.out.style.setProperty("--thumb-size", `${THUMB_SIZE}px`);
  // 一行能放几张：内容区宽 / (小图宽 + gap 5) → 434/(173+5) = 2
  const perRow = Math.max(1, Math.floor((CONTENT_W + 5) / (THUMB_SIZE + 5)));
  el.out.classList.toggle("scrollable", count > perRow);
  // 布局基准变了，渐隐开关要跟着重算（尺寸写进 CSS 变量后不重排就不会有 scrollWidth）
  if (stripEl) requestAnimationFrame(() => syncStripFades());
}

// ── 小图条：溢出提示与滚轮横滚（2026-10-21）───────────────────────────
// 用户口径：小图必要时得有滚动条，要不怎么看全。滚动条只是「存在感」还不够，
// 所以另外做两件事：① 两侧渐隐（哪边还有内容哪边才渐隐）；② 垂直滚轮横滚。
// 渐隐用 CSS mask 挂在 .tk-strip 上，切换 can-l / can-r 两个 class，
// 判定依据是真实 scrollLeft / scrollWidth，不猜数学。
let stripEl = null;
let stripRO = null;
const STRIP_EPS = 1;   // 亚像素容差：缩放 125% 时 scrollLeft 会是小数

// 返回当前条的三态快照（同时把 class 刷到 DOM），便于外部/自测读回。
function syncStripFades() {
  const s = stripEl;
  if (!s || !s.isConnected) return null;
  const overflow = Math.max(0, s.scrollWidth - s.clientWidth);
  const x = s.scrollLeft;
  const canR = overflow > STRIP_EPS && x < overflow - STRIP_EPS;   // 右边还有
  const canL = overflow > STRIP_EPS && x > STRIP_EPS;              // 左边还有
  s.classList.toggle("can-r", canR);
  s.classList.toggle("can-l", canL);
  return { overflow, x, canL, canR, cls: s.className };
}

// 滚轮 → 横向滚动。
// 口径（2026-10-21 用户明确）：**鼠标在小图条上时，滚轮只归小图条**。
// 滚到边界就自然停住，不要把事件漏给聊天页——否则想横着看完最后一张，
// 手一多滚一格密码就变成页面上下跳，反而更难看全。
// 因此除不溢出、ctrl 缩放、纯横向滚轮三种情况外，一律 preventDefault。
function onStripWheel(e) {
  const s = stripEl;
  if (!s || !s.isConnected) return;
  const overflow = Math.max(0, s.scrollWidth - s.clientWidth);
  if (overflow <= STRIP_EPS) return;          // 不溢出：不接管，让页面正常滚
  if (e.ctrlKey) return;                      // ctrl+滚轮 = 缩放手势，不接管
  const raw = e.deltaY;
  if (!raw) return;                           // 纯横向滚轮（deltaX）交给浏览器
  // deltaMode 归一：Firefox 默认按行计（1 行 = 3），换算成 px 才不会一格只挪 3px
  const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? s.clientWidth : 1);
  const dy = raw * unit;
  // 只要鼠标在条上就吃掉这次滚轮（含已到边界的情况）——到边界就是不动，不外泄。
  e.preventDefault();
  const x = s.scrollLeft;
  const next = clamp(x + dy, 0, overflow);
  if (next !== x) s.scrollLeft = next;
  syncStripFades();
}

// 小图条唯一入口：挂监听 + 初次同步。
function attachStrip(strip) {
  stripEl = strip;
  strip.addEventListener("scroll", syncStripFades, { passive: true });
  // passive:false 才能 preventDefault
  strip.addEventListener("wheel", onStripWheel, { passive: false });
  // 小图是 lazy 加载，图片陆续到位会改变 scrollWidth；load 不冒泡，用捕获里接
  strip.addEventListener("load", syncStripFades, true);
  // 卡宽变化（宿主改宽度 / 降级到全宽）也要重算
  try {
    if (typeof ResizeObserver === "function") {
      if (stripRO) stripRO.disconnect();
      stripRO = new ResizeObserver(() => syncStripFades());
      stripRO.observe(strip);
    }
  } catch { /* 老宿主 */ }
  syncStripFades();
  requestAnimationFrame(() => syncStripFades());   // 图片/字体到达后 clientWidth 可能变
}

function selectOutput(i) {
  if (!outUrls.length) return;
  const idx = clamp(i, 0, outUrls.length - 1);
  outIndex = idx;
  if (el.bigImg) el.bigImg.src = outUrls[idx];
  thumbEls.forEach((b, j) => b.classList.toggle("on", j === idx));
  // 选中项必须可见（键盘 Tab / 程序化选中都走这里）
  const b = thumbEls[idx];
  if (b && b.scrollIntoView) {
    try { b.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* 老宿主 */ }
    syncStripFades();
  }
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
  stripEl = null;
  if (stripRO) { stripRO.disconnect(); stripRO = null; }   // 旧条的观察器跟着旧 DOM 一起停掉
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
      // 键盘 Tab 到某张时把它带进视野（inline:nearest = 只在需要时横滚，不做纵向跳动）
      b.addEventListener("focus", () => {
        try { b.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* 老宿主 */ }
        syncStripFades();
      });
      strip.appendChild(b);
      return b;
    });
    el.out.appendChild(strip);
    attachStrip(strip);
  } else {
    thumbEls = [];
    stripEl = null;
  }
  reportSize(true);
  return 0;   // 全部展示，永不截断
}

// ── 卡内 lightbox ──
// ── 卡内 lightbox：看原图 + 滚轮缩放 + 拖动平移（2026-10-21）──
// 交互：
//   滚轮        → 以鼠标位置为锚点缩放（fit*0.5 ~ 8x）
//   按住拖动    → 平移
//   双击        → 在「适应屏幕」与「100% 原尺寸」两态间切换
//   点空白/Esc  → 关闭（点在图上不关）
//
// 2026-10-21 修正要点：
//   ① 锚点公式。transform-origin:0 0 + translate(tx,ty)，图左上角在视口坐标就是 (tx,ty)。
//      图内坐标 ix 在屏幕上的位置 = tx + ix*scale。要让缩放到 s2 后同一个 ix 仍落在 cx：
//          tx' + ix*s2 = cx，且 ix = (cx - tx)/s1
//        ⇒ tx' = cx - (cx - tx) * (s2/s1)
//      所以原公式方向对，但必须用「state 里的 tx/ty」算，不能用 getBoundingClientRect()
//      —— rect 是含现有 transform 的结果，且 rect.x 在 flex 居中/圆角/缩放叠加下不等于 tx，
//      实测锚点漂移 150px（图像空间）。现在改成纯 state 推导，与 DOM 布局解耦。
//   ② dblclick。原实现 lbZoomAt(); 后又无条件 lbFit()，把刚设的 100% 立即覆盖回 fit（实测双击毫无反应）。
//      改成明确的两态：当前≈fit → 1；否则 → fit。目标与当前相同时不做事。
//   ③ 拖动。pointerdown 判定 e.target !== lbImg 会因图片上没有任何可命中区域之外的边缘而失败；
//      更稳的写法是挂在 lb 上、用 e.target 只排除 hint/badge 等 UI，且允许在蒙版上拖也行——
//      但保留「只在图上拖」的语义，同时把监听器改到 window 上做 move/up，防止指针移出图片后丢失。
//   ④ lostpointercapture / pointercancel 都要复位 dragging，否则会卡住。
//   ⑤ 关闭要清 transform / src / class / state，并重置 failed 态。
//   ⑥ 加载失败要有可见提示，不能留一张破图 + 100% 徽标在那误导。
const lbState = { scale: 1, tx: 0, ty: 0, fit: 1, natW: 0, natH: 0, dragging: false, sx: 0, sy: 0, pointerId: null };
const lbBadge = lb ? lb.querySelector(".zoom-badge") : null;
const lbHint = lb ? lb.querySelector(".hint") : null;
const LB_HINT = lbHint ? lbHint.textContent : "";
const LB_MIN = 0.02, LB_MAX = 8;   // 绝对 scale 上下限（fit 可能很小，下限按 fit 再收紧）

function lbApply() {
  if (!lbImg) return;
  lbImg.style.transform = `translate(${lbState.tx}px, ${lbState.ty}px) scale(${lbState.scale})`;
  if (lbBadge) {
    // 徽标口径：相对「原尺寸」的真实倍率。100% = 1:1 原图，一眼能看出是否在看原图。
    lbBadge.textContent = `${Math.round(lbState.scale * 100)}%`;
  }
}

// 以视口坐标 (cx, cy) 为锚点缩放到 nextScale，保持鼠标下的图像点不动。
function lbZoomAt(nextScale, cx, cy) {
  if (!lbImg || !lbState.natW || !lbState.natH) return;
  const lo = Math.min(LB_MIN, lbState.fit);      // 允许缩到 fit 以下但不超过它
  const s2 = clamp(nextScale, lo, LB_MAX);
  const s1 = lbState.scale;
  if (!(s1 > 0) || Math.abs(s2 - s1) < 1e-9) return;
  const k = s2 / s1;
  // 推导见上方注释①：tx' = cx - (cx - tx) * k
  lbState.tx = cx - (cx - lbState.tx) * k;
  lbState.ty = cy - (cy - lbState.ty) * k;
  lbState.scale = s2;
  lbApply();
  lb.classList.add("show-zoom");
}

// 按视口算适配缩放并居中（小图不放大，保持 1:1）
function lbFit() {
  if (!lbImg) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const pad = 28;
  const nw = lbState.natW || lbImg.naturalWidth || 1;
  const nh = lbState.natH || lbImg.naturalHeight || 1;
  const fitScale = Math.min(1, (vw - pad) / nw, (vh - pad) / nh);
  lbState.fit = fitScale;
  lbState.scale = fitScale;
  // 居中：图左上角 = (视口 - 图尺寸*scale) / 2
  lbState.tx = (vw - nw * fitScale) / 2;
  lbState.ty = (vh - nh * fitScale) / 2;
  lbApply();
}

function lbResetDrag() {
  lbState.dragging = false;
  lbState.pointerId = null;
  if (lb) lb.classList.remove("dragging");
}

function lbFail() {
  lbState.natW = 0; lbState.natH = 0;
  lbState.scale = 1; lbState.tx = 0; lbState.ty = 0; lbState.fit = 1;
  if (lbImg) lbImg.style.transform = "";
  if (lb) { lb.classList.add("failed"); lb.classList.remove("show-zoom"); }
  if (lbBadge) lbBadge.textContent = "";
  if (lbHint) lbHint.textContent = "图片加载失败";
}

function openLightbox(url) {
  if (!lb || !lbImg || !url) return;
  lbResetDrag();
  lb.classList.remove("dragging", "show-zoom", "failed");
  if (lbHint) lbHint.textContent = LB_HINT;
  // 先复位 state，避免上一张的 scale/tx 泄到新图（尤其新图更小/更大时）
  lbState.scale = 1; lbState.tx = 0; lbState.ty = 0; lbState.fit = 1;
  lbImg.style.transform = "none";
  lb.hidden = false;
  const onReady = () => {
    lbImg.removeEventListener("error", onErr);
    const w = lbImg.naturalWidth || 0, h = lbImg.naturalHeight || 0;
    if (!w || !h) { lbFail(); return; }
    lbState.natW = w; lbState.natH = h;
    lbFit();
  };
  const onErr = () => { lbImg.removeEventListener("load", onReady); lbFail(); };
  lbImg.addEventListener("load", onReady, { once: true });
  lbImg.addEventListener("error", onErr, { once: true });
  lbImg.src = url;
  // 缓存命中：complete 已真且尺寸已知，直接走一遍（load 不会再发）
  if (lbImg.complete && lbImg.naturalWidth) onReady();
}

function closeLightbox() {
  if (!lb) return;
  lbResetDrag();
  lb.hidden = true;
  lb.classList.remove("dragging", "show-zoom", "failed");
  lbState.scale = 1; lbState.tx = 0; lbState.ty = 0; lbState.fit = 1;
  lbState.natW = 0; lbState.natH = 0;
  if (lbHint) lbHint.textContent = LB_HINT;
  if (lbBadge) lbBadge.textContent = "";
  // 彻底断开上一张：清 transform + 摘 src（否则隐藏着的 img 仍占解码内存，且下张可能读到旧尺寸）
  if (lbImg) { lbImg.style.transform = ""; lbImg.removeAttribute("src"); }
}

if (lb) {
  // 滚轮缩放（passive:false 才能 preventDefault，阻止底页跟着滚）
  lb.addEventListener("wheel", (e) => {
    if (lb.hidden || !lbState.natW) return;
    e.preventDefault();
    // 触控板 / 按住 Ctrl（macOS 双指）会给出很小的 deltaY，统归一到一个步长
    const step = 1.12;
    const factor = e.deltaY < 0 ? step : 1 / step;
    lbZoomAt(lbState.scale * factor, e.clientX, e.clientY);
  }, { passive: false });

  // 拖动平移：按下必须在图上（蒙版上按下 = 点空白关闭，不进入拖拽）
  lb.addEventListener("pointerdown", (e) => {
    if (lb.hidden || !lbState.natW) return;
    if (e.button !== 0) return;                       // 只左键
    if (e.target !== lbImg) return;                   // 只在图上拖
    lbState.dragging = true;
    lbState.pointerId = e.pointerId;
    lbState.sx = e.clientX - lbState.tx;
    lbState.sy = e.clientY - lbState.ty;
    lb.classList.add("dragging");
    // 2026-10-21 注意：这里绝不能 e.preventDefault()。
    // 在 pointerdown 上调 preventDefault 会抑制后续兼容鼠标事件，
    // 导致 dblclick 根本不触发（实测双击完全无反应）。
    // 拖影已由 img[draggable=false] + user-select:none 阻断，无需 preventDefault。
    try { lbImg.setPointerCapture(e.pointerId); } catch { /* 老浏览器忽略 */ }
  });

  // move/up 挂 window：指针即使移出图片/窗口边缘也不丢
  window.addEventListener("pointermove", (e) => {
    if (!lbState.dragging) return;
    if (lbState.pointerId !== null && e.pointerId !== lbState.pointerId) return;
    lbState.tx = e.clientX - lbState.sx;
    lbState.ty = e.clientY - lbState.sy;
    lbApply();
  });
  const endDrag = (e) => {
    if (!lbState.dragging) return;
    if (e && lbState.pointerId !== null && e.pointerId !== lbState.pointerId) return;
    lbResetDrag();
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  // 捕获被系统/其他元素抢走时也要复位，否则 dragging 永远为 true（下次拖动直接跳位）
  if (lbImg) lbImg.addEventListener("lostpointercapture", endDrag);

  // 双击已移除（2026-10-21）：单击已经承担「放大↔缩回」，再保留双击会冲突 ——
  // 一次双击会先后触发两次单击（放大→缩回）再触发 dblclick（又切一次），
  // 最终落到哪个态取决于事件顺序，不可控。想要 1:1 看原图，滚轮或单击放大后就能到。

  // 单击图片：放大 ↔ 缩回（2026-10-21 用户定）。
  // 与拖动共存的条件：按下到抬起的位移 ≤ CLICK_SLOP 才算“单击”，否则算拖拽不响应。
  // 阈值取 5px：手抖、触控板微动不会误触；真要放大得明确地点一下。
  // 目标态：当前≈fit → 放大到 2×fit（至少也到 1:1 原尺寸）；否则回 fit。
  const LB_CLICK_SLOP = 5;
  let pressPt = null;
  lb.addEventListener("pointerdown", (e) => {
    if (lb.hidden || e.target !== lbImg) { pressPt = null; return; }
    if (e.button !== 0) { pressPt = null; return; }
    pressPt = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0 };
  });
  window.addEventListener("pointermove", (e) => {
    if (!pressPt) return;
    if (e.pointerId !== pressPt.id) return;
    const d = Math.hypot(e.clientX - pressPt.x, e.clientY - pressPt.y);
    if (d > pressPt.moved) pressPt.moved = d;
  });
  window.addEventListener("pointerup", (e) => {
    if (!pressPt) return;
    if (e.pointerId !== pressPt.id) { pressPt = null; return; }
    const wasClick = pressPt.moved <= LB_CLICK_SLOP;
    const cx = e.clientX, cy = e.clientY;
    pressPt = null;
    if (!wasClick || lb.hidden || !lbState.natW) return;   // 拖过了就不算单击
    const atFit = Math.abs(lbState.scale - lbState.fit) <= lbState.fit * 0.02 + 1e-6;
    if (atFit) {
      // 放大：至少 2×fit，但不要小于 1:1，也不要超过上限
      const target = clamp(Math.max(lbState.fit * 2, 1), LB_MIN, LB_MAX);
      lbZoomAt(target, cx, cy);
    } else {
      // 缩回适应屏幕（居中）
      lbFit();
    }
  });

  // 点空白处关闭（点图上不关）。用 pointerdown+up 同点判定，避免拖拽结束误关。
  let downPt = null;
  lb.addEventListener("pointerdown", (e) => { downPt = { x: e.clientX, y: e.clientY, t: e.target }; });
  lb.addEventListener("click", (e) => {
    if (lb.hidden) return;
    if (e.target !== lb) return;                 // 只认空白处
    if (downPt && downPt.t !== lb) return;       // 按下时在图上 → 这是一次拖拽/点击图，不关
    if (downPt && (Math.abs(e.clientX - downPt.x) > 4 || Math.abs(e.clientY - downPt.y) > 4)) return;
    closeLightbox();
  });
}
try { window.addEventListener("keydown", (e) => { if (e.key === "Escape" && lb && !lb.hidden) closeLightbox(); }); } catch { /* 忽略 */ }

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
