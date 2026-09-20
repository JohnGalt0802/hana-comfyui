// ui/assets/settings.js — 设置页（v0 只读：现状展示 + 说明）
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

async function poll() {
  try {
    const r = await hana.api.fetch("/comfyui-hana/status", { cache: "no-store" });
    const st = await r.json();
    const boot = st.boot || {};
    const relay = st.relay || null;
    const backend = relay && relay.backend ? relay.backend : null;
    $("s-backend").textContent = st.backendUrl || "127.0.0.1:8188";
    $("s-reachable").innerHTML = backend
      ? (backend.reachable ? '<span class="chip ok">可达</span>' : `<span class="chip bad">不可达</span>`)
      : '<span class="chip">未知（快照未就绪）</span>';
    const port = boot.service && boot.service.port ? boot.service.port : "—";
    $("s-relay").textContent = `${boot.phase || "?"} · 端口 ${port}${relay && relay.relay ? ` · ${relay.relay.mode}` : ""}`;
    $("s-version").textContent = (st.app && st.app.version) || "—";
  } catch (e) {
    $("s-reachable").innerHTML = `<span class="chip bad">读取失败</span>`;
  }
}

async function main() {
  syncTheme();
  try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 忽略 */ }
  try { await hana.ready(); } catch { /* 忽略 */ }
  void poll();
  setInterval(() => { void poll(); }, 3000);
}
void main();
