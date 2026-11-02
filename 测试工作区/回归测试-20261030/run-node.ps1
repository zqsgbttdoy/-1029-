$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$out = $PSScriptRoot
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Set-Location (Join-Path $root '补后端\miniprogram')
node --test tests/api.test.cjs tests/diary-links.test.cjs tests/drafts.test.cjs tests/reports.test.cjs --test-reporter=tap *> (Join-Path $out 'node.log')
Write-Output ('NODE_EXIT=' + $LASTEXITCODE)
Select-String -Path (Join-Path $out 'node.log') -Pattern '^# (tests|pass|fail|cancelled|skipped)' | ForEach-Object Line
Set-Location $root
node (Resolve-Path '测试工作区\小程序编译预检.cjs') *> (Join-Path $out 'miniprogram.log')
Write-Output ('MP_EXIT=' + $LASTEXITCODE)
