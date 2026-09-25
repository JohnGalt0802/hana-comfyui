// ui/assets/settings.js — 设置页：安装目录 / 服务启动 / 连接状态
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

function setMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (kind ? ` ${kind}` : "");
}

async function apiJson(path, init) {
  const r = await hana.api.fetch(path, { cache: "no-store", ...(init || {}) });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, ok: r.ok, data };
}

// ── 连接状态 ──────────────────────────────────────────────────────────────
async function poll() {
  try {
    const { data: st } = await apiJson("/comfyui-hana/status");
    const boot = (st && st.boot) || {};
    const relay = (st && st.relay) || null;
    const backend = relay && relay.backend ? relay.backend : null;
    $("s-backend").textContent = (st && st.backendUrl) || "127.0.0.1:8188";
    $("s-reachable").innerHTML = backend
      ? (backend.reachable ? '<span class="chip ok">可达</span>' : '<span class="chip bad">不可达</span>')
      : '<span class="chip">未知（快照未就绪）</span>';
    const port = boot.service && boot.service.port ? boot.service.port : "—";
    $("s-relay").textContent = `${boot.phase || "?"} · 端口 ${port}${relay && relay.relay ? ` · ${relay.relay.mode}` : ""}`;
    $("s-version").textContent = (st && st.app && st.app.version) || "—";
  } catch {
    $("s-reachable").innerHTML = '<span class="chip bad">读取失败</span>';
  }
}

// ── 安装目录 ──────────────────────────────────────────────────────────────
function collectCandidates(d) {
  if (!d || typeof d !== "object") return [];
  const arr = Array.isArray(d.drives) ? d.drives : Array.isArray(d.candidates) ? d.candidates : [];
  return arr.slice(0, 8).map((x) => {
    if (typeof x === "string") return x;
    const p = x.path || x.root || x.dir || x.target || "";
    const free = x.freeGb ?? x.freeGB ?? x.free_gb;
    return p ? `${p}${typeof free === "number" ? `（剩 ${Math.round(free)}G）` : ""}` : "";
  }).filter(Boolean);
}

async function loadInstall() {
  // 当前实际使用的安装（中继侧探测结果）
  try {
    const { data: st } = await apiJson("/comfyui-hana/status");
    const relay = (st && st.relay) || {};
    const env = relay.env || null;
    const hit = env && Array.isArray(env.installs) && env.installs.length ? env.installs[0] : null;
    $("s-install-now").innerHTML = hit
      ? `<span class="chip ok">已检测</span> ${esc(hit.path)}${hit.version ? ` · v${esc(hit.version)}` : ""}${hit.kind ? ` · ${esc(hit.kind)}` : ""}${hit.hasVenv === false ? ' · <span class="chip bad">缺 venv</span>' : ""}`
      : '<span class="chip bad">未检测到</span>';
  } catch {
    $("s-install-now").innerHTML = '<span class="chip bad">读取失败</span>';
  }
  // 自定义位置 + 盘位候选
  try {
    const { data } = await apiJson("/comfyui-hana/install-targets");
    const custom = data && data.custom ? String(data.custom) : "";
    $("s-install-custom").textContent = custom || "未设置（用自动探测）";
    const input = $("s-install-input");
    if (custom && input && !input.value.trim()) input.value = custom;
    const cands = collectCandidates(data);
    $("s-install-cands").textContent = cands.length ? "盘位候选：" + cands.join("　") : "";
  } catch { /* 忽略 */ }
}

