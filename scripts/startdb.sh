#!/usr/bin/env bash
# Start MySQL and Redis in the background.

REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"
REDIS_BIN="$(command -v redis-server 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-server)"

# ── MySQL ────────────────────────────────────────────────────────────────────

if brew services list 2>/dev/null | grep -q "^mysql.*started"; then
  echo "MySQL is already running."
else
  echo "Starting MySQL..."
  brew services start mysql
  echo "  MySQL started."
fi

# ── Redis ────────────────────────────────────────────────────────────────────

if "$REDIS_CLI" ping 2>/dev/null | grep -q PONG; then
  echo "Redis is already running."
else
  echo "Starting Redis..."
  if command -v brew &>/dev/null; then
    brew services start redis
  else
    "$REDIS_BIN" --daemonize yes
  fi
  echo "  Redis started."
fi
