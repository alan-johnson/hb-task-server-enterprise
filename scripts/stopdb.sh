#!/usr/bin/env bash
# Stop the task API server and web server then stop PostgreSQL and Redis.

PG_BIN="/opt/homebrew/opt/postgresql@18/bin"
PG_DATA="/opt/homebrew/var/postgresql@18"
REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"
PG_CTL="$(command -v pg_ctl 2>/dev/null || echo "$PG_BIN/pg_ctl")"

# ── PostgreSQL ──────────────────────────────────────────────────────────────

if "$PG_BIN/pg_isready" -q 2>/dev/null; then
  echo "Stopping PostgreSQL..."
  "$PG_CTL" stop -D "$PG_DATA" -m fast -w -q
  echo "  PostgreSQL stopped."
else
  echo "PostgreSQL is not running."
fi

# ── Redis ───────────────────────────────────────────────────────────────────

if "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
  echo "Stopping Redis..."
  "$REDIS_CLI" shutdown nosave 2>/dev/null || true
  echo "  Redis stopped."
else
  echo "Redis is not running."
fi
