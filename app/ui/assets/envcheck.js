// ui/assets/envcheck.js — ComfyUI 服务环境检查卡（T2 · 拉起服务）
// 数据 / 操作：POST /comfyui-hana/backend/{envcheck,clear,wait,start}
//   （surface 凭据由 sdk 的 hana.api.fetch 自动携带；app 路由经 controlKey 转发到中继。）
// 按钮：重试=重跑检查（复查通过则继续拉起）；清除其他进程=按快照清理勾选进程后继续；取消=终止流程。
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);
const root = $("ec-root");
const CARD_WIDTH = 460;

let session = null;
try { session = new URLSearchParams(location.search).get("appSurfaceSession") || null; } catch { session = null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 卡片状态机：init → (blocked | clean | error)；blocked 可重试/清除/取消；clean 可拉起；done / canceled 收束。
const S = {
  busy: false,
  phase: "init", // init | blocked | clean | error | done | canceled
  snapshotId: "",
  blockers: [],
  procs: new Map(), // pid -> 中继 processes[] 记录（带 clearable 标记）
  gpu: null,
  warnings: [],
  sel: new Set(), // 勾选待清理的 pid
  note: "",
  noteErr: false,
};

function errText(r) {
  const d = r && r.data;
  if (d && typeof d.error === "string" && d.error) return d.error;
  if (d && typeof d.raw === "string" && d.raw) return d.raw;
  if (r && typeof r.status === "number" && r.status) return `HTTP ${r.status}`;
  return "未知错误";
}

async function api(path, body) {
  const r = await hana.api.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    cache: "no-store",
  });
  const t = await r.text();
  let d = null;
  try { d = JSON.parse(t); } catch { d = null; }
  return { status: r.status, ok: r.ok && !(d && d.ok === false), data: d, raw: t ? t.slice(0, 160) : "" };
}

function isClearable(pid) {
  const p = S.procs.get(Number(pid));
  return !!(p && p.clearable);
}

// 默认勾选：快照里所有可清理的阻断项进程（compute → pid；port-residual → pids[]）。
function defaultSelection() {
  const out = new Set();
  for (const b of S.blockers) {
    const pids = b && b.kind === "compute" ? [b.pid] : (b && Array.isArray(b.pids) ? b.pids : []);
    for (const pid of pids) if (isClearable(pid)) out.add(Number(pid));
  }
  return out;
}

function blockerRows() {
  const out = [];
  for (const b of S.blockers) {
    if (b && b.kind === "compute") {
      out.push({ pid: b.pid, name: b.name || "(未知进程)", sub: b.reason || "疑似其他模型/推理服务", clearable: isClearable(b.pid) });
    } else if (b && b.kind === "port-residual") {
      for (const pid of (b.pids || [])) out.push({ pid, name: "8188 残留监听", sub: b.reason || "ComfyUI 监听但不可达，可清除后重启", clearable: isClearable(pid) });
    } else if (b && b.kind === "port-foreign") {
      for (const pid of (b.pids || [])) out.push({ pid, name: "8188 被无关进程占用", sub: b.reason || "仅报告，不清理", clearable: false });
    }
  }
  return out;
}

function gpuLine() {
  const g = S.gpu;
  if (!g || g.available !== true) return g && g.error ? `显存：不可用（${g.error}）` : "显存：不可用";
  return `显存：${g.memoryUsedMiB ?? "?"}/${g.memoryTotalMiB ?? "?"} MiB（${g.usedPct ?? "?"}%）`;
}

