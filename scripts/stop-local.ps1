# ============================================================================
#  监理现场管理系统 · 停止本地服务（后端 8080 + 页面服务 8081）
#  由根目录"停止服务.bat"调用（bat 只含 ASCII 字符并执行 chcp 65001，本文件以 UTF-8 显式读取）。
#  只结束本系统进程：命令行含 supervision-site-management 的 java，或含 e2e-static-server.js 的 node；
#  端口若被其他程序占用，只提示不结束。
# ============================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { $Host.UI.RawUI.WindowTitle = '监理现场管理系统 - 停止服务' } catch {}

$Targets = @(
    @{ Name = '后端服务'; Port = 8080; Sig = 'supervision-site-management'; Exe = @('java.exe', 'javaw.exe') },
    @{ Name = '页面服务'; Port = 8081; Sig = 'e2e-static-server.js'; Exe = @('node.exe') }
)

function Get-PortPid([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch {}
    $m = netstat -ano | Select-String -Pattern ("^\s*TCP\s+\S+:{0}\s+\S+\s+LISTENING\s+(\d+)" -f $Port) | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
    return 0
}

Write-Host '=============================================='
Write-Host '   监理现场管理系统 - 停止本地服务'
Write-Host '=============================================='
Write-Host ''

$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$backendPid = Get-PortPid 8080
$protected = @($all | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains('supervision-site-management') -and
    ($_.ProcessId -eq $backendPid -or $_.CommandLine -match '--server.port=8080(?:\s|$)') -and
    $_.CommandLine -notmatch '--spring.profiles.active=local(?:\s|$)'
})
if ($protected.Count -gt 0) {
    Write-Host '[数据保护] 检测到非 local 后端，可能仍使用内存数据库。本次没有停止任何服务。' -ForegroundColor Yellow
    Write-Host '请先完成现有数据导出、附件备份与还原验证，不能直接停止旧内存库。'
    exit 1
}
foreach ($t in $Targets) {
    # 按进程命令行特征查找（包括尚未开始监听端口、仍在启动中的进程）
    $portPid = Get-PortPid $t.Port
    $procs = @($all | Where-Object {
        $_.CommandLine -and ($t.Exe -contains $_.Name.ToLowerInvariant()) -and $_.CommandLine.Contains($t.Sig) -and
        ($_.ProcessId -eq $portPid -or ($t.Port -eq 8080 -and $_.CommandLine -match '--server.port=8080(?:\s|$)' -and $_.CommandLine -match '--spring.profiles.active=local(?:\s|$)'))
    })
    $ownIds = @($procs | ForEach-Object { [int]$_.ProcessId })

    if ($procs.Count -eq 0) {
        Write-Host "[提示] $($t.Name)未在运行。"
    } else {
        foreach ($p in $procs) {
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                Write-Host "[OK] 已停止$($t.Name)（端口 $($t.Port)，PID=$($p.ProcessId)）" -ForegroundColor Green
            } catch {
                Write-Host "[警告] 无法结束$($t.Name) PID=$($p.ProcessId)：$($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
    if ($portPid -ne 0 -and -not ($ownIds -contains $portPid)) {
        Write-Host "[跳过] 端口 $($t.Port) 被其他程序占用（PID=$portPid），不是本系统进程，未结束。" -ForegroundColor Yellow
        Write-Host "       如确需释放，可执行： taskkill /pid $portPid /f"
    }
}

# 复核端口是否已释放（最多等 5 秒）
Write-Host ''
foreach ($t in $Targets) {
    $left = 0
    for ($i = 0; $i -lt 10; $i++) {
        $left = Get-PortPid $t.Port
        if ($left -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($left -eq 0) { Write-Host "      端口 $($t.Port)：已释放" }
    else { Write-Host "      端口 $($t.Port)：仍被 PID=$left 占用" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '处理完成。数据库和附件均保留，未清理任何测试数据。再次使用时双击"一键启动.bat"即可。'
exit 0
