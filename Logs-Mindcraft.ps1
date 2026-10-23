Get-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\mindcraft.log') -Tail 80 -Wait -Encoding UTF8
