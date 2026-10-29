# D4 单据正文锁定 + 乐观锁 409 端到端核验（需 e2e 后端 8091 + 静态代理 18091）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File 测试工作区\上线阻塞项核验.ps1
param([string]$Base = 'http://127.0.0.1:18091')
$ErrorActionPreference = 'Stop'
$fail = 0
function Mark($ok, $msg) { if ($ok) { Write-Host "[OK]   $msg" } else { Write-Host "[FAIL] $msg"; $script:fail++ } }
function StatusOf($block) {
    try { $r = & $block; return [int]$r.statusCode } catch { return [int]$_.Exception.Response.StatusCode.value__ }
}

$login = Invoke-RestMethod -Method Post -Uri "$Base/api/auth/login" -ContentType 'application/json' -Body (@{ username = 'admin'; password = '123456' } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.data.token)" }
Mark ($login.code -eq 200 -and $login.data.token) 'login admin ok'

# ---------- D4-A 现场记录乐观锁 ----------
$diary = @{ code = 'QA-D4-20261021'; projectId = 1; diaryDate = '2026-10-20'; weather = 'sunny'; wind = 'breeze'; temperature = '20C'; construction = 'QA construction'; management = 'QA'; inspection = 'QA'; otherMatters = 'none' } | ConvertTo-Json
$created = (Invoke-RestMethod -Method Post -Uri "$Base/api/supervision-diaries" -Headers @{ Authorization = $h.Authorization; 'Idempotency-Key' = [guid]::NewGuid().ToString() } -ContentType 'application/json' -Body $diary).data
$v0 = [long]$created.lockVersion
Mark ($created.id -ne $null -and $v0 -eq 0) "diary created id=$($created.id) lockVersion=$v0"

$diary2 = @{ code = 'QA-D4-20261021'; projectId = 1; diaryDate = '2026-10-20'; weather = 'sunny-2'; wind = 'breeze'; temperature = '20C'; construction = 'QA construction'; management = 'QA'; inspection = 'QA'; otherMatters = 'none' } | ConvertTo-Json
$h1 = @{ Authorization = $h.Authorization; 'X-Record-Version' = "$v0" }
$updated = (Invoke-RestMethod -Method Put -Uri "$Base/api/supervision-diaries/$($created.id)" -Headers $h1 -ContentType 'application/json' -Body $diary2).data
$v1 = [long]$updated.lockVersion
Mark ($v1 -eq ($v0 + 1)) "current version update ok, lockVersion $v0 -> $v1"

$stale = StatusOf { Invoke-WebRequest -UseBasicParsing -Method Put -Uri "$Base/api/supervision-diaries/$($created.id)" -Headers $h1 -ContentType 'application/json' -Body $diary2 }
Mark ($stale -eq 409) "stale version update returns 409 (actual $stale)"

$noVer = StatusOf { Invoke-WebRequest -UseBasicParsing -Method Put -Uri "$Base/api/supervision-diaries/$($created.id)" -Headers $h -ContentType 'application/json' -Body $diary2 }
Mark ($noVer -eq 428) "missing X-Record-Version returns 428 (actual $noVer)"

# ---------- D4-B 通知单正文锁定与状态流转 ----------
$notice = @{ code = 'QA-D4-TZ-20261021'; projectId = 1; noticeDate = '2026-10-20'; title = 'QA notice'; content = 'original body'; priority = 'high'; status = 'draft' } | ConvertTo-Json
$n = (Invoke-RestMethod -Method Post -Uri "$Base/api/supervision-notices" -Headers $h -ContentType 'application/json' -Body $notice).data
Mark ($n.id -ne $null -and $n.status -eq 'draft') "notice created id=$($n.id) status=draft"

$issue = @{ code = 'QA-D4-TZ-20261021'; projectId = 1; noticeDate = '2026-10-20'; title = 'QA notice'; content = 'original body'; priority = 'high'; status = 'issued' } | ConvertTo-Json
$issued = (Invoke-RestMethod -Method Put -Uri "$Base/api/supervision-notices/$($n.id)" -Headers $h -ContentType 'application/json' -Body $issue).data
Mark ($issued.status -eq 'issued') "draft -> issued allowed (status=$($issued.status))"

