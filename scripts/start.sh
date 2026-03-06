#!/bin/sh
PID_FILE=".server.pid"

if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
  echo "Server is already running (PID $(cat $PID_FILE))"
  exit 0
fi

node src/server.js &
echo $! > "$PID_FILE"
echo "Server started (PID $!)"
