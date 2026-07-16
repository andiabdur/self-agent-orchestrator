#!/bin/bash
# Restart self-agent-orchestrator: stop then start
cd "$(dirname "$0")"
./stop.sh
sleep 1
./start.sh
