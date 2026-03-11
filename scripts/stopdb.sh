#!/usr/bin/env bash
# Stop MySQL and Redis.

REDIS_CLI="$(command -v redis-cli 2>/dev/null || echo /opt/homebrew/opt/redis/bin/redis-cli)"

# ── MySQL ────────────────────────────────────────────────────────────────────

if brew services list 2>/dev/null | grep -q "^mysql.*started"; then
  echo "Stopping MySQL..."
  brew services stop mysql
  echo "  MySQL stopped."
else
  echo "MySQL is not running."
fi

# ── Redis ────────────────────────────────────────────────────────────────────

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
