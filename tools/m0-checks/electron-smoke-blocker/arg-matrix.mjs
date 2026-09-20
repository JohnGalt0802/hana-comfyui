// 变体矩阵：定位 Electron 静默 -1 的触发参数
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const electron = "D:\\HanakoWorks\\ComfyUI\\_build\\electron\\electron.exe";
const dbg = "D:\\HanakoWorks\\ComfyUI\\_scratch\\driver-dbg.mjs";
const prof = "D:\\HanakoWorks\\ComfyUI\\_scratch\\ep-matrix";
mkdirSync(prof, { recursive: true });

const cases = [
  ["A url+profiledir", ["--url", "about:blank", "--profile-dir", prof]],
  ["B url+foodir", ["--url", "about:blank", "--foo", prof]],
  ["C httpurl+foo1", ["--url", "http://127.0.0.1:8188/", "--foo", "1"]],
  ["D x+profileDir", ["--url", "x", "--profile-dir", prof]],
  ["E swap-cwdserver", ["--profile-dir", prof, "--url", "about:blank"]],
];
const CWD = "C:\\Users\\John Galt\\.hanako\\artifacts\\server\\0.1013.2-win32-x64-0c4a512d36b007db-ge82f5aaf7ce9a6df";

function runCase(name, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [dbg, ...args], { stdio: ["ignore", "pipe", "pipe"], env, cwd: name === "E swap-cwdserver" ? CWD : undefined });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve(`${name}: SPAWN ERROR ${e}`));
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(`${name}: TIMEOUT\nOUT:${out}\nERR:${err}`); }, 15000);
    child.on("close", (code, signal) => {
      clearTimeout(t);
      resolve(`${name}: close code=${code} signal=${signal}\nOUT:${out.trim()}\nERR:${err.trim()}`);
    });
  });
}

for (const [name, args] of cases) {
  console.log("==== " + name + " ====");
  console.log(await runCase(name, args));
  console.log("");
}
