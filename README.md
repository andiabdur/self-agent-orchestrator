# Self Agent Orchestrator

**Self Agent Orchestrator** is a lightweight, responsive, and secure Web UI for controlling and interacting with your Claude Code CLI (`@anthropic-ai/claude-code`) from any device. It allows you to run shell commands, edit/read files, view execution diffs, and manage background agent tasks through an elegant, mobile-friendly web interface.

---

## ⚡ 1-Command Installation

You can install, configure, and start the Orchestrator with a single command. The installer will guide you through setting up credentials, ports, and optional autostart services.

### macOS & Linux (Bash)
```bash
curl -fsSL https://raw.githubusercontent.com/andiabdur/self-agent-orchestrator/main/install.sh | bash
```

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/andiabdur/self-agent-orchestrator/main/install.ps1 | iex
```

---

## ⚙️ Manual Installation & Startup

If you prefer to set up and run the Orchestrator manually, follow these instructions:

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/andiabdur/self-agent-orchestrator.git
cd self-agent-orchestrator
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and edit the values:
```bash
cp .env.example .env
```
Ensure you set:
*   `WEB_USERNAME` and `WEB_PASSWORD` for basic authentication.
*   `CLAUDE_BIN` to the absolute path of your `claude` CLI binary.
*   `AGENT_CWD` to your default agent workspace.

### 3. Running the Service

#### 🖥️ macOS & Linux
*   **Start in background**: `./start.sh`
*   **Stop**: `./stop.sh`
*   **Check status**: `./status.sh`
*   **Run in foreground**: `npm start`

#### 🪟 Windows
*   **Start in background**: Run `start.bat` (CMD) or `.\start.ps1` (PowerShell)
*   **Stop**: Run `stop.bat` (CMD) or `.\stop.ps1` (PowerShell)
*   **Check status**: Run `status.bat` (CMD) or `.\status.ps1` (PowerShell)
*   **Restart**: Run `restart.bat` (CMD) or `.\restart.ps1` (PowerShell)
*   **Run in foreground**: `npm start` or `node server.js`

---

## 🔒 Security Recommendations
*   Always change the default password in your `.env` file before exposing the server.
*   It is highly recommended to run this service behind a secure tunnel (e.g. **Tailscale Funnel**, **Cloudflare Tunnels**, or **WireGuard**) rather than exposing raw HTTP ports to the open internet.
*   Use `bypassPermissions` only in trusted project environments, as it allows the agent to execute tools automatically without manual user approval prompts.
