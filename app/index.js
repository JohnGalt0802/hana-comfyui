// app/index.js — Hana-ComfyUI · v2 App 入口（v0.2：工具面 + 任务桥 + 任务卡）
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
//   4. 路由：/comfyui-hana/boot-state | status | health | relay/start | backend/start | backend/stop | backend | task?id=
//      （relay/start 只重启「中继」；backend/* 管 8188 上的 ComfyUI 本体，由计划任务拉起，独立于 Hana 存活）
//   5. 每 1.5s 轮询中继 /_relay/status（ctx.runtime.fetch 优先）；每 2s 结算任务
//
// 生命周期口径：本 App 负责"拉起 + 监督 + 状态出口 + 任务跟踪"；最终回收由宿主受管 runtime
// 负责（停用/卸载时回收其受管进程组与服务连接）。
// ─────────────────────────────────────────────────────────────────────────────
import { defineApp } from "./sdk/app-contract/server-client.js";
import { createHash, randomInt, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectGraph } from "./lib/canvas-project.mjs";
import { analyzeGraph, traceGraph } from "./lib/canvas-analysis.mjs";
import { outlineGraph } from "./lib/canvas-outline.mjs";

const APP_ID = "comfyui-hana";
// v0.6.0（M9）：ComfyUI 服务进程起停（中继 /_relay/backend/{start,stop,proc} + App 路由 + 工具 action=service
//   + 左侧面板「启动服务/停止服务」）。启动走计划任务（脱离宿主沙箱 job，服务独立存活），撤下走 taskkill。
//   面板原来那个「重试启动」正名为「重启中继」——它只重启受管 runtime，不碰 ComfyUI 服务本体。
const APP_VERSION = "0.8.0";
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
  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  const NOTE_TYPES = new Set(["Note", "MarkdownNote"]);
  const UNSUPPORTED_UI_TYPES = new Set(["Reroute", "PrimitiveNode", "Subgraph", "GroupNode", "SubgraphInputNode", "SubgraphOutputNode"]);

  async function getObjectInfo() {
    const { ok, data } = await relayJson("/object_info", { timeoutMs: 30_000 });
    if (!ok || !isPlainObject(data)) throw new Error("读取 /object_info 失败（中继或后端不可用）");
    return data;
  }

  // UI 格式（nodes/links）→ API 格式：经典图子集（子图/环绕/静音/旁路节点会明确报错）
  function convertUiToApi(wf, objectInfo) {
    const nodes = Array.isArray(wf.nodes) ? wf.nodes : null;
    if (!nodes) throw new Error("不是 UI 格式工作流（缺 nodes 数组）");
    const linkById = new Map();
    if (Array.isArray(wf.links)) {
      for (const l of wf.links) {
        if (Array.isArray(l) && l.length >= 6) linkById.set(l[0], { origin: l[1], originSlot: l[2] });
      }
    }
    const out = {};
    const problems = [];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const type = String(n.type || "");
      if (NOTE_TYPES.has(type)) continue;
      if (n.mode === 2 || n.mode === 4) { problems.push(`节点 #${n.id} ${type} 处于静音/旁路状态`); continue; }
      if (UNSUPPORTED_UI_TYPES.has(type) || /^[0-9a-fA-F-]{20,}$/.test(type)) {
        problems.push(`节点 #${n.id} 类型 ${type}（子图/环绕节点）`);
        continue;
      }
      const info = objectInfo[type];
      if (!info) { problems.push(`节点 #${n.id} 类型 ${type} 不在 /object_info`); continue; }
      const declared = [
        ...Object.keys(info.input?.required || {}),
        ...Object.keys(info.input?.optional || {}),
      ];
      const nodeInputs = Array.isArray(n.inputs) ? n.inputs : [];
      const wv = Array.isArray(n.widgets_values) ? [...n.widgets_values] : [];
      let wvi = 0;
      const inputs = {};
      for (const name of declared) {
        const slot = nodeInputs.find((s) => s && s.name === name);
        if (slot && slot.link !== null && slot.link !== undefined) {
          const link = linkById.get(slot.link);
          if (!link) { problems.push(`节点 #${n.id} 输入 ${name} 的连线缺失（link ${slot.link}）`); continue; }
          inputs[name] = [String(link.origin), link.originSlot];
          continue;
        }
        const spec = (info.input?.required || {})[name] || (info.input?.optional || {})[name];
        if (!spec) continue;
        const t = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
        const isWidget = ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(t);
        const forceInput = !!(spec[1] && spec[1].forceInput === true);
        if (!isWidget || forceInput) continue;
        let val;
        if (wvi < wv.length) val = wv[wvi++];
        if ((name === "seed" || name === "noise_seed") && wvi < wv.length && typeof wv[wvi] === "string" &&
            ["fixed", "increment", "decrement", "randomize"].includes(wv[wvi])) {
          wvi += 1; // 跳过 control_after_generate 副值
        }
        if (isPlainObject(val) && "value" in val) val = val.value;
        if (val !== undefined) inputs[name] = val;
      }
      out[String(n.id)] = { class_type: type, inputs };
      if (typeof n.title === "string" && n.title) out[String(n.id)]._meta = { title: n.title };
    }
    if (problems.length) {
      throw new Error(`UI→API 转换遇到不支持的构造：${problems.slice(0, 6).join("；")}${problems.length > 6 ? " 等" : ""}。请在 ComfyUI 里用「工作流 → 导出（API 格式）」拿到 API JSON 后再提交。`);
    }
    return out;
  }

  async function readLocalText(path) {
    const { status, ok, data } = await relayJson("/_relay/fs/read", { method: "POST", body: JSON.stringify({ path }) });
    if (!ok || !data?.ok) {
      throw new Error(`读取文件失败（${status}）：${data?.error || "未知错误"} —— ${path}`);
    }
    return data.text;
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
    // 这里只把"相对路径"放进 query（斜杠原样、其余段编码），避开宿主那段校验。
    const p = String(target.path).replace(/\\/g, "/");
    const file = p.startsWith("workflows/") ? p : `workflows/${p}`;
    const res = await relayJson(`/_relay/userdata?file=${encodeURI(file)}`, { timeoutMs: 30_000 });
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

  function applyInputs(prompt, inputs) {
    const applied = [];
    if (!inputs) return applied;
    if (!isPlainObject(inputs)) throw new Error("inputs 需要对象：{\"<node_id>.<input>\": value}");
    for (const [key, value] of Object.entries(inputs)) {
      const i = key.lastIndexOf(".");
      if (i <= 0) throw new Error(`inputs 键格式应为 "<node_id>.<input>"：${key}`);
      const nodeId = key.slice(0, i);
      const inputName = key.slice(i + 1);
      const node = prompt[nodeId];
      if (!node || !isPlainObject(node)) {
        throw new Error(`inputs 注入失败：节点 ${nodeId} 不存在（现有节点 id：${Object.keys(prompt).slice(0, 30).join(", ")}）`);
      }
      node.inputs = isPlainObject(node.inputs) ? node.inputs : {};
      node.inputs[inputName] = value;
      applied.push(key);
    }
    return applied;
  }

  function summarizeWorkflow(parsed) {
    if (Array.isArray(parsed?.nodes)) {
      const nodes = parsed.nodes
        .filter((n) => n && !NOTE_TYPES.has(String(n.type)))
        .map((n) => ({ id: n.id, type: n.type, title: n.title || undefined }));
      return { format: "ui", nodeCount: nodes.length, nodes };
    }
    if (isPlainObject(parsed)) {
      const nodes = Object.entries(parsed).map(([id, n]) => ({ id, type: n?.class_type, title: n?._meta?.title || undefined }));
      return { format: "api", nodeCount: nodes.length, nodes };
    }
    return { format: "unknown", nodeCount: 0, nodes: [] };
  }

  // ── 任务卡数据 ────────────────────────────────────────────────────────────
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

  function statusText() {
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

  function stableCardId(promptId) {
    return "a_" + createHash("sha256").update(`${APP_ID}:${promptId}`).digest("hex").slice(0, 20);
  }

  // 宿主边界（2026-09-21 实测）：next-step 的可靠投递只写桌面会话（agents/{id}/sessions/*.jsonl）；
  // 子代理会话（agents/{id}/subagent-sessions/direct/*.jsonl）会被宿主静默拒绝（console 级）——
  // 从子代理发起的任务不会自动回执，工具文案必须如实说明，避免制造预期落差。
  function isSubagentSessionPath(p) {
    return typeof p === "string" && /[\\/]subagent-sessions[\\/]/i.test(p);
  }
  const SUBAGENT_DELIVERY_NOTE = "来源是子代理会话：宿主 next-step 投递仅支持桌面会话，完成后不会自动回执（请用 comfyui action=query/result 主动取结果；需要自动回执请从主对话发起）";

  // ── 工具动作实现 ──────────────────────────────────────────────────────────
  async function actionSubmit(args, context) {
    const { prompt, source } = await resolveWorkflowToPrompt(args.workflow);
    if (!isPlainObject(prompt) || Object.keys(prompt).length === 0) {
      throw new Error("工作流为空或结构无法识别（需要 API 格式：{ \"<node_id>\": { class_type, inputs } }）");
    }
    const applied = applyInputs(prompt, args.inputs);
    const label = String(args.clientLabel || "").trim().slice(0, 120) || `ComfyUI 生成（${Object.keys(prompt).length} 节点）`;

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
    const promptId = data && typeof data.prompt_id === "string" ? data.prompt_id : null;
    if (!promptId) throw new Error(`后端未返回 prompt_id：${JSON.stringify(data).slice(0, 300)}`);

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
    const cardRef = {
      pluginId: APP_ID,
      cardId: "task",
      cardInstanceId: stableCardId(promptId),
      route: `/task.html?pid=${encodeURIComponent(promptId)}${job.taskId ? `&taskId=${encodeURIComponent(job.taskId)}` : ""}`,
      title: `ComfyUI 生成 · ${label}`,
      description: `prompt ${promptId.slice(0, 8)}… · ${source}${applied.length ? ` · 注入 ${applied.length} 项` : ""}`,
      aspectRatio: "16:9",
      cardForm: "flush",
    };
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
              ? "后台自动跟踪（进度见任务卡；自动回执不适用，用 comfyui action=query/result 取结果）"
              : "后台自动跟踪（进度见任务卡，或 comfyui action=query）")
          : "后台自动跟踪（结果不主动投递，用 comfyui action=result 取产物）"
      }`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        bridgedTool: { name: "comfyui", server: APP_ID },
        card: cardRef,
        comfyui: {
          action: "submit",
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
    probe: { drive: "api.probe", desc: "桥自检（关键 API 存在性）" },
    revision: { drive: "canvas.revision", desc: "画布变更序号（只问变没变，轻量）" },
    events: { drive: "canvas.events", desc: "画布变更记录（最近若干条）" },
    frameReload: { drive: "frame.reload", desc: "强制重载工作区内层 iframe（扩展换文件后用）" },
    commands: { drive: "canvas.commands", desc: "列前端已注册命令 id（排布插件自检）" },
    commandShape: { drive: "canvas.commandShape", desc: "探前端命令表形状（自检）" },
    loadWorkflowFile: { drive: "canvas.loadWorkflowFile", desc: "按文件路径直接加载工作流（绕过前端列表，写）", write: true },
    openWorkflow: { drive: "canvas.openWorkflow", desc: "打开指定工作流并推到前台（不修改图内容，自带未保存保护）" },
    // 以下为写入（需授权：设置页「允许 agent 修改画布」）
    setWidget: { drive: "canvas.setWidget", desc: "改一个节点参数", write: true },
    addNode: { drive: "canvas.addNode", desc: "新建节点入图", write: true },
    removeNode: { drive: "canvas.removeNode", desc: "删除节点", write: true },
    connect: { drive: "canvas.connect", desc: "连线", write: true },
    disconnect: { drive: "canvas.disconnect", desc: "断开一条输入连线", write: true },
    setNodeMode: { drive: "canvas.setNodeMode", desc: "mute / bypass / 恢复正常", write: true },
    save: { drive: "canvas.save", desc: "把当前图落盘为工作流文件", write: true },
    undo: { drive: "canvas.undo", desc: "撤销 agent 上一步", write: true },
    patch: { drive: "canvas.patch", desc: "意图级写：多编辑一次提交（edits），$引用/原子回滚/verify/dryRun", write: true },
    // 排布：把命令递交给前端扩展自己执行（默认走 node-organizer 插件）
    organize: { drive: "canvas.organize", desc: "调前端扩展已注册命令（默认 node-organizer.organize 自动排布；args.command 可换）", write: true },
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

  async function actionCanvas(args) {
    // 默认 state：对话开始时最常用——读服务端缓存的「手边快照」，零往返
    // 注意：白名单 key 是驼峰（openWorkflow / setWidget / addNode…），
    // 不能先把 op 名 toLowerCase 再查表，否则写入类 op 永远对不上。
    const opRaw = String((args && args.op) || "state").trim();
    const op = Object.keys(CANVAS_OPS).find((k) => k.toLowerCase() === opRaw.toLowerCase()) || "";
    const spec = op ? CANVAS_OPS[op] : null;
    if (!spec) throw new Error(`op 必须是 ${Object.keys(CANVAS_OPS).join(" / ")}（收到 "${opRaw}"）`);
    // 写入类 op 需显式授权（默认关）
    if (spec.write && !readAllowWrite()) {
      throw new Error(`「${op}」会修改你的画布，当前未授权。请在 Hana-ComfyUI 设置页打开「允许 agent 修改画布」后再试。`);
    }
    // patch：缺 edits 提前拦住（不浪费一次桥往返；结构细节校验仍以桥侧为准）
    if (op === "patch" && (!args || !Array.isArray(args.edits) || args.edits.length === 0)) {
      throw new Error("patch 需要 edits（编辑数组）");
    }
    // 写入参数原样透传给桥（桥侧做具体校验）
    const bridgeArgs = {};
    for (const k of [
      "nodeId",
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
    ]) {
      if (args && args[k] !== undefined) bridgeArgs[k] = args[k];
    }
    // 两条腿互补：直连模式下壳页跨源够不到 app，代理模式下扩展加载不了。
    // 所以先试壳页（活且能应答就用它），失败则回退到扩展那条路。
    const bridgeCall = () => relayJson("/_relay/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: spec.drive, args: bridgeArgs }),
      timeoutMs: 30_000,
    });
    let via = "bridge";
    let res;
    if (shellAlive()) {
      try {
        const r = await shellCall(spec.drive, bridgeArgs);
        if (r.ok) {
          via = "shell";
          res = { ok: true, status: 200, data: { ok: true, data: r.data } };
        } else {
          // 壳页活着但执行失败（典型：直连模式跨源够不到 app）→ 回退扩展
          res = await bridgeCall();
        }
      } catch {
        res = await bridgeCall();
      }
    } else {
      res = await bridgeCall();
    }
    const { ok, status, data } = res;
    const d = data && typeof data === "object" ? data : {};
    if (!ok || d.ok === false) {
      const why = d.error || `HTTP ${status}`;
      throw new Error(`读画布失败（${op}，经 ${via}）：${why}${d.detail ? " · " + d.detail : ""}`);
    }
    const payload = d.data === undefined ? null : d.data;
    // 投影过滤器（P1）：get 的 select/fields 在 app 层消费（不透传给桥）
    const projSelect = args && typeof args.select === "string" ? args.select : "";
    const projFields = args && typeof args.fields === "string" ? args.fields : "";
    let text;
    if (op === "pages" && payload) {
      const rows = (payload.pages || []).map(
        (p) =>
          `  ${p.sid}… 「${p.workflow || "(未命名)"}」 ${p.ageSec}s 前活跃${p.modified ? "（有未保存改动）" : ""}`,
      );
      text = [`在线页面：${payload.count} 个`, ...rows].join("\n");
      if (!rows.length) text = "在线页面：0 个（没有开着的 ComfyUI 页面）";
    } else if (op === "state" && payload) {
      if (!payload.hasState) {
        text =
          "还没有画布快照。打开一次 ComfyUI 工作区（让它推一次基线），或改用 op=summary 现抓。";
      } else {
        const s = payload.summary || {};
        const age = payload.ageSec == null ? "时间未知" : `${payload.ageSec}s 前`;
        const rows = (s.nodes || []).map(
          (n) => `  #${n.id} ${n.type}${n.title && n.title !== n.type ? ` （${n.title}）` : ""}`,
        );
        text = [
          `画布快照（${age}，rev=${payload.revision ?? "?"}）：${s.nodeCount} 个节点 / ${s.linkCount} 条连线`,
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
      const s = JSON.stringify(analyzeGraph(payload));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "trace") {
      // trace：nodeId/slot/dir 从 args 直读（不透传给桥）；缺参给明确报错
      const nodeId = args && args.nodeId;
      const slot = args && args.slot;
      if (nodeId == null || String(nodeId).trim() === "") throw new Error("trace 需要 nodeId（目标节点 id）");
      if (slot == null || String(slot).trim() === "") throw new Error("trace 需要 slot（名字或索引）");
      const s = JSON.stringify(traceGraph(payload, { node: nodeId, slot, dir: args && args.dir }));
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    } else if (op === "outline") {
      const s = JSON.stringify(outlineGraph(payload));
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
    } else if (op === "save" && payload) {
      text = `已落盘：${payload.saved}（${payload.nodes} 节点）${payload.backup ? `，备份 ${payload.backup}` : ""}`;
    } else if (op === "undo" && payload) {
      text = payload.undone
        ? `已撤销「${payload.undone}」（剩余可撤销 ${payload.stackLeft} 步）`
        : payload.note || "已执行撤销";
    } else {
      const s = JSON.stringify(payload, null, op === "probe" || op === "running" ? 2 : 0);
      text = s && s.length > 60_000 ? s.slice(0, 60_000) + `\n…（已截断，原文 ${s.length} 字符）` : String(s);
    }
    return {
      content: [{ type: "text", text }],
      details: {
        comfyui: {
          action: "canvas",
          op,
          ok: true,
          ...(op === "summary" && payload ? { nodeCount: payload.nodeCount, linkCount: payload.linkCount } : {}),
          ...(op === "probe" || op === "running" || op === "revision" ? { payload } : {}),
          ...(op === "events" ? { changeCount: payload && payload.total } : {}),
        },
      },
    };
  }

  async function actionService(args) {
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
    if (op === "start") {
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
        ? "ComfyUI 服务已在运行（无需重复启动）。"
        : [
            "已请求启动 ComfyUI 服务（由计划任务以当前用户身份拉起，独立于 Hana 存活）。",
            d.python ? `解释器：${d.python}` : "",
            d.mainPy ? `入口：${d.mainPy}` : "",
            d.logFile ? `日志：${d.logFile}` : "",
            "首次启动约 30～90 秒（含依赖导入）；用 comfyui(action=\"status\") 或工作区左侧面板看就绪。",
          ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text }], details: { comfyui: { action: "service", op, ...d } } };
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
    throw new Error(`op 必须是 status / start / stop（收到 "${op}"）`);
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
          clientLabel: { type: "string", description: "任务标签（显示在任务卡与回执里）" },
          front: { type: "boolean", description: "true 时插队到队列最前（默认追加到队尾）" },
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
          op: { type: "string", enum: ["status", "start", "stop"], description: "status=查服务进程状态（默认）；start=拉起本机 ComfyUI 服务（未运行时）；stop=撤下服务（终止 8188 上的进程）" },
          path: { type: "string", description: "start 可选：指定 ComfyUI 安装根（默认用本机安装探测结果）" },
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
              "prompt",
              "running",
              "probe",
              "revision",
              "events",
              "setWidget",
              "addNode",
              "removeNode",
              "connect",
              "disconnect",
              "setNodeMode",
              "save",
              "undo",
              "patch",
            ],
            description:
              "读/改人正在看的同一张画布。读：pages=在线页面清单（各自开的哪个工作流）；state=最近快照（默认，零往返）；summary=现抓摘要；get=全量 UI JSON（select/fields 投影裁剪）；check=体检（悬空/未接/mute·bypass）；trace=追踪端口来源/去向；outline=大纲（功能块+块间连线）；prompt=可提交形态；running=当前执行节点；probe=桥自检；revision=变更序号；events=变更记录。写（需授权）：setWidget=改参数；addNode=加节点；removeNode=删节点；connect=连线；disconnect=断线；setNodeMode=mute/bypass；save=落盘为工作流文件；undo=撤销 agent 上一步；patch=意图级写（多编辑一次提交：edits、$引用、原子回滚、verify/dryRun）。多页面时用 workflow 参数定向（不传则广播）",
          },
          workflow: { type: "string", description: "多页面定向：只发给正打开这个工作流名的页面（不传则广播给所有页面）" },
          select: { type: "string", description: "投影过滤：只保留匹配节点（#8 / #8,#27 / type=PrimitiveInt / title~尺寸，逗号分隔取并集）；与 fields 搭配替代全量 get" },
          fields: { type: "string", description: "投影过滤：节点字段白名单（title,type,mode,inputs,outputs,widgets_values,pos,size，逗号分隔）；id 始终保留" },
          nodeId: { type: "string", description: "目标节点 id（canvas get/state/summary 里的 \"#<id>\"，setWidget/removeNode/connect/trace 等用）" },
          name: { type: "string", description: "setWidget 用参数名；save 用工作流名（省略则用当前工作流）" },
          value: { description: "setWidget 用：新值（数字/字符串/布尔，按参数类型给）" },
          type: { type: "string", description: "addNode 用：节点类型（如 KSampler / CLIPTextEncode / EmptyLatentImage）" },
          pos: { type: "array", items: { type: "number" }, description: "addNode 用：画布坐标 [x, y]（可选）" },
          title: { type: "string", description: "addNode 用：节点标题（可选）" },
          fromNode: { type: "string", description: "connect 用：源节点 id" },
          fromSlot: { description: "connect 用：源输出槽（名字或索引）" },
          toNode: { type: "string", description: "connect 用：目标节点 id" },
          toSlot: { description: "connect 用：目标输入槽（名字或索引）" },
          slot: { description: "disconnect/trace 用：槽（名字或索引）" },
          dir: { type: "string", enum: ["up", "down"], description: "trace 用：up=直接来源（默认）/ down=直接去向" },
          mode: { type: "number", enum: [0, 2, 4], description: "setNodeMode 用：0=正常 / 2=mute / 4=bypass" },
          edits: {
            type: "array",
            description: "patch 用：编辑数组（顺序执行，原子回滚）。每条恰一个 key，可用：addNode / setWidget / connect / disconnect / setNodeMode / removeNode / save（save 仅限最后一条）。示例：[{\"disconnect\":{\"nodeId\":8,\"slot\":\"width\"}},{\"addNode\":{\"type\":\"PrimitiveInt\",\"title\":\"宽度\",\"as\":\"w\"}},{\"setWidget\":{\"nodeId\":\"$w\",\"name\":\"value\",\"value\":1248}},{\"connect\":{\"fromNode\":\"$w\",\"fromSlot\":\"INT\",\"toNode\":8,\"toSlot\":\"width\"}},{\"save\":{}}]",
          },
          verify: { type: "boolean", description: "patch 用：执行后逐条对照终态（默认 true）" },
          dryRun: { type: "boolean", description: "patch 用：只做预检、零图变更（默认 false）；输出逐条 checks" },
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
        "status=服务/中继/队列/运行中任务聚合；submit=提交工作流（三形态：API 格式 JSON 对象 / 文件路径 / {template:\"名称\"}；inputs 注入 \"<node_id>.<input>\"; clientLabel 标签；front 插队）→ 返回 prompt_id 与任务卡，后台自动跟踪并在完成时按 next-step 回执；" +
        "query=按 prompt_id/taskId 查任务或列最近；result=取产物（本地路径+预览 URL，可选入会话文件）；cancel=定向取消（all:true 才全清）；service=ComfyUI 服务进程起停（op=status/start/stop）——服务由计划任务拉起，独立于 Hana 存活；workflows=列出/读取已保存工作流的节点结构；upload=上传图片（图生图输入）；" +
        "update=ComfyUI 本体更新（op=check 检查 / apply 执行 / status 查进度；仅源码安装支持，走 git pull --ff-only + pip install -r requirements.txt，更新前自动停服务，完成后需重新启动服务）；" +
        "canvas=读/改人正在看的同一张画布（读：pages 在线页面清单 / state 最近快照（默认，零往返）/ summary 现抓摘要 / get 全量 UI JSON（select/fields 投影裁剪）/ check 体检（悬空/未接/mute·bypass）/ trace 追踪端口来源/去向 / outline 大纲（功能块+块间连线）/ prompt 可提交形态 / running 当前执行节点 / probe 桥自检 / revision 变更序号 / events 变更记录；写：setWidget 改参数 / addNode 加节点 / removeNode 删节点 / connect 连线 / disconnect 断线 / setNodeMode mute或bypass / undo 撤销 agent 上一步 / patch 意图级写（多编辑一次提交：edits、$引用、原子回滚、verify/dryRun））——写入类 op 需用户在设置页开启「允许 agent 修改画布」，且需 ComfyUI 页面在线；agent 的改动要用 op=undo 撤（新版前端的 Ctrl+Z 撤不掉外部改动）。快照由前端在画布变化后主动推、缓在 ComfyUI 侧，所以 ComfyUI 页面没开着也能拿到上次状态；页面从未打开过时用 op=summary 现抓（需先部署 custom_nodes/hana_bridge 并启动服务）。" +
        "提交即返回（回合纪律：不要在提交后原地等待；进度用任务卡或 query 查看）。完整手册见 SKILL: skills/comfyui-hana/SKILL.md",
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
              const snap = state.snapshot;
              const capsMap = await capabilitiesMap();
              const capOf = (w) => (capsMap ? (capsMap[w] || "not_asked") : "unknown");
              return {
                content: [{ type: "text", text: statusText() + `\n- 能力账本：${CAP_TASKS}=${capOf(CAP_TASKS)} · ${CAP_START_TURN}=${capOf(CAP_START_TURN)} · ${CAP_STAGE_FILE}=${capOf(CAP_STAGE_FILE)}` }],
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
            case "service": return await actionService(args);
            case "update": return await actionUpdate(args, context);
            case "canvas": return await actionCanvas(args);
            case "upload": return await actionUpload(args);
            default:
              throw new Error(`action 必须是 status / submit / query / result / cancel / workflows / upload / service / update / canvas（收到 "${action}"）`);
          }
        } catch (e) {
          const text = `comfyui(${action || "?"}) 失败：${msgOf(e)}`;
          error(text);
          return { content: [{ type: "text", text }], details: { comfyui: { action, ok: false, error: msgOf(e) } } };
        }
      },
    });
    log("工具注册：comfyui（v0.3：status/submit/query/result/cancel/workflows/upload/service/update/canvas）");
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
        try { return c.json(fullStatus()); } catch (e) { return c.json({ ok: false, error: msgOf(e) }, 500); }
      });

      app.get("/comfyui-hana/health", (c) => c.json({ ok: true, app: { id: APP_ID, version: APP_VERSION }, ts: new Date().toISOString() }));

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
      return c.json({
        ok: true,
        alive: shellAlive(),
        lastSeenAgoMs: shellBridge.lastSeenAt ? Date.now() - shellBridge.lastSeenAt : null,
        queued: shellBridge.queue.length,
        inflight: shellBridge.pending.size,
        hello: shellBridge.lastHello,
      });
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
          return c.json(await actionCanvas(merged));
        } catch (e) {
          return c.json({ ok: false, error: msgOf(e) }, 502);
        }
      };
      app.get("/comfyui-hana/canvas", canvasRoute);
      app.post("/comfyui-hana/canvas", canvasRoute);

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

      app.get("/comfyui-hana/task", async (c) => {
        try {
          const id = String(c.req.query("id") || "").trim();
          if (!id) return c.json({ ok: false, error: "需要 ?id=<promptId 或 taskId>" }, 400);
          const job = await findJobById(id);
          if (!job) return c.json({ ok: true, found: false, id, proxyPrefix: proxyPrefix() });
          return c.json({
            ok: true,
            found: true,
            proxyPrefix: proxyPrefix(),
            task: jobSummary(job),
            relayEvents: state.snapshot?.relay?.events || null,
          });
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
    log("路由注册：ctx.routes.register（/comfyui-hana/boot-state|status|health|metrics|release|install-*|task|relay/start|backend/start|backend/stop|backend|theme|update*）");
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
