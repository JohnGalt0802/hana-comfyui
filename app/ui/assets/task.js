// ui/assets/task.js — ComfyUI 任务卡（v0.2 完整版）
// 数据：GET /comfyui-hana/task?id=<promptId|taskId>（轮询）
// 预览图：经代理路径 + surface 凭据段加载（与工作区同款凭据链路）
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);
const root = $("tk-root");
const params = new URLSearchParams(location.search);
const ID = (params.get("pid") || params.get("id") || params.get("taskId") || "").trim();
const CARD_WIDTH = 460;

let session = null;
try { session = new URLSearchParams(location.search).get("appSurfaceSession") || null; } catch { session = null; }

let timer = null;
let tickTimer = null;
let lastData = null;
let lastStateClass = "";

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

function stateClass(jobState, stateText) {
  if (jobState === "completed") return "ok";
  if (jobState === "error" || jobState === "interrupted" || jobState === "canceled" || jobState === "timeout") return "bad";
  if (jobState === "running" || jobState === "pending") return "run";
  return "";
}

function thumbUrl(proxyPrefix, viewPath) {
  if (!proxyPrefix || !viewPath) return null;
  if (session) return `${proxyPrefix}_surface/${encodeURIComponent(session)}/${viewPath}`;
  return `${proxyPrefix}${viewPath}`; // 无凭据段时可能 403（降级显示占位）
}

function renderNote(text) {
  root.innerHTML = `<div class="tk-hdr"><span class="tk-title">ComfyUI 任务</span><span class="chip">—</span></div><div class="tk-note">${esc(text)}</div>`;
  reportSize();
}

function render(data) {
  lastData = data;
  if (!data || !data.ok) { renderNote(`读取失败：${data && data.error ? data.error : "未知错误"}`); return; }
  if (!data.found) {
    renderNote(`未找到任务 record：${ID}\n（可能已超出本进程记忆；提交后短时间内可用，或改用 comfyui action=query/result）`);
    return;
  }
  const t = data.task;
  const cls = stateClass(t.state, t.stateText);
  lastStateClass = cls;

  const outputs = Array.isArray(t.outputs) ? t.outputs : [];
  const progress = t.progress && typeof t.progress.value === "number" && typeof t.progress.max === "number" && t.progress.max > 0
    ? Math.min(100, Math.round((t.progress.value / t.progress.max) * 100)) : null;
  const indeterminate = (t.state === "running" || t.state === "pending") && progress === null;

  const rows = [];
  rows.push(`<div class="tk-row"><span>耗时</span><span class="v" data-tk-elapsed>${fmtDur(t.elapsedMs)}</span></div>`);
  if (t.queuePosition != null) rows.push(`<div class="tk-row"><span>队列位</span><span class="v">前 ${esc(t.queuePosition)} 个排队</span></div>`);
  if (t.currentNode != null) rows.push(`<div class="tk-row"><span>当前节点</span><span class="v">#${esc(t.currentNode)}</span></div>`);
  if (t.nodesDone) rows.push(`<div class="tk-row"><span>完成节点</span><span class="v">${esc(t.nodesDone)}</span></div>`);
  if (progress !== null) rows.push(`<div class="tk-row"><span>步进</span><span class="v">${t.progress.value}/${t.progress.max}</span></div>`);
  if (t.promptId) rows.push(`<div class="tk-row"><span>prompt</span><span class="v">${esc(String(t.promptId).slice(0, 8))}…</span></div>`);
  if (t.taskId) rows.push(`<div class="tk-row"><span>宿主任务</span><span class="v">${esc(t.taskId)}</span></div>`);

  const thumbs = outputs.slice(0, 12).map((o) => {
    const url = thumbUrl(data.proxyPrefix, o.viewPath);
    const label = esc(o.filename || "");
    if (url) {
      return `<div class="tk-thumb" title="${label}"><img src="${esc(url)}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=&quot;ph&quot;>${label}<br>（预览不可用）</div>'"><div class="name">${label}</div></div>`;
    }
    return `<div class="tk-thumb"><div class="ph">${label}<br>（无预览路径）</div></div>`;
  }).join("");
  const more = outputs.length > 12 ? `<div class="tk-note">还有 ${outputs.length - 12} 个产物（用 comfyui action=result 取完整清单）</div>` : "";

  const err = t.error ? `<div class="tk-err">${esc(typeof t.error === "string" ? t.error : `${t.error.type || ""} ${t.error.message || ""}`)}</div>` : "";

  root.innerHTML = `
    <div class="tk-hdr">
      <span class="tk-title">${esc(t.label || "ComfyUI 任务")}</span>
      <span class="chip ${cls}">${esc(t.stateText || t.state)}</span>
    </div>
    <div class="tk-bar ${indeterminate ? "indet" : ""}"><div style="width:${progress !== null ? progress : indeterminate ? 40 : 0}%"></div></div>
    ${rows.join("")}
    ${outputs.length ? `<div class="tk-out">${thumbs}</div>${more}` : ""}
    ${err}
    <div class="tk-note">${t.state === "running" || t.state === "pending" ? "自动刷新中…" : "任务已结束。"}</div>
  `;
  reportSize();
}

function reportSize() {
  try {
    const h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 40) return;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主无此路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

async function poll() {
  const id = ID;
  if (!id) { renderNote("缺少任务标识（url 需要 ?pid=<promptId> 或 ?taskId=）"); return; }
  try {
    const r = await hana.api.fetch(`/comfyui-hana/task?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    render(data);
    schedule(data);
  } catch (e) {
    renderNote(`读取失败：${(e && e.message) || e}`);
    schedule(null);
  }
}

function schedule(data) {
  const done = data && data.ok && data.found && ["completed", "error", "interrupted", "canceled", "timeout"].includes(data.task.state);
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
  // 秒级刷新的“耗时”字段（不动整块 DOM）
  tickTimer = setInterval(() => {
    try {
      const el = document.querySelector("[data-tk-elapsed]");
      if (el && lastData?.task && !["completed", "error", "interrupted", "canceled", "timeout"].includes(lastData.task.state)) {
        el.textContent = fmtDur(Date.now() - lastData.task.submittedAt);
      }
    } catch { /* 忽略 */ }
  }, 1000);
  void poll();
}
void main();
