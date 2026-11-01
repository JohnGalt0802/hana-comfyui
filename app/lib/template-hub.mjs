// app/lib/template-hub.mjs — 模板库内核：官方模板索引 → 可检索 / 可判可跑 / 可对账缺模型的纯函数。
// 纯函数模块：不 fetch、不 fs、不 process、不读盘。索引内容与模型清单都由调用方传入。
// 数据契约（探索实测，2026-11-02）：
//   mcp 索引  = [{ category, description, templates: [...] }]，字段规范，检索用这份。
//   zh 索引   = [{ moduleName, type, category, icon, title, templates: [...] }]，字段比 mcp 多
//               mediaType / tags / models / date / thumbnail 等，按 name 对齐补中文。
//   两份不同构；mcp 条目是 zh 的子集（实际数据 zh 有 mcp 没有的条目），对不上的回落英文。
// ─────────────────────────────────────────────────────────────────────────────

// zh 索引模板里对齐 mcp 条目时取的中文补充字段
const ZH_PICK = ["mediaType", "tags", "models", "date", "size", "thumbnail"];

/**
 * 把 mcp 索引 + zh 索引合成一份扁平目录。
 * @returns {Array<{name,title,titleZh,category,task,model,mediaType,tags,workflowTags,
 *   freshness,usage,recommend,description,descriptionZh,minComfyUIVersion,io,capabilities,hasZh}>}
 */
export function buildCatalog({ mcpIndex, zhIndex }) {
  if (!Array.isArray(mcpIndex)) throw new TypeError("mcpIndex 必须是分类数组");
  const zhByName = new Map();
  if (zhIndex !== undefined && zhIndex !== null) {
    if (!Array.isArray(zhIndex)) throw new TypeError("zhIndex 必须是模块数组");
    for (const mod of zhIndex) {
      for (const t of mod.templates || []) {
        if (t && t.name && !zhByName.has(t.name)) zhByName.set(t.name, t);
      }
    }
  }

  const rows = [];
  for (const cat of mcpIndex) {
    for (const t of cat.templates || []) {
      const zh = zhByName.get(t.name);
      const row = {
        name: t.name,
        title: t.title,
        titleZh: undefined,
        category: cat.category,
        task: t.task,
        model: t.model,
        mediaType: undefined,
        tags: undefined,
        workflowTags: t.capabilities?.workflow || [],
        freshness: t.freshness,
        usage: t.usage ?? 0,
        recommend: t.recommend,
        description: t.description,
        descriptionZh: undefined,
        minComfyUIVersion: t.minComfyUIVersion,
        io: t.io,
        capabilities: t.capabilities,
        hasZh: Boolean(zh),
      };
      if (zh) {
        for (const k of ZH_PICK) row[k] = zh[k];
        row.titleZh = zh.title;
        row.descriptionZh = zh.description;
      }
      rows.push(row);
    }
  }
  return rows;
}

/** 自然序（usage 降序、同数按 name 升序），searchCatalog 无显式 sort 时的缺省。 */
function byUsageDesc(a, b) {
  if (b.usage !== a.usage) return b.usage - a.usage;
  return String(a.name).localeCompare(String(b.name));
}

const SEARCH_FIELDS = ["name", "title", "titleZh", "description", "descriptionZh", "model"];

/**
 * 目录检索。q 大小写不敏感、全字段子串匹配（含中文字段）；其余条件精确匹配。
 * @returns {{total:number, shown:number, offset:number, rows:Array}}
 */
export function searchCatalog(catalog, { q, task, model, mediaType, tag, recommend, limit = 20, offset = 0, sort = byUsageDesc } = {}) {
  if (!Array.isArray(catalog)) throw new TypeError("catalog 必须是数组");
  let rows = catalog;
  if (q !== undefined && q !== null && q !== "") {
    const needle = String(q).toLowerCase();
    rows = rows.filter((t) => SEARCH_FIELDS.some((f) => typeof t[f] === "string" && t[f].toLowerCase().includes(needle)));
  }
  if (task !== undefined && task !== null) rows = rows.filter((t) => t.task === task);
  if (model !== undefined && model !== null) rows = rows.filter((t) => t.model === model);
  if (mediaType !== undefined && mediaType !== null) rows = rows.filter((t) => t.mediaType === mediaType);
  if (recommend !== undefined && recommend !== null) rows = rows.filter((t) => t.recommend === recommend);
  if (tag !== undefined && tag !== null) {
    rows = rows.filter((t) => (t.tags || []).includes(tag) || t.workflowTags.includes(tag));
  }
  if (sort) rows = [...rows].sort(sort);

  const total = rows.length;
  const start = Math.max(0, offset);
  const page = limit > 0 ? rows.slice(start, start + limit) : rows.slice(start);
  return { total, shown: page.length, offset: start, rows: page };
}

/**
 * "0.43.0" 式版本比较，按 "." 切段逐段转数值比（位数不齐时缺段按 0）。
 * 非法输入抛 TypeError，不用字典序兜底——宁可炸也不出错的排序。
 * @returns {-1|0|1}
 */
export function compareVersion(a, b) {
  const parse = (v, label) => {
    if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v.trim())) {
      throw new TypeError(`${label} 不是 "x.y.z" 数字版本串: ${JSON.stringify(v)}`);
    }
    return v.trim().split(".").map(Number);
  };
  const pa = parse(a, "a");
  const pb = parse(b, "b");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/**
 * 模板在本机版本上能不能跑。没有 minComfyUIVersion 视为无门槛、可跑。
 * @returns {{runnable:true} | {runnable:false, reason:string}}
 */
export function runnableCheck(template, comfyuiVersion) {
  const min = template?.minComfyUIVersion;
  if (!min) return { runnable: true };
  if (compareVersion(comfyuiVersion, min) < 0) {
    return { runnable: false, reason: `minComfyUIVersion ${min} > 本机 ${comfyuiVersion}` };
  }
  return { runnable: true };
}

/**
 * 收集模板 JSON 里 properties.models[]（三字段 name/url/directory）。
 * 顶层 nodes 与 definitions.subgraphs[].nodes[] 都收，深度优先递归，同一模型对象只报一次。
 * @returns {Array<{name,url,directory}>}
 */
export function collectRequiredModels(templateJson) {
  const out = [];
  const seen = new Set();
  const visit = (node) => {
    const models = node?.properties?.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (m && typeof m.name === "string" && !seen.has(m.name)) {
          seen.add(m.name);
          out.push({ name: m.name, url: m.url, directory: m.directory });
        }
      }
    }
  };
  for (const n of templateJson?.nodes || []) visit(n);
  for (const sg of templateJson?.definitions?.subgraphs || []) {
    for (const n of sg?.nodes || []) visit(n);
  }
  return out;
}

/**
 * 缺模型对账。required 来自 collectRequiredModels；installed 形如
 * { "<directory>": ["<filename>", ...] }。directory 与文件名都精确匹配、大小写敏感
 * （Windows 文件系统虽然不区分大小写，这里按原样比，调用方如需宽松匹配自行预处理）。
 * @returns {{missing:Array<{name,url,directory}>, present:Array<{name,url,directory}>}}
 */
export function diffModels(required, installed) {
  const missing = [];
  const present = [];
  for (const m of required) {
    const bucket = installed?.[m.directory];
    const ok = Array.isArray(bucket) && bucket.includes(m.name);
    (ok ? present : missing).push(m);
  }
  return { missing, present };
}
