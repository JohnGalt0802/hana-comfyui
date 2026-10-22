// check-bridge-syntax.mjs —— 桥文件的「真解析」检查
// 为什么不用 node --check：桥文件含 import，node 会按 ESM 路径解析，对「同块重复 const」
// 这类错误不报（2026-10-12 踩坑：node --check exit 0，但浏览器加载整桥失败）。
// 本脚本剥掉 import 后 new Function 解析，等价浏览器的脚本加载，能抓重复声明。
// 用法：node tools/check-bridge-syntax.mjs [path/to/bridge.js]
// 不带参数时，按 hana-bridge-<ddHHmmss>.js 在 app/bridge/js 下取最新一个（与部署脚本同口径）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_JS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
  "bridge",
  "js",
);

// 取 app/bridge/js 下 hana-bridge-<ddHHmmss>.js 里最新（文件名时间戳最大）的一个
function resolveLatestBridgeJs() {
  let names;
  try {
    names = fs.readdirSync(BRIDGE_JS_DIR);
  } catch (e) {
    console.error(`找不到桥目录：${BRIDGE_JS_DIR}（${e.message}）`);
    process.exit(2);
  }
  const cands = names
    .map((n) => ({ n, m: /^hana-bridge-(\d{8})\.js$/.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m[1].localeCompare(b.m[1]));
  if (cands.length === 0) {
    console.error(`桥目录下没有 hana-bridge-<ddHHmmss>.js：${BRIDGE_JS_DIR}`);
    process.exit(2);
  }
  return path.join(BRIDGE_JS_DIR, cands[cands.length - 1].n);
}

const p = process.argv[2] || resolveLatestBridgeJs();
let s;
try {
  s = fs.readFileSync(p, "utf8");
} catch (e) {
  console.error("读文件失败：", e.message);
  process.exit(2);
}
// 剥掉顶层 import/export（桥在浏览器里不走 ESM；剥掉后仍是等价可执行体）
const stripped = s
  .replace(/^\s*import\s+[^;]*;\s*$/gm, "")
  .replace(/^\s*export\s+/gm, "");
try {
  // eslint-disable-next-line no-new-func
  new Function(stripped);
  console.log("PARSE OK：" + p);
  process.exit(0);
} catch (e) {
  console.error("PARSE FAIL：" + p + "\n  " + e.message);
  process.exit(1);
}
