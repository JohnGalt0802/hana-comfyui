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

// ── 剪贴板三级回落 ───────────────────────────────────────────────────────────
// 设置页 iframe 没有宿主剪贴板写授权（sdk 的 clipboard 能力必失败），
// 也不在安全上下文时 navigator.clipboard 可能被拒，所以依次退到 execCommand，再退到页面展开。
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* 权限拒绝或非安全上下文 → 下一级 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    if (!(document.execCommand && document.execCommand("copy"))) throw new Error("execCommand 复制失败");
  } finally {
    ta.remove();
  }
}

// 最后兜底：把要复制的文本展开成按钮下方的只读框并全选，让人手动 Ctrl+C。
function revealForManualCopy(btn, text) {
  document.querySelectorAll("textarea.s-copy-reveal").forEach((el) => el.remove());
  const ta = document.createElement("textarea");
  ta.readOnly = true;
  ta.className = "s-copy-reveal";
  ta.value = text;
  ta.style.cssText = "width:min(720px,100%);min-height:6em;margin-top:6px;white-space:pre-wrap;font:12px/1.5 monospace;";
  (btn && btn.parentNode ? btn : document.body).insertAdjacentElement("afterend", ta);
  ta.focus();
  ta.select();
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

// ── LLM 网关设置（v0.22.0，2026-11-02）─────────────────────────────
// 展示接入地址/token，选默认与视觉模型；保存即写盘+重推中继，立即生效。
// 模型选项全部来自后端 GET 返回的 models[].id，不写死任何模型名。
let gwModels = []; // [{id, provider, modelId}]

function gwTokenShort(t) {
  const s = String(t || "");
  if (!s) return "—";
  return s.length <= 14 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function gwFillSelect(sel, cur, disabled) {
  if (!sel) return;
  sel.innerHTML = "";
  if (disabled) {
    sel.disabled = true;
    const o = document.createElement("option");
    o.textContent = "（模型目录不可用）";
    sel.appendChild(o);
    return;
  }
  sel.disabled = false;
  const ids = gwModels.map((m) => m.id);
  const opts = ids.includes(cur) || !cur ? ids : [cur, ...ids]; // 当前值不在目录里也展示出来，让人看到再改
  for (const id of opts) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    if (id === cur) o.selected = true;
    sel.appendChild(o);
  }
  if (!cur && ids.length) sel.value = ids[0];
}

// ── 暴露给 ComfyUI 的模型（复选清单 + 搜索过滤 + 全选/清空）──────────────
function gwExposeSelected() {
  return [...document.querySelectorAll("#s-gw-expose-list input[type=checkbox]:checked")].map((c) => c.value);
}

function gwRenderExpose(checkedIds) {
  const box = $("s-gw-expose-list");
  if (!box) return;
  const kw = (($("s-gw-expose-filter") || {}).value || "").trim().toLowerCase();
  const checked = new Set(Array.isArray(checkedIds) ? checkedIds : gwExposeSelected());
  box.innerHTML = "";
  const ids = gwModels.map((m) => m.id);
  if (!ids.length) {
    box.textContent = "（模型目录不可用，无可勾选模型）";
    return;
  }
  let shown = 0;
  for (const id of ids) {
    if (kw && !id.toLowerCase().includes(kw)) continue;
    shown++;
    const lab = document.createElement("label");
    lab.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = id;
    cb.checked = checked.has(id);
    const span = document.createElement("span");
    span.textContent = id;
    span.title = id;
    lab.appendChild(cb);
    lab.appendChild(span);
    box.appendChild(lab);
  }
  if (!shown) box.textContent = "（无匹配模型）";
}

async function loadGateway() {
  try {
    const { data } = await apiJson("/comfyui-hana/llm-gateway");
    if (!data || !data.ok) {
      setMsg("s-gw-msg", `读取失败：${(data && data.error) || "未知原因"}`, "bad");
      return;
    }
    gwModels = Array.isArray(data.models) ? data.models : [];
    $("s-gw-base").textContent = data.baseUrl || "—";
    $("s-gw-token").textContent = gwTokenShort(data.token);
    const noCatalog = !gwModels.length;
    gwFillSelect($("s-gw-default"), data.defaultModel || null, noCatalog);
    gwFillSelect($("s-gw-vision"), data.visionModel || null, noCatalog);
    gwRenderExpose(Array.isArray(data.exposeModels) ? data.exposeModels : []); // 空数组 → 全不勾
    if (noCatalog) {
      setMsg("s-gw-msg", data.catalogError
        ? `模型目录不可用：${data.catalogError}`
        : "模型目录为空（宿主没有可用模型），无法选择。", "bad");
    }
  } catch (e) {
    setMsg("s-gw-msg", `读取失败：${String((e && e.message) || e)}`, "bad");
  }
}

$("s-gw-copy-url").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const t = $("s-gw-base").textContent || "";
  if (!t || t === "—") return;
  try { await copyText(t); setMsg("s-gw-msg", "接入地址已复制。", "ok"); }
  catch { revealForManualCopy(btn, t); setMsg("s-gw-msg", "已展开文本，请手动复制。", ""); }
});

