# Handle leftover 'verification' dir + confirm fresh local-data state
$ErrorActionPreference = 'Continue'
$Root = 'e:\' + [char]0x5E0C + [char]0x5730 + [char]0x5DE5 + [char]0x4F5C + '\trae ' + [char]0x6587 + [char]0x4EF6 + [char]0x4FDD + [char]0x5B58 + '\' + [char]0x5B8C + [char]0x6574 + [char]0x7248 + '-' + [char]0x76D1 + [char]0x7406 + ' - qoder'
$ld = Join-Path $Root 'local-data'

Write-Output '=== current local-data (after fresh restart) ==='
Get-ChildItem -LiteralPath $ld -Force | ForEach-Object {
    if ($_.PSIsContainer) {
        $c = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue).Count
        Write-Output ("  [DIR] " + $_.Name + "  (" + $c + " files)")
    } else {
        Write-Output ("  [FILE] " + $_.Name + "  " + $_.Length + "B")
    }
}

# Try to move the leftover verification (IDE LSP may still hold it)
$ver = Join-Path $ld 'verification'
if (Test-Path -LiteralPath $ver) {
    $bak = Get-ChildItem -LiteralPath (Join-Path $Root ([string][char]0x6D4B+[char]0x8BD5+[char]0x5DE5+[char]0x4F5C+[char]0x533A)) -Directory -Force | Where-Object { $_.Name.Contains('20261026-09') } | Sort-Object Name -Descending | Select-Object -First 1
    if ($bak) {
        $dest = Join-Path $bak.FullName 'local-data\verification'
        try {
            Move-Item -LiteralPath $ver -Destination $dest -ErrorAction Stop
            Write-Output ''
            Write-Output 'OK: verification moved to backup.'
        } catch {
            Write-Output ''
            Write-Output ('LOCKED: verification still held by IDE Java language server.')
            Write-Output ('        Left in place; it does NOT affect runtime or production.')
        }
    }
}
