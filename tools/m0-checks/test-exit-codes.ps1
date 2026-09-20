# M0 中继本地实测 · 退出码语义化 + 受管配置文件自删
$ErrorActionPreference = 'Continue'
$node = 'node'
$relay = 'D:\HanakoWorks\ComfyUI\app\runtime\comfy-relay.mjs'
$dir = 'D:\HanakoWorks\ComfyUI\tools\m0-checks'
$results = @()

function Start-Relay([string[]]$args_, [string]$tag) {
  $out = Join-Path $dir "relay-$tag.out.log"; $err = Join-Path $dir "relay-$tag.err.log"
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  Start-Process -FilePath $node -ArgumentList $args_ -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
}
function Wait-Port([int]$port, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    Start-Sleep -Milliseconds 250
    try { $r = Invoke-WebRequest "http://127.0.0.1:$port/_relay/health" -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { return $true } } catch {}
  }
  return $false
}

# ── 1) 端口占用 → 退出码 7 ──────────────────────────────────────────────
$A = Start-Relay @($relay, '--standalone', '--port', '39140', '--backend', '127.0.0.1:8188') 'a'
$okA = Wait-Port 39140
"relay A listening=$okA (pid=$($A.Id))"
$B = Start-Process -FilePath $node -ArgumentList @($relay, '--standalone', '--port', '39140', '--backend', '127.0.0.1:8188') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'relay-b.out.log') -RedirectStandardError (Join-Path $dir 'relay-b.err.log') -PassThru -Wait
"B exitCode=$($B.ExitCode)  (期望 7)"
$results += [pscustomobject]@{ case = '端口占用→7'; expected = 7; got = $B.ExitCode }
Get-Content (Join-Path $dir 'relay-b.err.log') -ErrorAction SilentlyContinue | ForEach-Object { "  B.err> $_" }
Stop-Process -Id $A.Id -Force -ErrorAction SilentlyContinue

# ── 2) require-backend 且后端不可达 → 退出码 2 ──────────────────────────
$C = Start-Process -FilePath $node -ArgumentList @($relay, '--standalone', '--port', '39141', '--backend', '127.0.0.1:39199', '--require-backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'relay-c.out.log') -RedirectStandardError (Join-Path $dir 'relay-c.err.log') -PassThru -Wait
"C exitCode=$($C.ExitCode)  (期望 2，等待约 8s 后端探测超时)"
$results += [pscustomobject]@{ case = '后端不可达→2'; expected = 2; got = $C.ExitCode }
Get-Content (Join-Path $dir 'relay-c.err.log') -ErrorAction SilentlyContinue | ForEach-Object { "  C.err> $_" }

# ── 3) 参数非法 → 退出码 3 ─────────────────────────────────────────────
$D = Start-Process -FilePath $node -ArgumentList @($relay, '--standalone', '--port', '99999') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'relay-d.out.log') -RedirectStandardError (Join-Path $dir 'relay-d.err.log') -PassThru -Wait
"D exitCode=$($D.ExitCode)  (期望 3)"
$results += [pscustomobject]@{ case = '参数非法→3'; expected = 3; got = $D.ExitCode }
Get-Content (Join-Path $dir 'relay-d.err.log') -ErrorAction SilentlyContinue | ForEach-Object { "  D.err> $_" }

# ── 4) 受管配置形态：配置文件被读取且自删 + 自定义就绪标记 ───────────────
$cfgPath = Join-Path $dir 'relay-managed-cfg.json'
$cfg = @{ mode = 'managed'; port = 39142; backend = @{ host = '127.0.0.1'; port = 8188 }; readyMarker = 'COMFY_RELAY_READY:localtest123'; requireBackend = $false; logRequests = $true } | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($cfgPath, $cfg)
$E = Start-Relay @($relay, $cfgPath) 'e'
$okE = Wait-Port 39142
Start-Sleep -Milliseconds 300
"relay E listening=$okE (pid=$($E.Id))  配置文件已自删=$(-not (Test-Path $cfgPath))  (期望 True)"
$outE = Get-Content (Join-Path $dir 'relay-e.out.log') -ErrorAction SilentlyContinue
"E stdout 首行> $($outE | Select-Object -First 1)"
$results += [pscustomobject]@{ case = '受管配置自删+marker'; expected = 'True/COMFY_RELAY_READY:localtest123'; got = "$(-not (Test-Path $cfgPath))/$($outE | Select-Object -First 1)" }
Stop-Process -Id $E.Id -Force -ErrorAction SilentlyContinue

# ── 5) 非法受管配置 → 退出码 3 ─────────────────────────────────────────
$badPath = Join-Path $dir 'relay-managed-bad.json'
[System.IO.File]::WriteAllText($badPath, '{"port": 99999}')
$F = Start-Process -FilePath $node -ArgumentList @($relay, $badPath) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'relay-f.out.log') -RedirectStandardError (Join-Path $dir 'relay-f.err.log') -PassThru -Wait
"F exitCode=$($F.ExitCode)  (期望 3)"
$results += [pscustomobject]@{ case = '配置非法→3'; expected = 3; got = $F.ExitCode }

"`n==== 汇总 ===="
$fail = 0
foreach ($r in $results) {
  $pass = "$($r.got)" -eq "$($r.expected)" -or ($r.case -eq '受管配置自删+marker' -and "$($r.got)" -like '*True*')
  if (-not $pass) { $fail++ }
  "{0}  {1}  expected={2} got={3}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }), $r.case, $r.expected, $r.got
}
exit $fail
