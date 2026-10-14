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

// ── 画布授权开关（2026-10-08：补齐 allow-write 链 + 新增副驾驶总闸）────────────────
// 说明：M12-P3 引入「允许 agent 修改画布」时只加了 HTML 与 main() 调用，JS 实现漏了
// （loadAllowWrite 未定义 → main() 在此抛 ReferenceError、轮询注册被中断）。本批一并修复。
async function loadAllowWrite() {
  try {
    const { data } = await apiJson("/comfyui-hana/allow-write");
    $("s-allow-write").checked = !!(data && data.enabled);
  } catch { /* 忽略 */ }
}

$("s-allow-write").addEventListener("change", async () => {
  const want = $("s-allow-write").checked;
  setMsg("s-aw-msg", "保存中…", "");
  try {
    const { data } = await apiJson("/comfyui-hana/allow-write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: want }),
    });
    if (!data || !data.ok) {
      $("s-allow-write").checked = !want;
      setMsg("s-aw-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
    } else {
      setMsg("s-aw-msg", want ? "已开启（即时生效）" : "已关闭", "ok");
    }
  } catch (e) {
    $("s-allow-write").checked = !want;
    setMsg("s-aw-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
  }
});

async function loadAllowCopilot() {
  try {
    const { data } = await apiJson("/comfyui-hana/allow-copilot");
    $("s-allow-copilot").checked = !!(data && data.enabled);
  } catch { /* 忽略 */ }
}

$("s-allow-copilot").addEventListener("change", async () => {
  const want = $("s-allow-copilot").checked;
  setMsg("s-ac-msg", "保存中…", "");
  try {
    const { data } = await apiJson("/comfyui-hana/allow-copilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: want }),
    });
    if (!data || !data.ok) {
      $("s-allow-copilot").checked = !want;
      setMsg("s-ac-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
    } else {
      setMsg("s-ac-msg", want ? "已开启（即时生效）" : "已关闭", "ok");
    }
  } catch (e) {
    $("s-allow-copilot").checked = !want;
    setMsg("s-ac-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
  }
});

// ── 出图实时预览（2026-10-13：默认关 / 两级档位）──────────────────────────
// 真相源在后端（preview-settings.json），生效值经中继下发。
// 下载入口不是「点了就下」：app 侧无外网白名单 + 无 ComfyUI 目录写权，/preview-model/download
// 恒回 needAgent；UI 只展示指引，由用户点「请 Agent 下载」把请求回传给会话。
let previewEnabled = false;
let previewTier = "basic";
let previewModelInfo = null; // {filename, targetDir, sources, note}

function renderPreview() {
  $("s-preview-tier-wrap").style.display = previewEnabled ? "" : "none";
  const radios = document.querySelectorAll('input[name="s-preview-tier"]');
  radios.forEach((r) => { r.checked = r.value === previewTier; r.disabled = !previewEnabled; });
  const hd = previewEnabled && previewTier === "hd";
  $("s-preview-hd").style.display = hd ? "" : "none";
  if (hd) void loadPreviewModel();
}

async function loadPreview() {
  try {
    const { data } = await apiJson("/comfyui-hana/preview-settings");
    if (data && data.ok) {
      previewEnabled = !!data.enabled;
      previewTier = data.tier === "hd" ? "hd" : "basic";
      $("s-preview-enabled").checked = previewEnabled;
    }
  } catch { /* 忽略 */ }
  renderPreview();
}

async function postPreview(body) {
  return apiJson("/comfyui-hana/preview-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 取模型获取指引（非下载执行）：targetDir / sources / note
async function loadPreviewModel() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/preview-model/download", { method: "POST", cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (data) previewModelInfo = data;
    $("s-preview-model-dir").innerHTML = data && data.targetDir
      ? `<code>${esc(data.targetDir)}</code>`
      : '<span class="chip bad">未知（未检测到安装目录）</span>';
  } catch (e) {
    $("s-preview-model-dir").innerHTML = '<span class="chip bad">读取失败</span>';
  }
}

function previewGuideText() {
  const dir = (previewModelInfo && previewModelInfo.targetDir) || "<ComfyUI>/models/vae_approx";
  const file = (previewModelInfo && previewModelInfo.filename) || "taeqi2_1_decoder.pth";
  const srcs = (previewModelInfo && Array.isArray(previewModelInfo.sources)) ? previewModelInfo.sources : [];
  const list = srcs.map((s) => `- ${s.name}: ${s.url}${s.caution ? `（${s.caution}）` : ""}`).join("\n");
  return `请下载 ComfyUI 预览模型 ${file} 到 ${dir}\n优先镜像源：\n${list}`;
}

$("s-preview-enabled").addEventListener("change", async () => {
  const want = $("s-preview-enabled").checked;
  setMsg("s-preview-save-msg", "保存中…", "");
  try {
    const { data } = await postPreview({ enabled: want });
    if (!data || !data.ok) {
      $("s-preview-enabled").checked = !want;
      setMsg("s-preview-save-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
      return;
    }
    previewEnabled = !!data.enabled;
    if (data.tier) previewTier = data.tier;
    renderPreview();
    setMsg("s-preview-save-msg", data.pushed ? "已生效" : `已存待生效${data.note ? `：${data.note}` : ""}`, data.pushed ? "ok" : "");
  } catch (e) {
    $("s-preview-enabled").checked = !want;
    setMsg("s-preview-save-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
  }
});

document.querySelectorAll('input[name="s-preview-tier"]').forEach((r) => {
  r.addEventListener("change", async () => {
    const want = r.value === "hd" ? "hd" : "basic";
    setMsg("s-preview-save-msg", "保存中…", "");
    try {
      const { data } = await postPreview({ tier: want });
      if (!data || !data.ok) {
        setMsg("s-preview-save-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
        renderPreview();
        return;
      }
      if (data.tier) previewTier = data.tier;
      renderPreview();
      setMsg("s-preview-save-msg", data.pushed ? "已生效" : `已存待生效${data.note ? `：${data.note}` : ""}`, data.pushed ? "ok" : "");
    } catch (e) {
      setMsg("s-preview-save-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
      renderPreview();
    }
  });
});

// 「请 Agent 下载」：照 workspace.js 的通知机制——没有现成的 agent 通知能力，
// 主路走 hana.emit 回传会话（仅 card slot 有效），失败/被拒时回落剪贴板复制指引。
$("s-preview-agent-get").addEventListener("click", async () => {
  if (!previewModelInfo) await loadPreviewModel();
  const text = previewGuideText();
  const dir = previewModelInfo && previewModelInfo.targetDir;
  try {
    const res = await hana.emit("preview-model-download-request", {
      filename: (previewModelInfo && previewModelInfo.filename) || "taeqi2_1_decoder.pth",
      targetDir: dir || null,
      message: `请下载 ComfyUI 预览模型 ${(previewModelInfo && previewModelInfo.filename) || "taeqi2_1_decoder.pth"} 到 ${dir || "<ComfyUI>/models/vae_approx"}`,
    });
    if (res && res.delivered) { setMsg("s-preview-model-msg", "已发回会话，agent 收到后会开始下载。", "ok"); return; }
    throw new Error("emit 未送达");
  } catch {
    try {
      await hana.clipboard.writeText(text);
      setMsg("s-preview-model-msg", "无法直接通知会话，下载指引已复制，粘给任意会话即可让 agent 代办。", "");
    } catch {
      setMsg("s-preview-model-msg", "无法通知会话，也无法复制。请手动转告 agent 下载指引。", "bad");
    }
  }
});

$("s-preview-copy").addEventListener("click", async () => {
  if (!previewModelInfo) await loadPreviewModel();
  try {
    await hana.clipboard.writeText(previewGuideText());
    setMsg("s-preview-model-msg", "下载指引已复制。", "ok");
  } catch { setMsg("s-preview-model-msg", "复制失败。", "bad"); }
});

// ── 启动 ──────────────────────────────────────────────────────────────────
async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  void loadInstall();
  void loadAutoStart();
  void loadAllowWrite();
  void loadAllowCopilot();
  void loadPreview();
  setInterval(() => { void poll(); }, 3000);
  setInterval(() => { void loadInstall(); }, 20000);
}
void main();
