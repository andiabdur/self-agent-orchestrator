#!/bin/bash
# Stop self-agent-orchestrator server

PID_FILE="$HOME/.self-agent-orchestrator/server.pid"

if [ ! -f "$PID_FILE" ]; then
  # Fallback: kill by process name
  PIDS=$(pgrep -f "node server.js" 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null
    echo "✓ Killed by name: $PIDS"
  else
    echo "Not running."
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
  echo "✓ Stopped (pid $PID)"
else
  echo "Not running (stale pidfile)"
fi
rm -f "$PID_FILE"
