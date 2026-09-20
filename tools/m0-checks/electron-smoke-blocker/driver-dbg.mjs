// 调试：Electron 下 argv 与 electron 模块可用性；隔离 driver 的 -1 退出原因
import { app } from "electron";

const write = (m) => { try { process.stdout.write(m + "\n"); } catch (e) { console.error(m, e); } };
write("DBG argv=" + JSON.stringify(process.argv));
write("DBG app type=" + typeof app + " setPath=" + typeof app?.setPath);

const P = process.argv.slice(2);
const C = (n) => { const l = P.indexOf(n); return l === -1 ? null : P[l + 1] || null; };
const I = C("--url"), U = C("--profile-dir");
write("DBG url=" + String(I) + " profileDir=" + String(U));

if (I && U) {
  try {
    app.setPath("userData", U);
    app.setPath("sessionData", `${U}-session`);
    write("DBG setPath ok");
  } catch (e) {
    write("DBG setPath ERR " + e);
  }
}
app.whenReady().then(() => { write("DBG whenReady"); app.exit(0); });
setTimeout(() => { write("DBG timeout"); process.exit(4); }, 10000).unref();
