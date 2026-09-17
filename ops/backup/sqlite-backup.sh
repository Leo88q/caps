#!/bin/sh
# Hourly SQLite backup for the compose deploy (docs/09 §4.3, runbook.md §4).
#
# Why not litestream: litestream streams Postgres WAL. The read-model is SQLite, so the correct
# primitive is `sqlite3 .backup`, which reads through the connection and therefore cannot copy a
# half-written database (a naive `cp` of a WAL-mode db can). We also run `PRAGMA integrity_check` on
# the copy: a backup that fails to open is not a backup, and finding that out during an incident is
# the most expensive way to learn it.
#
# S3 upload is optional (BACKUP_S3_URI=s3://bucket/prefix). It uses `aws` if present and otherwise
# logs one WARN and keeps writing locally, so a missing credential never stops the local snapshot.
set -eu

DB_PATH="${DB_PATH:-/data/guttercaps.sqlite}"
OUT_DIR="${OUT_DIR:-/backup/out}"
KEEP="${BACKUP_KEEP:-72}"          # 72 × hourly = 3 days on-host
INTERVAL="${BACKUP_INTERVAL_S:-3600}"
S3_URI="${BACKUP_S3_URI:-}"

mkdir -p "$OUT_DIR"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ALERT sqlite3 not installed in the backup image — no snapshot is being taken" >&2
  exit 1
fi

one() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="$OUT_DIR/guttercaps-$ts.sqlite"
  # `.backup` on a source URL: consistent even while the API is writing.
  sqlite3 "file:$DB_PATH?mode=ro&immutable=0" ".backup '$tmp'"
  ok=$(sqlite3 "$tmp" "PRAGMA integrity_check;" 2>&1 | head -1)
  if [ "$ok" != "ok" ]; then
    echo "ALERT backup integrity_check FAILED for $tmp: $ok" >&2
    mv "$tmp" "$tmp.CORRUPT"
    return 1
  fi
  gzip -9 "$tmp"
  chmod 0640 "$tmp.gz"
  size=$(wc -c < "$tmp.gz")
  echo "backup guttercaps-$ts.sqlite.gz ok ($size bytes)"
  if [ -n "$S3_URI" ] && command -v aws >/dev/null 2>&1; then
    if aws s3 cp "$tmp.gz" "$S3_URI/guttercaps-$ts.sqlite.gz" --only-show-errors >/dev/null 2>&1; then
      echo "uploaded to $S3_URI"
    else
      echo "ALERT s3 upload failed (local copy kept)" >&2
    fi
  elif [ -n "$S3_URI" ]; then
    echo "WARN BACKUP_S3_URI set but aws-cli is missing — local-only backups" >&2
  fi
  # Retention applies to the local dir only; the S3 lifecycle is the bucket's business (documented).
  ls -1t "$OUT_DIR"/*.sqlite.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r f; do rm -f "$f"; done
  return 0
}

if [ "${RUN_ONCE:-0}" = "1" ]; then one; exit $?; fi

echo "backup loop: every ${INTERVAL}s, keeping $KEEP in $OUT_DIR (db $DB_PATH)"
while :; do
  # A failed snapshot must not kill the loop; the next hour tries again and the ALERT is the page.
  one || echo "WARN backup attempt failed; retrying in ${INTERVAL}s" >&2
  sleep "$INTERVAL"
done
