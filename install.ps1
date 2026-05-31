# Self Agent Orchestrator - Windows Installer
# This script configures .env and sets up the background service for Windows.

$ErrorActionPreference = "Stop"

Write-Host "==============================================" -ForegroundColor Blue
Write-Host "    Self Agent Orchestrator Windows Installer" -ForegroundColor Blue
Write-Host "==============================================" -ForegroundColor Blue
Write-Host ""

$INSTALL_DIR = Get-Location
$INSTALL_DIR_PATH = $INSTALL_DIR.Path

# 1. Dependency checks: Node.js & NPM
Write-Host "🔍 Checking Node.js and NPM..."
$nodeFound = $false
try {
    $nodeVersion = node -v
    Write-Host "✓ Node.js found: $nodeVersion" -ForegroundColor Green
    $nodeFound = $true
} catch {
    Write-Host "⚠ Node.js not found in PATH." -ForegroundColor Yellow
    Write-Host "Attempting to detect Node via winget..." -ForegroundColor Yellow
    
    # Try winget detection
    try {
        winget --version > $null
        Write-Host "winget found. You can install Node.js by running:" -ForegroundColor Green
        Write-Host "winget install OpenJS.NodeJS" -ForegroundColor Cyan
    } catch {
        Write-Host "Please download and install Node.js manually from: https://nodejs.org/" -ForegroundColor Red
    }
    
    Write-Host "Exiting installer. Please install Node.js and restart this installer." -ForegroundColor Red
    Exit
}

# 2. Claude CLI detection
Write-Host "`n🔍 Checking Claude CLI..."
$claudePath = ""

# Try standard PATH search
$claudeExe = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeExe) {
    $claudePath = $claudeExe.Source
} else {
    # Check default locations
    $userProfile = $env:USERPROFILE
    $possiblePaths = @(
        "$userProfile\AppData\Roaming\npm\claude.cmd",
        "$userProfile\AppData\Local\Programs\claude\claude.exe"
    )
    foreach ($path in $possiblePaths) {
        if (Test-Path $path) {
            $claudePath = $path
            break
        }
    }
}

if ($claudePath) {
    Write-Host "✓ Claude CLI found at: $claudePath" -ForegroundColor Green
} else {
    Write-Host "⚠ Claude CLI not detected in standard locations." -ForegroundColor Yellow
    Write-Host "Make sure it is installed via 'npm install -g @anthropic-ai/claude-code' and you have logged in." -ForegroundColor Yellow
    $claudePath = "$env:USERPROFILE\AppData\Roaming\npm\claude.cmd" # fallback default
}

# 3. Interactive Configuration
Write-Host "`n⚙️ Setting up configurations..."

# Username
$webUser = Read-Host "Enter web interface username [admin]"
if ([string]::IsNullOrWhiteSpace($webUser)) { $webUser = "admin" }

# Generate random password
$charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
$randPass = ""
for ($i = 0; $i -lt 12; $i++) {
    $randPass += $charset[(Get-Random -Minimum 0 -Maximum $charset.Length)]
}

$webPass = Read-Host "Enter web interface password [$randPass]"
if ([string]::IsNullOrWhiteSpace($webPass)) { $webPass = $randPass }

# Port
$webPort = Read-Host "Enter port number [7000]"
if ([string]::IsNullOrWhiteSpace($webPort)) { $webPort = "7000" }

# Default CWD (escape backslashes for JS strings)
$defaultCWD = $env:USERPROFILE
$agentCWD = Read-Host "Enter default working directory [$defaultCWD]"
if ([string]::IsNullOrWhiteSpace($agentCWD)) { $agentCWD = $defaultCWD }
$agentCWD = $agentCWD -replace '\\', '/'

# Claude path override
$claudePathRaw = Read-Host "Enter Claude binary path [$claudePath]"
if (-not [string]::IsNullOrWhiteSpace($claudePathRaw)) { $claudePath = $claudePathRaw }
$claudePath = $claudePath -replace '\\', '/'

# Model
$claudeModel = Read-Host "Enter default model (sonnet/opus/haiku) [sonnet]"
if ([string]::IsNullOrWhiteSpace($claudeModel)) { $claudeModel = "sonnet" }

# Permission mode
$permMode = Read-Host "Enter permission mode (bypassPermissions/acceptEdits/plan) [bypassPermissions]"
if ([string]::IsNullOrWhiteSpace($permMode)) { $permMode = "bypassPermissions" }

# 4. Generate .env file
Write-Host "`n📝 Generating .env file..."
$envContent = @"
# Authentication
WEB_USERNAME=$webUser
WEB_PASSWORD=$webPass

