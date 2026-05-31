# Check status of Self Agent Orchestrator on Windows
$ErrorActionPreference = "Stop"

cd $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Host "✗ Not running (.env not found)" -ForegroundColor Red
    Exit 0
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

$isRunning = $false
$pid = $null

if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            $isRunning = $true
        }
    }
}

# Fallback: check by process command line
if (-not $isRunning) {
    $proc = Get-CimInstance Win32_Process -Filter "CommandLine like '%node server.js%'" -ErrorAction SilentlyContinue
    if ($proc) {
        $isRunning = $true
        $pid = $proc[0].ProcessId
        Write-Host "⚠ Running but no pidfile or stale pidfile (pid $pid)" -ForegroundColor Yellow
    }
}

if ($isRunning) {
    # Get IP addresses on Windows
    $localIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi", "Ethernet" -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
    if (-not $localIp) {
        $localIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
    }
    
    # Tailscale IP
    $tailscaleIp = $null
    if (Get-Command tailscale -ErrorAction SilentlyContinue) {
        $tailscaleIp = (tailscale ip -4 2>$null | Select-Object -First 1)
    }
    
    Write-Host "✓ Running (pid $pid)" -ForegroundColor Green
    if ($tailscaleIp) {
        Write-Host "  Tailscale:  http://$($tailscaleIp.Trim()):$port" -ForegroundColor Cyan
    }
    if ($localIp) {
        Write-Host "  Local LAN:  http://$($localIp):$port" -ForegroundColor Cyan
    }
    Write-Host "  Localhost:  http://127.0.0.1:$port" -ForegroundColor Cyan
    Write-Host "  Logs:       Get-Content `"$logFile`" -Wait" -ForegroundColor Cyan
} else {
    Write-Host "✗ Not running." -ForegroundColor Red
}
