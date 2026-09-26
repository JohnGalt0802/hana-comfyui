#!/usr/bin/env node
// runtime/comfy-relay.mjs — Hana-ComfyUI 受管中继（Node 单文件，无第三方依赖）· v0.5
// ─────────────────────────────────────────────────────────────────────────────
// 干什么：把宿主受管服务代理（/api/apps/comfyui-hana/routes/_runtime/<runtimeId>/…）
//         转发来的请求，HTTP/WS 全量反代到本机 ComfyUI（默认 127.0.0.1:8188）。
// 业务面（/_relay/*，只读为主；管理端点需 x-comfy-relay-key）：
//   GET  /_relay/status            聚合状态（后端可达性、队列、请求计数、事件订阅、日志文件；
//                                  后端不可达时附 env：本机 ComfyUI 安装探测）
//   GET  /_relay/prompts           进度事件缓存（订阅后端 /ws 得来）：active + recent
//   GET  /_relay/prompts/<id>      单个 prompt 的事件记录
//   GET  /_relay/history?id=&max=  历史摘要（裁剪版：status/error/outputs，避免全量历史体积）
//   GET  /_relay/metrics           主机指标（GPU / CPU / 内存；GPU 走 nvidia-smi 定时缓存）
//   GET  /_relay/drives            安装位置候选（各盘剩余空间/可写性 + 推荐 <盘>:\ComfyUI）
//   GET/POST /_relay/custom-roots  App 推送的自定义安装位置（POST 需 controlKey）
//   POST /_relay/fs/stat           文件 stat（本机路径；{path}）
//   POST /_relay/fs/read           读取文本/二进制（{path, encoding, maxBytes}，上限 8 MiB）
//   POST /_relay/upload            读取本机图片并 multipart 上传到后端 /upload/image
//                                  （{path, subfolder?, type?, overwrite?}）
//   GET  /_relay/theme             宿主主题写入状态（跨源主题跟随，见「主题同步」区）
//   GET  /_relay/update            ComfyUI 本体更新检查（git fetch + 比较，带 TTL 缓存）
//   POST /_relay/update            执行更新（{op:"check"|"apply"}；apply 后台跑，需 controlKey）
//   GET  /_relay/update/status     更新进度（阶段 / 步骤 / 日志尾）
  //   POST /_relay/bridge           画布桥（只读阶段）：{op,args} → ComfyUI 内 hana_bridge 扩展执行
  //                                 （需 controlKey；token 读 custom_nodes/hana_bridge/.token）
//
// 启动方式：
//   受管模式（生产）：node comfy-relay.mjs <runtime-config.json>
//     —— 由 App 的 ctx.runtime.start({runtime:"node", service:{port,readyMarker}}) 拉起；
//        配置 0600，启动时读取后立即自删；就绪标记独占一行写 stdout（宿主按整行匹配）。
//   standalone（本地测试）：node comfy-relay.mjs --standalone --port 39123 --backend 127.0.0.1:8188
//     可选：--ready-marker <文本>、--require-backend、--log-file <路径>、
//           --control-key <密钥>（≥16 字符）、--comfy-base <ComfyUI 根>、--help
//  诊断：node comfy-relay.mjs --probe-env（打印本机安装探测 JSON 后退出）
//
// 退出码：0 OK / 1 INTERNAL / 2 BACKEND_UNREACHABLE（requireBackend 时）/ 3 USAGE / 7 PORT
// 日志：请求与信息走 stdout（宿主受管 runtime 捕获）；warn/error 走 stderr；
//       配置了 logFile 时同步落盘（启动时 >5MiB 滚动到 <logFile>.1）。
//
// ── 路径口径（宿主段已实测：宿主在转发前剥离前缀与 _surface 凭证段）────────────────
// 中继收到的应是干净目标路径（如 /api/queue、/ws）；防御性清理保留为保险：
//   · 路径开头的 /_surface/<票据>/ 段    · 查询串里的 appSurfaceSession
// 上游请求一律以"服务端转发"语义发出——不携带 Origin / Sec-Fetch-*；Host 重写为后端 authority。
// ─────────────────────────────────────────────────────────────────────────────
import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { cpus as osCpus, freemem, homedir, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { basename, dirname, extname, join } from "node:path";

// ── 退出码 ──────────────────────────────────────────────────────────────────
const EXIT = Object.freeze({ OK: 0, INTERNAL: 1, BACKEND: 2, USAGE: 3, PORT: 7 });

// ── 常量 ────────────────────────────────────────────────────────────────────
const PROBE_INTERVAL_MS = 5_000;   // 后端被动探测节拍
const PROBE_TIMEOUT_MS = 3_000;
const QUEUE_CACHE_MS = 1_000;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_RETRY_MS = 2_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const PROMPT_MAX_RECORDS = 300;    // 事件缓存上限（条）
const PROMPT_KEEP_TERMINAL_MS = 30 * 60 * 1000;
const FS_READ_MAX_BYTES = 8 * 1024 * 1024;
const GPU_CACHE_MS = 4_000;        // nvidia-smi 采集缓存（子进程开销大，别按请求频率跑）
const CPU_SAMPLE_MS = 1_500;       // CPU 采样节拍（按间隔算 delta，与客户端无关）
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const JSON_BODY_MAX_BYTES = 256 * 1024;
const TRACKED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
// 逐跳头（RFC 7230）：不向下游/上游透传
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
// 服务端转发语义下剔除的浏览器语义头
const BROWSER_ONLY = new Set(["origin"]);
const CREDENTIAL_QUERY_KEYS = new Set(["appSurfaceSession"]);
const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

// ── 日志 ────────────────────────────────────────────────────────────────────
let logFilePath = null;
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function logLine(stream, level, text) {
  for (const line of String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.trim().length === 0) continue;
    const out = `[comfy-relay] [${ts()}] [${level}] ${line.trimEnd()}\n`;
    stream.write(out);
    if (logFilePath) {
      try { appendFileSync(logFilePath, out); } catch { /* 落盘失败不影响主流程 */ }
    }
  }
}
const log = (...a) => logLine(process.stdout, "info", a.map(String).join(" "));
const warn = (...a) => logLine(process.stderr, "warn", a.map(String).join(" "));
const logErr = (...a) => logLine(process.stderr, "error", a.map(String).join(" "));

function initLogFile(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      try { rmSync(`${path}.1`, { force: true }); } catch { /* 忽略 */ }
      renameSync(path, `${path}.1`);
    }
    logFilePath = path;
    return true;
  } catch (e) {
    warn(`日志文件初始化失败（仅保留 stdout/stderr）：${(e && e.message) || e}`);
    return false;
  }
}

// ── 统计 ────────────────────────────────────────────────────────────────────
const stats = {
  startedAtMs: Date.now(),
  total: 0,
  byMethod: Object.create(null),
  errors: 0,
  active: 0,
  ws: 0,
  wsActive: 0,
};

const backend = {
  host: "127.0.0.1",
  port: 8188,
  reachable: false,
  checkedAt: 0,
  lastError: null,
  system: null,
};
let queueInfo = null;
let queueAt = 0;
let config = null;
let servingPort = null;

// ── 参数 / 配置 ─────────────────────────────────────────────────────────────
const USAGE = `用法：
  node comfy-relay.mjs <runtime-config.json>          受管模式（由 Hana ctx.runtime.start 拉起）
  node comfy-relay.mjs --standalone --port <端口> --backend <host:端口>
                                                      本地测试模式
选项：
  --ready-marker <文本>   受管模式下由配置提供；standalone 默认 COMFY_RELAY_READY:<port>
  --require-backend       启动时后端不可达则退出码 2（默认关闭：attach 模式下后端可后起）
  --log-file <路径>       追加写日志文件（启动时 >5MiB 滚动为 <路径>.1）
  --control-key <密钥>    /_relay/* 管理端点密钥（≥16 字符）；受管模式由配置提供
  --comfy-base <路径>     ComfyUI 安装根（可选；不传则由本机安装探测自动识别）
  --client-id <id>        后端 /ws 订阅与提交共用的 clientId（默认 comfyui-relay）
  --probe-env             打印本机 ComfyUI 安装探测结果（JSON）后退出（诊断用）
  --help                  显示本帮助`;

function usageExit(text) {
  if (text) logErr(text);
  process.stderr.write(USAGE + "\n");
  process.exit(EXIT.USAGE);
}

function parseBackendAddress(text) {
  const m = /^([A-Za-z0-9.:[\]_-]+):(\d{1,5})$/.exec(String(text || "").trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function validateConfig(raw, sourceLabel) {
  const out = {
    mode: "managed",
    port: 0,
    backend: { host: "127.0.0.1", port: 8188 },
    readyMarker: "",
    requireBackend: false,
    logRequests: true,
    upstreamTimeoutMs: 0,
    backendWaitMs: 8_000,
    logFile: null,
    controlKey: null,
    comfyBase: null,
    clientId: "comfyui-relay-" + randomBytes(4).toString("hex"),
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: 配置必须是 JSON 对象`);
  }
  if (typeof raw.mode === "string" && raw.mode === "standalone") out.mode = "standalone";
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${sourceLabel}: port 必须是 0..65535 的整数`);
  out.port = port;
  if (raw.backend && typeof raw.backend === "object") {
    const host = String(raw.backend.host || "").trim();
    const bport = Number(raw.backend.port);
    if (!host) throw new Error(`${sourceLabel}: backend.host 必填`);
    if (!Number.isInteger(bport) || bport < 1 || bport > 65535) throw new Error(`${sourceLabel}: backend.port 必须是 1..65535 的整数`);
    out.backend = { host, port: bport };
  }
  if (typeof raw.readyMarker === "string" && raw.readyMarker.length > 0) {
    if (/[\r\n]/.test(raw.readyMarker)) throw new Error(`${sourceLabel}: readyMarker 不能含换行`);
    out.readyMarker = raw.readyMarker;
  }
  if (typeof raw.requireBackend === "boolean") out.requireBackend = raw.requireBackend;
  if (typeof raw.logRequests === "boolean") out.logRequests = raw.logRequests;
  if (typeof raw.upstreamTimeoutMs === "number" && Number.isFinite(raw.upstreamTimeoutMs) && raw.upstreamTimeoutMs > 0) {
    out.upstreamTimeoutMs = Math.round(raw.upstreamTimeoutMs);
  }
  if (typeof raw.backendWaitMs === "number" && Number.isFinite(raw.backendWaitMs) && raw.backendWaitMs > 0) {
    out.backendWaitMs = Math.round(raw.backendWaitMs);
  }
  if (typeof raw.logFile === "string" && raw.logFile.trim()) out.logFile = raw.logFile.trim();
  if (typeof raw.controlKey === "string" && raw.controlKey.length >= 16) out.controlKey = raw.controlKey;
  if (typeof raw.comfyBase === "string" && raw.comfyBase.trim()) out.comfyBase = raw.comfyBase.trim();
  if (typeof raw.clientId === "string" && raw.clientId.trim()) out.clientId = raw.clientId.trim();
  return out;
}

function loadConfig(argv) {
  if (argv.includes("--help") || argv.includes("-h")) usageExit();
  const standalone = argv.includes("--standalone");
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    return argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  if (!standalone) {
    const path = argv.find((a) => !a.startsWith("-"));
    if (!path) usageExit("缺少运行时配置文件路径（或使用 --standalone）");
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw Object.assign(new Error(`读取运行时配置失败：${(e && e.message) || e}`), { usage: true });
    }
    // 读取后立即自删（配置里含端口/密钥；不留在盘上）
    try { rmSync(path, { force: true }); } catch { /* 忽略 */ }
    const cfg = validateConfig(raw, "runtime-config");
    cfg.mode = "managed";
    return cfg;
  }
  // standalone
  const raw = {
    mode: "standalone",
    port: 0,
    backend: { host: "127.0.0.1", port: 8188 },
    requireBackend: argv.includes("--require-backend"),
    logRequests: true,
  };
  const portText = getFlag("--port");
  if (portText !== null) {
    const p = Number(portText);
    if (!Number.isInteger(p) || p < 0 || p > 65535) usageExit(`--port 非法：${portText}`);
    raw.port = p;
  }
  const backendText = getFlag("--backend");
  if (backendText) {
    const addr = parseBackendAddress(backendText);
    if (!addr) usageExit(`--backend 非法（应为 host:port）：${backendText}`);
    raw.backend = addr;
  }
  const marker = getFlag("--ready-marker");
  if (marker) raw.readyMarker = marker;
  const logFile = getFlag("--log-file");
  if (logFile) raw.logFile = logFile;
  const controlKey = getFlag("--control-key");
  if (controlKey) raw.controlKey = controlKey;
  const comfyBase = getFlag("--comfy-base");
  if (comfyBase) raw.comfyBase = comfyBase;
  const clientId = getFlag("--client-id");
  if (clientId) raw.clientId = clientId;
  const cfg = validateConfig(raw, "standalone");
  cfg.mode = "standalone";
  return cfg;
}

// ── 路径防御性清理 ──────────────────────────────────────────────────────────
let stripSurfaceCount = 0;
let stripQueryCount = 0;

function sanitizeTarget(rawUrl) {
  let rest = String(rawUrl || "/").replace(/[\r\n\u0000]/g, "");
  let query = "";
  const qi = rest.indexOf("?");
  if (qi >= 0) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }
  // 1) /_surface/<票据>/ 段
  const SURFACE = "/_surface/";
  if (rest.startsWith(SURFACE)) {
    const tail = rest.slice(SURFACE.length);
    const slash = tail.indexOf("/");
    const token = slash >= 0 ? tail.slice(0, slash) : tail;
    if (token) {
      rest = slash >= 0 ? tail.slice(slash) : "/";
      stripSurfaceCount += 1;
      if (stripSurfaceCount <= 3) warn(`收到未剥离的 /_surface/ 凭证段，已防御性清理（第 ${stripSurfaceCount} 次）：${key2(rawUrl)}`);
    }
  }
  // 2) 凭证查询参数
  if (query) {
    let hit = false;
    const kept = [];
    for (const seg of query.split("&")) {
      const key = seg.split("=", 1)[0];
      if (CREDENTIAL_QUERY_KEYS.has(key)) { hit = true; continue; }
      kept.push(seg);
    }
    if (hit) {
      query = kept.join("&");
      stripQueryCount += 1;
      if (stripQueryCount <= 3) warn(`收到凭证查询参数，已防御性清理（第 ${stripQueryCount} 次）：${key2(rawUrl)}`);
    }
  }
  return rest + (query ? `?${query}` : "");
}
function key2(u) {
  return String(u)
    .replace(/(\/_surface\/)[^/?&]+/gi, "$1<redacted>")
    .replace(/(appSurfaceSession=)[^&]*/gi, "$1<redacted>");
}

