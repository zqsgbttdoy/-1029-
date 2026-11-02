$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$ports = @(18130, 18131)
foreach ($port in $ports) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "验收端口已占用：$port；不停止既有实例" }
}
$run = [Guid]::NewGuid().ToString('N')
$env:LOG_PATH = Join-Path $PSScriptRoot "runs/$run/logs"
$env:APP_UPLOAD_DIR = Join-Path $PSScriptRoot "runs/$run/uploads"
$env:SPRING_DATASOURCE_URL = "jdbc:h2:mem:diarylinks$run;MODE=MySQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=15000"
$env:SPRING_PROFILES_ACTIVE = 'e2e'
$env:JAVA_TOOL_OPTIONS = (($env:JAVA_TOOL_OPTIONS + ' -Dfile.encoding=UTF-8').Trim())
$mvn = Join-Path $root '补后端/backend/.mvn/maven/apache-maven-3.9.6/bin/mvn.cmd'
$pom = Join-Path $root '补后端/backend/pom.xml'
$repo = Join-Path $root '.m2-cache'
Write-Output "独立验收实例=$run，后端=18130，静态代理=18131，上传=$env:APP_UPLOAD_DIR"
& $mvn -o -B -f $pom "-Dmaven.repo.local=$repo" '-Dspring-boot.run.profiles=e2e' '-Dspring-boot.run.arguments=--server.port=18130 --server.address=127.0.0.1' spring-boot:run
exit $LASTEXITCODE
