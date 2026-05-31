#!/bin/bash
# Self Agent Orchestrator - macOS & Linux Installer
# This script configures .env and sets up the background service.

set -e

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}==============================================${NC}"
echo -e "${BLUE}    Self Agent Orchestrator Installer        ${NC}"
echo -e "${BLUE}==============================================${NC}"
echo ""

# Get the installation directory (where this script is located)
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

# 1. Dependency checks: Node.js & NPM
echo -e "🔍 Checking Node.js and NPM..."
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js not found.${NC}"
    OS_TYPE="$(uname -s)"
    if [ "$OS_TYPE" = "Darwin" ]; then
        if command -v brew &> /dev/null; then
            echo "Installing Node.js via Homebrew..."
            brew install node
        else
            echo -e "${RED}Homebrew not found. Please install Node.js manually from https://nodejs.org/${NC}"
            exit 1
        fi
    elif [ "$OS_TYPE" = "Linux" ]; then
        if command -v apt-get &> /dev/null; then
            echo "Installing Node.js via apt..."
            sudo apt-get update && sudo apt-get install -y nodejs npm
        elif command -v dnf &> /dev/null; then
            echo "Installing Node.js via dnf..."
            sudo dnf install -y nodejs npm
        else
            echo -e "${RED}Package manager not supported automatically. Please install Node.js manually.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Unsupported OS type. Please install Node.js manually.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Node.js found: $(node -v)${NC}"
fi

# 2. Claude CLI detection
echo -e "\n🔍 Checking Claude CLI..."
CLAUDE_PATH=""
if command -v claude &> /dev/null; then
    CLAUDE_PATH="$(command -v claude)"
elif [ -f "$HOME/.local/bin/claude" ]; then
    CLAUDE_PATH="$HOME/.local/bin/claude"
elif [ -f "/usr/local/bin/claude" ]; then
    CLAUDE_PATH="/usr/local/bin/claude"
elif [ -f "/opt/homebrew/bin/claude" ]; then
    CLAUDE_PATH="/opt/homebrew/bin/claude"
fi

if [ -n "$CLAUDE_PATH" ]; then
    echo -e "${GREEN}✓ Claude CLI found at: $CLAUDE_PATH${NC}"
else
    echo -e "${YELLOW}⚠ Claude CLI not detected in standard locations.${NC}"
    echo -e "${YELLOW}Make sure it is installed via 'npm install -g @anthropic-ai/claude-code' and you have logged in.${NC}"
    CLAUDE_PATH="$HOME/.local/bin/claude" # fallback default
fi

# 3. Interactive Configuration
echo -e "\n⚙️ Setting up configurations..."

# Username
read -p "Enter web interface username [admin]: " WEB_USER
WEB_USER="${WEB_USER:-admin}"

# Generate a random 12-char password
RAND_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12 || echo "orchestrate123")
read -p "Enter web interface password [$RAND_PASS]: " WEB_PASS
WEB_PASS="${WEB_PASS:-$RAND_PASS}"

# Port
read -p "Enter port number [7000]: " WEB_PORT
WEB_PORT="${WEB_PORT:-7000}"

# Default CWD
DEFAULT_CWD="$HOME"
read -p "Enter default working directory [$DEFAULT_CWD]: " AGENT_CWD
AGENT_CWD="${AGENT_CWD:-$DEFAULT_CWD}"

# Claude path override
read -p "Enter Claude binary path [$CLAUDE_PATH]: " USER_CLAUDE_PATH
CLAUDE_PATH="${USER_CLAUDE_PATH:-$CLAUDE_PATH}"

# Model
read -p "Enter default model (sonnet/opus/haiku) [sonnet]: " CLAUDE_MODEL
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"

# Permission mode
read -p "Enter permission mode (bypassPermissions/acceptEdits/plan) [bypassPermissions]: " PERM_MODE
PERM_MODE="${PERM_MODE:-bypassPermissions}"

# 4. Generate .env file
echo -e "\n📝 Generating .env file..."
cat << EOF > .env
# Authentication
WEB_USERNAME=$WEB_USER
WEB_PASSWORD=$WEB_PASS

# Server configuration
PORT=$WEB_PORT
HOST=0.0.0.0

# Claude Configuration
CLAUDE_BIN=$CLAUDE_PATH
AGENT_CWD=$AGENT_CWD
CLAUDE_MODEL=$CLAUDE_MODEL
PERMISSION_MODE=$PERM_MODE

# State directory (sessions, logs)
STATE_DIR=$HOME/.self-agent-orchestrator
EOF
echo -e "${GREEN}✓ .env file created successfully.${NC}"

