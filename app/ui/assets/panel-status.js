// ui/assets/panel-status.js — 功能面板（连接状态），轮询 App 路由 /comfyui-hana/status
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);

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

const PHASE_LABEL = { idle: "待启动", starting: "启动中", ready: "就绪", error: "错误", stopped: "已停止" };

function chip(text, cls) {
  return `<span class="chip ${cls || ""}">${text}</span>`;
}

function render(st) {
  const boot = st.boot || {};
  const relay = st.relay || null;
  const backend = relay && relay.backend ? relay.backend : null;
  $("p-phase").innerHTML = chip(PHASE_LABEL[boot.phase] || String(boot.phase || "?"), boot.phase === "ready" ? "ok" : (boot.phase === "error" ? "bad" : "warn"));
  $("p-port").textContent = boot.service && boot.service.port ? String(boot.service.port) : "—";
  if (backend) {
    $("p-backend").innerHTML = backend.reachable ? chip("可达", "ok") : chip("不可达", "bad");
  } else {
    $("p-backend").textContent = "—";
  }
  const sys = backend && backend.system ? backend.system : null;
  $("p-ver").textContent = sys && sys.comfyui_version
    ? `${sys.comfyui_version}${sys.installed_frontend_version ? " · 前端 " + sys.installed_frontend_version : ""}`
    : "—";
  const q = relay && relay.queue ? relay.queue : null;
  $("p-queue").textContent = q ? `${q.running} 运行 / ${q.pending} 排队` : "—";
  $("p-note").textContent = boot.note || "";
  const errText = (boot.error && boot.error.userText) || st.relayError || (backend && !backend.reachable ? backend.lastError : "");
  $("p-err").textContent = errText ? `${(boot.error && boot.error.code) || "err"}：${errText}` : "";
}

async function poll() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/status", { cache: "no-store" });
    const st = await r.json();
    render(st);
  } catch (e) {
    $("p-note").textContent = "状态读取失败：" + String(e && e.message || e);
  }
}

$("p-retry").addEventListener("click", async () => {
  try {
    await hana.api.fetch("/comfyui-hana/relay/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    $("p-note").textContent = "已请求启动，等待中继就绪……";
  } catch (e) {
    $("p-note").textContent = "启动请求失败：" + String(e && e.message || e);
  }
  setTimeout(() => { void poll(); }, 800);
});

async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  setInterval(() => { void poll(); }, 2000);
}
void main();
