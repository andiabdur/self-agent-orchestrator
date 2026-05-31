# Stop Self Agent Orchestrator on Windows
$ErrorActionPreference = "Stop"

cd $PSScriptRoot

$stateDir = "$env:USERPROFILE\.self-agent-orchestrator"
$pidFile = "$stateDir\server.pid"

if (-not (Test-Path $pidFile)) {
    # Fallback: find node process running server.js
    $proc = Get-CimInstance Win32_Process -Filter "CommandLine like '%node server.js%'" -ErrorAction SilentlyContinue
    if ($proc) {
        foreach ($p in $proc) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "[OK] Stopped process by name (pid $($p.ProcessId))" -ForegroundColor Green
        }
    } else {
        Write-Host "Not running." -ForegroundColor Yellow
    }
    exit 0
}

$targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($targetPid) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
        # Check if it has child processes (e.g. node.exe started by cmd.exe)
        $childProcs = Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetPid" -ErrorAction SilentlyContinue
        foreach ($cp in $childProcs) {
            Stop-Process -Id $cp.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Stopped (pid $targetPid)" -ForegroundColor Green
    } else {
        # Fallback: check if node server.js is running anyway
        $nodeProcs = Get-CimInstance Win32_Process -Filter "CommandLine like '%node server.js%'" -ErrorAction SilentlyContinue
        if ($nodeProcs) {
            foreach ($np in $nodeProcs) {
                Stop-Process -Id $np.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Write-Host "[OK] Stopped node server processes by name" -ForegroundColor Green
        } else {
            Write-Host "Not running (stale pidfile)" -ForegroundColor Yellow
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "Not running." -ForegroundColor Yellow
}
