// ui/assets/task.js — ComfyUI 任务卡（2026-10-13 重做）
// 改动面：① 删内部 ID（promptId / taskId）② 元信息压一行 ③ 节点时间轴（完成点亮 / 当前流动 / 未跑留灰）
// ④ 实时预览区（previewFrames 最新帧 + 胶片点选回放）⑤ 产物缩略图按真实宽高比（contain + columns）
// ⑥ 卡内 lightbox（纯前端，不用宿主权限）⑦ 失败态红段 + 断点节点 + 可行动提示
// 保留：轮询 / 身份解析（cardId）/ 主题跟随（t-dark）/ 尺寸上报（reportSize）
// 数据：GET /comfyui-hana/task?cardId=<卡实例 id>（轮询）；product 预览经代理路径 + surface 凭据段。
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

// ── 主题 ──
function syncTheme() {
  let snap = null;
  try { snap = hana.theme?.getSnapshot?.() || null; } catch { snap = null; }
  const label = String(snap?.theme || "");
  let dark = snap?.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
  if (!snap?.appearance && (!label || label === "inherit")) {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  document.body.classList.toggle("t-dark", dark);
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

function stateClass(jobState) {
  if (jobState === "completed") return "ok";
  if (jobState === "error" || jobState === "interrupted" || jobState === "canceled" || jobState === "timeout") return "bad";
  if (jobState === "running" || jobState === "pending") return "run";
  return "";
}
const isTerminal = (s) => ["completed", "error", "interrupted", "canceled", "timeout"].includes(s);
const isActive = (s) => s === "running" || s === "pending";

function thumbUrl(proxyPrefix, viewPath) {
  if (!proxyPrefix || !viewPath) return null;
  if (session) return `${proxyPrefix}_surface/${encodeURIComponent(session)}/${viewPath}`;
  return `${proxyPrefix}${viewPath}`; // 无凭据段时可能 403（降级为占位）
}

// ── 节点名映射（尽力而为：拿不到就如实显示「节点 #N」，不瞎编）──
function nodeLabel(id, t) {
  if (id == null || id === "") return "—";
  const key = String(id);
  const map = (t && (t.nodeNames || t.nodeTitles || t.nodeLabels)) || null;
  if (map && typeof map === "object" && typeof map[key] === "string" && map[key].trim()) {
    return `${map[key].trim()}（#${key}）`;
  }
  return `节点 #${key}`;
}

// 总节点数：优先显式字段，其次从 label「（N 节点）」解析；拿不到返回 null（时间轴退化为「已跑 + 尾部留白」）
function totalNodes(t) {
  const direct = num(t.nodeCount) ?? num(t.totalNodes) ?? num(t.nodesTotal);
  if (direct && direct > 0) return Math.trunc(direct);
  const m = /(\d+)\s*节点/.exec(String(t.label || ""));
  if (m) { const n = Number(m[1]); if (n > 0) return n; }
  return null;
}

// ── 失败态：一句可行动提示（只在证据支持时点名原因）──
function errorText(t) {
  const e = t.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  return `${e.type || ""} ${e.message || ""}`.trim() || JSON.stringify(e);
}
function errorHint(t) {
  const msg = errorText(t);
  if (/allocat|out of memory|\boom\b|cuda.*memory|显存|内存不足/i.test(msg)) {
    return "疑似显存不足：降低分辨率 / 批量（降倍率），或先释放显存（关掉其它占 GPU 的程序、清空 ComfyUI 队列）后重跑。";
  }
  if (/interrupt|cancel|取消|中断/i.test(msg)) {
    return "任务被中断 / 取消；如需继续请重新提交。";
  }
  return "可到 ComfyUI 控制台看完整堆栈，修正后重新提交。";
}

// ── DOM 骨架（一次建立，之后按需局部更新，避免整块重绘闪烁）──
const el = {};
function ensureSkeleton() {
  if (el.title && el.title.isConnected) return;
  root.innerHTML = `
    <div class="tk-hdr">
      <span class="tk-title"></span>
      <span class="tk-elapsed" data-tk-elapsed></span>
      <span class="chip"></span>
    </div>
    <div class="tk-meta"></div>
    <div class="tk-bar"><div></div></div>
    <div class="tk-tl"></div>
    <div class="tk-tl-cap"></div>
    <div class="tk-pv">
      <div class="tk-pv-wrap"><img class="tk-pv-img" alt="实时预览"></div>
      <div class="tk-pv-bar"></div>
    </div>
    <div class="tk-out"></div>
    <div class="tk-err"></div>
    <div class="tk-hint"></div>
    <div class="tk-foot"></div>`;
  el.title = root.querySelector(".tk-title");
  el.elapsed = root.querySelector(".tk-elapsed");
  el.chip = root.querySelector(".chip");
  el.meta = root.querySelector(".tk-meta");
  el.bar = root.querySelector(".tk-bar");
  el.barFill = el.bar.querySelector("div");
  el.tl = root.querySelector(".tk-tl");
  el.cap = root.querySelector(".tk-tl-cap");
  el.pv = root.querySelector(".tk-pv");
  el.pvWrap = root.querySelector(".tk-pv-wrap");
  el.pvImg = root.querySelector(".tk-pv-img");
  el.pvBar = root.querySelector(".tk-pv-bar");
  el.out = root.querySelector(".tk-out");
  el.err = root.querySelector(".tk-err");
  el.hint = root.querySelector(".tk-hint");
  el.foot = root.querySelector(".tk-foot");
  el.pvWrap.addEventListener("click", () => { const s = el.pvImg.getAttribute("src"); if (s) openLightbox(s); });
  segEls = []; thumbEls = []; stripEls = [];
  lastSegSig = ""; lastOutKey = "";
}

function renderNote(text) {
  el.title = null; // 骨架失效，下轮重建
  root.innerHTML = `<div class="tk-hdr"><span class="tk-title">ComfyUI 任务</span><span class="chip">—</span></div><div class="tk-note">${esc(text)}</div>`;
  reportSize(true);
}

// ── 时间轴 ──
let segEls = [];
let lastSegSig = "";
function buildSegments(t, cls) {
  const done = Math.max(0, Math.trunc(num(t.nodesDone) || 0));
  const total = totalNodes(t);
  const failed = cls === "bad";
  const active = isActive(t.state);
  const segs = [];
  if (total && total > 0) {
    let count = total;
    let d = done;
    if (count > 24) { d = Math.round((done / total) * 24); count = 24; } // 超长工作流按比例压到 24 段
    for (let i = 0; i < count; i += 1) segs.push({ k: i < d ? "done" : "idle" });
    if (failed) { if (d < count) segs[d].k = "bad"; else if (count) segs[count - 1].k = "bad"; }
    else if (active) { if (d < count) segs[d].k = "cur"; else if (count) segs[count - 1].k = "cur"; }
  } else {
    for (let i = 0; i < done; i += 1) segs.push({ k: "done" });
    if (failed) segs.push({ k: "bad" });
    else if (active) segs.push({ k: "cur" });
    for (let i = 0; i < 4; i += 1) segs.push({ k: "tail" }); // 末段留白＝剩余未知
    if (!segs.length) segs.push({ k: "tail" });
  }
  return segs;
}
function renderTimeline(t, cls) {
  const segs = buildSegments(t, cls);
  const sig = segs.map((s) => s.k).join("");
  if (sig !== lastSegSig) {
    lastSegSig = sig;
    if (segEls.length !== segs.length) {
      el.tl.innerHTML = "";
      segEls = segs.map(() => {
        const d = document.createElement("div");
        el.tl.appendChild(d);
        return d;
      });
    }
    segs.forEach((s, i) => { segEls[i].className = `tk-seg ${s.k}`; });
  }
  // 说明行
  const parts = [];
  const p = t.progress;
  if (p && num(p.value) != null && num(p.max) != null) parts.push(`第 ${p.value}/${p.max} 步`);
  const done = Math.trunc(num(t.nodesDone) || 0);
  const total = totalNodes(t);
  if (cls === "bad") {
    parts.push(`断在 ${nodeLabel(t.currentNode != null ? t.currentNode : p && p.node, t)}`);
    parts.push(total ? `已跑 ${done}/${total}` : `已跑 ${done}`);
  } else {
    if (!isTerminal(t.state)) parts.push(nodeLabel(t.currentNode, t));
    if (total) parts.push(`已跑 ${done}/${total}`);
    else if (done) parts.push(`已跑 ${done}`);
  }
  const text = parts.filter(Boolean).join(" · ");
  if (el.cap.textContent !== text) el.cap.textContent = text;
  el.cap.hidden = !text;
}

// ── 元信息一行 ──
function chipNum(label, v) { return `<span class="m">${esc(label)}<b>${esc(v)}</b></span>`; }
function renderMeta(t) {
  const items = [];
  if (t.queuePosition != null) items.push(chipNum("队列", `前 ${t.queuePosition}`));
  const p = t.progress;
  if (p && num(p.value) != null && num(p.max) != null) items.push(chipNum("步进", `${p.value}/${p.max}`));
  const done = Math.trunc(num(t.nodesDone) || 0);
  const total = totalNodes(t);
  if (done || total) items.push(chipNum("已跑节点", total ? `${done}/${total}` : `${done}`));
  const html = items.join("");
  if (el.meta.innerHTML !== html) el.meta.innerHTML = html;
  el.meta.hidden = !items.length;
}

// ── 进度条 ──
function renderBar(t, cls) {
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
  el.barFill.style.width = `${indet ? 38 : pct}%`;
}

// ── 实时预览（最新帧 + 胶片点选回放）──
let stripEls = [];
let follow = true;
let selIndex = -1;
let lastFrameKey = "";
const frameSrc = (f) => (/^data:/.test(f) ? f : `data:image/jpeg;base64,${f}`);
function renderPreview(t, hasOutputs) {
  const raw = Array.isArray(t.previewFrames) ? t.previewFrames.filter((f) => typeof f === "string" && f) : [];
  // 完成后让位给成品图；缺帧或空帧 → 整块隐藏（不留空框、不报错）
  const show = raw.length > 0 && !(t.state === "completed" && hasOutputs);
  el.pv.hidden = !show;
  if (!show) { lastFrameKey = ""; return; }
  const frames = raw.slice(-16); // 环形最多 16，最新在后
  const key = `${frames.length}|${frames[frames.length - 1].slice(-48)}`;
  if (key !== lastFrameKey) {
    lastFrameKey = key;
    if (follow) selIndex = frames.length - 1;
  }
  if (selIndex < 0 || selIndex >= frames.length) { selIndex = frames.length - 1; follow = true; }

  const src = frameSrc(frames[selIndex]);
  if (el.pvImg.getAttribute("src") !== src) el.pvImg.src = src; // 只换 src，元素不重建 → 不闪

  // 胶片（每个槽位按需换 src，元素常驻）
  if (stripEls.length !== frames.length) {
    el.pvBar.innerHTML = "";
    stripEls = [];
    for (let i = 0; i < frames.length; i += 1) {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "tk-film";
      const im = document.createElement("img");
      im.alt = `第 ${i + 1} 帧`;
      d.appendChild(im);
      d.title = `第 ${i + 1} 帧`;
      d.addEventListener("click", () => { selIndex = i; follow = i === frames.length - 1; lastFrameKey = ""; if (lastData) render(lastData); });
      el.pvBar.appendChild(d);
      stripEls.push({ box: d, img: im });
    }
  }
  frames.forEach((f, i) => {
    const s = frameSrc(f);
    if (stripEls[i] && stripEls[i].img.getAttribute("src") !== s) stripEls[i].img.src = s;
  });
  stripEls.forEach((s, i) => { s.box.className = `tk-film${i === selIndex ? " on" : ""}`; });
  el.pvBar.classList.toggle("follow", follow);
}

// ── 产物缩略图（columns 保自然宽高比）──
let thumbEls = [];
let lastOutKey = "";
function renderOutputs(outputs, proxyPrefix) {
  const shown = outputs.slice(0, 24);
  const key = shown.map((o) => o.viewPath || o.filename || "").join("|");
  if (key !== lastOutKey) {
    lastOutKey = key;
    el.out.innerHTML = "";
    thumbEls = shown.map((o) => {
      const url = thumbUrl(proxyPrefix, o.viewPath);
      const label = o.filename || "";
      const box = document.createElement("div");
      box.className = "tk-thumb";
      if (!url) {
        const ph = document.createElement("div");
        ph.className = "ph";
        ph.textContent = `${label}\n（无预览路径）`;
        box.appendChild(ph);
      } else {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = label;
        img.addEventListener("error", () => box.classList.add("miss"));
        img.src = url;
        box.title = label;
        box.addEventListener("click", () => openLightbox(url));
        box.appendChild(img);
      }
      if (label) {
        const n = document.createElement("div");
        n.className = "name";
        n.textContent = label;
        box.appendChild(n);
      }
      el.out.appendChild(box);
      return box;
    });
  }
  el.out.hidden = !shown.length;
  return outputs.length - shown.length;
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

// ── 主渲染 ──
function render(data) {
  lastData = data;
  if (!data || !data.ok) { renderNote(`读取失败：${data && data.error ? data.error : "未知错误"}`); return; }
  if (!data.found) {
    renderNote(`未找到任务 record：${identity ? identity.value : "?"}\n（可能已超出本进程记忆；提交后短时间内可用，或改用 comfyui action=query/result）`);
    return;
  }
  const t = data.task;
  const cls = stateClass(t.state);
  ensureSkeleton();

  const terminal = isTerminal(t.state);
  if (terminal && !render._terminalReported) {
    render._terminalReported = true;
    [0, 1000, 2500].forEach((d) => setTimeout(() => reportSize(true), d));
  }

  el.title.textContent = t.label || "ComfyUI 任务";
  el.title.title = t.label || "";
  el.chip.textContent = t.stateText || t.state;
  el.chip.className = `chip ${cls}`;
  const elapsedVal = isActive(t.state) && t.submittedAt ? Date.now() - t.submittedAt : t.elapsedMs;
  el.elapsed.textContent = fmtDur(elapsedVal);

  renderMeta(t);
  renderBar(t, cls);
  renderTimeline(t, cls);

  const outputs = Array.isArray(t.outputs) ? t.outputs : [];
  renderPreview(t, outputs.length > 0);
  const moreCount = renderOutputs(outputs, data.proxyPrefix);

  const errText = cls === "bad" ? errorText(t) : "";
  el.err.textContent = errText;
  el.err.hidden = !errText;
  el.hint.textContent = errText ? errorHint(t) : "";
  el.hint.hidden = !errText;

  const foot = [];
  foot.push(terminal ? "任务已结束。" : "自动刷新中…");
  if (moreCount > 0) foot.push(`另有 ${moreCount} 个产物（用 comfyui action=result 取完整清单）。`);
  el.foot.textContent = foot.join(" ");

  reportSize();
}

// ── 尺寸上报（宽度上报 + 高度随内容；启动期自愈收敛）──
var lastReportedH = 0;
function reportSize(force) {
  try {
    const h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 40) return;
    if (!force && h === lastReportedH) return;
    lastReportedH = h;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主无此路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}
(function bootSettle() {
  if (typeof setInterval !== "function") return;
  const adopted = () => { try { return Math.abs(window.innerWidth - CARD_WIDTH) <= 2; } catch { return true; } };
  reportSize(true);
  try { window.addEventListener("resize", () => { if (!adopted()) reportSize(true); }); } catch { /* 忽略 */ }
  let n = 0;
  const timer2 = setInterval(() => {
    n += 1;
    if (adopted()) { clearInterval(timer2); return; }
    reportSize(true);
    if (n >= 6) clearInterval(timer2);
  }, 1500);
})();

// ── 身份与轮询（自愈式：启动期错过握手也能自动恢复）──
// 缺陷背景：宿主 event loop 严重卡顿时（实测 24~67s），注入 surface 上下文的握手消息
// 可能迟到；旧逻辑只在启动轮询 12×150ms，错过就永久停在错误文案。现在改为：
// ① poll 每轮自愈重试 ② 解析窗口拉长到 40×150ms ③ 订阅 onContextChanged 抢先 ④ re-show 补试。
let identity = null;
let resolving = null;   // 进行中的解析（并发重试合并成一次，不叠加探测循环）
let lastReshowAt = 0;   // re-show 连续触发合并

async function resolveIdentity() {
  let q = null;
  try { q = new URLSearchParams(location.search); } catch { q = null; }
  const qid = q ? (q.get("id") || q.get("pid") || q.get("taskId") || "").trim() : "";
  if (qid) return { kind: "id", value: qid };
  // 轮询上限 40 × 150ms ≈ 6s：覆盖宿主卡顿（原先 12×150ms≈1.8s 太短）。
  for (let i = 0; i < 40; i += 1) {
    if (identity) return identity;   // 订阅/其它路径已抢先拿到就不必再等
    let ctx = null;
    try { ctx = hana.surface?.getContext?.() || null; } catch { ctx = null; }
    if (ctx && typeof ctx.cardInstanceId === "string" && ctx.cardInstanceId.trim()) {
      return { kind: "cardId", value: ctx.cardInstanceId.trim() };
    }
    await sleep(150);
  }
  return null;
}

// 解析入口：轮询自愈 / 订阅 / re-show 共用同一逻辑；进行中的解析被复用，不重复起循环。
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

// 双保险之一：订阅 surface 上下文变化（onContextChanged 会立即回调一次当前值）。
// 订阅不可用 / 抛错时静默忽略 —— 正确性不押在订阅上，靠 poll 内的自愈轮询兜底。
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

// 双保险之二：re-show 重试（宿主 park 后移回时 iframe 不重载，启动期的解析早已结束）。
// 连续触发用 ~400ms 合并，只做一次性 setTimeout，不引入常驻定时器。
function onReshow() {
  try {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (identity) return;
    const now = Date.now();
    if (now - lastReshowAt < 400) return;
    lastReshowAt = now;
    setTimeout(() => { void retryIdentity(); }, 0);
  } catch { /* 事件不可用不影响主流程 */ }
}
try {
  document.addEventListener("visibilitychange", onReshow);
  window.addEventListener("pageshow", onReshow);
} catch { /* 忽略 */ }

const FETCH_TIMEOUT_MS = 15000;

// 给单次取数加兜底：fetch 永久挂起时不至于让 await 永不返回（否则 pollInFlight 永不复位 → 卡片冻结）。
function fetchWithTimeout(url, ms) {
  let to = null;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(Object.assign(new Error("timeout"), { __timeout: true })), ms);
  });
  const req = hana.api.fetch(url, { cache: "no-store" });
  req.catch(() => {});   // 防 race 落败后 req 的 rejection 变成 unhandledrejection
  return Promise.race([req, timeout]).finally(() => { if (to) clearTimeout(to); });
}

