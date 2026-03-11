#!/usr/bin/env bash
# Stop the MySQL server managed by Homebrew.
# (Formerly stop-postgres.sh — renamed in purpose after migrating to MySQL.)

if command -v brew &>/dev/null; then
  if brew services list 2>/dev/null | grep -q "^mysql.*started"; then
    echo "Stopping mysql via Homebrew..."
    brew services stop mysql
    echo "  MySQL stopped."
  else
    echo "MySQL is not running (no Homebrew-managed mysql service found)."
  fi
else
  echo "Homebrew not found. Stop MySQL manually:"
  echo "  mysqladmin -u root -p shutdown"
fi
