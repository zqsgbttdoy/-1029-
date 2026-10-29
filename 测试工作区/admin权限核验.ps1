# admin 最高权限核验：登录 → 角色/权限绑定 → 全部业务接口 → 24 个导航页面
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File 测试工作区\admin权限核验.ps1 [-Base http://localhost:8081]
param([string]$Base = 'http://localhost:8081', [string]$User = 'admin', [string]$Pwd = '123456')
$ErrorActionPreference = 'Stop'
$fail = 0
function Mark($ok, $msg) { if ($ok) { Write-Host "[OK]   $msg" -ForegroundColor Green } else { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:fail++ } }

$login = Invoke-RestMethod -Method Post -Uri "$Base/api/auth/login" -ContentType 'application/json' -Body (@{ username = $User; password = $Pwd } | ConvertTo-Json)
Mark ($login.code -eq 200 -and $login.data.token) "登录 $User（不记录密码）"
$h = @{ Authorization = "Bearer $($login.data.token)" }

$info = (Invoke-RestMethod -Uri "$Base/api/auth/info" -Headers $h).data
Mark (@($info.roles) -contains 'admin') ("当前用户角色：" + (@($info.roles) -join ','))

$roles = (Invoke-RestMethod -Uri "$Base/api/roles?pageNum=1&pageSize=200" -Headers $h).data.list
$adminRole = $roles | Where-Object { $_.code -eq 'admin' } | Select-Object -First 1
Mark ($adminRole -and $adminRole.status -eq 'active') "系统管理员角色（code=admin）存在且启用"

$all = (Invoke-RestMethod -Uri "$Base/api/permissions?pageNum=1&pageSize=500" -Headers $h).data
$allIds = @($(if ($all.list) { $all.list } else { $all }) | ForEach-Object { [long]$_.id })
$bound = @((Invoke-RestMethod -Uri "$Base/api/roles/$($adminRole.id)/permissions" -Headers $h).data | ForEach-Object { [long]$_ })
$missing = @($allIds | Where-Object { $bound -notcontains $_ })
Mark ($allIds.Count -gt 0 -and $missing.Count -eq 0) "权限项全部绑定给 admin：已绑定 $($bound.Count) / 共 $($allIds.Count)"

$apis = '/dashboard/stats', '/projects', '/daily-inspections', '/sideline-inspections', '/supervision-notices', '/work-contacts',
        '/supervision-diaries', '/supervision-logs', '/safety-logs', '/meeting-minutes', '/supervision-monthly-reports',
        '/sub-item-databases', '/project-documents', '/departments', '/users', '/roles', '/permissions/tree',
        '/operation-logs', '/messages', '/work-standard-configs'
$firstProject = @((Invoke-RestMethod -Uri "$Base/api/projects?pageNum=1&pageSize=1" -Headers $h).data.list) | Select-Object -First 1
if ($firstProject) { $apis += "/field/summary?projectId=$($firstProject.id)&date=$(Get-Date -Format yyyy-MM-dd)" }
else { Write-Host '[SKIP] 库中暂无项目，跳过项目级接口 /field/summary（可先运行 生成演示数据.bat）' -ForegroundColor Yellow }
foreach ($a in $apis) {
    $sep = if ($a.Contains('?')) { '&' } else { '?' }
    try { $r = Invoke-RestMethod -Uri "$Base/api$a${sep}pageNum=1&pageSize=5" -Headers $h; Mark ($r.code -eq 200) "接口 GET $a" }
    catch { Mark $false "接口 GET $a -> $($_.Exception.Message)" }
}

$pages = 'index', 'project-ledger', 'daily-inspection', 'sideline-inspection', 'supervision-notice', 'work-contact',
         'supervision-diary', 'supervision-log', 'safety-log', 'meeting-minutes', 'supervision-monthly-report',
         'sub-item-database', 'project-data-upload', 'diary-statistics', 'diary-report', 'log-statistics',
         'safety-log-statistics', 'department-management', 'personnel-management', 'permission-settings',
         'process-management', 'operation-log', 'message-center', 'work-standard-config', 'login', 'welcome'
foreach ($p in $pages) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri "$Base/$p.html"; Mark ($r.StatusCode -eq 200 -and $r.Content.Length -gt 1000) "页面 $p.html（$($r.Content.Length) 字节）" }
    catch { Mark $false "页面 $p.html -> $($_.Exception.Message)" }
}
Write-Host ''
if ($fail -eq 0) { Write-Host '全部通过' -ForegroundColor Green; exit 0 } else { Write-Host "失败 $fail 项" -ForegroundColor Red; exit 1 }