// ── 头处理 ─────────────────────────────────────────────────────────────────
function filterHeaders(rawHeaders, { forUpgrade = false, backendHost, backendPort } = {}) {
  const out = Object.create(null);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]);
    const value = rawHeaders[i + 1];
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "host") continue; // 重写为后端 authority
    if (BROWSER_ONLY.has(lower)) continue; // Origin 不转发
    if (lower.startsWith("sec-fetch-")) continue; // 浏览器跨站保护头不转发
    if (!forUpgrade && HOP_BY_HOP.has(lower)) continue; // upgrade 握手需要 connection/upgrade
    if (out[lower] !== undefined) {
      out[lower] = Array.isArray(out[lower]) ? [...out[lower], value] : [out[lower], value];
    } else {
      out[lower] = value;
    }
  }
  out.host = `${backendHost}:${backendPort}`;
  return out;
}

function copyResponseHeaders(rawHeaders) {
  const out = Object.create(null);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]);
    const value = rawHeaders[i + 1];
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (out[lower] !== undefined) {
      out[lower] = Array.isArray(out[lower]) ? [...out[lower], value] : [out[lower], value];
    } else {
      out[lower] = value;
    }
  }
  return out;
}

// ── 后端探测 / 状态聚合 ────────────────────────────────────────────────────
function markBackendDown(errText) {
  const was = backend.reachable;
  backend.reachable = false;
  backend.lastError = errText;
  backend.checkedAt = Date.now();
  if (was) warn(`后端 ${backend.host}:${backend.port} 转为不可达：${errText}`);
}

async function probeBackend() {
  try {
    const res = await fetch(`http://${backend.host}:${backend.port}/system_stats`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      markBackendDown(`/system_stats HTTP ${res.status}`);
      return;
    }
    const data = await res.json().catch(() => null);
    const was = backend.reachable;
    backend.reachable = true;
    backend.lastError = null;
    backend.checkedAt = Date.now();
    backend.system = data && typeof data === "object" ? extractSystem(data) : null;
    if (!was) log(`后端 ${backend.host}:${backend.port} 可达（ComfyUI ${backend.system?.comfyui_version || "?"}）`);
  } catch (e) {
    markBackendDown(e && e.name === "TimeoutError" ? "探测超时" : String((e && e.message) || e));
  }
}

// /system_stats 形状（0.37.0 实测）：system.{comfyui_version, required_frontend_version, python_version,
// comfy_package_versions:[{name:"comfyui-frontend-package",installed,required}]}；取前端包已装版本。
function extractSystem(data) {
  const s = data && data.system && typeof data.system === "object" ? data.system : {};
  let installedFrontend = null;
  if (Array.isArray(s.comfy_package_versions)) {
    const row = s.comfy_package_versions.find((p) => p && String(p.name || "").includes("frontend"));
    if (row && row.installed !== undefined) installedFrontend = row.installed;
  }
  return {
    comfyui_version: s.comfyui_version !== undefined ? s.comfyui_version : null,
    python_version: s.python_version !== undefined ? s.python_version : null,
    required_frontend_version: s.required_frontend_version !== undefined ? s.required_frontend_version : null,
    installed_frontend_version: installedFrontend,
    deploy_environment: s.deploy_environment !== undefined ? s.deploy_environment : null,
    devices: Array.isArray(data.devices)
      ? data.devices.map((d) => ({
          name: d && d.name !== undefined ? d.name : null,
          vram_total: d && d.vram_total !== undefined ? d.vram_total : null,
          vram_free: d && d.vram_free !== undefined ? d.vram_free : null,
        }))
      : null,
  };
}

// ── 本机安装探测（环境引导用）───────────────────────────────────────────────
// 目标：区分「装了但没跑」与「可能没装」，供 App / 壳页给出对应引导文案。
// 策略：有限候选路径 + 指纹判定，绝不做全盘扫描；结果按 TTL 缓存（同步、廉价）。
const ENV_PROBE_TTL_MS = 15_000;
const envProbe = { at: 0, result: null };
let customRoots = []; // App 推送的自定义安装位置（优先于常见路径检查）

// 受管 runtime 的环境被宿主重写过（USERPROFILE/HOME 可能指向 app 的 .runtime-tmp），
// os.homedir() 在那里拿到的不是真实用户目录。逐级回退并排除污染路径。
function realHome() {
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  if (process.env.USERPROFILE) push(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) push(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  push(homedir());
  if (process.env.HOME) push(process.env.HOME);
  for (const c of cands) {
    if (/[\\/]app-data[\\/]|[\\/]\.runtime-tmp/i.test(c)) continue; // 运行时临时目录，不是真家目录
    if (existsSync(c)) return c.replace(/[\\/]+$/, "");
  }
  return null;
}

function candidateRoots() {
  const home = realHome();
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  for (const r of customRoots) push(r); // 自定义优先
  if (process.env.COMFYUI_PATH) push(process.env.COMFYUI_PATH.trim());
  if (process.platform === "win32") {
    for (const d of ["C", "D", "E", "F", "G"]) {
      push(`${d}:\\ComfyUI`);
      push(`${d}:\\ComfyUI\\ComfyUI`);
      push(`${d}:\\ComfyUI_windows_portable`);
    }
    push(join(home, "ComfyUI"));
    push(join(home, "Desktop", "ComfyUI"));
    push(join(home, "Documents", "ComfyUI"));
    if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, "Programs", "@comfyorgcomfyui-electron"));
  } else if (process.platform === "darwin") {
    push(join(home, "ComfyUI"));
    push(join(home, "Documents", "ComfyUI"));
    push("/Applications/ComfyUI.app");
  } else {
    push(join(home, "ComfyUI"));
    push("/opt/ComfyUI");
  }
  return roots;
}

function detectInstall(root) {
  try {
    if (!existsSync(root)) return null;
    // ComfyUI Desktop（Electron 版）：安装目录名特异，存在即视为线索
    if (root.includes("@comfyorgcomfyui-electron")) {
      return { path: root, kind: "desktop", version: null, hasVenv: false, mainPy: null };
    }
    // 源码安装：main.py + folder_paths.py 同目录
    if (existsSync(join(root, "main.py")) && existsSync(join(root, "folder_paths.py"))) {
      let version = null;
      try {
        const vf = join(root, "comfyui_version.py");
        if (existsSync(vf)) {
          const m = /__version__\s*=\s*["']([^"']+)["']/.exec(readFileSync(vf, "utf8").slice(0, 4000));
          if (m) version = m[1];
        }
      } catch { /* 版本读不到不致命 */ }
      const parent = dirname(root);
      const hasVenv = ["venv", ".venv"].some((d) =>
        existsSync(join(root, d, "Scripts", "python.exe")) || existsSync(join(root, d, "bin", "python")) ||
        existsSync(join(parent, d, "Scripts", "python.exe")) || existsSync(join(parent, d, "bin", "python")));
      return { path: root, kind: "source", version, hasVenv, mainPy: join(root, "main.py") };
    }
    // 外层布局：root/ComfyUI/main.py + 自带环境（便携包的 python_embeded，或外层源码布局的兄弟 venv）
    if (existsSync(join(root, "ComfyUI", "main.py"))) {
      const hasEmbeded = existsSync(join(root, "python_embeded", "python.exe"));
      const hasSiblingVenv = ["venv", ".venv"].some((d) =>
        existsSync(join(root, d, "Scripts", "python.exe")) || existsSync(join(root, d, "bin", "python")));
      if (hasEmbeded || hasSiblingVenv) {
        return {
          path: root, kind: hasEmbeded ? "portable" : "source",
          version: null, hasVenv: true,
          mainPy: join(root, "ComfyUI", "main.py"),
        };
      }
    }
    return null;
  } catch { return null; }
}

function probeEnv(force = false) {
  if (!force && envProbe.result && Date.now() - envProbe.at < ENV_PROBE_TTL_MS) return envProbe.result;
  const roots = candidateRoots();
  const installs = [];
  for (const root of roots) {
    const hit = detectInstall(root);
    if (hit && !installs.some((i) => i.path === hit.path)) installs.push(hit);
  }
  envProbe.result = {
    platform: process.platform,
    found: installs.length > 0,
    installs: installs.slice(0, 5),
    candidatesChecked: roots.length,
    probeAt: new Date().toISOString(),
  };
  envProbe.at = Date.now();
  return envProbe.result;
}

// ── 主机指标采集（GPU / CPU / 内存）──────────────────────────────────────────
// 供 App 状态面板的实时图表与「释放显存」按钮；只读，不碰后端。
// GPU 走 nvidia-smi：受管 runtime 的 local-machine profile 允许子进程。
// 踩坑（llama-monitor 2026-09-19 实测）：宿主裁剪过子进程环境，缺 ProgramFiles
// 会让 nvidia-smi 的 NVML 初始化失败（exit 255，"Failed to initialize NVML"）；
// 统一补 CHILD_ENV，缺 PATH 时固化的 "C:\Windows\System32" 也在内。
const CHILD_ENV = {
  ...process.env,
  ProgramFiles: process.env.ProgramFiles || "C:\\Program Files",
  "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ProgramData: process.env.ProgramData || "C:\\ProgramData",
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  windir: process.env.windir || "C:\\Windows",
  SystemDrive: process.env.SystemDrive || "C:",
  PATH: process.env.PATH || "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem",
};
const SMI_PATH = existsSync("C:\\Windows\\System32\\nvidia-smi.exe") ? "C:\\Windows\\System32\\nvidia-smi.exe" : "nvidia-smi";
const SMI_ARGS = [
  "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit",
  "--format=csv,noheader,nounits",
];

