#!/bin/bash
# Check status of self-agent-orchestrator server test aja

PID_FILE="$HOME/.self-agent-orchestrator/server.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    PORT="${PORT:-7000}"
    TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    TAILSCALE_IP=$($TS ip -4 2>/dev/null | head -1)
    SERVE_URL=$($TS serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null)
    echo "✓ Running (pid $PID)"
    if [ -n "$SERVE_URL" ]; then
      echo "  HTTPS:      $SERVE_URL  ← recommended"
    fi
    [ -n "$TAILSCALE_IP" ] && echo "  Tailscale:  http://$TAILSCALE_IP:$PORT"
    [ -n "$LOCAL_IP" ]     && echo "  Local LAN:  http://$LOCAL_IP:$PORT"
    echo "  Localhost:  http://127.0.0.1:$PORT"
    echo "  Logs:       tail -f $HOME/.self-agent-orchestrator/logs/server.log"
  else
    echo "✗ Not running (stale pidfile, pid $PID)"
  fi
else
  if pgrep -f "node server.js" >/dev/null 2>&1; then
    echo "⚠ Running but no pidfile (started outside start.sh?)"
    pgrep -af "node server.js"
  else
    echo "✗ Not running."
  fi
fi