async function postInstallTarget(path) {
  return apiJson("/comfyui-hana/install-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

$("s-install-save").addEventListener("click", async () => {
  const p = ($("s-install-input").value || "").trim();
  if (!p) { setMsg("s-install-msg", "请填一个绝对路径（如 D:\\ComfyUI），或点「清除」恢复自动探测。", "bad"); return; }
  setMsg("s-install-msg", "保存中…", "");
  try {
    const { data } = await postInstallTarget(p);
    if (data && data.ok) { setMsg("s-install-msg", `已保存：${data.custom || p}`, "ok"); void loadInstall(); }
    else setMsg("s-install-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
  } catch (e) {
    setMsg("s-install-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
  }
});

$("s-install-clear").addEventListener("click", async () => {
  setMsg("s-install-msg", "清除中…", "");
  try {
    const { data } = await postInstallTarget("");
    if (data && data.ok) {
      setMsg("s-install-msg", "已清除，恢复自动探测。", "ok");
      $("s-install-input").value = "";
      void loadInstall();
    } else setMsg("s-install-msg", `清除失败：${(data && data.error) || "未知原因"}`, "bad");
  } catch (e) {
    setMsg("s-install-msg", `清除失败：${String((e && e.message) || e)}`, "bad");
  }
});

$("s-install-detect").addEventListener("click", () => {
  setMsg("s-install-msg", "已重新读取探测结果（中继侧有 15 秒缓存）。", "");
  void loadInstall();
  void poll();
});

// ── 服务自动拉起 ──────────────────────────────────────────────────────────
async function loadAutoStart() {
  try {
    const { data } = await apiJson("/comfyui-hana/auto-start");
    $("s-auto-start").checked = !!(data && data.enabled);
  } catch { /* 忽略 */ }
}

$("s-auto-start").addEventListener("change", async () => {
  const want = $("s-auto-start").checked;
  try {
    const { data } = await apiJson("/comfyui-hana/auto-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: want }),
    });
    if (!data || !data.ok) {
      $("s-auto-start").checked = !want;
      setMsg("s-install-msg", "", "");
    }
  } catch {
    $("s-auto-start").checked = !want;
  }
});

// ── ComfyUI 更新（M11）────────────────────────────────────────────────────
let updatePollTimer = null;
let updatePollUntil = 0;

function fmtVer(v) {
  if (!v) return "—";
  return `${v.describe || v.commit || "?"}${v.dirty ? "（有未提交改动）" : ""}`;
}

function renderUpdateCheck(d) {
  if (!d) return;
  if (d.isGit === false) {
    $("s-up-local").textContent = d.local ? fmtVer(d.local) : "—";
    $("s-up-remote").innerHTML = '<span class="chip">不适用</span>';
    setMsg("s-up-msg", d.note || "该安装不是 Git 仓库，App 无法代为更新。", "bad");
    return;
  }
  $("s-up-local").textContent = fmtVer(d.local);
  $("s-up-remote").textContent = fmtVer(d.remote);
  if (d.local && d.local.dirty) setMsg("s-up-msg", "本地有未提交改动，git 会拒绝拉取（不擅自 merge/reset）。", "bad");
  else if (d.upToDate) setMsg("s-up-msg", "已是最新，无待更新提交。", "ok");
  else setMsg("s-up-msg", `落后 ${d.behind} 个提交${d.ahead ? `（本地领先 ${d.ahead} 个）` : ""}。`, "ok");
}

async function checkUpdate(force) {
  setMsg("s-up-msg", "检查中（git fetch 可能需要几秒）…", "");
  try {
    const { data } = await apiJson(`/comfyui-hana/update${force ? "?force=1" : ""}`);
    if (!data || data.ok === false) { setMsg("s-up-msg", `检查失败：${(data && data.error) || "未知原因"}`, "bad"); return; }
    renderUpdateCheck(data);
  } catch (e) {
    setMsg("s-up-msg", `检查失败：${String((e && e.message) || e)}`, "bad");
  }
}

function renderUpdateStatus(st) {
  if (!st) return false;
  const phaseText = { idle: "空闲", stopping: "正在停服务", fetching: "抓取远端", pulling: "拉取更新", installing: "安装依赖", done: "已完成", failed: "失败" }[st.phase] || st.phase;
  $("s-up-state").innerHTML = st.running
    ? `<span class="chip">进行中</span> ${esc(phaseText)}`
    : (st.phase === "failed" ? '<span class="chip bad">失败</span>' : (st.phase === "done" ? '<span class="chip ok">已完成</span>' : esc(phaseText)));
  if (st.before) $("s-up-local").textContent = fmtVer(st.before);
  if (st.after) $("s-up-remote").textContent = `更新后 ${fmtVer(st.after)}`;
  const steps = (st.steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `：${String(s.detail).split("\n").slice(-1)[0]}` : ""}`);
  $("s-up-log").textContent = [...steps, ...(st.logTail || []).slice(-12)].filter(Boolean).join("\n");
  if (st.lastError) setMsg("s-up-msg", `更新失败：${st.lastError}`, "bad");
  else if (st.phase === "done") setMsg("s-up-msg", "更新完成。请到工作区点「启动服务」重新拉起 ComfyUI。", "ok");
  return !!st.running;
}

async function pollUpdateStatus() {
  try {
    const { data } = await apiJson("/comfyui-hana/update/status");
    const running = renderUpdateStatus(data);
    if (!running && updatePollTimer && Date.now() > updatePollUntil) stopUpdatePolling();
  } catch { /* 下一拍再试 */ }
}

function startUpdatePolling() {
  if (updatePollTimer) return;
  updatePollUntil = Date.now() + 30 * 60_000; // 上限 30 分钟（pip 可能很久）
  updatePollTimer = setInterval(() => { void pollUpdateStatus(); }, 2000);
  void pollUpdateStatus();
}
function stopUpdatePolling() {
  if (updatePollTimer) { clearInterval(updatePollTimer); updatePollTimer = null; }
}

$("s-up-check").addEventListener("click", () => { void checkUpdate(true); });
$("s-up-apply").addEventListener("click", async () => {
  setMsg("s-up-msg", "已发起更新（先停服务，随后 git pull + pip install）…", "");
  try {
    const { data } = await apiJson("/comfyui-hana/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "apply" }),
    });
    if (!data || data.accepted !== true) {
      setMsg("s-up-msg", `发起失败：${(data && (data.reason || data.error)) || "未知原因"}`, "bad");
      return;
    }
    startUpdatePolling();
    void loadInstall();
  } catch (e) {
    setMsg("s-up-msg", `发起失败：${String((e && e.message) || e)}`, "bad");
  }
});

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  void loadInstall();
  void loadAutoStart();
  void pollUpdateStatus();
  setInterval(() => { void poll(); }, 3000);
  setInterval(() => { void loadInstall(); }, 20000);
}
void main();
