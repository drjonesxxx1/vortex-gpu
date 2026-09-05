#!/usr/bin/env bash
#
# backup-db.sh — crash-consistent, VERIFIED backup of the live VortexGPU
# SQLite database.
#
#   /opt/vortexgpu/scripts/backup-db.sh [--dry-run]
#
# Design rules (learned the hard way — see docs/BACKUP.md):
#   * absolute paths everywhere; no `cd`, so nothing can run in the wrong dir
#   * never writes to, moves, or deletes the source database
#   * uses the SQLite online backup API, not `cp` (a cp of a live db can tear)
#   * the backup is VERIFIED after writing: exists, non-zero, integrity_check
#     ok, required tables present, row counts printed
#   * old backups are pruned ONLY after the new backup verifies
#
# Environment overrides (all must be absolute paths):
#   VORTEX_DB          source database   (default /opt/vortexgpu/data/vortex.db)
#   VORTEX_BACKUP_DIR  destination dir   (default /var/backups/vortexgpu)
#   VORTEX_RETENTION   backups to keep   (default 14)

set -euo pipefail

readonly SRC_DB="${VORTEX_DB:-/opt/vortexgpu/data/vortex.db}"
readonly BACKUP_DIR="${VORTEX_BACKUP_DIR:-/var/backups/vortexgpu}"
readonly RETENTION="${VORTEX_RETENTION:-14}"
readonly DB_TOOL="/opt/vortexgpu/scripts/lib/db-tool.mjs"
readonly NODE_BIN="${NODE_BIN:-node}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "backup-db.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '[backup-db] %s\n' "$*"; }
fail() { printf '[backup-db] FAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --
case "$SRC_DB"     in /*) ;; *) fail "VORTEX_DB must be an absolute path: $SRC_DB" ;; esac
case "$BACKUP_DIR" in /*) ;; *) fail "VORTEX_BACKUP_DIR must be an absolute path: $BACKUP_DIR" ;; esac
[[ "$RETENTION" =~ ^[0-9]+$ ]] || fail "VORTEX_RETENTION must be a non-negative integer: $RETENTION"
(( RETENTION >= 1 )) || fail "VORTEX_RETENTION must be at least 1 (refusing to keep zero backups)"

command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node not found on PATH"
[[ -f "$DB_TOOL" ]] || fail "helper not found: $DB_TOOL"

[[ -e "$SRC_DB" ]] || fail "source database does not exist: $SRC_DB"
[[ -f "$SRC_DB" ]] || fail "source database is not a regular file: $SRC_DB"
[[ -r "$SRC_DB" ]] || fail "source database is not readable: $SRC_DB"
[[ -s "$SRC_DB" ]] || fail "source database is zero bytes: $SRC_DB"

# The backup directory must live OUTSIDE the app tree, so that a stray
# `rm -rf` inside /opt/vortexgpu cannot take the backups with it.
case "$BACKUP_DIR" in
  /opt/vortexgpu|/opt/vortexgpu/*)
    fail "refusing to back up into the app tree: $BACKUP_DIR" ;;
esac

if [[ ! -d "$BACKUP_DIR" ]]; then
  log "creating backup directory: $BACKUP_DIR"
  mkdir -p -- "$BACKUP_DIR" || fail "cannot create backup directory: $BACKUP_DIR"
  chmod 700 -- "$BACKUP_DIR" || fail "cannot chmod backup directory: $BACKUP_DIR"
fi
[[ -w "$BACKUP_DIR" ]] || fail "backup directory is not writable: $BACKUP_DIR"

# Prove writability for real, not just by permission bits (read-only mount,
# full disk, immutable flag...).
readonly WRITE_PROBE="${BACKUP_DIR}/.write-probe.$$"
if ! : > "$WRITE_PROBE" 2>/dev/null; then
  fail "backup directory is not actually writable: $BACKUP_DIR"
fi
rm -f -- "$WRITE_PROBE"

# The timestamp is computed HERE and checked, so a backup can never be written
# to a filename containing a literal, unexpanded $(date).
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "timestamp did not expand correctly: '$STAMP'"

readonly TARGET="${BACKUP_DIR}/vortex-${STAMP}.db"
readonly TMP_TARGET="${TARGET}.partial"

log "source:      $SRC_DB"
log "destination: $TARGET"
log "retention:   keep newest $RETENTION"

if (( DRY_RUN )); then
  log "--dry-run: verifying the SOURCE only, writing nothing"
  "$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$SRC_DB" "source database" \
    || fail "source database failed verification"
  log "dry run OK — no backup written"
  exit 0
fi

# Never resurrect a stale partial file.
rm -f -- "$TMP_TARGET"
# Idempotent: a second run inside the same second is a no-op, not an
# overwrite. We never clobber an existing backup file.
if [[ -e "$TARGET" ]]; then
  log "a backup for this timestamp already exists: $TARGET"
  log "verifying it and exiting without writing (nothing overwritten, nothing pruned)"
  "$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$TARGET" "existing backup" \
    || fail "the existing backup at $TARGET does not verify — move it aside and re-run"
  log "OK (no-op)"
  exit 0
fi

cleanup_partial() { rm -f -- "$TMP_TARGET"; }
trap cleanup_partial EXIT

# ------------------------------------------------------------------ backup --
log "copying via the SQLite online backup API..."
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" backup "$SRC_DB" "$TMP_TARGET" \
  || fail "SQLite backup API failed (no backup written)"

# ------------------------------------------------------------------ verify --
# A backup that is not verified is not a backup.
log "verifying the backup..."
"$NODE_BIN" --disable-warning=ExperimentalWarning "$DB_TOOL" verify "$TMP_TARGET" "backup" \
  || fail "backup failed verification — leaving nothing behind, NOT pruning"

chmod 600 -- "$TMP_TARGET" || fail "cannot chmod backup file"
mv -- "$TMP_TARGET" "$TARGET" || fail "cannot move verified backup into place"
trap - EXIT

# Checksum sidecar. PRAGMA integrity_check does not look at unused pages, so
# bit rot in free space is invisible to it; a SHA-256 catches any change at
# all. restore-db.sh checks this before restoring.
if command -v sha256sum >/dev/null 2>&1; then
  # No `cd` anywhere: hash the absolute path, then write the sidecar in the
  # `<hash>  <basename>` form `sha256sum -c` expects.
  if ! SUM="$(sha256sum -- "$TARGET" | cut -d' ' -f1)"; then
    fail "could not checksum $TARGET"
  fi
  if ! printf '%s  %s\n' "$SUM" "$(basename -- "$TARGET")" > "${TARGET}.sha256"; then
    rm -f -- "${TARGET}.sha256"
    fail "could not write the checksum sidecar for $TARGET"
  fi
  chmod 600 -- "${TARGET}.sha256" || true
  log "checksum: $SUM"
else
  log "WARNING: sha256sum not found — no checksum sidecar written"
fi

log "verified backup written: $TARGET"

# ------------------------------------------------------------------- prune --
# Only reached when the new backup verified. Matches the strict filename
# pattern this script writes and nothing else.
mapfile -t ALL_BACKUPS < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name 'vortex-????????T??????Z.db' -print | LC_ALL=C sort -r
)
readonly TOTAL="${#ALL_BACKUPS[@]}"
log "backups on disk: $TOTAL"

if (( TOTAL > RETENTION )); then
  for old in "${ALL_BACKUPS[@]:RETENTION}"; do
    if [[ "$old" == "$TARGET" ]]; then continue; fi   # never prune the one just made
    log "pruning old backup: $old"
    rm -f -- "$old" "${old}.sha256" || log "WARNING: could not remove $old"
  done
else
  log "nothing to prune (retention $RETENTION)"
fi

log "OK"
