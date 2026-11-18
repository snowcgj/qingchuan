$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'work/local-server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host '没有发现本地服务记录。'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$serverProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $serverPid)
$expectedNodes = @('runtime/node.exe', '.runtime/node.exe', 'node_modules/node/bin/node.exe') | ForEach-Object { Join-Path $projectRoot $_ }
$systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($systemNode) { $expectedNodes += $systemNode.Source }
if ($serverProcess -and $serverProcess.ExecutablePath -in $expectedNodes -and $serverProcess.CommandLine -match 'scripts[/\\]local-server\.mjs') {
    Stop-Process -Id $serverPid
    Write-Host '轻传本地服务已停止。'
} else {
    Write-Host '记录中的轻传服务已经退出。'
}
