$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = 'E:\希地工作\trae 文件保存\完整版-监理 - qoder\测试工作区\.edge-participants-prod'
$edgeArgs = @(
  '--headless=new',
  '--remote-debugging-port=19311',
  '--remote-debugging-address=127.0.0.1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  ('--user-data-dir=' + $profile),
  'about:blank'
)
Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null
Write-Host 'EDGE_LAUNCHED port=19311 profile=' $profile
