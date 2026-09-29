// M13 本地实测：中继 /_relay/submit-file（大工作流直读直提，绕开宿主隧道 1M/4M 限制）
// 用法: node test-submit-file.mjs
// 前置：ComfyUI 服务在 127.0.0.1:8188 运行且队列为空（测试会真实提交，但均为极小纯 CPU 任务）
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39323;
const KEY = "m13-test-key-0123456789abcdef";
const LOGDIR = "D:\\HanakoWorks\\ComfyUI\\tools\\m13-checks\\logs";
const LOGFILE = LOGDIR + "\\relay-m13-test.log";
const BACKEND = "127.0.0.1:8188";
// ComfyUI userdata/workflows 物理目录候选（取存在的第一个；9/28 时间戳指向候选 1）
const WORKFLOWS_CANDIDATES = [
  "D:\\ComfyUI\\ComfyUI\\user\\default\\workflows",
  "D:\\ComfyUI\\user\\workflows",
];

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(LOGDIR, { recursive: true });

// ── 后端预检 ────────────────────────────────────────────────────────────────
async function backendAlive() {
  try { const r = await fetch(`http://${BACKEND}/system_stats`, { signal: AbortSignal.timeout(3000) }); return r.ok; }
  catch { return false; }
}
async function queueEmpty() {
  try {
    const r = await fetch(`http://${BACKEND}/queue`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    return (d.queue_running?.length ?? 0) === 0 && (d.queue_pending?.length ?? 0) === 0;
  } catch { return false; }
}

// ── 造测试文件 ──────────────────────────────────────────────────────────────
const bigPath = `${LOGDIR}\\big-ui-workflow.json`;
const smallApiPath = `${LOGDIR}\\small-api-workflow.json`;
const badPath = `${LOGDIR}\\not-json.txt`;

function makeBigUi() {
  const big = "X".repeat(4 * 1024 * 1024 + 600_000); // ~4.6MB 填充
  const wf = {
    last_node_id: 3,
    last_link_id: 1,
    nodes: [
      {
        id: 1, type: "EmptyImage", pos: [100, 100], size: [200, 100], flags: {}, order: 0, mode: 0,
        inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
        widgets_values: [64, 64, 1, 0],
      },
      {
        id: 2, type: "SaveImage", pos: [400, 100], size: [300, 200], flags: {}, order: 1, mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [],
        widgets_values: ["m13_big"],
      },
      {
        id: 3, type: "Note", pos: [100, 300], size: [300, 200], flags: {}, order: 2, mode: 0,
        widgets_values: [big],
      },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"]],
    groups: [], config: {}, extra: {}, version: 0.4,
  };
  writeFileSync(bigPath, JSON.stringify(wf));
}

function makeSmallApi() {
  const wf = {
    "1": { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "m13_small" } },
  };
  writeFileSync(smallApiPath, JSON.stringify(wf));
}

// ── 中继进程管理 ────────────────────────────────────────────────────────────
function startRelay() {
  const child = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", BACKEND, "--log-file", LOGFILE, "--control-key", KEY], { stdio: ["ignore", "pipe", "pipe"] });
  child.__log = "";
  child.stdout.on("data", (c) => { child.__log += c.toString("utf8"); });
  child.stderr.on("data", (c) => { child.__log += c.toString("utf8"); });
  return child;
}
async function waitReady(child, ms = 10000) {
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

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  makeBigUi();
  makeSmallApi();
  writeFileSync(badPath, "this is not json at all");

  const bk = await backendAlive();
  if (!bk) {
    console.log("⚠️ 后端 8188 不可达——先启动 ComfyUI 服务后重跑（该测试需要真实后端做转换与提交）");
    process.exit(2);
  }
  const qe = await queueEmpty();
  if (!qe) {
    console.log("⚠️ 队列非空——按纪律不提交测试任务，请先清空队列后重跑");
    process.exit(3);
  }

  const relay = startRelay();
  const ready = await waitReady(relay);
  check("中继 standalone 就绪", ready, ready ? "" : relay.__log.slice(-400));
  if (!ready) { relay.kill("SIGKILL"); process.exit(1); }
  await sleep(800); // 等事件订阅连上

  // 0) controlKey 门
  const noKey = await jpost("/_relay/submit-file", { path: smallApiPath });
  check("submit-file 无密钥 → 403", noKey.status === 403, `HTTP ${noKey.status}`);

  // 1) 核心：大 UI 文件（>4.6MB）
  const bigSize = statSync(bigPath).size;
  const big = await jpost("/_relay/submit-file", { path: bigPath }, { "x-comfy-relay-key": KEY });
  const bigOk = big.status === 200 && big.data?.ok === true && typeof big.data?.prompt_id === "string";
  check(`大文件提交（${(bigSize / 1024 / 1024).toFixed(2)} MB，UI 格式）`, bigOk, `status=${big.status} prompt=${big.data?.prompt_id ? big.data.prompt_id.slice(0, 8) : ""} nodeCount=${big.data?.nodeCount} ${big.data?.source || big.data?.error || ""}`);
  check("大文件 nodeCount==2（Note 被跳过）", big.data?.nodeCount === 2, `nodeCount=${big.data?.nodeCount}`);
  check("大文件 source 标注 UI 已转换", String(big.data?.source || "").includes("UI 格式已转换"), String(big.data?.source || ""));

  // 2) 小 API 文件
  const small = await jpost("/_relay/submit-file", { path: smallApiPath }, { "x-comfy-relay-key": KEY });
  check("小文件提交（API 格式）", small.status === 200 && small.data?.ok === true && typeof small.data?.prompt_id === "string", `nodeCount=${small.data?.nodeCount} ${small.data?.prompt_id || small.data?.error || ""}`);
  check("小文件 source 标注 API 格式", String(small.data?.source || "").includes("API 格式"), String(small.data?.source || ""));

  // 3) inputs 注入
  const inj = await jpost("/_relay/submit-file", { path: smallApiPath, inputs: { "1.width": 48 } }, { "x-comfy-relay-key": KEY });
  check("inputs 注入（1.width=48）", inj.status === 200 && inj.data?.ok === true && Array.isArray(inj.data?.applied) && inj.data.applied.includes("1.width"), JSON.stringify(inj.data?.applied || inj.data?.error));

  // 4) 负例：不存在 / 非 JSON / 空入参
  const nf = await jpost("/_relay/submit-file", { path: "D:\\definitely-not-exist-12345.json" }, { "x-comfy-relay-key": KEY });
  check("不存在文件 → 404", nf.status === 404, `HTTP ${nf.status}`);
  const bj = await jpost("/_relay/submit-file", { path: badPath }, { "x-comfy-relay-key": KEY });
  check("非 JSON → 400 含说明", bj.status === 400 && /不是合法 JSON/.test(String(bj.data?.error || "")), `HTTP ${bj.status}`);
  const noArg = await jpost("/_relay/submit-file", {}, { "x-comfy-relay-key": KEY });
  check("缺 path/template → 400", noArg.status === 400, `HTTP ${noArg.status}`);

  // 5) template 未找到
  const nt = await jpost("/_relay/submit-file", { template: "__m13_not_exist__.json" }, { "x-comfy-relay-key": KEY });
  check("template 未找到 → 502 含提示", nt.status === 502 && /找不到/.test(String(nt.data?.error || "")), String(nt.data?.error || "").slice(0, 90));

  // 6) template 正例（写测试文件 → 提交 → 清理；重试一次容忍列表刷新延迟）
  const tplName = `_m13_test_${randomBytes(4).toString("hex")}.json`;
  const wfDir = WORKFLOWS_CANDIDATES.find((d) => existsSync(d)) || null;
  const tplPath = wfDir ? `${wfDir}\\${tplName}` : null;
  let tplOk = false; let tplExtra = "无可用 workflows 目录";
  try {
    if (tplPath) {
      writeFileSync(tplPath, readFileSync(smallApiPath));
      let tplRes = await jpost("/_relay/submit-file", { template: tplName }, { "x-comfy-relay-key": KEY });
      if (!(tplRes.status === 200 && tplRes.data?.ok === true)) {
        await sleep(1200);
        tplRes = await jpost("/_relay/submit-file", { template: tplName }, { "x-comfy-relay-key": KEY });
      }
      tplOk = tplRes.status === 200 && tplRes.data?.ok === true && typeof tplRes.data?.prompt_id === "string";
      tplExtra = `dir=${wfDir} status=${tplRes.status} ${tplRes.data?.prompt_id ? "prompt=" + tplRes.data.prompt_id.slice(0, 8) : (tplRes.data?.error || "").toString().slice(0, 90)}`;
    }
  } finally {
    try { if (tplPath && existsSync(tplPath)) rmSync(tplPath); } catch { /* 清理失败不 fail */ }
  }
  check("template 正例（userdata 写入→提交→清理）", tplOk, tplExtra);

  // 7) 软观察：大文件任务确实进入后端历史（失败不算 FAIL，只打印）
  await sleep(2500);
  if (big.data?.prompt_id) {
    try {
      const r = await fetch(`http://${BACKEND}/history/${big.data.prompt_id}`, { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      const st = d?.[big.data.prompt_id]?.status?.status_str || "（尚无记录）";
      console.log(`INFO  大文件任务后端状态：${st}`);
    } catch (e) {
      console.log(`INFO  后端历史查询失败（不影响判定）：${String((e && e.message) || e)}`);
    }
  }

  relay.kill("SIGKILL");
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("测试异常：", e); process.exit(1); });
