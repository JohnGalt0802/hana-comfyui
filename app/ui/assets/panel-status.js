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
  $("p-port").textContent = boot.service && boot.service.port ? String(boot.service.port) : "—";
  if (backend && !relayDown) {
    $("p-backend").innerHTML = backend.reachable ? chip("可达", "ok") : chip("服务未跑", "bad");
  } else {
    $("p-backend").textContent = "—";
  }
  const sys = backend && !relayDown && backend.system ? backend.system : null;
  $("p-ver").textContent = sys && sys.comfyui_version
    ? `${sys.comfyui_version}${sys.installed_frontend_version ? " · 前端 " + sys.installed_frontend_version : ""}`
    : "—";
  const q = !relayDown && relay && relay.queue ? relay.queue : null;
  $("p-queue").textContent = q ? `${q.running} 运行 / ${q.pending} 排队` : "—";

  lastStatus = st; // 信号灯推导用

  // 服务起停按钮：① 中继不可达 → 双收（先重启中继）② 服务未跑 → 「启动服务」③ 就绪 → 「停止服务」
  const reachable = !!(backend && backend.reachable) && !relayDown; // 保守：中继不可达时后端可达性不可信
  const proc = backend && backend.proc ? backend.proc : null;
  const startBtn = $("p-start"), stopBtn = $("p-stop");
  // 启动等待收尾（2026-10-08 三态扩展）：
  //  · 观测到 reachable（且中继在线）→ 就绪收尾；
  //  · 中继不可达 → 结束等待（无法确认），文案改「已受理，待中继恢复确认」；
  //  · 服务端权威失败（lastStartResult.ok=false 且晚于本次等待起点）→ 失败收尾，不等 120s。
  const justReady = svcStarting && reachable;
  if (justReady) endSvcStart();
  else if (svcStarting && relayDown) {
    endSvcStart();
    svcNoteMsg = "已受理，待中继恢复确认。";
    svcNoteRelay = true;
    showSvcRetry();
  } else if (svcStarting && proc && !relayDown) {
    const lr = proc.lastStartResult;
    const lrAt = lr && lr.at ? Date.parse(lr.at) : NaN;
    if (lr && lr.ok === false && Number.isFinite(lrAt) && lrAt >= svcStartAt - 2000) {
      svcFail("启动失败：" + (lr.error || "服务端报告启动未成功"));
    }
  }
  if (reachable) { svcNoteMsg = ""; svcNoteRelay = false; hideSvcRetry(); }
  else if (!relayDown && svcNoteRelay) { svcNoteMsg = ""; svcNoteRelay = false; hideSvcRetry(); } // 中继已恢复：撤下「待中继恢复确认」
  if (!svcBusy) {
    if (relayDown) {
      // ① 中继不可达：启动/停止都送不到中继 → 双收，由「重启中继」负责恢复
      startBtn.style.display = "none";
      stopBtn.style.display = "none";
      startBtn.disabled = false;
      startBtn.textContent = "启动服务";
      startBtn.title = "中继不可达：先「重启中继」，再启动服务";
    } else {
      startBtn.style.display = reachable ? "none" : "";
      stopBtn.style.display = reachable ? "" : "none";
      stopBtn.disabled = false;
      if (svcStarting && !reachable) { // 持久「启动中」：按钮保持禁用，待就绪/失败/超时收尾
        startBtn.disabled = true;
        startBtn.textContent = "启动中…";
      } else {
        startBtn.disabled = false;
        startBtn.textContent = "启动服务";
      }
      const hasInstall = !!(proc && (proc.install || proc.python || proc.mainPy));
      startBtn.title = hasInstall
        ? `启动 ComfyUI：${proc.python || proc.mainPy || ""}`
        : "按本机安装探测结果拉起 ComfyUI（由计划任务以当前用户身份起，独立于 Hana 存活）";
    }
  }

  const svcBits = [];
  if (proc) {
    if (proc.install) svcBits.push(`安装根 ${proc.install}`);
    if (reachable && Array.isArray(proc.pids) && proc.pids.length) svcBits.push(`监听进程 ${proc.pids.join(", ")}`);
    const stamp = (iso) => String(iso).replace("T", " ").slice(0, 19);
    if (proc.startedAt) svcBits.push(reachable ? `本 App 拉起于 ${stamp(proc.startedAt)}` : `上次由本 App 拉起：${stamp(proc.startedAt)}`);
    if (!reachable && proc.lastStop && proc.lastStop.at) svcBits.push(`上次停止：${stamp(proc.lastStop.at)}`);
  }
  // 常规详情（boot.note + 安装根/监听进程/拉起时间等）→ 折叠区底部 p-detail（不再占按钮区）
  $("p-detail").textContent = [boot.note || "", svcBits.join(" · ")].filter(Boolean).join("\n");
  // p-note：仅操作反馈（启动等待/失败/已运行/停止结果等即时消息）；无消息 → 清空并隐藏
  if (justReady) {
    setNote("ComfyUI 服务已就绪。");
  } else if (svcStarting) {
    // 等待就绪中：note 由秒表维护（renderSvcWaitNote），此处不覆盖
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
    render(st);
  } catch (e) {
    if (!svcStarting) setNote("状态读取失败：" + String((e && e.message) || e)); // 等待态由秒表维护，不覆盖
  }
}

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

