# Verify factory state via API (ASCII only)
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8080/api'

$login = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -ContentType 'application/json' -Body '{"username":"admin","password":"123456"}'
$token = $login.data.token
if (-not $token) { $token = $login.data.accessToken }
$h = @{ Authorization = "Bearer $token" }
Write-Host ("LOGIN: OK, user=" + $login.data.name + " / role=" + $login.data.role)

$users = Invoke-RestMethod -Uri "$base/users?pageNum=1&pageSize=100" -Headers $h
Write-Host ("USERS total=" + $users.data.total)
$users.data.list | ForEach-Object { Write-Host ("  - id=" + $_.id + " name=" + $_.name + " status=" + $_.status) }

$proj = Invoke-RestMethod -Uri "$base/projects?pageNum=1&pageSize=100" -Headers $h
Write-Host ("PROJECTS total=" + $proj.data.total)
$proj.data.list | ForEach-Object { Write-Host ("  - " + $_.name) }

$dept = Invoke-RestMethod -Uri "$base/departments?pageNum=1&pageSize=100" -Headers $h
Write-Host ("DEPARTMENTS total=" + $dept.data.total)
$dept.data.list | ForEach-Object { Write-Host ("  - " + $_.name) }

$diag = Invoke-RestMethod -Uri "$base/supervision-diaries?pageNum=1&pageSize=10" -Headers $h
Write-Host ("DIARIES total=" + $diag.data.total)

$notice = Invoke-RestMethod -Uri "$base/supervision-notices?pageNum=1&pageSize=10" -Headers $h
Write-Host ("NOTICES total=" + $notice.data.total)

Write-Host 'VERIFY DONE'
