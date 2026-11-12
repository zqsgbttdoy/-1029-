# Headless Edge + CDP 19232 for problem-upload-removal acceptance; isolated profile.
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
$profileDir = Join-Path $env:TEMP ('edge-pur-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$edgeArgs = @(
  '--headless=new',
  '--remote-debugging-port=19232',
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  ('--user-data-dir="' + $profileDir + '"'),
  'about:blank'
)
$p = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru
Write-Host ('EDGE_LAUNCHED port=19232 pid=' + $p.Id)