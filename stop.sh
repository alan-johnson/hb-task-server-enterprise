#!/bin/sh
PID_FILE=".server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found. Server may not be running."
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  rm "$PID_FILE"
  echo "Server stopped (PID $PID)"
else
  echo "Server was not running (stale PID $PID)"
  rm "$PID_FILE"
fi
