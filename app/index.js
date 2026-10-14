// app/index.js — Hana-ComfyUI · v2 App 入口（v0.2：工具面 + 任务桥）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：
//   1. 受管 runtime 拉起中继进程 runtime/comfy-relay.mjs（local-machine / external）
//      —— 随机端口（38000-52000）、随机 readyMarker、随机 controlKey（管理端点用）、
//         私有配置 0600 启动即删、就绪轮询 240s、退出码语义化、退避自愈、遗留实例回收
//   2. 工具 comfyui（单工具 · oneOf 动作分派）：
//      status / submit / query / result / cancel / workflows / upload
//   3. 任务桥：submit → ctx.tasks.create({callToken, delivery:"next-step"}) → 轮询结算
//      （complete/fail/cancel）—— 需要能力词 app/tasks.manage + app/session.start-turn，
//      未授权时自动降级为「仅内存跟踪」（工具返回值里说明原因）
//   4. 路由：/comfyui-hana/boot-state | status | health | relay/start | backend/start | backend/stop | backend | backend/{envcheck,clear,wait} | task
//      （relay/start 只重启「中继」；backend/* 管 8188 上的 ComfyUI 本体，由计划任务拉起，独立于 Hana 存活）
//   5. 每 1.5s 轮询中继 /_relay/status（ctx.runtime.fetch 优先）；每 2s 结算任务
//
// 生命周期口径：本 App 负责"拉起 + 监督 + 状态出口 + 任务跟踪"；最终回收由宿主受管 runtime
// 负责（停用/卸载时回收其受管进程组与服务连接）。
// ─────────────────────────────────────────────────────────────────────────────
import { defineApp } from "./sdk/app-contract/server-client.js";
import { createHash, randomInt, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectGraph } from "./lib/canvas-project.mjs";
import { analyzeGraph, traceGraph } from "./lib/canvas-analysis.mjs";
import { outlineGraph } from "./lib/canvas-outline.mjs";
import { resolveWorkflowPath, loadUiWorkflow, fileGet, fileCheck, fileTrace, fileOutline, fileSummary, fileDiff, runFilePatch, writeFileAtomic } from "./workflow-file.mjs";
import { isPlainObject, convertUiToApi, applyInputs, summarizeWorkflow } from "./lib/workflow-tools.mjs";
// T3-1 / T3-3（2026-10-10）：openWorkflow 链路的落定判定与路由失败文案（纯函数，见其 test.mjs）。
import { nameMatchesTarget, openWorkflowLoadVerdict, openWorkflowRouteError, toIntOrNull } from "./lib/canvas-open-workflow.mjs";

const APP_ID = "comfyui-hana";
// v0.6.0（M9）：ComfyUI 服务进程起停（中继 /_relay/backend/{start,stop,proc} + App 路由 + 工具 action=service
//   + 左侧面板「启动服务/停止服务」）。启动走计划任务（脱离宿主沙箱 job，服务独立存活），撤下走 taskkill。
//   面板原来那个「重试启动」正名为「重启中继」——它只重启受管 runtime，不碰 ComfyUI 服务本体。
// （拉起服务 T2）：service 增 envcheck/clear/wait op；start 前自动 envcheck，阻断时暂缓拉起并返回阻断说明。
//   2026-10-09：卡片功能恢复——任务卡（task.html，submit/queue 回执 details.card）与环境检查卡
//     （envcheck.html，卡按钮路由 /comfyui-hana/backend/{envcheck,clear,wait} 一并恢复）；
//     流内卡走工具回执通道，不注册 contributes.cards（卡片中心零新增）。
const APP_VERSION = "0.13.0";
const RELAY_ENTRY = "runtime/comfy-relay.mjs";
const BACKEND = Object.freeze({ host: "127.0.0.1", port: 8188 });
const RELAY_CLIENT_ID_PREFIX = "comfyui-hana-relay"; // 中继 /ws 订阅与提交共用（ComfyUI 只把执行事件发给提交方 client_id）
// 注意：每次中继启动生成唯一后缀——ComfyUI 旧连接的 finally 会按 sid pop，复用同名会在快速重启时误删新连接。
// ComfyUI 安装根不硬编码：由中继的本机安装探测动态提供（见 comfyBase()），任何机器都能用。
const READY_MAX_MS = 240_000;
const READY_POLL_MS = 300;
const STATUS_POLL_MS = 1_500;
const JOB_TICK_MS = 2_000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000; // 单任务最长跟踪 60 分钟
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const TERMINAL_STATES = new Set(["failed", "exited", "stopped"]);
const TERMINAL_JOB = new Set(["completed", "error", "interrupted", "canceled", "timeout"]);
const CAP_TASKS = "app/tasks.manage";
const CAP_START_TURN = "app/session.start-turn";
const CAP_STAGE_FILE = "app/session.stage-file";
const KEEPALIVE_PROBE = true; // TODO 踹探针实验（临时代码，验证完按结论处理）

