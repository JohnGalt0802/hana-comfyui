// M3 校准：慢速极小工作流计时（纯 CPU），为 cancel 测试挑选合适时长
// 用法: node calibrate-slow.mjs
const BASE = "http://127.0.0.1:8188";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const variants = {
  V3_long: {
    "1": { class_type: "EmptyImage", inputs: { width: 512, height: 512, batch_size: 1, color: 0 } },
    "2": { class_type: "ImageScaleBy", inputs: { image: ["1", 0], upscale_method: "lanczos", scale_by: 2.0 } },
    "3": { class_type: "ImageScaleBy", inputs: { image: ["2", 0], upscale_method: "lanczos", scale_by: 2.0 } },
    "4": { class_type: "ImageScaleBy", inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: 2.0 } },
    "5": { class_type: "ImageScaleBy", inputs: { image: ["4", 0], upscale_method: "lanczos", scale_by: 0.5 } },
    "6": { class_type: "ImageScaleBy", inputs: { image: ["5", 0], upscale_method: "lanczos", scale_by: 2.0 } },
    "7": { class_type: "ImageScaleBy", inputs: { image: ["6", 0], upscale_method: "lanczos", scale_by: 0.5 } },
    "8": { class_type: "ImageScaleBy", inputs: { image: ["7", 0], upscale_method: "lanczos", scale_by: 2.0 } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "comfyui_hana_m3_cal_v3" } },
  },
};

async function queueState() {
  const q = await (await fetch(`${BASE}/queue`)).json();
  return { running: q.queue_running.length, pending: q.queue_pending.length };
}
async function submit(wf, tag) {
  const t0 = Date.now();
  const r = await (await fetch(`${BASE}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: `m3-cal-${tag}` }) })).json();
  if (!r.prompt_id) { console.log(`${tag}: submit failed`, JSON.stringify(r).slice(0, 300)); return null; }
  for (;;) {
    await sleep(300);
    const h = await (await fetch(`${BASE}/history/${r.prompt_id}`)).json();
    const e = h[r.prompt_id];
    if (e) {
      const ms = Date.now() - t0;
      console.log(`${tag}: ${e.status.completed ? "completed" : "status=" + e.status.status_str} in ${ms} ms`);
      return { pid: r.prompt_id, ms, completed: e.status.completed };
    }
    if (Date.now() - t0 > 120000) { console.log(`${tag}: timeout`); return null; }
  }
}

async function main() {
  const q = await queueState();
  if (q.running || q.pending) { console.log("队列非空，拒绝测试"); process.exit(2); }
  for (const [name, wf] of Object.entries(variants)) {
    const q2 = await queueState();
    if (q2.running || q2.pending) { console.log("队列非空，停止"); break; }
    await submit(wf, name);
    await sleep(500);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
