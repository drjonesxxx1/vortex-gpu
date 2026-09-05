#!/usr/bin/env bash
#
# restore-db.sh — restore a verified backup over a VortexGPU database.
#
#   /opt/vortexgpu/scripts/restore-db.sh /var/backups/vortexgpu/vortex-<stamp>.db --yes
#
# Order of operations (deliberate — nothing destructive happens early):
#   1. verify the BACKUP first: exists, non-zero, integrity_check ok,
#      required tables present. If it fails, we stop having touched nothing.
#   2. take a safety copy of the CURRENT database (SQLite backup API).
#   3. copy the verified backup into place, then verify the RESULT.
#   4. tell the operator to restart the service. This script NEVER restarts it.
#
# --yes is mandatory: this cannot run by accident, from a cron entry, or from
# a half-typed command line.
#
# Environment overrides (absolute paths only):
#   VORTEX_DB          target database   (default /opt/vortexgpu/data/vortex.db)
#   VORTEX_BACKUP_DIR  safety-copy dir   (default /var/backups/vortexgpu)

set -euo pipefail

readonly TARGET_DB="${VORTEX_DB:-/opt/vortexgpu/data/vortex.db}"
readonly BACKUP_DIR="${VORTEX_BACKUP_DIR:-/var/backups/vortexgpu}"
readonly DB_TOOL="/opt/vortexgpu/scripts/lib/db-tool.mjs"
readonly NODE_BIN="${NODE_BIN:-node}"

log()  { printf '[restore-db] %s\n' "$*"; }
fail() { printf '[restore-db] FAILED: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage: /opt/vortexgpu/scripts/restore-db.sh <backup-file.db> --yes

  <backup-file.db>  absolute path to a backup produced by backup-db.sh
  --yes             required confirmation; without it nothing happens
USAGE
}

SOURCE_BACKUP=""
CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    --yes)     CONFIRMED=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "restore-db.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$SOURCE_BACKUP" ]]; then
        echo "restore-db.sh: more than one backup file given" >&2; exit 2
      fi
      SOURCE_BACKUP="$arg" ;;
  esac
done
readonly SOURCE_BACKUP CONFIRMED

