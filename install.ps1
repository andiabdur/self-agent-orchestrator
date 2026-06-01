# Self Agent Orchestrator - Windows Installer
# This script configures .env and sets up the background service for Windows.

$ErrorActionPreference = "Stop"

# Bypass execution policy for the current process session (fixes npm.ps1 blocked errors)
try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
} catch {}

Write-Host "==============================================" -ForegroundColor Blue
Write-Host "    Self Agent Orchestrator Windows Installer" -ForegroundColor Blue
Write-Host "==============================================" -ForegroundColor Blue
Write-Host ""

$INSTALL_DIR = Get-Location
$INSTALL_DIR_PATH = $INSTALL_DIR.Path

# Check if we are in the correct project directory, otherwise clone or download it
if (-not (Test-Path "$INSTALL_DIR_PATH\package.json") -or -not (Test-Path "$INSTALL_DIR_PATH\server.js")) {
    Write-Host "📂 Current directory does not contain project files. Setting up in ./self-agent-orchestrator..." -ForegroundColor Yellow
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        git clone https://github.com/andiabdur/self-agent-orchestrator.git
        cd self-agent-orchestrator
        $INSTALL_DIR = Get-Location
        $INSTALL_DIR_PATH = $INSTALL_DIR.Path
    } else {
        Write-Host "-> git not found. Downloading project ZIP from GitHub..." -ForegroundColor Cyan
        $zipUrl = "https://github.com/andiabdur/self-agent-orchestrator/archive/refs/heads/main.zip"
        $zipPath = "$env:TEMP\self-agent-orchestrator.zip"
        
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
        
        Write-Host "-> Extracting ZIP..." -ForegroundColor Cyan
        Expand-Archive -Path $zipPath -DestinationPath "$INSTALL_DIR_PATH" -Force
        
        cd "self-agent-orchestrator-main"
        $INSTALL_DIR = Get-Location
        $INSTALL_DIR_PATH = $INSTALL_DIR.Path
    }
}

# 1. Dependency checks: Node.js & NPM
Write-Host "🔍 Checking Node.js and NPM..."
$nodeFound = $false

function Test-Node {
    try {
        $nodeVersion = node -v
        Write-Host "✓ Node.js found: $nodeVersion" -ForegroundColor Green
        return $true
    } catch {
        # Check standard installation path as fallback
        if (Test-Path "C:\Program Files\nodejs\node.exe") {
            $env:Path += ";C:\Program Files\nodejs"
            try {
                $nodeVersion = node -v
                Write-Host "✓ Node.js found at C:\Program Files\nodejs: $nodeVersion" -ForegroundColor Green
                return $true
            } catch {}
        }
        return $false
    }
}

