// 本地 UI 预检（非官方 smoke，v2）：单个复用窗口逐个加载 ui/ 页面（file://），
// 记录 console 消息 / 可见文本 / 渲染进程异常；结果实时落盘。
// 用法: electron.exe ui-precheck.mjs --app-dir <appDir>
import { app, BrowserWindow } from "electron";
import { readdirSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

app.disableHardwareAcceleration();
const LOG = "D:\\HanakoWorks\\ComfyUI\\tools\\m0-checks\\ui-precheck.log";
const step = (m) => { try { appendFileSync(LOG, new Date().toISOString() + " " + m + "\n"); } catch {} };
step("start argv=" + JSON.stringify(process.argv));
process.on("uncaughtException", (e) => { step("uncaughtException " + ((e && e.stack) || e)); });
process.on("unhandledRejection", (e) => { step("unhandledRejection " + ((e && e.stack) || e)); });
app.on("window-all-closed", () => { step("window-all-closed（抑制退出）"); });
app.on("render-process-gone", (_e, _wc, d) => step("app render-process-gone " + JSON.stringify(d)));

const idx = process.argv.indexOf("--app-dir");
const appDir = idx >= 0 ? process.argv[idx + 1] : process.argv[process.argv.length - 1];
const uiDir = path.join(appDir, "ui");
const pages = readdirSync(uiDir).filter((f) => f.endsWith(".html"));
step("pages=" + JSON.stringify(pages));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  step("whenReady");
  const win = new BrowserWindow({ width: 1024, height: 700, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const results = [];
  for (const page of pages) {
    const messages = [];
    const onConsole = (...args) => {
      try {
        const level = typeof args[1] === "number" ? args[1] : (args[0] && args[0].level);
        const message = typeof args[2] === "string" ? args[2] : (args[0] && args[0].message);
        messages.push({ level, message: String(message || "").slice(0, 400) });
      } catch { /* 忽略 */ }
    };
    const onGone = (_e, d) => messages.push({ level: 3, message: "render-process-gone " + JSON.stringify(d) });
    win.webContents.on("console-message", onConsole);
    win.webContents.on("render-process-gone", onGone);
    const url = pathToFileURL(path.join(uiDir, page)).href;
    let loadError = null;
    try {
      await win.loadURL(url);
      await sleep(2500);
    } catch (e) {
      loadError = String((e && e.message) || e).slice(0, 300);
    }
    let visibleText = "", hasRenderable = false;
    try {
      const r = await win.webContents.executeJavaScript(`(() => {
        const text = String(document.body ? document.body.innerText : '').trim().slice(0, 400);
        const vis = Array.from(document.querySelectorAll('body *')).some((n) => { try { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; } catch { return false; } });
        return { text, vis };
      })()`, true);
      visibleText = r.text; hasRenderable = r.vis;
    } catch (e) {
      messages.push({ level: 3, message: "executeJavaScript failed: " + String((e && e.message) || e).slice(0, 300) });
    }
    win.webContents.off("console-message", onConsole);
    win.webContents.off("render-process-gone", onGone);
    const rec = { page, loadError, visibleText, hasRenderable, messages };
    results.push(rec);
    step(`RESULT ${page} loadError=${loadError} textLen=${visibleText.length} renderable=${hasRenderable} msgs=${messages.length}`);
    for (const m of messages) step(`  msg[${m.level}] ${m.message}`);
  }
  console.log(JSON.stringify({ uiDir, count: results.length, results }, null, 2));
  step("done");
  app.exit(0);
});
setTimeout(() => { step("timeout-exit"); app.exit(2); }, 120_000).unref();
