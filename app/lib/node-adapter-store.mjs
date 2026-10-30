// 节点适配档案加载器（2026-10-30）
//
// 职责边界：本模块只做 IO —— 扫目录、读 *.json、取出 rules 字段、合并成 { [nodeType]: rules }。
// 规则引擎本体在 lib/workflow-tools.mjs（纯函数模块，不塞任何 IO）；两者只通过 adapters 参数相连。
//
// 目录与优先级（后加载者覆盖同名的 nodeType）：
//   1) 内置：<app>/lib/node-adapters/*.json（随仓库分发，本模块自解析，无需调用方传）
//   2) 用户：<app-data>/comfyui-hana/node-adapters/*.json（由调用方按各自 app-data 口径拼好传 opts.userDir）
//   app-data 根目录的取法不在这里发明：app 侧用 sdk.dataDir，中继侧用运行时配置里的 appDataDir。
//
// 缓存：按「目录 + 文件 mtime/size」缓存，TTL 内完全不碰盘（转换在画布执行路径上会被频繁调用）；
//       TTL 到期后重扫目录，只有 mtime/size 变了的文件才重读。clearNodeAdapterCache() 立即失效。
//
// 容错：目录缺失 = 没有档案（静默）；单文件 JSON 坏 / 档案里无 rules / rules 不是对象 → warn 并跳过。
//       本模块不抛错，也绝不让主流程失败。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内置档案目录：<app>/lib/node-adapters */
export const BUILTIN_NODE_ADAPTER_DIR = join(HERE, "node-adapters");

/** 默认缓存 TTL：5s 内同一目录不重复读盘 */
const DEFAULT_TTL_MS = 5_000;

/** dir → { at: number, files: Map<name, {mtimeMs, size, rules}>, merged: {[nodeType]: rules} } */
const cache = new Map();

function msgOf(e) {
  return String((e && e.message) || e);
}

function defaultWarn(text) {
  try { console.warn(`[node-adapters] ${text}`); } catch { /* 无 console 也不影响主流程 */ }
}

// 读单个档案文件 → { [nodeType]: rules } 或 null（跳过）。只认 rules 字段；
// schema/title/source/verifiedAt/evidence 是元信息，这里有意忽略（evidence 给人看）。
function readRulesFile(file, name, warn) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    warn(`${name}：读取失败，已跳过（${msgOf(e)}）`);
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    warn(`${name}：JSON 解析失败，已跳过（${msgOf(e)}）`);
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    warn(`${name}：档案不是 JSON 对象，已跳过`);
    return null;
  }
  const nodeType = typeof doc.nodeType === "string" ? doc.nodeType.trim() : "";
  if (!nodeType) {
    warn(`${name}：缺少 nodeType（非空字符串），已跳过`);
    return null;
  }
  const rules = doc.rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    warn(`${name}：缺少 rules 或 rules 不是对象，已跳过`);
    return null;
  }
  return { [nodeType]: rules };
}

// 扫一个目录并合并成 { [nodeType]: rules }（同目录内按文件名排序，后者覆盖前者）
function loadDirRules(dir, warn, ttlMs) {
  const now = Date.now();
  const prev = cache.get(dir);
  if (prev && now - prev.at < ttlMs) return prev.merged;

  let names;
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // 目录不存在 = 没有档案，正常情况，不告警
      cache.set(dir, { at: now, files: new Map(), merged: {} });
      return {};
    }
    warn(`扫描 ${dir} 失败，已按无档案处理（${msgOf(e)}）`);
    return prev ? prev.merged : {};
  }

  const files = new Map();
  const merged = {};
  for (const name of names) {
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch (e) {
      warn(`${name}：读取文件状态失败，已跳过（${msgOf(e)}）`);
      continue;
    }
    if (!st.isFile()) continue;
    const old = prev && prev.files.get(name);
    const rules = old && old.mtimeMs === st.mtimeMs && old.size === st.size
      ? old.rules
      : readRulesFile(file, name, warn);
    files.set(name, { mtimeMs: st.mtimeMs, size: st.size, rules });
    if (rules) Object.assign(merged, rules);
  }
  cache.set(dir, { at: now, files, merged });
  return merged;
}

/**
 * 加载节点适配档案。
 * @param {object} [opts]
 * @param {string|null} [opts.userDir]    用户档案目录；null/空 = 只加载内置
 * @param {string|null} [opts.builtinDir] 覆盖内置目录（测试用）；传 null 则跳过内置
 * @param {number} [opts.ttlMs]           缓存 TTL（默认 5000；0 = 每次都重扫）
 * @param {(text:string)=>void} [opts.warn] 告警出口（默认 console.warn）
 * @returns {Promise<{[nodeType: string]: object}>} 空对象表示无档案（等价于调用方不传 adapters）
 */
export async function loadNodeAdapters(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const warn = typeof o.warn === "function" ? o.warn : defaultWarn;
  const ttlMs = Number.isFinite(o.ttlMs) && o.ttlMs >= 0 ? o.ttlMs : DEFAULT_TTL_MS;
  const merged = {};

  if (o.builtinDir !== null) {
    const builtinDir = typeof o.builtinDir === "string" && o.builtinDir ? o.builtinDir : BUILTIN_NODE_ADAPTER_DIR;
    Object.assign(merged, loadDirRules(builtinDir, warn, ttlMs));
  }
  if (typeof o.userDir === "string" && o.userDir) {
    // 用户档案后覆盖：同名 nodeType 以用户那份为准
    Object.assign(merged, loadDirRules(o.userDir, warn, ttlMs));
  }
  return merged;
}

/** 手动失效缓存（不传 dir 则全清）。验收时用它让改动立即生效。 */
export function clearNodeAdapterCache(dir) {
  if (typeof dir === "string" && dir) cache.delete(dir);
  else cache.clear();
}
