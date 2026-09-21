#!/usr/bin/env node
// runtime/comfy-relay.mjs — ComfyUI-Hana 受管中继（Node 单文件，无第三方依赖）· v0.3
// ─────────────────────────────────────────────────────────────────────────────
// 干什么：把宿主受管服务代理（/api/apps/comfyui-hana/routes/_runtime/<runtimeId>/…）
//         转发来的请求，HTTP/WS 全量反代到本机 ComfyUI（默认 127.0.0.1:8188）。
// 业务面（/_relay/*，只读为主；管理端点需 x-comfy-relay-key）：
//   GET  /_relay/status            聚合状态（后端可达性、队列、请求计数、事件订阅、日志文件；
//                                  后端不可达时附 env：本机 ComfyUI 安装探测）
//   GET  /_relay/prompts           进度事件缓存（订阅后端 /ws 得来）：active + recent
//   GET  /_relay/prompts/<id>      单个 prompt 的事件记录
//   GET  /_relay/history?id=&max=  历史摘要（裁剪版：status/error/outputs，避免全量历史体积）
//   POST /_relay/fs/stat           文件 stat（本机路径；{path}）
//   POST /_relay/fs/read           读取文本/二进制（{path, encoding, maxBytes}，上限 8 MiB）
//   POST /_relay/upload            读取本机图片并 multipart 上传到后端 /upload/image
//                                  （{path, subfolder?, type?, overwrite?}）
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
  --comfy-base <路径>     ComfyUI 安装根（供 fs 路径提示；默认 D:\\ComfyUI\\ComfyUI）
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

function candidateRoots() {
  const home = homedir();
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
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
    // 便携包：python_embeded + ComfyUI/main.py（双指纹，缺一不判——避免把「外层包着源码仓」的目录误判）
    if (existsSync(join(root, "ComfyUI", "main.py")) && existsSync(join(root, "python_embeded", "python.exe"))) {
      return {
        path: root, kind: "portable", version: null,
        hasVenv: true,
        mainPy: join(root, "ComfyUI", "main.py"),
      };
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
    // 后端不可达时才附安装探测（供 App/壳页分流「装了没跑」vs「可能没装」）
    env: backend.reachable ? null : probeEnv(),
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
