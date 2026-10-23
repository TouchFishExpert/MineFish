$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$portableNode = Join-Path $root 'runtime\node-v22.23.3-win-x64'
if (Test-Path -LiteralPath (Join-Path $portableNode 'node.exe')) { $env:PATH = $portableNode + ';' + $env:PATH }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.x and npm first.' }
$nodeVersion = & node.exe --version
if ($nodeVersion -notmatch '^v22\.') { throw "Node.js 22.x is required; found $nodeVersion" }
$env:npm_config_cache = Join-Path $root 'runtime\npm-cache'
Set-Location (Join-Path $root 'mindcraft')
& npm.cmd ci --include=dev --foreground-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Do not start until repaired.' }
