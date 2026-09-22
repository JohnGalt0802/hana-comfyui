// ui/assets/panel-status.js — ComfyUI-Hana 功能面板（整页工作区左侧栏）
// 三块：连接状态（/comfyui-hana/status）+ 主机指标图表（/comfyui-hana/metrics）+ 释放显存
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);

// ── 主题跟随 ──────────────────────────────────────────────────────────────
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

// ── 连接状态 ──────────────────────────────────────────────────────────────
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
    render(await r.json());
  } catch (e) {
    $("p-note").textContent = "状态读取失败：" + String((e && e.message) || e);
  }
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
    $("v-pwr").textContent = g.powerW == null ? "—" : `${Math.round(g.powerW)}W`;
    pushPoint(hist.util, g.utilPct);
    pushPoint(hist.vram, g.memoryTotalMiB ? (g.memoryUsedMiB / g.memoryTotalMiB) * 100 : null);
    pushPoint(hist.temp, g.tempC);
    pushPoint(hist.pwr, g.powerW);
  } else {
    $("m-gpu-name").textContent = "GPU 不可用";
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

// ── 交互 ──────────────────────────────────────────────────────────────────
$("p-retry").addEventListener("click", async () => {
  try {
    await hana.api.fetch("/comfyui-hana/relay/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    $("p-note").textContent = "已请求启动，等待中继就绪……";
  } catch (e) {
    $("p-note").textContent = "启动请求失败：" + String((e && e.message) || e);
  }
  setTimeout(() => { void poll(); }, 800);
});
$("m-release").addEventListener("click", () => { void releaseVram(); });
window.addEventListener("resize", () => { redrawAll(); });

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => { syncTheme(); redrawAll(); }); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  setInterval(() => { void poll(); }, 2000);
  void metricsTick();
  setInterval(() => { void metricsTick(); }, 1000);
}
void main();
