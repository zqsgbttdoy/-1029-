# Verify backup integrity
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bak = Get-ChildItem -LiteralPath (Join-Path $Root '测试工作区') -Directory -Filter '出厂重置备份-*' | Sort-Object Name -Descending | Select-Object -First 1

if (-not $bak) { Write-Host 'ERROR: no backup dir found'; exit 1 }
Write-Host ("Backup dir: " + $bak.FullName)
Write-Host ''

Write-Host '--- Top-level contents ---'
Get-ChildItem -LiteralPath $bak.FullName -Force | ForEach-Object {
    Write-Host ("  " + $_.Name + $(if ($_.PSIsContainer) { '\' } else { '' }))
}
Write-Host ''

Write-Host '--- Key runtime files present? ---'
$db = Join-Path $bak.FullName 'local-data\db\supervision.mv.db'
$up = Join-Path $bak.FullName 'local-data\uploads'
$m1 = Join-Path $bak.FullName 'local-data\initialized.marker'
$m2 = Join-Path $bak.FullName 'local-data\migration.properties'
Write-Host ("  supervision.mv.db : " + (Test-Path -LiteralPath $db))
Write-Host ("  uploads dir       : " + (Test-Path -LiteralPath $up))
Write-Host ("  initialized.marker: " + (Test-Path -LiteralPath $m1))
Write-Host ("  migration.propert : " + (Test-Path -LiteralPath $m2))

$totalFiles = (Get-ChildItem -LiteralPath $bak.FullName -Recurse -Force -File -ErrorAction SilentlyContinue).Count
$totalMB = [math]::Round(((Get-ChildItem -LiteralPath $bak.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ''
Write-Host ("  Total: $totalFiles files, $totalMB MB")

Write-Host ''
Write-Host '--- Current local-data (should only have verification + empty db/uploads) ---'
$ld = Join-Path $Root 'local-data'
if (Test-Path -LiteralPath $ld) {
    Get-ChildItem -LiteralPath $ld -Force | ForEach-Object { Write-Host ("  " + $_.Name) }
    $dbNow = Join-Path $ld 'db\supervision.mv.db'
    Write-Host ("  Active DB exists: " + (Test-Path -LiteralPath $dbNow))
}
