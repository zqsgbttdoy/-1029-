# Robust fix: find mojibake backup dirs at project root, rename to clean names inside test-workspace
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$ws = Join-Path $Root ([string]([char]0x6D4B) + [char]0x8BD5 + [char]0x5DE5 + [char]0x4F5C + [char]0x533A)

# Backup dirs may be direct children of root OR nested under a mojibake parent (created by encoding bug)
$cands = @(Get-ChildItem -LiteralPath $Root -Directory -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '20261026-094' })
if ($cands.Count -eq 0) { Write-Output 'NOTHING FOUND at root'; exit 0 }
Write-Output ('FOUND ' + $cands.Count + ' candidate dir(s)')

foreach ($c in $cands) {
    $m = [regex]::Match($c.Name, '\d{8}-\d{6}')
    $suffix = if ($m.Success) { $m.Value } else { (Get-Date -Format 'yyyyMMdd-HHmmss') }
    $fileCount = (Get-ChildItem -LiteralPath $c.FullName -Recurse -Force -File -ErrorAction SilentlyContinue).Count
    if ($fileCount -eq 0) {
        Remove-Item -LiteralPath $c.FullName -Recurse -Force -ErrorAction SilentlyContinue
        Write-Output ('REMOVED empty: ' + $suffix)
        continue
    }
    $target = Join-Path $ws ('factory-reset-backup-' + $suffix)
    if (Test-Path -LiteralPath $target) { Write-Output ('SKIP target exists: ' + $target); continue }
    Move-Item -LiteralPath $c.FullName -Destination $target
    Write-Output ('RENAMED -> ' + $target + ' (' + $fileCount + ' files)')

    # Verify key contents
    $db = Join-Path $target 'local-data\db\supervision.mv.db'
    $up = Join-Path $target 'local-data\uploads'
    $ur = Join-Path $target 'uploads-root'
    Write-Output ('   old mv.db: ' + (Test-Path -LiteralPath $db) + ' | old uploads: ' + (Test-Path -LiteralPath $up) + ' | uploads-root: ' + (Test-Path -LiteralPath $ur))
}

Write-Output ''
Write-Output '=== cleanup mojibake parent dirs (empty only, never the real test-workspace) ==='
foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $_.FullName -ne $ws })) {
    if ($d.Name -match '20261026-094') { continue }  # itself a candidate, handled above
    $inner = @(Get-ChildItem -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue)
    $looksMojibake = $true  # root-level non-ASCII-named dirs we created are only the mojibake parents
    if ($inner.Count -eq 0) {
        Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue
        Write-Output ('REMOVED empty mojibake parent: ' + $d.FullName)
    }
}

Write-Output ''
Write-Output '=== project root dirs now ==='
Get-ChildItem -LiteralPath $Root -Directory -Force | ForEach-Object { Write-Output ('  ' + $_.Name) }
