// V3 测试辅助：极简重定向服务（读文件 → 302；每次请求重新读文件，方便切换目标）
import http from "node:http";
import { readFileSync } from "node:fs";

const FILE = "D:\\HanakoWorks\\ComfyUI\\docs\\m0-results\\host\\V3-browser-url.txt";
http.createServer((req, res) => {
  let target = "/";
  try { target = readFileSync(FILE, "utf8").trim(); } catch { /* 保持 / */ }
  res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
  res.end("redirect");
}).listen(39299, "127.0.0.1", () => console.log("redirect server on 39299 (file-driven)"));
