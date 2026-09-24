# sync-to-host.ps1 — Hana-ComfyUI 开发仓 → 宿主副本同步
# ─────────────────────────────────────────────────────────────────────────────
# 用法：
#   powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1 -DryRun    # 只打印将发生的差异（不写盘）
#   powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1            # 实际同步（副本已存在时）
#   powershell -File D:\HanakoWorks\ComfyUI\tools\sync-to-host.ps1 -Create    # 首次创建宿主副本目录
#
# 行为：
#   1. robocopy /E（增量覆盖，不 purge 删除；排除 .git）→ 打印差异统计
#   2. 同步后全量核对（相对路径 + SHA-256，排除 .git）→ 报告不一致条目（-SkipVerify 可跳过）
#   3. robocopy 退出码 0-7 视为成功，≥8 报错
#
# 纪律：宿主安装/重启是独立阶段（由主脑统一安排）；本脚本只负责"复制 + 校验"。
# ─────────────────────────────────────────────────────────────────────────────
[CmdletBinding()]
param(
  [string]$Source = 'D:\HanakoWorks\ComfyUI\app',
  [string]$Target = 'C:\Users\John Galt\.hanako\apps\comfyui-hana',
  [switch]$DryRun,
  [switch]$Create,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── 前置检查 ────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Source -PathType Container)) { Fail "源目录不存在：$Source" }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'manifest.json'))) { Fail "源目录缺少 manifest.json：$Source" }
$srcManifest = Get-Content -Raw -LiteralPath (Join-Path $Source 'manifest.json') | ConvertFrom-Json
if ($srcManifest.id -ne 'comfyui-hana') { Fail "源 manifest.id 不是 comfyui-hana（收到 $($srcManifest.id)）" }

$targetExists = Test-Path -LiteralPath $Target -PathType Container
if (-not $targetExists -and -not $Create -and -not $DryRun) {
  Fail "目标目录不存在：$Target`n首次安装/建副本是独立阶段——确认要做时追加 -Create 参数（或先 -DryRun 预览）。"
}
if ($targetExists) {
  $tManifestPath = Join-Path $Target 'manifest.json'
  if (Test-Path -LiteralPath $tManifestPath) {
    $tManifest = Get-Content -Raw -LiteralPath $tManifestPath | ConvertFrom-Json
    if ($tManifest.id -ne 'comfyui-hana') { Fail "目标目录 manifest.id 不是 comfyui-hana（收到 $($tManifest.id)），拒绝覆盖：$Target" }
  } else {
    # 目标存在但没有 manifest.json：仅当目录为空（或只有 .git）时允许
    $others = @(Get-ChildItem -LiteralPath $Target -Force | Where-Object { $_.Name -ne '.git' })
    if ($others.Count -gt 0 -and -not $Create) { Fail "目标目录非空且没有 manifest.json，拒绝覆盖：$Target（确认要重建请加 -Create）" }
  }
}

Write-Host "源：  $Source"
Write-Host "目标：$Target"
Write-Host "模式：$(if ($DryRun) { 'DryRun（只列差异，不写盘）' } else { '同步' })$(if ($Create) { ' + Create' } else { '' })"
Write-Host ''

# ── robocopy 同步 ──────────────────────────────────────────────────────────
$roboArgs = @($Source, $Target, '/E', '/XO', '/XD', '.git', '/XF', '.DS_Store', '/NFL', '/NDL', '/NP', '/R:2', '/W:1')
if ($DryRun) { $roboArgs += '/L' }

Write-Host '── robocopy ─────────────────────────────────────────────'
& robocopy @roboArgs
$rc = $LASTEXITCODE
Write-Host '──────────────────────────────────────────────────────────'
if ($rc -ge 8) { Fail "robocopy 失败（退出码 $rc）——目标可能被占用或权限不足。" }
Write-Host "robocopy 退出码 $rc（0-7 视为成功）$(if ($rc -eq 0) { '：无差异（副本已是最新）' })"
Write-Host ''

# ── DryRun：结束 ───────────────────────────────────────────────────────────
if ($DryRun) {
  Write-Host "DryRun 完成：以上为将会复制/更新的内容（未写盘）。"
  exit 0
}

# ── 全量核对（相对路径 + SHA-256，排除 .git）────────────────────────────────
if (-not $SkipVerify) {
  Write-Host '── 副本核对（SHA-256，排除 .git）─────────────────────────'
  function Get-RelHashes([string]$root) {
    $map = @{}
    Get-ChildItem -LiteralPath $root -Recurse -File -Force |
      Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' } |
      ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('/', '\')
        $map[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      }
    return $map
  }
  $srcHashes = Get-RelHashes $Source
  $dstHashes = Get-RelHashes $Target
  $missing = @($srcHashes.Keys | Where-Object { -not $dstHashes.ContainsKey($_) })
  $extra = @($dstHashes.Keys | Where-Object { -not $srcHashes.ContainsKey($_) })
  $diff = @($srcHashes.Keys | Where-Object { $dstHashes.ContainsKey($_) -and $dstHashes[$_] -ne $srcHashes[$_] })
  Write-Host ("源文件 {0} 个 · 副本文件 {1} 个 · 缺失 {2} · 多出 {3} · 内容不一致 {4}" -f $srcHashes.Count, $dstHashes.Count, $missing.Count, $extra.Count, $diff.Count)
  foreach ($m in $missing) { Write-Host "  缺失: $m" -ForegroundColor Yellow }
  foreach ($e in $extra) { Write-Host "  多出: $e" -ForegroundColor DarkYellow }
  foreach ($d in $diff) { Write-Host "  不一致: $d" -ForegroundColor Yellow }
  if ($missing.Count -eq 0 -and $diff.Count -eq 0) { Write-Host '一致 ✓' -ForegroundColor Green } else { Write-Host '存在差异（见上）' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '同步完成。宿主生效方式（独立阶段）：reload 或重启宿主，由主脑统一安排。'