# 4b. Migrate old data if exists
OLD_STATE_DIR="$HOME/.agent-web-terminal"
NEW_STATE_DIR="$HOME/.self-agent-orchestrator"
if [ -d "$OLD_STATE_DIR" ] && [ ! -f "$NEW_STATE_DIR/sessions.json" ]; then
    echo -e "\n🔄 Migrating chat history from old agent-web-terminal directory..."
    mkdir -p "$NEW_STATE_DIR"
    cp -r "$OLD_STATE_DIR/sessions.json" "$NEW_STATE_DIR/" 2>/dev/null || true
    cp -r "$OLD_STATE_DIR/sessions" "$NEW_STATE_DIR/" 2>/dev/null || true
    echo -e "${GREEN}✓ Chat history migrated successfully.${NC}"
fi

# 5. NPM Install
echo -e "\n📦 Installing Node.js dependencies..."
npm install --no-audit --no-fund
echo -e "${GREEN}✓ Dependencies installed successfully.${NC}"

# 6. Autostart option
echo ""
read -p "Do you want to enable autostart on system boot? (y/n) [y]: " AUTOSTART
AUTOSTART="${AUTOSTART:-y}"

OS_TYPE="$(uname -s)"
SERVICE_STARTED=false

if [ "$AUTOSTART" = "y" ] || [ "$AUTOSTART" = "Y" ]; then
    if [ "$OS_TYPE" = "Darwin" ]; then
        echo -e "\n🖥️ Setting up macOS LaunchAgent..."
        PLIST_DIR="$HOME/Library/LaunchAgents"
        mkdir -p "$PLIST_DIR"
        PLIST_FILE="$PLIST_DIR/com.self-agent-orchestrator.plist"

        cat << EOF > "$PLIST_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.self-agent-orchestrator</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(command -v node)</string>
        <string>$INSTALL_DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PORT</key>
        <string>$WEB_PORT</string>
        <key>WEB_USERNAME</key>
        <string>$WEB_USER</string>
        <key>WEB_PASSWORD</key>
        <string>$WEB_PASS</string>
        <key>AGENT_CWD</key>
        <string>$AGENT_CWD</string>
        <key>CLAUDE_MODEL</key>
        <string>$CLAUDE_MODEL</string>
        <key>PERMISSION_MODE</key>
        <string>$PERM_MODE</string>
        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_PATH</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.self-agent-orchestrator/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.self-agent-orchestrator/logs/launchd.err.log</string>
</dict>
</plist>
EOF
        # Load plist
        mkdir -p "$HOME/.self-agent-orchestrator/logs"
        launchctl unload "$PLIST_FILE" 2>/dev/null || true
        launchctl load "$PLIST_FILE"
        echo -e "${GREEN}✓ Launchctl service loaded.${NC}"
        SERVICE_STARTED=true

    elif [ "$OS_TYPE" = "Linux" ]; then
        echo -e "\n🖥️ Setting up systemd user service..."
        SYSTEMD_DIR="$HOME/.config/systemd/user"
        mkdir -p "$SYSTEMD_DIR"
        SERVICE_FILE="$SYSTEMD_DIR/self-agent-orchestrator.service"

        cat << EOF > "$SERVICE_FILE"
[Unit]
Description=Self Agent Orchestrator Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) server.js
Restart=on-failure
Environment=NODE_ENV=production
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=default.target
EOF
        # Reload daemon and start
        mkdir -p "$HOME/.self-agent-orchestrator/logs"
        systemctl --user daemon-reload
        systemctl --user enable self-agent-orchestrator.service
        systemctl --user restart self-agent-orchestrator.service
        echo -e "${GREEN}✓ Systemd user service loaded and enabled.${NC}"
        SERVICE_STARTED=true
    fi
else
    echo -e "\nSkipping autostart configuration."
fi

# Start manual if autostart was not configured/failed
if [ "$SERVICE_STARTED" = "false" ]; then
    echo -e "\n🚀 Starting service manually in background..."
    chmod +x start.sh
    ./start.sh
fi

echo -e "\n${GREEN}🎉 Installation completed successfully!${NC}"
echo -e "----------------------------------------------"
echo -e "Web Access: http://localhost:$WEB_PORT"
echo -e "Username:   $WEB_USER"
echo -e "Password:   $WEB_PASS"
echo -e "----------------------------------------------"

if [ "$SERVICE_STARTED" = "true" ]; then
    echo -e "Autostart is configured. It will run in the background."
    if [ "$OS_TYPE" = "Darwin" ]; then
        echo -e "To stop:    launchctl unload ~/Library/LaunchAgents/com.self-agent-orchestrator.plist"
        echo -e "To start:   launchctl load ~/Library/LaunchAgents/com.self-agent-orchestrator.plist"
    elif [ "$OS_TYPE" = "Linux" ]; then
        echo -e "To stop:    systemctl --user stop self-agent-orchestrator.service"
        echo -e "To start:   systemctl --user start self-agent-orchestrator.service"
    fi
else
    echo -e "Start command:  ./start.sh"
    echo -e "Stop command:   ./stop.sh"
    echo -e "Status check:   ./status.sh"
fi
echo -e "=============================================="
