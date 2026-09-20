# M0 中继本地实测 · 主测试套件（依次跑七个测试并落盘输出摘要）
# 用法：powershell -File run-all-tests.ps1 [-Electron <electron.exe 路径>]
# 产物：D:\HanakoWorks\ComfyUI\docs\m0-results\*.txt
param(
  [string]$Electron = 'D:\HanakoWorks\ComfyUI\_build\electron-v33\electron.exe'
)
$ErrorActionPreference = 'Continue'
$root = 'D:\HanakoWorks\ComfyUI'
$res = Join-Path $root 'docs\m0-results'
New-Item -ItemType Directory -Force -Path $res | Out-Null

function Run-Test([string]$name, [scriptblock]$body) {
  Write-Host "==================== $name ===================="
  $out = & $body 2>&1 | Out-String
  Write-Host $out
  [System.IO.File]::WriteAllText((Join-Path $res "$name.txt"), $out)
}

Run-Test '01-basic-http' { pwsh -NoProfile -File "$root\tools\m0-checks\test-relay-basic.ps1" }
Run-Test '02-ws-binary' { node "$root\tools\m0-checks\test-relay-ws-binary.mjs" }
Run-Test '03-ws-comfy-relay' { node "$root\tools\m0-checks\test-relay-ws-comfy.mjs" 39241 }
Run-Test '04-ws-comfy-direct' { node "$root\tools\m0-checks\test-relay-ws-comfy.mjs" --direct }
Run-Test '05-exit-codes' { pwsh -NoProfile -File "$root\tools\m0-checks\test-exit-codes.ps1" }
Run-Test '06-prefix-sim' { node "$root\tools\m0-checks\test-prefix-sim.mjs" }
Run-Test '07-ui-precheck' {
  if (Test-Path $Electron) {
    # GUI 子进程可能残留句柄，用文件重定向 + 超时保障（不走管道）
    $outFile = Join-Path $res '07-ui-precheck.txt'
    $errFile = Join-Path $res '07-ui-precheck.err.txt'
    $p = Start-Process -FilePath 'node' -ArgumentList @(
      "$root\tools\m0-checks\run-electron-harness.mjs", $Electron, "$root\tools\m0-checks\ui-precheck.mjs", '--app-dir', "$root\app"
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $p.WaitForExit(150000)) { try { $p.Kill() } catch {}; Add-Content $outFile "`n[超时：ui-precheck 150s 未结束，已终止]" }
    Get-Content $outFile -ErrorAction SilentlyContinue
    "---- steps ----"
    Get-Content "$root\tools\m0-checks\ui-precheck.log" -ErrorAction SilentlyContinue
  } else {
    "SKIP：未指定可用的 Electron（$Electron）——本地 UI 预检需要 Electron 运行时"
  }
}

Write-Host "`n全部完成，输出在 $res"
