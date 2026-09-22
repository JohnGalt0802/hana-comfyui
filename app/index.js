// app/index.js — ComfyUI-Hana · v2 App 入口（v0.2：工具面 + 任务桥 + 任务卡）
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
//   4. 路由：/comfyui-hana/boot-state | status | health | relay/start | task?id=
//   5. 每 1.5s 轮询中继 /_relay/status（ctx.runtime.fetch 优先）；每 2s 结算任务
//
// 生命周期口径：本 App 负责"拉起 + 监督 + 状态出口 + 任务跟踪"；最终回收由宿主受管 runtime
// 负责（停用/卸载时回收其受管进程组与服务连接）。
// ─────────────────────────────────────────────────────────────────────────────
import { defineApp } from "./sdk/app-contract/server-client.js";
import { createHash, randomInt, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_ID = "comfyui-hana";
const APP_VERSION = "0.5.0";
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
      "请帮我安装 ComfyUI（供 ComfyUI-Hana 使用）。",
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
    const rel = String(target.path).split("/").map((s) => encodeURIComponent(s)).join("/");
    const res = await relayJson(`/userdata/${rel}`, { timeoutMs: 30_000 });
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
    lines.push(`ComfyUI-Hana 状态（v${APP_VERSION}）`);
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
        command: "upload",
        required: ["path"],
        fields: {
          path: { type: "string", description: "本机图片文件绝对路径（png/jpg/webp/gif/bmp）" },
          subfolder: { type: "string", description: "上传到 input 的子目录（可选）" },
          overwrite: { type: "boolean", description: "true 时覆盖同名文件" },
        },
      },
    ];
  }

  try {
    const branches = actionBranches();
    await sdk.tools.register({
      name: "comfyui",
      description:
        "ComfyUI-Hana：操作本机 ComfyUI（127.0.0.1:8188）的工具（一个 App 一个同名工具，action 选动作）。" +
        "status=服务/中继/队列/运行中任务聚合；submit=提交工作流（三形态：API 格式 JSON 对象 / 文件路径 / {template:\"名称\"}；inputs 注入 \"<node_id>.<input>\"; clientLabel 标签；front 插队）→ 返回 prompt_id 与任务卡，后台自动跟踪并在完成时按 next-step 回执；" +
        "query=按 prompt_id/taskId 查任务或列最近；result=取产物（本地路径+预览 URL，可选入会话文件）；cancel=定向取消（all:true 才全清）；workflows=列出/读取已保存工作流的节点结构；upload=上传图片（图生图输入）。" +
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
            case "upload": return await actionUpload(args);
            default:
              throw new Error(`action 必须是 status / submit / query / result / cancel / workflows / upload（收到 "${action}"）`);
          }
        } catch (e) {
          const text = `comfyui(${action || "?"}) 失败：${msgOf(e)}`;
          error(text);
          return { content: [{ type: "text", text }], details: { comfyui: { action, ok: false, error: msgOf(e) } } };
        }
      },
    });
    log("工具注册：comfyui（v0.2：status/submit/query/result/cancel/workflows/upload）");
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
    });
    log("路由注册：ctx.routes.register（/comfyui-hana/boot-state|status|health|metrics|release|install-targets|install-target|install-prompt|install-launch|task|relay/start）");
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
