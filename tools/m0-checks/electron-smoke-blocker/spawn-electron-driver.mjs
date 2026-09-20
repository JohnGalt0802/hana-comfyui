// 直接复刻 smoke runner 的 spawn 方式，看 electron driver 的真实 stdout/stderr/exit
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const electron = "D:\\HanakoWorks\\ComfyUI\\_build\\electron\\electron.exe";
const driver = "C:\\Users\\John Galt\\.hanako\\artifacts\\server\\0.1013.2-win32-x64-0c4a512d36b007db-ge82f5aaf7ce9a6df\\scripts\\app-validation-electron-driver.mjs";
const prof = "D:\\HanakoWorks\\ComfyUI\\_scratch\\ep6";
mkdirSync(prof, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_ENABLE_LOGGING = "1";

const child = spawn(electron, [driver, "--url", "about:blank", "--profile-dir", prof, "--require-sdk-ready", "false", "--require-document-status", "false", "--timeout-ms", "5000"], {
  stdio: ["ignore", "pipe", "pipe"],
  env,
});
child.stdout.on("data", (d) => console.log("OUT>", d.toString().trimEnd()));
child.stderr.on("data", (d) => console.log("ERR>", d.toString().trimEnd()));
child.on("error", (e) => console.log("SPAWN ERROR", e));
child.on("close", (code, signal) => {
  console.log("CLOSE code=", code, "signal=", signal);
  process.exit(0);
});
setTimeout(() => { console.log("TIMEOUT - killing"); child.kill("SIGKILL"); }, 30000);