let pollInFlight = false;
async function poll() {
  if (pollInFlight) return;   // 订阅/定时器可能同时唤起 poll：进行一次即可，避免叠加请求
  pollInFlight = true;
  try {
    if (!identity) {
      // 自愈：每轮都重新尝试解析。宿主卡顿期错过握手 → 恢复后这里自动接上，
      // 卡片不再「一次失败就永久停在提示文案」。
      identity = await retryIdentity();
    }
    if (!identity) {
      renderNote("正在等待卡片上下文…");
      schedule(null);
      return;
    }
    const qs = identity.kind === "cardId"
      ? `cardId=${encodeURIComponent(identity.value)}`
      : `id=${encodeURIComponent(identity.value)}`;
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

async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(() => reportSize()).observe(root); } catch { /* 忽略 */ }
  }
  // 秒级刷新的「耗时」（只改文本节点，不动整块 DOM）
  tickTimer = setInterval(() => {
    try {
      const t = lastData?.task;
      if (!el.elapsed || !el.elapsed.isConnected || !t) return;
      if (isActive(t.state) && t.submittedAt) el.elapsed.textContent = fmtDur(Date.now() - t.submittedAt);
    } catch { /* 忽略 */ }
  }, 1000);
  subscribeContext();
  void poll();   // 身份解析（含自愈重试）全部由 poll 负责
}
void main();
