# Restart Self Agent Orchestrator on Windows
$ErrorActionPreference = "Stop"

cd $PSScriptRoot

Write-Host "Restarting Self Agent Orchestrator..." -ForegroundColor Cyan

# Stop service
if (Test-Path "stop.ps1") {
    & .\stop.ps1
}

Start-Sleep -Seconds 1

# Start service
if (Test-Path "start.ps1") {
    & .\start.ps1
}
