#!/usr/bin/env bash
# Stop the task API server, web server, PostgreSQL, and Redis.

PG_BIN="/opt/homebrew/opt/postgresql@18/bin"
PG_DATA="/opt/homebrew/var/postgresql@18"
REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"
PG_CTL="$(command -v pg_ctl 2>/dev/null || echo "$PG_BIN/pg_ctl")"

stop_port() {
  local port=$1
  local name=$2
  local pids
  pids=$(lsof -ti TCP:"$port" -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Stopping $name (port $port, PID $pids)..."
    kill "$pids"
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

# ── Node servers ─────────────────────────────────────────────────────────────

stop_port 3500 "task API server"
stop_port 80   "web server"

# ── PostgreSQL ───────────────────────────────────────────────────────────────

if "$PG_BIN/pg_isready" -q 2>/dev/null; then
  echo "Stopping PostgreSQL..."
  if "$PG_CTL" stop -D "$PG_DATA" -m fast -w; then
    echo "  PostgreSQL stopped."
  else
    echo "  ERROR: pg_ctl stop failed." >&2
  fi
else
  echo "PostgreSQL is not running."
fi

# ── Redis ─────────────────────────────────────────────────────────────────────

if "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
  echo "Stopping Redis..."
  if brew services list 2>/dev/null | grep -q "^redis.*started"; then
    brew services stop redis
  else
    "$REDIS_CLI" shutdown nosave 2>/dev/null || true
  fi
  echo "  Redis stopped."
else
  echo "Redis is not running."
fi
