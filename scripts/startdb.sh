#!/usr/bin/env bash
# Start PostgreSQL and Redis in the background.

PG_BIN="/opt/homebrew/opt/postgresql@18/bin"
PG_DATA="/opt/homebrew/var/postgresql@18"
PG_LOG="/opt/homebrew/var/log/postgresql@18.log"
REDIS_BIN="/opt/homebrew/opt/redis/bin/redis-server"

# ── PostgreSQL ──────────────────────────────────────────────────────────────

PG_CTL="$(command -v pg_ctl 2>/dev/null || echo "$PG_BIN/pg_ctl")"

if "$PG_BIN/pg_isready" -q 2>/dev/null; then
  echo "PostgreSQL is already running."
else
  echo "Starting PostgreSQL..."
  LC_ALL="en_US.UTF-8" "$PG_CTL" start -D "$PG_DATA" -l "$PG_LOG" -w
  echo "  PostgreSQL started. Log: $PG_LOG"
fi

# ── Redis ───────────────────────────────────────────────────────────────────

REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"

if "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
  echo "Redis is already running."
else
  echo "Starting Redis..."
  "$REDIS_BIN" --daemonize yes
  echo "  Redis started."
fi