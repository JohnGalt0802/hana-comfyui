// M3 遗留项①：relay 日志滚动验证（>5MiB 启动时滚动为 .1）
// 方法：预置 6MiB 旧日志 → 起 relay → 验证 .1 保留旧内容、新日志从零开始并持续追加
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const RELAY = "D:\\HanakoWorks\\ComfyUI\\app\\runtime\\comfy-relay.mjs";
const PORT = 39401;
const DIR = "D:\\HanakoWorks\\ComfyUI\\tools\\m3-checks\\logs";
const LOG = `${DIR}\\rot-test.log`;
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(DIR, { recursive: true });
rmSync(`${LOG}.1`, { force: true });

// 1) 预置 6MiB 旧日志（> LOG_MAX_BYTES=5MiB）
const junk = "x".repeat(1023) + "\n";
const buf = Buffer.alloc(6 * 1024 * 1024, "x");
writeFileSync(LOG, buf);
const preSize = statSync(LOG).size;
check("前置：预置 6MiB 旧日志", preSize === 6 * 1024 * 1024, `${preSize} B`);

// 2) 起 relay
const relay = spawn(process.execPath, [RELAY, "--standalone", "--port", String(PORT), "--backend", "127.0.0.1:8188", "--log-file", LOG], { stdio: ["ignore", "pipe", "pipe"] });
let rlog = "";
relay.stdout.on("data", (c) => { rlog += c.toString("utf8"); });
relay.stderr.on("data", (c) => { rlog += c.toString("utf8"); });
const t0 = Date.now();
while (!rlog.includes("COMFY_RELAY_READY") && Date.now() - t0 < 8000) await sleep(100);
check("中继就绪", rlog.includes("COMFY_RELAY_READY"));

// 3) 滚动断言
const rotated = existsSync(`${LOG}.1`) ? statSync(`${LOG}.1`).size : -1;
check("旧日志已滚动为 .1（6MiB 原样保留）", rotated === 6 * 1024 * 1024, `.1 = ${rotated} B`);
const freshSize = existsSync(LOG) ? statSync(LOG).size : -1;
check("新日志已重建（远小于 5MiB）", freshSize > 0 && freshSize < 1024 * 1024, `新日志 = ${freshSize} B`);
const fresh = readFileSync(LOG, "utf8");
check("新日志含启动记录（日志落盘/监听）", /日志落盘/.test(fresh) && /中继监听/.test(fresh));

// 4) 追加验证：发请求后有新行
await fetch(`http://127.0.0.1:${PORT}/_relay/queue-noop`).catch(() => {});
await fetch(`http://127.0.0.1:${PORT}/api/queue`).catch(() => {});
await sleep(400);
const afterSize = statSync(LOG).size;
const after = readFileSync(LOG, "utf8");
check("请求日志持续追加（含 GET 行）", afterSize > freshSize && /GET \/api\/queue/.test(after), `${freshSize} → ${afterSize} B`);

relay.kill("SIGKILL");
await sleep(300);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
