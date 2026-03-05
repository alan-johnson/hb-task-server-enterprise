#!/usr/bin/env bash
# Stop the PostgreSQL server managed by Homebrew

if command -v brew &>/dev/null; then
  SERVICE=$(brew services list | awk '/postgresql/ { print $1; exit }')
  if [ -n "$SERVICE" ]; then
    echo "Stopping $SERVICE via Homebrew..."
    brew services stop "$SERVICE"
  else
    echo "No Homebrew-managed PostgreSQL service found."
    echo "If PostgreSQL is running via pg_ctl, run:"
    echo "  pg_ctl stop -D \"\$PGDATA\""
  fi
else
  # Fallback: pg_ctl
  if command -v pg_ctl &>/dev/null && [ -n "$PGDATA" ]; then
    echo "Stopping PostgreSQL via pg_ctl..."
    pg_ctl stop -D "$PGDATA" -m fast
  else
    echo "Neither Homebrew nor pg_ctl found. Locate your PostgreSQL process manually:"
    echo "  ps aux | grep postgres"
    exit 1
  fi
fi
