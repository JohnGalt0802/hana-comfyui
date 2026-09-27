<#
.SYNOPSIS
  重载 hana_bridge 前端扩展并冒烟测试（一步到位）。

.DESCRIPTION
  做三件事，顺序固定：
    1. 给 app/bridge/js 下的扩展 js 换一个带时间戳的新文件名（**这是关键**：
       浏览器对同一 URL 的 js 会顽固缓存，连无痕窗口都不例外 —— 实测
       改名是唯一可靠的绕过方式；ComfyUI 会扫目录自动加载新文件）
    2. 部署到 custom_nodes/hana_bridge 并重启 ComfyUI
    3. 打开一个新页面，等扩展注册，用「定向」方式调指定 op

  为什么必须定向：ComfyUI 侧 send_sync 是广播，浏览器里残留的旧页面
  （仍在跑旧 js）可能抢先回传，导致拿到过期结果。定向（带 sid）才可靠。

.PARAMETER Op
  要冒烟测试的 op，默认 api.probe。

.PARAMETER ArgsJson
  该 op 的参数 JSON，默认 {}。

.PARAMETER NoRestart
  跳过重启（仅部署）。

.PARAMETER NoOpen
  跳过开浏览器（已有页面在线时用）。

.EXAMPLE
  pwsh -NoProfile -File tools\bridge-reload.ps1
  pwsh -NoProfile -File tools\bridge-reload.ps1 -Op api.diag
#>
param(
  [string]$Op = "api.probe",
  [string]$ArgsJson = "{}",
  [switch]$NoRestart,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$proj = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$srcDir = Join-Path $proj "app\bridge\js"
$dstDir = "D:\ComfyUI\ComfyUI\custom_nodes\hana_bridge\js"
$tokenFile = "D:\ComfyUI\ComfyUI\custom_nodes\hana_bridge\.token"
$node = "C:\Program Files\nodejs\node.exe"

# ---- 1) 改名（绕缓存）----
Write-Output "[1/4] 给扩展 js 换新文件名（绕过浏览器缓存）"
$old = Get-ChildItem $srcDir -File -Filter "hana-bridge*.js" -ErrorAction SilentlyContinue | Select-Object -First 1
$newName = "hana-bridge-" + (Get-Date -Format "ddHHmmss") + ".js"
if ($old) { Rename-Item $old.FullName $newName -Force } else { throw "源目录里没有 hana-bridge*.js" }
Write-Output ("      源：{0} → {1}" -f $old.Name, $newName)

# ---- 2) 语法检查 + 部署 ----
Write-Output "[2/4] 语法检查并部署"
$tmp = Join-Path $env:TEMP ("hb-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item (Join-Path $srcDir $newName) (Join-Path $tmp "h.mjs") -Force
& $node --check (Join-Path $tmp "h.mjs") 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "扩展 js 语法检查失败，已中止部署" }
Remove-Item $dstDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item (Join-Path $srcDir $newName) (Join-Path $dstDir $newName) -Force
Write-Output ("      已部署：{0}" -f $newName)

# ---- 3) 重启 ----
if (-not $NoRestart) {
  Write-Output "[3/4] 重启 ComfyUI"
  $pids = (netstat -ano | Select-String ":8188\s+\S+\s+LISTENING") |
    ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Select-Object -Unique
  foreach ($p in $pids) { taskkill /F /T /PID $p 2>&1 | Out-Null }
  Start-Sleep -Seconds 3
  schtasks /run /tn HanaComfyUI-Backend 2>&1 | Out-Null
  $ready = $false
  for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 5
    $c = (& curl.exe -sS --max-time 4 -o NUL -w "%{http_code}" "http://127.0.0.1:8188/system_stats" 2>&1) -join ""
    if ($c -eq "200") { Write-Output ("      就绪（{0}s）" -f ($i * 5)); $ready = $true; break }
  }
  if (-not $ready) { throw "ComfyUI 未在 150s 内就绪" }
} else {
  Write-Output "[3/4] 跳过重启"
}

# ---- 4) 开页面 + 定向冒烟 ----
$tk = (Get-Content $tokenFile -Raw).Trim()
if (-not $NoOpen) {
  Write-Output "[4/4] 开新页面并冒烟测试"
  Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    -ArgumentList "--incognito", "--new-window", ("http://127.0.0.1:8188/?b=" + $newName) | Out-Null
  Start-Sleep -Seconds 25
} else {
  Write-Output "[4/4] 跳过开页面，直接冒烟"
}

$pages = (& curl.exe -sS --max-time 20 -X POST "http://127.0.0.1:8188/api/hana_bridge/call" `
  -H "x-hana-token: $tk" -H "Content-Type: application/json" -d '{"op":"canvas.pages","args":{}}' 2>&1) -join ""
$list = ($pages | ConvertFrom-Json).data.pages
if (-not $list -or $list.Count -eq 0) { throw "没有在线页面（扩展未注册？）" }
Write-Output ("      在线页面 {0} 个" -f $list.Count)

foreach ($pg in $list) {
  $sid = if ($pg.sidFull) { $pg.sidFull } else { $pg.sid }
  $body = (@{ op = $Op; args = ($ArgsJson | ConvertFrom-Json); sid = $sid } | ConvertTo-Json -Depth 8 -Compress)
  $r = (& curl.exe -sS --max-time 40 -X POST "http://127.0.0.1:8188/api/hana_bridge/call" `
    -H "x-hana-token: $tk" -H "Content-Type: application/json" -d $body 2>&1) -join ""
  Write-Output ("      sid={0} → {1}" -f $pg.sid, $r.Substring(0, [Math]::Min(1500, $r.Length)))
}
