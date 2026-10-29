# Probe: locate backup dirs (ASCII-only literals to dodge encoding pitfalls)
$ErrorActionPreference = 'Continue'
$Root = 'e:\' + [char]0x5E0C + [char]0x5730 + [char]0x5DE5 + [char]0x4F5C + '\trae ' + [char]0x6587 + [char]0x4EF6 + [char]0x4FDD + [char]0x5B58 + '\' + [char]0x5B8C + [char]0x6574 + [char]0x7248 + '-' + [char]0x76D1 + [char]0x7406 + ' - qoder'
Write-Output ("ROOT EXISTS: " + (Test-Path -LiteralPath $Root))

Write-Output '=== root-level dirs ==='
Get-ChildItem -LiteralPath $Root -Directory -Force | ForEach-Object { Write-Output ("  [" + $_.Name + "]") }

$ws = Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $_.Name.Contains([string][char]0x6D4B + [char]0x8BD5) }
if ($ws) {
    Write-Output ('=== inside workspace dir: ' + $ws.Name + ' ===')
    Get-ChildItem -LiteralPath $ws.FullName -Directory -Force | Where-Object { $_.Name.Contains('20261026-09') } | ForEach-Object {
        Write-Output ('  DIR: ' + $_.Name)
        Get-ChildItem -LiteralPath $_.FullName -Force -Recurse -Depth 1 | ForEach-Object { Write-Output ('      ' + $_.FullName.Substring($ws.FullName.Length + 1)) }
    }
}

Write-Output '=== root dirs containing 20261026-09 (mis-placed?) ==='
Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $_.Name.Contains('20261026-09') } | ForEach-Object {
    Write-Output ('  NAME: [' + $_.Name + ']  ' + $_.FullName)
    Get-ChildItem -LiteralPath $_.FullName -Force -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Output ('      ' + $_.FullName) }
}
