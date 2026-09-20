// 用 node 驱动 electron 跑 ui-precheck（可靠捕获 stdout/exit）
import { spawn } from "node:child_process";

const electron = process.argv[2];
const args = process.argv.slice(3);
const child = spawn(electron, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
let out = "", err = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { err += d.toString(); });
child.on("close", (code) => {
  console.log("EXIT:", code);
  console.log("---- stdout ----");
  console.log(out.trim() || "(empty)");
  console.log("---- stderr ----");
  console.log(err.trim() || "(empty)");
  process.exit(0);
});
const killer = setTimeout(() => { child.kill("SIGKILL"); }, 90000);
killer.unref?.();
