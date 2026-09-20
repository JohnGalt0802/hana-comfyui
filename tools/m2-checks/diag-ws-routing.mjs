// 诊断：ComfyUI /ws 事件路由 —— 提交方 client_id 与订阅方 client_id 的关系
// 步骤：① 开一个 WS（clientId=dbg-A）② 提交（client_id=dbg-A）③ 开另一个 WS（clientId=dbg-B）④ 再提交（client_id=dbg-B）
// 观察两个连接各自收到什么。
const PORT = 8188;
const results = [];

function openWs(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=${id}`);
    const msgs = [];
    ws.addEventListener("open", () => resolve({ id, ws, msgs }));
    ws.addEventListener("message", (ev) => {
      const t = typeof ev.data === "string" ? ev.data : "(bin)";
      let type = "?";
      try { type = JSON.parse(t).type; } catch {}
      msgs.push({ at: Date.now(), type });
    });
    setTimeout(() => resolve({ id, ws, msgs }), 1500);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(clientId, tag) {
  const wf = {
    "1": { class_type: "EmptyImage", inputs: { width: 32, height: 32, batch_size: 1, color: 0 } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: `comfyui_hana_dbg_${tag}` } },
  };
  const r = await fetch(`http://127.0.0.1:${PORT}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: clientId }) });
  return (await r.json()).prompt_id;
}

async function main() {
  const q = await (await fetch(`http://127.0.0.1:${PORT}/queue`)).json();
  if (q.queue_running.length || q.queue_pending.length) { console.log("队列非空，拒绝测试"); process.exit(2); }

  const A = await openWs("dbg-A");
  await sleep(300);
  const pidA = await submit("dbg-A", "a");
  await sleep(1500);

  const B = await openWs("dbg-B");
  await sleep(300);
  const pidB = await submit("dbg-B", "b");
  await sleep(1500);

  const summarize = (c, pid) => ({
    id: c.id,
    total: c.msgs.length,
    types: c.msgs.map((m) => m.type).join(","),
    hasPid: c.msgs.filter((m) => JSON.stringify(m).includes(pid)).length,
  });
  console.log("A 收到：", JSON.stringify(summarize(A, pidA)));
  console.log("B 收到：", JSON.stringify(summarize(B, pidB)));
  console.log("A 消息明细：", JSON.stringify(A.msgs));
  console.log("B 消息明细：", JSON.stringify(B.msgs));
  A.ws.close(); B.ws.close();
  await sleep(300);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
