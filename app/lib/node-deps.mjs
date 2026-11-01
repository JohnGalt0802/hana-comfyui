// app/lib/node-deps.mjs — 缺包诊断内核 T8：未知类名 → 候选插件仓库 → 三态摘要（纯模块 · 零依赖）
// ─────────────────────────────────────────────────────────────────────────────
// 纯函数，不读盘不联网（无 fs / fetch / process）。映射表与已装清单都由调用方传入。
//
// 数据契约（extension-node-map.json，schema 全表统一）：
//   { "https://github.com/<owner>/<repo>": [["ClassA","ClassB",...], { title_aux }] }
// 类名 → 仓库不是一对一：约 4% 类名对应多仓库（实测最多 PreViewVideo 15 个），
// 热门名（KSampler / CheckpointLoaderSimple）也在表里且多候选。绝不断言唯一来源。
//
// 纯前端扩展（如 comfyui-node-organizer）注册 0 个节点类、不在映射表里，
// 不做特例：统一走「表里查不到」→ summarize 的 unresolved 路径。
//
// 三态判定边界（summarize 的口径）：
//   installedNotLoaded —— 该类所有候选仓库都已装（present:true）。包在目录里但类没出现在
//     object_info：加载失败 / 禁用 / 需重启。下一步：看启动日志、重启。
//   notInstalled —— 该类存在候选，且至少一个候选未装。未装候选（去重合并）进建议安装清单；
//     同一类的已装候选不进 installedNotLoaded（装了也没加载出这个类，再报会互相打架）。
//   unresolved —— 反查索引里没有该类。手写类名、拼错、纯前端扩展都落这里。
//     下一步：对照启动日志手工核对。
// ─────────────────────────────────────────────────────────────────────────────

// 归一化仓库地址 → "owner/repo"（小写、去 .git 后缀）。
//   https://github.com/Owner/Repo.git → owner/repo
//   https://github.com/Owner/Repo     → owner/repo
//   git@github.com:Owner/Repo.git     → owner/repo
//   http://github.com/Owner/Repo/     → owner/repo
// 非 GitHub 或无法解析（空、非字符串、缺 owner/repo）→ null，由调用方标 unresolvable。
export function normalizeRepo(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  const ssh = s.match(/^git@[^:/]+:([^/]+)\/(.+)$/i);
  let tail = null;
  if (ssh) {
    tail = `${ssh[1]}/${ssh[2]}`;
  } else {
    const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/(.+)$/i);
    if (!m) return null;
    tail = `${m[1]}/${m[2]}`;
  }
  tail = tail.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^[^/]+\/[^/]+$/.test(tail)) return null;
  return tail.toLowerCase();
}

// 原始映射表 → 反向索引 { "<ClassName>": [{ repo, title, classes }] }
// repo 是归一化的 "owner/repo"；title 取 title_aux（缺省回落 repo）。
// 输入键无法归一化（非 GitHub 地址等）→ 该条目跳过。
// 同一仓库若意外重复出现，后者覆盖前者（与原始表的键唯一性一致）。
// 每个类名下的候选按 repo 字母序排列（确定性输出；resolveMissing 会再按语义重排）。
export function buildReverseIndex(nodeMap) {
  if (!nodeMap || typeof nodeMap !== "object") {
    throw new Error("buildReverseIndex: nodeMap 必须是对象（原始 extension-node-map）");
  }
  const index = new Map();
  for (const [rawUrl, entry] of Object.entries(nodeMap)) {
    const repo = normalizeRepo(rawUrl);
    if (!repo || !Array.isArray(entry)) continue;
    const [classes, meta] = entry;
    if (!Array.isArray(classes)) continue;
    const title = (meta && typeof meta === "object" && typeof meta.title_aux === "string")
      ? meta.title_aux
      : repo;
    for (const cls of classes) {
      if (typeof cls !== "string" || !cls) continue;
      if (!index.has(cls)) index.set(cls, []);
      index.get(cls).push({ repo, title, classes: classes.slice() });
    }
  }
  const out = {};
  for (const [cls, list] of index) {
    list.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
    out[cls] = list;
  }
  return out;
}

// 已装清单归一化：调用方给的 { 原始地址或 owner/repo: { present, dir } } →
// { "owner/repo": { present, dir } }（present 缺省视为 true）。不可归一化的键丢弃。
export function normalizeInstalled(installed) {
  const out = {};
  if (!installed || typeof installed !== "object") return out;
  for (const [raw, info] of Object.entries(installed)) {
    const repo = normalizeRepo(raw) ?? (/^[^/]+\/[^/]+$/.test(raw) ? raw.toLowerCase() : null);
    if (!repo) continue;
    const present = info && typeof info === "object" ? info.present !== false : true;
    const dir = info && typeof info === "object" && typeof info.dir === "string" ? info.dir : undefined;
    out[repo] = dir === undefined ? { present } : { present, dir };
  }
  return out;
}

