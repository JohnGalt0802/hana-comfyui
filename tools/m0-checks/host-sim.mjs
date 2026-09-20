// 模拟宿主受管服务代理（本地预演用，不是交付物）：
//   /api/apps/comfyui-hana/routes/_runtime/<rid>/<rest...>  → 剥前缀 → 原样转发到中继
// 用法: node host-sim.mjs <listenPort|39150> <relayPort|39123>
import http from "node:http";
import net from "node:net";

const PORT = Number(process.argv[2] || 39150);
const RELAY_PORT = Number(process.argv[3] || 39123);
const PREFIX = "/api/apps/comfyui-hana/routes/_runtime/";

function strip(url) {
  if (!url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length); // <rid>/<rest...>
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "/";
}

const server = http.createServer((req, res) => {
  const target = strip(req.url || "/");
  if (target === null) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not under prefix"); return; }
  const up = http.request({ host: "127.0.0.1", port: RELAY_PORT, method: req.method, path: target, headers: req.headers });
  up.on("response", (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", (e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end("sim upstream error: " + e.message); });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const target = strip(req.url || "/");
  if (target === null) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  const up = net.connect(RELAY_PORT, "127.0.0.1", () => {
    const lines = [`GET ${target} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else lines.push(`${k}: ${v}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => { try { socket.destroy(); } catch {} });
  socket.on("error", () => { try { up.destroy(); } catch {} });
});

server.listen(PORT, "127.0.0.1", () => console.log(`host-sim listening 127.0.0.1:${PORT} → relay:${RELAY_PORT}（剥前缀 ${PREFIX}）`));
