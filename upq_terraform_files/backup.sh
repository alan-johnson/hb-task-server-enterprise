#!/usr/bin/env bash
# ===========================================================================
# UpQ database backup — implements the off-site legs of 3-2-1.
#
#   Copy 1: live managed MySQL (DO handles this + PITR)
#   Copy 2: this encrypted dump in DO Spaces        <- different medium, off-box
#   Copy 3: mirror of the same dump in Backblaze B2 <- different PROVIDER, off-site
#
# Runs nightly via cron. Every dump is encrypted with `age` BEFORE it leaves
# the box, so neither storage provider ever sees plaintext customer data.
#
# Requires on the droplet: mysql-client, age, s3cmd (or aws cli), curl.
# All secrets come from /etc/upq/backup.env (chmod 600, NOT in git).
# ===========================================================================
set -euo pipefail

source /etc/upq/backup.env
# backup.env must define:
#   DB_HOST DB_PORT DB_NAME DB_USER DB_PASS
#   AGE_RECIPIENT          (your age public key, e.g. age1...)
#   SPACES_BUCKET          (e.g. upq-backups)
#   SPACES_ENDPOINT        (e.g. https://nyc3.digitaloceanspaces.com)
#   B2_BUCKET              (e.g. upq-backups-b2)
#   (s3cmd configured separately for Spaces; rclone remote 'b2' for Backblaze)

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="$(mktemp -d)"
DUMP="${WORKDIR}/upq-${TIMESTAMP}.sql.gz"
ENC="${DUMP}.age"

cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

echo "[$(date -u)] Dumping ${DB_NAME}..."
# --single-transaction = consistent snapshot without locking (InnoDB).
mysqldump \
  --host="${DB_HOST}" --port="${DB_PORT}" \
  --user="${DB_USER}" --password="${DB_PASS}" \
  --single-transaction --quick --routines --triggers --events \
  --ssl-mode=REQUIRED \
  "${DB_NAME}" | gzip -9 > "${DUMP}"

echo "[$(date -u)] Encrypting with age..."
age -r "${AGE_RECIPIENT}" -o "${ENC}" "${DUMP}"
rm -f "${DUMP}"   # never keep plaintext around

# --- Copy 2: DO Spaces ---
echo "[$(date -u)] Uploading to Spaces..."
s3cmd put "${ENC}" "s3://${SPACES_BUCKET}/daily/$(basename "${ENC}")" \
  --host="${SPACES_ENDPOINT#https://}" \
  --host-bucket="%(bucket)s.${SPACES_ENDPOINT#https://}"

# --- Copy 3: Backblaze B2 (different provider) ---
echo "[$(date -u)] Mirroring to Backblaze B2..."
rclone copy "${ENC}" "b2:${B2_BUCKET}/daily/"

echo "[$(date -u)] Backup ${TIMESTAMP} complete."

# ---------------------------------------------------------------------------
# RESTORE (documented here so it's never lost — TEST THIS regularly):
#
#   1. Pull the dump:   s3cmd get s3://${SPACES_BUCKET}/daily/<file>.sql.gz.age
#   2. Decrypt:         age -d -i /path/to/age-private-key.txt <file>.age > dump.sql.gz
#   3. Restore:         gunzip < dump.sql.gz | mysql --host=... --user=... -p <target_db>
#
# An untested backup is not a backup. Run a restore into a throwaway DB monthly.
# ---------------------------------------------------------------------------
