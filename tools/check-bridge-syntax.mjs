// check-bridge-syntax.mjs —— 桥文件的「真解析」检查
// 为什么不用 node --check：桥文件含 import，node 会按 ESM 路径解析，对「同块重复 const」
// 这类错误不报（2026-10-12 踩坑：node --check exit 0，但浏览器加载整桥失败）。
// 本脚本剥掉 import 后 new Function 解析，等价浏览器的脚本加载，能抓重复声明。
// 用法：node tools/check-bridge-syntax.mjs <path/to/bridge.js>
import fs from "node:fs";

const p = process.argv[2] || "app/bridge/js/hana-bridge-14194557.js";
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
