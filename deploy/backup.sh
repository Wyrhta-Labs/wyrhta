#!/bin/sh
# Periodic pg_dump of every household database into /backups.
#
# Runs postgres:18-alpine purely as a client — this does not affect ADR 0006
# rule 2, which constrains the image holding household data.
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
DATABASES="heorth feoh kithledger"

while true; do
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  for db in $DATABASES; do
    out="/backups/${db}-${ts}.dump"
    tmp="${out}.tmp"
    if pg_dump -h db -U postgres -d "$db" -Fc -f "$tmp"; then
      mv "$tmp" "$out"
      echo "backup ok: ${out}"
    else
      echo "backup FAILED for '${db}'" >&2
      rm -f "$tmp"
    fi
  done

  # Prune by age. -mtime +N is "older than N days".
  find /backups -name '*.dump' -type f -mtime "+${RETENTION}" -delete
  echo "backup: pruned dumps older than ${RETENTION} days"

  if [ "${BACKUP_ONCE:-false}" = "true" ]; then
    echo "backup: BACKUP_ONCE set, exiting"
    exit 0
  fi

  sleep "$INTERVAL"
done