$tamper = @{ code = 'QA-D4-TZ-20261021'; projectId = 1; noticeDate = '2026-10-20'; title = 'QA notice'; content = 'tampered body'; priority = 'high'; status = 'issued' } | ConvertTo-Json
$lock = StatusOf { Invoke-WebRequest -UseBasicParsing -Method Put -Uri "$Base/api/supervision-notices/$($n.id)" -Headers $h -ContentType 'application/json' -Body $tamper }
Mark ($lock -eq 409) "issued notice content overwrite returns 409 (actual $lock)"

$jump = @{ code = 'QA-D4-TZ-20261021'; projectId = 1; noticeDate = '2026-10-20'; title = 'QA notice'; content = 'original body'; priority = 'high'; status = 'verified' } | ConvertTo-Json
$skip = StatusOf { Invoke-WebRequest -UseBasicParsing -Method Put -Uri "$Base/api/supervision-notices/$($n.id)" -Headers $h -ContentType 'application/json' -Body $jump }
Mark ($skip -eq 409) "issued -> verified jump returns 409 (actual $skip)"

# ---------- D3 管理接口越权（普通用户 403） ----------
$role = (Invoke-RestMethod -Method Post -Uri "$Base/api/roles" -Headers $h -ContentType 'application/json' -Body (@{ name = 'QA ReadOnly'; code = 'qa_readonly'; description = 'QA' } | ConvertTo-Json)).data
Mark ($role.id -ne $null) "created non-admin role id=$($role.id)"
$user = (Invoke-RestMethod -Method Post -Uri "$Base/api/users" -Headers $h -ContentType 'application/json' -Body (@{ name = 'qa_readonly_user'; username = 'qa_readonly_user'; password = '123456'; phone = '13900000001'; roleIds = @($role.id); status = 'active' } | ConvertTo-Json -Depth 5)).data
Mark ($user.id -ne $null) "created non-admin user id=$($user.id)"

$nlogin = Invoke-RestMethod -Method Post -Uri "$Base/api/auth/login" -ContentType 'application/json' -Body (@{ username = 'qa_readonly_user'; password = '123456' } | ConvertTo-Json)
$nh = @{ Authorization = "Bearer $($nlogin.data.token)" }
$rolesCode = StatusOf { Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/roles?pageNum=1&pageSize=5" -Headers $nh }
$permCode = StatusOf { Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/permissions?pageNum=1&pageSize=5" -Headers $nh }
$deptCode = StatusOf { Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/departments?pageNum=1&pageSize=5" -Headers $nh }
Mark ($rolesCode -eq 403) "normal user GET /roles returns 403 (actual $rolesCode)"
Mark ($permCode -eq 403) "normal user GET /permissions returns 403 (actual $permCode)"
Mark ($deptCode -eq 403) "normal user GET /departments returns 403 (actual $deptCode)"

$adminRole = @((Invoke-RestMethod -Uri "$Base/api/roles?pageNum=1&pageSize=200" -Headers $h).data.list) | Where-Object { $_.code -eq 'admin' } | Select-Object -First 1
$delAdmin = StatusOf { Invoke-WebRequest -UseBasicParsing -Method Delete -Uri "$Base/api/roles/$($adminRole.id)" -Headers $h }
Mark ($delAdmin -eq 400) "admin role delete rejected (actual $delAdmin)"
$permTotal = [int]((Invoke-RestMethod -Uri "$Base/api/permissions?pageNum=1&pageSize=500" -Headers $h).data.total)
$bound = @((Invoke-RestMethod -Uri "$Base/api/roles/$($adminRole.id)/permissions" -Headers $h).data)
Mark ($permTotal -gt 0 -and $bound.Count -eq $permTotal) "admin keeps all permissions ($($bound.Count)/$permTotal)"

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASSED'; exit 0 } else { Write-Host "FAILED $fail"; exit 1 }
