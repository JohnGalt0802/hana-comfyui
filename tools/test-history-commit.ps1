#Requires -Version 7.0
<#
.SYNOPSIS
  画布提交历史 P1 — 实机 HTTP 回归用例集（E1）
.DESCRIPTION
  对运行中的 ComfyUI（hui 桥，8188）的 /hana_bridge/history-commit 与
  /hana_bridge/history-list 做 HTTP 级回归测试，并做文件系统侧验证。
  纯 HTTP + 文件系统检查，不依赖 ComfyUI 环境；测试数据全部使用
  测试专用工作流名（__selftest__ 系列 / 测试中文工作流 (v2)），脚本结束清理。
  ⚠️ 实机运行前提：ComfyUI 在跑（默认 http://127.0.0.1:8188），且落盘目录在
  默认位置（D:\ComfyUI\ComfyUI\user\default\workflows\.history）。
  可用参数覆盖：-BaseUrl / -HistoryRoot。
.EXAMPLE
  pwsh tools/test-history-commit.ps1
  pwsh tools/test-history-commit.ps1 -BaseUrl http://127.0.0.1:8188
#>
param(
    [string]$BaseUrl = 'http://127.0.0.1:8188',
    [string]$HistoryRoot = 'D:\ComfyUI\ComfyUI\user\default\workflows\.history'
)

$script:BaseUrl = $BaseUrl.TrimEnd('/')
$script:HistoryRoot = $HistoryRoot

# ── 测试专用工作流名（红线：绝不触碰真实工作流历史）────────────────────────
$script:TestNames = @(
    '__selftest__',
    '__selftest__big',
    '__selftest__empty',
    '__selftest__race',
    '__selftest__d1',
    '__selftest__b2guard',
    '测试中文工作流 (v2)'
)

$script:results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Name, [bool]$Ok, [string]$Evidence, [string]$Expect = '', [string]$Actual = '')
    $script:results.Add([pscustomobject]@{
        Name = $Name; Ok = $Ok; Evidence = $Evidence; Expect = $Expect; Actual = $Actual
    }) | Out-Null
    $mark = if ($Ok) { '✔' } else { '✘' }
    Write-Host ("{0} {1} — {2}" -f $mark, $Name, $Evidence)
    if (-not $Ok) {
        if ($Expect) { Write-Host ("    期望: {0}" -f $Expect) }
        if ($Actual) { Write-Host ("    实际: {0}" -f $Actual) }
    }
}

