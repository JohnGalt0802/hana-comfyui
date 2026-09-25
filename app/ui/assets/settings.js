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

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  void loadInstall();
  void loadAutoStart();
  setInterval(() => { void poll(); }, 3000);
  setInterval(() => { void loadInstall(); }, 20000);
}
void main();