let gpuCache = { at: 0, value: null, error: null };
let gpuInflight = false;
function refreshGpu() {
  if (gpuInflight) return;
  gpuInflight = true;
  execFile(SMI_PATH, SMI_ARGS, { windowsHide: true, timeout: 6_000, env: CHILD_ENV }, (err, stdout) => {
    gpuInflight = false;
    if (err) {
      gpuCache = { at: Date.now(), value: null, error: String((err && err.message) || err).slice(0, 200) };
      return;
    }
    try {
      const p = String(stdout).trim().split(",").map((s) => s.trim());
      const num = (i) => { const v = parseFloat(p[i]); return Number.isNaN(v) ? null : v; };
      gpuCache = {
        at: Date.now(),
        value: {
          name: p[0] || null,
          memoryTotalMiB: num(1), memoryUsedMiB: num(2), memoryFreeMiB: num(3),
          utilPct: num(4), tempC: num(5), powerW: num(6), powerLimitW: num(7),
        },
        error: null,
      };
    } catch (e) {
      gpuCache = { at: Date.now(), value: null, error: String((e && e.message) || e).slice(0, 200) };
    }
  });
}

let cpuPrev = null;
let cpuSnapshot = { usagePct: null, cores: 0, model: null };
function sampleCpu() {
  const cs = osCpus();
  const now = Date.now();
  const cur = cs.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  let usagePct = null;
  if (cpuPrev && now > cpuPrev.t) {
    let dIdle = 0, dTotal = 0;
    for (let i = 0; i < Math.min(cur.length, cpuPrev.times.length); i++) {
      dIdle += cur[i].idle - cpuPrev.times[i].idle;
      dTotal += cur[i].total - cpuPrev.times[i].total;
    }
    if (dTotal > 0) usagePct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  cpuPrev = { t: now, times: cur };
  cpuSnapshot = {
    usagePct: usagePct === null ? null : Math.round(usagePct * 10) / 10,
    cores: cur.length,
    model: (cs[0] && cs[0].model) ? String(cs[0].model).replace(/\s+/g, " ").trim() : null,
  };
}

function metricsPayload() {
  if (Date.now() - gpuCache.at > GPU_CACHE_MS) refreshGpu(); // 异步刷新，本次回缓存值
  const memTotal = totalmem();
  const memFree = freemem();
  return {
    ok: true,
    at: new Date().toISOString(),
    gpu: gpuCache.value,
    gpuError: gpuCache.value ? null : gpuCache.error,
    gpuAt: gpuCache.at ? new Date(gpuCache.at).toISOString() : null,
    cpu: cpuSnapshot,
    mem: {
      totalMiB: Math.round(memTotal / 1048576),
      freeMiB: Math.round(memFree / 1048576),
      usedMiB: Math.round((memTotal - memFree) / 1048576),
      usedPct: memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 1000) / 10 : null,
    },
    platform: osPlatform(),
    release: osRelease(),
  };
}

// ── ComfyUI 服务进程管理（启动 / 停止）─────────────────────────────────────
// 为什么要绕「计划任务」这一圈（2026-09-23 实测，非推断）：
//   中继自身跑在宿主的受限令牌 + job object 里（hana-win-sandbox --normal-token-job）。
//   中继直接 spawn 的子进程即使 detached + unref，也会在中继退出时被 job 连带回收
//   （实测：沙箱父进程退出后子进程消失）。宿主一重启 / App 一重载，正在跑的 ComfyUI 就没了。
//   改由 Task Scheduler 以当前用户身份拉起：天然脱离沙箱与 job，Hana 退出后服务仍在
//   （实测：沙箱退出后 8188 继续服务，ComfyUI 0.37.0，45s 就绪）。
// 撤下：受限令牌下 taskkill 能终止该进程（实测成功）；计划任务只当启动器，不常驻。
// 生命周期口径：服务一旦由本入口拉起就独立于 Hana 存活，中继重启不影响它；
//   只有「停止服务」入口（或外部手段）能把它撤下。
const BACKEND_TASK_NAME = "HanaComfyUI-Backend";
const LAUNCHER_NAME = "backend-launcher.cmd";
const LAUNCHER_VBS_NAME = "backend-launcher.vbs";
const WSCRIPT_EXE = "C:\\Windows\\System32\\wscript.exe";
const PID_CACHE_MS = 5_000;
const backendProc = {
  startedAt: null,
  install: null,
  python: null,
  mainPy: null,
  launcher: null,
  logFile: null,
  lastError: null,
  lastStop: null,
};
let pidCache = { at: 0, pids: [] };

function backendStatePath() {
  const dir = logFilePath ? dirname(logFilePath) : process.cwd();
  return join(dir, "backend-state.json");
}

function loadBackendState() {
  try {
    const raw = JSON.parse(readFileSync(backendStatePath(), "utf8"));
    for (const k of ["startedAt", "install", "python", "mainPy", "launcher", "logFile"]) {
      if (raw && typeof raw[k] === "string" && raw[k]) backendProc[k] = raw[k];
    }
  } catch { /* 首次运行没有状态文件，正常 */ }
}

