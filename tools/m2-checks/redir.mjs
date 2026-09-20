// M2 测试辅助：读文件 → 302（每次请求重读；用于把浏览器引导到带凭据的长 URL）
import http from "node:http";
import { readFileSync } from "node:fs";

const FILE = "D:\\HanakoWorks\\ComfyUI\\tools\\m2-checks\\logs\\redir-url.txt";
http.createServer((req, res) => {
  let target = "/";
  try { target = readFileSync(FILE, "utf8").trim(); } catch { /* 保持 / */ }
  res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
  res.end("redirect");
}).listen(39399, "127.0.0.1", () => console.log("m2 redir on 39399"));