if (Test-Node) {
    $nodeFound = $true
} else {
    Write-Host "⚠ Node.js not found. Attempting automatic installation..." -ForegroundColor Yellow
    
    $installed = $false
    
    # Try 1: winget
    try {
        winget --version > $null
        Write-Host "-> Trying to install Node.js via winget..." -ForegroundColor Cyan
        Start-Process winget -ArgumentList "install --id OpenJS.NodeJS --silent --accept-source-agreements --accept-package-agreements" -Wait -NoNewWindow
        $installed = $true
    } catch {
        Write-Host "-> winget is not available or failed." -ForegroundColor Yellow
    }
    
    # Try 2: choco
    if (-not $installed) {
        $chocoPath = Get-Command choco -ErrorAction SilentlyContinue
        if ($chocoPath) {
            try {
                Write-Host "-> Trying to install Node.js via Chocolatey..." -ForegroundColor Cyan
                Start-Process choco -ArgumentList "install nodejs -y" -Wait -NoNewWindow
                $installed = $true
            } catch {}
        }
    }
    
    # Try 3: scoop
    if (-not $installed) {
        $scoopPath = Get-Command scoop -ErrorAction SilentlyContinue
        if ($scoopPath) {
            try {
                Write-Host "-> Trying to install Node.js via Scoop..." -ForegroundColor Cyan
                Start-Process scoop -ArgumentList "install nodejs" -Wait -NoNewWindow
                $installed = $true
            } catch {}
        }
    }
    
    # Try 4: Download official MSI and run installer wizard
    if (-not $installed) {
        try {
            Write-Host "-> All command line package managers failed." -ForegroundColor Yellow
            Write-Host "-> Downloading official Node.js installer (MSI) from nodejs.org..." -ForegroundColor Cyan
            
            $msiUrl = "https://nodejs.org/dist/v20.12.2/node-v20.12.2-x64.msi"
            $msiPath = "$env:TEMP\node-v20.12.2-x64.msi"
            
            # Set TLS 1.2 for download
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath
            
            Write-Host "✓ Installer downloaded. Opening installation wizard..." -ForegroundColor Green
            Write-Host "Please follow the instructions in the setup window to install Node.js." -ForegroundColor Green
            
            # Start installer wizard and wait for completion
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`"" -Wait -PassThru
            if ($proc.ExitCode -eq 0) {
                $installed = $true
            } else {
                Write-Host "⚠ Installation wizard returned code: $($proc.ExitCode)" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "✗ Failed to download official Node.js MSI: $_" -ForegroundColor Red
        }
    }
    
    # Refresh PATH environment variables
    Write-Host "Refreshing PATH environment variables..." -ForegroundColor Cyan
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (Test-Path "C:\Program Files\nodejs") {
        $env:Path += ";C:\Program Files\nodejs"
    }

    # Recheck Node
    if (Test-Node) {
        $nodeFound = $true
    } else {
        Write-Host "✗ Node.js is still not detected after installation." -ForegroundColor Red
        Write-Host "Please download and install Node.js manually from: https://nodejs.org/" -ForegroundColor Red
        Write-Host "Once installed, restart this script." -ForegroundColor Red
        Exit
    }
}

# 2. Claude CLI detection
Write-Host "`n🔍 Checking Claude CLI..."
$claudePath = ""

function Find-Claude {
    $claudeExe = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeExe) {
        $source = $claudeExe.Source
        if ($source -like "*.ps1") {
            $cmdPath = $source -replace "\.ps1$", ".cmd"
            if (Test-Path $cmdPath) {
                return $cmdPath
            }
        }
        return $source
    }
    
    # Check default locations
    $userProfile = $env:USERPROFILE
    $possiblePaths = @(
        "$userProfile\AppData\Roaming\npm\claude.cmd",
        "$userProfile\AppData\Local\Programs\claude\claude.exe"
    )
    foreach ($path in $possiblePaths) {
        if (Test-Path $path) {
            return $path
        }
    }
    return $null
}

$claudePath = Find-Claude

if (-not $claudePath) {
    Write-Host "⚠ Claude CLI not found. Attempting to install @anthropic-ai/claude-code globally..." -ForegroundColor Yellow
    try {
        # Run npm.cmd directly to avoid PowerShell script execution policy issues with npm.ps1
        $proc = Start-Process -FilePath "npm.cmd" -ArgumentList "install -g @anthropic-ai/claude-code" -Wait -PassThru -NoNewWindow
        if ($proc.ExitCode -eq 0) {
            Write-Host "✓ Claude CLI installed successfully!" -ForegroundColor Green
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Path "$env:APPDATA\npm") {
                $env:Path += ";$env:APPDATA\npm"
            }
            $claudePath = Find-Claude
        } else {
            Write-Host "✗ Global installation returned exit code: $($proc.ExitCode)" -ForegroundColor Red
        }
    } catch {
        Write-Host "✗ Failed to run npm install globally: $_" -ForegroundColor Red
    }
}

if ($claudePath) {
    Write-Host "✓ Claude CLI found at: $claudePath" -ForegroundColor Green
} else {
    Write-Host "⚠ Claude CLI not detected." -ForegroundColor Yellow
    Write-Host "Please install it manually using: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
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

# Multi-node setup (optional)
Write-Host ""
$multiNode = Read-Host "Set up multi-node? (control other machines from this UI) (y/n) [n]"
if ([string]::IsNullOrWhiteSpace($multiNode)) { $multiNode = "n" }

$nodeName = ""
$nodesJson = ""

if ($multiNode -match '^[yY]') {
    $defaultNodeName = $env:COMPUTERNAME
    $nodeNameInput = Read-Host "  Friendly name for THIS machine [$defaultNodeName]"
    if ([string]::IsNullOrWhiteSpace($nodeNameInput)) { $nodeName = $defaultNodeName } else { $nodeName = $nodeNameInput }

    $nodes = New-Object System.Collections.ArrayList
    while ($true) {
        Write-Host ""
        $addNode = Read-Host "  Add a remote node? (y/n) [y]"
        if ([string]::IsNullOrWhiteSpace($addNode)) { $addNode = "y" }
        if ($addNode -notmatch '^[yY]') { break }

        $nodeId = Read-Host "    Node ID (short, no spaces, e.g., 'laptop-b')"
        if ([string]::IsNullOrWhiteSpace($nodeId) -or $nodeId -eq "local") {
            Write-Host "    ⚠ Skipped (id empty or 'local' is reserved)" -ForegroundColor Yellow
            continue
        }

        $nodeFriendly = Read-Host "    Friendly display name [Node $nodeId]"
        if ([string]::IsNullOrWhiteSpace($nodeFriendly)) { $nodeFriendly = "Node $nodeId" }

        $nodeUrl = Read-Host "    URL (e.g., http://laptop-b:7000)"
        if ([string]::IsNullOrWhiteSpace($nodeUrl)) {
            Write-Host "    ⚠ Skipped (URL is required)" -ForegroundColor Yellow
            continue
        }

        $nodeUser = Read-Host "    Username [$webUser]"
        if ([string]::IsNullOrWhiteSpace($nodeUser)) { $nodeUser = $webUser }

        $nodePass = Read-Host "    Password [$webPass]"
        if ([string]::IsNullOrWhiteSpace($nodePass)) { $nodePass = $webPass }

        [void]$nodes.Add([PSCustomObject]@{
            id       = $nodeId
            name     = $nodeFriendly
            url      = $nodeUrl
            username = $nodeUser
            password = $nodePass
        })
        Write-Host "    ✓ Added: $nodeFriendly" -ForegroundColor Green
    }

    if ($nodes.Count -gt 0) {
        # Force array wrap (ConvertTo-Json unwraps single-element arrays without it)
        $nodesJson = ConvertTo-Json @($nodes) -Compress
        Write-Host "✓ Configured $($nodes.Count) remote node(s)" -ForegroundColor Green
    } else {
        Write-Host "⚠ No remote nodes added — only NODE_NAME will be set." -ForegroundColor Yellow
    }
}

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

if (-not [string]::IsNullOrWhiteSpace($nodeName)) {
    $envContent += "`n`n# Multi-node: Friendly name for this machine (shown in sidebar)`nNODE_NAME=$nodeName"
}
if (-not [string]::IsNullOrWhiteSpace($nodesJson)) {
    $envContent += "`n`n# Multi-node: Remote nodes to connect to (JSON array)`nNODES=$nodesJson"
}

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
$autostart = Read-Host "Do you want to enable autostart on system boot? (y/n) [n]"
if ([string]::IsNullOrWhiteSpace($autostart)) { $autostart = "n" }

$serviceStarted = $false

if ($autostart -eq "y" -or $autostart -eq "Y") {
    Write-Host "`nSetting up Windows Startup Shortcut..."
    
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
        Write-Host "[OK] Startup shortcut added successfully." -ForegroundColor Green
        
        # Start it right now using our new start.ps1 script!
        Write-Host "`nStarting service in the background..." -ForegroundColor Cyan
        & "$INSTALL_DIR_PATH\start.ps1"
        $serviceStarted = $true
    } catch {
        Write-Host "[ERROR] Failed to create startup shortcut: $_" -ForegroundColor Red
    }
} else {
    Write-Host "`nSkipping autostart configuration."
}

# NOTE: If autostart was NOT selected, we do NOT automatically start the service.
# This satisfies the user's request: "jika tidak memilih autostart default nya no autostart ya, service nya jangan di running"

Write-Host "`nInstallation completed successfully!" -ForegroundColor Green
Write-Host "----------------------------------------------"
Write-Host "Web Access: http://localhost:$webPort"
Write-Host "Username:   $webUser"
Write-Host "Password:   $webPass"
Write-Host "----------------------------------------------"

if ($serviceStarted) {
    Write-Host "Autostart is configured. It is currently running in the background."
    Write-Host "To stop:    Run .\stop.bat (CMD) or .\stop.ps1 (PowerShell)"
    Write-Host "To status:  Run .\status.bat (CMD) or .\status.ps1 (PowerShell)"
    Write-Host "To remove autostart: Delete the shortcut 'self-agent-orchestrator.lnk' in your Startup folder:"
    Write-Host "            (Run shell:startup to open the folder)"
} else {
    Write-Host "Service is NOT running." -ForegroundColor Yellow
    Write-Host "To start:   Run .\start.bat (CMD) or .\start.ps1 (PowerShell)"
    Write-Host "To stop:    Run .\stop.bat (CMD) or .\stop.ps1 (PowerShell)"
    Write-Host "To status:  Run .\status.bat (CMD) or .\status.ps1 (PowerShell)"
}
Write-Host "=============================================="


