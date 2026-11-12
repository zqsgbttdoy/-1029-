$ErrorActionPreference = 'Stop'
# Isolated e2e backend (fat jar) + static proxy for problem-upload-removal acceptance.
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less files as GBK.
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backendDir = Get-ChildItem $root -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'backend\pom.xml') } | Select-Object -First 1
if (-not $backendDir) { throw 'backend module not found' }
$jar = Get-ChildItem (Join-Path $backendDir.FullName 'backend\target') -Filter '*.jar' | Where-Object { $_.Length -gt 10000000 } | Select-Object -First 1
if (-not $jar) { throw 'fat jar not found' }
$java = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot\bin\java.exe'
foreach ($port in 18090, 18091) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "port busy: $port" }
}
$run = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$runDir = Join-Path $PSScriptRoot "runs\$run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$env:SPRING_DATASOURCE_URL = "jdbc:h2:mem:pur$run;MODE=MySQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=15000"
$env:LOG_PATH = Join-Path $runDir 'logs'
$env:APP_UPLOAD_DIR = Join-Path $runDir 'uploads'
New-Item -ItemType Directory -Force -Path $env:LOG_PATH, $env:APP_UPLOAD_DIR | Out-Null
$backend = Start-Process -FilePath $java -ArgumentList '-jar', ('"' + $jar.FullName + '"'), '--spring.profiles.active=e2e', '--server.port=18090', '--server.address=127.0.0.1' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'backend.out') -RedirectStandardError (Join-Path $runDir 'backend.err') -WorkingDirectory $backendDir.FullName
$env:E2E_BACKEND_PORT = '18090'
$env:E2E_STATIC_PORT = '18091'
$static = Start-Process -FilePath 'node' -ArgumentList 'e2e-static-server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir 'static.out') -RedirectStandardError (Join-Path $runDir 'static.err')
"run=$run backend=$($backend.Id) static=$($static.Id)" | Tee-Object -FilePath (Join-Path $PSScriptRoot 'run-ids.txt')