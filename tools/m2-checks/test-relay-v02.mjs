// M2 本地实测：standalone 中继 v0.2 新端点（status/prompts/history/fs/upload/日志落盘/controlKey）
// 用法: node test-relay-v02.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39321;
const KEY = "m2-test-key-0123456789abcdef";
const LOGFILE = "D:\\HanakoWorks\\ComfyUI\\tools\\m2-checks\\logs\\relay-v02-test.log";
const TMPDIR = "D:\\HanakoWorks\\ComfyUI\\tools\\m2-checks\\logs";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(TMPDIR, { recursive: true });
try { if (existsSync(LOGFILE)) { writeFileSync(LOGFILE, ""); } } catch {}

function startRelay() {
  const child = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--log-file", LOGFILE, "--control-key", KEY], { stdio: ["ignore", "pipe", "pipe"] });
  child.__log = "";
  child.stdout.on("data", (c) => { child.__log += c.toString("utf8"); });
  child.stderr.on("data", (c) => { child.__log += c.toString("utf8"); });
  return child;
}
async function waitReady(child, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.__log.includes("COMFY_RELAY_READY")) return true;
    await sleep(100);
  }
  return false;
}
const base = `http://127.0.0.1:${PORT}`;
async function jget(p, headers = {}) {
  const r = await fetch(`${base}${p}`, { headers });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, data: d };
}
async function jpost(p, body, headers = {}) {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, data: d };
}

async function main() {
  const relay = startRelay();
  const ready = await waitReady(relay);
  check("中继 v0.2 standalone 就绪", ready, ready ? "" : relay.__log.slice(-500));
  if (!ready) { relay.kill("SIGKILL"); process.exit(1); }

  await sleep(800); // 等事件订阅连上

  // 1) status 新字段
  const st = await jget("/_relay/status");
  check("status 200 且含 logFile/events 字段",
    st.status === 200 && st.data?.relay?.logFile === LOGFILE && !!st.data?.events,
    `logFile=${st.data?.relay?.logFile} eventsConnected=${st.data?.events?.connected}`);
  check("事件订阅已连接（后端 /ws）", st.data?.events?.connected === true);

  // 2) prompts 端点
  const pr = await jget("/_relay/prompts");
  check("prompts 200 + ws.connected", pr.status === 200 && pr.data?.ok === true && pr.data?.ws?.connected === true);

  // 3) history 摘要
  const hist = await jget("/_relay/history?max=2");
  const histOk = hist.status === 200 && hist.data?.ok === true && Array.isArray(hist.data?.entries);
  check("history 摘要 200（数组、≤2 条）", histOk && hist.data.entries.length <= 2, `count=${hist.data?.entries?.length}`);

  // 4) 日志落盘
  await sleep(300);
  let logSize = 0;
  try { logSize = statSync(LOGFILE).size; } catch {}
  check("日志已落盘（>0 字节）", logSize > 0, `${logSize} B`);

  // 5) controlKey 门
  const noKey = await jpost("/_relay/fs/stat", { path: "D:\\ComfyUI\\ComfyUI\\comfyui_version.py" });
  check("fs/stat 无密钥 → 403", noKey.status === 403, `HTTP ${noKey.status}`);
  const badKey = await jpost("/_relay/fs/stat", { path: "D:\\ComfyUI\\ComfyUI\\comfyui_version.py" }, { "x-comfy-relay-key": "wrong-key-000000000000" });
  check("fs/stat 错误密钥 → 403", badKey.status === 403, `HTTP ${badKey.status}`);

  // 6) fs/stat + fs/read（正确密钥）
  const goodStat = await jpost("/_relay/fs/stat", { path: "D:\\ComfyUI\\ComfyUI\\comfyui_version.py" }, { "x-comfy-relay-key": KEY });
  check("fs/stat 正确密钥 → exists=true", goodStat.data?.stat?.exists === true, JSON.stringify(goodStat.data?.stat || null));
  const goodRead = await jpost("/_relay/fs/read", { path: "D:\\ComfyUI\\ComfyUI\\comfyui_version.py" }, { "x-comfy-relay-key": KEY });
  check("fs/read 文本读取", goodRead.data?.ok === true && /0\.37/.test(String(goodRead.data?.text || "")), `size=${goodRead.data?.size}`);

  // 7) prompts/<id> 404 语义（200 + found:false）
  const miss = await jget("/_relay/prompts/not-a-real-id");
  check("prompts/<id> 未知 id → found:false", miss.status === 200 && miss.data?.found === false);

  relay.kill("SIGKILL");
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