# ── HTTP 助手（-SkipHttpErrorCheck：4xx/5xx 不抛异常，返回状态码+body）──────
function Invoke-HanaApi {
    param([ValidateSet('Get', 'Post')][string]$Method, [string]$Uri, $BodyObj)
    try {
        if ($null -ne $BodyObj) {
            # Bug1 修复：测试件一律传原始 JSON 字符串（PowerShell 哈希表经 ConvertTo-Json
            # 会把单元素嵌套数组拍平，如 [[1,1,0,2,0,"IMAGE"]] → [1,1,0,2,0,"IMAGE"]）
            if ($BodyObj -is [string]) { $json = $BodyObj }
            else { $json = $BodyObj | ConvertTo-Json -Depth 64 -Compress }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $resp = Invoke-WebRequest -Method $Method -Uri $Uri -Body $bytes `
                -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 60
        }
        else {
            $resp = Invoke-WebRequest -Method $Method -Uri $Uri -SkipHttpErrorCheck -TimeoutSec 60
        }
        $parsed = $null
        try { $parsed = $resp.Content | ConvertFrom-Json } catch { }
        return @{ Status = [int]$resp.StatusCode; Raw = [string]$resp.Content; Json = $parsed; Error = $null }
    }
    catch {
        return @{ Status = $null; Raw = $null; Json = $null; Error = $_.Exception.Message }
    }
}

function Invoke-Commit {
    param($BodyObj, [string]$Path = '/hana_bridge/history-commit')
    return Invoke-HanaApi -Method Post -Uri ($script:BaseUrl + $Path) -BodyObj $BodyObj
}

function Invoke-List {
    param([string]$Workflow, [string]$Path = '/hana_bridge/history-list')
    $q = [System.Uri]::EscapeDataString($Workflow)
    return Invoke-HanaApi -Method Get -Uri ("{0}{1}?workflow={2}" -f $script:BaseUrl, $Path, $q)
}

# ── 文件系统助手 ────────────────────────────────────────────────────────────
function Get-HistoryDir([string]$WorkflowName) {
    return Join-Path $script:HistoryRoot $WorkflowName
}
function Get-IndexLines([string]$Dir) {
    $idx = Join-Path $Dir 'index.jsonl'
    if (-not (Test-Path -LiteralPath $idx)) { return @() }
    return @(Get-Content -LiteralPath $idx -Encoding utf8 | Where-Object { $_.Trim() -ne '' })
}
function Get-SnapshotFiles([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Name -ne 'index.jsonl' })
}
function Get-DirNamesUnderHistory {
    if (-not (Test-Path -LiteralPath $script:HistoryRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $script:HistoryRoot -Directory | Select-Object -ExpandProperty Name)
}
# 最小 2 节点图（A 组标准输入）。Bug1 修复：直接返回原始 JSON 字符串，
# 避免哈希表经 ConvertTo-Json 把单元素嵌套数组拍平（links [[…]] → […]）。
function New-SmallGraph {
    return '{"nodes":[{"id":1,"type":"KSampler","pos":[0,0]},{"id":2,"type":"SaveImage","pos":[200,0]}],"links":[[1,1,0,2,0,"IMAGE"]]}'
}

# 构造 history-commit 请求体（原始 JSON 字符串；GraphJson 为已序列化的 JSON）
function New-CommitBodyJson {
    param(
        [string]$Workflow,
        [string]$PromptId = '',
        [string]$GraphJson = '',
        [string]$Source = '',
        [string]$At = ''
    )
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($Workflow) { $parts.Add('"workflow":' + ($Workflow | ConvertTo-Json -Compress)) }
    if ($PromptId) { $parts.Add('"promptId":' + ($PromptId | ConvertTo-Json -Compress)) }
    if ($At) { $parts.Add('"at":"' + $At + '"') }
    if ($Source) { $parts.Add('"source":"' + $Source + '"') }
    if ($GraphJson) { $parts.Add('"graph":' + $GraphJson) }
    return '{' + ($parts -join ',') + '}'
}

# ════════════════════════════════════════════════════════════════════════════
# 0. 服务探活（不可达 → 明确报错退出，不静默跳过）
# ════════════════════════════════════════════════════════════════════════════
Write-Host "── 0. 服务探活：$script:BaseUrl"
$probe = Invoke-HanaApi -Method Get -Uri ($script:BaseUrl + '/system_stats')
if ($null -ne $probe.Error) {
    Write-Host "✘ ComfyUI 服务不可达（$($script:BaseUrl)）：$($probe.Error)"
    Write-Host '   （本脚本针对运行中的 ComfyUI 实机做 HTTP 回归，请先启动服务再跑）'
    exit 1
}
if ($probe.Status -ne 200) {
    Write-Host "✘ $script:BaseUrl 可达但 /system_stats 返回 $($probe.Status)，不像 ComfyUI 服务"
    exit 1
}
Write-Host "✔ 服务可达（/system_stats → 200）"

# ── .history 现状报告（发现非空：列出来，不删）─────────────────────────────
$existing = @(Get-DirNamesUnderHistory)
if ($existing.Count -eq 0) {
    Write-Host ("✔ .history 现状：{0} 不存在或为空" -f $script:HistoryRoot)
}
else {
    Write-Host ("⚠ .history 现状：发现 {0} 个既有目录（只列出，不删）：" -f $existing.Count)
    $existing | ForEach-Object { Write-Host ("    - {0}" -f $_) }
}

# ── 预清理：残留的测试专用目录（上次中断可能留下），保证 A1 能拿到 seq=1 ──
foreach ($n in $script:TestNames) {
    $p = Get-HistoryDir $n
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Recurse -Force
        Write-Host ("↻ 预清理残留测试目录：.history/{0}" -f $n)
    }
}

# ════════════════════════════════════════════════════════════════════════════
# 用例执行（finally 里做清理，保证中途异常也会清）
# ════════════════════════════════════════════════════════════════════════════
try {
    # ════════ A 组：基础链路 ════════
    Write-Host ''
    Write-Host '── A 组：基础链路'

    # A1 基本提交
    $dir = Get-HistoryDir '__selftest__'
    $body1 = New-CommitBodyJson -Workflow '__selftest__' -PromptId 'aaaaaaaa-1111-2222-3333-444444444444' -GraphJson (New-SmallGraph) -Source 'user' -At '2026-10-11T00:00:00.000Z'
    $r1 = Invoke-Commit $body1
    $okStatus = ($r1.Status -eq 200)
    $okFlag = ($okStatus -and $r1.Json -and $r1.Json.ok -eq $true -and $r1.Json.seq -eq 1)
    $snapFile = $null; $roundTrip = $false; $idxOk = $false; $idx1 = @()
    if ($okFlag) {
        $snapFile = Join-Path $dir $r1.Json.file
        $fileExists = Test-Path -LiteralPath $snapFile
        if ($fileExists) {
            # Bug2 修复：不用 ConvertFrom-Json 读回快照——pwsh 7 会把 "at" 解析成 datetime
            # 对象，与字符串字面量比较恒 False。改用 System.Text.Json 直读原始字符串，
            # 同时规避 datetime 强转与嵌套数组的任何读回歧义。
            $doc = [System.Text.Json.JsonDocument]::Parse((Get-Content -LiteralPath $snapFile -Raw -Encoding utf8))
            try {
                $root = $doc.RootElement
                $nodeIds = @($root.GetProperty('graph').GetProperty('nodes').EnumerateArray() | ForEach-Object { $_.GetProperty('id').GetInt32() })
                $linksArr = @($root.GetProperty('graph').GetProperty('links').EnumerateArray())
                $roundTrip = ($root.GetProperty('seq').GetInt32() -eq 1 `
                    -and $root.GetProperty('promptId').GetString() -eq 'aaaaaaaa-1111-2222-3333-444444444444' `
                    -and $root.GetProperty('nodeCount').GetInt32() -eq 2 -and $root.GetProperty('linkCount').GetInt32() -eq 1 `
                    -and $root.GetProperty('schemaVersion').GetInt32() -eq 1 `
                    -and $root.GetProperty('at').GetString() -eq '2026-10-11T00:00:00.000Z' -and $root.GetProperty('source').GetString() -eq 'user' `
                    -and $nodeIds.Count -eq 2 -and ($nodeIds -contains 1) -and ($nodeIds -contains 2) `
                    -and $linksArr.Count -eq 1)
            }
            finally { $doc.Dispose() }
        }
        # Bug4 修复：函数返回的数组跨边界会被降级成标量（单元素时 $idx1[0] 取到首字符）
        $idx1 = @(Get-IndexLines $dir)
        $line1 = if ($idx1.Count -eq 1) { $idx1[0] } else { '' }
        $idxOk = ($idx1.Count -eq 1 -and $line1 -notmatch '"graph"\s*:' -and $line1 -match '"seq":1')
    }
    Add-Result -Name 'A1 基本提交' -Ok ($okFlag -and $roundTrip -and $idxOk) `
        -Evidence ("status={0} seq={1} file={2} 快照round-trip={3} 索引1行且无graph字段={4}" -f `
            $r1.Status, $(if ($r1.Json) { $r1.Json.seq } else { '?' }), $(if ($r1.Json) { $r1.Json.file } else { '?' }), $roundTrip, $idxOk) `
        -Expect '200 + {ok:true,seq:1}；快照文件存在且可解析回原结构（2节点/1链/promptId/at/source 一致）；index.jsonl 恰1行且不含 graph 字段' `
        -Actual ("HTTP={0} body={1}" -f $r1.Status, $r1.Raw)

    # A2 二次提交追加
    $okA2 = $false; $ev2 = ''
    if ($okFlag) {
        $firstLineBefore = $idx1[0]
        $body2 = New-CommitBodyJson -Workflow '__selftest__' -PromptId 'bbbbbbbb-2222-3333-4444-555555555555' -GraphJson (New-SmallGraph) -Source 'agent'
        $r2 = Invoke-Commit $body2
        # Bug4 修复：同上，包 @() 保数组（A2 要做 $idx2[0] 索引）
        $idx2 = @(Get-IndexLines $dir)
        $secondFile = $null
        if ($r2.Json -and $r2.Json.file) { $secondFile = Test-Path -LiteralPath (Join-Path $dir $r2.Json.file) }
        $okA2 = ($r2.Status -eq 200 -and $r2.Json.ok -eq $true -and $r2.Json.seq -eq 2 -and $secondFile `
            -and $idx2.Count -eq 2 -and ($idx2[0] -ceq $firstLineBefore))
        $ev2 = ("seq={0} 第二文件存在={1} 索引行数={2} 首行逐字符未变={3}" -f `
            $(if ($r2.Json) { $r2.Json.seq } else { '?' }), $secondFile, $idx2.Count, ($idx2.Count -ge 2 -and ($idx2[0] -ceq $firstLineBefore)))
        Add-Result -Name 'A2 二次提交追加' -Ok $okA2 -Evidence $ev2 `
            -Expect '200 + seq=2；第二个快照文件存在；索引 2 行；首行逐字符与提交前一致' `
            -Actual ("HTTP={0} body={1}" -f $r2.Status, $r2.Raw)
    }
    else {
        Add-Result -Name 'A2 二次提交追加' -Ok $false -Evidence '前置 A1 未通过，跳过执行' `
            -Expect '依赖 A1' -Actual 'A1 失败'
    }

    # A3 查询回读
    $okA3 = $false
    if ($okFlag) {
        $rl = Invoke-List '__selftest__'
        $entries = @()
        $fieldsOk = $false
        if ($rl.Json -and $rl.Json.entries) { $entries = @($rl.Json.entries) }
        if ($entries.Count -eq 2) {
            $required = @('seq', 'file', 'promptId', 'at', 'source', 'nodeCount', 'linkCount')
            $fieldsOk = $true
            foreach ($e in $entries) {
                foreach ($f in $required) {
                    if (-not ($e.PSObject.Properties.Name -contains $f)) { $fieldsOk = $false }
                }
            }
        }
        $okA3 = ($rl.Status -eq 200 -and $rl.Json.ok -eq $true -and $entries.Count -eq 2 -and $rl.Json.badLines -eq 0 -and $fieldsOk)
        Add-Result -Name 'A3 查询回读' -Ok $okA3 `
            -Evidence ("entries={0} 与索引行数({1})一致 badLines={2} 字段齐全={3}" -f $entries.Count, @(Get-IndexLines $dir).Count, $rl.Json.badLines, $fieldsOk) `
            -Expect '200 + entries 数与索引行数一致（2），每条含 seq/file/promptId/at/source/nodeCount/linkCount，badLines=0' `
            -Actual ("HTTP={0} body={1}" -f $rl.Status, $rl.Raw)
    }
    else {
        Add-Result -Name 'A3 查询回读' -Ok $false -Evidence '前置 A1 未通过，跳过执行' -Expect '依赖 A1' -Actual 'A1 失败'
    }

    # ════════ B 组：边界 ════════
    Write-Host ''
    Write-Host '── B 组：边界'

    # B1 缺 workflow
    $beforeB1 = @(Get-DirNamesUnderHistory) -join '|'
    $rb1 = Invoke-Commit ('{"graph":' + (New-SmallGraph) + '}')
    $afterB1 = @(Get-DirNamesUnderHistory) -join '|'
    $okB1 = ($rb1.Status -eq 400 -and $rb1.Json -and $rb1.Json.ok -eq $false -and $beforeB1 -ceq $afterB1)
    Add-Result -Name 'B1 缺 workflow → 400 + 不落盘' -Ok $okB1 `
        -Evidence ("status={0} ok={1} 目录集合未变={2}" -f $rb1.Status, $(if ($rb1.Json) { $rb1.Json.ok } else { '?' }), ($beforeB1 -ceq $afterB1)) `
        -Expect '400 + {ok:false}；.history 下目录集合前后一致（不落盘）' `
        -Actual ("HTTP={0} body={1}" -f $rb1.Status, $rb1.Raw)

    # B2 缺 graph
    $rb2 = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__b2guard' -PromptId 'cccccccc-0000-0000-0000-000000000000')
    $b2DirCreated = Test-Path -LiteralPath (Get-HistoryDir '__selftest__b2guard')
    $okB2 = ($rb2.Status -eq 400 -and $rb2.Json -and $rb2.Json.ok -eq $false -and -not $b2DirCreated)
    Add-Result -Name 'B2 缺 graph → 400 + 不落盘' -Ok $okB2 `
        -Evidence ("status={0} ok={1} 目录未创建={2}" -f $rb2.Status, $(if ($rb2.Json) { $rb2.Json.ok } else { '?' }), (-not $b2DirCreated)) `
        -Expect '400 + {ok:false}；.history/__selftest__b2guard 不存在' `
        -Actual ("HTTP={0} body={1}" -f $rb2.Status, $rb2.Raw)

    # B3 中文工作流名
    $cnName = '测试中文工作流 (v2)'
    $rb3 = Invoke-Commit (New-CommitBodyJson -Workflow $cnName -PromptId 'dddddddd-3333-4444-5555-666666666666' -GraphJson (New-SmallGraph) -Source 'user')
    $cnDir = Get-HistoryDir $cnName
    $cnDirExists = Test-Path -LiteralPath $cnDir
    $nameClean = $cnDirExists -and -not ($cnName -match '[\\/:\*\?"<>\|\x00-\x1f]')
    $cnFilesOk = $cnDirExists -and @(Get-SnapshotFiles $cnDir).Count -eq 1 -and @(Get-IndexLines $cnDir).Count -eq 1
    $okB3 = ($rb3.Status -eq 200 -and $rb3.Json.ok -eq $true -and $cnDirExists -and $nameClean -and $cnFilesOk)
    Add-Result -Name 'B3 中文工作流名' -Ok $okB3 `
        -Evidence ("status={0} 目录名='{1}' 存在={2} 无非法字符={3} 快照+索引落盘={4}" -f `
            $rb3.Status, $cnName, $cnDirExists, $nameClean, $cnFilesOk) `
        -Expect "200 + 落盘目录名恰为「测试中文工作流 (v2)」（保留中文与空格、无非法字符），1 快照 + 1 行索引" `
        -Actual ("HTTP={0} body={1}" -f $rb3.Status, $rb3.Raw)

    # B4 超大 graph（>14MiB → 413/4xx + 不落盘）
    $padLen = 15 * 1024 * 1024   # 15MiB 字符（ASCII），序列化后 > 14MiB 上限
    $bigGraphJson = '{"nodes":[],"links":[],"pad":"' + ('x' * $padLen) + '"}'
    $rb4 = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__big' -PromptId 'eeeeeeee-4444-5555-6666-777777777777' -GraphJson $bigGraphJson -Source 'user')
    $bigDirCreated = Test-Path -LiteralPath (Get-HistoryDir '__selftest__big')
    $is4xx = ($rb4.Status -ge 400 -and $rb4.Status -lt 500)
    $okB4 = ($is4xx -and (-not $bigDirCreated))
    Add-Result -Name 'B4 超大 graph (>14MiB)' -Ok $okB4 `
        -Evidence ("status={0} 目录未创建={1}" -f $rb4.Status, (-not $bigDirCreated)) `
        -Expect '413（或任一 4xx）+ .history/__selftest__big 不存在（超限不落任何盘上痕迹）' `
        -Actual ("HTTP={0} body(截断)={1}" -f $rb4.Status, $(if ($rb4.Raw) { $rb4.Raw.Substring(0, [Math]::Min(300, $rb4.Raw.Length)) } else { $rb4.Error }))

    # B5 空 graph（记录实际行为，不判 fail）
    $rb5 = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__empty' -PromptId 'ffffffff-5555-6666-7777-888888888888' -GraphJson '{"nodes":[],"links":[]}' -Source 'user')
    $b5Landed = ($rb5.Status -eq 200 -and $rb5.Json.ok -eq $true)
    Add-Result -Name 'B5 空 graph（已知口径，不判 fail）' -Ok $true `
        -Evidence ("实际行为：status={0} ok={1} → {2}（已知口径：JS 层已拦空图，HTTP 层不重复拦，允许落盘为当前设计）" -f `
            $rb5.Status, $(if ($rb5.Json) { $rb5.Json.ok } else { '?' }), $(if ($b5Landed) { '已落盘' } else { '未落盘' }))

    # ════════ C 组：幂等与并发 ════════
    Write-Host ''
    Write-Host '── C 组：幂等与并发'

    # C1 同 promptId 连发两次（记录实际行为；当前设计每次提交都是新快照）
    $samePid = '99999999-aaaa-bbbb-cccc-dddddddddddd'
    $rc1a = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__' -PromptId $samePid -GraphJson (New-SmallGraph) -Source 'user')
    $rc1b = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__' -PromptId $samePid -GraphJson (New-SmallGraph) -Source 'user')
    $seqA = if ($rc1a.Json) { $rc1a.Json.seq } else { $null }
    $seqB = if ($rc1b.Json) { $rc1b.Json.seq } else { $null }
    $okC1 = ($rc1a.Status -eq 200 -and $rc1b.Status -eq 200 -and $rc1a.Json.ok -eq $true -and $rc1b.Json.ok -eq $true -and $seqB -gt $seqA)
    Add-Result -Name 'C1 同 promptId 连发两次' -Ok $okC1 `
        -Evidence ("两次均成功：seq {0} → {1}（当前设计：每次提交都是新快照，同 promptId 不去重）" -f $seqA, $seqB) `
        -Expect '两次都 200 + {ok:true}，且 seq 递增（不同 seq）' `
        -Actual ("HTTP {0}/{1}，seq {2}/{3}" -f $rc1a.Status, $rc1b.Status, $seqA, $seqB)

    # C2 连发 5 次快速提交（真并发：ForEach-Object -Parallel，不同 promptId）
    $raceResults = 0..4 | ForEach-Object -Parallel {
        $i = $_
        $url = $using:BaseUrl + '/hana_bridge/history-commit'
        # Bug1 同类坑修复：直接拼原始 JSON——哈希表经 ConvertTo-Json 会拍平单元素嵌套数组，
        # nodes=@(@{…}) 会被塌成单个对象，graph.nodes 就不再是数组（nodeCount 会数错）。
        $bodyJson = '{"workflow":"__selftest__race","promptId":"r' + $i.ToString('D7') +
            '-aaaa-bbbb-cccc-dddddddddddd","source":"user","graph":{"nodes":[{"id":' + $i +
            ',"type":"Note"}],"links":[]}}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
        try {
            $resp = Invoke-WebRequest -Method Post -Uri $url -Body $bytes -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 60
            $j = $resp.Content | ConvertFrom-Json
            [pscustomobject]@{ Status = [int]$resp.StatusCode; Ok = $j.ok; Seq = $j.seq; File = $j.file }
        }
        catch {
            [pscustomobject]@{ Status = 0; Ok = $false; Seq = $null; File = $null }
        }
    }
    $raceDir = Get-HistoryDir '__selftest__race'
    $raceFiles = @(Get-SnapshotFiles $raceDir)
    $raceLines = @(Get-IndexLines $raceDir)
    $raceSeqs = @($raceLines | ForEach-Object { ($_ | ConvertFrom-Json).seq })
    $allOk = @($raceResults | Where-Object { $_.Ok -eq $true }).Count
    $okC2 = ($allOk -eq 5 -and $raceFiles.Count -eq 5 -and $raceLines.Count -eq 5)
    Add-Result -Name 'C2 快速连发 5 次（真并发）' -Ok $okC2 `
        -Evidence ("HTTP 全 200 且 ok={0}/5；快照文件 {1}/5；索引行 {2}/5；seq 集=[{3}]（本机无锁，验证现实竞态窗口内是否安全）" -f `
            $allOk, $raceFiles.Count, $raceLines.Count, ($raceSeqs -join ',')) `
        -Expect '5 个请求全部 200+ok；5 个快照文件 + 5 行索引，无丢失、seq 无重复' `
        -Actual ("结果：{0}" -f (($raceResults | ForEach-Object { "s{0}/seq{1}" -f $_.Status, $_.Seq }) -join ' '))

    # ════════ D 组：等价路径 ════════
    Write-Host ''
    Write-Host '── D 组：等价路径'

    # D1 /api/ 前缀 commit
    $rd1 = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__d1' -PromptId 'aaaaaaa1-0000-0000-0000-000000000000' -GraphJson (New-SmallGraph) -Source 'user') -Path '/api/hana_bridge/history-commit'
    $rd1root = Invoke-Commit (New-CommitBodyJson -Workflow '__selftest__d1' -PromptId 'aaaaaaa1-0000-0000-0000-000000000001' -GraphJson (New-SmallGraph) -Source 'user')
    $okD1 = ($rd1.Status -eq 200 -and $rd1.Json.ok -eq $true -and $rd1root.Status -eq 200 -and $rd1root.Json.ok -eq $true)
    Add-Result -Name 'D1 /api/ 前缀 history-commit' -Ok $okD1 `
        -Evidence ("api 前缀 status={0} ok={1}；根路径 status={2} ok={3}（行为一致）" -f `
            $rd1.Status, $rd1.Json.ok, $rd1root.Status, $rd1root.Json.ok) `
        -Expect '两路径均 200 + {ok:true}' `
        -Actual ("api={0} root={1}" -f $rd1.Status, $rd1root.Status)

    # D2 /api/ 前缀 history-list（并与根路径回读比对）
    $rd2 = Invoke-List '__selftest__d1' -Path '/api/hana_bridge/history-list'
    $rd2root = Invoke-List '__selftest__d1'
    $entriesApi = if ($rd2.Json -and $rd2.Json.entries) { @($rd2.Json.entries) } else { @() }
    $entriesRoot = if ($rd2root.Json -and $rd2root.Json.entries) { @($rd2root.Json.entries) } else { @() }
    $entriesEqual = (($entriesApi | ConvertTo-Json -Depth 32 -Compress) -ceq ($entriesRoot | ConvertTo-Json -Depth 32 -Compress))
    $okD2 = ($rd2.Status -eq 200 -and $rd2.Json.ok -eq $true -and $entriesApi.Count -ge 1 -and $entriesEqual)
    Add-Result -Name 'D2 /api/ 前缀 history-list' -Ok $okD2 `
        -Evidence ("api 前缀 status={0} entries={1}；根路径 status={2} entries={3}；两路径 entries 一致={4}" -f `
            $rd2.Status, $entriesApi.Count, $rd2root.Status, $entriesRoot.Count, $entriesEqual) `
        -Expect '两路径均 200 + ok:true，entries 内容一致（≥1 条）' `
        -Actual ("api={0} root={1}" -f $rd2.Status, $rd2root.Status)
}
finally {
    # ════════ 清理：只删本次测试专用目录 ════════
    Write-Host ''
    Write-Host '── 清理'
    foreach ($n in $script:TestNames) {
        $p = Get-HistoryDir $n
        if (Test-Path -LiteralPath $p) {
            try {
                Remove-Item -LiteralPath $p -Recurse -Force
                Write-Host ("已删除: .history/{0}" -f $n)
            }
            catch {
                Write-Host ("删除失败: .history/{0} — {1}" -f $n, $_.Exception.Message)
            }
        }
        else {
            Write-Host ("无需清理（不存在）: .history/{0}" -f $n)
        }
    }
    if (Test-Path -LiteralPath $script:HistoryRoot) {
        $rest = @(Get-DirNamesUnderHistory)
        if ($rest.Count -gt 0) {
            Write-Host ("清理后 .history 剩余目录（非本次测试数据，未触碰）：{0}" -f ($rest -join ', '))
        }
        else {
            Write-Host '清理后 .history 为空'
        }
    }
}

# ════════════════════════════════════════════════════════════════════════════
# 汇总与退出码
# ════════════════════════════════════════════════════════════════════════════
$pass = @($script:results | Where-Object { $_.Ok }).Count
$total = $script:results.Count
Write-Host ''
Write-Host ("═══ 汇总：{0}/{1} 通过 ═══" -f $pass, $total)
if ($pass -lt $total) { exit 1 }
exit 0
