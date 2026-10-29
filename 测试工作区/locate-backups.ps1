# Locate the two backup dirs precisely
$ErrorActionPreference = 'Continue'
$Root = 'e:\' + [char]0x5E0C + [char]0x5730 + [char]0x5DE5 + [char]0x4F5C + '\trae ' + [char]0x6587 + [char]0x4EF6 + [char]0x4FDD + [char]0x5B58 + '\' + [char]0x5B8C + [char]0x6574 + [char]0x7248 + '-' + [char]0x76D1 + [char]0x7406 + ' - qoder'

foreach ($loc in @('ROOT', 'SUB')) {
    if ($loc -eq 'ROOT') { $base = $Root } else { $base = Join-Path $Root ([string]([char]0x6D4B) + [char]0x8BD5 + [char]0x5DE5 + [char]0x4F5C + [char]0x533A) }
    if (-not (Test-Path -LiteralPath $base)) { continue }
    Write-Output ('SCAN: ' + $base)
    Get-ChildItem -LiteralPath $base -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name.Contains('20261026-094') } | ForEach-Object {
        $files = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue)
        $mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
        Write-Output ('  DIR: ' + $_.FullName + '  -> ' + $files.Count + ' files, ' + $mb + ' MB')
    }
}
