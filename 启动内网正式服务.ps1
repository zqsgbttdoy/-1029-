# ============================================================================
#  监理现场管理系统 · 内网正式部署启动脚本
#  （真实 MySQL 数据库，数据永久保存；与"一键启动.bat"的演示模式本质不同）
#
#  使用三步（零基础）：
#    1. 右键本文件 →「显示更多选项」→「打开方式」→ 记事本
#    2. 把下方【第 ① 步替换区】的 5 处 <尖括号> 换成真实值（去掉尖括号本身）
#    3. 保存关闭，右键本文件 →「使用 PowerShell 运行」
#
#  停止系统：关闭启动后出现的两个最小化黑色窗口（java 和 node 进程窗口）。
#  同事电脑访问：http://本电脑局域网IP:8081/login.html
# ============================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { $Host.UI.RawUI.WindowTitle = '监理系统 - 内网正式服务启动中' } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ===== 【第 ① 步替换区】以下 5 行必须换成真实值，否则本脚本拒绝启动 =====
$DbPassword    = '<操作单第3步设置的数据库密码>'
$JwtSecret     = '<操作单第5步输出的第一行64位随机密钥>'
$UploadSecret  = '<操作单第5步输出的第二行64位随机密钥，不能与上一行相同>'
$ResetPassword = '<自定义初始重置密码：至少8位，含字母和数字，禁止123456>'
$ServerIP      = '<本机局域网IP，cmd里执行ipconfig可查，如192.168.1.50>'

# ---------- 检查 1：占位符是否都替换了 ----------
foreach ($v in @($DbPassword, $JwtSecret, $UploadSecret, $ResetPassword, $ServerIP)) {
    if ($v -like '*<>*') {
        Write-Host '[错误] 本脚本还有 <尖括号> 占位符没有替换成真实值。' -ForegroundColor Red
        Write-Host '       请右键本文件 → 打开方式 → 记事本，按注释逐行替换后保存，再重新运行。'
        Read-Host '按回车键关闭窗口' | Out-Null
        exit 1
    }
}
if ($JwtSecret -eq $UploadSecret) {
    Write-Host '[错误] APP_JWT_SECRET 和 APP_UPLOAD_SIGNING_SECRET 两把密钥不能相同（安全校验要求）。' -ForegroundColor Red
    Read-Host '按回车键关闭窗口' | Out-Null
    exit 1
}

# ---------- 检查 2：后端程序包是否存在 ----------
$Jar = Join-Path $Root '补后端\backend\target\supervision-site-management-1.0.0.jar'
if (-not (Test-Path -LiteralPath $Jar)) {
    Write-Host "[错误] 未找到后端程序包：$Jar" -ForegroundColor Red
    Write-Host '       解决：先双击项目根目录的"一键启动.bat"，等它自动构建并打开登录页后，'
    Write-Host '             再双击"停止服务.bat"，然后回来运行本脚本。'
    Read-Host '按回车键关闭窗口' | Out-Null
    exit 1
}

# ---------- 检查 3：端口 8080 / 8081 是否被占用（如演示模式还在运行） ----------
function Test-PortBusy([int]$Port) {
    $t = New-Object Net.Sockets.TcpClient
    try { $t.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $t.Close() }
}
foreach ($p in @(8080, 8081)) {
    if (Test-PortBusy $p) {
        Write-Host "[错误] 端口 $p 已被占用，通常是演示服务（一键启动.bat）还在运行。" -ForegroundColor Red
        Write-Host '       请先双击"停止服务.bat"关闭演示服务，再重新运行本脚本。'
        Read-Host '按回车键关闭窗口' | Out-Null
        exit 1
    }
}

# ---------- 设置环境变量（后端生产安全校验要求的 8 项 + 本机监听） ----------
$env:SPRING_PROFILES_ACTIVE       = 'prod'
$env:SPRING_DATASOURCE_USERNAME   = 'supervision_app'
$env:SPRING_DATASOURCE_PASSWORD   = $DbPassword
$env:APP_JWT_SECRET               = $JwtSecret
$env:APP_UPLOAD_SIGNING_SECRET    = $UploadSecret
$env:APP_CORS_ALLOWED_ORIGINS     = "http://${ServerIP}:8081"
$env:APP_DEFAULT_RESET_PASSWORD   = $ResetPassword
$env:APP_UPLOAD_DIR               = (Join-Path $Root 'uploads-prod')
$env:LOG_PATH                     = (Join-Path $Root 'logs-prod')
$env:SERVER_ADDRESS               = '127.0.0.1'   # 后端只监听本机，同事统一走 8081 页面入口
$env:E2E_STATIC_HOST              = '0.0.0.0'    # 页面服务开放给局域网（已在 e2e-static-server.js 内支持）