function saveBackendState() {
  try {
    mkdirSync(dirname(backendStatePath()), { recursive: true });
    writeFileSync(backendStatePath(), JSON.stringify({ ...backendProc, savedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (e) {
    warn(`backend-state 写入失败：${(e && e.message) || e}`);
  }
}

function runExe(exe, args, timeoutMs = 20_000) {
  try {
    const r = spawnSync(exe, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: CHILD_ENV });
    return {
      code: r.status === null || r.status === undefined ? -1 : r.status,
      stdout: String(r.stdout || "").trim(),
      stderr: String(r.stderr || "").trim(),
      error: r.error ? String(r.error.message) : null,
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: "", error: String((e && e.message) || e) };
  }
}

// 8188 上正在监听的进程（撤下按钮的靶子；按端口找，不依赖进程名，兼容外部启动方式）
function listeningPids() {
  if (Date.now() - pidCache.at < PID_CACHE_MS) return pidCache.pids;
  const r = runExe("netstat.exe", ["-ano", "-p", "TCP"], 15_000);
  const pids = new Set();
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
    if (!parts[1].endsWith(`:${backend.port}`)) continue;
    if (String(parts[3]).toUpperCase() !== "LISTENING") continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  pidCache = { at: Date.now(), pids: [...pids] };
  return pidCache.pids;
}

// 解析可启动目标：安装根 → venv python → main.py。策略与 probeEnv 同一套指纹，不硬编码路径。
function resolveLaunchTarget(overridePath) {
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  if (overridePath) push(overridePath);
  for (const r of customRoots) push(r);
  const env = probeEnv(true);
  for (const i of env.installs || []) push(i.path);

  const tried = [];
  for (const root of cands) {
    const hit = detectInstall(root);
    if (!hit || !hit.mainPy) continue;
    const mainDir = dirname(hit.mainPy);
    const outer = dirname(mainDir);
    const pyCands = [];
    if (hit.kind === "portable") {
      pyCands.push(join(outer, "python_embeded", "python.exe"), join(mainDir, "python_embeded", "python.exe"));
    }
    for (const r of [outer, mainDir]) {
      pyCands.push(join(r, "venv", "Scripts", "python.exe"), join(r, ".venv", "Scripts", "python.exe"));
    }
    for (const p of pyCands) {
      if (existsSync(p)) return { ok: true, install: hit, python: p, mainPy: hit.mainPy, cwd: mainDir };
      tried.push(p);
    }
  }
  return { ok: false, tried, roots: cands };
}

async function startBackendService(overridePath) {
  if (backend.reachable) return { ok: true, already: true, reachable: true, url: `http://${backend.host}:${backend.port}` };
  const t = resolveLaunchTarget(overridePath);
  if (!t.ok) {
    backendProc.lastError = "未找到可启动的 ComfyUI 安装（缺 main.py 或缺 venv python）";
    saveBackendState();
    return { ok: false, error: backendProc.lastError, tried: t.tried, roots: t.roots };
  }

  const dir = logFilePath ? dirname(logFilePath) : process.cwd();
  const launcher = join(dir, LAUNCHER_NAME);
  const launcherVbs = join(dir, LAUNCHER_VBS_NAME);
  const logFile = join(dir, "backend.log");
  const script = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${t.cwd}"`,
    `"${t.python}" main.py --listen ${backend.host} --port ${backend.port} >> "${logFile}" 2>&1`,
    "",
  ].join("\r\n");
  // 隐藏窗口：任务若直接指向 .cmd，Windows 会开一个可见控制台（实测：任务栏多出一个 cmd 窗口）。
  // 改用 wscript 的 Run(..., 0, False) 隐藏拉起；wscript 不可用（组策略禁脚本宿主）时回退直接 .cmd。
  const useVbs = existsSync(WSCRIPT_EXE);
  const vbsScript = [
    "' Hana-ComfyUI service launcher (auto-generated by the app; do not edit)",
    "' Purpose: run backend-launcher.cmd with a hidden window (no console popup from the scheduled task)",
    "Dim sh, q",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "q = Chr(34)",
    `sh.Run "cmd /c " & q & "${launcher}" & q, 0, False`,
    "",
  ].join("\r\n");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(launcher, script, "utf8");
    if (useVbs) writeFileSync(launcherVbs, vbsScript, "utf8");
  } catch (e) {
    backendProc.lastError = `启动器写入失败：${(e && e.message) || e}`;
    saveBackendState();
    return { ok: false, error: backendProc.lastError };
  }

  // 任务命令行：vbs 分支整串交给 Task Scheduler，路径带空格靠内部引号（与 launcher 同一坑）
  const taskCommand = useVbs ? `${WSCRIPT_EXE} //B //NoLogo "${launcherVbs}"` : `"${launcher}"`;
  runExe("schtasks.exe", ["/delete", "/tn", BACKEND_TASK_NAME, "/f"], 15_000); // 任务不存在会非零退出，忽略
  // 2026-09-23 实测：不加引号 → Last Result -2147024703；加引号 → 任务 Running、服务起得来。
  const cr = runExe("schtasks.exe", ["/create", "/tn", BACKEND_TASK_NAME, "/tr", taskCommand, "/sc", "once", "/st", "00:00", "/f"], 20_000);
  if (cr.code !== 0) {
    backendProc.lastError = `计划任务创建失败：${cr.stderr || cr.error || `exit ${cr.code}`}`;
    saveBackendState();
    logErr(`启动 ComfyUI 服务失败：${backendProc.lastError}`);
    return { ok: false, error: backendProc.lastError, launcher };
  }
  const rr = runExe("schtasks.exe", ["/run", "/tn", BACKEND_TASK_NAME], 20_000);
  if (rr.code !== 0) {
    backendProc.lastError = `计划任务启动失败：${rr.stderr || rr.error || `exit ${rr.code}`}`;
    saveBackendState();
    logErr(`启动 ComfyUI 服务失败：${backendProc.lastError}`);
    return { ok: false, error: backendProc.lastError, launcher };
  }

  backendProc.startedAt = new Date().toISOString();
  backendProc.install = t.install.path;
  backendProc.python = t.python;
  backendProc.mainPy = t.mainPy;
  backendProc.launcher = launcher;
  backendProc.logFile = logFile;
  backendProc.lastError = null;
  saveBackendState();
  pidCache = { at: 0, pids: [] };
  log(`请求启动 ComfyUI 服务：${t.python} main.py（cwd=${t.cwd}，日志 ${logFile}，启动器 ${useVbs ? launcherVbs : launcher}）`);

  // 兜底诊断：90s 后仍未就绪就把成因指向可查的两处（否则面板只会显示“不可达”，无从下手）
  setTimeout(async () => {
    if (backend.reachable) return;
    await probeBackend();
    if (backend.reachable) return;
    backendProc.lastError = "服务启动 90 秒后仍不可达：查 logs/backend.log 与计划任务 HanaComfyUI-Backend 的 Last Result";
    saveBackendState();
    warn(`ComfyUI 服务 90s 未就绪（见 ${logFile}）`);
  }, 90_000).unref?.();

  return {
    ok: true,
    accepted: true,
    install: t.install.path,
    python: t.python,
    mainPy: t.mainPy,
    cwd: t.cwd,
    launcher: useVbs ? launcherVbs : launcher,
    launcherCmd: launcher,
    hidden: useVbs,
    logFile,
    url: `http://${backend.host}:${backend.port}`,
  };
}

async function stopBackendService() {
  pidCache = { at: 0, pids: [] }; // 强制重查：不强依赖「可达」判断（端口有监听但 HTTP 不响时也要能撤）
  const pids = listeningPids();
  const stopped = [];
  const failed = [];
  for (const pid of pids) {
    const r = runExe("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 20_000);
    if (r.code === 0) stopped.push(pid);
    else failed.push({ pid, error: r.stderr || r.error || `exit ${r.code}` });
  }
  runExe("schtasks.exe", ["/delete", "/tn", BACKEND_TASK_NAME, "/f"], 15_000); // 顺手清理启动器任务
  await new Promise((r) => setTimeout(r, 800));
  await probeBackend();
  pidCache = { at: 0, pids: [] };
  backendProc.lastStop = { at: new Date().toISOString(), pids, stopped, alive: backend.reachable };
  backendProc.lastError = failed.length ? `部分进程未能终止：${JSON.stringify(failed)}` : null;
  saveBackendState();
  log(`停止 ComfyUI 服务：pids=${JSON.stringify(pids)} stopped=${JSON.stringify(stopped)} 仍可达=${backend.reachable}`);
  return { ok: !backend.reachable, pids, stopped, failed, alive: backend.reachable, already: pids.length === 0 };
}

// ── 主题同步（跨源下的宿主主题跟随）─────────────────────────────────────────
// 背景：工作区 iframe 直连 8188 后变成跨源（见 UI 注释），壳页再也摸不到 contentWindow，
// 于是把「写样式」改成「写信给 ComfyUI 服务端」：
//   ① Comfy.CustomColorPalettes.hana = { colors: { comfy_base, litegraph_base } } —— 面板/DOM + 画布/节点/连线
//   ② Comfy.ColorPalette = "hana" —— 选中它
// ComfyUI 的 POST /settings 是 {**settings, **new_settings} 合并写（app/app_settings.py 实测），
// 不会碰用户其他设置；色板由前端下次加载时读取，因此无需强刷正在编辑的画布。
// 键名与壳页 HANA_CSS_MAP / HANA_JS_MAP 同源（comfy_base / litegraph_base），直接复用。
const THEME_PALETTE_ID = "hana";

async function backendJsonOrNull(path, method = "GET", body = null) {
  if (!backend.reachable) return null;
  try {
    const res = await fetch(`http://${backend.host}:${backend.port}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: body ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      log(`[theme] 后端 ${method} ${path} → HTTP ${res.status}`);
      return null;
    }
    // 注意：ComfyUI 的 POST /settings 成功时返回 **200 空 body**（app_settings.py 里是
    // web.Response(status=200)，不带 JSON）。不能假设响应体是 JSON——早前用 res.json()
    // 解析空体失败被当成“写入失败”，导致色板其实写成功了、壳页却收到 502 而没去重载界面
    // （2026-09-25 据 relay.log 定位）。所以：空体 / 非 JSON 都视为成功。
    const text = (await res.text()).trim();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  } catch (e) {
    log(`[theme] 后端 ${method} ${path} 异常：${String((e && e.message) || e)}`);
    return null;
  }
}

async function applyThemeSettings(body) {
  if (!backend.reachable) {
    log("[theme] 写主题失败：后端不可达");
    return { ok: false, error: `后端 ${backend.host}:${backend.port} 不可达` };
  }
  const b = body && typeof body === "object" ? body : {};
  const colors = b.colors && typeof b.colors === "object" ? b.colors : null;
  const patch = {};
  if (colors) {
    const cur = await backendJsonOrNull("/api/settings");
    if (!cur) {
      log("[theme] 写主题失败：读取 /api/settings 未成功（后端未就绪 / 超时 / 非 2xx）");
      return { ok: false, error: "读取 ComfyUI 现有设置失败（后端未就绪或拒绝）" };
    }
    const existing = cur["Comfy.CustomColorPalettes"];
    const customs = existing && typeof existing === "object" ? { ...existing } : {};
    const def = {
      id: THEME_PALETTE_ID,
      name: "Hana（跟随宿主主题）",
      colors: {
        comfy_base: colors.comfy_base && typeof colors.comfy_base === "object" ? colors.comfy_base : {},
        litegraph_base: colors.litegraph_base && typeof colors.litegraph_base === "object" ? colors.litegraph_base : {},
        node_slot: colors.node_slot && typeof colors.node_slot === "object" ? colors.node_slot : {},
      },
    };
    if (typeof b.lightTheme === "boolean") def.light_theme = b.lightTheme;
    customs[THEME_PALETTE_ID] = def;
    patch["Comfy.CustomColorPalettes"] = customs;
    patch["Comfy.ColorPalette"] = THEME_PALETTE_ID;
  } else if (typeof b.palette === "string" && b.palette) {
    patch["Comfy.ColorPalette"] = b.palette; // 无细粒度配色时只跟随明暗（用 ComfyUI 内置色板）
  } else {
    return { ok: false, error: "需要 colors（自定义色板）或 palette（内置色板名）" };
  }
  const out = await backendJsonOrNull("/api/settings", "POST", patch);
  if (out === null) {
    log("[theme] 写主题失败：POST /api/settings 未接受（超时 / 非 2xx / 连接错误）");
    return { ok: false, error: "写入 ComfyUI 设置失败（后端未接受）" };
  }
  const d = colors && patch["Comfy.CustomColorPalettes"] ? patch["Comfy.CustomColorPalettes"][THEME_PALETTE_ID] : null;
  log(`主题已写入 ComfyUI 设置：palette=${patch["Comfy.ColorPalette"]}` +
    (d ? `（自定义色板 comfy_base=${Object.keys(d.colors.comfy_base).length} 项 litegraph_base=${Object.keys(d.colors.litegraph_base).length} 项）` : "（仅明暗）"));
  return {
    ok: true,
    applied: { palette: patch["Comfy.ColorPalette"], custom: !!d, comfyBaseKeys: d ? Object.keys(d.colors.comfy_base).length : 0 },
  };
}

// ── ComfyUI 本体更新（M11）──────────────────────────────────────────────
// 目标：源码安装的 ComfyUI 能在 App 里检查 / 执行更新（git pull + pip install -r requirements.txt）。
// 设计要点：
//   · 长任务（pip 可数分钟）必须后台跑 —— 用异步 spawn，绝不 spawnSync 卡住中继事件循环；
//   · 只用 git pull --ff-only：不产生 merge commit；本地有未提交改动会明确失败，不擅自处理；
//   · 更新前记录旧 commit（更新后一并记录），失败时把成因与回退线索写清楚；
//   · 更新前先停服务（pip 覆盖文件时 8188 进程占用会失败）；更新后**不自动起服务**。
const UPDATE_LOG_TAIL_MAX = 60;
const GIT_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 30 * 60_000;
const UPDATE_CHECK_TTL_MS = 60_000;

const updateProc = {
  running: false,
  phase: "idle",      // idle | stopping | fetching | pulling | installing | done | failed
  startedAt: null,
  finishedAt: null,
  before: null,       // { commit, describe, branch, dirty, dirtyDetail }
  after: null,
  steps: [],          // [{ name, ok, detail, at }]
  logTail: [],
  lastError: null,
};
let updateCheckCache = { at: 0, data: null };
let updateStateLoaded = false;

function updateStatePath() {
  const dir = logFilePath ? dirname(logFilePath) : process.cwd();
  return join(dir, "update-state.json");
}

function pushUpdateLog(line) {
  const s = String(line || "").replace(/\s+$/, "");
  if (!s) return;
  updateProc.logTail.push(s);
  if (updateProc.logTail.length > UPDATE_LOG_TAIL_MAX) {
    updateProc.logTail.splice(0, updateProc.logTail.length - UPDATE_LOG_TAIL_MAX);
  }
}

function saveUpdateState() {
  try {
    mkdirSync(dirname(updateStatePath()), { recursive: true });
    writeFileSync(updateStatePath(), JSON.stringify({ ...updateProc, savedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (e) { warn(`update-state 写入失败：${(e && e.message) || e}`); }
}

function loadUpdateState() {
  try {
    const raw = JSON.parse(readFileSync(updateStatePath(), "utf8"));
    Object.assign(updateProc, {
      running: false, // 进程已换，过期运行态不认
      phase: raw.phase === "done" || raw.phase === "failed" ? raw.phase : "idle",
      startedAt: raw.startedAt || null,
      finishedAt: raw.finishedAt || null,
      before: raw.before || null,
      after: raw.after || null,
      steps: Array.isArray(raw.steps) ? raw.steps.slice(-12) : [],
      logTail: Array.isArray(raw.logTail) ? raw.logTail.slice(-UPDATE_LOG_TAIL_MAX) : [],
      lastError: raw.lastError || null,
    });
  } catch { /* 首次运行没有状态文件，正常 */ }
}

// git 可执行文件：先 PATH，再常见安装位置（中继在宿主沙箱里，PATH 可能不全）
function resolveGit() {
  for (const exe of ["git.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]) {
    const r = runExe(exe, ["--version"], 8_000);
    if (r.code === 0) return { path: exe, version: r.stdout };
  }
  return null;
}

// 异步子进程（流式）：长任务专用。返回 { code, ok, tail }
function runStream(exe, args, { cwd = null, timeoutMs = GIT_TIMEOUT_MS, onLine = null } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    const keep = (chunk) => {
      for (const raw of String(chunk || "").split(/\r?\n/)) {
        const s = raw.replace(/\s+$/, "");
        if (!s) continue;
        if (lines.length < 40) lines.push(s); else lines[lines.length - 1] = s;
        pushUpdateLog(s);
        if (onLine) onLine(s);
      }
    };
    let child;
    try {
      child = spawn(exe, args, { cwd: cwd || undefined, windowsHide: true, env: CHILD_ENV });
    } catch (e) {
      return resolve({ code: -1, ok: false, tail: String((e && e.message) || e) });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      pushUpdateLog(`[超时] ${basename(exe)} 超过 ${Math.round(timeoutMs / 1000)}s，已终止`);
    }, timeoutMs);
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, ok: false, tail: String((e && e.message) || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, ok: code === 0, tail: lines.slice(-12).join("\n") }); });
  });
}

// 仓库信息（未跟踪文件不算 dirty，否则 requirements.core.txt 这类会一直报脏）
function gitInfo(git, repoDir) {
  const g = (args) => runExe(git, ["-C", repoDir, ...args], 15_000);
  const status = String(g(["status", "--porcelain"]).stdout || "");
  const dirtyLines = status.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("?? "));
  return {
    commit: g(["rev-parse", "--short", "HEAD"]).stdout || null,
    describe: g(["describe", "--tags", "--always"]).stdout || null,
    branch: g(["rev-parse", "--abbrev-ref", "HEAD"]).stdout || null,
    dirty: dirtyLines.length > 0,
    dirtyDetail: dirtyLines.slice(0, 5),
  };
}

// 更新上下文：ComfyUI 源码目录（git 仓库）+ venv python
function resolveUpdateContext() {
  const t = resolveLaunchTarget(null);
  if (!t.ok) return { ok: false, error: "未找到可更新的 ComfyUI 安装（缺 main.py 或缺 venv python）" };
  const git = resolveGit();
  if (!git) return { ok: false, error: "本机未找到 git 可执行文件（更新需要 Git）" };
  const repoDir = dirname(t.mainPy); // main.py 所在目录即源码根
  return { ok: true, git, repoDir, python: t.python, install: t.install, isRepo: existsSync(join(repoDir, ".git")) };
}

// 画布桥 token：custom_nodes/hana_bridge/.token 由 Python 侧首次加载时生成，中继读同一文件比对。
// 缓存 5s（路径探测要碰文件系统，没必要每次调用都做）。
let bridgeTokenCache = { at: 0, token: null };
function readBridgeToken() {
  if (Date.now() - bridgeTokenCache.at < 5_000) return bridgeTokenCache.token;
  let token = null;
  try {
    const t = resolveLaunchTarget(null);
    if (t.ok && t.mainPy) {
      const p = join(dirname(t.mainPy), "custom_nodes", "hana_bridge", ".token");
      if (existsSync(p)) token = readFileSync(p, "utf8").trim() || null;
    }
  } catch (e) {
    warn(`[bridge] 读取 token 失败：${String((e && e.message) || e)}`);
  }
  bridgeTokenCache = { at: Date.now(), token };
  return token;
}

// 检查更新（fetch + 比较；带 TTL 缓存，避免 UI 反复触发网络）
async function checkUpdate(force = false) {
  if (!force && updateCheckCache.data && Date.now() - updateCheckCache.at < UPDATE_CHECK_TTL_MS) return updateCheckCache.data;
  const ctx = resolveUpdateContext();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const local = gitInfo(ctx.git.path, ctx.repoDir);
  if (!ctx.isRepo) {
    const out = { ok: true, isGit: false, note: "该安装不是 Git 仓库（便携包 / 手工解压），App 无法代为更新", local, checkedAt: new Date().toISOString() };
    updateCheckCache = { at: Date.now(), data: out };
    return out;
  }
  const f = await runStream(ctx.git.path, ["-C", ctx.repoDir, "fetch", "--prune", "origin"], { timeoutMs: GIT_TIMEOUT_MS });
  if (!f.ok) {
    const out = { ok: false, isGit: true, local, error: `git fetch 失败：${f.tail}`, checkedAt: new Date().toISOString() };
    updateCheckCache = { at: Date.now(), data: out };
    return out;
  }
  const g = (args) => runExe(ctx.git.path, ["-C", ctx.repoDir, ...args], 20_000);
  const branch = local.branch || "master";
  const remoteRef = `origin/${branch}`;
  const behind = Number(g(["rev-list", "--count", `HEAD..${remoteRef}`]).stdout || 0) || 0;
  const ahead = Number(g(["rev-list", "--count", `${remoteRef}..HEAD`]).stdout || 0) || 0;
  const out = {
    ok: true,
    isGit: true,
    repoDir: ctx.repoDir,
    git: { path: ctx.git.path, version: ctx.git.version },
    local,
    remote: {
      ref: remoteRef,
      commit: g(["rev-parse", "--short", remoteRef]).stdout || null,
      describe: g(["describe", "--tags", "--always", remoteRef]).stdout || null,
    },
    behind,
    ahead,
    upToDate: behind === 0,
    checkedAt: new Date().toISOString(),
  };
  updateCheckCache = { at: Date.now(), data: out };
  return out;
}

// 执行更新（后台；结果不在这里返回，进度看 status）
function startUpdateJob() {
  if (updateProc.running) return { accepted: false, reason: "already-running", phase: updateProc.phase };
  const ctx = resolveUpdateContext();
  if (!ctx.ok) return { accepted: false, reason: ctx.error };
  if (!ctx.isRepo) return { accepted: false, reason: "该安装不是 Git 仓库（便携包），无法代为更新" };

  updateProc.running = true;
  updateProc.phase = "stopping";
  updateProc.startedAt = new Date().toISOString();
  updateProc.finishedAt = null;
  updateProc.steps = [];
  updateProc.logTail = [];
  updateProc.lastError = null;
  updateProc.after = null;
  updateProc.before = gitInfo(ctx.git.path, ctx.repoDir);
  updateStateLoaded = true;
  saveUpdateState();
  log(`开始更新 ComfyUI：repo=${ctx.repoDir} 当前=${updateProc.before.describe || updateProc.before.commit}`);

  const step = (name, ok, detail) => {
    updateProc.steps.push({ name, ok: !!ok, detail: detail ? String(detail).slice(0, 400) : null, at: new Date().toISOString() });
    if (!ok) updateProc.lastError = `${name}：${detail || "失败"}`;
    saveUpdateState();
  };

  void (async () => {
    try {
      // 1) 停服务：pip 覆盖文件时被占用会失败，务必先停
      if (backend.reachable) {
        pushUpdateLog("停 ComfyUI 服务（更新期间必须停止）…");
        const s = await stopBackendService();
        step("停止服务", s.ok, s.ok ? null : `仍有进程存活：${JSON.stringify(s.failed || [])}`);
        if (!s.ok) throw new Error("停止服务失败，已中止更新（避免文件占用导致半更新）");
      } else {
        step("停止服务", true, "服务本来就没在跑");
      }
      // 2) fetch
      updateProc.phase = "fetching"; saveUpdateState();
      pushUpdateLog("git fetch --prune origin …");
      const f = await runStream(ctx.git.path, ["-C", ctx.repoDir, "fetch", "--prune", "origin"], { timeoutMs: GIT_TIMEOUT_MS });
      step("抓取远端", f.ok, f.ok ? null : f.tail);
      if (!f.ok) throw new Error("git fetch 失败（网络或镜像不可用）");
      // 3) pull --ff-only
      updateProc.phase = "pulling"; saveUpdateState();
      pushUpdateLog("git pull --ff-only …");
      const p = await runStream(ctx.git.path, ["-C", ctx.repoDir, "pull", "--ff-only"], { timeoutMs: GIT_TIMEOUT_MS });
      step("拉取更新", p.ok, p.tail);
      if (!p.ok) throw new Error("git pull --ff-only 失败：本地可能有未提交改动或历史分叉（不擅自 merge/reset，请人工处理后重试）");
      // 4) pip install -r requirements.txt
      updateProc.phase = "installing"; saveUpdateState();
      pushUpdateLog("pip install -r requirements.txt …（可能数分钟）");
      const i = await runStream(ctx.python, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: ctx.repoDir, timeoutMs: PIP_TIMEOUT_MS });
      step("安装依赖", i.ok, i.tail);
      if (!i.ok) throw new Error("pip install 失败（依赖可能处于半更新状态，请按日志处理后再启动服务）");
      updateProc.after = gitInfo(ctx.git.path, ctx.repoDir);
      updateProc.phase = "done";
      step("完成", true, `${updateProc.before?.describe || "?"} → ${updateProc.after?.describe || "?"}`);
      log(`ComfyUI 更新完成：${updateProc.before?.commit} → ${updateProc.after?.commit}`);
      updateCheckCache = { at: 0, data: null };
    } catch (e) {
      updateProc.phase = "failed";
      if (!updateProc.lastError) updateProc.lastError = String((e && e.message) || e);
      logErr(`ComfyUI 更新失败：${updateProc.lastError}`);
    } finally {
      updateProc.running = false;
      updateProc.finishedAt = new Date().toISOString();
      saveUpdateState();
    }
  })();

  return { accepted: true, phase: updateProc.phase, before: updateProc.before, repoDir: ctx.repoDir, python: ctx.python };
}

function updateStatusPayload() {
  if (!updateStateLoaded) { updateStateLoaded = true; loadUpdateState(); }
  return {
    ok: true,
    running: updateProc.running,
    phase: updateProc.phase,
    startedAt: updateProc.startedAt,
    finishedAt: updateProc.finishedAt,
    before: updateProc.before,
    after: updateProc.after,
    steps: updateProc.steps,
    lastError: updateProc.lastError,
    logTail: updateProc.logTail.slice(-24),
    hint: "失败后可人工在仓库目录用 git 处理；pip 装过的新依赖不会自动回退。更新完成后需要重新启动 ComfyUI 服务。",
  };
}

function backendProcPayload() {
  return {
    taskName: BACKEND_TASK_NAME,
    startedAt: backendProc.startedAt,
    install: backendProc.install,
    python: backendProc.python,
    mainPy: backendProc.mainPy,
    launcher: backendProc.launcher,
    logFile: backendProc.logFile,
    pids: listeningPids(), // 始终查（5s 缓存）：启动中/未就绪时也能看到进程是否已起来
    lastError: backendProc.lastError,
    lastStop: backendProc.lastStop,
  };
}

function startMetricsSampler() {
  sampleCpu(); // 建立首帧基线（下一次采样才有 usagePct）
  refreshGpu();
  const t = setInterval(() => {
    sampleCpu();
    if (Date.now() - gpuCache.at > GPU_CACHE_MS) refreshGpu();
  }, CPU_SAMPLE_MS);
  t.unref?.();
}

// ── 安装位置候选（盘位探测）─────────────────────────────────────────────────
// 供 App 引导弹窗：列出各盘剩余空间与可写性，给出推荐的 <盘>:\ComfyUI。
// fs.statfsSync 在 Windows 可用（Node 18+）；写权限用 accessSync(W_OK) 探。
const MIN_FREE_GB = 30; // ComfyUI 程序 + 依赖 ≈ 6GB，模型另算；低于此值不建议作为安装盘

function driveTargets() {
  const targets = [];
  const sysDrive = (process.env.SystemRoot || "C:\\").slice(0, 2).toUpperCase();
  if (process.platform === "win32") {
    for (const d of ["C", "D", "E", "F", "G", "H"]) {
      const root = `${d}:\\`;
      if (!existsSync(root)) continue;
      let freeGB = null, totalGB = null, writable = false;
      try {
        const st = statfsSync(root);
        freeGB = Math.round(((st.bsize * st.bavail) / 1073741824) * 10) / 10;
        totalGB = Math.round(((st.bsize * st.blocks) / 1073741824) * 10) / 10;
      } catch { /* 读不到空间 */ }
      try { accessSync(root, fsConstants.W_OK); writable = true; } catch { writable = false; }
      targets.push({
        path: `${d}:\\ComfyUI`,
        label: `${d} 盘`,
        freeGB, totalGB, writable,
        isSystem: root.slice(0, 2).toUpperCase() === sysDrive,
        exists: existsSync(`${d}:\\ComfyUI`),
      });
    }
  }
  // 用户目录候选（永远可写，兜底）
  const home = realHome();
  if (home) {
    const homeTarget = join(home, "ComfyUI");
    if (!targets.some((t) => t.path === homeTarget)) {
      let homeFree = null;
      try {
        const st = statfsSync(home);
        homeFree = Math.round(((st.bsize * st.bavail) / 1073741824) * 10) / 10;
      } catch { /* 忽略 */ }
      targets.push({ path: homeTarget, label: "用户目录", freeGB: homeFree, totalGB: null, writable: true, isSystem: false, exists: existsSync(homeTarget), fallback: true });
    }
  }
  // 推荐：可写 + 非系统盘 + 空间充足 → 空间最大者；否则退系统盘；再退用户目录
  const pick = (list) => list.filter((t) => t.writable && t.freeGB !== null && t.freeGB >= MIN_FREE_GB).sort((a, b) => b.freeGB - a.freeGB);
  let best = pick(targets.filter((t) => !t.isSystem && !t.fallback))[0];
  if (!best) best = pick(targets.filter((t) => !t.fallback))[0];
  if (!best) best = targets.find((t) => t.fallback);
  if (best) best.recommended = true;
  return { ok: true, platform: process.platform, minFreeGB: MIN_FREE_GB, targets };
}

async function probeQueue() {
  if (Date.now() - queueAt < QUEUE_CACHE_MS && queueInfo) return;
  try {
    const res = await fetch(`http://${backend.host}:${backend.port}/queue`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object") {
      const running = Array.isArray(data.queue_running) ? data.queue_running.length : Number(data.queue_running) || 0;
      const pending = Array.isArray(data.queue_pending) ? data.queue_pending.length : Number(data.queue_pending) || 0;
      queueInfo = { running, pending };
      queueAt = Date.now();
    }
  } catch {
    /* 队列探测失败不影响状态出口（reachable 由 probeBackend 维护） */
  }
}

// ── 进度事件缓存（订阅后端 /ws）─────────────────────────────────────────────
// 只做"最近事件 → prompt 状态"的只读聚合，供 App 侧轮询；不改变任何后端行为。
const promptStore = new Map(); // promptId -> record
const wsEvents = { connected: false, lastEventAt: 0, lastError: null, everConnected: false, queueRemaining: null, byType: Object.create(null), count: 0 };
let wsRetryTimer = null;
let wsStopped = false;

function promptRec(id) {
  let r = promptStore.get(id);
  if (!r) {
    r = {
      promptId: id,
      state: "unknown", // unknown | running | completed | error | interrupted
      firstSeenAt: Date.now(),
      lastEventAt: 0,
      startedAt: null,
      finishedAt: null,
      nodesDone: 0,
      cached: 0,
      currentNode: null,
      progress: null,
      outputs: [],
      error: null,
      events: [],
    };
    promptStore.set(id, r);
    prunePrompts();
  }
  return r;
}

function pushEvent(r, type, summary) {
  r.events.push({ t: Date.now(), type, ...(summary ? { summary } : {}) });
  if (r.events.length > 40) r.events.shift();
}

function prunePrompts() {
  if (promptStore.size <= PROMPT_MAX_RECORDS) return;
  const now = Date.now();
  const terminal = [];
  for (const r of promptStore.values()) {
    if (r.finishedAt && now - r.finishedAt > PROMPT_KEEP_TERMINAL_MS) terminal.push(r.promptId);
  }
  for (const id of terminal) promptStore.delete(id);
  while (promptStore.size > PROMPT_MAX_RECORDS) {
    let oldest = null;
    for (const r of promptStore.values()) {
      if (r.state === "running") continue;
      if (!oldest || r.lastEventAt < oldest.lastEventAt) oldest = r;
    }
    if (!oldest) break;
    promptStore.delete(oldest.promptId);
  }
}

function handleBackendEvent(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  const t = typeof msg.type === "string" ? msg.type : "unknown";
  wsEvents.count += 1;
  wsEvents.byType[t] = (wsEvents.byType[t] || 0) + 1;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  switch (t) {
    case "status": {
      const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : null;
      if (typeof q === "number") wsEvents.queueRemaining = q;
      break;
    }
    case "execution_start": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.state = "running";
      r.startedAt = r.startedAt || Date.now();
      r.lastEventAt = Date.now();
      pushEvent(r, "execution_start", "");
      break;
    }
    case "execution_cached": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      if (Array.isArray(d.nodes)) r.cached = d.nodes.length;
      r.lastEventAt = Date.now();
      pushEvent(r, "execution_cached", `${r.cached} 节点命中缓存`);
      break;
    }
    case "executing": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.lastEventAt = Date.now();
      if (d.node === null || d.node === undefined) {
        r.currentNode = null; // 主体执行结束，等待 history 收尾
      } else {
        r.currentNode = d.node;
        r.state = "running";
        r.startedAt = r.startedAt || Date.now();
      }
      break;
    }
    case "progress": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      if (typeof d.value === "number" && typeof d.max === "number") {
        r.progress = { value: d.value, max: d.max, node: d.node !== undefined ? d.node : null };
      }
      if (d.node !== undefined) r.currentNode = d.node;
      r.state = r.state === "unknown" ? "running" : r.state;
      r.lastEventAt = Date.now();
      break;
    }
    case "executed": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.nodesDone += 1;
      r.lastEventAt = Date.now();
      if (d.output && typeof d.output === "object") {
        for (const v of Object.values(d.output)) {
          if (!Array.isArray(v)) continue;
          for (const item of v) {
            if (item && typeof item === "object" && typeof item.filename === "string") {
              r.outputs.push({
                filename: item.filename,
                subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
                type: typeof item.type === "string" ? item.type : "output",
                node: d.node !== undefined ? d.node : null,
              });
            }
          }
        }
      }
      break;
    }
    case "execution_error": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.state = "error";
      r.finishedAt = Date.now();
      r.lastEventAt = Date.now();
      r.error = {
        node: d.node_id !== undefined ? d.node_id : null,
        type: d.exception_type || null,
        message: d.exception_message || "执行错误",
      };
      pushEvent(r, "execution_error", String(r.error.message).slice(0, 200));
      break;
    }
    case "execution_interrupted": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.state = "interrupted";
      r.finishedAt = Date.now();
      r.lastEventAt = Date.now();
      pushEvent(r, "execution_interrupted", "");
      break;
    }
    case "execution_success": {
      if (typeof d.prompt_id !== "string") break;
      const r = promptRec(d.prompt_id);
      r.state = "completed";
      r.finishedAt = Date.now();
      r.lastEventAt = Date.now();
      pushEvent(r, "execution_success", "");
      break;
    }
    default:
      break;
  }
}