[[ -n "$SOURCE_BACKUP" ]] || { usage >&2; exit 2; }
case "$SOURCE_BACKUP" in /*) ;; *) fail "backup path must be absolute: $SOURCE_BACKUP" ;; esac
case "$TARGET_DB"      in /*) ;; *) fail "VORTEX_DB must be an absolute path: $TARGET_DB" ;; esac

if (( ! CONFIRMED )); then
  log "refusing to restore without --yes."
  log "this would overwrite: $TARGET_DB"
  log "re-run with --yes when you are sure."
  exit 2
fi

command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node not found on PATH"
[[ -f "$DB_TOOL" ]] || fail "helper not found: $DB_TOOL"

# ------------------------------------------ 1. verify the backup FIRST ------
# 1a. checksum sidecar, if backup-db.sh wrote one. PRAGMA integrity_check does
# not inspect unused pages, so this is what catches bit rot in free space.
if [[ -f "${SOURCE_BACKUP}.sha256" ]]; then
  if ! command -v sha256sum >/dev/null 2>&1; then
    fail "a checksum sidecar exists but sha256sum is not installed — cannot verify $SOURCE_BACKUP"
  fi
  log "checking the checksum sidecar: ${SOURCE_BACKUP}.sha256"
  EXPECTED="$(cut -d' ' -f1 < "${SOURCE_BACKUP}.sha256")"
  ACTUAL="$(sha256sum -- "$SOURCE_BACKUP" | cut -d' ' -f1)"
  if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
    fail "CHECKSUM MISMATCH for $SOURCE_BACKUP (expected ${EXPECTED:-<empty>}, got $ACTUAL) — the backup file has changed on disk; nothing was touched"
  fi
  log "checksum OK: $ACTUAL"
else
  log "WARNING: no checksum sidecar (${SOURCE_BACKUP}.sha256) — relying on integrity_check alone"
fi

# 1b. structural verification.
log "verifying the backup BEFORE touching anything: $SOURCE_BACKUP"
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$SOURCE_BACKUP" "backup" \
  || fail "backup did not verify — nothing was changed, $TARGET_DB is untouched"

[[ "$(readlink -f -- "$SOURCE_BACKUP")" != "$(readlink -f -- "$TARGET_DB" 2>/dev/null || echo '')" ]] \
  || fail "backup and target are the same file: $SOURCE_BACKUP"

# ----------------------------------- 2. safety copy of the CURRENT db -------
readonly TARGET_DIR="$(dirname -- "$TARGET_DB")"
[[ -d "$TARGET_DIR" ]] || fail "target directory does not exist: $TARGET_DIR"
[[ -w "$TARGET_DIR" ]] || fail "target directory is not writable: $TARGET_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "timestamp did not expand correctly: '$STAMP'"

if [[ -f "$TARGET_DB" ]]; then
  mkdir -p -- "$BACKUP_DIR" || fail "cannot create safety-copy directory: $BACKUP_DIR"
  [[ -w "$BACKUP_DIR" ]] || fail "safety-copy directory is not writable: $BACKUP_DIR"
  PRE_RESTORE="${BACKUP_DIR}/pre-restore-${STAMP}.db"
  if [[ -e "$PRE_RESTORE" ]]; then
    fail "safety copy already exists, refusing to overwrite: $PRE_RESTORE"
  fi
  log "saving the CURRENT database first: $PRE_RESTORE"
  "$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" backup "$TARGET_DB" "$PRE_RESTORE" \
    || fail "could not save the current database — refusing to restore over it"
  chmod 600 -- "$PRE_RESTORE" || fail "cannot chmod safety copy"
  log "current database saved. If this restore is wrong, restore that file back."
else
  PRE_RESTORE=""
  log "no existing database at $TARGET_DB — nothing to save first"
fi
readonly PRE_RESTORE

# --------------------------------------------------- 3. restore + verify ----
readonly STAGED="${TARGET_DB}.restore-${STAMP}.partial"
rm -f -- "$STAGED"
log "staging the restored copy: $STAGED"
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" backup "$SOURCE_BACKUP" "$STAGED" \
  || { rm -f -- "$STAGED"; fail "could not stage the restore — $TARGET_DB is untouched"; }

log "verifying the staged copy before it replaces the live database..."
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$STAGED" "staged restore" \
  || { rm -f -- "$STAGED"; fail "staged copy did not verify — $TARGET_DB is untouched"; }

# Sidecar journal/WAL files from the old database must not survive the swap.
rm -f -- "${TARGET_DB}-journal" "${TARGET_DB}-wal" "${TARGET_DB}-shm"
mv -- "$STAGED" "$TARGET_DB" || fail "could not move the staged copy into place"
chmod 644 -- "$TARGET_DB" || log "WARNING: could not chmod $TARGET_DB"

log "verifying the restored database in place..."
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$TARGET_DB" "restored database" \
  || fail "restored database failed verification — DO NOT restart the service; see $PRE_RESTORE"

# ------------------------------------------------------------ 4. hand off ---
cat <<EOF

[restore-db] RESTORE COMPLETE
  restored from : $SOURCE_BACKUP
  restored to   : $TARGET_DB
  previous db   : ${PRE_RESTORE:-<none — there was no existing database>}

NEXT STEP — this script does NOT restart anything, on purpose.
The running service still holds the OLD database open. Until an operator
restarts it, the restored file is not in use.

  Restart it the approved way (this logs every user out):

      bash /opt/vortexgpu/deploy.sh

  Then confirm the service is healthy and the data is back:

      curl -s http://10.30.20.127:3000/api/health

EOF