New-Item -ItemType Directory -Force -Path $env:APP_UPLOAD_DIR, $env:LOG_PATH | Out-Null

# ---------- 启动两个服务（各自独立最小化窗口，关窗口即停止该服务） ----------
Write-Host '[1/3] 正在启动后端服务（第一次稍慢，约 30~60 秒）...'
$javaCmd = (Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $javaCmd) {
    Write-Host '[错误] 未找到 java 命令。请确认已安装 JDK 17 并勾选了 Set JAVA_HOME，重启电脑后再试。' -ForegroundColor Red
    Read-Host '按回车键关闭窗口' | Out-Null
    exit 1
}
$backend = Start-Process $javaCmd.Source -ArgumentList '-jar', $Jar -WorkingDirectory $Root -WindowStyle Minimized -PassThru

Write-Host '[2/3] 正在启动页面服务（端口 8081）...'
$nodeCmd = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $nodeCmd) {
    Write-Host '[错误] 未找到 node 命令。请安装 Node.js LTS 后重试。' -ForegroundColor Red
    Read-Host '按回车键关闭窗口' | Out-Null
    exit 1
}
Start-Process $nodeCmd.Source -ArgumentList (Join-Path $Root 'e2e-static-server.js') -WorkingDirectory $Root -WindowStyle Minimized | Out-Null

# ---------- 探活等待：后端就绪 + 页面就绪 ----------
Write-Host '[3/3] 等待服务就绪（最长 120 秒）...' -NoNewline
$backendOk = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 120) {
    if (Test-PortBusy 8080) { $backendOk = $true; break }
    if ($backend.HasExited) { break }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds 3
}
Write-Host ''
if (-not $backendOk) {
    Write-Host '[错误] 后端未能启动。请到任务栏找到最小化的"java"黑色窗口点开，' -ForegroundColor Red
    Write-Host '       查看最后几行中文报错（常见：数据库密码不对 / MySQL服务未启动 / 密钥不合规）。'
    Write-Host "       也可查看日志：$Root\logs-prod\app.log"
    Read-Host '按回车键关闭窗口' | Out-Null
    exit 1
}
Start-Sleep -Seconds 3
$staticOk = Test-PortBusy 8081

Write-Host ''
Write-Host '==============================================' -ForegroundColor Green
if ($staticOk) {
    Write-Host ' ✅ 启动完成！' -ForegroundColor Green
} else {
    Write-Host ' ⚠ 后端已就绪，但页面服务 8081 未响应（稍后重试或看node窗口报错）' -ForegroundColor Yellow
}
Write-Host " 本机访问：   http://localhost:8081/login.html"
Write-Host " 同事电脑访问：http://${ServerIP}:8081/login.html"
Write-Host ' 初始账号 admin / 密码 123456' -ForegroundColor Yellow
Write-Host ' ⚠ 登录后请立即修改 admin 密码，并停用演示账号！' -ForegroundColor Yellow
Write-Host " 照片附件目录：$env:APP_UPLOAD_DIR（请纳入日常备份）"
Write-Host " 运行日志：    $env:LOG_PATH\app.log"
Write-Host '=============================================='
Write-Host ''
if (-not (Test-NetFirewallRule -DisplayName '监理系统8081' -ErrorAction SilentlyContinue)) {
    Write-Host '[提醒] 若同事打不开页面：多半是防火墙未放行 8081。' -ForegroundColor Yellow
    Write-Host '       以管理员身份打开 PowerShell 执行：' -ForegroundColor Yellow
    Write-Host '       New-NetFirewallRule -DisplayName "监理系统8081" -Direction Inbound -Protocol TCP -LocalPort 8081 -Profile Domain,Private -Action Allow' -ForegroundColor Yellow
}
Read-Host '本窗口信息已展示完毕，按回车键关闭本窗口（不影响两个服务继续运行）' | Out-Null
