#!/usr/bin/env bash
# ===========================================================================
# Redis persistence check — cron job, not part of the app.
#
# Redis backs a read cache that holds DECRYPTED OAuth tokens (see
# src/db/cache.js). RDB snapshotting is disabled two ways — `save ""` in
# /etc/redis/redis.conf (config-level, survives every restart) and a
# `CONFIG SET save ""` the app also issues on every connect — but neither is
# an absolute guarantee against every path that can produce a dump file (an
# operator running SAVE/BGSAVE by hand, a future config edit that
# re-enables save points, etc.). This is the belt-and-suspenders check:
# if a dump file ever appears anyway, remove it and say so loudly instead of
# letting decrypted credentials sit on disk indefinitely and unnoticed.
#
# Runs as root via cron — needs to be root, since /var/lib/redis is
# redis:redis, drwxr-x---. Install:
#   sudo crontab -e
#   0 * * * * /home/deploy/check-redis-persistence.sh >> /var/log/upq-redis-check.log 2>&1
# ===========================================================================
set -euo pipefail

REDIS_DATA_DIR="/var/lib/redis"
ENV_FILE="/home/deploy/upq/.env"

shopt -s nullglob
rdb_files=("${REDIS_DATA_DIR}"/*.rdb)

if [ ${#rdb_files[@]} -eq 0 ]; then
  echo "[$(date -u)] OK — no RDB snapshot present in ${REDIS_DATA_DIR}"
  exit 0
fi

echo "[$(date -u)] WARNING — found ${#rdb_files[@]} RDB file(s) in ${REDIS_DATA_DIR}; persistence should be disabled. Removing:"
for f in "${rdb_files[@]}"; do
  ls -la "$f"
  rm -f "$f"
done

# Re-assert at the live server too, in case something re-enabled save points
# at runtime (CONFIG SET) rather than by editing redis.conf.
if command -v redis-cli >/dev/null 2>&1 && [ -f "${ENV_FILE}" ]; then
  REDIS_PASSWORD="$(grep '^REDIS_URL=' "${ENV_FILE}" | sed -E 's#.*://:([^@]+)@.*#\1#')"
  if [ -n "${REDIS_PASSWORD}" ]; then
    redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning config set save "" >/dev/null
    echo "[$(date -u)] Re-asserted CONFIG SET save \"\" on the live server."
  fi
fi

echo "[$(date -u)] Cleanup complete. Investigate why persistence was re-enabled — check /etc/redis/redis.conf's 'save' directive and any recent manual SAVE/BGSAVE/CONFIG SET commands."
