$ErrorActionPreference = 'Stop'
$root = 'e:\希地工作\trae 文件保存\完整版-监理 - qoder'
$reports = Join-Path $root '测试工作区\回归测试-20261030\surefire'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'
Set-Location (Join-Path $root '补后端\backend')
& '.\.mvn\maven\apache-maven-3.9.6\bin\mvn.cmd' -o -B ("-Dmaven.repo.local=" + (Join-Path $root '.m2-cache')) ("-Dqa.reportsDirectory=" + $reports) test
Write-Output ('MAVEN_EXIT=' + $LASTEXITCODE)
