# validate-app.ps1 — 对开发仓（目录名 app）做官方校验
# 说明：官方校验/装载要求目录名 == manifest.id（comfyui-hana），开发仓目录名为 app，
#       因此先 robocopy 一份到 staging（默认 _build\validate\comfyui-hana），再跑校验器。
# 用法：
#   powershell -File D:\HanakoWorks\ComfyUI\tools\validate-app.ps1            # 静态校验（--json）
#   powershell -File D:\HanakoWorks\ComfyUI\tools\validate-app.ps1 -Smoke     # 加 --smoke（隔离 AppHost 启动校验）
#   powershell -File D:\HanakoWorks\ComfyUI\tools\validate-app.ps1 -Smoke -Electron <electronExe路径>  # 页面 smoke 用的 Electron
[CmdletBinding()]
param(
  [switch]$Smoke,
  [string]$Electron = '',
  [string]$Stage = 'D:\HanakoWorks\ComfyUI\_build\validate\comfyui-hana',
  [string]$Source = 'D:\HanakoWorks\ComfyUI\app'
)

$ErrorActionPreference = 'Stop'
$validator = 'C:\Users\John Galt\.hanako\skills\hana-app-creator\scripts\validate_app.mjs'
if (-not (Test-Path -LiteralPath $validator)) { Write-Host "找不到校验器：$validator" -ForegroundColor Red; exit 1 }

# 清空 staging（只删 staging 叶子目录；_build 下其它产物如 electron 不动）
if (-not ($Stage -like '*\_build\*')) { Write-Host "拒绝清理非 _build\… 目录：$Stage" -ForegroundColor Red; exit 1 }
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
robocopy $Source $Stage /E /XD .git /NFL /NDL /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "staging robocopy 失败（$LASTEXITCODE）" -ForegroundColor Red; exit 1 }
Write-Host "staging：$Stage"

$args_ = @('--dir', $Stage, '--json')
if ($Smoke) { $args_ += '--smoke' }
if ($Smoke -and $Electron) { $env:HANA_APP_ELECTRON = $Electron }

& node $validator @args_
exit $LASTEXITCODE