// ── 折叠区开合记忆（状态区/监视器均默认折叠；选择记忆到 localStorage，各工作区共享一份）──
function bindFold(id, key, onToggle) {
  const el = $(id);
  try { el.open = localStorage.getItem(key) === "1"; } catch { /* 忽略 */ }
  el.addEventListener("toggle", () => {
    try { localStorage.setItem(key, el.open ? "1" : "0"); } catch { /* 忽略 */ }
    if (onToggle) onToggle();
  });
}
bindFold("fold-status", "comfyui-hana.panel.statusOpen");
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
const SVC_START_TIMEOUT_MS = 120_000;
const SVC_START_NOTE = "已请求启动 ComfyUI 服务，等待就绪（首次约 30～90 秒）…";

function setSvcBusy(on, label) {
  svcBusy = on;
  const btn = label && label.indexOf("停") === 0 ? $("p-stop") : $("p-start");
  if (on) { btn.disabled = true; btn.textContent = label || "处理中…"; }
  else { btn.textContent = btn.id === "p-stop" ? "停止服务" : "启动服务"; pollBurst(); } // 起停请求收尾：快速轮询波
}

function showSvcRetry() { $("p-note-actions").style.display = ""; }
function hideSvcRetry() { $("p-note-actions").style.display = "none"; }

function renderSvcWaitNote() {
  const secs = Math.max(0, Math.round((Date.now() - svcStartAt) / 1000));
  // 叠加服务端权威字段（2026-10-08）：proc.starting=true 说明启动确在途，等待可继续放心
  const proc = lastStatus && lastStatus.relay && lastStatus.relay.backend ? lastStatus.relay.backend.proc : null;
  setNote(`${SVC_START_NOTE}\n已等待 ${secs} 秒${proc && proc.starting === true ? "（服务端标记：启动中）" : ""}`);
}

function endSvcStart() {
  svcStarting = false;
  if (svcWaitTimer) { clearInterval(svcWaitTimer); svcWaitTimer = null; }
}

function svcFail(msg) {
  endSvcStart();
  svcNoteMsg = msg;
  setNote(msg);
  const btn = $("p-start");
  btn.disabled = false;
  btn.textContent = "启动服务";
  showSvcRetry();
}

function svcWaitTick() {
  if (!svcStarting) return;
  if (Date.now() - svcStartAt >= SVC_START_TIMEOUT_MS) {
    // 超时文案按态区分（2026-10-08，P5 三态）
    const st = lastStatus || {};
    const relayDown = st.relayError != null;
    const proc = st.relay && st.relay.backend ? st.relay.backend.proc : null;
    if (relayDown) svcFail("启动超时：已等待 120 秒，中继不可达，无法确认服务状态（可尝试「重启中继」）。");
    else if (proc && proc.starting === true) svcFail("启动超时：已等待 120 秒，服务端仍标记「启动中」（稍后可用状态复查）。");
    else svcFail("启动超时：已等待 120 秒，服务仍未就绪。");
    return;
  }
  renderSvcWaitNote();
}

async function startService() {
  if (svcBusy || svcStarting) return;
  svcBusy = true;
  svcStarting = true;
  svcStartAt = Date.now();
  svcNoteMsg = "";
  svcNoteRelay = false;
  hideSvcRetry();
  const startBtn = $("p-start");
  startBtn.disabled = true;
  startBtn.textContent = "启动中…";
  renderSvcWaitNote();
  if (svcWaitTimer) clearInterval(svcWaitTimer);
  svcWaitTimer = setInterval(() => { svcWaitTick(); }, 1000);
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
  if (st.before) $("u-local").textContent = st.after ? `${fmtVer(st.before)} → ${fmtVer(st.after)}` : fmtVer(st.before);
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
  void silentUpdateCheck(); // 信号灯：启动静默查一次更新（失败不打扰）
  setInterval(() => { void silentUpdateCheck(); }, 10 * 60_000); // …此后每 10 分钟一次
  document.addEventListener("visibilitychange", () => { // 页面由不可见转可见（回到工作区）：静默再查一次
    if (document.visibilityState === "visible") void silentUpdateCheck();
  });
}
void main();
