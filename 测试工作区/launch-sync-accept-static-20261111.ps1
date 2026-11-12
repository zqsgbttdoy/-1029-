# 隔离验收静态站：端口 18091，/api 代理到 18090，不触碰 8081
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$env:E2E_STATIC_PORT = '18091'
$env:E2E_BACKEND_PORT = '18090'
$env:E2E_STATIC_HOST = '127.0.0.1'
Set-Location -LiteralPath $root
& node (Join-Path $root 'e2e-static-server.js') *>&1 |
  Out-File -FilePath (Join-Path $root 'logs\sync-accept-static-20261111.log') -Encoding utf8