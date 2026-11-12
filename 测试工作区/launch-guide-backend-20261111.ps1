# 填写指引下线验收后端：e2e profile（H2 内存库 MySQL 兼容模式），端口 18090，不触碰 8080/8081/local-data
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# 根目录由脚本位置推导，避免 PS5.1 按 GBK 解码无 BOM 的 UTF-8 中文路径
$root = Split-Path -Parent $PSScriptRoot
$backend = Get-ChildItem -LiteralPath $root -Directory | ForEach-Object { Join-Path $_.FullName 'backend' } | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'mvnw.cmd') } | Select-Object -First 1
# Maven 生成的 classpath 文件是 UTF-8，必须显式按 UTF-8 读取，否则中文路径乱码
$cp = (Get-Content -LiteralPath (Join-Path $backend 'cp-sync-1111.txt') -Raw -Encoding UTF8).Trim()
$full = (Join-Path $backend 'target\classes') + ';' + $cp
$java = (Get-Command java.exe -CommandType Application | Select-Object -First 1).Source
Set-Location -LiteralPath $backend
& $java '-Dfile.encoding=UTF-8' -cp $full com.supervision.SupervisionApplication `
  --spring.profiles.active=e2e --server.port=18090 `
  "--app.upload.dir=$(Join-Path $PSScriptRoot 'guide-removal-uploads-20261111')" *>&1 |
  Out-File -FilePath (Join-Path $root 'logs\guide-removal-backend-20261111.log') -Encoding utf8