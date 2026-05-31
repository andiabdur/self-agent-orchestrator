# Start Self Agent Orchestrator in background on Windows
$ErrorActionPreference = "Stop"

cd $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Host "✗ .env not found. Please run installation first." -ForegroundColor Red
    Exit 1
}

# Load port from .env
$port = "7000"
Get-Content .env | Foreach-Object {
    if ($_ -match "^PORT=(.*)") {
        $port = $Matches[1].Trim()
    }
}

$stateDir = "$env:USERPROFILE\.self-agent-orchestrator"
$pidFile = "$stateDir\server.pid"
$logFile = "$stateDir\logs\server.log"

New-Item -ItemType Directory -Force -Path "$stateDir\logs" | Out-Null

# Check if already running
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($proc -and ($proc.ProcessName -like "*node*" -or $proc.ProcessName -eq "cmd")) {
            Write-Host "Already running (pid $oldPid). Use stop.ps1 first." -ForegroundColor Yellow
            Exit 0
        }
    }
}

# Start node server silently in background
$args = "/c node server.js >> `"$logFile`" 2>&1"
$proc = Start-Process cmd.exe -ArgumentList $args -WindowStyle Hidden -PassThru

# Write PID
$proc.Id | Out-File -FilePath $pidFile -Encoding ascii -Force

Start-Sleep -Seconds 1
$runningProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($runningProc) {
    Write-Host "✓ Started (pid $($proc.Id))" -ForegroundColor Green
    Write-Host "  HTTP:  http://localhost:$port" -ForegroundColor Cyan
    Write-Host "  Logs:  Get-Content `"$logFile`" -Wait" -ForegroundColor Cyan
} else {
    Write-Host "✗ Failed to start. Check logs at: $logFile" -ForegroundColor Red
}
