#!/bin/bash
# Start self-agent-orchestrator in background using .env

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✗ .env not found. Copy .env.example to .env and edit it first."
  exit 1
fi

LOG_DIR="$HOME/.self-agent-orchestrator/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$HOME/.self-agent-orchestrator/server.pid"

# Stop if already running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Already running (pid $OLD_PID). Use ./stop.sh first."
    exit 1
  fi
fi

# Start in background, --env-file loads .env (Node 22+ built-in)
nohup /opt/homebrew/bin/node --env-file=.env server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '"' | tr -d "'")
  PORT="${PORT:-7000}"
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  SERVE_URL=$($TS serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
  TAILSCALE_IP=$($TS ip -4 2>/dev/null | head -1)
  echo "✓ Started (pid $(cat "$PID_FILE"))"
  [ -n "$SERVE_URL" ] && echo "  HTTPS:    $SERVE_URL"
  [ -n "$TAILSCALE_IP" ] && echo "  HTTP:     http://$TAILSCALE_IP:$PORT"
  echo "  Logs:     tail -f $LOG_FILE"
  echo "  Stop:     ./stop.sh"
else
  echo "✗ Failed to start. Check $LOG_FILE"
  exit 1
fi
