# electron-smoke-blocker — 官方 --smoke UI 半场受阻的最小复现材料（见 docs/M0-验证记录.md §2.2）

- arg-matrix.mjs：参数形态矩阵（改 electron 路径为你要测的运行时）
  运行：node arg-matrix.mjs
  已知结论（stock Electron v33.4.11 / v42.3.3 均复现）：
    [script, "--url", <URL>, <更多参数>] → 即刻退出（-1，无输出）
    [script, "--profile-dir", <dir>, "--url", <URL>]（调换顺序）/ [script, "--url", "x", ...] → 正常
- driver-dbg.mjs：探针脚本（打印 argv / electron 模块 / setPath），配合 arg-matrix 判定"失败发生在 JS 之前"
- spawn-electron-driver.mjs：按官方 runner 的方式 spawn（stdio 管道），观察 exit/stdout