$("s-gw-copy-token").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  // 页面上只展示截断形态，复制时用最近一次 GET 拿到的全文
  let full = null;
  try {
    const { data } = await apiJson("/comfyui-hana/llm-gateway");
    full = data && data.token;
    if (!full) { setMsg("s-gw-msg", "token 不可用。", "bad"); return; }
    await copyText(full);
    setMsg("s-gw-msg", "token 已复制（全文）。", "ok");
  } catch (e) {
    if (full) { revealForManualCopy(btn, full); setMsg("s-gw-msg", "已展开文本，请手动复制。", ""); }
    else setMsg("s-gw-msg", `复制失败：${String((e && e.message) || e)}`, "bad");
  }
});

// 搜索过滤 / 全选 / 清空（列表元素在每次渲染时重建，事件只在控件层绑一次）
if ($("s-gw-expose-filter")) $("s-gw-expose-filter").addEventListener("input", () => gwRenderExpose());
if ($("s-gw-expose-all")) $("s-gw-expose-all").addEventListener("click", () => {
  document.querySelectorAll("#s-gw-expose-list input[type=checkbox]").forEach((c) => { c.checked = true; });
});
if ($("s-gw-expose-none")) $("s-gw-expose-none").addEventListener("click", () => {
  document.querySelectorAll("#s-gw-expose-list input[type=checkbox]").forEach((c) => { c.checked = false; });
});

$("s-gw-save").addEventListener("click", async () => {
  setMsg("s-gw-msg", "保存中…", "");
  const def = $("s-gw-default").value || null;
  const vis = $("s-gw-vision").value || null;
  const expose = gwExposeSelected();
  try {
    const { data } = await apiJson("/comfyui-hana/llm-gateway", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: def, visionModel: vis, exposeModels: expose }),
    });
    if (!data || !data.ok) {
      setMsg("s-gw-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
      return;
    }
    // 以服务端确认后的值为准回填（含别名映射后的归一）
    gwFillSelect($("s-gw-default"), data.defaultModel || null, !gwModels.length);
    gwFillSelect($("s-gw-vision"), data.visionModel || null, !gwModels.length);
    const okLine = data.pushed ? "已保存，立即生效" : `已保存，待生效${data.note ? `：${data.note}` : ""}`;
    const syncLine = data.pluginSync && data.pluginSync.ok === false && data.pluginSync.reason
      ? `；插件同步失败：${data.pluginSync.reason}` : "";
    setMsg("s-gw-msg", okLine + syncLine, data.pushed ? "ok" : "");
    const btn = $("s-gw-restart");
    if (btn) btn.style.display = data.restartRequired ? "" : "none";
  } catch (e) {
    setMsg("s-gw-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
  }
});