function startBackendEvents() {
  if (typeof WebSocket !== "function") {
    wsEvents.lastError = "global WebSocket unavailable";
    warn("当前 Node 无全局 WebSocket，跳过后端 /ws 事件订阅（进度聚合降级）");
    return;
  }
  const connect = () => {
    if (wsStopped) return;
    let ws;
    try {
      ws = new WebSocket(`ws://${backend.host}:${backend.port}/ws?clientId=${encodeURIComponent((config && config.clientId) || "comfyui-relay")}`);
    } catch (e) {
      wsEvents.lastError = String((e && e.message) || e);
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      wsEvents.connected = true;
      wsEvents.lastError = null;
      if (!wsEvents.everConnected) {
        wsEvents.everConnected = true;
        log("已订阅后端 /ws（进度事件缓存就绪）");
      }
    });
    ws.addEventListener("message", (ev) => {
      wsEvents.lastEventAt = Date.now();
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data) {
        try { handleBackendEvent(data); } catch { /* 单条消息解析失败不影响订阅 */ }
      }
    });
    ws.addEventListener("close", () => {
      wsEvents.connected = false;
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      wsEvents.lastError = "websocket error";
      try { ws.close(); } catch { /* 忽略 */ }
    });
  };
  const scheduleReconnect = () => {
    if (wsStopped || wsRetryTimer) return;
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      connect();
    }, WS_RETRY_MS);
    wsRetryTimer.unref?.();
  };
  connect();
}

