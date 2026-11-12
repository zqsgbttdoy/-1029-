# 填写指引下线验收：无头 Edge + CDP 19232，独立 profile，不影响用户浏览器
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
$profileDir = Join-Path $PSScriptRoot '.edge-guide-removal-20261111'
$edgeArgs = @(
  '--headless=new',
  '--remote-debugging-port=19232',
  '--remote-debugging-address=127.0.0.1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  ('--user-data-dir="' + $profileDir + '"'),
  'about:blank'
)
Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null
Write-Host 'EDGE_LAUNCHED port=19232'