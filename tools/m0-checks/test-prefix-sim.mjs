// M0 本地预演：模拟"宿主代理前缀剥离"链（host-sim → 中继 → ComfyUI 8188）
// 覆盖：HTTP 穿透、前端 index.html 相对寻址证据、/_surface 防御清理、WS 经剥前缀链路
import { spawn } from "node:child_process";

const RELAY_PORT = 39251;
const SIM_PORT = 39252;
const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const SIM = "D:\\HanakoWorks\\ComfyUI\\tools\\m0-checks\\host-sim.mjs";
const PREFIX = `http://127.0.0.1:${SIM_PORT}/api/apps/comfyui-hana/routes/_runtime/r1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };

function startChild(args, tag) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.__log = "";
  child.stdout.on("data", (c) => { child.__log += c.toString("utf8"); });
  child.stderr.on("data", (c) => { child.__log += c.toString("utf8"); });
  return child;
}

async function waitFor(child, needle, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.__log.includes(needle)) return true;
    await sleep(100);
  }
  return false;
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") };
}

async function wsOnce(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, why: "timeout" }); }, 10000);
    ws.addEventListener("message", (ev) => {
      let type = "?";
      try { type = JSON.parse(ev.data).type; } catch {}
      if (type === "status") {
        clearTimeout(timer);
        ws.close(1000, "done");
        resolve({ ok: true, why: "status" });
      }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); resolve({ ok: false, why: String(e && e.message || e) }); });
  });
}

async function main() {
  const relay = startChild([RELAY, "--standalone", "--port", String(RELAY_PORT), "--backend", "127.0.0.1:8188"], "relay");
  if (!(await waitFor(relay, "COMFY_RELAY_READY"))) { console.log("relay not ready\n" + relay.__log); process.exit(2); }
  const sim = startChild([SIM, String(SIM_PORT), String(RELAY_PORT)], "sim");
  if (!(await waitFor(sim, "host-sim listening"))) { console.log("sim not ready\n" + sim.__log); process.exit(2); }
  console.log(`relay:${RELAY_PORT}  sim:${SIM_PORT}  ready`);

  const directQueue = await get("http://127.0.0.1:8188/api/queue");
  const viaSim = await get(`${PREFIX}/api/queue`);
  check("剥前缀链路 GET /api/queue 200", viaSim.status === 200, `status=${viaSim.status}`);
  check("剥前缀链路 body 与直连一致", viaSim.text === directQueue.text);

  const sysStats = await get(`${PREFIX}/system_stats`);
  check("剥前缀链路 GET /system_stats 200", sysStats.status === 200, `status=${sysStats.status} len=${sysStats.text.length}`);

  const idx = await get(`${PREFIX}/`);
  const relAsset = /src="\.\/assets\/index-[^"]+\.js"/.test(idx.text) || /href="\.\/assets\//.test(idx.text);
  check("剥前缀链路 GET / 返回 ComfyUI 前端 HTML", idx.status === 200 && idx.text.includes("<title>ComfyUI</title>"), `status=${idx.status} len=${idx.text.length}`);
  check("前端 index.html 使用相对寻址（./assets/… 模块入口）", relAsset);

  const assetHref = (idx.text.match(/src="\.\/(assets\/[^"]+\.js)"/) || [])[1] || "assets/index-CKO20XHW.js";
  const asset = await get(`${PREFIX}/${assetHref}`);
  check(`静态资源经剥前缀链路可取（/${assetHref}）`, asset.status === 200 && asset.text.length > 1000, `status=${asset.status} len=${asset.text.length}`);

  const surface = await get(`${PREFIX}/_surface/credential-token-abc/api/queue`);
  check("未剥离的 /_surface/ 凭证段被中继防御性清理后仍 200", surface.status === 200, `status=${surface.status}`);

  const q = await get(`${PREFIX}/api/queue?appSurfaceSession=tok-123&x=1`);
  check("凭证查询参数被清理且其余查询串保留（200）", q.status === 200, `status=${q.status}`);

  const ws = await wsOnce(`ws://127.0.0.1:${SIM_PORT}/api/apps/comfyui-hana/routes/_runtime/r1/ws`);
  check("WS 经剥前缀全链路收到 status 消息", ws.ok, ws.why);

  await sleep(300);
  relay.kill("SIGKILL"); sim.kill("SIGKILL");
  console.log("\n---- relay log ----");
  console.log(relay.__log.trim());
  console.log("---- sim log ----");
  console.log(sim.__log.trim());

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