function promptRecordOut(r) {
  return {
    promptId: r.promptId,
    state: r.state,
    firstSeenAt: r.firstSeenAt,
    lastEventAt: r.lastEventAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    nodesDone: r.nodesDone,
    cached: r.cached,
    currentNode: r.currentNode,
    progress: r.progress,
    outputs: r.outputs,
    error: r.error,
    events: r.events.slice(-20),
  };
}

function promptsPayload() {
  const active = [];
  const recent = [];
  for (const r of promptStore.values()) {
    const out = promptRecordOut(r);
    if (r.state === "running" || r.state === "unknown") active.push(out);
    else recent.push(out);
  }
  active.sort((a, b) => b.lastEventAt - a.lastEventAt);
  recent.sort((a, b) => (b.finishedAt || b.lastEventAt) - (a.finishedAt || a.lastEventAt));
  return {
    ok: true,
    ws: {
      connected: wsEvents.connected,
      lastEventAt: wsEvents.lastEventAt || null,
      lastError: wsEvents.lastError,
      queueRemaining: wsEvents.queueRemaining,
    },
    active: active.slice(0, 20),
    recent: recent.slice(0, 30),
    tracked: promptStore.size,
  };
}

function statusPayload() {
  return {
    ok: true,
    relay: {
      port: servingPort,
      mode: config ? config.mode : "unknown",
      pid: process.pid,
      startedAt: new Date(stats.startedAtMs).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      ready: true,
      stripSurfaceCount,
      stripQueryCount,
      logFile: logFilePath,
    },
    backend: {
      url: `http://${backend.host}:${backend.port}`,
      reachable: backend.reachable,
      checkedAt: backend.checkedAt ? new Date(backend.checkedAt).toISOString() : null,
      lastError: backend.lastError,
      system: backend.system,
      proc: backendProcPayload(),
    },
    queue: queueInfo,
    events: {
      connected: wsEvents.connected,
      lastEventAt: wsEvents.lastEventAt || null,
      promptsTracked: promptStore.size,
      count: wsEvents.count,
      byType: { ...wsEvents.byType },
    },
    requests: {
      total: stats.total,
      byMethod: { ...stats.byMethod },
      ws: stats.ws,
      wsActive: stats.wsActive,
      errors: stats.errors,
      active: stats.active,
    },
    // 安装探测：总是附带（TTL 15s 缓存，成本可忽略）。壳页用它分流「装了没跑 / 未检测到」；
    // App 用它取安装根做产物定位（不硬编码本机路径）。
    env: probeEnv(),
  };
}

// ── HTTP 反代 ──────────────────────────────────────────────────────────────
function bumpMethod(method) {
  const key = TRACKED_METHODS.has(method) ? method : "OTHER";
  stats.byMethod[key] = (stats.byMethod[key] || 0) + 1;
}

function jsonOut(res, status, body, method = "GET") {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  if (method === "HEAD") res.end(); else res.end(text);
}

function proxyHttp(req, res) {
  stats.total += 1;
  bumpMethod(req.method || "GET");
  stats.active += 1;
  const startedMs = Date.now();
  const target = sanitizeTarget(req.url);
  let finished = false;
  let clientGone = false;
  const done = () => {
    if (finished) return;
    finished = true;
    stats.active -= 1;
    if (config && config.logRequests) {
      log(`${req.method} ${key2(target)} → ${res.statusCode} ${Date.now() - startedMs}ms`);
    }
  };

  const headers = filterHeaders(req.rawHeaders, { backendHost: backend.host, backendPort: backend.port });
  const upstream = http.request({
    host: backend.host,
    port: backend.port,
    method: req.method,
    path: target,
    headers,
  });

  if (config && config.upstreamTimeoutMs > 0) {
    upstream.setTimeout(config.upstreamTimeoutMs, () => upstream.destroy(new Error(`upstream timeout ${config.upstreamTimeoutMs}ms`)));
  }

  upstream.on("response", (upRes) => {
    if (clientGone || res.destroyed) {
      upRes.destroy();
      done();
      return;
    }
    res.writeHead(upRes.statusCode || 502, copyResponseHeaders(upRes.rawHeaders));
    upRes.pipe(res);
    upRes.on("end", done);
    upRes.on("error", (e) => {
      stats.errors += 1;
      warn(`后端响应流错误：${e && e.message ? e.message : e}`);
      done();
    });
  });

  upstream.on("error", (e) => {
    stats.errors += 1;
    if (!clientGone) markBackendDown(String((e && e.code) || (e && e.message) || e));
    if (!clientGone && !res.destroyed) {
      if (!res.headersSent) {
        jsonOut(res, 502, {
          error: "comfy-relay: ComfyUI 后端不可达",
          code: "BACKEND_UNREACHABLE",
          detail: `${(e && e.code) || ""} ${(e && e.message) || ""}`.trim(),
        });
      } else {
        res.destroy();
      }
    }
    done();
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { upstream.destroy(); } catch { /* 忽略 */ }
    }
  });
  res.on("error", (e) => {
    // 客户端连接异常（如 iframe 被关）：不当成后端故障
    clientGone = true;
    warn(`客户端响应流出错：${e && e.message ? e.message : e}`);
    try { upstream.destroy(); } catch { /* 忽略 */ }
  });
  req.on("error", (e) => {
    clientGone = true;
    warn(`客户端请求流出错：${e && e.message ? e.message : e}`);
    try { upstream.destroy(); } catch { /* 忽略 */ }
  });

  req.pipe(upstream);
}