function btn(id, label, cls, disabled) {
  return `<button class="ec-btn ${cls || ""}" id="${id}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function render() {
  const phase = S.phase;
  const title = phase === "blocked" ? "检测到其他模型占用 GPU"
    : phase === "error" ? "环境检查失败"
    : phase === "canceled" ? "已取消"
    : "ComfyUI 服务检查";
  const chip = phase === "blocked" ? '<span class="chip bad">有阻断</span>'
    : phase === "error" ? '<span class="chip bad">检查失败</span>'
    : phase === "done" ? '<span class="chip ok">已就绪</span>'
    : phase === "clean" ? '<span class="chip ok">检查通过</span>'
    : phase === "canceled" ? '<span class="chip">已取消</span>'
    : '<span class="chip">读取中…</span>';

  const parts = [];
  parts.push(`<div class="ec-hdr"><span class="ec-title">${esc(title)}</span>${chip}</div>`);

  if (phase === "blocked") {
    parts.push('<div class="ec-sub">以下进程占用 GPU 或 8188 端口，拉起前需要先处理：</div>');
    const list = blockerRows().map((r) => {
      const cb = r.clearable
        ? `<input type="checkbox" data-pid="${r.pid}" ${S.sel.has(Number(r.pid)) ? "checked" : ""} aria-label="选择清理 pid ${r.pid}">`
        : '<span class="tag">不清理</span>';
      return `<div class="ec-row">${cb}<div><div class="nm">${esc(r.name)} <span style="color:var(--text-muted);font-weight:400">· pid ${r.pid}</span></div><div class="meta">${esc(r.sub)}</div></div></div>`;
    }).join("");
    parts.push(`<div class="ec-list">${list}</div>`);
    parts.push(`<div class="ec-warn"><div>${esc(gpuLine())}</div>${S.warnings.map((w) => `<div>警告：${esc(w)}</div>`).join("")}</div>`);
    parts.push('<div class="ec-note">清除将丢失其上下文/缓存（进程会被终止，例如正在跑的小秘/推理服务）。</div>');
    parts.push(`<div class="ec-bar">${btn("ec-retry", "重试", "", S.busy)}${btn("ec-clear", "清除其他进程", "primary", S.busy)}${btn("ec-cancel", "取消", "", S.busy)}</div>`);
    if (S.snapshotId) parts.push(`<div class="ec-foot">快照 ${esc(S.snapshotId.slice(0, 8))} · 约 180s 内有效 · 仅能清理快照内进程</div>`);
  } else if (phase === "clean") {
    parts.push('<div class="ec-sub">环境检查通过，未发现阻断项。</div>');
    parts.push(`<div class="ec-warn"><div>${esc(gpuLine())}</div>${S.warnings.map((w) => `<div>警告：${esc(w)}</div>`).join("")}</div>`);
    parts.push(`<div class="ec-bar">${btn("ec-start", "拉起服务", "primary", S.busy)}${btn("ec-retry", "重新检查", "", S.busy)}${btn("ec-cancel", "取消", "", S.busy)}</div>`);
  } else if (phase === "error") {
    parts.push('<div class="ec-sub">环境检查没有跑通（中继可能未就绪或接口暂不可用）。可以直接拉起试试。</div>');
    parts.push(`<div class="ec-bar">${btn("ec-retry", "重试", "primary", S.busy)}${btn("ec-start", "直接拉起（跳过检查）", "", S.busy)}${btn("ec-cancel", "取消", "", S.busy)}</div>`);
  } else if (phase === "done") {
    parts.push('<div class="ec-sub">服务已就绪，可以打开工作区使用了。</div>');
  } else if (phase === "canceled") {
    parts.push('<div class="ec-sub">已取消，未做任何变更。如需重新开始，让助手再拉起一次即可。</div>');
  } else {
    parts.push('<div class="ec-sub">正在检查环境（GPU 计算进程 / 显存 / 8188 端口）…</div>');
  }

  if (S.note) parts.push(`<div class="ec-status${S.noteErr ? " err" : ""}">${esc(S.note)}</div>`);
  root.innerHTML = parts.join("");
  bind();
  reportSize();
}

function bind() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  on("ec-retry", () => { if (!S.busy) void runCheck(true); });
  on("ec-clear", () => { if (!S.busy) void clearFlow(); });
  on("ec-cancel", () => { if (!S.busy) { S.phase = "canceled"; S.note = ""; render(); } });
  on("ec-start", () => { if (!S.busy) void startFlow(); });
  root.querySelectorAll("input[data-pid]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const pid = Number(cb.getAttribute("data-pid"));
      if (cb.checked) S.sel.add(pid); else S.sel.delete(pid);
    });
  });
}

async function runCheck(userTriggered) {
  S.busy = true;
  S.noteErr = false;
  S.note = "正在检查环境…";
  render();
  let r = null;
  try { r = await api("/comfyui-hana/backend/envcheck"); } catch (e) { r = { status: 0, ok: false, data: { error: (e && e.message) || String(e) } }; }
  S.busy = false;
  if (!r.ok || !r.data || typeof r.data.snapshotId !== "string") {
    S.phase = "error";
    S.noteErr = true;
    S.note = `环境检查失败：${errText(r)}`;
    render();
    return;
  }
  const d = r.data;
  S.snapshotId = d.snapshotId;
  S.blockers = Array.isArray(d.blockers) ? d.blockers : [];
  S.warnings = Array.isArray(d.warnings) ? d.warnings : [];
  S.gpu = d.gpu || null;
  S.procs = new Map(
    (Array.isArray(d.processes) ? d.processes : [])
      .filter((p) => p && Number.isInteger(Number(p.pid)))
      .map((p) => [Number(p.pid), p]),
  );
  S.sel = defaultSelection();
  S.noteErr = false;
  S.note = "";
  if (S.blockers.length) {
    S.phase = "blocked";
    render();
    return;
  }
  S.phase = "clean";
  render();
  if (userTriggered) {
    S.note = "复查通过，继续拉起…";
    render();
    await startFlow();
  }
}

async function clearFlow() {
  const pids = [...S.sel];
  if (!pids.length) {
    S.noteErr = true;
    S.note = "请先勾选要清除的进程。";
    render();
    return;
  }
  S.busy = true;
  S.noteErr = false;
  S.note = `正在清除 ${pids.length} 个进程（终止 → 复核 → 复查）…`;
  render();
  let r = null;
  try { r = await api("/comfyui-hana/backend/clear", { snapshotId: S.snapshotId, pids }); } catch (e) { r = { status: 0, ok: false, data: { error: (e && e.message) || String(e) } }; }
  S.busy = false;
  if (!r.ok || !r.data) {
    S.noteErr = true;
    S.note = `清除失败：${errText(r)}`;
    render();
    return;
  }
  const d = r.data;
  const cleared = Array.isArray(d.cleared) ? d.cleared : [];
  const refused = Array.isArray(d.refused) ? d.refused : [];
  const recheck = d.recheck && typeof d.recheck === "object" ? d.recheck : {};
  const bits = [`已终止 ${cleared.length} 个${cleared.length ? `（${cleared.join(", ")}）` : ""}`];
  if (refused.length) bits.push(`拒绝 ${refused.length} 个：${refused.map((x) => `${x.pid}（${x.reason}）`).join("；")}`);
  if (recheck.note) bits.push(`复查：${recheck.note}`);
  S.noteErr = cleared.length === 0;
  S.note = bits.join("；");
  const portPids = Array.isArray(recheck.portPids) ? recheck.portPids : null;
  const portFree = portPids ? portPids.length === 0 : true;
  render();
  if (cleared.length && portFree) {
    S.note += "；继续拉起…";
    render();
    await startFlow();
  }
}

async function startFlow() {
  S.busy = true;
  S.noteErr = false;
  S.note = "正在请求拉起服务…";
  render();
  let r = null;
  try { r = await api("/comfyui-hana/backend/start"); } catch (e) { r = { status: 0, ok: false, data: { error: (e && e.message) || String(e) } }; }
  if (!r.ok) {
    S.busy = false;
    S.noteErr = true;
    S.note = `拉起失败：${errText(r)}`;
    render();
    return;
  }
  const d = r.data || {};
  if (d.reachable || d.state === "ready" || (d.already && !d.starting)) {
    S.busy = false;
    S.phase = "done";
    S.note = "服务已在运行。";
    render();
    return;
  }
  S.note = d.already ? `启动请求已受理（${d.detail || "启动中"}），等待就绪…` : "已请求拉起，等待就绪…";
  render();
  let last = null;
  for (let i = 1; i <= 5; i++) {
    await sleep(1500);
    let w = null;
    try { w = await api("/comfyui-hana/backend/wait"); } catch (e) { w = { status: 0, ok: false, data: { error: (e && e.message) || String(e) } }; }
    if (!w.ok || !w.data || typeof w.data.state !== "string") {
      S.note = `已请求拉起；等待接口暂不可用（${errText(w)}），可稍后用服务状态查看结果。`;
      break;
    }
    last = w.data;
    if (last.state === "ready") {
      S.phase = "done";
      S.note = `服务已就绪${typeof last.readyInMs === "number" ? `（启动耗时约 ${Math.round(last.readyInMs / 1000)}s）` : ""}。`;
      break;
    }
    if (last.state === "timeout" || last.state === "failed") {
      S.noteErr = true;
      S.note = last.state === "timeout"
        ? `启动超时：${last.detail || "仍未就绪"}（未杀进程，可稍后重看）`
        : `未检测到启动中的服务：${last.detail || ""}`;
      break;
    }
    S.note = `等待就绪（第 ${i} 轮）…`;
    render();
  }
  if (last && last.state === "starting") S.note = `仍在启动：${last.detail || ""}（可稍后用服务状态或左侧面板查看）`;
  S.busy = false;
  render();
}

function reportSize() {
  try {
    const h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 40) return;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主无此路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(() => reportSize()).observe(root); } catch { /* 忽略 */ }
  }
  void runCheck(false);
}
void main();
