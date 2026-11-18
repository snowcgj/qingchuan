$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$port = if ($env:PORT) { $env:PORT } else { '4317' }
try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/local-info') -TimeoutSec 2
    if ($health.app -eq 'qingchuan') {
        Start-Process ('http://127.0.0.1:' + $port)
        exit 0
    }
} catch { }
$nodeCandidates = @('runtime/node.exe', '.runtime/node.exe', 'node_modules/node/bin/node.exe')
$localNode = $nodeCandidates | ForEach-Object { Join-Path $projectRoot $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $localNode) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $localNode = $nodeCommand.Source }
}
if (-not $localNode) {
    Write-Host '请下载带 runtime 目录的 Windows 便携包，或安装 Node.js 22.18 及以上版本。' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}
$detectedVersion = & $localNode -p 'process.versions.node'
if ([version]$detectedVersion -lt [version]'22.18.0') { Write-Host '需要 Node.js 22.18 或以上，请使用便携包。' -ForegroundColor Yellow; Read-Host '按回车退出'; exit 1 }
$env:Path = (Split-Path -Parent $localNode) + ';' + $env:Path
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist-local/index.html'))) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/vite/bin/vite.js'))) {
        Write-Host '缺少网页构建产物。源码用户请先运行 npm ci 和 npm run build。' -ForegroundColor Yellow
        Read-Host '按回车退出'
        exit 1
    }
    & $localNode 'node_modules/vite/bin/vite.js' build --config vite.local.config.ts
    if ($LASTEXITCODE -ne 0) { Read-Host '构建失败，按回车退出'; exit 1 }
}
Write-Host ('电脑入口：http://127.0.0.1:' + $port)
& $localNode --disable-warning=ExperimentalWarning 'scripts/local-server.mjs' --open
if ($LASTEXITCODE -ne 0) { Read-Host '启动失败，按回车退出' }
