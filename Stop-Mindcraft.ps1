$ErrorActionPreference = 'Stop'
try {
    Invoke-RestMethod 'http://127.0.0.1:18081/stop' -Method Post -TimeoutSec 3
    Start-Sleep -Seconds 6
    Write-Output 'Mindcraft stopped.'
} catch { Write-Output 'Mindcraft is not running, or the control service is unavailable. Check logs\mindcraft.log.' }
