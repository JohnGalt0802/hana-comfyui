// ui/assets/panel-status.js — Hana-ComfyUI 功能面板（整页工作区左侧栏）
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

  // 服务起停按钮：不可达 → 「启动服务」；可达 → 「停止服务」
  const reachable = !!(backend && backend.reachable);
  const proc = backend && backend.proc ? backend.proc : null;
  const startBtn = $("p-start"), stopBtn = $("p-stop");
  if (!svcBusy) {
    startBtn.style.display = reachable ? "none" : "";
    stopBtn.style.display = reachable ? "" : "none";
    startBtn.disabled = false;
    stopBtn.disabled = false;
    const hasInstall = !!(proc && (proc.install || proc.python || proc.mainPy));
    startBtn.title = hasInstall
      ? `启动 ComfyUI：${proc.python || proc.mainPy || ""}`
      : "按本机安装探测结果拉起 ComfyUI（由计划任务以当前用户身份起，独立于 Hana 存活）";
  }

  const svcBits = [];
  if (proc) {
    if (proc.install) svcBits.push(`安装根 ${proc.install}`);
    if (reachable && Array.isArray(proc.pids) && proc.pids.length) svcBits.push(`监听进程 ${proc.pids.join(", ")}`);
    const stamp = (iso) => String(iso).replace("T", " ").slice(0, 19);
    if (proc.startedAt) svcBits.push(reachable ? `本 App 拉起于 ${stamp(proc.startedAt)}` : `上次由本 App 拉起：${stamp(proc.startedAt)}`);
    if (!reachable && proc.lastStop && proc.lastStop.at) svcBits.push(`上次停止：${stamp(proc.lastStop.at)}`);
  }
  $("p-note").textContent = [boot.note || "", svcBits.join(" · ")].filter(Boolean).join("\n");
  const errText = (boot.error && boot.error.userText) || st.relayError || (backend && !backend.reachable ? backend.lastError : "");
  const procErr = proc && proc.lastError ? `服务：${proc.lastError}` : "";
  $("p-err").textContent = [errText ? `${(boot.error && boot.error.code) || "err"}：${errText}` : "", procErr].filter(Boolean).join("\n");
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

// ── 服务起停（启动/停止 8188 上的 ComfyUI 本体）─────────────────────────
let svcBusy = false;

function setSvcBusy(on, label) {
  svcBusy = on;
  const btn = label && label.indexOf("停") === 0 ? $("p-stop") : $("p-start");
  if (on) { btn.disabled = true; btn.textContent = label || "处理中…"; }
  else { btn.textContent = btn.id === "p-stop" ? "停止服务" : "启动服务"; void poll(); }
}

async function startService() {
  if (svcBusy) return;
  setSvcBusy(true, "启动中…");
  let msg = "";
  try {
    const r = await hana.api.fetch("/comfyui-hana/backend/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.ok !== false) {
      msg = j.already ? "服务已在运行" : "已请求启动，等待就绪（首次约 30～90 秒）…";
    } else {
      msg = "启动失败：" + ((j && j.error) || `HTTP ${r.status}`);
    }
  } catch (e) {
    msg = "启动失败：" + String((e && e.message) || e);
  } finally {
    $("p-note").textContent = msg;
    setSvcBusy(false, "启动服务");
  }
}

async function stopService() {
  if (svcBusy) return;
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
    else msg = `已停止服务（进程 ${JSON.stringify((j && j.stopped) || [])}）`;
  } catch (e) {
    msg = "停止失败：" + String((e && e.message) || e);
  } finally {
    $("p-note").textContent = msg;
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
  if (st.before) $("u-local").textContent = st.after ? `${fmtVer(st.before)} → ${fmtVer(st.after)}` : fmtVer(st.before);
  const steps = (st.steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `：${String(s.detail).split("\n").slice(-1)[0]}` : ""}`);
  // 日志尾给到 30 行：git pull / pip install 的输出更有参考价值
  $("u-log").textContent = [...steps, ...(st.logTail || []).slice(-30)].filter(Boolean).join("\n");
  if (st.lastError) $("u-note").textContent = `更新失败：${st.lastError}`;
  else if (st.phase === "done") $("u-note").textContent = "更新完成。点「启动服务」重新拉起 ComfyUI。";
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

// ── 交互 ──────────────────────────────────────────────────────────────────
$("p-retry").addEventListener("click", async () => {
  $("p-note").textContent = "已请求重启中继，等待就绪……";
  try {
    await hana.api.fetch("/comfyui-hana/relay/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch (e) {
    $("p-note").textContent = "重启请求失败：" + String((e && e.message) || e);
  }
  setTimeout(() => { void poll(); }, 800);
});
$("p-start").addEventListener("click", () => { void startService(); });
$("p-stop").addEventListener("click", () => { void stopService(); });
$("m-release").addEventListener("click", () => { void releaseVram(); });
$("u-check").addEventListener("click", () => { void checkUpdate(); });
$("u-apply").addEventListener("click", () => { void applyUpdate(); });
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
  void updStatusTick(); // 初始显示当前版本 / 上次更新结果
}
void main();