// ── WebSocket 升级反代 ─────────────────────────────────────────────────────
function proxyUpgrade(req, clientSocket, head) {
  stats.total += 1;
  stats.ws += 1;
  const target = sanitizeTarget(req.url);
  const openedAt = Date.now();
  let established = false;
  let closed = false;

  const upstream = net.connect(backend.port, backend.host);
  upstream.setNoDelay(true);
  clientSocket.setNoDelay(true);

  const bail = (why) => {
    if (closed) return;
    closed = true;
    if (established) {
      stats.wsActive = Math.max(0, stats.wsActive - 1);
      log(`WS ${key2(req.url)} 关闭（${Date.now() - openedAt}ms${why ? " · " + why : ""}，active ${stats.wsActive}）`);
    } else if (why) {
      warn(`WS ${key2(req.url)} 未建立：${why}`);
    }
    try { upstream.destroy(); } catch { /* 忽略 */ }
    try { clientSocket.destroy(); } catch { /* 忽略 */ }
  };

  const handshakeTimer = setTimeout(() => bail("上游握手超时"), WS_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  const headers = filterHeaders(req.rawHeaders, {
    forUpgrade: true,
    backendHost: backend.host,
    backendPort: backend.port,
  });
  const headerLines = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) headerLines.push(`${name}: ${v}`);
    else headerLines.push(`${name}: ${value}`);
  }

  upstream.on("connect", () => {
    upstream.write(`GET ${target} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
  });

  let buf = Buffer.alloc(0);
  const onUpstreamData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) {
      if (buf.length > 64 * 1024) bail("上游握手响应头过长");
      return;
    }
    upstream.off("data", onUpstreamData);
    clearTimeout(handshakeTimer);
    const headBytes = buf.subarray(0, idx + 4);
    const tailBytes = buf.subarray(idx + 4);
    const statusLine = headBytes.toString("latin1").split("\r\n", 1)[0];
    const is101 = /^HTTP\/1\.[01] 101(\s|$)/.test(statusLine);
    clientSocket.write(headBytes);
    if (tailBytes.length) clientSocket.write(tailBytes);
    if (is101) {
      established = true;
      stats.wsActive += 1;
      log(`WS ${key2(req.url)} 已建立（active ${stats.wsActive}）→ ${backend.host}:${backend.port}`);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.on("close", () => bail());
      clientSocket.on("close", () => bail());
      upstream.on("error", (e) => bail(`上游错误 ${(e && e.message) || e}`));
      clientSocket.on("error", (e) => bail(`客户端错误 ${(e && e.message) || e}`));
    } else {
      // 非 101：按普通响应透传并收尾
      warn(`WS ${key2(req.url)} 上游拒绝升级：${statusLine}`);
      upstream.pipe(clientSocket);
      upstream.on("close", () => { try { clientSocket.end(); } catch { /* 忽略 */ } });
      clientSocket.on("close", () => { try { upstream.destroy(); } catch { /* 忽略 */ } });
    }
  };
  upstream.on("data", onUpstreamData);
  upstream.on("error", (e) => bail(`上游连接错误 ${(e && e.message) || e}`));
  clientSocket.on("error", (e) => bail(`客户端错误 ${(e && e.message) || e}`));
  clientSocket.on("close", () => { if (!established) bail(); });
}

// ── 管理端点辅助 ────────────────────────────────────────────────────────────
function collectOutputs(outputsObj) {
  const out = [];
  if (!outputsObj || typeof outputsObj !== "object") return out;
  for (const [nodeId, v] of Object.entries(outputsObj)) {
    if (!v || typeof v !== "object") continue;
    for (const [kind, arr] of Object.entries(v)) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item && typeof item === "object" && typeof item.filename === "string") {
          out.push({
            node: nodeId,
            kind,
            filename: item.filename,
            subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
            type: typeof item.type === "string" ? item.type : "output",
          });
          if (out.length >= 200) return out;
        }
      }
    }
  }
  return out;
}

function trimHistoryEntry(promptId, entry) {
  const status = entry && entry.status && typeof entry.status === "object" ? entry.status : {};
  let error = null;
  if (Array.isArray(status.messages)) {
    for (const m of status.messages) {
      if (Array.isArray(m) && typeof m[0] === "string" && /error|interrupt/i.test(m[0])) {
        const info = m[1] && typeof m[1] === "object" ? m[1] : {};
        error = {
          type: m[0],
          message: typeof info.exception_message === "string" ? info.exception_message : (typeof info.message === "string" ? info.message : m[0]),
          node: info.node_id !== undefined ? info.node_id : null,
        };
      }
    }
  }
  return {
    promptId,
    completed: status.completed === true,
    status: typeof status.status_str === "string" ? status.status_str : null,
    error,
    outputs: collectOutputs(entry && entry.outputs),
  };
}

async function handleHistory(req, res) {
  const url = new URL(String(req.url || "/"), "http://relay.invalid");
  const id = url.searchParams.get("id");
  const max = Math.min(20, Math.max(1, Number(url.searchParams.get("max")) || 8));
  try {
    const target = id ? `http://${backend.host}:${backend.port}/history/${encodeURIComponent(id)}` : `http://${backend.host}:${backend.port}/history`;
    const up = await fetch(target, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!up.ok) return jsonOut(res, 502, { ok: false, error: `后端 /history HTTP ${up.status}` });
    const data = await up.json().catch(() => null);
    if (!data || typeof data !== "object") return jsonOut(res, 502, { ok: false, error: "后端 /history 返回非对象" });
    const entries = Object.entries(data).map(([pid, e]) => trimHistoryEntry(pid, e));
    return jsonOut(res, 200, { ok: true, count: entries.length, entries: id ? entries : entries.slice(0, max) });
  } catch (e) {
    return jsonOut(res, 502, { ok: false, error: String((e && e.message) || e) });
  }
}

function controlOk(req) {
  if (!config || !config.controlKey) return true; // 未配置密钥时开放（启动时已 warn）
  const got = req.headers["x-comfy-relay-key"];
  if (typeof got !== "string" || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(config.controlKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBodyJson(req, limit = JSON_BODY_MAX_BYTES) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error(`请求体超过 ${Math.round(limit / 1024)} KiB 上限`);
    chunks.push(c);
  }
  if (n === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeStat(p) {
  try {
    const st = statSync(p);
    return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { exists: false, isFile: false, isDirectory: false, size: null, mtimeMs: null, code: (e && e.code) || null };
  }
}

async function handleFsRead(req, res) {
  let body;
  try { body = await readBodyJson(req); } catch (e) { return jsonOut(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  const p = typeof body.path === "string" ? body.path.trim() : "";
  if (!p) return jsonOut(res, 400, { ok: false, error: "需要 path" });
  const st = safeStat(p);
  if (!st.exists || !st.isFile) return jsonOut(res, 404, { ok: false, error: `文件不存在或不是普通文件：${p}`, stat: st });
  if (st.size > FS_READ_MAX_BYTES) return jsonOut(res, 413, { ok: false, error: `文件超过 ${FS_READ_MAX_BYTES} 字节上限`, size: st.size });
  try {
    const buf = readFileSync(p);
    const encoding = body.encoding === "base64" ? "base64" : "utf8";
    log(`fs/read ${key2(p)}（${st.size} B, ${encoding}）`);
    if (encoding === "base64") return jsonOut(res, 200, { ok: true, size: st.size, encoding, base64: buf.toString("base64") });
    return jsonOut(res, 200, { ok: true, size: st.size, encoding: "utf8", text: buf.toString("utf8") });
  } catch (e) {
    return jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

async function handleFsStat(req, res) {
  let body;
  try { body = await readBodyJson(req); } catch (e) { return jsonOut(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  const p = typeof body.path === "string" ? body.path.trim() : "";
  if (!p) return jsonOut(res, 400, { ok: false, error: "需要 path" });
  return jsonOut(res, 200, { ok: true, path: p, stat: safeStat(p) });
}

async function handleUpload(req, res) {
  let body;
  try { body = await readBodyJson(req); } catch (e) { return jsonOut(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  const p = typeof body.path === "string" ? body.path.trim() : "";
  if (!p) return jsonOut(res, 400, { ok: false, error: "需要 path（本机图片文件）" });
  const st = safeStat(p);
  if (!st.exists || !st.isFile) return jsonOut(res, 404, { ok: false, error: `文件不存在或不是普通文件：${p}` });
  if (st.size > UPLOAD_MAX_BYTES) return jsonOut(res, 413, { ok: false, error: `文件超过 ${UPLOAD_MAX_BYTES} 字节上限`, size: st.size });
  let buf;
  try { buf = readFileSync(p); } catch (e) { return jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  const filename = basename(p);
  const mime = MIME_BY_EXT[extname(p).toLowerCase()] || "application/octet-stream";
  try {
    const form = new FormData();
    form.append("image", new Blob([buf], { type: mime }), filename);
    if (typeof body.subfolder === "string" && body.subfolder) form.append("subfolder", body.subfolder);
    form.append("type", typeof body.type === "string" && body.type ? body.type : "input");
    if (body.overwrite === true) form.append("overwrite", "true");
    const up = await fetch(`http://${backend.host}:${backend.port}/upload/image`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await up.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
    log(`upload ${key2(filename)}（${st.size} B → HTTP ${up.status}）`);
    return jsonOut(res, up.ok ? 200 : 502, {
      ok: up.ok,
      status: up.status,
      ...(parsed && typeof parsed === "object" ? { result: parsed } : { text: text.slice(0, 500) }),
    });
  } catch (e) {
    stats.errors += 1;
    return jsonOut(res, 502, { ok: false, error: `上传到后端失败：${String((e && e.message) || e)}` });
  }
}

// ── 服务器 ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathOnly = String(req.url || "/").split("?", 1)[0];
  if (pathOnly === "/_relay/status") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    void (async () => {
      const force = /[?&]probe=1(&|$)/.test(String(req.url || ""));
      if (force || Date.now() - backend.checkedAt > PROBE_INTERVAL_MS) await probeBackend();
      if (backend.reachable) await probeQueue();
      jsonOut(res, 200, statusPayload(), req.method);
    })();
    return;
  }
  if (pathOnly === "/_relay/health") {
    jsonOut(res, 200, { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) }, req.method);
    return;
  }
  if (pathOnly === "/_relay/metrics") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    jsonOut(res, 200, metricsPayload(), req.method);
    return;
  }
  if (pathOnly === "/_relay/env") {
    // 诊断（只读）：受管 runtime 的环境被宿主裁剪/重写过，这里导出关键变量与推断结果供排错
    jsonOut(res, 200, {
      ok: true,
      platform: process.platform,
      homedir: homedir(),
      realHome: realHome(),
      userprofile: process.env.USERPROFILE || null,
      home: process.env.HOME || null,
      homedrive: process.env.HOMEDRIVE || null,
      homepath: process.env.HOMEPATH || null,
      appdata: process.env.APPDATA || null,
      localappdata: process.env.LOCALAPPDATA || null,
      cwd: process.cwd(),
      hanaHome: process.env.HANA_HOME || null,
      envHomeKeys: Object.keys(process.env).filter((k) => /HOME|USER|HANA/i.test(k)),
    }, req.method);
    return;
  }
  if (pathOnly === "/_relay/userdata") {
    // 代读后端 userdata 文件。存在的理由：App 侧经宿主 ctx.runtime.fetch 发起请求，
    // 其校验禁止 pathname 含编码斜杠（/userdata/workflows%2Fxxx.json 会被拒），
    // 而 ComfyUI 的 /userdata/{file} 路由又必须把斜杠编成 %2F。中继走 node:http，不受此限。
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    const uq = new URL(String(req.url || "/"), "http://relay.invalid");
    const file = (uq.searchParams.get("file") || "").trim();
    if (!file) {
      jsonOut(res, 400, { ok: false, error: "缺少 file 参数" }, req.method);
      return;
    }
    const upPath = `/userdata/${encodeURIComponent(file)}`;
    void (async () => {
      try {
        const out = await new Promise((resolve, reject) => {
          const up = http.request({
            host: backend.host,
            port: backend.port,
            method: "GET",
            path: upPath,
            headers: { accept: "*/*", host: `${backend.host}:${backend.port}` },
          }, (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
          });
          up.on("error", reject);
          up.setTimeout(15_000, () => up.destroy(new Error("upstream timeout")));
          up.end();
        });
        if (out.status !== 200) {
          jsonOut(res, 502, { ok: false, error: `后端 /userdata HTTP ${out.status}` }, req.method);
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": out.body.length });
        if (req.method === "HEAD") res.end(); else res.end(out.body);
      } catch (e) {
        jsonOut(res, 502, { ok: false, error: String((e && e.message) || e) }, req.method);
      }
    })();
    return;
  }
  if (pathOnly === "/_relay/drives") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    jsonOut(res, 200, driveTargets(), req.method);
    return;
  }
  if (pathOnly === "/_relay/custom-roots") {
    if (req.method === "GET" || req.method === "HEAD") {
      jsonOut(res, 200, { ok: true, roots: customRoots }, req.method);
      return;
    }
    if (req.method === "POST") {
      if (!controlOk(req)) {
        jsonOut(res, 403, { error: "comfy-relay: control key required" });
        return;
      }
      void (async () => {
        try {
          const body = await readBodyJson(req);
          const roots = Array.isArray(body && body.roots)
            ? body.roots.filter((r) => typeof r === "string" && r.trim()).slice(0, 8).map((r) => r.trim())
            : [];
          customRoots = roots;
          envProbe.at = 0; // 立即失效探测缓存，下一次状态读取就能看到新位置
          log(`custom-roots 更新：${customRoots.length ? customRoots.join(" | ") : "（清空）"}`);
          jsonOut(res, 200, { ok: true, roots: customRoots }, req.method);
        } catch (e) {
          jsonOut(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      })();
      return;
    }
    jsonOut(res, 405, { error: "method not allowed" }, req.method);
    return;
  }
  if (pathOnly === "/_relay/bridge") {
    // 画布桥（只读阶段）：转发到 ComfyUI 里 hana_bridge 注册的同源路由。
    // 为何不直连前端：ComfyUI 的 CSP 是 connect-src 'self' data:（server.py），前端连不出 8188。
    // 所以链路是：中继 → 8188 /api/hana_bridge/call → send_sync → 前端扩展 → 同源回传。
    if (req.method !== "POST") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    if (!controlOk(req)) {
      jsonOut(res, 403, { error: "comfy-relay: control key required" });
      return;
    }
    void (async () => {
      try {
        if (!backend.reachable) {
          jsonOut(res, 502, { ok: false, error: "backend_unreachable", detail: `ComfyUI ${backend.host}:${backend.port} 不可达` }, req.method);
          return;
        }
        const body = await readBodyJson(req).catch(() => ({}));
        const op = String((body && body.op) || "").trim();
        if (!op) {
          jsonOut(res, 400, { ok: false, error: "missing_op" }, req.method);
          return;
        }
        const token = readBridgeToken();
        if (!token) {
          jsonOut(res, 502, {
            ok: false,
            error: "bridge_not_deployed",
            detail: "未找到 custom_nodes/hana_bridge/.token（桥未部署，或 ComfyUI 尚未加载过它）",
          }, req.method);
          return;
        }
        const upstream = await fetch(`http://${backend.host}:${backend.port}/api/hana_bridge/call`, {
          method: "POST",
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "application/json", "content-type": "application/json", "x-hana-token": token },
          body: JSON.stringify({ op, args: (body && body.args) || {} }),
        });
        const text = (await upstream.text()).trim();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { ok: false, error: `桥返回非 JSON（HTTP ${upstream.status}）` };
        }
        jsonOut(res, upstream.ok ? 200 : 502, data, req.method);
      } catch (e) {
        jsonOut(res, 502, { ok: false, error: String((e && e.message) || e) }, req.method);
      }
    })();
    return;
  }
  if (pathOnly === "/_relay/backend/start" || pathOnly === "/_relay/backend/stop") {
    if (req.method !== "POST") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    if (!controlOk(req)) {
      jsonOut(res, 403, { error: "comfy-relay: control key required" });
      return;
    }
    void (async () => {
      try {
        const body = await readBodyJson(req).catch(() => ({}));
        const out = pathOnly.endsWith("/start")
          ? await startBackendService(typeof body.path === "string" ? body.path.trim() : null)
          : await stopBackendService();
        jsonOut(res, out.ok ? 200 : 502, out);
      } catch (e) {
        jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    })();
    return;
  }
  if (pathOnly === "/_relay/backend/proc") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    jsonOut(res, 200, { ok: true, reachable: backend.reachable, proc: backendProcPayload() }, req.method);
    return;
  }
  // 宿主主题 → ComfyUI 服务端设置（跨源下的主题跟随；键名同 HANA_CSS_MAP / HANA_JS_MAP）
  if (pathOnly === "/_relay/theme") {
    if (req.method === "GET" || req.method === "HEAD") {
      void (async () => {
        try {
          const cur = await backendJsonOrNull("/api/settings");
          const customs = cur && cur["Comfy.CustomColorPalettes"];
          jsonOut(res, 200, {
            ok: !!cur,
            reachable: backend.reachable,
            palette: cur ? cur["Comfy.ColorPalette"] || null : null,
            hasHanaPalette: !!(customs && typeof customs === "object" && customs[THEME_PALETTE_ID]),
          }, req.method);
        } catch (e) {
          jsonOut(res, 502, { ok: false, error: String((e && e.message) || e) }, req.method);
        }
      })();
      return;
    }
    if (req.method === "POST") {
      if (!controlOk(req)) {
        jsonOut(res, 403, { error: "comfy-relay: control key required" });
        return;
      }
      void (async () => {
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          const out = await applyThemeSettings(body);
          jsonOut(res, out.ok ? 200 : 502, out);
        } catch (e) {
          jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      })();
      return;
    }
    jsonOut(res, 405, { error: "method not allowed" }, req.method);
    return;
  }
  // ComfyUI 本体更新（M11）：check=检查（带缓存）/ apply=后台执行 / status=进度
  if (pathOnly === "/_relay/update" || pathOnly === "/_relay/update/status") {
    const wantStatus = pathOnly.endsWith("/status");
    if (wantStatus) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        jsonOut(res, 405, { error: "method not allowed" }, req.method);
        return;
      }
      jsonOut(res, 200, updateStatusPayload(), req.method);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const url = new URL(String(req.url || "/"), "http://relay.invalid");
      const force = url.searchParams.get("force") === "1";
      void (async () => {
        try {
          const out = await checkUpdate(force);
          jsonOut(res, out.ok ? 200 : 502, out, req.method);
        } catch (e) {
          jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) }, req.method);
        }
      })();
      return;
    }
    if (req.method === "POST") {
      if (!controlOk(req)) {
        jsonOut(res, 403, { error: "comfy-relay: control key required" });
        return;
      }
      void (async () => {
        try {
          const body = await readBodyJson(req).catch(() => ({}));
          const op = String((body && body.op) || "apply");
          if (op === "check") {
            const out = await checkUpdate(true);
            jsonOut(res, out.ok ? 200 : 502, out);
            return;
          }
          if (op !== "apply") {
            jsonOut(res, 400, { ok: false, error: 'op 只支持 "check" / "apply"' });
            return;
          }
          const out = startUpdateJob();
          jsonOut(res, out.accepted ? 202 : 409, out);
        } catch (e) {
          jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) });
        }
      })();
      return;
    }
    jsonOut(res, 405, { error: "method not allowed" }, req.method);
    return;
  }
  if (pathOnly === "/_relay/prompts") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    void (async () => {
      if (backend.reachable && Date.now() - queueAt > QUEUE_CACHE_MS) await probeQueue();
      jsonOut(res, 200, promptsPayload(), req.method);
    })();
    return;
  }
  if (pathOnly.startsWith("/_relay/prompts/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    let id = "";
    try { id = decodeURIComponent(pathOnly.slice("/_relay/prompts/".length)); } catch { id = ""; }
    const r = id ? promptStore.get(id) : null;
    jsonOut(res, 200, r ? { ok: true, found: true, record: promptRecordOut(r) } : { ok: true, found: false, promptId: id }, req.method);
    return;
  }
  if (pathOnly === "/_relay/history") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    void handleHistory(req, res);
    return;
  }
  if (pathOnly === "/_relay/fs/read" || pathOnly === "/_relay/fs/stat" || pathOnly === "/_relay/upload") {
    if (req.method !== "POST") {
      jsonOut(res, 405, { error: "method not allowed" }, req.method);
      return;
    }
    if (!controlOk(req)) {
      jsonOut(res, 403, { error: "comfy-relay: control key required" });
      return;
    }
    const handler = pathOnly === "/_relay/fs/read" ? handleFsRead : pathOnly === "/_relay/fs/stat" ? handleFsStat : handleUpload;
    void handler(req, res).catch((e) => {
      try { jsonOut(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch { /* 忽略 */ }
    });
    return;
  }
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const pathOnly = String(req.url || "/").split("?", 1)[0];
  if (pathOnly.startsWith("/_relay/")) {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  proxyUpgrade(req, socket, head);
});

server.on("error", (e) => {
  const code = (e && e.code) || "";
  if (code === "EADDRINUSE" || code === "EACCES") {
    logErr(`监听失败（${code}）：127.0.0.1:${config ? config.port : "?"}`);
    process.exit(EXIT.PORT);
  }
  logErr(`服务器错误：${(e && e.message) || e}`);
  process.exit(EXIT.INTERNAL);
});

// ── 启动 ───────────────────────────────────────────────────────────────────
async function waitBackendOrExit(cfg) {
  const deadline = Date.now() + cfg.backendWaitMs;
  for (;;) {
    await probeBackend();
    if (backend.reachable) return;
    if (Date.now() >= deadline) {
      logErr(`requireBackend：后端 ${cfg.backend.host}:${cfg.backend.port} 在 ${cfg.backendWaitMs}ms 内不可达（${backend.lastError || "unknown"}）`);
      process.exit(EXIT.BACKEND);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startProbeTimer() {
  const t = setInterval(() => {
    if (Date.now() - backend.checkedAt >= PROBE_INTERVAL_MS) void probeBackend();
  }, PROBE_INTERVAL_MS);
  t.unref?.();
}

async function main() {
  // 诊断开关：打印本机安装探测结果（JSON）后退出，不启动服务器（供 agent / 人工排查）
  if (process.argv.includes("--probe-env")) {
    try {
      process.stdout.write(JSON.stringify(probeEnv(true), null, 2) + "\n");
      process.exit(EXIT.OK);
    } catch (e) {
      logErr(`--probe-env 失败：${(e && e.message) || e}`);
      process.exit(EXIT.INTERNAL);
    }
    return;
  }
  try {
    config = loadConfig(process.argv.slice(2));
  } catch (e) {
    logErr((e && e.message) || e);
    process.exit(EXIT.USAGE);
    return;
  }
  backend.host = config.backend.host;
  backend.port = config.backend.port;

  if (config.logFile) {
    if (initLogFile(config.logFile)) log(`日志落盘：${config.logFile}`);
  }
  loadBackendState(); // 服务进程状态（上次由哪个入口拉起、日志位置）跨中继重启保留
  if (!config.controlKey && config.mode === "managed") {
    warn("受管模式未配置 controlKey：/_relay 管理端点将开放（应由 App 配置）");
  }

  if (config.requireBackend) await waitBackendOrExit(config);
  else void probeBackend();

  await new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => {
      const addr = server.address();
      servingPort = addr && typeof addr === "object" ? addr.port : config.port;
      resolve();
    });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const marker = config.readyMarker || `COMFY_RELAY_READY:${servingPort}`;
  process.stdout.write(`${marker}\n`); // 就绪标记：独占一行，精确匹配
  log(`中继监听 127.0.0.1:${servingPort} → http://${backend.host}:${backend.port}（mode=${config.mode}${config.requireBackend ? " requireBackend" : ""}）`);
  startProbeTimer();
  startMetricsSampler();
  startBackendEvents();
}

process.on("SIGINT", () => { log("收到 SIGINT，退出"); server.close(() => process.exit(EXIT.OK)); setTimeout(() => process.exit(EXIT.OK), 1000).unref?.(); });
process.on("SIGTERM", () => { log("收到 SIGTERM，退出"); server.close(() => process.exit(EXIT.OK)); setTimeout(() => process.exit(EXIT.OK), 1000).unref?.(); });
process.on("uncaughtException", (e) => { logErr(`uncaughtException：${(e && e.stack) || e}`); process.exit(EXIT.INTERNAL); });
process.on("unhandledRejection", (e) => { logErr(`unhandledRejection：${(e && e.stack) || e}`); process.exit(EXIT.INTERNAL); });

main().catch((e) => {
  logErr(`启动失败：${(e && e.stack) || e}`);
  process.exit(EXIT.INTERNAL);
});