const USER_TEXT = Object.freeze({
  "port-busy": "中继端口被占用或无法监听（已自动换随机端口重试，仍失败请检查本机回环端口占用与安全软件拦截）。",
  "backend-unreachable": "中继无法连接 ComfyUI 后端（127.0.0.1:8188）。请确认 ComfyUI 正在运行，再重试启动。",
  config: "中继运行时配置无效（见 runtime 日志）。",
  "not-authorized": "宿主未授权本 App 启动受管 runtime（app/runtime.local-machine 能力未授予或已撤销）。检查 App 能力与授权状态。",
  timeout: "中继在 240s 内未完成就绪（查看 runtime 日志与状态）。",
  internal: "中继进程异常退出（见 runtime 日志）。",
  unknown: "中继启动失败（见 runtime 日志与状态）。",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const name = APP_ID;

export default defineApp(async (sdk) => {
  const fire = (p) => { try { if (p && typeof p.catch === "function") p.catch(() => {}); } catch { /* 忽略 */ } };
  const log = (m) => fire(sdk.logger?.info?.(`[${APP_ID}] ${m}`));
  const warn = (m) => fire(sdk.logger?.warn?.(`[${APP_ID}] ${m}`));
  const error = (m) => fire(sdk.logger?.error?.(`[${APP_ID}] ${m}`));
  const msgOf = (e) => (e && e.message ? String(e.message) : String(e));

  const dataDir = sdk.dataDir;
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("comfyui-hana apply: ctx.dataDir 缺失（宿主未提供 App 数据目录）");
  }
  log(`apply entered | dataDir=${dataDir} | version=${APP_VERSION}`);

  // ── 运行时状态 ────────────────────────────────────────────────────────────
  const state = {
    phase: "idle", // idle | starting | ready | error | stopped
    runtimeId: null,
    servicePort: null,
    controlKey: null,
    clientId: null,
    lastInfo: null,
    lastError: null,
    startPromise: null,
    snapshot: null, // { at, relay: object|null, error }
    statusTimer: null,
    refreshing: false,
    jobs: new Map(), // promptId → job
    jobTimer: null,
    caps: { at: 0, map: null },
  };

  function withCode(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // ── 能力账本查询（缓存 30s）───────────────────────────────────────────────
  async function capabilitiesMap(force = false) {
    if (!force && state.caps.map && Date.now() - state.caps.at < 30_000) return state.caps.map;
    try {
      const res = await sdk.bus.request("app:capabilities", {});
      const map = {};
      for (const c of (res && Array.isArray(res.capabilities) ? res.capabilities : [])) {
        if (c && typeof c.capability === "string") map[c.capability] = c.status;
      }
      state.caps = { at: Date.now(), map };
      return map;
    } catch (e) {
      warn(`app:capabilities 查询失败：${msgOf(e)}`);
      return null;
    }
  }

  async function hasCapability(word) {
    const map = await capabilitiesMap();
    if (!map) return false;
    const st = map[word];
    return st === "always" || st === "session";
  }

  // ── 私有运行时配置（0600，启动即删）──────────────────────────────────────
  function writeRuntimeConfig(port, readyMarker, controlKey, clientId, attempt) {
    const dir = join(dataDir, "integration");
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `relay-${randomBytes(6).toString("hex")}.json`);
    const config = {
      mode: "managed",
      port,
      backend: { host: BACKEND.host, port: BACKEND.port },
      readyMarker,
      requireBackend: false, // attach 模式：后端可能后起，中继常驻并持续探测
      logRequests: true,
      upstreamTimeoutMs: 0,
      logFile: join(dataDir, "logs", "relay.log"),
      controlKey,
      clientId,
      note: `comfyui-hana relay v${APP_VERSION} (attempt ${attempt}) @ ${new Date().toISOString()}`,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch { /* Windows 上多为 no-op */ }
    return configPath;
  }

  function classifyTerminal(info) {
    const exitCode = typeof info?.exitCode === "number" ? info.exitCode : null;
    if (exitCode === 7) return { code: "port-busy", userText: USER_TEXT["port-busy"] };
    if (exitCode === 2) return { code: "backend-unreachable", userText: USER_TEXT["backend-unreachable"] };
    if (exitCode === 3) return { code: "config", userText: USER_TEXT.config };
    if (exitCode === 1) return { code: "internal", userText: USER_TEXT.internal };
    return { code: "unknown", userText: USER_TEXT.unknown };
  }

  async function stopRuntimeQuietly() {
    const runtimeId = state.runtimeId;
    state.runtimeId = null;
    state.servicePort = null;
    if (!runtimeId) return;
    if (typeof sdk.runtime?.stop !== "function") return;
    try {
      await sdk.runtime.stop(runtimeId);
    } catch (e) {
      warn(`runtime.stop 失败（宿主可能已回收）：${msgOf(e)}`);
    }
  }

  async function stopStaleRuntimes() {
    try {
      const list = await sdk.runtime.list();
      for (const rt of Array.isArray(list) ? list : []) {
        if (!rt?.runtimeId || rt.runtimeId === state.runtimeId) continue;
        if (rt.state === "ready" || rt.state === "starting") {
          try {
            await sdk.runtime.stop(rt.runtimeId);
            log(`已回收遗留受管实例 ${rt.runtimeId}（${rt.state}）`);
          } catch (e) {
            warn(`回收遗留实例失败 ${rt.runtimeId}：${msgOf(e)}`);
          }
        }
      }
    } catch (e) {
      warn(`runtime.list 失败（忽略，继续启动）：${msgOf(e)}`);
    }
  }

  // ── 单次启动尝试 ──────────────────────────────────────────────────────────
  async function startOnce(attempt) {
    if (!sdk.runtime || typeof sdk.runtime.start !== "function") {
      throw withCode("宿主 ctx.runtime 不可用（app/runtime.execute 能力未授予或宿主过旧）", "unknown");
    }
    const port = randomInt(38000, 52001);
    const readyMarker = "COMFY_RELAY_READY:" + randomBytes(18).toString("base64url");
    const controlKey = randomBytes(24).toString("base64url");
    const clientId = `${RELAY_CLIENT_ID_PREFIX}-${randomBytes(4).toString("hex")}`;
    const configPath = writeRuntimeConfig(port, readyMarker, controlKey, clientId, attempt);

    log(`启动中继受管 runtime（attempt ${attempt}/3，端口 ${port}，backend ${BACKEND.host}:${BACKEND.port}）`);
    let rt = null;
    try {
      rt = await sdk.runtime.start({
        runtime: "node",
        entry: RELAY_ENTRY,
        profile: "local-machine",
        network: "external",
        cwd: dataDir,
        args: [configPath],
        service: { port, readyMarker },
      });
    } catch (e) {
      try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ }
      const raw = msgOf(e);
      warn(`ctx.runtime.start 被宿主拒绝：${raw}`);
      const code = /not authorized|authoriz|DENIED|declined/i.test(raw) ? "not-authorized" : "unknown";
      throw withCode(`${USER_TEXT[code]}（宿主：${raw}）`, code);
    }
    const cleanup = setTimeout(() => { try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ } }, 10_000);
    cleanup.unref?.();

    const runtimeId = rt && rt.runtimeId;
    if (!runtimeId) throw withCode(`ctx.runtime.start 未返回 runtimeId（宿主契约异常）：${JSON.stringify(rt || null)}`, "unknown");
    state.runtimeId = runtimeId;
    state.servicePort = typeof rt?.service?.port === "number" ? rt.service.port : port;
    state.controlKey = controlKey;
    state.clientId = clientId;
    state.lastInfo = rt;
    log(`runtimeId=${runtimeId} state=${rt.state || "starting"} servicePort=${state.servicePort}`);

    const deadline = Date.now() + READY_MAX_MS;
    for (;;) {
      let info = null;
      try {
        info = await sdk.runtime.get(runtimeId);
      } catch (e) {
        warn(`runtime.get 查询失败：${msgOf(e)}`);
      }
      const rs = info && info.state;
      const svc = info && info.service;
      if (rs === "ready" || (svc && svc.state === "ready")) {
        state.lastInfo = info;
        if (typeof svc?.port === "number") state.servicePort = svc.port;
        log(`中继就绪（state=${rs} service=${JSON.stringify(svc || null)}）`);
        return { runtimeId, info };
      }
      if (TERMINAL_STATES.has(rs)) {
        const cls = classifyTerminal(info);
        state.lastInfo = info;
        error(`中继 runtime 终态异常：state=${rs} exitCode=${info && info.exitCode}`);
        throw withCode(`${cls.userText}（runtime state=${rs} exitCode=${info && info.exitCode}）`, cls.code);
      }
      if (Date.now() >= deadline) {
        throw withCode(USER_TEXT.timeout, "timeout");
      }
      await sleep(READY_POLL_MS);
    }
  }

  // ── 单飞行 + 退避重试 ────────────────────────────────────────────────────
  let retryTimer = null;
  let retryCount = 0;

  function scheduleRetry() {
    if (state.manualStop || retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
    retryCount += 1;
    const t = setTimeout(() => {
      retryTimer = null;
      if (state.manualStop) return;
      ensureManagedRuntime().then(
        () => { retryCount = 0; log("自动重试成功，中继已就绪"); },
        () => { /* 失败由 ensureManagedRuntime 的 catch 继续排程 */ },
      );
    }, delay);
    t.unref?.();
    retryTimer = t;
    warn(`中继启动失败（第 ${retryCount} 次）：${state.lastError ? state.lastError.userText : "未知"} —— ${Math.round(delay / 1000)}s 后自动重试（无需手动操作）`);
  }

  async function probeRuntimeAlive() {
    if (!state.runtimeId) return null;
    try {
      const info = await sdk.runtime.get(state.runtimeId);
      if (info && (info.state === "ready" || (info.service && info.service.state === "ready"))) {
        state.lastInfo = info;
        if (typeof info.service?.port === "number") state.servicePort = info.service.port;
        return info;
      }
      return null;
    } catch (e) {
      warn(`runtime.get 探活失败（保守视为仍就绪）：${msgOf(e)}`);
      return state.lastInfo;
    }
  }

  async function ensureManagedRuntime() {
    state.manualStop = false;
    if (state.phase === "ready" && state.runtimeId) {
      const alive = await probeRuntimeAlive();
      if (alive) return { runtimeId: state.runtimeId, info: alive };
      warn("缓存状态为 ready，但 runtime 已不在就绪态（子进程退出/宿主回收），重新启动");
      stopStatusPolling();
      await stopRuntimeQuietly();
      state.phase = "idle";
      state.lastInfo = null;
    }
    if (state.phase === "starting" && state.startPromise) return state.startPromise;

    const attemptPromise = (async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await startOnce(attempt);
        } catch (e) {
          lastErr = e;
          await stopRuntimeQuietly();
          if (e?.code !== "port-busy" || attempt >= 3) throw e;
          warn(`端口占用（第 ${attempt} 次尝试）——换随机端口重试`);
        }
      }
      throw lastErr || withCode(USER_TEXT.unknown, "unknown");
    })();

    state.phase = "starting";
    state.startPromise = attemptPromise;
    try {
      const result = await attemptPromise;
      state.phase = "ready";
      state.lastError = null;
      startStatusPolling();
      void maybeAutoStartBackend(); // 中继就绪后按配置决定是否拉起 ComfyUI 服务（不阻塞启动）
      return result;
    } catch (e) {
      state.phase = "error";
      state.lastError = { code: e?.code || "unknown", userText: msgOf(e) || USER_TEXT.unknown, raw: msgOf(e) };
      await stopRuntimeQuietly();
      scheduleRetry();
      throw e;
    } finally {
      state.startPromise = null;
    }
  }

  // ── 中继调用助手 ──────────────────────────────────────────────────────────
  function relayReady() {
    return state.phase === "ready" && !!state.runtimeId;
  }

  // ComfyUI 安装根：由中继本机安装探测动态提供（env.installs[0].path），不硬编码路径；
  // 探测不到（装在不常见位置）时返回 null，产物定位退化为「仅相对名 + 预览 URL」。
  function comfyBase() {
    const env = state.snapshot && state.snapshot.relay ? state.snapshot.relay.env : null;
    const hit = env && Array.isArray(env.installs) ? env.installs[0] : null;
    return hit && typeof hit.path === "string" && hit.path ? hit.path : null;
  }

  async function relayFetch(path, init = {}) {
    if (!relayReady()) {
      throw new Error(`中继未就绪（phase=${state.phase}）：${noteFor(state.phase)}`);
    }
    const headers = { ...(init.headers || {}) };
    if (state.controlKey) headers["x-comfy-relay-key"] = state.controlKey;
    return sdk.runtime.fetch(state.runtimeId, path, {
      method: init.method || "GET",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      // 宿主契约：ctx.runtime.fetch 的 timeoutMs 只能是 1..30000
      timeoutMs: Math.min(30_000, Math.max(1, Number(init.timeoutMs) || 30_000)),
    });
  }

  async function relayJson(path, init = {}) {
    const res = await relayFetch(path, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 800) }; }
    return { status: res.status, ok: res.ok, data };
  }

  // ── 安装位置（引导弹窗用）────────────────────────────────────────────────
  // 自定义安装位置持久化在 app-data，并推给中继（probeEnv 优先检查它）——
  // 这样即使用户选了非常规目录，装完也会被自动发现。
  const installTargetFile = join(dataDir, "install-target.json");

  // 服务自动拉起（可选，默认关）：Hana 启动时若已装 ComfyUI 且 8188 无服务，自动拉起一次。
  const autoStartFile = join(dataDir, "auto-start.json");

  // 画布写入授权（默认关）：agent 改的是人眼前的画布，不给默认放行。
  const allowWriteFile = join(dataDir, "allow-write.json");

  // 副驾驶总闸（默认关，v2 2026-10-08）：允许 Agent 开启画布副驾驶——「人明确下令」的机制基座。
  // 边界：桥（js/py）读不到本设置，总闸只在 app 层生效；桥侧只兜底 copilot_off 写拦截。
  const allowCopilotFile = join(dataDir, "allow-copilot.json");

  // D2 待同步（2026-09-29 契约 §3.3；A 批 2026-10-08 收口）：backend 产出记账（仅显式 mode=backend）；画布恢复（且获授权）后惰性回填。
  const pendingCanvasFile = join(dataDir, "pending-canvas.json");

  // 出图实时预览设置（2026-10-13）：默认关 / 两级档位（basic=latent2rgb 免下载；hd=taesd 需下载解码器）。
  // 本文件是 App 侧真相源；生效值另推中继（/_relay/preview-config），中继未就绪时仅存盘、待就绪后补推。
  const previewSettingsFile = join(dataDir, "preview-settings.json");
  const PREVIEW_TIERS = Object.freeze(["basic", "hd"]);
  const PREVIEW_DEFAULT = Object.freeze({ enabled: false, tier: "basic" });
  // HD 档（taesd）所需解码器：ComfyUI 按「前缀」在 models/vae_approx/ 匹配
  // （latent_formats.py: QwenImage21.taesd_decoder_name = "taeqi2_1_decoder"），文件名须以该前缀开头。
  const PREVIEW_HD_FILENAME = "taeqi2_1_decoder.pth";

  function readAllowWrite() {
    try {
      return JSON.parse(readFileSync(allowWriteFile, "utf8")).enabled === true;
    } catch { return false; }
  }

  function writeAllowWrite(enabled) {
    try {
      writeFileSync(allowWriteFile, JSON.stringify({ enabled: !!enabled, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`allow-write 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  function readAllowCopilot() {
    try {
      return JSON.parse(readFileSync(allowCopilotFile, "utf8")).enabled === true;
    } catch { return false; }
  }

  function writeAllowCopilot(enabled) {
    try {
      writeFileSync(allowCopilotFile, JSON.stringify({ enabled: !!enabled, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`allow-copilot 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  // ── 出图预览设置：tier ↔ method 映射 + 读写 ─────────────────────────────
  function tierToMethod(tier) {
    return tier === "hd" ? "taesd" : "latent2rgb";
  }

  function readPreviewSettings() {
    try {
      const raw = JSON.parse(readFileSync(previewSettingsFile, "utf8"));
      const tier = raw && PREVIEW_TIERS.includes(raw.tier) ? raw.tier : PREVIEW_DEFAULT.tier;
      return { enabled: !!(raw && raw.enabled === true), tier };
    } catch { return { ...PREVIEW_DEFAULT }; } // 首次运行无文件 → 默认关/basic
  }

  function writePreviewSettings({ enabled, tier }) {
    const safeTier = PREVIEW_TIERS.includes(tier) ? tier : PREVIEW_DEFAULT.tier;
    try {
      writeFileSync(previewSettingsFile, JSON.stringify({ enabled: enabled === true, tier: safeTier, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`preview-settings 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  // 归一化中继回读的 {enabled, method}（method 非两级档位 → null；enabled 但无 method 视为关）。
  function normalizeRelayPreview(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const method = src.method === "latent2rgb" || src.method === "taesd" ? src.method : null;
    return { enabled: src.enabled === true && !!method, method };
  }

  // 中继回读（预览配置）：不可达/未就绪一律返回 null，不抛错（设置页不因中继缺席而报错）。
  async function relayPreviewRead() {
    if (!relayReady()) return null;
    try {
      const { ok, data } = await relayJson("/_relay/preview-config", { timeoutMs: 5_000 });
      if (!ok || !data || typeof data !== "object") return null;
      return normalizeRelayPreview(data);
    } catch { return null; }
  }

  // 推送预览配置给中继（relayFetch 自带 x-comfy-relay-key）。返回 {pushed, error}。
  async function relayPreviewPush(enabled, method) {
    try {
      const res = await relayFetch("/_relay/preview-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: enabled === true, method }),
        timeoutMs: 8_000,
      });
      if (!res.ok) return { pushed: false, error: `relay HTTP ${res.status}` };
      return { pushed: true, error: null };
    } catch (e) {
      return { pushed: false, error: msgOf(e) };
    }
  }

  // 副驾驶开关门控（v2，2026-10-08）：总闸关时给出可行动提示，开则放行。
  // 口径：只受总闸管辖——不受写授权、不受目标页当前状态影响（否则鸡生蛋：未开的布永远开不了）。
  function copilotGateError() {
    if (readAllowCopilot()) return null;
    return "未开启「允许 Agent 开启画布副驾驶」授权（默认关）：请在 Hana-ComfyUI 设置页打开后再试（或由用户在画布顶栏点「副驾驶·开」）。";
  }

  function readAutoStart() {
    try {
      return JSON.parse(readFileSync(autoStartFile, "utf8")).enabled === true;
    } catch { return false; }
  }

  function writeAutoStart(enabled) {
    try {
      writeFileSync(autoStartFile, JSON.stringify({ enabled: !!enabled, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`auto-start 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  function readInstallTarget() {
    try {
      const raw = JSON.parse(readFileSync(installTargetFile, "utf8"));
      return { path: raw && typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : null };
    } catch { return { path: null }; }
  }

  function writeInstallTarget(path) {
    try {
      writeFileSync(installTargetFile, JSON.stringify({ path: path || null, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`install-target 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  // 说明页「已看过」标记（intro-state.json）：文件缺失/损坏按未看过处理，不报错。
  const introStateFile = join(dataDir, "intro-state.json");

  function readIntroState() {
    try {
      const raw = JSON.parse(readFileSync(introStateFile, "utf8"));
      const src = raw && typeof raw === "object" ? raw : {};
      return { seen: src.seen === true, optOut: src.optOut === true };
    } catch { return { seen: false, optOut: false }; }
  }

  function writeIntroState(seen, optOut) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileAtomic(introStateFile, JSON.stringify({ seen: seen === true, optOut: optOut === true, at: new Date().toISOString() }, null, 2));
      return true;
    } catch (e) {
      warn(`intro-state 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  let lastRelayPid = 0;

  // 自动拉起：仅当开关开启且本机已装 ComfyUI 时执行。中继的 startBackendService 自身幂等
  // （8188 已有服务时返回 already:true），因此无需预判可达性，不会重复起服务。
  async function maybeAutoStartBackend() {
    try {
      if (!readAutoStart()) return;
      await new Promise((r) => setTimeout(r, 6000)); // 等状态轮询拿到首帧快照（含安装探测）
      if (!relayReady()) return;
      try { await syncCustomRoots(true); } catch { /* 推不动不致命，下面的探测会兜底 */ }
      const env = (state.snapshot && state.snapshot.relay && state.snapshot.relay.env) || null;
      if (!env || !env.found) { log("自动拉起：跳过（本机未探测到 ComfyUI 安装）"); return; }
      const { ok, data } = await relayJson("/_relay/backend/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 40_000,
      });
      const d = data && typeof data === "object" ? data : {};
      log(`自动拉起 ComfyUI：ok=${ok}${d.already ? "（已在运行）" : ""}${d.error ? ` err=${d.error}` : ""}`);
    } catch (e) {
      warn(`自动拉起 ComfyUI 失败（不影响 App）：${msgOf(e)}`);
    }
  }
  async function syncCustomRoots(force = false) {
    if (!relayReady()) return;
    const snap = state.snapshot;
    const pid = (snap && snap.relay && snap.relay.relay && snap.relay.relay.pid) || 0;
    if (!force && pid && pid === lastRelayPid) return; // 同一中继实例不重复推
    const { path } = readInstallTarget();
    try {
      await relayJson("/_relay/custom-roots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: path ? [path] : [] }),
        timeoutMs: 6_000,
      });
      lastRelayPid = pid || lastRelayPid;
    } catch (e) {
      warn(`custom-roots 同步失败：${msgOf(e)}`);
    }
  }

  // 安装提示词模板（后端单点维护；前端“复制指令”也从这里取）
  function buildInstallPrompt(targetPath) {
    return [
      "请帮我安装 ComfyUI（供 Hana-ComfyUI 使用）。",
      "",
      `安装位置（已确认，请装到这里）：${targetPath}`,
      "",
      "执行要求：",
      "1. 读取 comfyui-hana 技能目录下的 INSTALL.md，按 Windows 主线步骤执行；",
      `2. 目录约定：仓库放在 ${targetPath}\\ComfyUI，Python 环境放 ${targetPath}\\venv；`,
      "3. 安装完成后启动服务（127.0.0.1:8188）并验证 /system_stats 返回 200；",
      "4. 遇到必须由用户决定的事先询问，其余按手册自主执行；",
      "5. 每完成一个阶段（克隆完 / 依赖装完 / 服务起来）简短汇报一次；",
      "6. 完成后回报：安装路径、ComfyUI 版本、服务状态。",
    ].join("\n");
  }

  // ── 状态快照轮询（1.5s）──────────────────────────────────────────────────
  function startStatusPolling() {
    if (state.statusTimer || !state.runtimeId) return;
    state.statusTimer = setInterval(() => { void refreshSnapshot(); }, STATUS_POLL_MS);
    state.statusTimer.unref?.();
    void refreshSnapshot();
  }

  function stopStatusPolling() {
    if (state.statusTimer) {
      try { clearInterval(state.statusTimer); } catch { /* 忽略 */ }
      state.statusTimer = null;
    }
  }

  async function refreshSnapshot() {
    const runtimeId = state.runtimeId;
    if (!runtimeId) return;
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      await refreshSnapshotOnce(runtimeId);
    } finally {
      state.refreshing = false;
    }
  }

  async function refreshSnapshotOnce(runtimeId) {
    let relay = null;
    let lastErrText = null;
    try {
      const res = await sdk.runtime.fetch(runtimeId, "/_relay/status", { timeoutMs: 4_000 });
      relay = await res.json();
    } catch (e) {
      lastErrText = msgOf(e);
      const port = state.servicePort;
      if (port && typeof sdk.network?.fetch === "function") {
        try {
          const res2 = await sdk.network.fetch(`http://127.0.0.1:${port}/_relay/status`, { method: "GET", timeoutMs: 4_000 });
          relay = await res2.json();
          lastErrText = null;
        } catch (e2) {
          lastErrText = `${lastErrText} / 直连回退失败：${msgOf(e2)}`;
        }
      }
    }
    state.snapshot = { at: Date.now(), relay: relay || null, error: lastErrText };
    void syncCustomRoots(); // 中继重启（pid 变化）时自动重推自定义安装位置

    if (!relay && state.phase === "ready") {
      try {
        const info = await sdk.runtime.get(runtimeId);
        if (info && TERMINAL_STATES.has(info.state)) {
          warn(`探测到中继 runtime 终态（${info.state} exitCode=${info.exitCode}），转入错误态并排程重试`);
          const cls = classifyTerminal(info);
          state.phase = "error";
          state.lastError = { code: cls.code, userText: cls.userText, raw: `state=${info.state} exitCode=${info.exitCode}` };
          stopStatusPolling();
          await stopRuntimeQuietly();
          scheduleRetry();
        }
      } catch { /* 查询失败忽略 */ }
    }
  }

  // ── 任务桥：跟踪 + 结算 ──────────────────────────────────────────────────
  function newJob(promptId, label) {
    const job = {
      promptId,
      taskId: null,
      label,
      clientLabel: label,
      state: "pending",
      submittedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      currentNode: null,
      nodesDone: 0,
      outputs: [],
      previewFrames: [],        // 实时预览帧（base64 裸串，最新在后；来自中继 prompts 记录）
      previewUpdatedAt: null,   // 末帧到达时间（ms）
      error: null,
      cancelRequested: false,
      historyFetched: false,
      lastTaskUpdateAt: 0,
      taskNote: null, // 桥降级原因
    };
    state.jobs.set(promptId, job);
    // 丢弃过老的已终态记录（最多保留 50 条）
    if (state.jobs.size > 50) {
      const terminal = [...state.jobs.values()].filter((j) => TERMINAL_JOB.has(j.state)).sort((a, b) => a.submittedAt - b.submittedAt);
      while (state.jobs.size > 50 && terminal.length) state.jobs.delete(terminal.shift().promptId);
    }
    return job;
  }

  function elapsedMsOf(job) {
    const end = job.finishedAt || Date.now();
    return Math.max(0, end - job.submittedAt);
  }

  function viewPathOf(o) {
    return `view?filename=${encodeURIComponent(o.filename)}&subfolder=${encodeURIComponent(o.subfolder || "")}&type=${encodeURIComponent(o.type || "output")}`;
  }

  async function enrichOutputs(job) {
    for (const o of job.outputs.slice(0, 30)) {
      o.viewPath = viewPathOf(o);
      if (o.type === "output" || o.type === "temp") {
        const root = comfyBase();
        if (!root) continue; // 未识别安装根：跳过绝对路径补充
        const base = o.type === "temp" ? "temp" : "output";
        const p = `${root}\\${base}\\${o.subfolder ? o.subfolder + "\\" : ""}${o.filename}`;
        try {
          const { ok, data } = await relayJson("/_relay/fs/stat", { method: "POST", body: JSON.stringify({ path: p }) });
          if (ok && data?.stat?.exists) {
            o.filePath = p;
            o.sizeBytes = data.stat.size;
          }
        } catch { /* stat 失败仅影响路径补充 */ }
      }
    }
  }

  function buildTaskResult(job) {
    const secs = Math.round(elapsedMsOf(job) / 1000);
    const files = job.outputs.map((o) => ({
      filename: o.filename,
      subfolder: o.subfolder || "",
      type: o.type || "output",
      filePath: o.filePath || null,
      viewPath: o.viewPath || viewPathOf(o),
      sizeBytes: o.sizeBytes ?? null,
    }));
    const lines = [
      `ComfyUI 任务完成：${job.label}（prompt ${job.promptId.slice(0, 8)}…，用时 ${secs}s，产物 ${files.length} 个）`,
    ];
    for (const f of files.slice(0, 10)) {
      lines.push(`- ${f.filePath || `（${f.type}:${f.subfolder ? f.subfolder + "/" : ""}${f.filename}）`}`);
    }
    return {
      text: lines.join("\n"),
      comfyui: {
        promptId: job.promptId,
        taskId: job.taskId,
        label: job.label,
        elapsedMs: elapsedMsOf(job),
        outputs: files,
      },
    };
  }

  function buildTaskErrorText(job) {
    if (job.state === "timeout") return `ComfyUI 任务超时未结算（${job.label}，prompt ${job.promptId}）：60 分钟内未见完成/错误事件。`;
    if (job.state === "interrupted" || job.state === "canceled") return `ComfyUI 任务已中断/取消（${job.label}，prompt ${job.promptId}）。`;
    const e = job.error;
    const detail = e ? `${e.type || ""} ${e.message || ""}`.trim() : "未知错误";
    return `ComfyUI 任务失败（${job.label}，prompt ${job.promptId}）：${detail}`;
  }

  async function settleJob(job, kind, errorInfo, entry) {
    if (TERMINAL_JOB.has(job.state)) return;
    job.state = kind;
    job.finishedAt = Date.now();
    if (entry && Array.isArray(entry.outputs) && entry.outputs.length) job.outputs = entry.outputs;
    if (errorInfo) job.error = errorInfo;
    try { await enrichOutputs(job); } catch (e) { warn(`产物路径补充失败：${msgOf(e)}`); }
    if (job.taskId) {
      try {
        if (kind === "completed") {
          await sdk.tasks.complete(job.taskId, buildTaskResult(job));
        } else if (kind === "canceled" || kind === "interrupted") {
          await sdk.tasks.cancel(job.taskId, "用户取消（ComfyUI 已中断）");
        } else {
          await sdk.tasks.fail(job.taskId, buildTaskErrorText(job));
        }
      } catch (e) {
        warn(`任务结算失败（${job.taskId}）：${msgOf(e)}`);
      }
    }
    log(`任务 ${job.promptId} → ${job.state}（${Math.round((job.finishedAt - job.submittedAt) / 1000)}s，产物 ${job.outputs.length}）`);
  }

  async function maybeUpdateTaskProgress(job) {
    if (!job.taskId) return;
    const now = Date.now();
    if (now - job.lastTaskUpdateAt < 5_000) return;
    job.lastTaskUpdateAt = now;
    const phase = job.state === "pending" ? "排队中" : "执行中";
    try {
      await sdk.tasks.update(job.taskId, {
        progress: {
          phase,
          promptId: job.promptId,
          currentNode: job.currentNode,
          nodesDone: job.nodesDone,
          progress: job.progress,
          elapsedMs: elapsedMsOf(job),
        },
      });
    } catch (e) {
      warn(`任务进度回写失败（${job.taskId}）：${msgOf(e)}`);
    }
  }

  async function jobTick() {
    const active = [...state.jobs.values()].filter((j) => !TERMINAL_JOB.has(j.state));
    if (!active.length) return;
    let promptsSnap = null;
    try {
      const r = await relayJson("/_relay/prompts", { timeoutMs: 6_000 });
      if (r.ok) promptsSnap = r.data;
    } catch { /* 快照失败时仍走 history 兜底 */ }
    for (const job of active) {
      try {
        await refreshJob(job, promptsSnap);
      } catch (e) {
        warn(`任务跟踪失败（${job.promptId}）：${msgOf(e)}`);
      }
    }
  }

  async function refreshJob(job, promptsSnap) {
    const now = Date.now();
    const rec =
      (promptsSnap?.active || []).find((r) => r.promptId === job.promptId) ||
      (promptsSnap?.recent || []).find((r) => r.promptId === job.promptId) ||
      null;
    if (rec) {
      if (rec.startedAt && !job.startedAt) job.startedAt = rec.startedAt;
      if (rec.currentNode !== undefined) job.currentNode = rec.currentNode;
      if (rec.progress) job.progress = rec.progress;
      if (typeof rec.nodesDone === "number") job.nodesDone = rec.nodesDone;
      // 实时预览：列表出口带的是末帧（full:false，1 帧）；卡片回放所需全量在 task 路由按需补拉
      if (Array.isArray(rec.previewFrames) && rec.previewFrames.length) {
        job.previewFrames = rec.previewFrames;
        job.previewUpdatedAt = rec.previewUpdatedAt || null;
      }
      if (rec.state === "error") {
        return settleJob(job, job.cancelRequested ? "canceled" : "error", rec.error, null);
      }
      if (rec.state === "interrupted") {
        return settleJob(job, job.cancelRequested ? "canceled" : "interrupted", null, null);
      }
    }
    // history 权威收尾（完成/错误/中断都会落 history）
    if (!job.historyFetched && (rec?.state === "completed" || now - job.submittedAt > 3_000)) {
      try {
        const { ok, data } = await relayJson(`/_relay/history?id=${encodeURIComponent(job.promptId)}`, { timeoutMs: 8_000 });
        if (ok && Array.isArray(data?.entries) && data.entries.length) {
          const entry = data.entries[0];
          job.historyFetched = true;
          if (entry.completed) return settleJob(job, "completed", null, entry);
          if (entry.status === "error") {
            const interrupted = entry.error && /interrupt/i.test(String(entry.error.type || ""));
            if (interrupted) return settleJob(job, job.cancelRequested ? "canceled" : "interrupted", entry.error, entry);
            return settleJob(job, "error", entry.error, entry);
          }
        }
      } catch { /* 下一轮再试 */ }
    }
    if (now - job.submittedAt > JOB_TIMEOUT_MS) {
      return settleJob(job, "timeout", null, null);
    }
    await maybeUpdateTaskProgress(job);
  }

  // ── 工作流解析（三形态 + inputs 注入）────────────────────────────────────
  // isPlainObject / NOTE_TYPES / UNSUPPORTED_UI_TYPES / convertUiToApi / applyInputs / summarizeWorkflow
  // 已移至 lib/workflow-tools.mjs（app 与中继共享，2026-09-29 M13）；见顶部 import。

  async function getObjectInfo() {
    const { ok, data } = await relayJson("/object_info", { timeoutMs: 30_000 });
    if (!ok || !isPlainObject(data)) throw new Error("读取 /object_info 失败（中继或后端不可用）");
    return data;
  }

  // T2 接线（2026-10-09）：check 的 object_info best-effort——进程内缓存（TTL 10 分钟）；
  // 仅当 rules 含 missing_required / all 时按需拉取；拉取失败不报硬错（调用方传 undefined，
  // lib 走降级路径并在 warnings 如实标注）。
  const OBJECT_INFO_TTL_MS = 10 * 60_000;
  const objectInfoCache = { at: 0, data: null };
  async function getObjectInfoCached() {
    const now = Date.now();
    if (objectInfoCache.data && now - objectInfoCache.at < OBJECT_INFO_TTL_MS) return objectInfoCache.data;
    const data = await getObjectInfo();
    objectInfoCache.at = now;
    objectInfoCache.data = data;
    return data;
  }
  function rulesNeedObjectInfo(rules) {
    if (rules === undefined || rules === null) return false;
    const list = Array.isArray(rules) ? rules : String(rules).split(",");
    return list.some((x) => {
      const s = String(x).trim().toLowerCase();
      return s === "missing_required" || s === "all";
    });
  }

  // convertUiToApi 已移至 lib/workflow-tools.mjs（app 与中继共享，2026-09-29 M13）

  async function readLocalText(path) {
    const { status, ok, data } = await relayJson("/_relay/fs/read", { method: "POST", body: JSON.stringify({ path }) });
    if (!ok || !data?.ok) {
      throw new Error(`读取文件失败（${status}）：${data?.error || "未知错误"} —— ${path}`);
    }
    return data.text;
  }

  // T-fs 修复（2026-10-09）：工作流文件写盘的「中继后端」——app 进程受宿主 --permission 沙箱限制
  // （fs 白名单不含 ComfyUI 安装目录），落盘统一由中继代做（/_relay/fs/write，原子写）。
  async function writeWorkflowFileViaRelay(path, text) {
    const { status, ok, data } = await relayJson("/_relay/fs/write", {
      method: "POST",
      body: JSON.stringify({ path, text }),
      timeoutMs: 30_000,
    });
    if (!ok || !data || data.ok !== true) {
      throw new Error(`写入文件失败（${status}）：${(data && data.error) || "未知错误"} —— ${path}`);
    }
    return data;
  }

  async function loadTemplate(name) {
    const list = await relayJson("/userdata?dir=workflows&recurse=true&full_info=true");
    const items = list.ok && Array.isArray(list.data) ? list.data : [];
    const target = items.find((i) => i && (
      String(i.path) === name ||
      String(String(i.path).split("/").pop()) === name ||
      String(i.path).toLowerCase() === name.toLowerCase()
    ));
    if (!target) {
      const avail = items.slice(0, 12).map((i) => i.path).join(" / ");
      throw new Error(`userdata 工作流里找不到「${name}」。可用：${avail || "（空——请先在 ComfyUI 里保存一个工作流，或用「导出 API 格式」的文件路径）"}`);
    }
    // 读 userdata 经中继的 /_relay/userdata 代理：宿主 ctx.runtime.fetch 会拒绝含 %2F 的
    // pathname，而 /userdata/{file} 必须把斜杠编成 %2F，所以交给中继（node:http）代取。
    // 这里只把"相对路径"放进 query（斜杠原样、其余段逐段 encodeURIComponent）——encodeURI
    // 会漏编「+」，中继侧 URLSearchParams 会把裸 + 解成空格；逐段编码后 + → %2B。
    const p = String(target.path).replace(/\\/g, "/");
    const file = p.startsWith("workflows/") ? p : `workflows/${p}`;
    const res = await relayJson(`/_relay/userdata?file=${file.split("/").map(encodeURIComponent).join("/")}`, { timeoutMs: 30_000 });
    if (!res.ok || res.data === null || res.data === undefined) throw new Error(`读取模板内容失败：${target.path}`);
    const parsed = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    return { parsed, source: `userdata:${target.path}` };
  }

  async function resolveWorkflowToPrompt(workflow) {
    if (typeof workflow === "string") {
      const path = workflow.trim();
      if (!path) throw new Error("workflow 路径为空");
      const text = await readLocalText(path);
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error(`工作流文件不是合法 JSON：${path}（${msgOf(e)}）`); }
      if (Array.isArray(parsed.nodes)) {
        const api = convertUiToApi(parsed, await getObjectInfo());
        return { prompt: api, source: `file:${path}（UI 格式已转换）` };
      }
      if (isPlainObject(parsed)) return { prompt: parsed, source: `file:${path}（API 格式）` };
      throw new Error(`工作流文件结构无法识别：${path}`);
    }
    if (isPlainObject(workflow)) {
      if (typeof workflow.template === "string" && Object.keys(workflow).length === 1) {
        const { parsed, source } = await loadTemplate(workflow.template.trim());
        if (Array.isArray(parsed.nodes)) {
          const api = convertUiToApi(parsed, await getObjectInfo());
          return { prompt: api, source: `${source}（UI 格式已转换）` };
        }
        if (isPlainObject(parsed)) return { prompt: parsed, source: `${source}（API 格式）` };
        throw new Error(`模板结构无法识别：${workflow.template}`);
      }
      if (Array.isArray(workflow.nodes)) {
        const api = convertUiToApi(workflow, await getObjectInfo());
        return { prompt: api, source: "inline（UI 格式已转换）" };
      }
      return { prompt: workflow, source: "inline（API 格式）" };
    }
    throw new Error("workflow 需要：API 格式 JSON 对象 / 文件路径字符串 / {template:\"名称\"}");
  }

  // applyInputs / summarizeWorkflow 已移至 lib/workflow-tools.mjs（app 与中继共享，2026-09-29 M13）

  // ── 任务摘要数据（query 用）────────────────────────────────────────────────────────────
  function jobSummary(job) {
    const q = state.snapshot?.relay?.queue || null;
    let queuePosition = null;
    if (job.state === "pending" && q && typeof q.pending === "number") queuePosition = q.pending;
    const stateText = {
      pending: "排队中",
      running: "执行中",
      completed: "已完成",
      error: "失败",
      interrupted: "已中断",
      canceled: "已取消",
      timeout: "超时",
    }[job.state] || job.state;
    return {
      promptId: job.promptId,
      taskId: job.taskId,
      label: job.label,
      state: job.state,
      stateText,
      submittedAt: job.submittedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: elapsedMsOf(job),
      progress: job.progress,
      currentNode: job.currentNode,
      nodesDone: job.nodesDone,
      queuePosition,
      previewFrames: job.previewFrames || [],
      previewUpdatedAt: job.previewUpdatedAt || null,
      outputs: job.outputs.map((o) => ({
        filename: o.filename,
        subfolder: o.subfolder || "",
        type: o.type || "output",
        filePath: o.filePath || null,
        sizeBytes: o.sizeBytes ?? null,
        viewPath: o.viewPath || viewPathOf(o),
      })),
      error: job.error || null,
    };
  }

  async function findJobById(id) {
    if (!id) return null;
    if (state.jobs.has(id)) return state.jobs.get(id);
    for (const job of state.jobs.values()) {
      if (job.taskId === id) return job;
    }
    // 记忆外的 taskId：读宿主记录找 promptId（own-read 不需要写入授权）
    try {
      const rec = await sdk.tasks.get(id);
      const pid = rec?.metadata?.comfyui?.promptId;
      if (typeof pid === "string" && pid) {
        const { ok, data } = await relayJson(`/_relay/history?id=${encodeURIComponent(pid)}`, { timeoutMs: 8_000 });
        const entry = ok && Array.isArray(data?.entries) ? data.entries[0] : null;
        const ghost = {
          promptId: pid,
          taskId: id,
          label: String(rec.label || "ComfyUI 任务"),
          state: rec.status === "completed" ? "completed" : rec.status === "failed" ? "error" : rec.status === "canceled" || rec.status === "aborted" ? "canceled" : "unknown",
          submittedAt: rec.createdAt || Date.now(),
          startedAt: null,
          finishedAt: rec.completedAt || null,
          progress: null,
          currentNode: null,
          nodesDone: 0,
          outputs: entry?.outputs || [],
          error: entry?.error || null,
          historyFetched: true,
          taskNote: "宿主记录恢复（本进程重启前的任务）",
        };
        state.jobs.set(pid, ghost);
        return ghost;
      }
    } catch { /* 找不到就返回 null */ }
    return null;
  }

  // ── 流内任务卡（卡片功能恢复，2026-10-09）──────────────────────────────
  // 通道：工具回执 details.card（+ details.bridgedTool）——宿主投影为内联卡，挂在工具调用块下方；
  // 不注册 contributes.cards（卡片中心零新增；与下载器「妥善解决」同姿势）。
  // 卡页 route 静态（/task.html / /envcheck.html），身份经宿主 surface 上下文的 cardInstanceId 反查。
  function stableCardId(key) {
    return "a_" + createHash("sha256").update(`${APP_ID}:${key}`).digest("hex").slice(0, 20);
  }

  // 卡实例 id → 任务：遍历内存任务表（promptId → stableCardId 重算比对）。先验词法形状；
  // 记忆外（>50 条清理 / 进程重启）如实返回 null（卡页给「未找到」说明）。
  async function findJobByCardId(cardId) {
    if (!/^a_[0-9a-f]{20}$/.test(String(cardId || ""))) return null;
    for (const job of state.jobs.values()) {
      if (stableCardId(job.promptId) === cardId) return job;
    }
    return null;
  }

  // 任务卡 ref（backend submit / canvas submit / canvas queue 三路共用；route 静态、id 稳定）。
  function taskCardRef(promptId, label, description) {
    return {
      pluginId: APP_ID,
      cardId: "task",
      cardInstanceId: stableCardId(promptId),
      route: "/task.html",
      title: `ComfyUI 生成 · ${label}`,
      description,
      aspectRatio: "16:9",
      cardForm: "flush",
      preferredWidthPx: 460,
      titlebar: null,
    };
  }

  // 环境检查卡 ref（service envcheck / service start 两路共用；卡自带按钮流程，数据由卡页自拉）。
  function envcheckCardRef(snapshotId, blockerCount, sessionPath) {
    return {
      pluginId: APP_ID,
      cardId: "envcheck",
      cardInstanceId: stableCardId(`envcheck:${typeof sessionPath === "string" && sessionPath ? sessionPath : "any"}`),
      route: "/envcheck.html",
      title: "检测到其他模型占用 GPU",
      description: `发现 ${blockerCount} 个阻断项 · 快照 ${String(snapshotId || "").slice(0, 8)}…`,
      aspectRatio: "16:9",
      cardForm: "flush",
      preferredWidthPx: 460,
      titlebar: null,
    };
  }

  // ── 状态出口 ──────────────────────────────────────────────────────────────
  function proxyPrefix() {
    if (state.phase !== "ready" || !state.runtimeId) return null;
    return `/api/apps/${encodeURIComponent(APP_ID)}/routes/_runtime/${encodeURIComponent(state.runtimeId)}/`;
  }

  function noteForReady() {
    const backendOk = !!(state.snapshot && state.snapshot.relay && state.snapshot.relay.backend && state.snapshot.relay.backend.reachable);
    if (!state.snapshot) return "中继已就绪，正在读取状态快照……";
    if (!backendOk) {
      const env = state.snapshot.relay && state.snapshot.relay.env ? state.snapshot.relay.env : null;
      const hit = env && Array.isArray(env.installs) ? env.installs[0] : null;
      if (hit) {
        return `中继已就绪，但 ComfyUI 服务（${BACKEND.host}:${BACKEND.port}）不可达——检测到本机安装（${hit.path}），可能尚未启动。启动后中继会自动恢复；也可对 Hana 说「帮我启动 ComfyUI」。`;
      }
      return `中继已就绪，但 ComfyUI 服务（${BACKEND.host}:${BACKEND.port}）不可达——未在本机常见位置检测到 ComfyUI 安装。如果尚未安装，对 Hana 说「帮我安装 ComfyUI」（安装引导见 App 技能）；如果装在别处，请让助手按实际路径与端口接入。`;
    }
    return "中继已就绪：ComfyUI 前端可经代理路径加载（相对寻址），HTTP/WS 全通。";
  }

  function noteFor(phase) {
    switch (phase) {
      case "ready": return noteForReady();
      case "starting": return "中继正在启动（受管 runtime 拉起、监听、就绪握手）……";
      case "idle": return "中继尚未启动。App 加载后会自动拉起受管 runtime；稍候本页会自动刷新，也可点「重试启动」。";
      case "error": return state.lastError ? `中继启动失败：${state.lastError.userText}` : "中继启动失败（无详细错误）。可点「重试启动」；持续失败请看宿主日志。";
      case "stopped": return "中继已停止。再次启动会重新拉起受管 runtime。";
      default: return `未知状态：${String(phase)}`;
    }
  }

  function bootState() {
    const info = state.lastInfo;
    const svc = info && info.service ? info.service : null;
    return {
      phase: state.phase,
      runtimeId: state.runtimeId,
      proxyPrefix: proxyPrefix(),
      service: {
        state: svc && typeof svc.state === "string" ? svc.state : (state.servicePort ? "ready" : null),
        port: svc && typeof svc.port === "number" ? svc.port : (state.servicePort || null),
      },
      error: state.lastError ? { code: state.lastError.code, userText: state.lastError.userText } : null,
      note: noteFor(state.phase),
      updatedAt: new Date().toISOString(),
    };
  }

  function jobsSummary() {
    const all = [...state.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt);
    return {
      active: all.filter((j) => !TERMINAL_JOB.has(j.state)).map((j) => ({
        promptId: j.promptId, taskId: j.taskId, state: j.state, label: j.label,
        progress: j.progress, currentNode: j.currentNode, elapsedMs: elapsedMsOf(j),
      })),
      recent: all.filter((j) => TERMINAL_JOB.has(j.state)).slice(0, 10).map((j) => ({
        promptId: j.promptId, taskId: j.taskId, state: j.state, label: j.label,
        finishedAt: j.finishedAt, outputs: j.outputs.length,
      })),
    };
  }

  function fullStatus() {
    const snap = state.snapshot;
    return {
      ok: true,
      app: { id: APP_ID, version: APP_VERSION },
      boot: bootState(),
      relay: snap ? snap.relay : null,
      relayError: snap ? snap.error : null,
      snapshotAt: snap ? new Date(snap.at).toISOString() : null,
      backendUrl: `http://${BACKEND.host}:${BACKEND.port}`,
      jobs: jobsSummary(),
      comfyBase: comfyBase(),
    };
  }

  // B 主链（2026-10-08）：四态诊断的文本行——「缺什么说什么」单一口径（status 与 submit auto 共用 diagnoseEnvironment）。
  function envStatusLines(env) {
    if (!env) return [];
    const tick = (v) => (v ? "✓" : "✗");
    const svc = env.serviceOk === true
      ? "可达"
      : env.serviceOk === false
        ? (env.serviceDetail && env.serviceDetail.starting ? "启动中" : "不可达")
        : "未判（中继未就绪）";
    const page = env.pageOk === true
      ? `桥可达（${env.pageVia === "shell" ? "壳页腿" : "扩展腿"}）`
      : env.pageOk === false
        ? "桥不可达"
        : `未探（壳页心跳：${env.shellOk ? "在线" : "不在线"}）`;
    const lines = [`- 环境：中继 ${tick(env.relayOk)} · 服务 ${svc} · 画布 ${page} · 授权 写${tick(env.allowWrite)}／副驾驶${tick(env.allowCopilot)}`];
    if (env.reasons && env.reasons.length) lines.push(`- 环境缺口：${env.reasons.join("；")}`);
    return lines;
  }

  function statusText(envDiag = null) {
    const boot = bootState();
    const snap = state.snapshot;
    const relay = snap && snap.relay ? snap.relay : null;
    const jobs = jobsSummary();
    const lines = [];
    lines.push(`Hana-ComfyUI 状态（v${APP_VERSION}）`);
    lines.push(`- 中继：${boot.phase}${boot.runtimeId ? ` · runtimeId=${boot.runtimeId}` : ""}${boot.service.port ? ` · 服务端口 ${boot.service.port}` : ""}`);
    if (relay && relay.backend) {
      const b = relay.backend;
      const sys = b.system || {};
      const ver = sys.comfyui_version ? `ComfyUI ${sys.comfyui_version}` : "ComfyUI（版本未知）";
      lines.push(`- 后端 http://${BACKEND.host}:${BACKEND.port}：${b.reachable ? "可达" : "不可达"} · ${ver}${sys.installed_frontend_version ? `（前端 ${sys.installed_frontend_version}）` : ""}`);
      if (relay.queue) lines.push(`- 队列：运行中 ${relay.queue.running} · 排队 ${relay.queue.pending}`);
      if (relay.events) lines.push(`- 事件订阅：${relay.events.connected ? "已连接" : "未连接"}（缓存 ${relay.events.promptsTracked} 条）`);
      if (relay.requests) lines.push(`- 中继请求：累计 ${relay.requests.total}（WS ${relay.requests.ws}）· 错误 ${relay.requests.errors}`);
      if (!b.reachable && b.lastError) lines.push(`- 后端错误：${b.lastError}`);
      if (!b.reachable) {
        const env = relay.env || null;
        if (env && env.found) {
          lines.push(`- 本机安装探测：检测到 ${env.installs.map((i) => `${i.path}（${i.kind}${i.version ? ` ${i.version}` : ""}${i.hasVenv ? "，含环境" : ""}）`).join("；")}`);
        } else if (env) {
          lines.push("- 本机安装探测：常见位置未发现 ComfyUI（如已安装在别处，请告知实际位置；如尚未安装，可让助手引导安装）");
        }
      }
    } else {
      lines.push(`- 后端：状态快照未就绪${snap && snap.error ? `（${snap.error}）` : ""}`);
    }
    lines.push(...envStatusLines(envDiag));
    if (jobs.active.length) {
      lines.push(`- 运行中任务（${jobs.active.length}）：`);
      for (const j of jobs.active.slice(0, 5)) {
        const p = j.progress ? ` ${j.progress.value}/${j.progress.max}` : "";
        lines.push(`  · ${j.label}（${j.promptId.slice(0, 8)}…，${j.state}${j.currentNode !== null ? `，节点 ${j.currentNode}` : ""}${p}，${Math.round(j.elapsedMs / 1000)}s）`);
      }
    }
    if (jobs.recent.length) {
      lines.push(`- 最近任务：${jobs.recent.slice(0, 5).map((j) => `${j.promptId.slice(0, 8)}…(${j.state},${j.outputs}产物)`).join(" · ")}`);
    }
    if (boot.error) lines.push(`- 错误：${boot.error.code} — ${boot.error.userText}`);
    lines.push(`- 说明：${boot.note}`);
    return lines.join("\n");
  }

  // 宿主边界（2026-09-21 实测）：next-step 的可靠投递只写桌面会话（agents/{id}/sessions/*.jsonl）；
  // 子代理会话（agents/{id}/subagent-sessions/direct/*.jsonl）会被宿主静默拒绝（console 级）——
  // 从子代理发起的任务不会自动回执，工具文案必须如实说明，避免制造预期落差。
  function isSubagentSessionPath(p) {
    return typeof p === "string" && /[\\/]subagent-sessions[\\/]/i.test(p);
  }
  const SUBAGENT_DELIVERY_NOTE = "来源是子代理会话：宿主 next-step 投递仅支持桌面会话，完成后不会自动回执（请用 comfyui action=query/result 主动取结果；需要自动回执请从主对话发起）";

  // ── A 批（2026-10-08）：auto 停下（blocked）回执 ────────────────────────────
  // 停下形态对齐 envcheck blocked 范式（见「服务环境检查」区 service start）：正常返回（不 throw）+
  // details.comfyui.blocked —— 非交互场景即停在回执，不自动 fall-through 到 backend。
  function submitStoppedReply({ code, reason, options }) {
    const opts = (Array.isArray(options) ? options : []).filter((s) => typeof s === "string" && s.trim());
    const marks = ["①", "②", "③", "④", "⑤"];
    const text = [
      `提交未执行（已停下，未自动改走后台）：${reason}`,
      opts.length ? "可选：" : "",
      ...opts.map((o, i) => `- ${marks[i] || `${i + 1}.`} ${o}`),
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        comfyui: {
          action: "submit",
          mode: "auto",
          blocked: true,
          code: code || "canvas-unknown",
          reason,
          options: opts,
        },
      },
    };
  }

  // auto 下画布流程失败的分类 → 停下回执（画布忙不在此列：由调用方报错退出，不抢占）。
  function autoStopReplyForCanvasError(e) {
    const code = (e && e.code) || "canvas-unknown";
    if (code === "canvas-unauthorized" || code === "copilot-off") {
      const gate = (e && e.gate) || (code === "copilot-off" ? "copilot" : "");
      const swName = gate === "copilot" ? "「允许 Agent 开启画布副驾驶」" : "「允许 agent 修改画布」";
      return submitStoppedReply({
        code,
        reason: code === "copilot-off" ? "该画布未开启副驾驶（桥侧写拦截拒绝）" : msgOf(e),
        options: [
          `去 Hana-ComfyUI 设置页 → 画布（共驾）→ 打开 ${swName}，然后说「继续」重新提交`,
          "如明确要走后台生图：重新提交时传 mode=backend（后台直提有丢值先例——UI→API 转换的原语节点值回退、LoadImageOutput 回卷等，关键参数请核对）",
          "先不跑（本次已停在回执，不会自动走后台）",
        ],
      });
    }
    if (code === "canvas-offline") {
      // B 主链起：环境缺走自举链（快返「环境准备中」→ 后台 → 自动继续）；本分支仅剩防御性兜底
      // ——在线路径与自动继续路径都不该再抛 canvas-offline（probeIn 已通过才会进画布流程）。
      return submitStoppedReply({
        code,
        reason: msgOf(e),
        options: [
          "重新提交即可（环境缺会自动准备：中继/服务自举、工作区未开自动拉起窗口）",
          "或先手动启动 ComfyUI 服务并打开 Hana-ComfyUI 工作区页面",
        ],
      });
    }
    return submitStoppedReply({ code, reason: msgOf(e), options: [] });
  }

  // ── 工具动作实现 ──────────────────────────────────────────────────────────
  async function actionSubmit(args, context) {
    // ── 分流（A 批 2026-10-08 新口径 + B 主链 2026-10-08 升级）：mode=auto|canvas|backend ──
    // auto（默认）：画布在线【壳页腿或扩展腿任一可达（#49）】、服务可达且两个授权闸都开 → canvas 流程
    //   （复制副本 → 装载 → canvas.queue）。不满足时分两类：
    //   · 环境缺（中继 / 服务 / 工作区）且可补 →【B 主链】自举：快返「环境准备中」回执（phase=preparing）
    //     → 后台准备（单一互斥；服务 envcheck→start→多轮 wait；工作区未开自动拉起窗口）→ 就绪自动继续；
    //     阻断/未装/拉不起 → 停下回执（blocked / 准备任务失败，不自动清障）。
    //   · 授权缺 / 装载失败 / 其余 → 停下——正常返回 + details.comfyui.blocked（对齐 envcheck 范式，
    //     不 throw、不静默 fall-through 到 backend）：授权缺 → 停下 + 选项（开开关 / 显式后台 / 先不跑）；
    //     装载/执行失败 → 停下 + 原因；其余未知错误 → 停下 + 原因。画布忙 → 报错退出（不抢占，保持现状）。
    // 结构性豁免（inline 对象 / 带非空 inputs）：形态判定前置（先于 probe），直接走 backend 流程，
    //   回执注明「未上画布：inline/inputs 形态直走后台提交」（命令形态直提，非环境失败）。
    // canvas：强制画布路径，前置不满足直接报错；backend：显式后台直提（唯一记待同步的路径）。
    const modeRaw = typeof args.mode === "string" && args.mode.trim() ? args.mode.trim().toLowerCase() : "";
    if (modeRaw && !["auto", "canvas", "backend"].includes(modeRaw)) {
      throw new Error(`mode 必须是 auto / canvas / backend（收到 "${args.mode}"）`);
    }
    const mode = modeRaw || "auto";
    let degradeNote = "";
    let structuralExempt = false; // T1-2：auto 下「inline/inputs 形态直走后台」的结构豁免标记
    if (mode === "canvas") {
      return await submitCanvasFlow(args, context);
    }
    if (mode === "auto") {
      // 结构性豁免判定（先于 probe）：inline 对象（非 {template} 单键形态）或带非空 inputs。
      const wfArgAuto = args.workflow;
      const isTemplateForm = isPlainObject(wfArgAuto) && typeof wfArgAuto.template === "string" && Object.keys(wfArgAuto).length === 1;
      const isInlineObject = isPlainObject(wfArgAuto) && !isTemplateForm;
      const inputsNonEmpty =
        args.inputs !== undefined && args.inputs !== null &&
        !(typeof args.inputs === "object" && Object.keys(args.inputs || {}).length === 0);
      if (isInlineObject || inputsNonEmpty) {
        degradeNote = "inline/inputs 形态直走后台提交";
        structuralExempt = true;
      } else {
        // B 主链：四态诊断（中继/服务，轻读）→ 通过再探页面态（#49 两腿判定）→ 全过直走现状；
        // 有缺 → 自举链（快返「环境准备中」+ 后台准备 + 就绪自动继续）。
        const diag = await diagnoseEnvironment();
        let probe = null;
        let envOk = diag.relayOk && diag.serviceOk === true;
        if (envOk) {
          probe = await canvasProbe();
          envOk = probe.ok;
        }
        if (!envOk) {
          return await submitBootstrapFlow(args, context, { diag, probe });
        }
        try {
          return await submitCanvasFlow(args, context, probe);
        } catch (e) {
          if (e && e.code === "canvas-busy") throw e; // 画布忙：报错退出（不抢占、不静默改走后端）
          const stopped = autoStopReplyForCanvasError(e);
          warn(`submit auto 停下（${stopped.details.comfyui.code}）：${stopped.details.comfyui.reason}`);
          return stopped;
        }
      }
    } else if (mode === "backend") {
      degradeNote = "显式 mode=backend";
    }
    // ── backend 流程（M13 分流原样）──────────────────────────────────────────
    // 入口（A 批收口）：仅显式 mode=backend 与 auto 的结构豁免（inline/inputs）走到这里。
    // 文件 / template 形态 → 中继侧直读直提（/_relay/submit-file）：大数据不过宿主
    //   runtime.fetch 隧道（其请求 1 MiB / 响应 4 MiB 为宿主硬限，见 docs/大工作流提交修复-20260929.md）。
    // inline 对象形态 → 原链路（内容已在内存，走 /prompt）。
    const wfArg = args.workflow;
    const wfPath = typeof wfArg === "string" ? wfArg.trim() : "";
    const wfTemplate =
      isPlainObject(wfArg) && typeof wfArg.template === "string" && Object.keys(wfArg).length === 1
        ? wfArg.template.trim()
        : "";

    let promptId = null;
    let source = "";
    let applied = [];
    let nodeCount = 0;

    if (wfPath || wfTemplate) {
      const reqBody = {
        ...(wfPath ? { path: wfPath } : { template: wfTemplate }),
        ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
        ...(args.front === true ? { front: true } : {}),
      };
      const { ok, status, data } = await relayJson("/_relay/submit-file", { method: "POST", body: JSON.stringify(reqBody), timeoutMs: 30_000 });
      if (!ok || !data || data.ok !== true || typeof data.prompt_id !== "string") {
        const detail = data && (data.error || data.detail) ? String(data.error || data.detail) : `HTTP ${status}`;
        const nodeErrors = data && data.node_errors && Object.keys(data.node_errors).length
          ? `；node_errors: ${JSON.stringify(data.node_errors).slice(0, 700)}`
          : "";
        throw new Error(`提交失败（${detail}）${nodeErrors}`);
      }
      promptId = data.prompt_id;
      source = String(data.source || (wfPath ? `file:${wfPath}` : `userdata:${wfTemplate}`));
      applied = Array.isArray(data.applied) ? data.applied : [];
      nodeCount = Number(data.nodeCount) || 0;
    } else {
      const { prompt, source: src } = await resolveWorkflowToPrompt(wfArg);
      if (!isPlainObject(prompt) || Object.keys(prompt).length === 0) {
        throw new Error("工作流为空或结构无法识别（需要 API 格式：{ \"<node_id>\": { class_type, inputs } }）");
      }
      const appliedList = applyInputs(prompt, args.inputs);
      const body = { prompt, client_id: state.clientId || RELAY_CLIENT_ID_PREFIX };
      if (args.front === true) body.front = true;
      const { ok, status, data } = await relayJson("/prompt", { method: "POST", body: JSON.stringify(body), timeoutMs: 30_000 });
      if (!ok) {
        const errObj = data && isPlainObject(data.error) ? data.error : null;
        const msg = errObj ? `${errObj.type || "error"}: ${String(errObj.message || "").slice(0, 400)}` : `HTTP ${status}`;
        const nodeErrors = data && data.node_errors && Object.keys(data.node_errors).length
          ? `；node_errors: ${JSON.stringify(data.node_errors).slice(0, 700)}`
          : "";
        throw new Error(`提交失败（${msg}）${nodeErrors}`);
      }
      promptId = data && typeof data.prompt_id === "string" ? data.prompt_id : null;
      if (!promptId) throw new Error(`后端未返回 prompt_id：${JSON.stringify(data).slice(0, 300)}`);
      source = src;
      applied = appliedList;
      nodeCount = Object.keys(prompt).length;
    }
    // D2 记账（契约 §3.3；A 批 2026-10-08 收口）：仅显式 mode=backend 的产出记账
    // （auto 停下 / 结构豁免直提不记）；画布恢复且获授权后惰性回填。
    if (mode === "backend") {
      try {
        const wfRef = await describeWorkflowRef(wfPath, wfTemplate);
        recordPendingCanvas({ workflowRef: wfRef, promptId, note: degradeNote || "mode=backend" });
      } catch (e) {
        warn(`待同步记账失败：${msgOf(e)}`);
      }
    }

    const label = String(args.clientLabel || "").trim().slice(0, 120) || `ComfyUI 生成（${nodeCount} 节点）`;

    const job = newJob(promptId, label);

    // 任务桥（需要 app/tasks.manage + app/session.start-turn；缺任一项则降级）
    const callToken = context && typeof context.callToken === "string" ? context.callToken : "";
    const sessionPath = context && typeof context.sessionPath === "string" ? context.sessionPath : "";
    const subagentOrigin = isSubagentSessionPath(sessionPath);
    let bridge = "none";
    if (callToken) {
      const [c1, c2] = await Promise.all([hasCapability(CAP_TASKS), hasCapability(CAP_START_TURN)]);
      if (!c1) {
        job.taskNote = "缺少能力 app/tasks.manage（未创建宿主任务）";
      } else if (!c2) {
        job.taskNote = "缺少能力 app/session.start-turn（未创建会话任务/投递）";
      } else {
        try {
          const task = await sdk.tasks.create({
            callToken,
            label,
            delivery: "next-step",
            metadata: { comfyui: { action: "submit", promptId, label, submittedAt: job.submittedAt } },
          });
          job.taskId = task && task.taskId ? String(task.taskId) : null;
          bridge = job.taskId ? "created" : "none";
          if (!job.taskId) job.taskNote = "ctx.tasks.create 未返回 taskId";
          else if (subagentOrigin) job.taskNote = SUBAGENT_DELIVERY_NOTE;
        } catch (e) {
          job.taskNote = `宿主任务创建失败：${msgOf(e).slice(0, 200)}`;
          warn(job.taskNote);
        }
      }
    } else {
      job.taskNote = "无 callToken（按钮通道调用）：仅内存跟踪，不投递结果";
    }

    startStatusPolling();
    // A 批（2026-10-08）：未上画布注记——显式 backend 保留「已记待同步」；结构豁免直提如实注明（未记）。
    // T1-2（2026-10-10）：结构豁免（inline/inputs 直提后端）回执升级为显著「警示」措辞，并带 backendDirect
    //   标记（程序可判定）——把「未经画布的直提」这条假成功高发路径讲清楚。
    const backendDirect = structuralExempt || mode === "backend";
    const notOnCanvasLine = structuralExempt
      ? [
          `- ⚠️ 警示：本次未经画布，直提后端（${degradeNote}）。`,
          "- ⚠️ 风险：后端 UI→API 转换对原语节点会丢值、LoadImageOutput 等受控下拉可能回卷，出图内容可能与画布所见不一致（假成功）。",
          "- ➜ 要值正确 / 要人机共驾：请走画布路径（去掉 inputs，用 canvas.queue 提交）。",
        ].join("\n")
      : mode === "backend"
        ? `- 未上画布：${degradeNote}；已记待同步（画布恢复且获授权后可回填）`
        : "";
    const text = [
      `已提交 ComfyUI 工作流：${label}`,
      `- prompt_id: ${promptId}`,
      `- 来源：${source}${applied.length ? `（inputs 注入 ${applied.length} 项：${applied.slice(0, 6).join(", ")}${applied.length > 6 ? "…" : ""}）` : ""}`,
      job.taskId
        ? (subagentOrigin
            ? `- 宿主任务：${job.taskId}（next-step；⚠️ ${SUBAGENT_DELIVERY_NOTE}）`
            : `- 宿主任务：${job.taskId}（next-step 投递，完成后自动回执）`)
        : `- 宿主任务：未创建${job.taskNote ? `（${job.taskNote}）` : ""}`,
      `- 跟踪方式：${
        bridge === "created"
          ? (subagentOrigin
              ? "后台自动跟踪（自动回执不适用，用 comfyui action=query/result 取结果）"
              : "后台自动跟踪（进度可用 comfyui action=query 查）")
          : "后台自动跟踪（结果不主动投递，用 comfyui action=result 取产物）"
      }`,
      notOnCanvasLine,
      mode === "backend" ? "- 风险说明：后台直提存在值丢先例（UI→API 转换的原语节点值回退、LoadImageOutput 回卷等）；关键参数与参考图请自行核对。" : "",
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        bridgedTool: { name: "comfyui", server: APP_ID },
        card: taskCardRef(promptId, label, `prompt ${promptId.slice(0, 8)}… · ${source}${applied.length ? ` · 注入 ${applied.length} 项` : ""}`),
        comfyui: {
          action: "submit",
          mode: "backend",
          promptId,
          taskId: job.taskId,
          label,
          source,
          injected: applied,
          submittedAt: job.submittedAt,
          bridge,
          bridgeNote: job.taskNote || null,
          originSession: sessionPath ? (subagentOrigin ? "subagent" : "desktop") : "unknown",
          deliverySupported: job.taskId ? !subagentOrigin : null,
          degradeNote: degradeNote || null,
          backendDirect,
          backendDirectReason: structuralExempt ? "inline/inputs" : mode === "backend" ? "explicit" : null,
        },
      },
    };
  }

  // 宿主任务桥（P8 抽取，2026-10-08）：newJob（幂等）→ 尝试创建宿主任务（能力/投递按既有口径降级）
  // → 确保状态轮询已启动。供「submit 画布流程」与「canvas op=queue」两路复用；
  // 返回 { job, bridge, subagentOrigin, sessionPath }——bridge: "created" | "none"。
  async function attachHostTask(promptId, { label, context, meta, mode }) {
    const job = state.jobs.get(promptId) || newJob(promptId, label);
    const callToken = context && typeof context.callToken === "string" ? context.callToken : "";
    const sessionPath = context && typeof context.sessionPath === "string" ? context.sessionPath : "";
    const subagentOrigin = isSubagentSessionPath(sessionPath);
    let bridge = "none";
    if (callToken) {
      const [c1, c2] = await Promise.all([hasCapability(CAP_TASKS), hasCapability(CAP_START_TURN)]);
      if (!c1) {
        job.taskNote = "缺少能力 app/tasks.manage（未创建宿主任务）";
      } else if (!c2) {
        job.taskNote = "缺少能力 app/session.start-turn（未创建会话任务/投递）";
      } else {
        try {
          const task = await sdk.tasks.create({
            callToken,
            label,
            delivery: "next-step",
            metadata: { comfyui: { action: "submit", mode, promptId, label, ...(meta && typeof meta === "object" ? meta : {}), submittedAt: job.submittedAt } },
          });
          job.taskId = task && task.taskId ? String(task.taskId) : null;
          bridge = job.taskId ? "created" : "none";
          if (!job.taskId) job.taskNote = "ctx.tasks.create 未返回 taskId";
          else if (subagentOrigin) job.taskNote = SUBAGENT_DELIVERY_NOTE;
        } catch (e) {
          job.taskNote = `宿主任务创建失败：${msgOf(e).slice(0, 200)}`;
          warn(job.taskNote);
        }
      }
    } else {
      job.taskNote = "无 callToken（按钮通道调用）：仅内存跟踪，不投递结果";
    }
    startStatusPolling();
    return { job, bridge, subagentOrigin, sessionPath };
  }

  // canvas 流程（D1 契约 §3.1；v2 副驾驶规则 2026-10-08 升级为「复制工作台」五步）：
  //   duplicate（复制副本）→ save（副本落盘：<原名去尾> (AgentCopy) YYYYMMDD-HHmm，重名递增）
  //   → 开副本 copilot → loadWorkflowFile（装载）→ settle + 落点断言 → canvas.queue（快返）。
  //   前置：画布在线 + 写授权 + 副驾驶总闸（readAllowCopilot）；不满足时按失败码抛错。
  //   失败抛错（code：canvas-offline / canvas-busy / canvas-unauthorized / canvas-unloadable / canvas-failed），
  //   auto 调用方按 code 分流：授权缺 / 失败 / 未知 → 停下回执（blocked）；canvas-busy → 报错退出。
  async function submitCanvasFlow(args, context, probeIn, preRefIn) {
    const probe = probeIn || (await canvasProbe());
    if (!probe.ok) {
      const e = new Error(probe.reason); e.code = "canvas-offline"; throw e;
    }
    const running = probe.running || {};
    if (running.runningNodeId != null) {
      const e = new Error(`画布忙（有任务正在执行，运行节点 #${running.runningNodeId}），本提交未上画布（不抢占）。如确实要走后端，请显式 mode=backend 重新提交。`);
      e.code = "canvas-busy"; throw e;
    }
    if (!readAllowWrite()) {
      const e = new Error("未开启「允许 agent 修改画布」授权（画布流程会复制/装载/执行，需先在 Hana-ComfyUI 设置页开启；或显式 mode=backend）");
      e.code = "canvas-unauthorized"; e.gate = "write"; throw e;
    }
    // v2（2026-10-08）：副驾驶总闸——canvas 流程要在副本上开启副驾驶（第 3 步）；
    // 总闸关则不可走画布路径（auto 停下 + 选项；显式 mode=canvas 时直接报错）。
    if (!readAllowCopilot()) {
      const e = new Error("未开启「允许 Agent 开启画布副驾驶」授权——canvas 流程需在副本上开启副驾驶（请先在 Hana-ComfyUI 设置页打开「允许 Agent 开启画布副驾驶」；或显式 mode=backend）");
      e.code = "canvas-unauthorized"; e.gate = "copilot"; throw e;
    }
    if (args.inputs !== undefined && args.inputs !== null && !(typeof args.inputs === "object" && Object.keys(args.inputs || {}).length === 0)) {
      const e = new Error("inputs 注入暂不支持画布路径（画布按文件装载原样参数；可显式 mode=backend 做注入）");
      e.code = "canvas-unloadable"; throw e;
    }
    // ① 装载引用解析（不可装载的形态在此提前失败，避免“先复制再失败”的副作用）
    const wfArg = args.workflow;
    const wfPath = typeof wfArg === "string" ? wfArg.trim() : "";
    const wfTemplate = isPlainObject(wfArg) && typeof wfArg.template === "string" && Object.keys(wfArg).length === 1 ? wfArg.template.trim() : "";
    const ref = preRefIn || (await resolveCanvasLoadRef({ wfPath, wfTemplate }));
    // ② 复制副本（v2 固定路径，2026-10-08）：无论用户画布副驾驶开关如何，一律先复制——
    //    「copilot 开 = 共编同页」自动分支已去除（降为「用户明确要求」的人工例外，不走本流程）。
    //    红线：原布零改动。
    const dup = await canvasBridgeInvoke("canvas.duplicate", {});
    if (!dup.ok) {
      if (dup.error === "copilot_off") throw copilotOffError("duplicate", dup); // 防御：duplicate 本在豁免名单
      const e = new Error(`复制画布失败：${dup.error || "未知"}`); e.code = "canvas-failed"; throw e;
    }
    const dupPage = dup.payload && dup.payload.page ? String(dup.payload.page) : null;
    const dupKey = dup.payload && dup.payload.key ? String(dup.payload.key) : null;
    const pageKey = dupPage || dupKey || null;
    // ③ 副本落盘：命名 <原名去尾> (AgentCopy) YYYYMMDD-HHmm（重名递增；语义见 pickAgentCopyName）。
    //    落盘走桥的「另存并切换」链——先拿到有文件身份的副本，再开副驾驶（v2 第 2、3 步顺序固定）。
    const copyName = await pickAgentCopyName(dupPage || dupKey);
    const saveRevBefore = await canvasRevisionRead();
    const sv = await canvasBridgeInvoke("canvas.save", { name: copyName });
    if (!sv.ok) {
      if (sv.error === "copilot_off") throw copilotOffError("save", sv); // 防御：save 本在豁免名单
      const e = new Error(`副本落盘失败：${sv.error || "未知"}`); e.code = "canvas-failed"; throw e;
    }
    if (sv.payload && sv.payload.savedAs === true && sv.payload.pending === true) {
      await settleSaveAsPending(sv.payload, saveRevBefore);
    }
    const copyFile = sv.payload && sv.payload.saved ? String(sv.payload.saved) : `workflows/${copyName}.json`;
    // ④ 开副本副驾驶（v2 第 3 步；Agent 默认在副本上工作——不碰原布）
    const cp = await canvasBridgeInvoke("canvas.copilot", { enabled: true });
    if (!cp.ok || !(cp.payload && cp.payload.enabled === true)) {
      if (cp.error === "copilot_off") throw copilotOffError("copilot", cp); // 防御：copilot 本在豁免名单
      const e = new Error(`开启副本副驾驶失败：${cp.error || "回执未确认开启"}`); e.code = "canvas-failed"; throw e;
    }
    // ⑤ 装载提交的工作流到副本（force：装载发生在副本上——零风险）。
    //    ⚠ 时序（修复 3）：桥侧 loadWorkflowFile 是快返（fire-and-forget）；v1.53.6 的
    //    app.loadGraphData 在 configure 前至少 3 处 await（扩展钩子 ×2、nodeReplacementStore.load），
    //    且 clean() 先行清图——快返后画布可能仍处「空图 / 旧图」窗口，不能拿快返当「装好了」。
    //    身份保持（补丁批 2026-10-08 已就位）：loadWorkflowFile 传「装载前活动页对象」为第 4 参，
    //    活动页保持在副本页（v1.55.14 activateLoadedWorkflow 对对象走 store.openWorkflow）。
    const revBefore = await canvasRevisionRead(); // 装载前序号（settle 参照；取不到退化为纯计数判定）
    const ld = await canvasBridgeInvoke("canvas.loadWorkflowFile", { file: ref.file, force: true });
    if (!ld.ok) {
      if (ld.error === "copilot_off") throw copilotOffError("loadWorkflowFile", ld);
      const e = new Error(`装载工作流到画布失败：${ld.error || "未知"}`); e.code = "canvas-failed"; throw e;
    }
    if (ld.payload && ld.payload.loaded === false) {
      const e = new Error(`装载被拒（${ld.payload.blocked || "未保存保护等"}）`); e.code = "canvas-failed"; throw e;
    }
    // ⑥ settle + 落点断言（v2：总是断言——执行页必须是 Agent 副本页）。
    //    等目标页节点数与预期一致（或 revision 位移）再放行 queue；超时 / 落点不符 → 报错退出（不 queue）。
    const targetCandidates = [...new Set([copyName, copyFile, dupPage, dupKey].filter(Boolean))];
    await waitCanvasLoadSettled({
      expectedNodes: ld.payload && Number.isFinite(Number(ld.payload.nodeCount)) ? Number(ld.payload.nodeCount) : null,
      revBefore: revBefore ? revBefore.revision : null,
      targetCandidates,
    });
    // ⑦ 画布发起执行（快返）；promptId 缺失时用 /queue 前后差集反查
    const before = await queuePromptIdsSnapshot();
    const q = await canvasBridgeInvoke("canvas.queue", args.front === true ? { front: true } : {});
    if (!q.ok) { const e = new Error(`画布执行提交失败：${q.error || "未知"}`); e.code = "canvas-failed"; throw e; }
    let promptId = q.payload && typeof q.payload.promptId === "string" && q.payload.promptId ? q.payload.promptId : null;
    const number = q.payload && q.payload.number !== undefined ? q.payload.number : undefined;
    let promptIdVia = promptId ? "queue-op" : null;
    if (!promptId) {
      const after = await queuePromptIdsSnapshot();
      if (before && after) {
        const fresh = [...after].filter((id) => !before.has(id));
        if (fresh.length === 1) { promptId = fresh[0]; promptIdVia = "queue-diff"; }
      }
    }
    // ⑧ 返回与跟踪：有 promptId → 与 backend 流程同构（宿主任务 + 轮询结算）；
    //    缺失（桥未实现反查）→ 如实说明不可自动跟踪。进度均以画布原生 UI 为准。
    const refName = String(ref.file).split("/").pop() || ref.file;
    const nodeCount = ld.payload && Number.isFinite(Number(ld.payload.nodeCount)) ? Number(ld.payload.nodeCount) : null;
    const label = String(args.clientLabel || "").trim().slice(0, 120) || `ComfyUI 生成（${refName}${nodeCount ? ` · ${nodeCount} 节点` : ""}）`;
    if (!promptId) {
      const text = [
        `已发起画布执行（快返）：${label}`,
        `- 执行位置：画布（Agent 副本页${copyName ? `：${copyName}` : ""}）`,
        `- 副本文件：${copyFile}（副驾驶已开）`,
        `- 来源：${ref.source}`,
        "- 注意：桥未回传 prompt_id，本次无法自动跟踪（进度以画布原生 UI 为准）。",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { comfyui: { action: "submit", mode: "canvas", ok: true, promptId: null, pageKey, agentCopy: { name: copyName, file: copyFile, copilotOn: true }, source: ref.source, queued: true, promptIdVia: null } },
      };
    }
    // P8（2026-10-08）：任务桥抽取为 attachHostTask（submit / queue 两路复用），行为与原先一致。
    const { job, bridge, subagentOrigin, sessionPath } = await attachHostTask(promptId, {
      label,
      context,
      mode: "canvas",
      meta: { pageKey, copyName },
    });
    const text = [
      `已提交 ComfyUI 工作流（画布执行，快返）：${label}`,
      `- prompt_id: ${promptId}${promptIdVia === "queue-diff" ? "（经 /queue 差集反查）" : ""}`,
      `- 执行位置：画布（Agent 副本页${copyName ? `：${copyName}` : ""}）`,
      `- 副本文件：${copyFile}（副驾驶已开；原布未被触碰）`,
      `- 来源：${ref.source}`,
      job.taskId
        ? (subagentOrigin
            ? `- 宿主任务：${job.taskId}（next-step；⚠️ ${SUBAGENT_DELIVERY_NOTE}）`
            : `- 宿主任务：${job.taskId}（next-step 投递，完成后自动回执）`)
        : `- 宿主任务：未创建${job.taskNote ? `（${job.taskNote}）` : ""}`,
      `- 跟踪方式：进度以画布原生 UI 为准${bridge === "created" ? (subagentOrigin ? "；自动回执不适用，用 comfyui action=query/result 取结果" : "；完成后宿主自动回执") : "；用 comfyui action=result 取产物"}`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        bridgedTool: { name: "comfyui", server: APP_ID },
        card: taskCardRef(promptId, label, `prompt ${promptId.slice(0, 8)}… · ${ref.source} · 画布执行`),
        comfyui: {
          action: "submit",
          mode: "canvas",
          promptId,
          taskId: job.taskId,
          label,
          source: ref.source,
          pageKey,
          agentCopy: { name: copyName, file: copyFile, copilotOn: true },
          promptIdVia,
          number,
          submittedAt: job.submittedAt,
          bridge,
          bridgeNote: job.taskNote || null,
          originSession: sessionPath ? (subagentOrigin ? "subagent" : "desktop") : "unknown",
          deliverySupported: job.taskId ? !subagentOrigin : null,
        },
      },
    };
  }

  async function resolvePromptId(args) {
    if (typeof args.promptId === "string" && args.promptId.trim()) return args.promptId.trim();
    if (typeof args.taskId === "string" && args.taskId.trim()) {
      const job = await findJobById(args.taskId.trim());
      if (job) return job.promptId;
      throw new Error(`找不到 taskId 对应的任务：${args.taskId}（宿主记录里没有 comfyui.promptId）`);
    }
    return null;
  }

  async function actionQuery(args) {
    const promptId = await resolvePromptId(args);
    if (promptId) {
      const job = state.jobs.get(promptId) || (await findJobById(promptId));
      const promptsSnap = await relayJson("/_relay/prompts", { timeoutMs: 6_000 }).catch(() => null);
      const rec = promptsSnap?.ok
        ? ((promptsSnap.data.active || []).find((r) => r.promptId === promptId) || (promptsSnap.data.recent || []).find((r) => r.promptId === promptId))
        : null;
      let entry = null;
      try {
        const h = await relayJson(`/_relay/history?id=${encodeURIComponent(promptId)}`, { timeoutMs: 8_000 });
        entry = h.ok && Array.isArray(h.data?.entries) ? h.data.entries[0] : null;
      } catch { /* 历史可缺 */ }
      const jobState = job ? job.state : (entry ? (entry.completed ? "completed" : entry.status === "error" ? "error" : "running") : rec ? rec.state : "unknown");
      // 投递状态探针（宿主侧：published=已发布待投递 / delivered=已送达；子代理会话预期停在 published）
      let delivery = null;
      if (job && job.taskId && typeof sdk.tasks?.getDelivery === "function") {
        try { delivery = await sdk.tasks.getDelivery(job.taskId); } catch { /* 读不到不影响查询 */ }
      }
      const lines = [`ComfyUI 任务查询：${promptId}`];
      lines.push(`- 状态：${jobState}${job && job.taskId ? ` · 宿主任务 ${job.taskId}` : ""}`);
      if (job) lines.push(`- 标签：${job.label} · 用时 ${Math.round(elapsedMsOf(job) / 1000)}s`);
      if (delivery) lines.push(`- 投递：${delivery.state}${delivery.delivered ? "（已送达）" : "（未送达）"}`);
      if (rec) {
        if (rec.progress) lines.push(`- 进度：${rec.progress.value}/${rec.progress.max}（节点 ${rec.progress.node ?? "-"}）`);
        if (rec.currentNode !== null && rec.currentNode !== undefined) lines.push(`- 当前节点：${rec.currentNode}`);
        if (rec.error) lines.push(`- 错误：${rec.error.type || ""} ${rec.error.message || ""}`);
      }
      if (entry) {
        if (entry.outputs?.length) lines.push(`- 产物：${entry.outputs.length} 个（用 action=result 取路径）`);
        if (entry.error) lines.push(`- 历史错误：${entry.error.type || ""} ${entry.error.message || ""}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { comfyui: { action: "query", promptId, state: jobState, job: job ? jobSummary(job) : null, delivery, event: rec || null, history: entry || null } },
      };
    }
    // 列最近
    const promptsSnap = await relayJson("/_relay/prompts", { timeoutMs: 6_000 }).catch(() => null);
    const active = promptsSnap?.ok ? promptsSnap.data.active || [] : [];
    const recent = promptsSnap?.ok ? promptsSnap.data.recent || [] : [];
    const own = [...state.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 10);
    const q = state.snapshot?.relay?.queue || null;
    const lines = ["ComfyUI 任务清单"];
    if (q) lines.push(`- 队列：运行中 ${q.running} · 排队 ${q.pending}`);
    if (active.length) {
      lines.push(`- 事件流活跃（${active.length}）：`);
      for (const r of active.slice(0, 8)) lines.push(`  · ${r.promptId.slice(0, 8)}… ${r.state}${r.progress ? `（${r.progress.value}/${r.progress.max}）` : ""}`);
    }
    if (own.length) {
      lines.push(`- 本 App 跟踪（${own.length}，最近 10）：`);
      for (const j of own.slice(0, 10)) lines.push(`  · ${j.promptId.slice(0, 8)}… ${j.state} · ${j.label}${j.taskId ? ` · task ${j.taskId}` : ""}`);
    }
    if (!active.length && !own.length) lines.push("（暂无任务记录）");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { comfyui: { action: "query", queue: q, active, own: own.map((j) => jobSummary(j)) } },
    };
  }

  async function fetchResultOutputs(promptId) {
    const job = state.jobs.get(promptId) || (await findJobById(promptId));
    if (job && job.outputs.length) {
      if (!job.outputs[0].viewPath) await enrichOutputs(job);
      return { outputs: job.outputs, job };
    }
    const h = await relayJson(`/_relay/history?id=${encodeURIComponent(promptId)}`, { timeoutMs: 8_000 });
    const entry = h.ok && Array.isArray(h.data?.entries) ? h.data.entries[0] : null;
    if (!entry) throw new Error(`找不到 prompt ${promptId} 的历史记录（可能尚未完成或已清理）`);
    if (!entry.completed && entry.status !== "error") throw new Error(`任务尚未完成（prompt ${promptId}，history 未完成）——稍后再试或先 action=query`);
    const outputs = entry.outputs || [];
    if (job) {
      job.outputs = outputs;
      await enrichOutputs(job);
      return { outputs: job.outputs, job };
    }
    const tmp = { outputs, promptId };
    await enrichOutputs(tmp);
    return { outputs: tmp.outputs, job: null };
  }

  async function actionResult(args, context) {
    const promptId = await resolvePromptId(args);
    if (!promptId) throw new Error("result 需要 promptId 或 taskId（可先用 action=query 列表）");
    const { outputs, job } = await fetchResultOutputs(promptId);
    const files = outputs.map((o) => ({
      filename: o.filename,
      subfolder: o.subfolder || "",
      type: o.type || "output",
      filePath: o.filePath || null,
      sizeBytes: o.sizeBytes ?? null,
      viewPath: o.viewPath || viewPathOf(o),
    }));
    // 可选：注册进会话文件（需要 app/session.stage-file 能力 + callToken）
    let staged = null;
    if (args.stage === true) {
      const callToken = context && typeof context.callToken === "string" ? context.callToken : "";
      if (!callToken) {
        staged = { ok: false, reason: "无 callToken，跳过入会话" };
      } else if (!(await hasCapability(CAP_STAGE_FILE))) {
        staged = { ok: false, reason: "缺少能力 app/session.stage-file，跳过入会话" };
      } else {
        const results = [];
        for (const f of files.slice(0, 5)) {
          if (!f.filePath) { results.push({ file: f.filename, ok: false, reason: "无本地路径" }); continue; }
          try {
            const r = await sdk.resources.stage({ path: f.filePath, name: f.filename, deliverAs: "attachment" });
            results.push({ file: f.filename, ok: true, fileId: r?.resource?.fileId || null });
          } catch (e) {
            results.push({ file: f.filename, ok: false, reason: msgOf(e).slice(0, 200) });
          }
        }
        staged = { ok: results.some((r) => r.ok), results };
      }
    }
    const lines = [`ComfyUI 产物（prompt ${promptId}，${files.length} 个）`];
    for (const f of files.slice(0, 20)) {
      lines.push(`- ${f.filePath || `（${f.type}:${f.subfolder ? f.subfolder + "/" : ""}${f.filename}）`}${f.sizeBytes != null ? `（${Math.round(f.sizeBytes / 1024)} KB）` : ""}`);
    }
    if (staged) lines.push(`- 入会话文件：${staged.ok ? "已提交" : "未完成"}${staged.reason ? `（${staged.reason}）` : ""}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        comfyui: { action: "result", promptId, outputs: files, staged },
      },
    };
  }

  async function actionCancel(args) {
    if (args.all === true) {
      const clearRes = await relayJson("/queue", { method: "POST", body: JSON.stringify({ clear: true }) });
      const intRes = await relayJson("/interrupt", { method: "POST", body: JSON.stringify({}) });
      if (!clearRes.ok || !intRes.ok) throw new Error(`清队列/中断请求失败（HTTP ${clearRes.status}/${intRes.status}）`);
      let canceled = 0;
      for (const job of state.jobs.values()) {
        if (!TERMINAL_JOB.has(job.state)) { job.cancelRequested = true; canceled += 1; }
      }
      return {
        content: [{ type: "text", text: `已清空 ComfyUI 队列并请求全局中断（影响队列内全部任务；本 App 跟踪中的 ${canceled} 条会按中断结算）。` }],
        details: { comfyui: { action: "cancel", all: true, affected: canceled } },
      };
    }
    const promptId = await resolvePromptId(args);
    if (!promptId) throw new Error("cancel 需要 promptId / taskId，或显式 all:true 清队列");
    const q = await relayJson("/queue", { timeoutMs: 8_000 });
    const qd = q.ok ? q.data : null;
    const pending = Array.isArray(qd?.queue_pending) && qd.queue_pending.some((it) => Array.isArray(it) && it[1] === promptId);
    const running = Array.isArray(qd?.queue_running) && qd.queue_running.some((it) => Array.isArray(it) && it[1] === promptId);
    const job = state.jobs.get(promptId) || null;
    if (pending) {
      const del = await relayJson("/queue", { method: "POST", body: JSON.stringify({ delete: [promptId] }) });
      if (!del.ok) throw new Error(`从队列删除失败（HTTP ${del.status}）`);
      if (job) job.cancelRequested = true;
      return {
        content: [{ type: "text", text: `已将 ${promptId} 从 ComfyUI 队列移除。` }],
        details: { comfyui: { action: "cancel", promptId, mode: "queue-delete" } },
      };
    }
    if (running) {
      const res = await relayJson("/interrupt", { method: "POST", body: JSON.stringify({ prompt_id: promptId }) });
      if (!res.ok) throw new Error(`中断请求失败（HTTP ${res.status}）`);
      if (job) job.cancelRequested = true;
      return {
        content: [{ type: "text", text: `已请求中断正在执行的 ${promptId}（ComfyUI 会在节点边界停止；状态稍后经跟踪确认）。` }],
        details: { comfyui: { action: "cancel", promptId, mode: "interrupt" } },
      };
    }
    return {
      content: [{ type: "text", text: `${promptId} 不在 ComfyUI 队列中（可能已完成或已不存在）。如需清空整个队列请显式传 all:true。` }],
      details: { comfyui: { action: "cancel", promptId, mode: "not-found" } },
    };
  }

  async function actionWorkflows(args) {
    if (typeof args.name === "string" && args.name.trim()) {
      const { parsed, source } = await loadTemplate(args.name.trim());
      const summary = summarizeWorkflow(parsed);
      const lines = [
        `工作流：${source}（格式 ${summary.format}，${summary.nodeCount} 个节点）`,
        ...summary.nodes.slice(0, 40).map((n) => `- #${n.id} ${n.type}${n.title ? ` 「${n.title}」` : ""}`),
      ];
      if (summary.nodes.length > 40) lines.push(`…（共 ${summary.nodes.length} 个节点，仅列前 40 个）`);
      lines.push("提示：API 格式可直接 submit；UI 格式会自动尝试转换（子图/环绕节点不支持）。");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { comfyui: { action: "workflows", op: "get", source, summary } },
      };
    }
    const list = await relayJson("/userdata?dir=workflows&recurse=true&full_info=true", { timeoutMs: 20_000 });
    const items = list.ok && Array.isArray(list.data) ? list.data : [];
    const lines = [`ComfyUI 已保存工作流（userdata/workflows，${items.length} 个）`];
    for (const i of items.slice(0, 40)) {
      lines.push(`- ${i.path}（${Math.round((i.size || 0) / 1024)} KB）`);
    }
    if (!items.length) lines.push("（空——请在 ComfyUI 里保存工作流，或在导出时选择 API 格式）");
    lines.push("读取结构摘要：comfyui(action=\"workflows\", name=\"<路径或文件名>\")");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { comfyui: { action: "workflows", op: "list", items: items.slice(0, 200) } },
    };
  }

  async function actionUpload(args) {
    const path = String(args.path || "").trim();
    if (!path) throw new Error("upload 需要 path（本机图片文件的绝对路径）");
    const body = { path };
    if (typeof args.subfolder === "string" && args.subfolder) body.subfolder = args.subfolder;
    if (args.overwrite === true) body.overwrite = true;
    const { ok, status, data } = await relayJson("/_relay/upload", { method: "POST", body: JSON.stringify(body), timeoutMs: 30_000 });
    if (!ok || !data?.ok) {
      throw new Error(`上传失败（HTTP ${status}）：${data?.error || JSON.stringify(data).slice(0, 300)}`);
    }
    const r = data.result || {};
    const name = typeof r.name === "string" ? r.name : null;
    const sub = typeof r.subfolder === "string" ? r.subfolder : "";
    return {
      content: [{
        type: "text",
        text: [
          `已上传图片到 ComfyUI input：${name || "（未返回 name）"}${sub ? `（subfolder=${sub}）` : ""}`,
          name ? `在 inputs 里引用：{"<LoadImage 节点 id>.image": "${sub ? sub + "/" : ""}${name}"}` : "",
        ].filter(Boolean).join("\n"),
      }],
      details: { comfyui: { action: "upload", path, name, subfolder: sub, type: r.type || "input" } },
    };
  }

  // ── ComfyUI 本体更新（M11）───────────────────────────────────────────────
  // 中继侧机制（git pull --ff-only + pip install -r requirements.txt；后台跑、失败不回退）
  // 见 runtime/comfy-relay.mjs 的「ComfyUI 本体更新」区。
  // 更新任务：建一个宿主任务，后台轮询中继，结束时 complete / fail。
  // 为何需要：更新要几分钟，用户大概率已经切到别的会话；靠任务卡与完成回执把结果送到。
  // 面板按钮走 HTTP 路由、没有 callToken，所以只在这里（工具通道）建任务。
  const updateWatch = { active: false, taskId: null, startedAt: 0, timer: null };

  async function beginUpdateWatch(callToken, before) {
    if (updateWatch.active) return;
    updateWatch.active = true;
    updateWatch.startedAt = Date.now();
    try {
      const t = await sdk.tasks.create({
        callToken,
        label: "ComfyUI 本体更新",
        delivery: "next-step",
        metadata: { comfyui: { action: "update", op: "apply", startedAt: new Date(updateWatch.startedAt).toISOString(), before } },
      });
      updateWatch.taskId = t && t.taskId ? String(t.taskId) : null;
      log(`更新任务已建：taskId=${updateWatch.taskId || "(none)"}`);
    } catch (e) {
      warn(`更新任务创建失败：${msgOf(e).slice(0, 200)}`);
    }
    const tick = async () => {
      try {
        const { ok, data } = await relayJson("/_relay/update/status", { timeoutMs: 8_000 });
        const st = ok && data && typeof data === "object" ? data : {};
        if (st.running) {
          updateWatch.timer = setTimeout(tick, 3000);
          return;
        }
        await finishUpdateWatch(st);
      } catch {
        updateWatch.timer = setTimeout(tick, 5000); // 中继may重启，下一拍再试
      }
    };
    updateWatch.timer = setTimeout(tick, 3000);
  }

  async function finishUpdateWatch(st) {
    updateWatch.active = false;
    if (updateWatch.timer) { clearTimeout(updateWatch.timer); updateWatch.timer = null; }
    const tid = updateWatch.taskId;
    const secs = Math.round((Date.now() - updateWatch.startedAt) / 1000);
    const steps = (st.steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.name}`).join(" · ");
    const after = st.after ? st.after.describe || st.after.commit : null;
    if (tid) {
      try {
        if (st.phase === "failed" || st.lastError) {
          await sdk.tasks.fail(tid, `ComfyUI 更新失败（${secs}s）：${st.lastError || "未知原因"}${steps ? `\n${steps}` : ""}`);
        } else {
          await sdk.tasks.complete(tid, [
            `ComfyUI 更新完成（耗时 ${secs}s）`,
            after ? `现版本：${after}` : "",
            steps ? `步骤：${steps}` : "",
            "服务已停止，用工作区顶栏或左侧面板「启动服务」重新拉起。",
          ].filter(Boolean).join("\n"));
        }
      } catch (e) {
        warn(`更新任务结算失败：${msgOf(e).slice(0, 200)}`);
      }
    }
    log(`更新任务结束：phase=${st.phase} 耗时 ${secs}s`);
  }

  async function actionUpdate(args, context) {
    const op = String(args.op || "check").trim().toLowerCase();
    if (op === "status") {
      const { ok, status, data } = await relayJson("/_relay/update/status", { timeoutMs: 10_000 });
      if (!ok || !data) throw new Error(`读取更新状态失败（HTTP ${status}）`);
      const lines = [
        `更新状态：${data.running ? `进行中（${data.phase}）` : data.phase}`,
        data.before ? `当前：${data.before.describe || data.before.commit}${data.before.dirty ? "（有未提交改动）" : ""}` : "",
        data.after ? `更新后：${data.after.describe || data.after.commit}` : "",
        ...(data.steps || []).map((s) => `- ${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `：${String(s.detail).split("\n").slice(-1)[0]}` : ""}`),
        data.lastError ? `错误：${data.lastError}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { comfyui: { action: "update", op, ...data } } };
    }
    if (op === "check") {
      const { ok, status, data } = await relayJson("/_relay/update?force=1", { timeoutMs: 150_000 });
      if (!ok || !data || data.ok === false) throw new Error(`检查更新失败：${(data && data.error) || `HTTP ${status}`}`);
      const lines = data.isGit === false
        ? [`无法代为更新：${data.note}`, data.local ? `当前：${data.local.describe || data.local.commit}` : ""]
        : [
            `当前：${data.local?.describe || data.local?.commit}（分支 ${data.local?.branch}）`,
            `远端：${data.remote?.describe || data.remote?.commit}`,
            data.upToDate ? "已是最新，无待更新提交。" : `落后 ${data.behind} 个提交${data.ahead ? `，本地领先 ${data.ahead} 个` : ""}。`,
            data.local?.dirty ? "注意：本地有未提交改动，更新可能被 git 拒绝。" : "",
          ];
      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: { comfyui: { action: "update", op, ...data } } };
    }
    if (op === "apply") {
      const { ok, status, data } = await relayJson("/_relay/update", { method: "POST", body: JSON.stringify({ op: "apply" }), timeoutMs: 30_000 });
      if (!ok || !data || data.accepted !== true) {
        throw new Error(`发起更新失败：${(data && (data.reason || data.error)) || `HTTP ${status}`}`);
      }
      // 建宿主任务 + 后台轮询：更新要几分钟，用户大概率已切走，靠任务卡 + 完成回执送到
      const d0 = data && typeof data === "object" ? data : {};
      const callToken = context && typeof context.callToken === "string" ? context.callToken : "";
      if (callToken) void beginUpdateWatch(callToken, d0.before || null);
      return {
        content: [{
          type: "text",
          text: [
            `已发起 ComfyUI 更新（后台执行，当前阶段 ${data.phase}）。`,
            data.before ? `当前版本：${data.before.describe || data.before.commit}` : "",
            "流程：停服务 → git fetch → git pull --ff-only → pip install -r requirements.txt。",
            "用 comfyui(action=\"update\", op=\"status\") 查进度；完成后需要重新启动服务。",
          ].filter(Boolean).join("\n"),
        }],
        details: { comfyui: { action: "update", op, ...data } },
      };
    }
    throw new Error(`update 的 op 只支持 check / apply / status（收到 "${op}"）`);
  }

  // ── 服务进程（启动 / 停止）───────────────────────────────────────────────
  // 中继侧落到「计划任务拉起 + taskkill 撤下」，原因见 runtime/comfy-relay.mjs 服务管理区。
  function serviceSnapshot() {
    const snap = state.snapshot;
    const b = snap && snap.relay && snap.relay.backend ? snap.relay.backend : null;
    return { reachable: !!(b && b.reachable), proc: (b && b.proc) || null, url: b ? b.url : `http://${BACKEND.host}:${BACKEND.port}` };
  }

  // ── 画布桥（只读感知：agent 读的正是人眼前那张图）────────────────────────
  // 链路：App → 中继 /_relay/bridge → ComfyUI /api/hana_bridge/call → 前端扩展。
  const CANVAS_OPS = {
    pages: { drive: "canvas.pages", desc: "在线页面清单（各自打开的工作流）" },
    state: { drive: "canvas.state", desc: "最近一次画布快照（服务端缓存，零往返）" },
    summary: { drive: "canvas.summary", desc: "画布结构摘要（现抓，节点 / 连线）" },
    get: { drive: "canvas.get", desc: "全量 UI 格式 JSON" },
    check: { drive: "canvas.get", desc: "体检：悬空/输出未接/mute·bypass（app 层分析）" },
    trace: { drive: "canvas.get", desc: "追踪：某端口的直接来源/去向（app 层分析）" },
    outline: { drive: "canvas.get", desc: "大纲：功能块与块间连线（app 层分析）" },
    prompt: { drive: "canvas.prompt", desc: "可提交形态（prompt 对象）" },
    running: { drive: "exec.running", desc: "当前执行到哪个节点" },
    progress: { drive: "exec.running", desc: "执行进度聚合（只读）：执行中？/ 当前节点 / 画布节点数 / 队列剩余 / promptId" },
    probe: { drive: "api.probe", desc: "桥自检（关键 API 存在性）" },
    revision: { drive: "canvas.revision", desc: "画布变更序号（只问变没变，轻量）" },
    events: { drive: "canvas.events", desc: "画布变更记录（最近若干条）" },
    frameReload: { drive: "frame.reload", desc: "强制重载工作区内层 iframe（扩展换文件后用）" },
    commands: { drive: "canvas.commands", desc: "列前端已注册命令 id（排布插件自检）" },
    commandShape: { drive: "canvas.commandShape", desc: "探前端命令表形状（自检）" },
    loadWorkflowFile: { drive: "canvas.loadWorkflowFile", desc: "按文件路径直接加载工作流（绕过前端列表，写）", write: true },
    openWorkflow: { drive: "canvas.openWorkflow", desc: "打开指定工作流并完整装载到画布（切前台+重绘；pending 落定校验；自带未保存保护）", write: true },
    activateWorkflow: { drive: "canvas.activateWorkflow", desc: "把已打开的目标工作流切成前台（轻量切标签，不重载、不丢数据；目标未打开则报错）", write: true },
    // 以下为写入（需授权：设置页「允许 agent 修改画布」）
    setWidget: { drive: "canvas.setWidget", desc: "改一个节点参数", write: true },
    addNode: { drive: "canvas.addNode", desc: "新建节点入图", write: true },
    removeNode: { drive: "canvas.removeNode", desc: "删除节点", write: true },
    connect: { drive: "canvas.connect", desc: "连线", write: true },
    disconnect: { drive: "canvas.disconnect", desc: "断开一条输入连线", write: true },
    setNodeMode: { drive: "canvas.setNodeMode", desc: "mute / bypass / 恢复正常", write: true },
    addGroup: { drive: "canvas.addGroup", desc: "新建分组（nodeIds 自动算框，含外扩 20；bounds 显式优先）", write: true },
    setGroup: { drive: "canvas.setGroup", desc: "改组：index|title 定位，改标题 / 重算框", write: true },
    removeGroup: { drive: "canvas.removeGroup", desc: "删组（不动节点）", write: true },
    save: { drive: "canvas.save", desc: "把当前图落盘为工作流文件", write: true },
    undo: { drive: "canvas.undo", desc: "撤销 agent 上一步", write: true },
    patch: { drive: "canvas.patch", desc: "意图级写：多编辑一次提交（edits），$引用/原子回滚/verify/dryRun", write: true },
    // 排布：把命令递交给前端扩展自己执行（默认走 node-organizer 插件）
    organize: { drive: "canvas.organize", desc: "调前端扩展已注册命令（默认 node-organizer.organize 自动排布；args.command 可换）", write: true },
    // 共驾 D1（2026-09-29 契约 §1）：画布执行 / 复制 / 视觉标记（写入类，过授权闸门）
    queue: { drive: "canvas.queue", desc: "执行当前画布（等效点 Queue，快返；front=true 插队首）", write: true },
    duplicate: { drive: "canvas.duplicate", desc: "以当前画布复制为新页（原布零改动；返回新页 path/key）", write: true },
    visual: { drive: "canvas.visual", desc: "画布视觉标记：lock 置锁 / highlight 黄标 / clear 全撤", write: true },
    copilot: { drive: "canvas.copilot", desc: "开关当前画布副驾驶（enabled=true/false；Agent 开启受「允许 Agent 开启画布副驾驶」总闸管辖）", write: true },
    // T2 接线：语义 diff（两份工作流 JSON）——目前仅 source="file"（live 对 file 列为后续）。
    diff: { drive: "canvas.diff", desc: "语义 diff：两份工作流 JSON 的节点/连线/组差异（source=file；path=基准、pathB=目标）" },
  };

  // 壳页桥：工作区壳页与 iframe 同源，直接够得到 iframe.contentWindow.app。
  //
  // 为何需要：代理模式下 iframe 挂在宿主 …/routes/_runtime/<id>/ 下，源是 hana server；
  // 而 ComfyUI 前端拼的绝对路径（/extensions/…、/scripts/…、/hana_bridge/hello）会丢前缀，
  // 打进宿主根 → 403。于是扩展加载不了、hello 上报也失败，旧桥在 hui 工作区里够不着画布。
  // 壳页同源直控 iframe（主题跟随就是这么做的），故把执行者搬到壳页。
  const shellBridge = {
    lastSeenAt: 0,
    lastHello: null,
    queue: [],          // 待壳页取走的 op
    pending: new Map(), // rid → { resolve, timer }
  };
  const SHELL_ALIVE_MS = 5000;
  const shellAlive = () => Date.now() - shellBridge.lastSeenAt < SHELL_ALIVE_MS;

  // 修2（2026-10-13）：壳页腿豁免名单（这些 op 强制走扩展腿）。
  // canvas.pages 的唯一权威源是 py（app/bridge/__init__.py 的 `op == "canvas.pages"` 分支直答
  // `_pages_payload()`；多标签的 openWorkflows / sid / stale / liveCount / ttlSec 都在那里）。
  // 壳页腿只看得见自己 iframe 里那一个页面，返回的是单页简化 payload
  // （app/ui/workspace.js 的 shellOp("canvas.pages")：只有 {pages:[{workflow,href}],count:1}），
  // 且它「支持」该 op（不抛错、不回退）→ 壳页存活时会遮蔽真正的多页账本。故本 op 不进壳页腿。
  // 前提（已核）：代理模式下壳页腿可用 ⇔ 中继已就绪（iframe 本身就挂在中继 runtime 下），
  // 而 canvas.pages 由 py 直答、不经前端扩展，扩展腿在该场景同样可达 → 不产生能力回退。
  const SHELL_LEG_SKIP = new Set(["canvas.pages"]);

  function shellCall(drive, args, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const rid = `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        shellBridge.pending.delete(rid);
        reject(new Error("工作区壳页未在超时内回传（工作区可能已关闭或正在忙）"));
      }, timeoutMs);
      shellBridge.pending.set(rid, { resolve, timer });
      shellBridge.queue.push({ rid, op: drive, args: args || {} });
    });
  }

  // ── 共驾 D1 助手（2026-09-29 契约）：桥调用 / 在线判定 / 装载引用 / D2 待同步 ──

  // 扩展腿调用原语（P4，2026-10-08）：从 canvasBridgeInvoke 内联提取为同级函数，
  // 供「两腿可达性探针」（canvasProbeLegs）单独复用。返回 relayJson 原样 { status, ok, data }。
  async function bridgeCallExt(drive, args, timeoutMs = 30_000) {
    return relayJson("/_relay/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: drive, args: args || {} }),
      timeoutMs,
    });
  }

  // 画布桥调用助手（双腿）：壳页活着先试壳页；壳页不支持/失败回退扩展腿。
  // 返回 { ok, status, via, payload, error, detail }；不抛错，由调用方决定行为。
  // 与 actionCanvas 的原有派发行为一致（actionCanvas 也改走这里，单一来源）。
  async function canvasBridgeInvoke(drive, args, timeoutMs) {
    // L6（2026-10-10）：timeoutMs 现同时透传两腿（此前只作用于扩展腿，壳页腿恒用自身 20s 默认）——
    // 调用方显式给才覆盖：显式值两腿一致；缺省则各守自身默认（壳页腿 20s / 扩展腿 30s）。
    const extMs = timeoutMs === undefined ? 30_000 : timeoutMs;
    const legMs = timeoutMs === undefined ? undefined : timeoutMs;
    let via = "bridge";
    let res;
    if (shellAlive() && !SHELL_LEG_SKIP.has(drive)) {
      try {
        const r = await shellCall(drive, args || {}, legMs);
        if (r.ok) {
          via = "shell";
          res = { ok: true, status: 200, data: { ok: true, data: r.data } };
        } else {
          // 壳页活着但执行失败（直连模式跨源够不到 / 壳页桥未支持）→ 回退扩展
          res = await bridgeCallExt(drive, args, extMs);
        }
      } catch {
        res = await bridgeCallExt(drive, args, extMs);
      }
    } else {
      res = await bridgeCallExt(drive, args, extMs);
    }
    const { ok, status, data } = res;
    const d = data && typeof data === "object" ? data : {};
    if (!ok || d.ok === false) {
      return {
        ok: false, status, via, payload: null,
        error: d.error || `HTTP ${status}`,
        detail: d.detail || null,
        // A1a（2026-10-08）：py 路由错误（no_page / no_live_page 等 409）自带在线页面简表——保留透传
        //（此前被丢弃），供报错文案补「在线页面清单」。未携带时为 null。
        pages: Array.isArray(d.pages) ? d.pages : null,
        // 缺口 4（2026-10-13）：target_not_foreground 回执自带候选页（sid / foreground / matches）——
        // 与 pages 同款保留透传（此前被丢弃），供报错文案附候选便于定位。未携带时为 null。
        candidates: Array.isArray(d.candidates) ? d.candidates : null,
      };
    }
    return { ok: true, status, via, payload: d.data === undefined ? null : d.data, error: null, detail: null };
  }

  // A1c（2026-10-08）：在线页面简表（报错文案用）：`sid…「workflow」`（过期条目标注；最多 8 条）。
  // 兼容两种形状：py 错误响应 _pages_brief() 与 canvas.pages 的 _pages_payload().pages。
  function onlinePagesBrief(pages) {
    if (!Array.isArray(pages) || !pages.length) return "";
    return pages.slice(0, 8)
      .map((p) => `${(p && p.sid) || "?"}…「${(p && p.workflow) || "(未命名)"}」${p && p.stale ? "（过期）" : ""}`)
      .join(" / ");
  }

  // 画布在线判定（契约 §3.1；#49 B 主链升级，2026-10-08）：壳页腿与扩展腿任一可达 = 在线；顺带取 exec.running（忙信息）。
  // 旧口径「壳页不在 → 直接判离线」退役：壳页不在时 canvasBridgeInvoke 会自动直走扩展腿，以「桥是否回帖」为裁判。
  // 返回 via: shell|bridge（由哪条腿答的）、shellOk（供「工作区缺 / 桥缺」分类）。
  // opts.timeoutMs：可选，压扩展腿单次上限（等待循环用短压时；缺省沿用 30s 契约上限）。
  async function canvasProbe(opts = {}) {
    const shellOk = shellAlive();
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30_000;
    try {
      const r = await canvasBridgeInvoke("exec.running", {}, timeoutMs);
      if (!r.ok) {
        return {
          ok: false,
          shellOk,
          reason: shellOk
            ? `扩展桥不可达（${r.error || "未知"}）`
            : `工作区壳页不在线，且扩展腿不可达（${r.error || "未知"}）`,
        };
      }
      return { ok: true, shellOk, running: r.payload || {}, via: r.via };
    } catch (e) {
      return { ok: false, shellOk, reason: `桥不可达（${msgOf(e)}）` };
    }
  }

  // 两腿可达性探针（P4，2026-10-08）：壳页腿与扩展腿各自独立试一次（各 8s 压时）。
  // 为什么需要：壳页对 api.probe 的支路「不要求 app 就绪」→ 总能回帖 → canvasBridgeInvoke
  // 的互回退永不触发 → 扩展腿从不被探测（P4 缺陷本身）。这里绕开互回退、两腿分别测。
  // ok 判据 = 「该腿是否回帖 + 耗时」；**不得以 hasApp=false 判壳页失败**——
  // 直连模式（iframe 直连 8188）跨源看不到 app 属预期，判据只看是否回帖。
  async function canvasProbeLegs() {
    const LEG_TIMEOUT_MS = 8_000;
    const shellNote = "直连模式跨源看不到 app（hasApp=false）属预期；判据只看该腿是否回帖";
    const t0 = Date.now();
    let shell;
    try {
      const r = await shellCall("api.probe", {}, LEG_TIMEOUT_MS);
      const ok = !!(r && r.ok !== false);
      shell = { ok, ms: Date.now() - t0, note: shellNote };
      if (ok) shell.data = r.data === undefined ? null : r.data;
      else shell.error = (r && r.error) || "壳页腿执行失败";
    } catch (e) {
      shell = { ok: false, ms: Date.now() - t0, error: msgOf(e), note: shellNote };
    }
    const t1 = Date.now();
    let ext;
    try {
      const res = await bridgeCallExt("api.probe", {}, LEG_TIMEOUT_MS);
      const d = res && res.data && typeof res.data === "object" ? res.data : {};
      const ok = !!res.ok && d.ok === true;
      ext = { ok, ms: Date.now() - t1 };
      if (ok) ext.data = d.data === undefined ? null : d.data;
      else ext.error = d.error || `HTTP ${res.status}`;
    } catch (e) {
      ext = { ok: false, ms: Date.now() - t1, error: msgOf(e) };
    }
    return { shell, ext };
  }

  // ── 探测四态统一出口（B 主链，2026-10-08）：中继 / 服务 / 页面 / 授权 ──
  // 诊断顺序中继优先（中继缺时服务态不可判，勘误表同口径）；工具 status 与 submit auto 共用本函数。
  // opts.deep：
  //   · false（默认）：零桥往返——页面态只读壳页心跳（shellOk）；pageOk=null（未探）。
  //   · true：主动经 canvasProbe 探一次两腿（可用 opts.timeoutMs 压时；opts.probe 可传现成结果复用）。
  // 返回 { relayOk, serviceOk, serviceDetail, shellOk, pageOk, pageVia, running, probe, allowWrite, allowCopilot, reasons }。
  async function diagnoseEnvironment(opts = {}) {
    const reasons = [];
    const relayOk = relayReady();
    if (!relayOk) {
      reasons.push(`中继未就绪（phase=${state.phase}${state.lastError && state.lastError.userText ? `：${state.lastError.userText}` : ""}）`);
    }
    let serviceOk = null;
    let serviceDetail = { judgeable: false, reachable: null, starting: false, installed: null, installPath: null, lastError: null };
    if (relayOk) {
      const sp = serviceSnapshot();
      const proc = sp.proc || {};
      const env = state.snapshot && state.snapshot.relay ? state.snapshot.relay.env : null;
      const installs = env && Array.isArray(env.installs) ? env.installs : [];
      const starting = proc.starting === true;
      serviceOk = sp.reachable;
      serviceDetail = {
        judgeable: true,
        reachable: sp.reachable,
        starting,
        installed: env ? installs.length > 0 : null, // env 未拿到 = 未知（null）
        installPath: installs.length && installs[0] ? installs[0].path || null : null,
        lastError: proc.lastError || null,
      };
      if (!sp.reachable) {
        reasons.push(starting ? "ComfyUI 服务启动中" : installs.length ? "ComfyUI 服务未运行" : "ComfyUI 服务未运行（且未探测到安装）");
      }
    }
    const shellOk = shellAlive();
    let pageOk = null;
    let pageVia = null;
    let probe = null;
    if (opts.deep) {
      probe = opts.probe || (await canvasProbe({ timeoutMs: opts.timeoutMs }));
      pageOk = probe.ok;
      pageVia = probe.ok ? probe.via || null : null;
      if (!probe.ok) reasons.push(probe.reason || "画布桥不可达");
    }
    const allowWrite = readAllowWrite();
    const allowCopilot = readAllowCopilot();
    if (!allowWrite) reasons.push("未开启「允许 agent 修改画布」授权");
    if (!allowCopilot) reasons.push("未开启「允许 Agent 开启画布副驾驶」授权");
    return {
      relayOk,
      serviceOk,
      serviceDetail,
      shellOk,
      pageOk,
      pageVia,
      running: probe && probe.ok ? probe.running || null : null,
      probe,
      allowWrite,
      allowCopilot,
      reasons,
    };
  }

  // 读当前画布变更序号 + 节点数（settle 参照；失败/缺字段返回 null——settle 退化为纯计数判定）
  async function canvasRevisionRead() {
    try {
      const r = await canvasBridgeInvoke("canvas.revision", {});
      if (!r.ok || !r.payload || typeof r.payload !== "object") return null;
      return {
        revision: Number.isFinite(Number(r.payload.revision)) ? Number(r.payload.revision) : null,
        nodes: Number.isFinite(Number(r.payload.nodes)) ? Number(r.payload.nodes) : null,
      };
    } catch {
      return null;
    }
  }

  // 目标页匹配（落点断言）：duplicate 返回 {page,key}（E1 口径）；exec.running.activeWorkflow
  // 是 filename||name。两侧统一「反斜杠归一 + 去 .json + 小写」后比全串或基名（容忍前缀/扩展名差异）。
  // L5（2026-10-10）：实现复用 lib 纯函数 nameMatchesTarget（单一来源——单测覆盖的就是运行时在跑的），
  // 不再本地重复实现（旧实现与之同口径：全串或基名相等）。保留本名作内部调用别名。
  const canvasPageMatches = (active, candidates) => nameMatchesTarget(active, candidates);

  // settle（修复 3）：装载后等画布安定，再放行 queue。
  // 依据（v1.53.6 实证）：loadGraphData 在 configure 前至少 3 处 await（扩展钩子 ×2、
  // nodeReplacementStore.load），且 clean() 先行清图——桥侧快返后画布可能仍处「空图/旧图」窗口。
  // 判定轮询 canvas.revision（项目既有轻量手段：当前节点数 + 变更序号）：
  //   · 强证据：曾观察到非预期计数（清图/中间态）→ 之后回到预期计数 → 放行；
  //   · 弱证据（保守）：序号已位移或连续多轮预期计数，且已完成 ≥ CANVAS_SETTLE_WEAK_POLLS 轮 → 放行；
  //   · 超时（30s）→ 报错，不 queue；预期计数未知时退化为「计数连续稳定」兜底。
  // targetCandidates 非空（v2：总是给出、有明确副本页）时，逐轮用 exec.running 核对活动页落点，不符立即报错。
  const CANVAS_SETTLE_POLL_MS = 800;
  const CANVAS_SETTLE_TIMEOUT_MS = 30_000;
  const CANVAS_SETTLE_WEAK_POLLS = 4; // 弱证据路径的保守轮数（≈3.2s）
  async function waitCanvasLoadSettled({ expectedNodes, revBefore, targetCandidates }) {
    const deadline = Date.now() + CANVAS_SETTLE_TIMEOUT_MS;
    const target = Array.isArray(targetCandidates) && targetCandidates.length ? targetCandidates : null;
    let polls = 0;
    let sawNonTarget = false;
    let stableTarget = 0;
    let lastNodes = null;
    let stableAny = 0;
    for (;;) {
      await sleep(CANVAS_SETTLE_POLL_MS);
      polls += 1;
      // 落点断言（v2 总是启用）：活动页必须是目标副本页；不符立即报错（不 queue）
      if (target) {
        const run = await canvasBridgeInvoke("exec.running", {});
        if (run.ok && run.payload && typeof run.payload === "object" && "activeWorkflow" in run.payload) {
          const active = run.payload.activeWorkflow;
          if (!canvasPageMatches(active, target)) {
            const e = new Error(`装载落点不符：当前活动页「${active || "(未知)"}」，应为目标页「${target[0]}」（不 queue）`);
            e.code = "canvas-failed";
            throw e;
          }
        }
      }
      const rev = await canvasRevisionRead();
      let settled = false;
      const cur = rev ? rev.nodes : null;
      if (expectedNodes != null && cur != null) {
        if (cur !== expectedNodes) {
          sawNonTarget = true; // 已观察到装载中间态（清图/部分）；之后回到预期计数才算数
          stableTarget = 0;
        } else {
          stableTarget += 1;
          const revMoved = revBefore != null && rev.revision != null && rev.revision !== revBefore;
          settled = sawNonTarget || (polls >= CANVAS_SETTLE_WEAK_POLLS && (revMoved || stableTarget >= CANVAS_SETTLE_WEAK_POLLS));
        }
      } else if (cur != null) {
        // 预期未知（装载回执无 nodeCount）：退化为「计数连续稳定」兜底
        if (cur === lastNodes) stableAny += 1; else stableAny = 0;
        lastNodes = cur;
        settled = stableAny >= CANVAS_SETTLE_WEAK_POLLS;
      }
      if (settled) return { polls, nodes: cur };
      if (Date.now() > deadline) {
        const e = new Error(`装载后画布未在 ${Math.round(CANVAS_SETTLE_TIMEOUT_MS / 1000)}s 内安定（当前节点数 ${cur == null ? "未知" : cur}，预期 ${expectedNodes == null ? "未知" : expectedNodes}）；已中止，不提交队列`);
        e.code = "canvas-failed";
        throw e;
      }
    }
  }

  // T3-1（2026-10-10）：openWorkflow 未落定时的现况取证（只读，供「如实报」用）。
  // 取：活动页名 / 该页 modified（dirty，来自 canvas.pages 服务端账本）/ 最近一条 events。
  async function openWorkflowUnsettledDiag({ expectedNames }) {
    const out = { active: null, pageModified: null, pageNodeCount: null, lastChange: null };
    try {
      const run = await canvasBridgeInvoke("exec.running", {});
      if (run.ok && run.payload && typeof run.payload === "object") out.active = run.payload.activeWorkflow || null;
    } catch { /* 取不到如实留空（上层文案按「未知」渲染） */ }
    try {
      const pgs = await canvasBridgeInvoke("canvas.pages", {});
      const pages = pgs.ok && pgs.payload && Array.isArray(pgs.payload.pages) ? pgs.payload.pages : null;
      if (pages) {
        // 优先认「当前活动页」（exec.running 给的），其次认目标页；都没有再退化为任一活页。
        const hit = pages.find((p) => p && !p.stale && canvasPageMatches(p.workflow, out.active ? [out.active] : []))
          || pages.find((p) => p && !p.stale && canvasPageMatches(p.workflow, expectedNames))
          || pages.find((p) => p && !p.stale);
        if (hit) {
          out.pageModified = hit.modified === true ? true : (hit.modified === false ? false : null);
          out.pageNodeCount = Number.isFinite(Number(hit.nodeCount)) ? Number(hit.nodeCount) : null;
        }
      }
    } catch { /* 同上 */ }
    try {
      const ev = await canvasBridgeInvoke("canvas.events", {});
      const ch = ev.ok && ev.payload && Array.isArray(ev.payload.changes) ? ev.payload.changes : null;
      if (ch && ch.length) {
        const last = ch[ch.length - 1] || {};
        out.lastChange = { at: last.at || null, source: last.source || null };
      }
    } catch { /* 同上 */ }
    return out;
  }

  // 等待「目标页到达 + 装载落定」（P1 P2 快返类 op 专用，2026-10-08）。
  // 与 waitCanvasLoadSettled 的「盯住」语义相反：装载在途期间活动页尚未切换（到达前
  // 不匹配属正常），不能即时抛错；本函数等到「同一轮内 ①活动页 ∈ candidates 且
  // ②节点数 == expectedNodes」才算落定，超时显式报错（含当前活动页 / 节点数 / rev 诊断）。
  // 用途：openWorkflow（切到 hit 页）、save 另存并切换（切到 adopted 页）——两者都在
  // loadGraphData 收尾的 afterLoadNewGraph → activateLoadedWorkflow 里才切换活动页。
  async function waitCanvasTargetArrive({ expectedNodes, candidates, revBefore }) {
    const target = Array.isArray(candidates) && candidates.length ? candidates : null;
    if (!target) {
      const e = new Error("落定校验缺目标页候选（openWorkflow / 另存应给出 activeAfter）");
      e.code = "canvas-failed";
      throw e;
    }
    const deadline = Date.now() + CANVAS_SETTLE_TIMEOUT_MS;
    let polls = 0;
    let lastActive = null;
    let lastNodes = null;
    let revMoved = false;
    for (;;) {
      await sleep(CANVAS_SETTLE_POLL_MS);
      polls += 1;
      const run = await canvasBridgeInvoke("exec.running", {});
      if (run.ok && run.payload && typeof run.payload === "object" && "activeWorkflow" in run.payload) {
        lastActive = run.payload.activeWorkflow;
      }
      const rev = await canvasRevisionRead();
      if (rev && rev.nodes != null) lastNodes = rev.nodes;
      if (rev && revBefore != null && rev.revision != null && rev.revision !== revBefore) revMoved = true;
      const arrived = canvasPageMatches(lastActive, target);
      if (arrived && (expectedNodes == null || lastNodes === expectedNodes)) {
        return { polls, nodes: lastNodes, active: lastActive, revMoved };
      }
      if (Date.now() > deadline) {
        const e = new Error(
          `装载落定超时（${Math.round(CANVAS_SETTLE_TIMEOUT_MS / 1000)}s）：当前活动页「${lastActive || "(未知)"}」，` +
          `应为「${target[0]}」；当前 ${lastNodes == null ? "未知" : lastNodes} 节点，预期 ${expectedNodes == null ? "未知" : expectedNodes}` +
          `${revMoved ? "" : "；未观察到 revision 位移"}（装载未完成或落到了别处）`
        );
        e.code = "canvas-failed";
        throw e;
      }
    }
  }

  // ── 副驾驶 v2 支持函数（2026-10-08 批）────────────────────────────────
  // copilot_off（v2 写拦截）：把桥侧结构化拒绝转译为「工具层友好面」——可行动的指引文案。
  function copilotOffError(opName, inv) {
    const detail = inv && inv.detail ? `\n（桥侧详情：${inv.detail}）` : "";
    const e = new Error(
      `该画布未开启副驾驶：Agent 仅可打开 / 复制 / 落盘（本次「${opName}」已被拒绝）。${detail}\n` +
      "开启：① 用户在画布顶栏点「副驾驶·开」；② 授权后 Agent 可奉命开启（设置页「允许 Agent 开启画布副驾驶」开启后，用 op=copilot enabled=true 开启）。"
    );
    e.code = "copilot-off";
    e.gate = "copilot";
    return e;
  }

  // v2 读侧标注：统一副驾驶状态行——「该画布副驾驶：开 / 关 / 未知」。
  // 数据源＝state 缓存里的 copilot（最近上报页口径；逐页精确标注见 pages 行）。
  function copilotLineText(cp) {
    if (!cp || typeof cp !== "object") return "该画布副驾驶：未知（页面尚未上报；关＝仅可读、不可写）";
    if (cp.enabled) {
      const extra = Number(cp.updatedAt) > 0 ? `，更新于 ${new Date(Number(cp.updatedAt)).toLocaleString()}` : "";
      return `该画布副驾驶：开（pageKey=${cp.pageKey || "未知"}${extra}）`;
    }
    return "该画布副驾驶：关（仅可读、不可写）";
  }

  // 其他内容类读 op 的尾注数据源：取 state 服务端缓存（零画布往返）。
  // 返回 copilot 对象（可为 null＝尚未上报）；桥不可达返回 undefined（调用方不给行、不给字段）。
  async function fetchCanvasCopilot() {
    try {
      const st = await canvasBridgeInvoke("canvas.state", {});
      if (st.ok && st.payload && typeof st.payload === "object") {
        return st.payload.copilot || null;
      }
    } catch { /* 拿不到 */ }
    return undefined;
  }

  // v2 副本落盘命名：<原名去尾> (AgentCopy) YYYYMMDD-HHmm；重名递增「 (2)」「 (3)」…。
  // 「原名去尾」= 从 duplicate 产物页名派生（去 .json、去尾部「 (N)」副本递增、「 (Copy)」副本后缀，
  // 以及 T3-2 补上的「 (AgentCopy) YYYYMMDD-HHmm」历史副本段——与桥侧 duplicate 的清洗口径同源）。
  // 重名探测：读 workflows/<name>.json 是否存在（与桥侧「另存并切换」的目标已存在预检同口径）；
  // 探测失败按「不存在」处理（save 侧仍有预检兜底）。
  function agentCopyBaseName(srcPage) {
    let base = String(srcPage || "").split("/").pop() || "";
    base = base.replace(/\.json$/i, "");
    // T3-2（2026-10-10）：循环剥离叠加尾巴，直到不再变化，只留原始名——
    //   ·「 (N)」副本递增（如「 (2)」）；·「 (AgentCopy) YYYYMMDD-HHmm」历史副本段
    //   （可多层叠加，正则一次清干净）；·「 (Copy)」副本后缀。
    //   修复前漏了 AgentCopy 段自身，导致每复制一轮净增一层，最终撞 400 超长。
    for (let guard = 0; guard < 50; guard++) {
      const next = base
        .replace(/\s*\(\d+\)$/, "")
        .replace(/(?:\s*\(AgentCopy\)\s*\d{8}-\d{4})+$/i, "")
        .replace(/\s*\(Copy\)$/i, "");
      if (next === base) break;
      base = next;
    }
    base = base.trim() || "workflow";
    return base;
  }

  async function pickAgentCopyName(srcPage) {
    const base = agentCopyBaseName(srcPage);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? `${base} (AgentCopy) ${stamp}` : `${base} (AgentCopy) ${stamp} (${i})`;
      let exists = false;
      try {
        const r = await relayJson(`/_relay/userdata?file=${encodeURIComponent(`workflows/${name}.json`)}`, { timeoutMs: 8_000 });
        exists = r.ok && r.data !== null && r.data !== undefined;
      } catch { exists = false; }
      if (!exists) return name;
    }
    throw new Error(`副本落盘命名失败：同名 50 连撞（${base} (AgentCopy) ${stamp}…）`);
  }

  // P2 抽取（2026-10-08）：另存并切换（savedAs）pending 落定 + 目标文件落盘核对
  // （actionCanvas / submitCanvasFlow / 回填共用；行为与 P2 初版逐行一致）。
  async function settleSaveAsPending(payload, revBefore) {
    await waitCanvasTargetArrive({
      expectedNodes: Number.isFinite(Number(payload.nodeCount)) ? Number(payload.nodeCount) : null,
      candidates: payload.activeAfter ? [payload.activeAfter] : null,
      revBefore: revBefore ? revBefore.revision : null,
    });
    let fileOk = false;
    for (let i = 0; i < 10 && !fileOk; i++) {
      try {
        const r = await relayJson(`/_relay/userdata?file=${String(payload.saved).split("/").map(encodeURIComponent).join("/")}`, { timeoutMs: 8_000 });
        if (r.ok && r.data !== null && r.data !== undefined) fileOk = true;
      } catch { /* 未落盘 / 中继抖动：下一轮再试 */ }
      if (!fileOk) await sleep(800);
    }
    if (!fileOk) {
      const e = new Error(`另存落定未确认：${payload.saved} 未在等待窗口内落盘（保存链可能在页面内失败，请检查页面）`);
      e.code = "canvas-failed";
      throw e;
    }
    payload.settled = true;
    payload.fileVerified = true;
  }

  // ComfyUI user/default 候选目录：优先 main.py 同级的 user/default；再兜安装根直接子路径。
  // 用于把「用户目录内的绝对路径」相对化成桥要求的装载路径（相对 user/default）。
  // T-fs 修复（2026-10-09）：不再用 app 进程 existsSync 探测存在性/排序——宿主 --permission
  // 沙箱下裸 fs 探测会抛英文受限错误；存在性判断由调用方经中继 stat 完成（resolveCanvasWorkflowsDir）。
  function comfyUserDirCandidates() {
    const env = state.snapshot && state.snapshot.relay ? state.snapshot.relay.env : null;
    const hit = env && Array.isArray(env.installs) ? env.installs[0] : null;
    if (!hit) return [];
    const cands = [];
    if (typeof hit.mainPy === "string" && hit.mainPy) cands.push(join(dirname(hit.mainPy), "user", "default"));
    if (typeof hit.path === "string" && hit.path) {
      cands.push(join(hit.path, "user", "default"));
      cands.push(join(hit.path, "ComfyUI", "user", "default"));
    }
    return [...new Set(cands.filter(Boolean))];
  }

  // 绝对路径 → user/default 相对路径（仅用户目录内可相对化）；已是相对路径则原样（桥按 user/default 解析）。
  function relativizeUserDataPath(p) {
    const norm = String(p || "").replace(/\\/g, "/").trim();
    if (!norm) return null;
    const isAbs = /^[A-Za-z]:\//.test(norm) || norm.startsWith("//") || norm.startsWith("/");
    if (!isAbs) {
      const rel = norm.replace(/^\/+/, "");
      return rel && !rel.split("/").includes("..") ? rel : null;
    }
    for (const cand of comfyUserDirCandidates()) {
      const base = String(cand).replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      if (norm.toLowerCase().startsWith(base.toLowerCase())) {
        const rel = norm.slice(base.length).replace(/^\/+/, "");
        if (rel && !rel.split("/").includes("..")) return rel;
      }
    }
    return null;
  }

  // userdata/workflows 名称 → 可装载文件引用（与 loadTemplate 同匹配口径，但不读内容）。
  // matchCount（2026-10-08 增）：同口径命中的条目数——A1 openWorkflow 文件回退按「唯一命中」判定。
  async function resolveTemplateRef(name) {
    const list = await relayJson("/userdata?dir=workflows&recurse=true&full_info=true", { timeoutMs: 20_000 });
    const items = list.ok && Array.isArray(list.data) ? list.data : [];
    const matches = items.filter((i) => i && (
      String(i.path) === name ||
      String(String(i.path).split("/").pop()) === name ||
      String(i.path).toLowerCase() === name.toLowerCase()
    ));
    const target = matches[0];
    if (!target) {
      const avail = items.slice(0, 12).map((i) => i.path).join(" / ");
      throw new Error(`userdata 工作流里找不到「${name}」。可用：${avail || "（空——请先在 ComfyUI 里保存一个工作流）"}`);
    }
    const p = String(target.path).replace(/\\/g, "/");
    const file = p.startsWith("workflows/") ? p : `workflows/${p}`;
    return { file, path: target.path, matchCount: matches.length };
  }

  // A1b（2026-10-08）：openWorkflow not_found 的文件层回退解析（name → userdata 文件）。
  // 复用 resolveTemplateRef（userdata 列表口径）；对入参习惯各补候选（补 .json / 去目录基名），
  // 唯一命中才返回 ref；命中多条（歧义）返回 ambiguous；全不命中返回 null（调用方保持原报错）。
  async function resolveOpenWorkflowFallbackRef(target) {
    const t = String(target || "").trim();
    if (!t) return { ref: null, ambiguous: false };
    const cands = [t];
    if (!/\.json$/i.test(t)) cands.push(`${t}.json`);
    const base = t.split("/").pop();
    if (base && base !== t) {
      cands.push(base);
      if (!/\.json$/i.test(base)) cands.push(`${base}.json`);
    }
    for (const c of [...new Set(cands)]) {
      let r = null;
      try { r = await resolveTemplateRef(c); } catch { continue; }
      if (r.matchCount === 1) return { ref: r, ambiguous: false };
      return { ref: null, ambiguous: true }; // 命中多条：不猜
    }
    return { ref: null, ambiguous: false };
  }

  // A2（2026-10-08）：loadWorkflowFile 脏保护拒载的专用文案（对齐 openWorkflow 款：页名 + 最近变更 + force 指引）。
  // 「最近变更」取数＝无桥改动方案：现抓 canvas.events 最后一条（P6 已落 source/时间）；取不到如实「未知」。
  async function loadWorkflowFileDirtyText(activeBefore) {
    let recent = "未知";
    try {
      const ev = await canvasBridgeInvoke("canvas.events", {});
      const list = ev.ok && ev.payload && Array.isArray(ev.payload.changes) ? ev.payload.changes : [];
      const last = list.length ? list[list.length - 1] : null;
      if (last && last.at) {
        const src = { user: "用户", agent: "agent", system: "系统" }[last.source] || String(last.source || "来源未知");
        recent = `${last.at}（${src}）`;
      }
    } catch { /* 取不到不影响拒载文案 */ }
    return `当前图有未保存改动（${activeBefore || "?"}；最近变更 ${recent}）；丢弃改动用 force=true；如为 agent 副本页可直接 force`;
  }

  // 装载前格式预检：ui / api / unknown。读取失败（超出通道限额等）返回 unknown（fail-open 不阻断）。
  async function peekWorkflowFormat(kind, value) {
    try {
      let parsed;
      if (kind === "userdata") {
        const r = await relayJson(`/_relay/userdata?file=${encodeURIComponent(String(value))}`, { timeoutMs: 20_000 });
        if (!r.ok || r.data === null || r.data === undefined) return "unknown";
        parsed = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      } else {
        parsed = JSON.parse(await readLocalText(String(value)));
      }
      if (Array.isArray(parsed && parsed.nodes)) return "ui";
      return isPlainObject(parsed) ? "api" : "unknown";
    } catch {
      return "unknown";
    }
  }

  // submit 的 workflow 形态 → 画布装载文件引用（{file, source}）；不可装载抛 canvas-unloadable。
  async function resolveCanvasLoadRef(wf) {
    const fail = (message) => { const e = new Error(message); e.code = "canvas-unloadable"; return e; };
    if (wf.wfTemplate) {
      let ref;
      try { ref = await resolveTemplateRef(wf.wfTemplate); }
      catch (e) { throw fail(msgOf(e)); }
      if ((await peekWorkflowFormat("userdata", ref.file)) === "api") {
        throw fail(`「${wf.wfTemplate}」是 API 格式，画布装载需要 UI 格式工作流（可显式 mode=backend）`);
      }
      return { file: ref.file, source: `userdata:${ref.path}` };
    }
    if (wf.wfPath) {
      const rel = relativizeUserDataPath(wf.wfPath);
      if (!rel) throw fail(`工作流文件不在 ComfyUI userdata（user/default）内，无法直接装载画布：${wf.wfPath}（可先存进 ComfyUI 工作流，或显式 mode=backend）`);
      const isAbs = /^[A-Za-z]:[\\/]/.test(wf.wfPath) || wf.wfPath.startsWith("/");
      if ((await peekWorkflowFormat(isAbs ? "local" : "userdata", isAbs ? wf.wfPath : rel)) === "api") {
        throw fail(`文件是 API 格式（${wf.wfPath}），画布装载需要 UI 格式工作流（可显式 mode=backend）`);
      }
      return { file: rel, source: `file:${wf.wfPath}` };
    }
    throw fail("inline 对象形态无法装载画布（装载需要文件引用；可先把工作流落盘/存进 ComfyUI，或显式 mode=backend）");
  }

  // /queue 的 prompt_id 集合（canvas.queue 未回传 promptId 时做前后差集反查）。
  async function queuePromptIdsSnapshot() {
    try {
      const r = await relayJson("/queue", { timeoutMs: 8_000 });
      if (!r.ok || !r.data || typeof r.data !== "object") return null;
      const ids = new Set();
      for (const it of [...(r.data.queue_running || []), ...(r.data.queue_pending || [])]) {
        if (Array.isArray(it) && typeof it[1] === "string") ids.add(it[1]);
      }
      return ids;
    } catch { return null; }
  }

  // visual 包裹的「改动清单」提取：payload 已知字段 → args 兜底（$ 引用不可解析则跳过）。
  function collectTouchedNodeIds(payload, args) {
    const ids = new Set();
    const add = (v) => {
      if (v === undefined || v === null) return;
      const s = String(v).trim();
      if (!s || s.startsWith("$")) return;
      ids.add(s);
    };
    if (payload && typeof payload === "object") {
      for (const k of ["nodes", "nodeIds", "changedNodes"]) {
        if (Array.isArray(payload[k])) payload[k].forEach((n) => add(n && typeof n === "object" ? (n.id ?? n.nodeId) : n));
      }
      for (const k of ["applied", "results"]) {
        if (Array.isArray(payload[k])) payload[k].forEach((r) => { if (r && typeof r === "object") { add(r.nodeId); add(r.id); } });
      }
    }
    if (!ids.size && args && typeof args === "object") {
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          if (!e || typeof e !== "object") continue;
          for (const inner of Object.values(e)) {
            if (inner && typeof inner === "object") { add(inner.nodeId); add(inner.fromNode); add(inner.toNode); }
          }
        }
      }
      add(args.nodeId); add(args.fromNode); add(args.toNode);
    }
    return [...ids].slice(0, 100);
  }

  // ── D2 待同步：backend 记账 + 惰性回填（契约 §3.3）────────────────────────
  function readPendingCanvas() {
    try {
      const raw = JSON.parse(readFileSync(pendingCanvasFile, "utf8"));
      return raw && typeof raw === "object" ? raw : null;
    } catch { return null; }
  }

  function writePendingCanvas(rec) {
    try {
      writeFileSync(pendingCanvasFile, JSON.stringify(rec, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`pending-canvas 写入失败：${msgOf(e)}`);
      return false;
    }
  }

  function recordPendingCanvas({ workflowRef, promptId, note }) {
    const rec = {
      createdAt: new Date().toISOString(),
      workflowRef: String(workflowRef || ""),
      promptId: String(promptId || ""),
      note: String(note || ""),
    };
    if (writePendingCanvas(rec)) log(`待同步记账：prompt ${rec.promptId}（${rec.note}）`);
    return rec;
  }

  function keepPendingWithReason(rec, reason) {
    if (!rec) return;
    writePendingCanvas({
      ...rec,
      attempts: (Number(rec.attempts) || 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: String(reason || ""),
    });
  }

  function clearPendingCanvas() {
    try { rmSync(pendingCanvasFile, { force: true }); } catch (e) { warn(`pending-canvas 清除失败：${msgOf(e)}`); }
  }

  // 供 D2 记账：把本次提交的 workflow 形态描述成可回填引用（画布可装载的形态才有可回填值）。
  async function describeWorkflowRef(wfPath, wfTemplate) {
    if (wfTemplate) {
      try {
        const ref = await resolveTemplateRef(wfTemplate);
        return `userdata:${ref.file}`;
      } catch {
        return `userdata:${wfTemplate}（未解析）`; // 回填侧会拒（定位不到文件）
      }
    }
    if (wfPath) return `file:${wfPath}`;
    return "inline"; // 无文件引用；回填不可用（保留原因）
  }

  // workflowRef → 可装载引用；不是文件引用（inline / 未解析）返回 null。
  function resolveBackfillRef(workflowRef) {
    const s = String(workflowRef || "").trim();
    if (s.startsWith("userdata:")) {
      const p = s.slice("userdata:".length).replace(/\\/g, "/").trim();
      if (!p || /[（）()]/.test(p)) return null;
      return { file: p.startsWith("workflows/") ? p : `workflows/${p}` };
    }
    if (s.startsWith("file:")) {
      const p = s.slice("file:".length).trim();
      const rel = relativizeUserDataPath(p);
      return rel ? { file: rel } : null;
    }
    return null;
  }

  const backfillState = { running: false, lastAt: 0 };
  const BACKFILL_MIN_GAP_MS = 30_000;

  // 惰性回填：记录存在 + 节流到点 → 检查画布恢复（桥两腿任一可达即可，#49 2026-10-08）与两个授权闸 → 复制副本并装载 → 清标记；
  // 任一步不满足/失败：保留记录并附原因（lastError），下次触发再试。恒复制副本（不碰用户当前画布）。
  // v2（2026-10-08）：副本流程补「落盘 + 开副本副驾驶」两步——否则 loadWorkflowFile 会被写拦截
  // （copilot_off）拒绝；总闸关时回填同样暂停（保留记录，等授权）。
  async function backfillPendingCanvasNow(trigger) {
    backfillState.running = true;
    backfillState.lastAt = Date.now();
    const rec = readPendingCanvas();
    const keep = (reason) => { keepPendingWithReason(rec, reason); log(`待同步保留（${reason}）`); };
    try {
      if (!rec) return;
      // #49（B 主链）：壳页在线不再是硬前置——桥调用两腿互补，能回帖即算画布恢复（壳页不在走扩展腿）。
      if (!readAllowWrite()) return keep("未开启「允许 agent 修改画布」授权");
      if (!readAllowCopilot()) return keep("未开启「允许 Agent 开启画布副驾驶」授权（v2 回填需在副本上开副驾驶）");
      let running;
      try { running = await canvasBridgeInvoke("exec.running", {}); }
      catch (e) { return keep(`桥不可达：${msgOf(e)}`); }
      if (!running.ok) return keep(`壳页与扩展腿均不可达：${running.error || "未知"}`);
      if (running.payload && running.payload.runningNodeId != null) return keep("画布有执行中任务，暂不回填");
      const loadRef = resolveBackfillRef(rec.workflowRef);
      if (!loadRef) return keep(`workflowRef 不是可装载的文件引用：${rec.workflowRef}`);
      // ② 复制副本（恒复制；原布零改动）
      const dup = await canvasBridgeInvoke("canvas.duplicate", {});
      if (!dup.ok) return keep(`复制画布失败：${dup.error || "未知"}`);
      const dupPage = dup.payload && dup.payload.page ? String(dup.payload.page) : null;
      const pageKey = dupPage || (dup.payload && dup.payload.key ? String(dup.payload.key) : null);
      // ③ 副本落盘（<原名去尾> (AgentCopy) …）——v2 顺序：先落盘、再开副驾驶（见 copilot.md v2）
      const copyName = await pickAgentCopyName(dupPage || pageKey);
      const saveRevBefore = await canvasRevisionRead();
      const sv = await canvasBridgeInvoke("canvas.save", { name: copyName });
      if (!sv.ok) return keep(`副本落盘失败：${sv.error || "未知"}`);
      if (sv.payload && sv.payload.savedAs === true && sv.payload.pending === true) {
        await settleSaveAsPending(sv.payload, saveRevBefore);
      }
      // ④ 开副本副驾驶
      const cp = await canvasBridgeInvoke("canvas.copilot", { enabled: true });
      if (!cp.ok || !(cp.payload && cp.payload.enabled === true)) {
        return keep(`开副本副驾驶失败：${cp.error || "回执未确认开启"}`);
      }
      // ⑤ 装载产物工作流
      const ld = await canvasBridgeInvoke("canvas.loadWorkflowFile", { file: loadRef.file, force: true });
      if (!ld.ok || (ld.payload && ld.payload.loaded === false)) {
        return keep(`装载失败：${(ld.payload && ld.payload.blocked) || ld.error || "未知"}`);
      }
      clearPendingCanvas();
      log(`待同步已回填：prompt ${rec.promptId} → ${loadRef.file}（副本 ${copyName}，触发 ${trigger}）`);
    } catch (e) {
      keep(`回填异常：${msgOf(e)}`);
    } finally {
      backfillState.running = false;
    }
  }

  function maybeBackfillPendingCanvas(trigger) {
    try {
      if (backfillState.running) return;
      if (Date.now() - backfillState.lastAt < BACKFILL_MIN_GAP_MS) return;
      if (!readPendingCanvas()) return;
      void backfillPendingCanvasNow(trigger).catch((e) => warn(`待同步回填异常：${msgOf(e)}`));
    } catch { /* 检测本身不打扰调用方 */ }
  }

  // T4-2（2026-10-10）：只读进度聚合（执行中可查）。四源并行、能取就取、取不到省略并在 notes 如实标注
  //   （不假造、不触发任何执行/写入）：
  //   ① 桥 exec.running —— 当前执行节点（runningNodeId）+ 活动工作流（画布不在线则缺）
  //   ② 桥 canvas.summary —— 画布节点数（nodeCount）
  //   ③ 中继 /queue —— 后端队列（运行中 / 排队），运行中队首的 promptId
  //   ④ 中继 /_relay/prompts —— /ws 事件聚合（活跃 prompt 的 currentNode / 细粒度 progress + 队列剩余）
  // 返回 { running, canvasOnline, runningNodeId?, nodeCount?, queueRunning?, queueRemaining?, promptId?, progress?, activeWorkflow?, notes[] }
  async function collectCanvasProgress() {
    const notes = [];
    const [run, sum, qs, pr] = await Promise.all([
      canvasBridgeInvoke("exec.running", {}, 8_000).catch((e) => ({ ok: false, error: msgOf(e) })),
      canvasBridgeInvoke("canvas.summary", {}, 8_000).catch((e) => ({ ok: false, error: msgOf(e) })),
      relayJson("/queue", { timeoutMs: 8_000 }).catch(() => null),
      relayJson("/_relay/prompts", { timeoutMs: 8_000 }).catch(() => null),
    ]);
    const out = { notes };
    // ① 桥：当前执行节点 + 活动工作流
    let canvasOnline = false;
    if (run && run.ok) {
      canvasOnline = true;
      const rp = run.payload && typeof run.payload === "object" ? run.payload : {};
      if (typeof rp.runningNodeId === "number") out.runningNodeId = rp.runningNodeId;
      if (rp.activeWorkflow) out.activeWorkflow = String(rp.activeWorkflow);
    } else {
      notes.push(`画布不可达（exec.running：${(run && run.error) || "未知"}）`);
    }
    out.canvasOnline = canvasOnline;
    // ② 桥：画布节点数
    if (sum && sum.ok && sum.payload && typeof sum.payload === "object" && Number.isFinite(Number(sum.payload.nodeCount))) {
      out.nodeCount = Number(sum.payload.nodeCount);
    } else if (canvasOnline) {
      notes.push("画布节点数取不到（canvas.summary 无 nodeCount）");
    }
    // ③ 中继 /queue：后端队列
    let queueRunning = null;
    let queueRemaining = null;
    let queueReachable = false;
    if (qs && qs.ok && qs.data && typeof qs.data === "object") {
      queueReachable = true;
      const rl = Array.isArray(qs.data.queue_running) ? qs.data.queue_running : [];
      const pl = Array.isArray(qs.data.queue_pending) ? qs.data.queue_pending : [];
      queueRunning = rl.length;
      queueRemaining = pl.length;
      out.queueRunning = queueRunning;
      out.queueRemaining = queueRemaining;
      const head = rl.find((it) => Array.isArray(it) && typeof it[1] === "string");
      if (head) out.promptId = head[1];
    } else {
      notes.push("后端 /queue 不可达（队列剩余未知）");
    }
    // ④ 中继 /_relay/prompts：/ws 事件聚合（补 promptId / 当前节点 / 细粒度进度 / 队列剩余）
    if (pr && pr.ok && pr.data && typeof pr.data === "object") {
      const d = pr.data;
      const act = Array.isArray(d.active) ? d.active : [];
      const cur = act.find((r) => r && r.state === "running") || act[0] || null;
      if (queueRemaining === null && d.ws && typeof d.ws.queueRemaining === "number") {
        out.queueRemaining = d.ws.queueRemaining;
        out.queueRemainingSource = "ws";
      }
      if (cur) {
        if (!out.promptId && cur.promptId) out.promptId = cur.promptId;
        if (out.runningNodeId == null && cur.currentNode != null) {
          out.runningNodeId = cur.currentNode;
          out.runningNodeIdSource = "ws";
        }
        if (cur.progress && typeof cur.progress === "object" && typeof cur.progress.value === "number" && typeof cur.progress.max === "number") {
          out.progress = { value: cur.progress.value, max: cur.progress.max, node: cur.progress.node ?? null };
        }
        out.activePrompts = act.length;
      }
    } else {
      notes.push("/ws 事件聚合不可达（细粒度进度缺失）");
    }
    // 执行中判定（M2，2026-10-10）：改三态——有任一「运行态源」可达才给布尔；
    // 画布（exec.running）与后端 /queue 全不可达时 = 未知（out.running=null + notes），绝不报「空闲」。
    const runningSourceReachable = canvasOnline || queueReachable;
    if (runningSourceReachable) {
      out.running = out.runningNodeId != null || (queueRunning != null && queueRunning > 0);
    } else {
      out.running = null;
      notes.push("执行状态未知：画布与后端队列均不可达");
    }
    return out;
  }

  // P8（2026-10-08）：签名补 context（queue 走宿主任务桥需要 callToken）；路由调用点传 null 保留降级。
  async function actionCanvas(args, context) {
    // 默认 state：对话开始时最常用——读服务端缓存的「手边快照」，零往返
    // 注意：白名单 key 是驼峰（openWorkflow / setWidget / addNode…），
    // 不能先把 op 名 toLowerCase 再查表，否则写入类 op 永远对不上。
    const opRaw = String((args && args.op) || "state").trim();
    const op = Object.keys(CANVAS_OPS).find((k) => k.toLowerCase() === opRaw.toLowerCase()) || "";
    const spec = op ? CANVAS_OPS[op] : null;
    if (!spec) throw new Error(`op 必须是 ${Object.keys(CANVAS_OPS).join(" / ")}（收到 "${opRaw}"）`);
    // T1（2026-10-09）文件源通道：source="file" 时不走桥——读类 op（get/check/outline/trace/summary）
    // 读 path 指定的工作流 JSON 文件（免闸门），patch 走文件版事务（沿用「允许 agent 修改画布」闸门）。
    // source 缺省 "live" 时以下全部行为与现状完全一致（本分叉之外一行未动）。
    const sourceRaw = args && args.source != null ? String(args.source).trim().toLowerCase() : "live";
    if (sourceRaw !== "live" && sourceRaw !== "file") {
      throw new Error(`source 只支持 "live"（默认，人眼前画布）或 "file"（工作流 JSON 文件，需 path）（收到 "${String(args.source)}"）`);
    }
    if (sourceRaw === "file") return await actionCanvasFile(args, op, opRaw);
    if (op === "diff") {
      throw new Error('「diff」目前仅支持 source="file"（对两份工作流 JSON 文件做语义 diff：path=基准、pathB=目标）；live 对 file 的比较列为后续');
    }
    // 写入类 op 需显式授权（默认关）；v2（2026-10-08）：副驾驶开关（copilot）改走总闸特判——
    // 只受「允许 Agent 开启画布副驾驶」管辖，不受写授权、不受目标页当前状态影响（否则鸡生蛋）。
    if (spec.write) {
      if (op === "copilot") {
        const gateErr = copilotGateError();
        if (gateErr) throw new Error(gateErr);
      } else if (!readAllowWrite()) {
        throw new Error(`「${op}」会修改你的画布，当前未授权。请在 Hana-ComfyUI 设置页打开「允许 agent 修改画布」后再试。`);
      }
    }
    // patch：缺 edits 提前拦住（不浪费一次桥往返；结构细节校验仍以桥侧为准）
    if (op === "patch" && (!args || !Array.isArray(args.edits) || args.edits.length === 0)) {
      throw new Error("patch 需要 edits（编辑数组）");
    }
    // 写入参数原样透传给桥（桥侧做具体校验）
    const bridgeArgs = {};
    for (const k of [
      "nodeId",
      "nodeIds",
      "index",
      "bounds",
      "color",
      "name",
      "value",
      "type",
      "pos",
      "title",
      "fromNode",
      "fromSlot",
      "toNode",
      "toSlot",
      "slot",
      "mode",
      "name",
      "workflow",
      "path",
      "force",
      "file",
      "command",
      "edits",
      "verify",
      "dryRun",
      "page",
      "front",
      "enabled",
    ]) {
      if (args && args[k] !== undefined) bridgeArgs[k] = args[k];
    }
    // visual：工具面的 action 被动作选择器占用，画布动作经 visualAction 传入（HTTP 路由也可直接给 action）；
    // 桥上字段名沿用契约 {action, nodes, edges, note}。
    if (op === "visual") {
      const vaRaw = typeof args.visualAction === "string" && args.visualAction.trim()
        ? args.visualAction.trim()
        : (typeof args.action === "string" && ["lock", "highlight", "clear"].includes(args.action) ? args.action : "");
      if (!["lock", "highlight", "clear"].includes(vaRaw)) {
        throw new Error("visual 需要 visualAction：lock（置锁）/ highlight（黄标）/ clear（全撤）");
      }
      bridgeArgs.action = vaRaw;
      if (Array.isArray(args.nodes)) bridgeArgs.nodes = args.nodes.map((n) => String(n)).slice(0, 200);
      if (Array.isArray(args.edges)) {
        bridgeArgs.edges = args.edges
          .filter((e) => Array.isArray(e) && e.length >= 2)
          .map((e) => [String(e[0]), String(e[1])])
          .slice(0, 200);
      }
      if (typeof args.note === "string" && args.note.trim()) bridgeArgs.note = args.note.trim().slice(0, 200);
    }
    // visual 自动包裹（契约 §3.2）：写类 op 前 lock、成功后 highlight（改动清单）、异常 clear；
    // 不分 copilot 开关（一致性优先）；dryRun 的 patch 零图变更，不包裹。
    const VISUAL_WRAPPED = { patch: true, organize: true, commands: true };
    const wrapVisual = !!VISUAL_WRAPPED[op] && !(op === "patch" && args && args.dryRun === true);
    if (wrapVisual) {
      const lock = await canvasBridgeInvoke("canvas.visual", { action: "lock", note: `agent 正在执行 ${op}` });
      if (!lock.ok) warn(`visual lock 失败（${op}）：${lock.error || "未知"}（不阻断，继续执行）`);
    }
    // P4（2026-10-08）：probe 特判——两腿各自探测（壳页腿 / 扩展腿各试一次），
    // 不再走 canvasBridgeInvoke 的互回退（壳页对 api.probe 总能回帖 → 扩展腿从不被探测）。
    if (op === "probe") {
      const legs = await canvasProbeLegs();
      const legText = (leg) => (leg.ok ? `ok（${leg.ms}ms）` : `失败（${leg.error || "未回帖"}，${leg.ms}ms）`);
      const text = [
        `两腿可达性：壳页腿 ${legText(legs.shell)}｜扩展腿 ${legText(legs.ext)}`,
        "说明：壳页腿 hasApp=false 属预期（直连模式跨源看不到 app）；两腿均以「是否回帖」为可达判据。",
        JSON.stringify(legs, null, 2),
      ].join("\n");
      maybeBackfillPendingCanvas(`canvas:${op}`);
      return {
        content: [{ type: "text", text }],
        details: { comfyui: { action: "canvas", op, ok: true, payload: legs } },
      };
    }
    // T4-2（2026-10-10）：progress——只读进度聚合（执行中可查；多源并行，取不到如实标注、省略字段）。
    if (op === "progress") {
      const prog = await collectCanvasProgress();
      // M2（2026-10-10）：running 三态——true 执行中 / false 空闲 / null 未知（全源不可达，不谎报空闲）。
      const stateText = prog.running === true ? "执行中" : (prog.running === false ? "空闲" : "未知");
      const lines = [`画布执行进度：${stateText}`];
      if (prog.runningNodeId != null) {
        lines.push(`- 当前节点：#${prog.runningNodeId}${prog.nodeCount != null ? `（画布共 ${prog.nodeCount} 节点）` : ""}`);
      } else if (prog.nodeCount != null) {
        lines.push(`- 画布节点：${prog.nodeCount} 个`);
      }
      if (prog.queueRunning != null || prog.queueRemaining != null) {
        lines.push(`- 队列：运行中 ${prog.queueRunning != null ? prog.queueRunning : "?"} · 排队 ${prog.queueRemaining != null ? prog.queueRemaining : "?"}`);
      }
      if (prog.promptId) {
        lines.push(`- prompt: ${String(prog.promptId).slice(0, 8)}…${prog.progress ? `（当前节点进度 ${prog.progress.value}/${prog.progress.max}）` : ""}`);
      }
      if (prog.activeWorkflow) lines.push(`- 活动工作流：${prog.activeWorkflow}`);
      if (prog.notes.length) lines.push(`- 说明：${prog.notes.join("；")}`);
      let text = lines.join("\n");
      const annot = await fetchCanvasCopilot();
      if (annot !== undefined) text += `\n${copilotLineText(annot)}`;
      maybeBackfillPendingCanvas(`canvas:${op}`);
      return {
        content: [{ type: "text", text }],
        details: { comfyui: { action: "canvas", op, ok: true, progress: prog, ...(annot !== undefined ? { copilot: annot } : {}) } },
      };
    }
    // P1/P2（2026-10-08）：openWorkflow / save 为「快返 + 落定」语义——先取装载前变更序号（settle 参照）。
    let settleRevBefore = null;
    if (op === "openWorkflow" || op === "save") {
      settleRevBefore = await canvasRevisionRead();
    }
    // P8（2026-10-08）：queue 接宿主任务桥——先取 before 快照，供无 promptId 时差集反查。
    let queueBefore = null;
    if (op === "queue") {
      try { queueBefore = await queuePromptIdsSnapshot(); } catch { queueBefore = null; }
    }
    // 两条腿互补的派发在 canvasBridgeInvoke（本函数 / submit canvas 流程 / 回填共用）。
    const inv = await canvasBridgeInvoke(spec.drive, bridgeArgs);
    let payload = null;
    try {
      if (!inv.ok) {
        const why = inv.error || `HTTP ${inv.status}`;
        // v2：写拦截（copilot_off）——转译为友好文案＋如何开启的指引（任务书口径：工具层友好面）。
        if (inv.error === "copilot_off") throw copilotOffError(op, inv);
        // 缺口 4/5（2026-10-13）：target_not_foreground——目标工作流在某页已打开但不在前台
        //（前台是别的标签）。不静默切视线，只给可行动指引＋在线页面/候选清单，切不切由 agent 自主。
        if (inv.error === "target_not_foreground") {
          const tgt = String(
            (bridgeArgs && (bridgeArgs.workflow || bridgeArgs.path || bridgeArgs.name)) || ""
          ).trim();
          const pagesBrief = onlinePagesBrief(inv.pages);
          const candText = Array.isArray(inv.candidates) && inv.candidates.length
            ? `\n- 候选页：${inv.candidates
                .slice(0, 8)
                .map((c) => {
                  const sid = (c && c.sid) || "?";
                  const fg = c && c.foreground ? `前台「${c.foreground}」` : "后台";
                  const mt = Array.isArray(c && c.matches) && c.matches.length ? ` 命中[${c.matches.join(" / ")}]` : "";
                  return `${sid}…（${fg}）${mt}`;
                })
                .join("；")}`
            : "";
          const e = new Error(
            `目标工作流「${tgt || "(未指定)"}」在某页已打开，但该页不在前台（前台是别的标签）——本次「${op}」未执行。` +
              `\n- 可行动指引：用 comfyui(action="canvas", op="activateWorkflow", workflow="${tgt || "<目标名>"}") 切到该标签后再操作（切换会移动用户视线，是否切换由 agent 自主决定）。` +
              `${pagesBrief ? `\n- 在线页面：${pagesBrief}` : ""}${candText}`
          );
          e.code = "target-not-foreground";
          throw e;
        }
        // T3-3（2026-10-10）：openWorkflow 的路由失败（无匹配页 no_page/no_live_page、有页未响应 timeout）
        // → 专用错误码与文案，不混进通用「读画布失败」（旧文案「可能没有打开的页面」与实况矛盾）。
        if (op === "openWorkflow") {
          const routeErr = openWorkflowRouteError({
            error: inv.error,
            wantWf: String((bridgeArgs && bridgeArgs.workflow) || "").trim(),
          });
          if (routeErr) {
            const pagesBrief = onlinePagesBrief(inv.pages);
            const e = new Error(`${routeErr.text}${pagesBrief ? `\n- 在线页面：${pagesBrief}` : ""}`);
            e.code = routeErr.code;
            throw e;
          }
        }
        // A1c（2026-10-08）：路由类错误（no_page / no_live_page）的 py 回执自带在线页面简表——
        // 补进报错文案（数据 = canvasBridgeInvoke 保留的 pages 透传，原被丢弃）。
        const pagesBrief = onlinePagesBrief(inv.pages);
        throw new Error(`读画布失败（${op}，经 ${inv.via}）：${why}${inv.detail ? " · " + inv.detail : ""}${pagesBrief ? `\n- 在线页面：${pagesBrief}` : ""}`);
      }
      payload = inv.payload;
      // P1（2026-10-08）：openWorkflow 明确失败（脏保护 / 未找到）→ 转显式错误（不留半状态、不静默）。
      if (op === "openWorkflow" && payload && typeof payload === "object" && payload.opened === false) {
        if (payload.blocked === "not_found") {
          // A1b（2026-10-08）：name 未命中（前端列表未收录）→ 文件层回退：经 userdata 解析到唯一文件时
          // 改走 loadWorkflowFile 完成装载（不经前端列表身份）；不唯一 / 解析失败 → 保持原报错（候选清单）。
          const target = String(bridgeArgs.path || bridgeArgs.name || "").trim();
          const fb = await resolveOpenWorkflowFallbackRef(target);
          if (fb.ref) {
            const ld = await canvasBridgeInvoke("canvas.loadWorkflowFile", {
              file: fb.ref.file,
              ...(bridgeArgs.force === true ? { force: true } : {}),
            });
            if (!ld.ok) {
              if (ld.error === "copilot_off") throw copilotOffError("loadWorkflowFile", ld);
              throw new Error(`openWorkflow name 未命中，文件回退装载失败：${ld.error || "未知"}`);
            }
            if (ld.payload && ld.payload.loaded === false) {
              if (ld.payload.blocked === "dirty") {
                throw new Error(`openWorkflow name 未命中，文件回退装载被拒：${await loadWorkflowFileDirtyText(ld.payload.activeBefore)}`);
              }
              throw new Error(`openWorkflow name 未命中，文件回退装载被拒（${ld.payload.blocked || "未知"}）`);
            }
            payload = {
              opened: true,
              // M1（2026-10-10）：文件回退成功路径必为「已装载」——补 loaded:true，
              // 与 details「loaded: payload.loaded === true」及文本「已打开并装载…」对齐；
              //（失败路径在此前已 throw，仍如实不落 loaded）。
              loaded: true,
              fallback: "file",
              name: target,
              file: fb.ref.file,
              nodeCount: ld.payload && Number.isFinite(Number(ld.payload.nodeCount)) ? Number(ld.payload.nodeCount) : null,
            };
          } else {
            // A1c（2026-10-08）：补在线页面清单——not_found 回执本身不带 pages，现抓一次 canvas.pages
            //（只读；取不到则略）。
            let pagesBrief = "";
            try {
              const pgs = await canvasBridgeInvoke("canvas.pages", {});
              if (pgs.ok && pgs.payload && Array.isArray(pgs.payload.pages)) pagesBrief = onlinePagesBrief(pgs.payload.pages);
            } catch { /* 取不到不影响报错 */ }
            const cands = Array.isArray(payload.candidates) && payload.candidates.length
              ? `（候选：${payload.candidates.slice(0, 8).join(" / ")}）`
              : "";
            throw new Error(`openWorkflow 被拒：没有找到「${target || "?"}」${cands}${pagesBrief ? `\n- 在线页面：${pagesBrief}` : ""}`);
          }
        } else {
          const why =
            payload.blocked === "dirty"
              ? `当前图有未保存改动（${payload.activeBefore || "?"}）；确认丢弃请传 force=true`
              : `装载被拒（${payload.blocked || "未知"}）`;
          throw new Error(`openWorkflow 被拒：${why}`);
        }
      }
      // A2（2026-10-08）：loadWorkflowFile 脏保护拒载 → 专用文案（对齐 openWorkflow 款）。
      if (op === "loadWorkflowFile" && payload && typeof payload === "object" && payload.loaded === false && payload.blocked === "dirty") {
        throw new Error(`loadWorkflowFile 被拒：${await loadWorkflowFileDirtyText(payload.activeBefore)}`);
      }
      if (wrapVisual && payload && typeof payload === "object" && (payload.ok === false || payload.error)) {
        // patch 事务回滚 / organize 命令失败：无“改动清单”，按异常口径撤锁
        try { await canvasBridgeInvoke("canvas.visual", { action: "clear", note: `${op} 未完成` }); } catch (e) { warn(`visual clear 失败：${msgOf(e)}`); }
      } else if (wrapVisual) {
        const nodes = collectTouchedNodeIds(payload, args);
        try { await canvasBridgeInvoke("canvas.visual", { action: "highlight", nodes }); } catch (e) { warn(`visual highlight 失败：${msgOf(e)}`); }
      }
    } catch (e) {
      if (wrapVisual) {
        try { await canvasBridgeInvoke("canvas.visual", { action: "clear", note: `${op} 异常` }); } catch (e2) { warn(`visual clear 失败：${msgOf(e2)}`); }
      }
      throw e;
    }
    // ── P1/P2/P8（2026-10-08）：快返类 op 的落定 / 任务桥处理 ────────────────
    // P1：openWorkflow 快返（pending）→ 落定校验（到达 activeAfter + 节点数）通过后才报成功，超时/落点不符显式报错。
    if (op === "openWorkflow" && payload && typeof payload === "object" && payload.opened === true && payload.pending === true) {
      // T3-1（2026-10-10）契约收紧：把「打开了（切换已发起）」与「装上了（装载已落定）」分开如实报。
      // 到达语义：装载在途期间活动页尚未切换，不能即时报「落点不符」；
      // 等「活动页到达 activeAfter + 节点数 == nodeCount」才算第一证据，超时不为成功。
      const expectedNodes = toIntOrNull(payload.nodeCount);
      const candidates = payload.activeAfter ? [payload.activeAfter] : (payload.matched ? [payload.matched] : null);
      let arrived = false;
      let settleInfo = null;
      try {
        settleInfo = await waitCanvasTargetArrive({
          expectedNodes,
          candidates,
          revBefore: settleRevBefore ? settleRevBefore.revision : null,
        });
        arrived = true;
      } catch (e) {
        payload.settleError = msgOf(e);
      }
      // 第二证据（可观测）：现抓 summary 的节点数——与期望冲突则判未落定（取不到则以第一证据为准）。
      let summaryNodes = null;
      try {
        const sm = await canvasBridgeInvoke("canvas.summary", {});
        if (sm.ok && sm.payload && typeof sm.payload === "object" && sm.payload.nodeCount != null) {
          summaryNodes = Number(sm.payload.nodeCount);
        }
      } catch { /* 第二证据取不到：由 verdict 退化为「以到达为准」 */ }
      const verdict = openWorkflowLoadVerdict({ arrived, expectedNodes, summaryNodeCount: summaryNodes });
      payload.opened = true;
      payload.loaded = verdict.loaded;
      payload.settled = verdict.loaded;
      payload.settleReason = verdict.reason;
      if (verdict.loaded) {
        payload.settlePolls = settleInfo && settleInfo.polls;
      } else {
        // 校验不过：如实标「未落定」——不回退成功语义、不静默；附现况证据（含 dirty 提示）。
        payload.pending = false;
        payload.unsettled = true;
        const diag = await openWorkflowUnsettledDiag({ expectedNames: candidates });
        payload.diagnostics = { ...diag, summaryNodes };
      }
    }
    // P2：另存并切换（savedAs）pending 时同口径落定（到达 adopted 页）；再核对目标文件确实落盘。
    // （2026-10-08 批：实现抽为 settleSaveAsPending，与 submitCanvasFlow / 回填共用。）
    if (op === "save" && payload && typeof payload === "object" && payload.savedAs === true && payload.pending === true) {
      await settleSaveAsPending(payload, settleRevBefore);
    }
    // P8：queue——promptId 落定（缺失时 /queue 差集反查）→ 建宿主任务（复用 submit 任务桥）。
    let queueTask = null;
    if (op === "queue" && payload && typeof payload === "object" && payload.ok !== false && !payload.error) {
      let promptId = typeof payload.promptId === "string" && payload.promptId ? payload.promptId : null;
      let promptIdVia = promptId ? "queue-op" : null;
      if (!promptId && queueBefore) {
        try {
          const after = await queuePromptIdsSnapshot();
          const fresh = after ? [...after].filter((id) => !queueBefore.has(id)) : [];
          if (fresh.length === 1) { promptId = fresh[0]; promptIdVia = "queue-diff"; }
        } catch { /* 反查失败不阻断；结果如实标注未捕获 */ }
      }
      queueTask = { promptId, promptIdVia, label: null, taskId: null, taskNote: null, subagentOrigin: false };
      if (promptId) {
        const label = `画布执行（${promptId.slice(0, 8)}…）`;
        queueTask.label = label; // 卡 ref 与文本行共用同一 label（卡片功能恢复）
        const { job, subagentOrigin } = await attachHostTask(promptId, {
          label,
          context,
          mode: "canvas-queue",
          meta: { promptIdVia },
        });
        queueTask.taskId = job.taskId;
        queueTask.taskNote = job.taskNote || null;
        queueTask.subagentOrigin = subagentOrigin;
      }
    }
    // 投影过滤器（P1）：get 的 select/fields 在 app 层消费（不透传给桥）
    const projSelect = args && typeof args.select === "string" ? args.select : "";
    const projFields = args && typeof args.fields === "string" ? args.fields : "";
    let text;
    if (op === "pages" && payload) {
      // v2 读侧标注（2026-10-08；续单升级为精确版）：每页副驾驶状态优先取桥 py 的精确值
      // （_frontends 逐条记录，/hana_bridge/state 上报时并入；app/bridge/__init__.py）。
      // 仅当页条目尚无该字段（py 旧版部署）时，退化为「最近上报页」用 state 缓存兜底。
      // null = 该页从未上报过状态（如实，不猜、不借别页值）。
      let recentSid = null;
      let recentCp = null;
      try {
        const st = await canvasBridgeInvoke("canvas.state", {});
        if (st.ok && st.payload && typeof st.payload === "object") {
          recentSid = typeof st.payload.sid === "string" && st.payload.sid ? st.payload.sid : null;
          recentCp = st.payload.copilot || null;
        }
      } catch { /* 标注失败不阻断页面清单 */ }
      for (const p of payload.pages || []) {
        if (p.copilot === undefined && recentSid && p.sidFull === recentSid) p.copilot = recentCp;
      }
      const rows = (payload.pages || []).map((p) => {
        const cpText = p.copilot && typeof p.copilot === "object"
          ? (p.copilot.enabled
              ? `副驾驶：开${p.copilot.pageKey ? `（pageKey=${p.copilot.pageKey}）` : ""}`
              : "副驾驶：关")
          : "副驾驶：未知";
        // T3-4（2026-10-10）：页身份——owner（agent 副本页 / 用户页，未知则省略）+ empty（空图，未知则省略）。
        const tags = [];
        if (p.owner === "agent") tags.push("agent 副本页");
        else if (p.owner === "user") tags.push("用户页");
        if (p.empty === true) tags.push("空图");
        const tagText = tags.length ? `｜${tags.join("｜")}` : "";
        // A 档（2026-10-13）：stale 标注——桥 py 已标 stale:true 的页（久未上报）在行尾追加「（过期）」，
        // 纯追加，不动既有字段顺序与内容；非 stale 页行保持不变。
        const staleText = p.stale === true ? "｜（过期）" : "";
        const line = `  ${p.sid}… 「${p.workflow || "(未命名)"}」 ${p.ageSec}s 前活跃${p.modified ? "（有未保存改动）" : ""}${tagText}｜${cpText}${staleText}`;
        // A 档 S4（2026-10-13）：同页打开的工作流——纯追加，不动上面既有行。
        // 仅当该页上报过 openWorkflows 且 >1 个 Tab 时展开（单 Tab 无信息量＝不显示）；
        // 旧上报/未上报（无该键）→ 原样返回，既有消费方（onlinePagesBrief 等）不受影响。
        const ow = p.openWorkflows;
        if (!Array.isArray(ow) || ow.length <= 1) return line;
        const items = ow.map((w) => {
          const nm = w && typeof w.name === "string" && w.name.trim() ? w.name.trim() : "未命名";
          const isActive = !!w && w.active === true;
          const inner = [];
          if (isActive) inner.push("当前");
          if (w && w.dirty === true) inner.push("未保存");
          return `${isActive ? "▸" : ""}${nm}${inner.length ? `（${inner.join("·")}）` : ""}`;
        });
        return `${line}\n    └ 打开 ${ow.length} 个：${items.join(" · ")}`;
      });
      // 验证单（2026-10-13）：payload.count 是全部条目数（含 TTL 内已失活页），
      // liveCount 是未 stale 的条数。优先用 liveCount，并在有死页时区分显示；缺失时退回 count（行为不变）。
      const total = payload.count;
      const live = typeof payload.liveCount === "number" ? payload.liveCount : total;
      const head = (typeof live === "number" && live !== total)
        ? `在线页面：${live} 个活跃（共 ${total} 条，含已失活）`
        : `在线页面：${total} 个`;
      text = [head, ...rows].join("\n");
      if (!rows.length) text = "在线页面：0 个（没有开着的 ComfyUI 页面）";
      const pageList = payload.pages || [];
      const notes = [];
      const expandedPages = pageList.filter((p) => Array.isArray(p.openWorkflows) && p.openWorkflows.length > 1).length;
      if (expandedPages > 1) {
        notes.push("页下「└ 打开 N 个」= 该页全部打开的工作流（▸=当前 Tab）");
      }
      if (pageList.some((p) => !p.copilot)) {
        notes.push("「副驾驶：未知」= 该页尚未上报状态（未知 ≠ 关闭）");
      }
      if (pageList.some((p) => p.empty === true)) {
        notes.push("「空图」= 该页当前无节点");
      }
      if (pageList.some((p) => !("owner" in p))) {
        notes.push("页身份未标注 = 该页归属未知");
      }
      // A 档（2026-10-13）：全部页都过期时补一句，避免误读为「一个活页都没有」的已死清单。
      if (pageList.length && pageList.every((p) => p.stale === true)) {
        notes.push("全部页面均已过期（久未上报，不等于已关闭）");
      }
      if (notes.length) text += `\n注：${notes.join("；")}。`;
    } else if (op === "state" && payload) {
      if (!payload.hasState) {
        text =
          "还没有画布快照。打开一次 ComfyUI 工作区（让它推一次基线），或改用 op=summary 现抓。";
      } else {
        const s = payload.summary || {};
        const age = payload.ageSec == null ? "时间未知" : `${payload.ageSec}s 前`;
        // P3（2026-10-08）：副驾驶行；v2（2026-10-08 批）统一口径「该画布副驾驶：开 / 关（仅可读、不可写）/ 未知」。
        const cpText = copilotLineText(payload.copilot || null);
        const rows = (s.nodes || []).map(
          (n) => `  #${n.id} ${n.type}${n.title && n.title !== n.type ? ` （${n.title}）` : ""}`,
        );
        text = [
          `画布快照（${age}，rev=${payload.revision ?? "?"}）：${s.nodeCount} 个节点 / ${s.linkCount} 条连线`,
          cpText,
          ...rows,
        ].join("\n");
      }
    } else if (op === "summary" && payload && typeof payload === "object") {
      const rows = (payload.nodes || []).map((n) => `  #${n.id} ${n.type}${n.title && n.title !== n.type ? ` （${n.title}）` : ""}`);
      text = [`画布：${payload.nodeCount} 个节点 / ${payload.linkCount} 条连线`, ...rows].filter(Boolean).join("\n");
    } else if (op === "get" && (projSelect.trim() !== "" || projFields.trim() !== "")) {
      // 投影裁剪：只回命中节点与白名单字段；全量 get 仍落 else 分支（行为不变）
      const s = JSON.stringify(projectGraph(payload, { select: projSelect, fields: projFields }));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "check") {
      // T2 接线：rules 原样透传；object_info best-effort（仅 rules 需要时拉，带缓存；拉不到走 lib 降级）
      const wantOI = rulesNeedObjectInfo(args && args.rules);
      let checkOI;
      if (wantOI) { try { checkOI = await getObjectInfoCached(); } catch { checkOI = undefined; } }
      const s = JSON.stringify(analyzeGraph(payload, { rules: args && args.rules, objectInfo: checkOI }));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "trace") {
      // trace：nodeId/slot/dir 从 args 直读（不透传给桥）；缺参给明确报错
      const nodeId = args && args.nodeId;
      const slot = args && args.slot;
      if (nodeId == null || String(nodeId).trim() === "") throw new Error("trace 需要 nodeId（目标节点 id）");
      if (slot == null || String(slot).trim() === "") throw new Error("trace 需要 slot（名字或索引）");
      const s = JSON.stringify(traceGraph(payload, { node: nodeId, slot, dir: args && args.dir, multi: args && args.multi, depth: args && args.depth }));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "outline") {
      // T2 接线：detail（blocks|nodes）+ block（块选择 → lib 的 select）
      const s = JSON.stringify(outlineGraph(payload, { detail: args && args.detail, select: args && args.block }));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "patch") {
      // 成功与「事务失败（已回滚）」都走这里：结果在 data 层（ok 字段）
      const s = JSON.stringify(payload);
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "running") {
      text = payload && payload.runningNodeId != null ? `当前执行节点：#${payload.runningNodeId}` : "当前没有节点在执行。";
    } else if (op === "prompt" && payload && typeof payload === "object") {
      const n = payload.output && typeof payload.output === "object" ? Object.keys(payload.output).length : 0;
      text = `可提交形态：${n} 个节点（已就绪）。`;
    } else if (op === "revision" && payload) {
      text =
        `画布变更序号 rev=${payload.revision}（记录 ${payload.changeCount} 条）｜` +
        `当前 ${payload.nodes} 节点 / ${payload.links} 连线` +
        (payload.lastChangeAt ? `｜最后变更 ${payload.lastChangeAt}` : "");
    } else if (op === "events" && payload) {
      const KIND = { added: "新增", removed: "删除", changed: "修改" };
      const rows = (payload.changes || []).map((c) => {
        const bits = [];
        if (c.deltaNodes) bits.push(`节点${c.deltaNodes > 0 ? "+" : ""}${c.deltaNodes}`);
        if (c.deltaLinks) bits.push(`连线${c.deltaLinks > 0 ? "+" : ""}${c.deltaLinks}`);
        const detail = (c.changed || []).map((x) => `#${x.id} ${x.type} ${KIND[x.kind] || x.kind}`).join("；");
        return `  rev${c.rev} ${c.at}${bits.length ? " " + bits.join(" ") : ""}${detail ? ` ｜${detail}` : ""}（现 ${c.nodes}/${c.links}）`;
      });
      text = [`画布变更：rev=${payload.revision}，共记录 ${payload.total} 条`, ...rows].join("\n");
      if (!rows.length) text = `画布变更：rev=${payload.revision}，暂无可列出的记录。`;
    } else if (op === "setWidget" && payload) {
      text =
        `已修改 #${payload.nodeId}（${payload.type}）的 ${payload.name}：${payload.before} → ${payload.after}\n` +
        `（要撤回就说一声，可用 op=undo）`;
    } else if (op === "addNode" && payload) {
      text =
        `已新建 #${payload.nodeId}（${payload.type}）${payload.title ? `「${payload.title}」` : ""}\n` +
        `输入：${(payload.inputs || []).join(", ") || "无"}｜输出：${(payload.outputs || []).join(", ") || "无"}\n` +
        `可用参数：${(payload.widgets || []).join(", ") || "无"}（用 op=setWidget 赋值，op=connect 连线）`;
    } else if (op === "removeNode" && payload) {
      text = `已删除 #${payload.removed}（${payload.type}），同时移除 ${payload.incomingLinks} 条入线。（要恢复用 op=undo）`;
    } else if (op === "connect" && payload) {
      text = `已连线 #${payload.from}[${payload.outSlot}] → #${payload.to}[${payload.inSlot}]（linkId=${payload.linkId}）`;
    } else if (op === "disconnect" && payload) {
      text = `已断开 #${payload.nodeId} 的 ${payload.slot}（linkId=${payload.linkId}）`;
    } else if (op === "setNodeMode" && payload) {
      text = `#${payload.nodeId} 已设为 ${payload.label}（mode=${payload.mode}，原 ${payload.before}）`;
    } else if (op === "addGroup" && payload) {
      text = `已新建分组「${payload.title}」（index=${payload.index}）\n框：${JSON.stringify(payload.bounds)}${payload.nodeCount != null ? `｜框住 ${payload.nodeCount} 个节点` : ""}（要撤用 op=undo）`;
    } else if (op === "setGroup" && payload) {
      text = `已更新分组「${payload.title}」（index=${payload.index}）\n框：${JSON.stringify(payload.bounds)}｜变更：${payload.changed && payload.changed.title ? "标题 " : ""}${payload.changed && payload.changed.bounds ? "bounds" : ""}`;
    } else if (op === "removeGroup" && payload) {
      text = `已删除分组「${payload.title}」（index=${payload.index}，节点未动）。（要恢复用 op=undo）`;
    } else if (op === "openWorkflow" && payload && typeof payload === "object") {
      if (payload.unsettled === true) {
        // T3-1（2026-10-10）：未落定如实报——「已切换但未装载/未落定」，并说明复核口径。
        const name = payload.activeAfter || payload.matched || "?";
        const d = payload.diagnostics || {};
        const lines = [
          `openWorkflow 未落定：请求已发起（opened=true，目标「${name}」${payload.nodeCount != null ? `，${payload.nodeCount} 节点` : ""}），但装载未确认落定（loaded=false）。`,
          `- 现况：活动页「${d.active || "(未知)"}」；summary 节点数 ${d.summaryNodes == null ? "未知" : d.summaryNodes}（预期 ${payload.nodeCount == null ? "未知" : payload.nodeCount}）；判据=${payload.settleReason || "未落定"}${payload.settleError ? `；等待详情：${payload.settleError}` : ""}`,
          "- 复核以 summary / events 为准，别只看 opened（opened 仅表示切换请求已发起，不等于画布已装载）。",
        ];
        if (d.pageModified === true) lines.push('- ⚠️ 该页现为 dirty（有未保存改动）：后续 loadWorkflowFile 会被 blocked:"dirty" 拦，需 force:true，或先在画布上处理掉未保存改动。');
        else if (d.pageModified === false) lines.push("- 该页当前未标记未保存改动（dirty=false）。");
        else lines.push("- 该页 dirty 状态未知（页面尚未上报）。");
        if (d.lastChange && d.lastChange.at) lines.push(`- 最近一次画布变更：${new Date(d.lastChange.at).toLocaleString()}（source=${d.lastChange.source || "?"}）。`);
        lines.push("建议：改用 loadWorkflowFile（path=…）按文件直接装载；或排查该页装载失败原因后重试。");
        text = lines.join("\n");
      } else if (payload.fallback === "file") {
        // A1b（2026-10-08）：name 未命中 → 文件回退装载的回执注明。
        text = `已打开并装载：name 未命中，已按文件回退装载（${payload.file}）${payload.nodeCount != null ? `，${payload.nodeCount} 节点` : ""}`;
      } else {
        // P1（2026-10-08）：完整装载语义——落定通过才算成功；壳页腿（旧语义）如实提示。
        const name = payload.activeAfter || payload.matched || "?";
        let line = `已打开并装载「${name}」${payload.nodeCount != null ? `（${payload.nodeCount} 节点）` : ""}`;
        if (payload.settled) line += "；落定校验通过";
        else if (payload.pending) line += "；装载已发起（异步）";
        if (inv && inv.via === "shell" && payload.pending !== true) {
          line += "\n- 注意：本次由壳页腿执行（壳页桥尚未升级为完整装载语义）；如画布未刷新，请重试或改用 loadWorkflowFile";
        }
        text = line;
      }
    } else if (op === "save" && payload) {
      // P2（2026-10-08）：①同名保存=前端保存链（dirty 清零）；②另存并切换（pending 时已落定校验）。
      if (payload.savedAs) {
        text =
          `已另存并切换：${payload.saved}（${payload.nodes != null ? `${payload.nodes} 节点` : "节点数未知"}）` +
          (payload.pending ? "；重绘/落盘已发起，落定校验通过" : "；重绘与落盘已完成");
      } else {
        text =
          `已落盘：${payload.saved}（${payload.nodes} 节点）${payload.backup ? `，备份 ${payload.backup}` : ""}` +
          `；前端保存链已执行（dirty=${payload.dirtyCleared === false ? "未清零⚠" : "已清零"}）`;
      }
    } else if (op === "undo" && payload) {
      text = payload.undone
        ? `已撤销「${payload.undone}」（剩余可撤销 ${payload.stackLeft} 步）`
        : payload.note || "已执行撤销";
    } else if (op === "queue" && payload && typeof payload === "object") {
      // P8（2026-10-08）：补宿主任务行（attachHostTask 复用 submit 任务桥；无 callToken 时降级说明）。
      const qt = queueTask || {
        promptId: typeof payload.promptId === "string" ? payload.promptId : null,
        promptIdVia: null,
        taskId: null,
        taskNote: null,
        subagentOrigin: false,
      };
      const lines = [
        `已发起画布执行（快返）${qt.promptId ? `：prompt ${qt.promptId}${qt.promptIdVia === "queue-diff" ? "（经 /queue 差集反查）" : ""}` : ""}${payload.number !== undefined ? `（队列号 ${payload.number}）` : ""}`,
        "进度以画布原生 UI 为准（队列 / 节点高亮 / 进度条）。",
      ];
      if (qt.promptId) {
        lines.push(
          qt.taskId
            ? (qt.subagentOrigin
                ? `- 宿主任务：${qt.taskId}（next-step；⚠️ ${SUBAGENT_DELIVERY_NOTE}）`
                : `- 宿主任务：${qt.taskId}（next-step 投递，完成后自动回执）`)
            : `- 宿主任务：未创建${qt.taskNote ? `（${qt.taskNote}）` : ""}`,
        );
      } else {
        lines.push("- promptId 未捕获（差集反查不唯一）：未建任务跟踪；可用 comfyui action=query 查看队列。");
      }
      text = lines.join("\n");
    } else if (op === "duplicate" && payload && typeof payload === "object") {
      text = `已复制当前画布为新页${payload.page || payload.key || payload.pageKey ? `：${payload.page || payload.key || payload.pageKey}` : ""}（原布零改动）。`;
    } else if (op === "visual" && payload && typeof payload === "object") {
      text = `视觉标记已更新（${(bridgeArgs && bridgeArgs.action) || "?"}）。`;
    } else if (op === "copilot" && payload && typeof payload === "object") {
      text = payload.enabled
        ? `副驾驶已开启（pageKey=${payload.pageKey || "未知"}）——Agent 进入驾驶位：该画布写操作放行（仍须写授权）。`
        : `副驾驶已关闭（pageKey=${payload.pageKey || "未知"}）——该画布恢复为：仅可读、不可写。`;
    } else {
      const s = JSON.stringify(payload, null, op === "probe" || op === "running" ? 2 : 0);
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    }
    // v2 读侧标注（2026-10-08）：内容类读 op 尾注副驾驶状态行（state 内嵌、pages 逐页已单独标注，不重复）。
    let annotCopilot;
    const COPILOT_ANNOTATED_OPS = new Set(["summary", "get", "check", "trace", "outline", "prompt", "running"]);
    if (COPILOT_ANNOTATED_OPS.has(op)) {
      annotCopilot = await fetchCanvasCopilot();
      if (annotCopilot !== undefined) text = `${text}\n${copilotLineText(annotCopilot)}`;
    }
    // 惰性回填触发点之一（契约 §3.3）：canvas 类 op 完成后检测画布是否恢复
    maybeBackfillPendingCanvas(`canvas:${op}`);
    // T3-1（2026-10-10）：openWorkflow 未落定 → ok:false + blocked:"unsettled"（如实上报，不谎报成功）。
    const openWorkflowUnsettled = op === "openWorkflow" && payload && payload.unsettled === true;
    const details = {
      comfyui: {
        action: "canvas",
        op,
        ok: !openWorkflowUnsettled,
        ...(op === "summary" && payload ? { nodeCount: payload.nodeCount, linkCount: payload.linkCount } : {}),
        // T3-1（2026-10-10）：openWorkflow 把「打开了(opened)」与「装上了(loaded)」分开如实报。
        ...(op === "openWorkflow" && payload && typeof payload === "object"
          ? {
              opened: payload.opened === true,
              loaded: payload.loaded === true,
              ...(payload.unsettled ? { blocked: "unsettled", settleReason: payload.settleReason || null, diagnostics: payload.diagnostics || null } : {}),
            }
          : {}),
        // T2-1（2026-10-10）：读 op 暴露副驾驶状态（结构化）；「未知」＝null（尚未上报），不并同「关」。
        ...(op === "state" && payload ? { copilot: payload.copilot || null } : {}),
        ...(op === "summary" && annotCopilot !== undefined ? { copilot: annotCopilot } : {}),
        ...(op === "probe" || op === "running" || op === "revision" ? { payload } : {}),
        ...(op === "events" ? { changeCount: payload && payload.total } : {}),
        // A1b（2026-10-08）：openWorkflow name 未命中 → 文件回退装载的结构化注明（与文本同步）。
        ...(op === "openWorkflow" && payload && payload.fallback === "file" ? { openWorkflowFallback: { kind: "file", file: payload.file } } : {}),
        // v2（2026-10-08）：「payload + 文本同步」——pages 逐页（含 copilot 标注）、copilot 开关结果。
        ...(op === "pages" && payload ? { count: payload.count, liveCount: payload.liveCount, pages: payload.pages } : {}),
        ...(op === "copilot" && payload ? { copilot: payload } : {}),
        // P8（2026-10-08）：queue 接任务桥后补 promptId / promptIdVia / taskId。
        ...(op === "queue" && queueTask && queueTask.promptId
          ? { promptId: queueTask.promptId, promptIdVia: queueTask.promptIdVia, taskId: queueTask.taskId, bridgeNote: queueTask.taskNote || null }
          : {}),
      },
    };
    // 流内任务卡（卡片功能恢复，2026-10-09）：queue 捕获到 promptId 时同 submit 姿势出卡
    //（旧版 queue op 无卡，按恢复单补齐——机制与 submit 卡一致，卡页按 cardInstanceId 反查）。
    if (op === "queue" && queueTask && queueTask.promptId) {
      details.bridgedTool = { name: "comfyui", server: APP_ID };
      details.card = taskCardRef(queueTask.promptId, queueTask.label || `画布执行（${queueTask.promptId.slice(0, 8)}…）`, `prompt ${queueTask.promptId.slice(0, 8)}… · 画布执行`);
    }
    return { content: [{ type: "text", text }], details };
  }

  // ── 文件源通道（T1，2026-10-09）：source="file" 的读 op 与文件版 patch ─────────
  // 与 live 的关系：读类 op 走 app/lib 同一批纯函数（输出同构；来源标记由文本尾注 + details 承载）；
  // patch 走 workflow-file 的文件版事务（内存全应用 → 全成才写盘 → .bak → 主文件；dryRun/verify 同族）。
  // 路径：绝对路径，或相对 ComfyUI 工作流目录（user/default/workflows）解析；目录外拒绝。
  // 闸门：文件读免闸门；文件写（patch）沿用「允许 agent 修改画布」授权（allow-write.json，同先例）。
  const CANVAS_FILE_READ_OPS = new Set(["get", "check", "outline", "trace", "summary"]);

  // T-fs 修复（2026-10-09）：目录存在性改经中继 /_relay/fs/stat 判断（app 进程不碰 fs）；
  // 全部候选不可用时返回首候选，由后续 read/write 给出可读错误（不抛英文沙箱文案）。
  async function relayStatPath(p) {
    const { ok, data } = await relayJson("/_relay/fs/stat", { method: "POST", body: JSON.stringify({ path: p }), timeoutMs: 8_000 });
    if (!ok || !data || typeof data !== "object") return null;
    return data.stat || null;
  }

  async function resolveCanvasWorkflowsDir() {
    const cands = comfyUserDirCandidates().map((d) => join(d, "workflows"));
    for (const c of cands) {
      try {
        const st = await relayStatPath(c);
        if (st && st.exists && st.isDirectory) return c;
      } catch { /* 中继不可用或查询失败：试下一个候选 */ }
    }
    return cands[0] || null;
  }

  async function actionCanvasFile(args, op, opRaw) {
    const pathRaw = args && args.path != null ? String(args.path) : "";
    const clipJson = (v) => {
      const s = JSON.stringify(v);
      return s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    };

    // ── 读类（免闸门；免画布/免页面）──
    if (CANVAS_FILE_READ_OPS.has(op)) {
      const workflowsDir = await resolveCanvasWorkflowsDir();
      const { abs } = resolveWorkflowPath(pathRaw, workflowsDir);
      const { parsed } = await loadUiWorkflow(abs, { readText: readLocalText });
      let text;
      let payload = null;
      if (op === "get") {
        const projSelect = args && typeof args.select === "string" ? args.select : "";
        const projFields = args && typeof args.fields === "string" ? args.fields : "";
        payload = fileGet(parsed, { select: projSelect, fields: projFields });
        text = clipJson(payload);
      } else if (op === "check") {
        // T2 接线：rules 原样透传；object_info best-effort（仅 rules 需要时拉，带缓存；拉不到走 lib 降级）
        const wantOI = rulesNeedObjectInfo(args && args.rules);
        let checkOI;
        if (wantOI) { try { checkOI = await getObjectInfoCached(); } catch { checkOI = undefined; } }
        payload = fileCheck(parsed, { rules: args && args.rules, objectInfo: checkOI });
        text = clipJson(payload);
      } else if (op === "trace") {
        payload = fileTrace(parsed, { node: args && args.nodeId, slot: args && args.slot, dir: args && args.dir, multi: args && args.multi, depth: args && args.depth });
        text = clipJson(payload);
      } else if (op === "outline") {
        payload = fileOutline(parsed, { detail: args && args.detail, block: args && args.block });
        text = clipJson(payload);
      } else { // summary（与 live 的文本形态同构；首行注明来源是文件）
        payload = fileSummary(parsed);
        const rows = (payload.nodes || []).map((n) => `  #${n.id} ${n.type}${n.title && n.title !== n.type ? ` （${n.title}）` : ""}`);
        text = [`文件：${payload.nodeCount} 个节点 / ${payload.linkCount} 条连线`, ...rows].join("\n");
      }
      text = `${text}\n（source=file：${abs}）`;
      return {
        content: [{ type: "text", text }],
        details: {
          comfyui: {
            action: "canvas", op, ok: true, source: "file", file: abs,
            ...(op === "summary" && payload ? { nodeCount: payload.nodeCount, linkCount: payload.linkCount } : {}),
          },
        },
      };
    }

    // ── 读类附加：diff（两份工作流 JSON 的语义 diff；免闸门）──
    if (op === "diff") {
      const workflowsDir = await resolveCanvasWorkflowsDir();
      const pathB = args && args.pathB != null ? String(args.pathB) : "";
      if (!pathB.trim()) throw new Error("diff 需要 pathB（目标文件；path=基准、pathB=目标）");
      const { abs: baseAbs } = resolveWorkflowPath(pathRaw, workflowsDir);
      const { abs: nextAbs } = resolveWorkflowPath(pathB, workflowsDir);
      const { parsed: baseParsed } = await loadUiWorkflow(baseAbs, { readText: readLocalText });
      const { parsed: nextParsed } = await loadUiWorkflow(nextAbs, { readText: readLocalText });
      const d = fileDiff(baseParsed, nextParsed);
      const text = `${clipJson(d)}\n（diff：${d.summary}）\n（source=file：基准 ${baseAbs} ↔ 目标 ${nextAbs}）`;
      return {
        content: [{ type: "text", text }],
        details: {
          comfyui: {
            action: "canvas", op, ok: true, source: "file",
            base: baseAbs, next: nextAbs, clean: d.clean, summary: d.summary,
          },
        },
      };
    }

    // ── 写类：文件版 patch（沿用「允许 agent 修改画布」闸门；同 allow-write.json 先例）──
    if (op === "patch") {
      if (!readAllowWrite()) {
        throw new Error("「patch（source=file）」会修改工作流文件，当前未授权。请在 Hana-ComfyUI 设置页打开「允许 agent 修改画布」后再试（文件通道沿用该开关）。");
      }
      if (!args || !Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error("patch 需要 edits（编辑数组）");
      }
      const workflowsDir = await resolveCanvasWorkflowsDir();
      const { abs } = resolveWorkflowPath(pathRaw, workflowsDir);
      const { text: oldText, parsed } = await loadUiWorkflow(abs, { readText: readLocalText });
      const report = await runFilePatch({
        abs, text: oldText, parsed,
        edits: args.edits,
        verify: args.verify,
        dryRun: args.dryRun,
        verifyCheck: args.verifyCheck,
        getObjectInfo,
        writeText: writeWorkflowFileViaRelay,
      });
      return {
        content: [{ type: "text", text: clipJson(report) }],
        details: {
          comfyui: {
            action: "canvas", op, ok: report.ok === true, source: "file", file: abs,
            written: report.written === true,
            ...(report.written === true ? { backup: report.backup || null } : {}),
          },
        },
      };
    }

    throw new Error(`source=file 只支持 op：get / check / outline / trace / summary / diff / patch（收到 "${opRaw}"）`);
  }

  // ── 服务环境检查 / 清理 / 等待（T2 · 拉起服务）────────────────────────────
  // 中继端点（T1）：POST /_relay/backend/{envcheck,clear,wait}，均需 controlKey
  // （relayJson 自动带 x-comfy-relay-key）；超时受宿主契约限制（ctx.runtime.fetch ≤30s）。
  async function relayEnvcheck() {
    const { ok, status, data } = await relayJson("/_relay/backend/envcheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 30_000,
    });
    const d = data && typeof data === "object" ? data : {};
    if (!ok || typeof d.snapshotId !== "string") {
      throw new Error(d.error || `中继返回 HTTP ${status}（envcheck 接口不可用？）`);
    }
    return d;
  }

  function formatBlockerLines(blockers) {
    return (Array.isArray(blockers) ? blockers : []).map((b) => {
      if (b && b.kind === "compute") return `- 计算进程 ${b.name || "?"}（pid ${b.pid}）：${b.reason || "疑似其他模型服务"}`;
      const pids = Array.isArray(b && b.pids) ? b.pids.join(", ") : "?";
      return `- 端口占用（pid ${pids}）：${b.reason || "8188 被占用且不可达"}`;
    });
  }

  async function actionService(args, context) {
    const op = String(args.op || "status").trim().toLowerCase();
    const cur = serviceSnapshot();
    if (op === "status") {
      const p = cur.proc;
      const lines = [
        `ComfyUI 服务：${cur.reachable ? "运行中" : "未运行"}（${cur.url}）`,
        p && p.pids && p.pids.length ? `监听进程：${p.pids.join(", ")}` : "",
        p && p.startedAt ? `由本 App 拉起于：${p.startedAt}` : "",
        p && p.install ? `安装根：${p.install}` : "",
        p && p.logFile ? `服务日志：${p.logFile}` : "",
        p && p.lastError ? `上次错误：${p.lastError}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { comfyui: { action: "service", op, reachable: cur.reachable, proc: p } } };
    }
    if (!relayReady()) throw new Error(`中继未就绪（phase=${state.phase}）：${noteFor(state.phase)}`);
    if (op === "envcheck") {
      const d = await relayEnvcheck();
      const blockers = Array.isArray(d.blockers) ? d.blockers : [];
      const warnings = Array.isArray(d.warnings) ? d.warnings : [];
      const gpuLine = d.gpu && d.gpu.available
        ? `显存 ${d.gpu.memoryUsedMiB ?? "?"}/${d.gpu.memoryTotalMiB ?? "?"} MiB（${d.gpu.usedPct ?? "?"}%）`
        : `显存信息不可用${d.gpu && d.gpu.error ? `（${d.gpu.error}）` : ""}`;
      const lines = blockers.length
        ? [
            `环境检查未通过：发现 ${blockers.length} 个阻断项（已暂缓拉起）。`,
            ...formatBlockerLines(blockers),
            `- ${gpuLine}`,
            `快照 snapshotId=${d.snapshotId}（约 180s 内有效；clear 需带上它）。`,
            "处理方式：随消息的操作卡（重试 / 清除其他进程 / 取消），或 service clear 后再 start。",
          ]
        : [`环境检查通过：未发现阻断项，可以 service start 拉起。`, `- ${gpuLine}`];
      if (warnings.length) lines.push(...warnings.map((w) => `- 警告：${w}`));
      const out = {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { comfyui: { action: "service", op, ok: blockers.length === 0, blockerCount: blockers.length, snapshotId: d.snapshotId, warnings } },
      };
      // 环境检查卡（卡片功能恢复，2026-10-09）：阻断时随回执出卡（route 静态 /envcheck.html；卡自拉数据）。
      if (blockers.length) {
        out.details.bridgedTool = { name: "comfyui", server: APP_ID };
        out.details.card = envcheckCardRef(d.snapshotId, blockers.length, context && context.sessionPath);
      }
      return out;
    }
    if (op === "wait") {
      const { ok, status, data } = await relayJson("/_relay/backend/wait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 30_000,
      });
      const d = data && typeof data === "object" ? data : {};
      if (!ok || typeof d.state !== "string") throw new Error(d.error || `中继返回 HTTP ${status}（wait 接口不可用？）`);
      void refreshSnapshot();
      const text = d.state === "ready"
        ? `服务已就绪${typeof d.readyInMs === "number" ? `（启动耗时约 ${Math.round(d.readyInMs / 1000)}s）` : ""}：ComfyUI 前端可用了。`
        : d.state === "starting"
          ? `仍在启动（本轮未就绪）：${d.detail || ""}；可再次 wait 继续等待（建议总时限 120～150s）。`
          : d.state === "timeout"
            ? `启动超时：${d.detail || "仍未就绪"}（未杀进程；可用 service status 或左侧面板看进展）。`
            : `未检测到启动中的服务：${d.detail || "请先 service start。"}`;
      return { content: [{ type: "text", text }], details: { comfyui: { action: "service", op, state: d.state, readyInMs: d.readyInMs, detail: d.detail } } };
    }
    if (op === "clear") {
      const snapshotId = typeof args.snapshotId === "string" ? args.snapshotId.trim() : "";
      const pids = Array.isArray(args.pids)
        ? [...new Set(args.pids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
        : [];
      if (!snapshotId) throw new Error("clear 需要 snapshotId（来自 service envcheck 的一次性快照）");
      if (!pids.length) throw new Error("clear 需要 pids（要清理的进程号数组；仅快照内进程会被处理，列表外一律拒绝）");
      const { ok, status, data } = await relayJson("/_relay/backend/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId, pids }),
        timeoutMs: 30_000,
      });
      const d = data && typeof data === "object" ? data : {};
      if (!ok) throw new Error(d.error || `中继返回 HTTP ${status}（clear 接口不可用？）`);
      void refreshSnapshot();
      const cleared = Array.isArray(d.cleared) ? d.cleared : [];
      const refused = Array.isArray(d.refused) ? d.refused : [];
      const re = d.recheck && typeof d.recheck === "object" ? d.recheck : {};
      const lines = [
        `清理结果：已终止 ${cleared.length} 个（${cleared.join(", ") || "无"}）${refused.length ? `，拒绝 ${refused.length} 个` : ""}。`,
        ...refused.map((r) => `- 拒绝 pid ${r && r.pid}：${(r && r.reason) || "未知原因"}`),
        re.note ? `复查：${re.note}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { comfyui: { action: "service", op, cleared, refused, recheck: re } } };
    }
    if (op === "start") {
      // 拉起前先自动环境检查（方案 §2.1「start 时自动先跑」）；检查本身不可用时 fail-open 照常拉起。
      let envD = null;
      let envNote = "";
      try {
        envD = await relayEnvcheck();
      } catch (e) {
        envNote = `环境检查跳过：${msgOf(e)}（直接尝试拉起）`;
        warn(`service start 环境检查跳过：${msgOf(e)}`);
      }
      const envBlockers = envD && Array.isArray(envD.blockers) ? envD.blockers : [];
      if (envBlockers.length) {
        const text = [
          `环境检查未通过：发现 ${envBlockers.length} 个阻断项，已暂缓拉起。`,
          ...formatBlockerLines(envBlockers),
          `快照 snapshotId=${envD.snapshotId}（约 180s 内有效）。`,
          "操作卡随消息给出（重试 / 清除其他进程 / 取消）；也可 service envcheck → clear → start。",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            comfyui: { action: "service", op, blocked: true, blockerCount: envBlockers.length, snapshotId: envD.snapshotId, warnings: envD.warnings || [] },
            // 环境检查卡（卡片功能恢复，2026-10-09）：start 前自动检查阻断时同 envcheck op 出卡
            bridgedTool: { name: "comfyui", server: APP_ID },
            card: envcheckCardRef(envD.snapshotId, envBlockers.length, context && context.sessionPath),
          },
        };
      }
      const { ok, data } = await relayJson("/_relay/backend/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(typeof args.path === "string" && args.path.trim() ? { path: args.path.trim() } : {}),
        timeoutMs: 25_000,
      });
      void refreshSnapshot();
      const d = data && typeof data === "object" ? data : {};
      if (!ok || d.ok === false) throw new Error(d.error || `中继返回 HTTP ${ok ? 200 : "?"}；${JSON.stringify(d).slice(0, 300)}`);
      const text = d.already
        ? (d.starting || d.state === "starting"
            ? `服务正在启动中（${d.detail || "已受理"}）；无需重复发起，用 service wait 轮询就绪。`
            : "ComfyUI 服务已在运行（无需重复启动）。")
        : [
            "已请求启动 ComfyUI 服务（由计划任务以当前用户身份拉起，独立于 Hana 存活）。",
            d.python ? `解释器：${d.python}` : "",
            d.mainPy ? `入口：${d.mainPy}` : "",
            d.logFile ? `日志：${d.logFile}` : "",
            "首次启动约 30～90 秒（含依赖导入）；用 service wait 轮询就绪（单次≤25s，建议总时限 120～150s），或看工作区左侧面板。",
          ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: [envNote, text].filter(Boolean).join("\n") }], details: { comfyui: { action: "service", op, ...d } } };
    }
    if (op === "stop") {
      const { ok, data } = await relayJson("/_relay/backend/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 25_000,
      });
      void refreshSnapshot();
      const d = data && typeof data === "object" ? data : {};
      if (!ok) throw new Error(d.error || "停止请求未成功（中继未就绪或中继返回错误）");
      const text = d.already
        ? "ComfyUI 服务本来就没在运行。"
        : d.alive
          ? `停止请求已发出，但 ${cur.url} 仍可达（pids=${JSON.stringify(d.pids || [])}）；可能进程正在退出，稍后重查。`
          : `已停止 ComfyUI 服务（终止进程 ${JSON.stringify(d.stopped || [])}）。`;
      return { content: [{ type: "text", text }], details: { comfyui: { action: "service", op, ...d } } };
    }
    throw new Error(`op 必须是 status / start / stop / envcheck / clear / wait（收到 "${op}"）`);
  }

  // ── 工作区自开（B 前置原型：宿主原生窗装工作区）──────────────────────────
  // 定位：落地「开一个宿主原生窗、装入 /workspace.html」的最小通路（B 包先行使，乙案）。
  // 边界：工具入口 action=window · op=open|close|status；B 主链起，由「环境准备」段按需调用
  //       （工作区缺 → 自动拉起 → 等就绪；#38 同刻仅一壳页——自动路径不双开）。
  // 依赖：capabilities 需 app/windows.manage（扩权词，走既有「应用能力」授予，即时生效）；
  //       窗口页凭据由 ui/workspace.js 侧兜底（query 优先；缺则从 /ui/_surface/<token>/ 路径段提取并回填）。
  // 凭据口径（2026-10-08 真机实测修正）：windows.* 一律走「无 callToken」App 级调用（详见 windowCall 注释）。
  // 注意：壳页桥为单桶（shellBridge）——窗口壳页与主工作区壳页共享心跳/队列，同刻仅一壳页。
  const CAP_WINDOWS = "app/windows.manage";
  const WORKSPACE_WINDOW_ENTRY = "/workspace.html";
  const WORKSPACE_WINDOW_TITLE = "ComfyUI 工作区";
  const WORKSPACE_WINDOW_BOUNDS = Object.freeze({ width: 1180, height: 820 });
  let lastWorkspaceWindowId = null; // 原型口径：最近一次 op=open 打开的窗口（close 的缺省目标）

  function windowsDomain() {
    return sdk.windows && typeof sdk.windows.create === "function" ? sdk.windows : null;
  }

  function requireWindowsDomain() {
    const win = windowsDomain();
    if (win) return win;
    throw withCode("宿主未提供 App 原生窗口支持（ctx.windows 缺失；需支持 app/windows.manage 的宿主版本）。", "unsupported");
  }

  async function requireWindowsCapability() {
    const caps = await capabilitiesMap(true); // 强制刷新：授权刚变更时不误判
    if (!caps) return; // 账本不可查时放行——让宿主实际调用当裁判（缺权会带 APP_CAPABILITY_DENIED 回来）
    const st = caps[CAP_WINDOWS] || "not_asked";
    if (st === "always" || st === "session") return;
    throw withCode(
      `未授予能力 ${CAP_WINDOWS}（账本：${st}）：到 设置 → 安全 →「应用能力」为本 App 打开该词（即时生效）；列表里没有该词 = 当前部署版本尚未声明（需先同步新版）。`,
      "capability-denied",
    );
  }

  const WINDOW_ERROR_HINTS = {
    APP_CAPABILITY_DENIED: `宿主拒绝：未授予能力 ${CAP_WINDOWS}（设置 → 安全 →「应用能力」打开后即时生效）。`,
    APP_WINDOW_NOT_FOUND: "窗口不存在或不属于当前调用者（可能已关闭；可用 op=status 查看现状）。",
    APP_WINDOW_NOT_READY: "窗口还在打开中（opening）；稍后用 op=status 再看状态。",
    APP_WINDOW_FORBIDDEN: "窗口调用被宿主拒绝（凭据不属于本 App 或已回收）。现版本为 App 级窗口、不携带 callToken；若仍见该错请携带宿主日志反馈。",
    APP_WINDOW_ENTRY_INVALID: `窗口 entry 无效（应为 App ui/ 内绝对路径，如 ${WORKSPACE_WINDOW_ENTRY}）。`,
    APP_WINDOW_STALE: "本 App 实例已换代（宿主重载过）；请重试。",
  };

  function windowErrText(e) {
    const code = e && typeof e.code === "string" ? e.code : "";
    const hint = WINDOW_ERROR_HINTS[code];
    const raw = msgOf(e);
    return hint ? `${hint}（宿主：${raw}）` : raw;
  }

  // 窗口调用一律不带 callToken（App 级窗口；SDK 契约 AppWindowCall.callToken 为可选）。理由（2026-10-08 真机实测证据链）：
  //   · 工具上下文的 callToken 是「调用期凭据」：宿主在工具 execute 返回的瞬间回收它（宿主 Sjn 包装器的 finally →
  //     releaseCallToken 把令牌从校验账本删除）；之后再用它调 windows.* 必得 APP_WINDOW_FORBIDDEN
  //     "App window call token does not belong to this App."——真机首测即此案（submit 自举后台段）。
  //   · 本段同时跑同步相（op=open/close/status 直接调用）与异步相（submit 自举后台段）——异步相拿不到活凭据；
  //   · token 有无决定窗口归属（带 → agentId=调用代理；无 → agentId=null），而 list/get/close 按
  //     (appId, agentId, generation) 过滤——混用会出现「后台查重看不见前台窗」→ 双开，破坏 #38；
  //   · 故全域统一为无 token（与 hana-builder 对 ownerAgentId=null 走 {} 的同款口径一致）。
  function windowCall(_context) {
    return {};
  }

  function windowLine(w) {
    const b = w && w.bounds && Number.isFinite(w.bounds.width) ? `${w.bounds.width}×${w.bounds.height}` : "?";
    return `${w && w.windowId ? w.windowId : "?"}（${(w && w.state) || "?"}；${(w && w.title) || "?"}；${b}）`;
  }

  // ── TODO 踹探针实验（临时代码，验证完按结论处理）──────────────────────────
  // 目的：验证「App 主进程定时 ctx.windows.request() 踹窗口页 → 窗口页 hana.window.onRequest
  // 应答」的 IPC 消息能否穿透 Chromium 后台节流（intensive throttling）。主进程 setInterval
  // 不受页面节流：每 10s 踹一发 poke（Promise.race 10s 超时；超时不阻塞下一发，防积压）；窗口页
  // 同步应答 { seq, t1, visibility }。每条结果 JSONL 双路追加落盘（POKE_DIR 与 APP_POKE_DIR，同名 poke-<窗开时间戳>.jsonl），
  // 一行一条 {"seq","sentAt","recvAt","deltaMs","pageT1","pageVisibility","state"}
  //（state: ok|timeout|error）。全链路容错、故障可见（脉搏日志 + 落盘告警），探针失败绝不影响正常业务。
  // 摘除指引：① 顶部 KEEPALIVE_PROBE；② 本块；③ openWorkspaceWindow 内启动调用；
  //（应答端在 app/ui/workspace.js 的 setupKeepalivePokeListener）。
  const POKE_INTERVAL_MS = 10_000; // 踹周期
  const POKE_TIMEOUT_MS = 10_000;  // 单发超时（超时记 state="timeout"，recvAt/deltaMs 记 null）
  const POKE_DIR = "D:/HanakoWorks/ComfyUI/_temp/keepalive-probe"; // 实验产物目录（目录不存在则创建）
  const APP_POKE_DIR = join(dataDir, "keepalive-probe"); // 落盘双路保底：app-data 侧目录（同名 basename 文件）
  const keepaliveProbes = new Map(); // windowId → { timer, seq, reg }；防守：同一窗口仅一个循环（防重复叠加）

  function pokeAppendLine(file, row) { // 2026-10-10 可观测化：双路落盘（原 POKE_DIR + app-data 侧）；任一路失败即告警
    const line = JSON.stringify(row) + "\n";
    const base = String(file).replace(/^.*[\\/]/, ""); // 双路同名 basename
    let dOk = false, dErr = "";
    try { // 路由 ①：原实验目录
      mkdirSync(POKE_DIR, { recursive: true });
      writeFileSync(file, line, { flag: "a" });
      dOk = true;
    } catch (e) { dErr = msgOf(e); }
    let aOk = false, aErr = "";
    try { // 路由 ②：app-data 侧（join(dataDir, "keepalive-probe") + 同名 basename 文件）
      mkdirSync(APP_POKE_DIR, { recursive: true });
      writeFileSync(join(APP_POKE_DIR, base), line, { flag: "a" });
      aOk = true;
    } catch (e) { aErr = msgOf(e); }
    if (!dOk || !aOk) warn(`[keepalive-probe] 落盘 d=${dOk ? "ok" : dErr} appdata=${aOk ? "ok" : aErr}`); // 两路都成则静默
  }

  async function pokeOnce(win, windowId, seq, file) {
    const sentAt = Date.now();
    let timer = null;
    const raced = await Promise.race([
      Promise.resolve()
        .then(() => win.request({ windowId, message: { type: "poke", seq, sentAt } }))
        .then((resp) => ({ kind: "ok", resp }), (e) => ({ kind: "error", err: e })), // 超时后的迟到拒绝一并吞掉（保留错误文本供脉搏），不炸链
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), POKE_TIMEOUT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    if (raced.kind === "ok") {
      const resp = raced.resp && typeof raced.resp === "object" ? raced.resp : {};
      const recvAt = Date.now();
      pokeAppendLine(file, {
        seq, sentAt, recvAt, deltaMs: recvAt - sentAt,
        pageT1: typeof resp.t1 === "number" ? resp.t1 : null,
        pageVisibility: typeof resp.visibility === "string" ? resp.visibility : null,
        state: "ok",
      });
      log(`[keepalive-probe] seq=${seq} state=ok deltaMs=${recvAt - sentAt}`); // 脉搏：每发一行
      return;
    }
    pokeAppendLine(file, { // timeout：10s 未回；error：请求被拒/异常（二者 recvAt/deltaMs 记 null）
      seq, sentAt, recvAt: null, deltaMs: null,
      pageT1: null, pageVisibility: null,
      state: raced.kind,
    });
    const errText = raced.err ? ` err=${msgOf(raced.err)}` : ""; // error：附加错误文本（若有）
    log(`[keepalive-probe] seq=${seq} state=${raced.kind} deltaMs=null${errText}`); // 脉搏：每发一行
  }

  function startKeepaliveProbe(windowId) {
    if (!windowId || keepaliveProbes.has(windowId)) return; // 防守：同一窗口只启动一个循环
    const win = sdk.windows;
    if (!win || typeof win.request !== "function") return; // 宿主未提供 request：静默跳过
    const file = join(POKE_DIR, `poke-${Date.now()}.jsonl`); // 文件名＝窗开时间戳
    const entry = { timer: null, seq: 0, reg: null };
    keepaliveProbes.set(windowId, entry);
    entry.timer = setInterval(() => {
      try { pokeOnce(win, windowId, ++entry.seq, file).catch(() => { /* 静默 */ }); } catch { /* 静默 */ }
    }, POKE_INTERVAL_MS);
    entry.timer.unref?.(); // 探针不阻碍进程退出
    // 窗口关闭（ctx.windows.onEvent 的 closed）→ 清循环 + 摘监听（防遗留叠加）
    if (typeof win.onEvent === "function") {
      Promise.resolve()
        .then(() => win.onEvent({ windowId }, (event) => {
          if (event && event.type === "closed") stopKeepaliveProbe(windowId);
        }))
        .then((reg) => {
          entry.reg = reg || null;
          if (!keepaliveProbes.has(windowId)) { try { reg?.dispose?.(); } catch { /* 忽略 */ } } // 竞态兜底：注册迟到于已停
        })
        .catch(() => { /* 静默：监听注册失败不影响循环本体 */ });
    }
    log(`[keepalive-probe] 踹循环已启动：windowId=${windowId} → ${file}（dataDir=${dataDir}）`);
  }

  function stopKeepaliveProbe(windowId) {
    const entry = keepaliveProbes.get(windowId);
    if (!entry) return;
    keepaliveProbes.delete(windowId);
    try { clearInterval(entry.timer); } catch { /* 忽略 */ }
    try { entry.reg?.dispose?.(); } catch { /* 忽略 */ }
    log(`[keepalive-probe] 踹循环已停止：windowId=${windowId}`);
  }
  // ── TODO 踹探针实验块结束 ─────────────────────────────────────────────────

  async function openWorkspaceWindow(context) {
    const win = requireWindowsDomain();
    await requireWindowsCapability();
    // 不再硬要求 callToken（见 windowCall 注释：调用期凭据跨 invoke 不可用，窗口统一 App 级）。
    let snapshot;
    try {
      snapshot = await win.create({
        ...windowCall(context),
        entry: WORKSPACE_WINDOW_ENTRY,
        title: WORKSPACE_WINDOW_TITLE,
        bounds: { ...WORKSPACE_WINDOW_BOUNDS },
        chrome: "custom", // 页面自绘标题栏（拖动 + 三键），故声明 custom（win32 下 BrowserWindow 选项不变）
        data: { role: "workspace" },
      });
    } catch (e) {
      throw withCode(windowErrText(e), (e && e.code) || "window-open-failed");
    }
    lastWorkspaceWindowId = snapshot && typeof snapshot.windowId === "string" ? snapshot.windowId : null;
    log(`工作区窗口已打开：windowId=${lastWorkspaceWindowId || "?"}（entry=${WORKSPACE_WINDOW_ENTRY}）`);
    // TODO 踹探针实验（临时代码，验证完按结论处理）：窗口创建成功 → 为该窗口启动踹循环
    if (KEEPALIVE_PROBE) {
      try { startKeepaliveProbe(lastWorkspaceWindowId); } catch { /* 静默：探针失败绝不影响开窗业务 */ }
    }
    return snapshot;
  }

  async function closeWorkspaceWindow(args, context) {
    const win = requireWindowsDomain();
    await requireWindowsCapability();
    const explicit = typeof args.windowId === "string" ? args.windowId.trim() : "";
    const targetId = explicit || lastWorkspaceWindowId || "";
    if (!targetId) {
      throw withCode("没有可关闭的窗口：未记录到已开的工作区窗；如窗口仍在，先 op=status 取 windowId 再 close。", "no-window");
    }
    let snapshot;
    try {
      snapshot = await win.close({ ...windowCall(context), windowId: targetId });
    } catch (e) {
      throw withCode(windowErrText(e), (e && e.code) || "window-close-failed");
    }
    if (targetId === lastWorkspaceWindowId) lastWorkspaceWindowId = null;
    log(`工作区窗口已关闭：windowId=${targetId}`);
    return snapshot;
  }

  async function workspaceWindowStatus(context) {
    const win = requireWindowsDomain();
    await requireWindowsCapability();
    let windows = [];
    try {
      const list = await win.list(windowCall(context));
      windows = Array.isArray(list) ? list : [];
    } catch (e) {
      throw withCode(windowErrText(e), (e && e.code) || "window-list-failed");
    }
    // last 指向的窗口若不在 list（列表按调用者过滤后不可见等），单独 get 一次补状态
    let last = null;
    if (lastWorkspaceWindowId && !windows.some((w) => w && w.windowId === lastWorkspaceWindowId)) {
      try {
        last = await win.get({ ...windowCall(context), windowId: lastWorkspaceWindowId });
      } catch (e) {
        last = { windowId: lastWorkspaceWindowId, error: windowErrText(e) };
      }
    }
    return { windows, last };
  }

  async function actionWindow(args, context) {
    const op = String(args.op || "status").trim().toLowerCase();
    if (op === "open") {
      const snapshot = await openWorkspaceWindow(context);
      const text = [
        `工作区窗口已打开：${windowLine(snapshot)}`,
        `- entry=${WORKSPACE_WINDOW_ENTRY} · chrome=custom · bounds=${snapshot && snapshot.bounds ? `${snapshot.bounds.width}×${snapshot.bounds.height}` : "?"}`,
        "窗口页自取 surface 凭据（query 优先；缺则从路径段提取并回填 URL）。",
        "注意：壳页桥为单桶——同刻仅一壳页（窗口页与卡/面板页并存会互抢画布 op）。",
      ].join("\n");
      return { content: [{ type: "text", text }], details: { comfyui: { action: "window", op, ok: true, window: snapshot } } };
    }
    if (op === "close") {
      const snapshot = await closeWorkspaceWindow(args, context);
      const text = `已关闭工作区窗口：${windowLine(snapshot)}`;
      return { content: [{ type: "text", text }], details: { comfyui: { action: "window", op, ok: true, window: snapshot } } };
    }
    if (op === "status") {
      const { windows, last } = await workspaceWindowStatus(context);
      const lines = windows.length
        ? windows.map((w) => `- ${windowLine(w)}`)
        : ["（当前没有本 App 的已开窗口）"];
      if (last) lines.push(`- last 补查：${last.error ? `${last.windowId}（get 失败：${last.error}）` : windowLine(last)}`);
      const text = [`工作区窗口：${windows.length} 个`, ...lines, "op=open 打开窗口；op=close 关闭。"].join("\n");
      return { content: [{ type: "text", text }], details: { comfyui: { action: "window", op, ok: true, windows, last } } };
    }
    throw new Error(`window 的 op 必须是 open / close / status（收到 "${op}"）`);
  }

  // ── 画布移交（2026-10-09 首版；2026-10-09 晚修订 1：非破坏加入 + 任意次序接管）──────────
  // 方案：docs/画布移交-外开窗口到主工作区-20261009.md（含「⚠ 修订 1」节）。单桶壳页桥（shellBridge）
  // 下不做实时接力，本移交 = 一次性状态转移：
  //   · op=write（窗口侧）：取全量画布（canvas.get，读类不需授权）→ 落盘
  //     user/default/workflows/_handoff-<ts>.json（中继 /_relay/fs/write 原子写）→ 写标记 handoff.json（app-data）；
  //   · op=peek / op=clear（卡侧/测试）：查 / 清标记；
  //   · op=take（卡侧）：查标记 → 桥 canvas.loadWorkflowNewPage【新开页装载】（快照开为一张
  //     【新】画布页，不触碰当前活动页——内容/dirty 无关，故无 dirty 分支）→ 成功清标记。
  //     口径＝「用户主动移交」（用户点「放入」+ 开卡接住），不走 agent 写闸门；桥侧该 op 不登记
  //     WRITE_OPS（不含 copilot 写拦截）。防重入：本函数内 take 互斥（同一时刻一次）+ 桥侧同文件去重
  //     （回执超时后的重试不重复开页）。触发侧（短窗轮询/活跃重查）见 app/ui/workspace.js。
  //   · 修订 1.2：write 落盘写标记后，若「卡实例记录」新鲜 → 立即定向直发同一「新开页装载」
  //     （按精确 sid 单发给卡实例；在线场景秒级进入 hui），成功即清标记；失败/无目标才落到卡侧
  //     兜底（短窗/低频巡检/take）。直发与卡侧 take 并发时由桥侧同文件去重兜底（不产生第二页）。
  //   · op=close-window：复用「工作区自开」的 close 通道（窗口页优先用宿主窗口 API 自关，失败再走这里）。
  const HANDOFF_FILE = join(dataDir, "handoff.json");
  const HANDOFF_PREFIX = "_handoff-";

  function readHandoffMarker() {
    try {
      const j = JSON.parse(readFileSync(HANDOFF_FILE, "utf8"));
      if (j && typeof j.file === "string" && j.file.trim()) return j;
    } catch { /* 无标记 / 损坏：按无标记处理 */ }
    return null;
  }
  function writeHandoffMarker(marker) {
    writeFileAtomic(HANDOFF_FILE, JSON.stringify(marker, null, 2)); // 原子写（.tmp → rename）
  }
  function clearHandoffMarker() {
    try { rmSync(HANDOFF_FILE, { force: true }); return true; } catch { return false; }
  }
  let takeInFlight = false; // take 防重入（修订 1）：同一时刻只允许一次在途；并发/重入请求回报 inFlight
  // ── 修订 1.2：定向直发（在线场景「点击直发」）──────────────────────────────
  // 卡壳页随 handoff/peek 上报「本壳 iframe 实例的 sid」（经桥 postMessage 宣告获得），记于此；
  // write 时若记录新鲜，把「新开页装载」按精确 sid 单发给该实例（不走壳页队列、不广播）。
  let handoffCardSid = null; // { sid, at }
  const HANDOFF_CARD_TTL_MS = 150_000; // 新鲜窗口：巡检 60s 拍 ×2 余量（短窗期 2.5s 拍，更鲜）
  function rememberCardSid(raw) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s || s.length > 128) return; // 形状校验（clientId 为 uuid 级字符串；超长/空直接忽略）
    handoffCardSid = { sid: s, at: Date.now() };
  }
  function freshCardSid() {
    if (handoffCardSid && Date.now() - handoffCardSid.at < HANDOFF_CARD_TTL_MS) return handoffCardSid.sid;
    return null;
  }

  // 定向直发：把「新开页装载」单发给在线的 hui 实例（不含窗实例）。链路——
  //   app → /_relay/bridge（relay 提升 args.sid 到顶层）→ py _hana_call 定向 send_sync（单发）
  //   → 目标实例的桥执行 canvas.loadWorkflowNewPage → 同源回传 → py → relay → 本函数回执。
  // 返回 { ok, reason, page? }；ok=true 时标记已清（接住即完成）。任一步失败 → 保留标记走卡侧离线兜底。
  async function tryDirectDeliver(marker) {
    const sid = freshCardSid();
    if (!sid) return { ok: false, reason: "no-card" }; // 无新鲜卡记录：hui 离线（或壳页身份通道未就绪）→ 兜底
    try {
      // 前置校验（防「定向退化广播」）：py 的 _hana_call 在「sid 不在账本」时会退化为广播
      //（误伤其他实例）；先确认该 sid 存在于活页清单。仅存在性判定、不要求未过期——账本条目只标
      // stale、不删；「是否真活」以投递回执为准（stale 只是「久未上报」，活实例照常可达；
      // 真断了则无回执→超时→兜底）。检查通过后即使目标瞬断也不会退化为广播。
      const pages = await relayJson("/_relay/bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "canvas.pages", args: {} }),
        timeoutMs: 5_000,
      });
      const list = pages && pages.ok && pages.data && pages.data.ok && pages.data.data && Array.isArray(pages.data.data.pages)
        ? pages.data.data.pages : null;
      if (!list || !list.some((p) => p && p.sidFull === sid)) {
        return { ok: false, reason: "card-not-live" };
      }
      // 定向投递（单发；不走壳页桥队列，也不广播）
      const del = await relayJson("/_relay/bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "canvas.loadWorkflowNewPage", args: { file: marker.file, sid } }),
        timeoutMs: 8_000, // > py CALL_TIMEOUT_SEC(6s)：让 py 的超时回执先到，拿明确失败语义
      });
      const d = del && del.data;
      if (d && d.ok === true && d.data && d.data.newPage === true) {
        clearHandoffMarker();
        log(`画布移交：定向直发成功（sid=${sid.slice(0, 8)}…，新开页 ${d.data.page || "?"}${d.data.dedup ? "，幂等去重" : ""}）`);
        return { ok: true, reason: "delivered", page: d.data.page || null };
      }
      log(`画布移交：定向直发未完成（${(d && (d.error || d.detail)) || `HTTP ${del && del.status}`}）——保留标记走离线兜底`);
      return { ok: false, reason: "deliver-failed" };
    } catch (e) {
      log(`画布移交：定向直发异常（${msgOf(e)}）——保留标记走离线兜底`);
      return { ok: false, reason: "deliver-error" };
    }
  }

  async function actionHandoff(op, args) {
    if (op === "write") {
      if (!relayReady()) return { ok: false, error: "relay-not-ready" };
      const got = await canvasBridgeInvoke("canvas.get", {});
      if (!got.ok) return { ok: false, error: got.error || "取画布失败", detail: got.detail || null, pages: got.pages || null };
      const graph = got.payload;
      if (!graph || typeof graph !== "object") return { ok: false, error: "画布全量为空（页面未就绪？）" };
      const workflowsDir = await resolveCanvasWorkflowsDir();
      if (!workflowsDir) return { ok: false, error: "找不到 ComfyUI 工作流目录（user/default/workflows）" };
      const name = `${HANDOFF_PREFIX}${Date.now()}.json`;
      const abs = join(workflowsDir, name);
      const written = await writeWorkflowFileViaRelay(abs, JSON.stringify(graph)); // 与 ComfyUI 自身保存同为紧凑 JSON
      const marker = {
        file: `workflows/${name}`, // 桥 loadWorkflowFile 要求「相对 user/default」的路径
        abs,
        ts: new Date().toISOString(),
        from: String((args && args.from) || "window"),
        nodes: Array.isArray(graph.nodes) ? graph.nodes.length : null,
      };
      writeHandoffMarker(marker);
      log(`画布移交：已落盘 ${name}（来源 ${marker.from}${written && written.size != null ? `，${written.size} B` : ""}）`);
      // 修订 1.2：在线场景「定向直发」——按精确 sid 单发给在线的 hui 实例（秒级、拿回执）；
      // 失败/无目标 → 保留标记，走卡侧离线兜底（短窗 / 低频巡检）。回执驱动窗口文案与谢幕。
      const del = await tryDirectDeliver(marker);
      return {
        ok: true, file: marker.file, abs, ts: marker.ts, nodes: marker.nodes,
        delivered: del.ok === true, reason: del.reason || null, page: del.page || null,
      };
    }
    if (op === "peek") {
      rememberCardSid(args && args.cardSid); // 修订 1.2：卡壳页顺带上报本壳实例 sid（定向直发目标记录）
      const m = readHandoffMarker();
      return m ? { ok: true, has: true, ...m } : { ok: true, has: false };
    }
    if (op === "clear") return { ok: true, cleared: clearHandoffMarker() };
    if (op === "take") {
      if (!relayReady()) return { ok: false, error: "relay-not-ready" };
      const m = readHandoffMarker();
      if (!m) return { ok: true, taken: false, absent: true };
      // 防重入（第一道；第二道=桥侧同文件去重）：短窗轮询 / 活跃重查 / 并发来源同一时刻只放一次 in-flight。
      if (takeInFlight) return { ok: true, taken: false, inFlight: true };
      takeInFlight = true;
      try {
        // 修订 1：接住动作 = 桥「新开页装载」（快照开为一张【新】画布页；不触碰当前活动页，
        // 故无 dirty 分支）。口径＝「用户主动移交」，不走 agent 写闸门（桥侧该 op 不在 WRITE_OPS）。
        const r = await canvasBridgeInvoke("canvas.loadWorkflowNewPage", { file: m.file });
        if (!r.ok) return { ok: false, error: r.error || "装载失败", detail: r.detail || null, pages: r.pages || null };
        const p = r.payload && typeof r.payload === "object" ? r.payload : {};
        if (p.newPage === true) {
          clearHandoffMarker();
          log(`画布移交：已接住 ${m.file}（新开页${p.page ? ` ${p.page}` : ""}${p.dedup ? "，幂等去重" : ""}，via ${r.via}）`);
          return {
            ok: true, taken: true, file: m.file,
            page: p.page || null,
            nodeCount: p.nodeCount != null ? p.nodeCount : null,
            dedup: p.dedup === true,
            via: r.via, ts: m.ts,
          };
        }
        return { ok: false, error: "装载返回未知形态", detail: p };
      } finally {
        takeInFlight = false;
      }
    }
    if (op === "close-window") {
      try {
        const snapshot = await closeWorkspaceWindow({}, null);
        return { ok: true, closed: true, window: snapshot || null };
      } catch (e) {
        return { ok: false, closed: false, error: msgOf(e) };
      }
    }
    return { ok: false, error: `handoff op 必须是 write / peek / clear / take / close-window（收到 "${op}"）` };
  }

  // ── 环境自举（B 主链，2026-10-08）：单一互斥 + 服务/页面自举段 + submit 准备链 ──
  // 口径（任务书/核查 §1.3、§6.2、§3.3）：
  //   · 三个自举动作（中继 / 服务 / 工作区）统一走单一互斥 ensureEnvironmentPrepared——并发提交只跑一轮准备，其余等待；
  //   · 服务段 = envcheck → start → 多轮 wait → 重探（单次 wait ≤25s 是宿主硬上限，故多轮循环；总时限 150s）；
  //     envcheck 阻断 → 停下报告、不自动清障；
  //   · 页面段 = 重探两腿（#49）；工作区没开 → 自动拉起宿主原生窗（属环境准备，不加新开关）→ 等就绪（探测自愈，90s）；
  //     壳页在线但桥不可达 → 不双开（#38 同刻仅一壳页），等自愈，超时停下；
  //   · 失败分类沿用包 A 停下范式（blocked / 原因文本）；跨 App 重载无持久化（与现状一致）。
  const SERVICE_PREPARE_WAIT_DEADLINE_MS = 150_000; // 服务段总时限（与 service wait 文案口径一致）
  const PAGE_PREPARE_WAIT_DEADLINE_MS = 90_000;     // 页面段总时限（窗口加载 / 页面重载的自愈窗口）
  const SEGMENT_LABEL = { relay: "中继", service: "服务", workspace: "工作区" };
  let envPreparePromise = null; // 单一互斥：并发提交复用同一轮准备（收尾即清）

  async function ensureEnvironmentPrepared(opts = {}) {
    if (envPreparePromise) return envPreparePromise;
    const startedAt = Date.now();
    envPreparePromise = (async () => {
      const journal = [];
      const note = (segment, ok, noteText, toJournal = true) => {
        if (toJournal) journal.push({ segment, ok, note: noteText || "", atMs: Date.now() - startedAt });
        if (typeof opts.onProgress === "function") {
          try { opts.onProgress(`环境准备中（${SEGMENT_LABEL[segment] || segment}：${noteText || (ok ? "完成" : "失败")}）`); } catch { /* 进度反馈失败不阻断 */ }
        }
      };
      // 段 1 · 中继（进程内 ensureManagedRuntime；内部单飞行叠加，安全）
      if (!relayReady()) {
        note("relay", true, "自举中", false); // 进度播报；记 journal 的是终态
        try {
          await ensureManagedRuntime();
        } catch (e) {
          note("relay", false, msgOf(e));
          return { ok: false, failedAt: "relay", error: msgOf(e), journal };
        }
        note("relay", true, "已就绪");
      } else {
        note("relay", true, "本就就绪（跳过）");
      }
      // 段 2 · 服务
      if (serviceSnapshot().reachable) {
        note("service", true, "本就可达（跳过）");
      } else {
        const r = await prepareServiceSegment(opts);
        if (!r.ok) {
          note("service", false, r.error || "启动失败");
          return { ok: false, failedAt: "service", ...r, journal };
        }
        note("service", true, r.note || "已就绪");
      }
      // 段 3 · 页面（工作区）
      const p = await preparePageSegment(opts);
      if (!p.ok) {
        note("workspace", false, p.error || "不可达");
        return { ok: false, failedAt: "workspace", ...p, journal };
      }
      note("workspace", true, p.note || "已可达");
      return { ok: true, journal };
    })().finally(() => { envPreparePromise = null; });
    return envPreparePromise;
  }

  // 服务段（核查 §1.3 循环封装）：envcheck（阻断→停）→ start → 多轮 wait → 重探；失败分类原样带出。
  async function prepareServiceSegment(opts = {}) {
    const tick = (noteText) => { if (typeof opts.onProgress === "function") { try { opts.onProgress(noteText); } catch { /* 忽略 */ } } };
    let env = null;
    try { env = await relayEnvcheck(); }
    catch (e) { return { ok: false, error: `环境检查不可用：${msgOf(e)}` }; }
    const blockers = Array.isArray(env.blockers) ? env.blockers : [];
    if (blockers.length) {
      // 阻断即停，不自动清障（#8 / 分工方案 §1-2）：带回阻断明细与快照 id 供停下回执。
      return { ok: false, blocked: true, blockerCount: blockers.length, snapshotId: env.snapshotId || null, blockerLines: formatBlockerLines(blockers) };
    }
    tick("环境准备中（服务：环境检查通过，拉起中）");
    let startData = null;
    try {
      const s = await relayJson("/_relay/backend/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 25_000,
      });
      startData = s.data && typeof s.data === "object" ? s.data : null;
      if (!s.ok || (startData && startData.ok === false)) {
        return { ok: false, error: (startData && startData.error) || `中继返回 HTTP ${s.status}` };
      }
    } catch (e) {
      return { ok: false, error: `拉起请求失败：${msgOf(e)}` };
    }
    const t0 = Date.now();
    for (;;) {
      let w = null;
      try {
        w = await relayJson("/_relay/backend/wait", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          timeoutMs: 30_000,
        });
      } catch (e) {
        return { ok: false, error: `等待服务就绪失败：${msgOf(e)}` };
      }
      const d = w.data && typeof w.data === "object" ? w.data : {};
      const st = typeof d.state === "string" ? d.state : "";
      if (st === "ready") {
        void refreshSnapshot(); // 末态快照（wait 内部已刷一次；此处再触发确保读到）
        const secs = typeof d.readyInMs === "number" && d.readyInMs > 0 ? `（约 ${Math.round(d.readyInMs / 1000)}s）` : "";
        return { ok: true, reachable: true, note: `已就绪${secs}` };
      }
      if (st === "failed" || st === "timeout") {
        return { ok: false, timeout: st === "timeout", error: d.detail || (st === "timeout" ? "启动超时（未杀进程）" : "未检测到启动中的服务") };
      }
      if (st !== "starting") {
        return { ok: false, error: d.detail || `wait 返回未知状态（${st || "?"}）` };
      }
      if (Date.now() - t0 >= SERVICE_PREPARE_WAIT_DEADLINE_MS) {
        return { ok: false, timeout: true, error: `启动等待超时（${Math.round(SERVICE_PREPARE_WAIT_DEADLINE_MS / 1000)}s 未就绪，未杀进程）` };
      }
      tick(`环境准备中（服务：启动中，已等 ${Math.round((Date.now() - t0) / 1000)}s）`);
      await sleep(1_500); // 轮间短休（中继探测节拍 5s，短间隔轮询只是浪费往返）
    }
  }

  // 页面段：重探两腿 → 缺则自动拉起工作区窗口（#38 同刻仅一壳页；已是壳页在线就只等自愈）→ 等就绪。
  async function preparePageSegment(opts = {}) {
    const context = opts.context || null;
    const tick = (noteText) => { if (typeof opts.onProgress === "function") { try { opts.onProgress(noteText); } catch { /* 忽略 */ } } };
    let probe = await canvasProbe({ timeoutMs: 10_000 });
    if (probe.ok) return { ok: true, via: probe.via || null, note: `画布已可达（经 ${probe.via === "shell" ? "壳页腿" : "扩展腿"}）` };
    if (probe.shellOk) {
      // 壳页在线但桥不可达：同刻仅一壳页——不另开窗口；等页面自愈（服务恢复后的重连/重载窗口期）。
      tick("环境准备中（工作区：壳页在线，等画布桥自愈）");
      const deadline = Date.now() + PAGE_PREPARE_WAIT_DEADLINE_MS;
      for (;;) {
        if (Date.now() >= deadline) {
          return { ok: false, error: `工作区壳页在线，但画布桥不可达：${probe.reason || "未知"}（同刻仅一壳页，未另开窗口；可刷新工作区页面后重新提交）` };
        }
        await sleep(2_500);
        probe = await canvasProbe({ timeoutMs: 10_000 });
        if (probe.ok) return { ok: true, via: probe.via || null, note: "画布桥已自愈（壳页在线）" };
      }
    }
    // 工作区没开（壳页不在线，扩展腿也不可达）→ 自动拉起窗口（属环境准备，不加新开关；回执注明）。
    tick("环境准备中（工作区：未开，拉起窗口中）");
    const existing = await findWorkspaceWindow(context);
    let opened = null;
    if (existing) {
      log(`工作区自举：已有窗口 ${existing.windowId || "?"}（state=${existing.state || "?"}），不另开（同刻仅一壳页），等待其上线`);
    } else {
      try {
        opened = await openWorkspaceWindow(context);
      } catch (e) {
        return { ok: false, error: `工作区拉起失败：${msgOf(e)}` };
      }
    }
    const deadline = Date.now() + PAGE_PREPARE_WAIT_DEADLINE_MS;
    for (;;) {
      if (Date.now() >= deadline) {
        const wid = (opened && opened.windowId) || (existing && existing.windowId) || "?";
        return {
          ok: false,
          windowOpened: !!opened,
          windowId: (opened && opened.windowId) || null,
          error: `工作区窗口${opened ? "已拉起" : "已在"}（${wid}），但 ${Math.round(PAGE_PREPARE_WAIT_DEADLINE_MS / 1000)}s 内画布桥仍不可达：${probe.reason || "未知"}（可查看工作区页面或稍后重新提交）`,
        };
      }
      await sleep(2_500);
      probe = await canvasProbe({ timeoutMs: 10_000 });
      if (probe.ok) {
        return {
          ok: true,
          via: probe.via || null,
          windowOpened: !!opened,
          windowId: (opened && opened.windowId) || null,
          note: `${opened ? `已拉起工作区窗口（${opened.windowId || "?"}）` : "已有工作区窗口上线"}，画布已可达（经 ${probe.via === "shell" ? "壳页腿" : "扩展腿"}）`,
        };
      }
    }
  }

  // #38 同刻仅一壳页：查已有本 App 工作区窗（opening/ready）——有则自举不双开，只等它上线。
  async function findWorkspaceWindow(context) {
    const win = sdk.windows && typeof sdk.windows.list === "function" ? sdk.windows : null;
    if (!win) return null;
    try {
      const list = await win.list(windowCall(context));
      const arr = Array.isArray(list) ? list : [];
      return (
        arr.find((w) => w && (w.state === "opening" || w.state === "ready") && ((w.data && w.data.role === "workspace") || w.title === WORKSPACE_WINDOW_TITLE)) || null
      );
    } catch (e) {
      warn(`工作区窗口列表查询失败（忽略，按无窗处理）：${msgOf(e)}`);
      return null;
    }
  }

  // ── submit 环境准备链（B 主链 · 任务化）────────────────────────────
  // actionSubmit auto 探测缺环境时进入：静态预检（前移）→ 快返「环境准备中」（宿主任务）→ 后台准备
  // → 就绪自动继续（重探 → 画布五步）→ 终态回执；失败 → 停下回执（准备任务 fail / 日志）。
  async function submitBootstrapFlow(args, context, hint) {
    // ① 静态可验项前移（核查 §3.3）：装载引用解析——「不可装载」属静态失败，不必等环境就绪。
    //    （中继未就绪时跳过：解析本身依赖中继，留给自动继续阶段再解析。）
    let preRef = null;
    if (relayReady()) {
      const wfArg = args.workflow;
      const wfPath = typeof wfArg === "string" ? wfArg.trim() : "";
      const wfTemplate =
        isPlainObject(wfArg) && typeof wfArg.template === "string" && Object.keys(wfArg).length === 1 ? wfArg.template.trim() : "";
      try {
        preRef = await resolveCanvasLoadRef({ wfPath, wfTemplate });
      } catch (e) {
        warn(`submit auto 停下（${(e && e.code) || "canvas-unloadable"}，静态预检）：${msgOf(e)}`);
        return autoStopReplyForCanvasError(e);
      }
    }
    // ② 环境缺口（缺什么说什么）与计划动作（如实前置说明；实际结果以后台回执为准）
    const missing = [];
    const plan = [];
    if (!hint.diag || !hint.diag.relayOk) {
      missing.push("中继未就绪");
      plan.push("中继自举");
    }
    if (hint.diag && hint.diag.relayOk && hint.diag.serviceOk === false) {
      missing.push(hint.diag.serviceDetail && hint.diag.serviceDetail.starting ? "服务启动中" : "服务未运行");
      plan.push("服务自举（环境检查 → 拉起 → 等就绪）");
    }
    if (hint.probe && !hint.probe.ok) {
      if (hint.probe.shellOk) {
        missing.push("画布桥不可达");
        plan.push("等待画布桥自愈");
      } else {
        missing.push("工作区未开");
        plan.push("自动拉起工作区窗口");
      }
    } else if (!hint.probe) {
      plan.push("工作区未开时自动拉起窗口");
    }
    if (!missing.length) missing.push("环境未就绪");
    if (!plan.length) plan.push("环境检查");
    // ③ 快返「环境准备中」回执 + 后台准备（宿主任务；进度按既有任务体系回写）
    const callToken = context && typeof context.callToken === "string" ? context.callToken : "";
    let prepareTaskId = null;
    let taskNote = null;
    if (callToken) {
      try {
        const t = await sdk.tasks.create({
          callToken,
          label: "ComfyUI 提交 · 环境准备中",
          delivery: "next-step",
          metadata: { comfyui: { action: "submit", phase: "preparing", missing, startedAt: new Date().toISOString() } },
        });
        prepareTaskId = t && t.taskId ? String(t.taskId) : null;
        if (!prepareTaskId) taskNote = "ctx.tasks.create 未返回 taskId";
      } catch (e) {
        taskNote = `宿主任务创建失败：${msgOf(e).slice(0, 200)}`;
        warn(taskNote);
      }
    } else {
      taskNote = "无 callToken（按钮通道调用）：仅内存跟踪，准备结果不主动投递";
    }
    fire(runBootstrapContinuation({ args, context, preRef, prepareTaskId, startedAt: Date.now() }));
    warn(`submit auto 环境准备中：缺 ${missing.join("、")}（将 ${plan.join("；")}）`);
    const text = [
      `已受理提交（环境准备中）：当前缺 ${missing.join("、")}。`,
      `- 将自动准备：${plan.join("；")}——就绪后自动继续（复制副本 → 装载 → 画布执行），无需重复提交；失败会送回执说明。`,
      prepareTaskId
        ? `- 宿主任务：${prepareTaskId}（进度与结果自动回执；也可用 comfyui action=query 查看）`
        : `- 宿主任务：未创建${taskNote ? `（${taskNote}）` : ""}`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        comfyui: {
          action: "submit",
          mode: "auto",
          phase: "preparing",
          prepare: { missing, plan, taskId: prepareTaskId, taskNote: taskNote || null, startedAt: new Date().toISOString() },
        },
      },
    };
  }

  // 后台：等待环境就绪 → 重探 → 自动继续（画布五步）→ 终态结算（准备任务 complete/fail）。
  async function runBootstrapContinuation({ args, context, preRef, prepareTaskId, startedAt }) {
    let lastProgressAt = 0;
    const notify = (noteText) => {
      const now = Date.now();
      if (now - lastProgressAt < 5_000) return; // 节流：任务进度回写不刷屏
      lastProgressAt = now;
      if (!prepareTaskId) return;
      fire(sdk.tasks.update(prepareTaskId, { progress: { phase: noteText, elapsedMs: now - startedAt } }));
    };
    const settlePrepare = async (ok, text) => {
      if (!prepareTaskId) return;
      try {
        if (ok) await sdk.tasks.complete(prepareTaskId, text);
        else await sdk.tasks.fail(prepareTaskId, text);
      } catch (e) {
        warn(`准备任务结算失败（${prepareTaskId}）：${msgOf(e)}`);
      }
    };
    let outcome;
    try {
      outcome = await ensureEnvironmentPrepared({ context, onProgress: notify });
    } catch (e) {
      outcome = { ok: false, failedAt: "internal", error: msgOf(e), journal: [] };
    }
    if (!outcome.ok) {
      const text = bootstrapFailText(outcome, startedAt);
      error(`submit 环境准备失败（${outcome.failedAt}）：${outcome.error || ""}`);
      await settlePrepare(false, text);
      return;
    }
    notify("环境准备中（就绪，继续提交）");
    // 就绪自动继续：重探 → 走完 canvas 五步（probe2 复核 busy/授权，与在线路径同口径）。
    let probe2 = null;
    try { probe2 = await canvasProbe(); }
    catch (e) { probe2 = { ok: false, reason: msgOf(e) }; }
    if (!probe2 || !probe2.ok) {
      const text = `环境已就绪，但画布桥仍不可达：${probe2 ? probe2.reason || "未知" : "未知"}。可稍后重新提交（届时环境已就位，直接走画布流程）。`;
      error(`submit 环境准备链：${text}`);
      await settlePrepare(false, text);
      return;
    }
    try {
      const result = await submitCanvasFlow(args, context, probe2, preRef);
      const c = result && result.details && result.details.comfyui ? result.details.comfyui : {};
      const segs = (outcome.journal || []).map((j) => `${SEGMENT_LABEL[j.segment] || j.segment}${j.ok ? "✓" : "✗"}`).join(" ");
      const actions = (outcome.journal || []).filter((j) => j.note).map((j) => `${SEGMENT_LABEL[j.segment] || j.segment}：${j.note}`).join("；");
      const lines = [
        `环境准备完成（${segs || "无需准备"}），已自动继续画布提交。`,
        actions ? `- 动作记录：${actions}（自动动作，无需手动；同刻仅一壳页）` : "",
        c.promptId ? `- prompt_id: ${c.promptId}` : "- prompt_id: 未捕获（详见提交回执说明）",
        c.agentCopy ? `- 执行位置：画布（Agent 副本页：${c.agentCopy.name || "?"}；副驾驶已开，原布未被触碰）` : "",
        c.taskId ? `- 产物回执：由跟踪任务 ${c.taskId} 送达。` : "- 产物回执：用 comfyui action=result 取。",
      ].filter(Boolean);
      log(`submit 环境准备链完成：${segs}`);
      await settlePrepare(true, lines.join("\n"));
    } catch (e) {
      let text;
      if (e && e.code === "canvas-busy") {
        text = `环境已就绪，但画布忙（不抢占、未提交）：${msgOf(e)}`;
      } else {
        const stopped = autoStopReplyForCanvasError(e);
        const s = stopped && stopped.content && stopped.content[0] ? stopped.content[0].text : msgOf(e);
        text = `环境已就绪，继续提交被停下：\n${s}`;
      }
      warn(`submit 环境准备链：继续提交失败（${(e && e.code) || "?"}）`);
      await settlePrepare(false, text);
    }
  }

  // 准备失败 → 停下回执文本（blocked 类带阻断明细与处理指引；其余带原因与引导）
  function bootstrapFailText(outcome, startedAt) {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const at = SEGMENT_LABEL[outcome.failedAt] || outcome.failedAt || "环境";
    if (outcome.blocked) {
      return [
        `环境准备未完成（${secs}s，停在${at}）：环境检查发现 ${outcome.blockerCount} 个阻断项，已暂缓拉起（不自动清障）。`,
        ...(outcome.blockerLines || []),
        outcome.snapshotId ? `快照 snapshotId=${outcome.snapshotId}（约 180s 内有效）。` : "",
        "处理：按上方清单处理占用后重新提交即可自动续跑；或 service clear（snapshotId+pids）后重试。",
      ].filter(Boolean).join("\n");
    }
    const guideMap = {
      workspace: "（可先手动打开 Hana-ComfyUI 工作区卡片，或检查「应用能力」里 app/windows.manage 是否已授予）",
      service: "（如尚未安装 ComfyUI，可对 Hana 说「帮我安装 ComfyUI」；服务日志见工作区左侧面板）",
      relay: "（中继会自动重试；也可稍后重新提交）",
    };
    return `环境准备未完成（${secs}s，停在${at}）：${outcome.error || "未知原因"}${outcome.timeout ? "（未杀进程，可稍后重新提交）" : ""}${guideMap[outcome.failedAt] || ""}`;
  }

  // ── 工具注册 ──────────────────────────────────────────────────────────────
  function actionBranches() {
    return [
      { command: "status", required: [], fields: {} },
      {
        command: "submit",
        required: ["workflow"],
        fields: {
          workflow: {
            description: "工作流三形态：① API 格式 JSON 对象（{\"<node_id>\":{class_type,inputs}}）；② 文件路径字符串（本机 .json；API 或可转换的 UI 格式）；③ {\"template\":\"名称\"} 取 ComfyUI userdata/workflows 里保存的工作流",
            anyOf: [
              { type: "object", properties: { template: { type: "string", description: "userdata/workflows 里的相对路径或文件名" } }, required: ["template"] },
              { type: "object" },
              { type: "string" },
            ],
          },
          inputs: {
            type: "object",
            additionalProperties: true,
            description: "显式注入，键为 \"<node_id>.<input>\"（如 {\"3.seed\": 42, \"6.text\": \"a cat\"}）；节点 id 与输入名可从 action=workflows 的摘要里找",
          },
          clientLabel: { type: "string", description: "任务标签（显示在宿主任务与回执里）" },
          front: { type: "boolean", description: "true 时插队到队列最前（默认追加到队尾）" },
          mode: { type: "string", enum: ["auto", "canvas", "backend"], description: "执行位置（默认 auto）：auto=画布在线（壳页或扩展腿任一可达）且已授权时走画布（复制副本 → 装载 → 画布执行）；环境缺（中继/服务/工作区）自动自举——快返「环境准备中」→ 后台准备 → 就绪自动继续（工作区未开会自动拉起窗口；envcheck 阻断/补不上则停下报告，不自动清障）；授权缺/装载失败等停下给选项（blocked，不自动改走后台）；inline 对象 / 带 inputs 的提交按结构豁免直走后台并注明。canvas=强制画布路径（前置不满足直接报错）；backend=显式后台直提（记待同步）" },
        },
      },
      {
        command: "query",
        required: [],
        fields: {
          promptId: { type: "string", description: "按 prompt_id 查询" },
          taskId: { type: "string", description: "按宿主任务 id 查询" },
          list: { type: "boolean", description: "true 时列出最近任务与队列（不带 id 时的默认行为）" },
        },
      },
      {
        command: "result",
        required: [],
        fields: {
          promptId: { type: "string", description: "按 prompt_id 取产物" },
          taskId: { type: "string", description: "按宿主任务 id 取产物" },
          stage: { type: "boolean", description: "true 时尝试把产物注册进当前会话文件（需要相应能力，未授权时自动跳过）" },
        },
      },
      {
        command: "cancel",
        required: [],
        fields: {
          promptId: { type: "string", description: "要取消的 prompt_id" },
          taskId: { type: "string", description: "要取消的宿主任务 id（解析出 prompt_id）" },
          all: { type: "boolean", description: "显式全清：清空整个 ComfyUI 队列并全局中断（会波及其他任务，慎用）" },
        },
      },
      {
        command: "workflows",
        required: [],
        fields: {
          name: { type: "string", description: "给出则读取该工作流的节点结构摘要（id/type/title）；省略则列出 userdata/workflows 里全部已保存工作流" },
        },
      },
      {
        command: "service",
        required: [],
        fields: {
          op: { type: "string", enum: ["status", "start", "stop", "envcheck", "clear", "wait"], description: "status=查服务进程状态（默认）；start=拉起本机 ComfyUI 服务（先自动环境检查，发现阻断项时暂缓拉起并返回阻断说明）；stop=撤下服务（终止 8188 上的进程）；envcheck=环境检查（GPU 计算进程/显存水位/8188 残留 → warnings/blockers/processes/gpu/snapshotId，异常时随结果附阻断说明）；clear=清理快照内进程（需 snapshotId+pids；逐项复核，列表外全拒）；wait=等就绪（单次≤25s，轮询至 ready/timeout，不杀进程）" },
          path: { type: "string", description: "start 可选：指定 ComfyUI 安装根（默认用本机安装探测结果）" },
          snapshotId: { type: "string", description: "clear 用：service envcheck 返回的一次性快照 id（约 180s 内有效；过期会全部拒绝）" },
          pids: { type: "array", items: { type: "number" }, description: "clear 用：要清理的进程 pid 数组（必须都在快照内；不在快照/不可清理项会被拒绝）" },
        },
      },
      {
        command: "upload",
        required: ["path"],
        fields: {
          path: { type: "string", description: "本机图片文件绝对路径（png/jpg/webp/gif/bmp）" },
          subfolder: { type: "string", description: "上传到 input 的子目录（可选）" },
          overwrite: { type: "boolean", description: "true 时覆盖同名文件" },
        },
      },
      {
        command: "update",
        required: [],
        fields: {
          op: { type: "string", enum: ["check", "apply", "status"], description: "check=检查更新（与远端比 commit，默认）；apply=执行更新（停服务 → git pull --ff-only → pip install -r requirements.txt，后台跑）；status=查更新进度" },
        },
      },
      {
        command: "canvas",
        required: [],
        fields: {
          op: {
            type: "string",
            enum: [
              "pages",
              "state",
              "summary",
              "get",
              "check",
              "trace",
              "outline",
              "diff",
              "prompt",
              "running",
              "progress",
              "probe",
              "revision",
              "events",
              "frameReload",
              "commands",
              "commandShape",
              "loadWorkflowFile",
              "openWorkflow",
              "activateWorkflow",
              "setWidget",
              "addNode",
              "removeNode",
              "connect",
              "disconnect",
              "setNodeMode",
              "addGroup",
              "setGroup",
              "removeGroup",
              "save",
              "undo",
              "patch",
              "organize",
              "queue",
              "duplicate",
              "visual",
              "copilot",
            ],
            description:
              "读/改人正在看的同一张画布。读：pages=在线页面清单（各自开的哪个工作流）；state=最近快照（默认，零往返）；summary=现抓摘要；get=全量 UI JSON（select/fields 投影裁剪）；check=体检（悬空/未接/mute·bypass；rules 可裁剪/扩展）；trace=追踪端口来源/去向（multi 多级链）；outline=大纲（功能块+块间连线；detail=nodes 可下钻）；diff=两文件语义 diff（source=file；path=基准、pathB=目标）；prompt=可提交形态；running=当前执行节点；progress=执行进度聚合（只读：执行中？/当前节点/画布节点数/队列剩余/promptId）；probe=桥自检；revision=变更序号；events=变更记录；commands=列前端已注册命令 id；commandShape=命令表形状（自检）；frameReload=重载内层 iframe（扩展换文件后用）。写（需授权；v2 硬约束：未开副驾驶的画布上仅可打开 / 复制 / 落盘）：setWidget=改参数；addNode=加节点；removeNode=删节点；connect=连线；disconnect=断线；setNodeMode=mute/bypass；addGroup=新建分组（title 必填；nodeIds 自动算框含外扩 20，bounds 显式优先）；setGroup=改组（index|title 定位，改标题/重算框）；removeGroup=删组（不动节点）；save=落盘为工作流文件；undo=撤销 agent 上一步；patch=意图级写（多编辑一次提交：edits、$引用、原子回滚、verify/dryRun）；loadWorkflowFile=按路径装载工作流（绕过前端列表）；openWorkflow=打开已保存工作流并完整装载（切前台+重绘，pending 落定校验；自带未保存保护，需授权）；activateWorkflow=把已打开的目标工作流切成前台（轻量切标签，不重载、不丢数据；目标未打开则报错，需授权）；organize=调前端已注册命令（默认自动排布）；queue=执行当前画布（等效点 Queue，快返；front 插队首）；duplicate=复制当前画布为新页（原布零改动，返回新页 page/key）；visual=锁与高亮（visualAction=lock/highlight/clear）；copilot=开关当前画布副驾驶（enabled=true/false；Agent 开启受「允许 Agent 开启画布副驾驶」总闸管辖）。source=file=对工作流 JSON 文件操作（path：绝对路径或相对工作流目录 user/default/workflows；读类 op 免画布免授权、patch 为文件版事务〔写盘+自动 .bak、dryRun/verify〕；其余 op 不支持）。多页面时用 workflow 参数定向（不传则广播）",
          },
          workflow: { type: "string", description: "多页面定向：只发给正打开这个工作流名的页面（不传则广播给所有页面）；亦兼作 activateWorkflow 的定向目标（指定要切到前台的工作流）" },
          select: { type: "string", description: "投影过滤：只保留匹配节点（#8 / #8,#27 / type=PrimitiveInt / title~尺寸 / 邻接 #8/up、#8/down〔≤跳数，含自身，#8/up:2 限 2 跳〕，逗号分隔取并集）；与 fields 搭配替代全量 get" },
          fields: { type: "string", description: "投影过滤：节点字段白名单（title,type,mode,inputs,outputs,widgets_values,pos,size，逗号分隔）；id 始终保留" },
          nodeId: { type: "string", description: "目标节点 id（canvas get/state/summary 里的 \"#<id>\"，setWidget/removeNode/connect/trace 等用）" },
          name: { type: "string", description: "setWidget 用参数名；save 用工作流名（省略则用当前工作流）" },
          value: { description: "setWidget 用：新值（数字/字符串/布尔，按参数类型给）" },
          type: { type: "string", description: "addNode 用：节点类型（如 KSampler / CLIPTextEncode / EmptyLatentImage）" },
          pos: { type: "array", items: { type: "number" }, description: "addNode 用：画布坐标 [x, y]（可选）" },
          title: { type: "string", description: "addNode 用：节点标题（可选）；addGroup 用：分组标题（必填）；setGroup 用：新标题（可选）" },
          nodeIds: { type: "array", items: { type: "string" }, description: "addGroup/setGroup 用：节点 id 列表（给定时自动算外接矩形、外扩 20）" },
          index: { type: "number", description: "setGroup/removeGroup 用：分组在 graph.groups 中的下标（0 基）" },
          bounds: { type: "array", items: { type: "number" }, description: "addGroup/setGroup 用：显式矩形 [x, y, w, h]（给了优先于 nodeIds 自动算）" },
          color: { type: "string", description: "addGroup 用：分组颜色（可选，色值字符串）" },
          fromNode: { type: "string", description: "connect 用：源节点 id" },
          fromSlot: { description: "connect 用：源输出槽（名字或索引）" },
          toNode: { type: "string", description: "connect 用：目标节点 id" },
          toSlot: { description: "connect 用：目标输入槽（名字或索引）" },
          slot: { description: "disconnect/trace 用：槽（名字或索引）" },
          dir: { type: "string", enum: ["up", "down"], description: "trace 用：up=直接来源（默认）/ down=直接去向" },
          mode: { type: "number", enum: [0, 2, 4], description: "setNodeMode 用：0=正常 / 2=mute / 4=bypass" },
          edits: {
            type: "array",
            description: "patch 用：编辑数组（顺序执行，原子回滚）。每条恰一个 key，可用：addNode / setWidget / connect / disconnect / setNodeMode / removeNode / save（save 仅限最后一条）。source=file 时另支持：addGroup{title,nodeIds?,bounds?} / setGroup{index|title,(title|nodeIds)} / removeGroup{index|title} / cloneNodes{nodeIds,offset?|position?}；save=写盘（仅末条、缺省自动）。示例：[{\"disconnect\":{\"nodeId\":8,\"slot\":\"width\"}},{\"addNode\":{\"type\":\"PrimitiveInt\",\"title\":\"宽度\",\"as\":\"w\"}},{\"setWidget\":{\"nodeId\":\"$w\",\"name\":\"value\",\"value\":1248}},{\"connect\":{\"fromNode\":\"$w\",\"fromSlot\":\"INT\",\"toNode\":8,\"toSlot\":\"width\"}},{\"save\":{}}]",
          },
          verify: { type: "boolean", description: "patch 用：执行后逐条对照终态（默认 true）；source=file 时＝应用后结构自检（+默认复跑 check 对比新增 issue）" },
          dryRun: { type: "boolean", description: "patch 用：只做预检、零图变更（默认 false）；输出逐条 checks；source=file 时＝内存模拟全批校验、不落盘" },
          page: { type: "string", description: "目标页定向（页 path/key；部分 op 支持，如 loadWorkflowFile 装载到指定页）" },
          front: { type: "boolean", description: "queue 用：true 插队首（默认队尾）" },
          visualAction: { type: "string", enum: ["lock", "highlight", "clear"], description: "visual 用：lock=置锁变灰 / highlight=黄标（撤锁后标 nodes）/ clear=全撤" },
          nodes: { type: "array", items: { type: "string" }, description: "visual highlight 用：要黄标的节点 id 列表" },
          edges: { type: "array", items: { type: "array", items: { type: "string" } }, description: "visual highlight 用：要黄标的连线 [fromNodeId, toNodeId] 列表" },
          note: { type: "string", description: "visual 用：备注（显示在锁提示里）" },
          enabled: { type: "boolean", description: "copilot 用：true=开启当前画布副驾驶 / false=关闭（Agent 开启受「允许 Agent 开启画布副驾驶」总闸管辖）" },
          source: { type: "string", enum: ["live", "file"], description: "数据来源：live=人眼前画布（默认，行为不变）；file=工作流 JSON 文件（读类 op：get/check/outline/trace/summary 免画布免授权；patch=文件版事务：内存全应用→写盘+自动 .bak，dryRun/verify 同族；其余 op 不支持）。配合 path 使用" },
          path: { type: "string", description: "source=file 用：工作流 JSON 文件路径——绝对路径，或相对 ComfyUI 工作流目录（user/default/workflows）解析；目录外路径拒绝。写回保持原文件格式；写盘前自动生成 <名>.bak.json（旧内容）" },
          verifyCheck: { type: "boolean", description: "source=file patch 用：verify 时复跑 check 并把新增 issue 放进 verify.check（默认 true；只报告、不判败）" },
          rules: { description: "check 用（可选）：规则集——逗号分隔字符串或字符串数组。可用 id：dangling / output_unwired / missing_required / muted_bypassed / domain_div16 / domain_steps_range / domain_save_name / domain_denoise_range；组记号：core（核心三码，缺省）/ domain / all。含 missing_required 或 all 时会尽力自动拉取 object_info（拉不到自动降级并在 warnings 标注）" },
          detail: { type: "string", enum: ["blocks", "nodes"], description: "outline 用：blocks=块级大纲（缺省）/ nodes=块下钻（配合 block，节点级视图）" },
          block: { type: "string", description: "outline 用（detail=nodes 时）：块选择——块名或 #<n>（1 基序号，按 blocks 顺序），逗号分隔取并集；缺省=全部块" },
          multi: { type: "boolean", description: "trace 用：true=返回多级完整链（path[]）；缺省单步（与旧版一致）" },
          depth: { type: "number", description: "trace 用：多级链深度上限（1..1000 整数，缺省 10；给出即启用多级）" },
          pathB: { type: "string", description: "diff 用（source=file）：目标文件路径（path=基准、pathB=目标；相对工作流目录或绝对路径）" },
        },
      },
      {
        command: "window",
        required: [],
        fields: {
          op: { type: "string", enum: ["open", "close", "status"], description: "open=打开宿主原生窗装载工作区（/workspace.html；需能力 app/windows.manage；壳页桥单桶，同刻仅一壳页；提交自举在环境缺时会自动拉起它）；close=关闭窗口（默认关最近一次 open 的；可传 windowId）；status=列出本 App 已开窗口（默认）" },
          windowId: { type: "string", description: "close 用：目标窗口 id（aw_*，来自 op=status / op=open 返回；省略则关最近一次打开的工作区窗）" },
        },
      },
    ];
  }

  try {
    const branches = actionBranches();
    await sdk.tools.register({
      name: "comfyui",
      description:
        "Hana-ComfyUI：操作本机 ComfyUI（127.0.0.1:8188）的工具（一个 App 一个同名工具，action 选动作）。" +
        "status=服务/中继/队列/运行中任务聚合（含四态环境诊断）；submit=提交工作流（三形态：API 格式 JSON 对象 / 文件路径 / {template:\"名称\"}；inputs 注入 \"<node_id>.<input>\"; clientLabel 标签；front 插队；mode=auto|canvas|backend 选执行位置——默认 auto：画布在线且已授权时复制副本-装载-画布执行（canvas.queue）；环境缺（中继/服务/工作区）自动自举：快返「环境准备中」→ 后台准备（服务拉起/必要时自动拉起工作区窗口）→ 就绪自动继续；阻断/补不上/授权缺停下（blocked：原因+选项，不自动改走后台）；inline 对象/带 inputs 结构豁免直走后台并注明）→ 返回 prompt_id，后台自动跟踪并在完成时按 next-step 回执；" +
        "query=按 prompt_id/taskId 查任务或列最近；result=取产物（本地路径+预览 URL，可选入会话文件）；cancel=定向取消（all:true 才全清）；service=ComfyUI 服务进程起停与环境检查（op=status/start/stop/envcheck/clear/wait：start 自动先 envcheck，异常时返回阻断说明；envcheck=检查 GPU 占用/端口残留；clear=按快照清理进程（snapshotId+pids）；wait=轮询就绪，单次≤25s）——服务由计划任务拉起，独立于 Hana 存活；workflows=列出/读取已保存工作流的节点结构；upload=上传图片（图生图输入）；" +
        "update=ComfyUI 本体更新（op=check 检查 / apply 执行 / status 查进度；仅源码安装支持，走 git pull --ff-only + pip install -r requirements.txt，更新前自动停服务，完成后需重新启动服务）；" +
        "canvas=读/改人正在看的同一张画布（读：pages 在线页面清单 / state 最近快照（默认，零往返）/ summary 现抓摘要 / get 全量 UI JSON（select/fields 投影裁剪）/ check 体检（悬空/未接/mute·bypass；rules 可裁剪/扩展）/ trace 追踪端口来源/去向（multi 多级链）/ outline 大纲（功能块+块间连线；detail 下钻）/ diff 两文件语义 diff（source=file；path 基准/pathB 目标）/ prompt 可提交形态 / running 当前执行节点 / progress 执行进度聚合（只读：执行中？/当前节点/画布节点数/队列剩余/promptId）/ probe 桥自检 / revision 变更序号 / events 变更记录；写：setWidget 改参数 / addNode 加节点 / removeNode 删节点 / connect 连线 / disconnect 断线 / setNodeMode mute或bypass / addGroup 新建分组（nodeIds 自动算框）/ setGroup 改组（改名/重算框）/ removeGroup 删组（不动节点）/ save 落盘 / undo 撤销 agent 上一步 / patch 意图级写（多编辑一次提交：edits、$引用、原子回滚、verify/dryRun）/ loadWorkflowFile 按路径装载 / openWorkflow 打开并完整装载（切前台+重绘）/ organize 排布命令 / queue 画布执行（快返，接宿主任务卡）/ duplicate 复制画布为新页 / visual 锁与高亮（visualAction）/ copilot 开关画布副驾驶（受「允许 Agent 开启画布副驾驶」总闸管辖）；source=file 对工作流 JSON 文件操作：读类 op 免画布免授权、patch 为文件版事务〔写盘+自动 .bak；path 相对工作流目录 user/default/workflows 或绝对路径〕）——写入类 op 需用户在设置页开启「允许 agent 修改画布」且需 ComfyUI 页面在线（壳页或桥扩展腿任一可达即可）；v2 硬约束：未开副驾驶的画布上写类 op 被拒（仅可打开/复制/落盘），开副驾驶由用户在画布顶栏开启或授权后由 agent 用 op=copilot 开启；agent 的改动要用 op=undo 撤（新版前端的 Ctrl+Z 撤不掉外部改动）。快照由前端在画布变化后主动推、缓在 ComfyUI 侧，所以 ComfyUI 页面没开着也能拿到上次状态；页面从未打开过时用 op=summary 现抓（需先部署 custom_nodes/hana_bridge 并启动服务）。" +
        "window=工作区原生窗：op=open 打开宿主原生窗装载工作区（/workspace.html；需能力 app/windows.manage；窗口页自取 surface 凭据；壳页桥为单桶——同刻仅一壳页，开窗前建议先关掉其它工作区壳页）/ op=status 列出本 App 已开窗口（默认）/ op=close 关闭窗口（默认关最近一次打开的，可传 windowId）。提交环境缺时自举链也会自动拉起该窗（同刻仅一壳页；无需手动）。" +
        "提交即返回（回合纪律：不要在提交后原地等待；进度用 query 查看）。完整手册见 SKILL: skills/comfyui-hana/SKILL.md",
      parameters: {
        type: "object",
        oneOf: branches.map((b) => ({
          type: "object",
          additionalProperties: false,
          required: ["action", ...b.required],
          properties: {
            action: { const: b.command, description: `动作：${b.command}` },
            ...b.fields,
          },
        })),
      },
      sessionPermission: { readOnly: false },
      execute: async (input) => {
        const args = input && typeof input === "object" ? input : {};
        const context = args.context && typeof args.context === "object" ? args.context : {};
        const action = String(args.action || "").trim();
        try {
          switch (action) {
            case "status": {
              maybeBackfillPendingCanvas("status");
              const snap = state.snapshot;
              const capsMap = await capabilitiesMap();
              const capOf = (w) => (capsMap ? (capsMap[w] || "not_asked") : "unknown");
              // B 主链：四态统一出口（中继/服务/页面/授权）——与 submit auto 共用 diagnoseEnvironment；
              // 此处 deep：主动探一次两腿（8s 压时；页面没开时扩展腿 ~6s 内回「没有页面」）。
              const envDiag = await diagnoseEnvironment({ deep: true, timeoutMs: 8_000 });
              return {
                content: [{ type: "text", text: statusText(envDiag) + `\n- 能力账本：${CAP_TASKS}=${capOf(CAP_TASKS)} · ${CAP_START_TURN}=${capOf(CAP_START_TURN)} · ${CAP_STAGE_FILE}=${capOf(CAP_STAGE_FILE)}` }],
                details: {
                  comfyui: {
                    action: "status",
                    phase: state.phase,
                    runtimeId: state.runtimeId,
                    servicePort: state.servicePort,
                    proxyPrefix: proxyPrefix(),
                    backendUrl: `http://${BACKEND.host}:${BACKEND.port}`,
                    backend: snap && snap.relay ? snap.relay.backend : null,
                    queue: snap && snap.relay ? snap.relay.queue : null,
                    events: snap && snap.relay ? snap.relay.events : null,
                    requests: snap && snap.relay ? snap.relay.requests : null,
                    jobs: jobsSummary(),
                    env: envDiag,
                    capabilities: {
                      [CAP_TASKS]: capOf(CAP_TASKS),
                      [CAP_START_TURN]: capOf(CAP_START_TURN),
                      [CAP_STAGE_FILE]: capOf(CAP_STAGE_FILE),
                    },
                    relayError: snap ? snap.error : null,
                    snapshotAt: snap ? new Date(snap.at).toISOString() : null,
                    error: state.lastError ? { code: state.lastError.code, userText: state.lastError.userText } : null,
                  },
                },
              };
            }
            case "submit": return await actionSubmit(args, context);
            case "query": return await actionQuery(args);
            case "result": return await actionResult(args, context);
            case "cancel": return await actionCancel(args);
            case "workflows": return await actionWorkflows(args);
            case "service": return await actionService(args, context);
            case "update": return await actionUpdate(args, context);
            case "canvas": return await actionCanvas(args, context);
            case "window": return await actionWindow(args, context);
            case "upload": return await actionUpload(args);
            default:
              throw new Error(`action 必须是 status / submit / query / result / cancel / workflows / upload / service / update / canvas / window（收到 "${action}"）`);
          }
        } catch (e) {
          const text = `comfyui(${action || "?"}) 失败：${msgOf(e)}`;
          error(text);
          return { content: [{ type: "text", text }], details: { comfyui: { action, ok: false, error: msgOf(e) } } };
        }
      },
    });
    log("工具注册：comfyui（v0.3：status/submit/query/result/cancel/workflows/upload/service/update/canvas/window）");
  } catch (e) {
    error(`工具注册失败：${msgOf(e)}`);
  }

  // ── 路由面 ────────────────────────────────────────────────────────────────
  try {
    await sdk.routes.register((app) => {
      app.get("/comfyui-hana/boot-state", (c) => {
        try { return c.json(bootState()); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/comfyui-hana/status", (c) => {
        try { maybeBackfillPendingCanvas("status-route"); return c.json(fullStatus()); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/comfyui-hana/health", (c) => c.json({ ok: true, app: { id: APP_ID, version: APP_VERSION }, ts: new Date().toISOString() }));

      // ── TODO 节流探针实验（临时代码，验证完按结论处理）────────────────────────
      // 「网络直采」通道（hui 页 → 后端报数，数据必达）：页面每 10s POST {t, n, vis}
      //（页面侧见 app/ui/workspace.js 的 setupThrottleProbe 网络直采段），本路由把一行 JSON
      // append 到 join(dataDir, "keepalive-probe", "hui-page-pulse.jsonl")（目录不存在则建）。
      // 不依赖 state 通道读回：页面被 Chromium 节流时落盘节奏会直接变稀/停摆，读该文件即可判定。
      // 摘除：删除本路由 + 页面侧上报段（setupThrottleProbe）。
      app.post("/comfyui-hana/keepalive-probe-ping", async (c) => {
        let t = null, n = null, vis = null; // TODO 实验：容错解析——缺字段/畸形 body 一律记 null
        try {
          const body = await c.req.json().catch(() => ({}));
          const src = body && typeof body === "object" ? body : {};
          if (typeof src.t === "number" && Number.isFinite(src.t)) t = src.t;
          if (typeof src.n === "number" && Number.isFinite(src.n)) n = src.n;
          if (typeof src.vis === "string") vis = src.vis;
        } catch { /* 忽略：按 null 落盘 */ }
        try { // TODO 实验：append 落盘（目录不存在则建）；写失败不影响响应
          const dir = join(dataDir, "keepalive-probe");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "hui-page-pulse.jsonl"), JSON.stringify({ t, n, vis }) + "\n", { flag: "a" });
        } catch { /* 忽略 */ }
        return c.json({ ok: true });
      });

      // 主机指标（GPU / CPU / 内存）：中继侧采集（nvidia-smi + os 模块），面板图表数据源
      app.get("/comfyui-hana/metrics", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/metrics", { timeoutMs: 8_000 });
          return c.json(ok && data && typeof data === "object" ? data : { ok: false, error: `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      // 释放显存：让 ComfyUI 后端卸载全部模型（POST /free），中继原样反代
      app.post("/comfyui-hana/release", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/free", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
            timeoutMs: 15_000,
          });
          void refreshSnapshot(); // 让状态/图表尽快反映卸载后的显存变化
          return c.json({ ok, status, backend: data }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      // 安装位置候选（盘位探测 + 当前自定义位置）
      app.get("/comfyui-hana/install-targets", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/drives", { timeoutMs: 8_000 });
          const base = ok && data && typeof data === "object" ? data : { ok: false, error: `relay HTTP ${status}` };
          return c.json({ ...base, custom: readInstallTarget().path }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      // 设置 / 清除自定义安装位置（持久化 + 立即推给中继）
      app.post("/comfyui-hana/install-target", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const raw = typeof body.path === "string" ? body.path.trim() : "";
          if (raw && !/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("/")) {
            return c.json({ ok: false, error: "需要绝对路径（如 D:\\ComfyUI）" }, 400);
          }
          if (!writeInstallTarget(raw || null)) return c.json({ ok: false, error: "写入失败" }, 500);
          await syncCustomRoots(true);
          return c.json({ ok: true, custom: raw || null });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      // 说明页「已看过」标记（持久化在 app-data；文件缺失/损坏按未看过处理）
      app.get("/comfyui-hana/intro", (c) => {
        try {
          const s = readIntroState();
          return c.json({ ok: true, seen: s.seen, optOut: s.optOut });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/comfyui-hana/intro", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const cur = readIntroState();
          const src = body && typeof body === "object" ? body : {};
          const seen = typeof src.seen === "boolean" ? src.seen : cur.seen;
          const optOut = typeof src.optOut === "boolean" ? src.optOut : cur.optOut;
          if (!writeIntroState(seen, optOut)) return c.json({ ok: false, error: "写入失败" }, 500);
          return c.json({ ok: true, seen, optOut });
        } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      // 服务自动拉起开关（持久化；开关详情见 maybeAutoStartBackend）
      app.get("/comfyui-hana/auto-start", (c) => {
        try { return c.json({ ok: true, enabled: readAutoStart() }); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/comfyui-hana/auto-start", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          if (!writeAutoStart(body.enabled === true)) return c.json({ ok: false, error: "写入失败" }, 500);
          return c.json({ ok: true, enabled: readAutoStart() });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      // ── 出图实时预览设置（2026-10-13）─────────────────────────────────────
      // 两级档位：basic=latent2rgb（免下载）/ hd=taesd（需 vae_approx/taeqi2_1_decoder*）。
      // 真相源在本 App 的 preview-settings.json；生效值经中继 /_relay/preview-config 下发。
      // 中继未就绪不报错：存盘成功、标记 pushed:false，待中继就绪后 UI 再发一次即可补推。
      app.get("/comfyui-hana/preview-settings", async (c) => {
        try {
          const s = readPreviewSettings();
          const relay = await relayPreviewRead();
          return c.json({ ok: true, enabled: s.enabled, tier: s.tier, relay });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      app.post("/comfyui-hana/preview-settings", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const cur = readPreviewSettings();
          const enabled = body && typeof body.enabled === "boolean" ? body.enabled : cur.enabled;
          const tier = body && PREVIEW_TIERS.includes(body.tier) ? body.tier : cur.tier;
          if (!writePreviewSettings({ enabled, tier })) return c.json({ ok: false, error: "写入失败" }, 500);
          const method = tierToMethod(tier);
          const { pushed, error } = await relayPreviewPush(enabled, method);
          log(`出图预览设置：enabled=${enabled} tier=${tier} method=${method} pushed=${pushed}${error ? ` (${error})` : ""}`);
          if (!pushed) {
            return c.json({ ok: true, pushed: false, enabled, tier, note: "中继未就绪，设置已存，待就绪后生效" });
          }
          const relay = await relayPreviewRead();
          return c.json({ ok: true, pushed: true, enabled, tier, relay });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      // HD 档解码器下载（app 侧不能自发下载：见下方 needAgent 回执的实测依据）。
      // app 若要直接取文件，需要：① 清单 network.allowedHosts 声明外部主机（现仅 127.0.0.1）；
      // ② 写入 ComfyUI 安装目录（app 数据目录之外）的写权限/代理通道。两条都缺，故不做，直报 needAgent。
      app.post("/comfyui-hana/preview-model/download", (c) => {
        const base = comfyBase();
        return c.json({
          ok: false,
          needAgent: true,
          filename: PREVIEW_HD_FILENAME,
          targetDir: base ? join(base, "models", "vae_approx") : null,
          sources: [
            { name: "GitHub raw（上游，已实测 200 / 15,314,938 B）", url: `https://raw.githubusercontent.com/madebyollin/taesd/main/${PREVIEW_HD_FILENAME}` },
            { name: "jsdelivr（GitHub 镜像，已实测 200）", url: `https://cdn.jsdelivr.net/gh/madebyollin/taesd@main/${PREVIEW_HD_FILENAME}` },
            // 注：hf-mirror.com 上无 madebyollin/taesd 该路径（实测 404），不要写镜像仓路径当必然存在。
            // HF 备选是 diffusers 格式 .safetensors，键名与 ComfyUI TAESD state_dict 不一致，未经转换不可用。
            { name: "HuggingFace（备选，需转换/验证）", url: "https://huggingface.co/madebyollin/taeqi2_1/resolve/main/taeqi2_1.safetensors", caution: "diffusers 格式，键名非 ComfyUI TAESD；优先用上面两个 .pth" },
          ],
          note: "请由 agent 用 hana-downloader 下载到 targetDir",
        });
      });

      // 安装提示词（供前端「复制安装指令」；模板在后端单点维护）
      app.get("/comfyui-hana/install-prompt", (c) => {
        const path = String(c.req.query("path") || "").trim();
        if (!path) return c.json({ ok: false, error: "需要 ?path=<安装位置>" }, 400);
        return c.json({ ok: true, path, prompt: buildInstallPrompt(path) });
      });

      // 直接发起安装：在默认工作区 / 默认 agent 下建会话并投递安装提示词
      app.post("/comfyui-hana/install-launch", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const path = typeof body.path === "string" ? body.path.trim() : "";
          if (!path) return c.json({ ok: false, error: "缺少 path" }, 400);
          writeInstallTarget(path); // 记住位置：装完能被自动发现
          await syncCustomRoots(true);
          const prompt = buildInstallPrompt(path);
          const created = await sdk.sessions.create({});
          const sessionId = (created && (created.sessionId || (created.sessionRef && created.sessionRef.sessionId))) || null;
          if (!sessionId) return c.json({ ok: false, error: "会话创建返回异常", created }, 502);
          await sdk.sessions.send({ sessionId, text: prompt });
          log(`安装会话已创建 | sessionId=${sessionId} | target=${path}`);
          return c.json({ ok: true, sessionId, sessionPath: created.sessionPath || null, path });
        } catch (e) {
          error(`install-launch 失败：${msgOf(e)}`);
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

  
    app.post("/comfyui-hana/shell/hello", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        shellBridge.lastSeenAt = Date.now();
        shellBridge.lastHello = body && typeof body === "object" ? body : {};
        return c.json({ ok: true, alive: true });
      } catch (e) {
        return c.json({ ok: false, error: msgOf(e) }, 500);
      }
    });

    app.get("/comfyui-hana/shell/poll", (c) => {
      shellBridge.lastSeenAt = Date.now();
      const ops = shellBridge.queue.splice(0, 20);
      return c.json({ ok: true, ops, count: ops.length });
    });

    app.post("/comfyui-hana/shell/result", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const rid = String((body && body.rid) || "");
        shellBridge.lastSeenAt = Date.now();
        const slot = shellBridge.pending.get(rid);
        if (slot) {
          shellBridge.pending.delete(rid);
          clearTimeout(slot.timer);
          slot.resolve({ ok: body.ok !== false, data: body.data, error: body.error });
        }
        return c.json({ ok: true, matched: !!slot });
      } catch (e) {
        return c.json({ ok: false, error: msgOf(e) }, 500);
      }
    });

    app.get("/comfyui-hana/shell/status", (c) => {
      maybeBackfillPendingCanvas("shell/status");
      return c.json({
        ok: true,
        alive: shellAlive(),
        lastSeenAgoMs: shellBridge.lastSeenAt ? Date.now() - shellBridge.lastSeenAt : null,
        queued: shellBridge.queue.length,
        inflight: shellBridge.pending.size,
        hello: shellBridge.lastHello,
      });
    });

    // 重载工作区（2026-10-12）：宿主左侧栏面板（ui/panel.html，functionPanel 实例）与整页工作区
    // （ui/workspace.html）是两个页面实例，面板够不到工作区内层 ComfyUI iframe。此路由只做转发：
    // 把 { op:"frame.reload" } 塞进壳页桥队列 → 工作区壳页 shellTick() 经 /comfyui-hana/shell/poll
    // 轮询取走并执行（workspace.js shellOp("frame.reload") → requestFrameReload，与原有 op 同一条路）。
    // 不登记 pending（调用方不需要结果）：壳页回帖 /shell/result 时匹配不到，matched:false，无害。
    // 壳页不在线（工作区未打开）→ 409 如实回报，不硬凑。
    app.post("/comfyui-hana/shell/reload", (c) => {
      if (!shellAlive()) return c.json({ ok: false, error: "shell-not-alive" }, 409);
      const rid = `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      shellBridge.queue.push({ rid, op: "frame.reload", args: {} });
      return c.json({ ok: true, rid, queued: shellBridge.queue.length });
    });

    // 画布桥（只读）：读人正在看的同一张图（op 走 ?op= 或 JSON body）
      const canvasRoute = async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!body || typeof body !== "object") body = {};
          const op = String(c.req.query("op") || body.op || "").trim();
          // 关键：args 必须原样传给 actionCanvas。
          // 此前这里把整个 body 丢了、只传 op，导致所有带参数的画布操作
          // （setWidget / addNode / loadWorkflowFile …）拿到的是空参数。
          const args = (body.args && typeof body.args === "object") ? body.args : {};
          const merged = Object.assign({}, args, body);
          delete merged.args;
          merged.op = op || "state";
          return c.json(await actionCanvas(merged, null));
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      };
      app.get("/comfyui-hana/canvas", canvasRoute);
      app.post("/comfyui-hana/canvas", canvasRoute);

      // 画布移交（2026-10-09）：外开窗口 → 主工作区。op=write / peek / clear / take / close-window。
      // 只服务本 App 壳页（窗口页/卡页直连本路由；非工具面动作，不进 comfyui 工具）。
      const handoffHttp = async (c) => {
        try {
          let body = {};
          try { body = await c.req.json(); } catch { body = {}; }
          if (!body || typeof body !== "object") body = {};
          const op = String(c.req.query("op") || body.op || "peek").trim();
          return c.json(await actionHandoff(op, body));
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      };
      app.get("/comfyui-hana/handoff", handoffHttp);
      app.post("/comfyui-hana/handoff", handoffHttp);

      // 画布写入授权开关（默认关）：agent 改画布前必须先得到明确允许
      app.get("/comfyui-hana/allow-write", (c) => {
        try { return c.json({ ok: true, enabled: readAllowWrite() }); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/comfyui-hana/allow-write", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          if (!writeAllowWrite(body.enabled === true)) return c.json({ ok: false, error: "写入失败" }, 500);
          log(`画布写入授权：${readAllowWrite() ? "已开启" : "已关闭"}`);
          return c.json({ ok: true, enabled: readAllowWrite() });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      // 副驾驶总闸（默认关；v2 2026-10-08）：允许 Agent 开启画布副驾驶——设置页新开关（即时生效）
      app.get("/comfyui-hana/allow-copilot", (c) => {
        try { return c.json({ ok: true, enabled: readAllowCopilot() }); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.post("/comfyui-hana/allow-copilot", async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          if (!writeAllowCopilot(body.enabled === true)) return c.json({ ok: false, error: "写入失败" }, 500);
          log(`画布副驾驶总闸：${readAllowCopilot() ? "已开启" : "已关闭"}`);
          return c.json({ ok: true, enabled: readAllowCopilot() });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      app.post("/comfyui-hana/relay/start", (c) => {
        if (state.phase === "ready") return c.json({ ok: true, accepted: false, reason: "already-ready", phase: state.phase });
        if (state.phase === "starting") return c.json({ ok: true, accepted: false, reason: "starting", phase: state.phase });
        Promise.resolve()
          .then(() => ensureManagedRuntime())
          .then(() => log("relay/start 触发启动完成（中继就绪）"))
          .catch((e) => warn(`relay/start 失败：${msgOf(e)}`));
        return c.json({ ok: true, accepted: true, phase: state.phase }, 202);
      });

      // ── ComfyUI 服务进程（启动 / 停止）──────────────────────────────────
      // 与上面的 relay/start 是两件事：relay/start 只重启本 App 的「中继」（受管 runtime，
      // 随 Hana 生命周期）；这里的 start/stop 管的是 8188 上的 ComfyUI 本体，由计划任务拉起，
      // 独立于 Hana 存活。具体机制见 runtime/comfy-relay.mjs 的「服务进程管理」区。
      app.post("/comfyui-hana/backend/start", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const body = await c.req.json().catch(() => ({}));
          const path = typeof body.path === "string" && body.path.trim() ? body.path.trim() : null;
          const { ok, status, data } = await relayJson("/_relay/backend/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(path ? { path } : {}),
            timeoutMs: 25_000,
          });
          if (ok) void refreshSnapshot();
          const out = data && typeof data === "object" ? data : { ok, status };
          return c.json(out, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/comfyui-hana/backend/stop", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/backend/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            timeoutMs: 25_000,
          });
          void refreshSnapshot();
          const out = data && typeof data === "object" ? data : { ok, status };
          return c.json(out, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      // 环境检查 / 快照清理 / 等待就绪（卡片功能恢复，2026-10-09）：环境检查卡的按钮直接 POST 的入口。
      // 语义同工具 service 的 envcheck/clear/wait op；转发到中继 /_relay/backend/{envcheck,clear,wait}，
      // 经 relayJson → x-comfy-relay-key（controlKey）管理；宿主侧由 surface 凭据（app_route）保护。
      app.post("/comfyui-hana/backend/envcheck", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/backend/envcheck", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            timeoutMs: 30_000,
          });
          return c.json(ok && data && typeof data === "object" ? data : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/comfyui-hana/backend/clear", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const body = await c.req.json().catch(() => ({}));
          const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId.trim() : "";
          const pids = Array.isArray(body.pids) ? body.pids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0) : [];
          if (!snapshotId || !pids.length) return c.json({ ok: false, error: "需要 {snapshotId, pids[]}（快照来自 envcheck；列表外/不可清理项会被中继拒绝）" }, 400);
          const { ok, status, data } = await relayJson("/_relay/backend/clear", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ snapshotId, pids }),
            timeoutMs: 30_000,
          });
          if (ok) void refreshSnapshot();
          return c.json(ok && data && typeof data === "object" ? data : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/comfyui-hana/backend/wait", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/backend/wait", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            timeoutMs: 30_000,
          });
          if (ok) void refreshSnapshot();
          return c.json(ok && data && typeof data === "object" ? data : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.get("/comfyui-hana/backend", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/backend/proc", { timeoutMs: 8_000 });
          const out = data && typeof data === "object" ? data : { ok, status };
          return c.json(out, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      // 任务卡数据源（卡片功能恢复，2026-10-09）：按 cardId（宿主铸造的卡实例 id，卡页 surface 上下文）
      // 或 id（promptId/taskId，调试/兼容）查任务；卡片 route 静态（/task.html），身份经 cardId 反查。
      app.get("/comfyui-hana/task", async (c) => {
        try {
          const cardId = String(c.req.query("cardId") || "").trim();
          const id = String(c.req.query("id") || "").trim();
          if (!cardId && !id) return c.json({ ok: false, error: "需要 ?cardId=<卡片实例 id> 或 ?id=<promptId 或 taskId>" }, 400);
          const job = cardId ? await findJobByCardId(cardId) : await findJobById(id);
          if (!job) return c.json({ ok: true, found: false, id: cardId || id, proxyPrefix: proxyPrefix() });
          const task = jobSummary(job);
          // 卡片 renderPreview 用全量帧做胶片回放（slice(-16)），而列表出口只带末帧；
          // 这里按需补拉单条（/_relay/prompts/<id>，full=true，全部 ≤16 帧）覆盖。取不到则退回末帧。
          if (job.promptId) {
            try {
              const { ok, data } = await relayJson(`/_relay/prompts/${encodeURIComponent(job.promptId)}`, { timeoutMs: 6_000 });
              const rec = ok && data && data.record ? data.record : null;
              if (rec && Array.isArray(rec.previewFrames) && rec.previewFrames.length) {
                task.previewFrames = rec.previewFrames;
                task.previewUpdatedAt = rec.previewUpdatedAt || task.previewUpdatedAt;
              }
            } catch { /* 补拉失败：保留列表末帧 */ }
          }
          return c.json({
            ok: true,
            found: true,
            proxyPrefix: proxyPrefix(),
            task,
            relayEvents: state.snapshot?.relay?.events || null,
          });
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 500);
        }
      });

      // ── 宿主主题 → ComfyUI 服务端设置 ──────────────────────────────
      // 工作区 iframe 直连 8188 后为跨源，壳页无法直接改 iframe 样式，改为把主题
      // 写进 ComfyUI 自己的设置（自定义色板 hana），iframe 下次加载即生效。
      // 机制与键名见 runtime/comfy-relay.mjs 的「主题同步」区；POST /settings 是合并写，
      // 不会动用户的其它设置。
      app.get("/comfyui-hana/theme", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/theme", { timeoutMs: 15_000 });
          return c.json(ok && data && typeof data === "object" ? data : { ok: false, error: `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/comfyui-hana/theme", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const body = await c.req.json().catch(() => ({}));
          const { ok, status, data } = await relayJson("/_relay/theme", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body && typeof body === "object" ? body : {}),
            timeoutMs: 20_000,
          });
          // 失败时把中继的具体原因透出来（早前直接吞成 `relay HTTP 502`，排查时看不出哪一步）
          return c.json(
            ok ? (data && typeof data === "object" ? data : { ok: true })
               : { ok: false, error: (data && data.error) || `relay HTTP ${status}` },
            ok ? 200 : 502,
          );
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });
      // ── ComfyUI 本体更新（M11）───────────────────────────────────────
      // check（带缓存）→ 跟远端比 commit；apply → 后台跑（停服务→fetch→pull→pip）；
      // status → 阶段/步骤/日志尾。机制见 runtime/comfy-relay.mjs 的「ComfyUI 本体更新」区。
      app.get("/comfyui-hana/update", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const force = String(c.req.query("force") || "") === "1" ? "?force=1" : "";
          const { ok, status, data } = await relayJson(`/_relay/update${force}`, { timeoutMs: 150_000 });
          return c.json(ok ? (data || { ok: true }) : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.get("/comfyui-hana/update/status", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const { ok, status, data } = await relayJson("/_relay/update/status", { timeoutMs: 10_000 });
          return c.json(ok ? (data || { ok: true }) : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });

      app.post("/comfyui-hana/update", async (c) => {
        if (!relayReady()) return c.json({ ok: false, error: "relay-not-ready", phase: state.phase }, 503);
        try {
          const body = await c.req.json().catch(() => ({}));
          const { ok, status, data } = await relayJson("/_relay/update", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body && typeof body === "object" ? body : {}),
            timeoutMs: 180_000,
          });
          return c.json(ok ? (data || { ok: true }) : { ok: false, error: (data && data.error) || `relay HTTP ${status}` }, ok ? 200 : 502);
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      });
    });
    log("路由注册：ctx.routes.register（/comfyui-hana/boot-state|status|health|metrics|release|install-*|relay/start|backend/start|backend/stop|backend|theme|update*）");
  } catch (e) {
    error(`ctx.routes.register 失败（壳页诊断面不可用，工具面仍可用）：${msgOf(e)}`);
  }

  // ── 任务结算节拍（2s）────────────────────────────────────────────────────
  state.jobTimer = setInterval(() => { void jobTick(); }, JOB_TICK_MS);
  state.jobTimer.unref?.();

  // ── 自动拉起（微任务，不占 apply 同步栈；单飞行）─────────────────────────
  Promise.resolve()
    .then(async () => {
      await stopStaleRuntimes();
      return ensureManagedRuntime();
    })
    .catch((e) => warn(`apply 自动链启动中继失败（状态经 boot-state 展示，可重试）：${msgOf(e)}`));

  log("apply done");
});
