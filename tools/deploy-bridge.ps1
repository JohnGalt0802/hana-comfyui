<#
.SYNOPSIS
  把 Hana-ComfyUI 的画布桥（hana_bridge）部署到本机 ComfyUI 的 custom_nodes 目录。

.DESCRIPTION
  源  ：<项目>\app\bridge（__init__.py + js\hana-bridge.js）
  目标：<ComfyUI 源码根>\custom_nodes\hana_bridge
  只复制源文件；.token（由 ComfyUI 侧首次加载时生成）与 __pycache__ 不参与复制/比对。
  部署或改动后必须重启 ComfyUI 服务才会加载（路由与前端扩展都在启动时注册）。

.PARAMETER Status
  只报告状态（是否已装、文件是否与源一致、token 是否已生成），不做任何写入。

.PARAMETER Remove
  卸载：删除目标目录（需重启 ComfyUI 才真正生效）。

.PARAMETER ComfyRoot
  显式指定 ComfyUI 源码根（含 main.py 的目录）。省略时自动探测。

.EXAMPLE
  pwsh -NoProfile -File tools\deploy-bridge.ps1 -Status
  pwsh -NoProfile -File tools\deploy-bridge.ps1
  pwsh -NoProfile -File tools\deploy-bridge.ps1 -Remove
#>
param(
  [switch]$Status,
  [switch]$Remove,
  [string]$ComfyRoot = ""
)

$ErrorActionPreference = "Stop"
$src = (Resolve-Path (Join-Path $PSScriptRoot "..\app\bridge")).Path
$node = "C:\Program Files\nodejs\node.exe"

function Resolve-ComfyRoot {
  param([string]$Explicit)
  if ($Explicit) {
    $p = Resolve-Path -LiteralPath $Explicit -ErrorAction SilentlyContinue
    if (-not $p) { throw "指定的 ComfyUI 根不存在：$Explicit" }
    return $p.Path
  }
  # 先问中继的环境探测（它本来就是干这个的）；失败再退到常见位置
  $relay = Join-Path $PSScriptRoot "..\app\runtime\comfy-relay.mjs"
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $relay)) {
    try {
      $j = (& $node $relay --probe-env 2>$null | Out-String) | ConvertFrom-Json
      $hit = $j.installs | Where-Object { $_.mainPy } | Select-Object -First 1
      if ($hit) { return (Split-Path $hit.mainPy -Parent) }
    } catch { }
  }
  foreach ($c in @("D:\ComfyUI\ComfyUI", "D:\ComfyUI", "C:\ComfyUI\ComfyUI", "C:\ComfyUI")) {
    if (Test-Path -LiteralPath (Join-Path $c "main.py")) { return $c }
  }
  throw "没能自动找到 ComfyUI 源码根（缺 main.py）；请用 -ComfyRoot 指定"
}

function Get-SourceFiles {
  Get-ChildItem -LiteralPath $src -Recurse -File |
    Where-Object { $_.Name -ne ".token" -and $_.FullName -notmatch "\\__pycache__\\" }
}

$root = Resolve-ComfyRoot -Explicit $ComfyRoot
$dst = Join-Path $root "custom_nodes\hana_bridge"
Write-Output "源  ：$src"
Write-Output "目标：$dst"

if ($Remove) {
  if (Test-Path -LiteralPath $dst) {
    Remove-Item -LiteralPath $dst -Recurse -Force
    Write-Output "已卸载。重启 ComfyUI 后生效。"
  } else {
    Write-Output "目标不存在，无需卸载。"
  }
  return
}

if ($Status) {
  $files = Get-SourceFiles
  $diff = @()
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($src.Length).TrimStart("\")
    $t = Join-Path $dst $rel
    if (-not (Test-Path -LiteralPath $t)) { $diff += "缺 $rel"; continue }
    if ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $t -Algorithm SHA256).Hash) { $diff += "异 $rel" }
  }
  $tokenPath = Join-Path $dst ".token"
  Write-Output ("已安装       ：{0}" -f (Test-Path -LiteralPath (Join-Path $dst "__init__.py")))
  Write-Output ("源文件       ：{0} 个" -f $files.Count)
  Write-Output ("与源不一致   ：{0}" -f $(if ($diff.Count) { $diff -join " / " } else { "无" }))
  Write-Output ("token 已生成 ：{0}" -f (Test-Path -LiteralPath $tokenPath))
  return
}

$files = Get-SourceFiles
foreach ($f in $files) {
  $rel = $f.FullName.Substring($src.Length).TrimStart("\")
  $t = Join-Path $dst $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $t -Parent) | Out-Null
  Copy-Item -LiteralPath $f.FullName -Destination $t -Force
}
Write-Output ("已部署 {0} 个文件（.token 保持原样，由 ComfyUI 侧生成）。重启 ComfyUI 后生效。" -f $files.Count)
