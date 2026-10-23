$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try {
    $state = Invoke-RestMethod 'http://127.0.0.1:18081/status' -TimeoutSec 2
    if ($state.running) { Write-Output 'Mindcraft is already running. Open http://localhost:18080'; exit 0 }
} catch {}
$node = Join-Path $root 'runtime\node-v22.23.3-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Install Node.js 22.x, or provide the optional portable runtime.' }
    $node = $nodeCommand.Source
}
$nodeVersion = & $node --version
if ($nodeVersion -notmatch '^v22\.') { throw "Node.js 22.x is required; found $nodeVersion" }
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
$script = Join-Path $root 'deployment\supervisor.cjs'
Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WorkingDirectory $root -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 2
Invoke-RestMethod 'http://127.0.0.1:18081/status' -TimeoutSec 3 | Select-Object supervisorPid,mainPid,running
Write-Output 'Dashboard: http://localhost:18080 | Log: logs\mindcraft.log'