# Server configuration
PORT=$webPort
HOST=0.0.0.0

# Claude Configuration
CLAUDE_BIN=$claudePath
AGENT_CWD=$agentCWD
CLAUDE_MODEL=$claudeModel
PERMISSION_MODE=$permMode

# State directory (sessions, logs)
STATE_DIR=$env:USERPROFILE/.self-agent-orchestrator
"@

Set-Content -Path "$INSTALL_DIR_PATH\.env" -Value $envContent -Encoding utf8
Write-Host "✓ .env file created successfully." -ForegroundColor Green

# 4b. Migrate old data if exists
$oldStateDir = "$env:USERPROFILE\.agent-web-terminal"
$newStateDir = "$env:USERPROFILE\.self-agent-orchestrator"
if ((Test-Path $oldStateDir) -and -not (Test-Path "$newStateDir\sessions.json")) {
    Write-Host "`n🔄 Migrating chat history from old agent-web-terminal directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $newStateDir | Out-Null
    if (Test-Path "$oldStateDir\sessions.json") {
        Copy-Item -Path "$oldStateDir\sessions.json" -Destination $newStateDir -Force
    }
    if (Test-Path "$oldStateDir\sessions") {
        Copy-Item -Path "$oldStateDir\sessions" -Destination $newStateDir -Recurse -Force
    }
    Write-Host "✓ Chat history migrated successfully." -ForegroundColor Green
}

# 5. NPM Install
Write-Host "`n📦 Installing Node.js dependencies..."
npm install --no-audit --no-fund
Write-Host "✓ Dependencies installed successfully." -ForegroundColor Green

# 6. Autostart option
Write-Host ""
$autostart = Read-Host "Do you want to enable autostart on system boot? (y/n) [y]"
if ([string]::IsNullOrWhiteSpace($autostart)) { $autostart = "y" }

$serviceStarted = $false

if ($autostart -eq "y" -or $autostart -eq "Y") {
    Write-Host "`n🖥️ Setting up Windows Startup Shortcut..."
    
    # Create background VBS launcher to run node invisibly
    $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$INSTALL_DIR_PATH"
WshShell.Run "node server.js", 0, false
"@
    Set-Content -Path "$INSTALL_DIR_PATH\launcher.vbs" -Value $vbsContent -Encoding Ascii
    
    # Create shortcut in user's Startup folder
    $startupFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    $shortcutPath = "$startupFolder\self-agent-orchestrator.lnk"
    
    try {
        $wshShellObj = New-Object -ComObject WScript.Shell
        $shortcut = $wshShellObj.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = "wscript.exe"
        $shortcut.Arguments = "`"$INSTALL_DIR_PATH\launcher.vbs`""
        $shortcut.WorkingDirectory = $INSTALL_DIR_PATH
        $shortcut.Description = "Self Agent Orchestrator background launcher"
        $shortcut.Save()
        Write-Host "✓ Startup shortcut added successfully." -ForegroundColor Green
        
        # Start it right now
        Start-Process "wscript.exe" -ArgumentList "`"$INSTALL_DIR_PATH\launcher.vbs`"" -WorkingDirectory $INSTALL_DIR_PATH
        Write-Host "✓ Started service in the background." -ForegroundColor Green
        $serviceStarted = $true
    } catch {
        Write-Host "✗ Failed to create startup shortcut: $_" -ForegroundColor Red
    }
} else {
    Write-Host "`nSkipping autostart configuration."
}

if (-not $serviceStarted) {
    Write-Host "`n🚀 Starting service manually in background..."
    # Run node server.js in background
    Start-Process "node" -ArgumentList "server.js" -WorkingDirectory $INSTALL_DIR_PATH -WindowStyle Hidden
    Write-Host "✓ Started manually in the background." -ForegroundColor Green
}

Write-Host "`n🎉 Installation completed successfully!" -ForegroundColor Green
Write-Host "----------------------------------------------"
Write-Host "Web Access: http://localhost:$webPort"
Write-Host "Username:   $webUser"
Write-Host "Password:   $webPass"
Write-Host "----------------------------------------------"

if ($serviceStarted) {
    Write-Host "Autostart is configured. It will run in the background."
    Write-Host "To stop:    Use Task Manager to terminate the 'node.exe' process."
    Write-Host "To remove autostart: Delete the shortcut 'self-agent-orchestrator.lnk' in your Startup folder:"
    Write-Host "            (Run shell:startup to open the folder)"
} else {
    Write-Host "Start command:  node server.js"
    Write-Host "Stop command:   Close the running node process (Task Manager or Ctrl+C if run in foreground)"
}
Write-Host "=============================================="
