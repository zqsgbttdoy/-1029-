# Report exact backup locations to a UTF8 file
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $Root '测试工作区\backup-report.txt'
$lines = @()
$lines += ("PROJECT ROOT = " + $Root)
$baks = Get-ChildItem -LiteralPath $Root -Directory -Recurse -Depth 1 -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '出厂重置备份-*' }
foreach ($b in $baks) {
    $files = Get-ChildItem -LiteralPath $b.FullName -Recurse -Force -File -ErrorAction SilentlyContinue
    $mb = [math]::Round(((($files | Measure-Object Length -Sum).Sum)) / 1MB, 2)
    $lines += ("BACKUP: " + $b.FullName + " | " + $files.Count + " files | " + $mb + " MB")
    $dbh = Join-Path $b.FullName 'local-data\db\supervision.mv.db'
    $lines += ("   has old mv.db : " + (Test-Path -LiteralPath $dbh))
    $upl = Join-Path $b.FullName 'local-data\uploads'
    $lines += ("   has old uploads: " + (Test-Path -LiteralPath $upl))
}
$lines += ("ACTIVE local-data db exists: " + (Test-Path -LiteralPath (Join-Path $Root 'local-data\db\supervision.mv.db')))
$lines | Set-Content -LiteralPath $out -Encoding UTF8
Write-Output ('WROTE: ' + $out)
