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
els.frame.addEventListener("load", () => { frameLoaded = true; els.loading.classList.remove("show"); });

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 订阅不可用则保留首帧 */ }
  try { await hana.ready(); } catch (e) { console.warn("[comfyui-hana] hana.ready 失败：", e); }
  void tick();
}
void main();