$("s-gw-restart").addEventListener("click", async () => {
  const btn = $("s-gw-restart");
  if (!btn) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "重启中…";
  setMsg("s-gw-msg", "正在同步并重启 ComfyUI…", "");
  try {
    const { data } = await apiJson("/comfyui-hana/llm-gateway/restart-comfy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!data || !data.ok) {
      setMsg("s-gw-msg", `重启失败：${(data && data.error) || "未知原因"}`, "bad");
      return;
    }
    setMsg("s-gw-msg", `已重启，节点下拉更新。${data.note || ""}`, "ok");
    btn.style.display = "none";
  } catch (e) {
    setMsg("s-gw-msg", `重启失败：${String((e && e.message) || e)}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
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
  // 不硬编码具体解码器名（issue #1）：不同模型族对应不同解码器，写死某一个会把人引到错误文件。
  // 接口总会带 filename；拿不到就如实说不知道，让人回设置页刷新，不要偷摸着猜一个。
  const file = (previewModelInfo && previewModelInfo.filename)
    || "（未知：请先刷新设置页，或在 GET /comfyui-hana/preview-decoders 按当前模型族选定）";
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

// 「请 Agent 下载」：设置页 iframe 既无宿主剪贴板授权，emit 也只在卡片槽位可达会话，
// 两条原路都必败；主路改走后端 ask-agent（建新会话投递），失败再退前端复制 / 展开文本。
$("s-preview-agent-get").addEventListener("click", async () => {
  if (!previewModelInfo) await loadPreviewModel();
  const text = previewGuideText();
  const dir = (previewModelInfo && previewModelInfo.targetDir) || "<ComfyUI>/models/vae_approx";
  const filename = (previewModelInfo && previewModelInfo.filename) || "（未知，请按指引刷新选定）";
  const request = `（这条消息由用户在 hui 设置页点「请 Agent 下载」发起。）\n请用 hana-downloader 下载 ComfyUI 预览模型 ${filename} 到 ${dir}。\n下载指引与镜像源：\n${text}`;
  try {
    const { data } = await apiJson("/comfyui-hana/ask-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request, title: "hui 预览模型下载请求" }),
    });
    if (data && data.ok) {
      setMsg("s-preview-model-msg", data.truncated ? "已发到新会话（指引超长被截断），agent 会开始下载。" : "已发到新会话，agent 会开始下载。", "ok");
      return;
    }
    throw new Error((data && data.error) || "未知错误");
  } catch (e) {
    const reason = String((e && e.message) || e);
    try {
      await copyText(text);
      setMsg("s-preview-model-msg", `无法直接通知会话（${reason}），指引已复制，粘给任意会话即可让 agent 代办。`, "");
    } catch {
      revealForManualCopy($("s-preview-agent-get"), text);
      setMsg("s-preview-model-msg", `无法直接通知会话（${reason}），已展开文本，请手动复制。`, "bad");
    }
  }
});

$("s-preview-copy").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  if (!previewModelInfo) await loadPreviewModel();
  const text = previewGuideText();
  try {
    await copyText(text);
    setMsg("s-preview-model-msg", "下载指引已复制。", "ok");
  } catch {
    revealForManualCopy(btn, text);
    setMsg("s-preview-model-msg", "已展开文本，请手动复制。", "");
  }
});

// ── 启动参数（issue #2 P1，2026-10-21）─────────────────────────────────
// 为什么需要：用户往往已有自己的 bat（带 --windows-standalone-build、代理环境变量）。
// App「启动服务」自己生成启动器，先前拿不到这些配置 → 同一个 ComfyUI 两边行为不一致。
// 说明：区块 DOM 在本文件里建（本次只允许改 comfy-relay.mjs / index.js / settings.js），
// 样式全部复用 settings.html 已有 class（.sec/.ed/.msg/.note/code），不另造视觉。
function buildLaunchSection() {
  const sec = document.createElement("div");
  sec.className = "sec";
  sec.id = "s-launch-sec";

  const h2 = document.createElement("h2");
  h2.textContent = "启动参数";

  const note1 = document.createElement("p");
  note1.className = "note";
  note1.textContent = "给 App 拉起的 ComfyUI 进程追加参数与环境变量，让你那套 bat 的配置在这里也能生效。留空即恢复默认（不加参数、不改环境）。";

  const k1 = document.createElement("div");
  k1.className = "k";
  k1.style.marginTop = "10px";
  k1.textContent = "额外启动参数";

  const row1 = document.createElement("div");
  row1.className = "ed";
  const extra = document.createElement("input");
  extra.type = "text";
  extra.id = "s-launch-args";
  extra.placeholder = "--windows-standalone-build";
  extra.spellcheck = false;
  extra.autocomplete = "off";
  row1.appendChild(extra);

  const k2 = document.createElement("div");
  k2.className = "k";
  k2.style.marginTop = "12px";
  k2.textContent = "启动前环境变量";

  const row2 = document.createElement("div");
  row2.className = "ed";
  const env = document.createElement("textarea");
  env.id = "s-launch-env";
  env.rows = 4;
  env.spellcheck = false;
  env.placeholder = "HTTP_PROXY=http://127.0.0.1:7890\nHTTPS_PROXY=http://127.0.0.1:7890";
  // 与 .ed input[type=text] 同一套观感（同边框/底色/圆角/字号），只多出多行与等宽布局
  env.style.cssText = "flex:1;min-width:220px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;padding:6px 10px;border-radius:8px;color:var(--text);border:0.5px solid var(--border);background:rgba(127,127,127,.08);resize:vertical;box-sizing:border-box;";
  row2.appendChild(env);

  const note2 = document.createElement("p");
  note2.className = "note";
  note2.textContent = "每行一条 KEY=VALUE（以第一个 = 切分，所以值里可以带 =）。国内网络通常要设 HTTP_PROXY / HTTPS_PROXY，否则 Manager 装节点、下载模型会失败。";

  const row3 = document.createElement("div");
  row3.className = "ed";
  const save = document.createElement("button");
  save.className = "primary";
  save.id = "s-launch-save";
  save.textContent = "保存";
  row3.appendChild(save);

  const msg = document.createElement("div");
  msg.className = "msg";
  msg.id = "s-launch-msg";

  const note3 = document.createElement("p");
  note3.className = "note";
  note3.id = "s-launch-hint";
  note3.innerHTML = "保存后<b>需重启服务才生效</b>：这些参数要等启动器（<code>backend-launcher.cmd</code>）重新生成时才写进去，而启动器只在点「启动服务」那一刻生成。已在跑的 ComfyUI 不会因保存而改变；想用上就先「停止服务」再「启动服务」。";

  sec.append(h2, note1, k1, row1, k2, row2, note2, row3, msg, note3);
  return sec;
}

const launchSecAnchor = $("s-preview-save-msg")?.closest(".sec") || null;
const launchSec = buildLaunchSection();
if (launchSecAnchor && launchSecAnchor.parentNode) {
  launchSecAnchor.parentNode.insertBefore(launchSec, launchSecAnchor.nextSibling);
} else {
  document.body.appendChild(launchSec);
}

async function loadLaunch() {
  try {
    const { data } = await apiJson("/comfyui-hana/launch-settings");
    if (data && data.ok) {
      $("s-launch-args").value = data.extraArgs || "";
      $("s-launch-env").value = typeof data.envText === "string"
        ? data.envText
        : (Array.isArray(data.env) ? data.env.map((e) => `${e.k}=${e.v}`).join("\n") : "");
    }
  } catch { /* 忽略 */ }
}

$("s-launch-save").addEventListener("click", async () => {
  const extraArgs = ($("s-launch-args").value || "").trim();
  const envText = $("s-launch-env").value || "";
  setMsg("s-launch-msg", "保存中…", "");
  try {
    const { data } = await apiJson("/comfyui-hana/launch-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extraArgs, env: envText }),
    });
    if (!data || !data.ok) {
      // 中继校验逐项点名（如「环境变量第 2 项：KEY「2BAD」不是合法环境变量名」），原样展示
      setMsg("s-launch-msg", `保存失败：${(data && data.error) || "未知原因"}`, "bad");
      return;
    }
    if (Array.isArray(data.env)) {
      $("s-launch-env").value = data.env.map((e) => `${e.k}=${e.v}`).join("\n");
    }
    setMsg("s-launch-msg", data.pushed
      ? "已保存，需重启服务生效（启动器在点「启动服务」时才生成）"
      : `已保存${data.note ? `：${data.note}` : ""}；重启服务生效`, data.pushed ? "ok" : "");
  } catch (e) {
    setMsg("s-launch-msg", `保存失败：${String((e && e.message) || e)}`, "bad");
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
  void loadAllowWrite();
  void loadAllowCopilot();
  void loadPreview();
  void loadGateway();
  void loadLaunch();
  setInterval(() => { void poll(); }, 3000);
  setInterval(() => { void loadInstall(); }, 20000);
}
void main();
