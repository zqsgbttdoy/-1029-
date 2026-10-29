# Factory Reset - Step 2: Move old data to backup (per-item, tolerant of IDE locks)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root 'local-data'

# Port check: ensure 8080 is released
$listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Host 'ERROR: Port 8080 still in use. Stop service first.'
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $Root "测试工作区\出厂重置备份-$stamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$failed = @()

# Move top-level 'uploads' dir
$up = Join-Path $Root 'uploads'
if (Test-Path -LiteralPath $up) {
    try { Move-Item -LiteralPath $up -Destination (Join-Path $BackupDir 'uploads-root') -ErrorAction Stop; Write-Host 'OK  moved: uploads (root)' }
    catch { Write-Host "FAIL uploads (root): $($_.Exception.Message)"; $failed += 'uploads-root' }
}

if (Test-Path -LiteralPath $DataDir) {
    # Move each child item of local-data
    foreach ($item in @(Get-ChildItem -LiteralPath $DataDir -Force)) {
        $dest = Join-Path $BackupDir ("local-data\" + $item.Name)
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest))
        try {
            Move-Item -LiteralPath $item.FullName -Destination $dest -ErrorAction Stop
            Write-Host ("OK  moved: local-data\" + $item.Name)
        } catch {
            Write-Host ("FAIL local-data\" + $item.Name + ": " + $_.Exception.Message)
            $failed += $item.Name
        }
    }
    # If local-data only contains leftovers, remove empty dirs
    $left = @(Get-ChildItem -LiteralPath $DataDir -Force -Recurse)
    if ($left.Count -eq 0) { Remove-Item -LiteralPath $DataDir -Force }
}

Write-Host ''
Write-Host "Backup folder: $BackupDir"
if ($failed.Count -gt 0) {
    Write-Host ("PARTIAL: these items are still locked and left in place: " + ($failed -join ', '))
} else {
    Write-Host 'COMPLETE: all old data moved out.'
}
