# M0 中继本地实测 · 基础冒烟（standalone）
# 起中继 → /_relay/status → 经中继打 8188 的 /api/queue、/system_stats、/ → 对比直连 → 收尾
$ErrorActionPreference = 'Continue'
$node = 'node'
$relay = 'D:\HanakoWorks\ComfyUI\app\runtime\comfy-relay.mjs'
$port = 39123
$out = 'D:\HanakoWorks\ComfyUI\tools\m0-checks\relay-basic.out.log'
$err = 'D:\HanakoWorks\ComfyUI\tools\m0-checks\relay-basic.err.log'
Remove-Item $out, $err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $node -ArgumentList @($relay, '--standalone', '--port', "$port", '--backend', '127.0.0.1:8188') -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 250
  try { $r = Invoke-WebRequest "http://127.0.0.1:$port/_relay/health" -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
}
"relay pid=$($p.Id) listening=$ok"
if (-not $ok) { Get-Content $err -ErrorAction SilentlyContinue; exit 1 }

$s = Invoke-RestMethod "http://127.0.0.1:$port/_relay/status" -TimeoutSec 5
"status.ok=$($s.ok)  backend.reachable=$($s.backend.reachable)  comfy=$($s.backend.system.comfyui_version)  frontend=$($s.backend.system.installed_frontend_version)  queue=$($s.queue.running)/$($s.queue.pending)  uptimeSec=$($s.relay.uptimeSec)"

$q  = Invoke-WebRequest "http://127.0.0.1:$port/api/queue" -UseBasicParsing -TimeoutSec 5
"via-relay GET /api/queue => $($q.StatusCode) len=$($q.Content.Length)"
$ss = Invoke-WebRequest "http://127.0.0.1:$port/system_stats" -UseBasicParsing -TimeoutSec 5
"via-relay GET /system_stats => $($ss.StatusCode) len=$($ss.Content.Length)"
$idx = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
"via-relay GET / => $($idx.StatusCode) len=$($idx.Content.Length) type=$($idx.Headers['Content-Type'])"
$oid = Invoke-WebRequest "http://127.0.0.1:$port/api/object_info/LoadImage" -UseBasicParsing -TimeoutSec 10
"via-relay GET /api/object_info/LoadImage => $($oid.StatusCode) len=$($oid.Content.Length)"

$dq = Invoke-WebRequest "http://127.0.0.1:8188/api/queue" -UseBasicParsing -TimeoutSec 5
"direct  GET /api/queue => $($dq.StatusCode) len=$($dq.Content.Length)"
"queue body identical: $($q.Content -eq $dq.Content)"
$dss = Invoke-WebRequest "http://127.0.0.1:8188/system_stats" -UseBasicParsing -TimeoutSec 5
$a = $ss.Content | ConvertFrom-Json; $b = $dss.Content | ConvertFrom-Json
"system_stats 静态字段一致: comfy=$($a.system.comfyui_version -eq $b.system.comfyui_version) frontend=$($a.system.required_frontend_version -eq $b.system.required_frontend_version) vramTotal=$($a.devices[0].vram_total -eq $b.devices[0].vram_total)（ram_free/vram_free 为动态值，不比对）"
$d0 = Invoke-WebRequest "http://127.0.0.1:8188/" -UseBasicParsing -TimeoutSec 5
"index body identical: $($idx.Content -eq $d0.Content)"

# 无 Origin / 无 Sec-Fetch-Site 的直连对照（中间件容忍度，curl 语义）
$rawDirect = curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:8188/api/queue"
$rawRelay  = curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:$port/api/queue"
"curl(no-origin) direct=$rawDirect relay=$rawRelay  (期望 200/200)"

$rawOriginDirect = curl.exe -s -o NUL -w "%{http_code}" -H "Origin: http://127.0.0.1:9999" -H "Sec-Fetch-Site: cross-site" "http://127.0.0.1:8188/api/queue"
$rawOriginRelay  = curl.exe -s -o NUL -w "%{http_code}" -H "Origin: http://127.0.0.1:9999" -H "Sec-Fetch-Site: cross-site" "http://127.0.0.1:$port/api/queue"
"curl(cross-site headers) direct=$rawOriginDirect relay=$rawOriginRelay  (直连预期 403：中间件拦跨站；中继预期 200：服务端语义转发，浏览器跨站头不转发)"

$s2 = Invoke-RestMethod "http://127.0.0.1:$port/_relay/status" -TimeoutSec 5
"requests.total=$($s2.requests.total)  byMethod=$($s2.requests.byMethod | ConvertTo-Json -Compress)"

Stop-Process -Id $p.Id -Force
Start-Sleep -Milliseconds 400
"---- relay stdout ----"
Get-Content $out -ErrorAction SilentlyContinue
"---- relay stderr ----"
Get-Content $err -ErrorAction SilentlyContinue