// 候选排序（resolveMissing 内使用）：
//   1. 已装优先（present:true 在前）
//   2. 类名精确出现优先：classes 只含这一个类名（该仓库专门提供它）在 multi-class 仓库之前
//   3. 仓库字母序（稳定兜底，确定性输出）
function cmpCandidates(a, b, className) {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  const aExact = a.classes.length === 1;
  const bExact = b.classes.length === 1;
  if (aExact !== bExact) return aExact ? -1 : 1;
  return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
}

// 形态判定：反向索引的值是 [{ repo, ... }]，原始映射表的值是 [classes数组, meta对象]。
// 看第一个值的首元素就知道是哪种，避免对原始表再跑一遍归一化。
function looksLikeReverseIndex(x) {
  if (!x || typeof x !== "object") return false;
  const first = Object.values(x)[0];
  return Array.isArray(first) && first.length > 0
    && first[0] && typeof first[0] === "object" && "repo" in first[0];
}

// 反查 + 已装标注。
//   unknownClasses: string[]
//   reverseIndex: buildReverseIndex 的输出（也容忍原始映射表，内部自动构建）
//   installed: { "owner/repo" | 原始地址: { present, dir } }（可省）
// → [{ className, candidates: [{ repo, title, installed: true|false, dir?, classes }] }]
// candidates 为空数组 = 表里查不到（是否 unresolved 由 summarize 归类）。
// className 重复时后者覆盖前者。
export function resolveMissing(unknownClasses, reverseIndex, installed) {
  if (!Array.isArray(unknownClasses)) {
    throw new Error("resolveMissing: unknownClasses 必须是字符串数组");
  }
  const index = looksLikeReverseIndex(reverseIndex)
    ? reverseIndex
    : buildReverseIndex(reverseIndex ?? {});
  const inst = normalizeInstalled(installed);
  const out = [];
  const seen = new Set();
  for (const className of unknownClasses) {
    if (typeof className !== "string" || !className || seen.has(className)) continue;
    seen.add(className);
    const candidates = (index[className] ?? []).map((c) => {
      const hit = inst[c.repo];
      const base = hit && hit.present === false
        ? { repo: c.repo, title: c.title, installed: false, classes: c.classes }
        : { repo: c.repo, title: c.title, installed: Boolean(hit), classes: c.classes };
      if (hit?.dir !== undefined) base.dir = hit.dir;
      return base;
    });
    candidates.sort((a, b) => cmpCandidates(a, b, className));
    out.push({ className, candidates });
  }
  return out;
}

// 三态摘要。notInstalled / installedNotLoaded 按 repo 去重并合并类名；
// unresolved 逐类列出。输出确定性排序（notInstalled/installedNotLoaded 按 repo 字母序，
// unresolved 按 className 字母序；类名列表按首次出现序去重）。
export function summarize(resolutions) {
  if (!Array.isArray(resolutions)) {
    throw new Error("summarize: resolutions 必须是 resolveMissing 的输出数组");
  }
  const notInstalled = new Map(); // repo → { repo, title, classes: [] }
  const installedNotLoaded = new Map(); // repo → { repo, dir?, title, classes: [] }
  const unresolved = new Set();
  const pushClass = (map, repo, className) => {
    const e = map.get(repo);
    if (!e.classes.includes(className)) e.classes.push(className);
  };
  for (const res of resolutions) {
    const { className, candidates } = res;
    if (!candidates.length) {
      unresolved.add(className);
      continue;
    }
    const missing = candidates.filter((c) => !c.installed);
    if (missing.length) {
      // 有未装候选 → 建议安装；同类的已装候选不进 installedNotLoaded（避免两态互相打架）。
      for (const c of missing) {
        if (!notInstalled.has(c.repo)) notInstalled.set(c.repo, { repo: c.repo, title: c.title, classes: [] });
        pushClass(notInstalled, c.repo, className);
      }
    } else {
      // 所有候选都已装但类没加载出来。
      for (const c of candidates) {
        if (!installedNotLoaded.has(c.repo)) {
          installedNotLoaded.set(c.repo, {
            repo: c.repo,
            title: c.title,
            classes: [],
            ...(c.dir !== undefined ? { dir: c.dir } : {}),
          });
        }
        pushClass(installedNotLoaded, c.repo, className);
      }
    }
  }
  const byRepo = (a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
  return {
    notInstalled: [...notInstalled.values()].sort(byRepo),
    installedNotLoaded: [...installedNotLoaded.values()].sort(byRepo),
    unresolved: [...unresolved].sort().map((className) => ({ className })),
  };
}
