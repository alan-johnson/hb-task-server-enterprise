#!/usr/bin/env bash
# Stop the web server (port 80) and task API server (port 3500)

stop_port() {
  local port=$1
  local name=$2
  local pids
  pids=$(lsof -ti TCP:"$port" -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Stopping $name (port $port, PID $pids)..."
    kill "$pids"
    # Wait up to 5 seconds for clean exit
    for i in $(seq 1 10); do
      sleep 0.5
      if ! lsof -ti TCP:"$port" -sTCP:LISTEN &>/dev/null; then
        echo "  $name stopped."
        return 0
      fi
    done
    echo "  $name did not exit cleanly; sending SIGKILL..."
    kill -9 "$pids" 2>/dev/null
  else
    echo "$name (port $port) is not running."
  fi
}

stop_port 80   "web server"
stop_port 3500 "task API server"
