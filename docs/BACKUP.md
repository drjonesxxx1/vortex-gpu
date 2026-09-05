# Database backup and recovery

The customer database is `/opt/vortexgpu/data/vortex.db` (SQLite). It holds
users, balances, invoices, sessions and VM rows. It has been destroyed once by
a stray `rm -rf` with no working backup. These scripts exist so that cannot
happen again.

| | |
|---|---|
| Backup script | `/opt/vortexgpu/scripts/backup-db.sh` |
| Restore script | `/opt/vortexgpu/scripts/restore-db.sh` |
| Backups live in | `/var/backups/vortexgpu/` (mode 700, **outside** the app tree) |
| Filename | `vortex-<YYYYMMDD>T<HHMMSS>Z.db` (UTC) + a `.sha256` sidecar |
| Retention | newest **14** backups, pruned only after a successful, verified backup |
| Copy method | SQLite online backup API via `node:sqlite` — **not** `cp` |

`sqlite3(1)` is not installed on this box; the scripts use Node 22's built-in
`node:sqlite` through `/opt/vortexgpu/scripts/lib/db-tool.mjs`. No npm packages
are required.

## Install the cron entry

**Not installed automatically — an operator must do this.** Nothing in this
repo touches crontab.

```
sudo crontab -e
```

Add exactly this line (daily at 03:17 UTC):

```cron
17 3 * * * /opt/vortexgpu/scripts/backup-db.sh >> /var/log/vortexgpu-backup.log 2>&1
```

`node` must be on cron's PATH. It is at `/usr/bin/node`, which is on the
default cron PATH (`/usr/bin:/bin`), so no `PATH=` line is needed. If node ever
moves (nvm, a container), set `NODE_BIN=/full/path/to/node` in the entry.

Confirm it ran the next morning:

```
tail -n 40 /var/log/vortexgpu-backup.log
ls -la /var/backups/vortexgpu/
```

A run that ends in anything other than `[backup-db] OK` produced **no** backup.
Cron will email the output on a non-zero exit.

## What a backup run does

1. Refuses to start unless the source exists, is a non-empty regular file, and
   is readable; and unless the backup directory is outside `/opt/vortexgpu`
   and provably writable.
2. Copies with the SQLite online backup API, into a `.partial` file — safe
   against a concurrent writer, unlike `cp`.
3. **Verifies the copy**: non-zero size, `PRAGMA integrity_check` = `ok`, the
   required tables (`users`, `invoices`, `sessions`, `vms`) all present, and
   prints the row count for each. An empty table is fine; a missing table is a
   hard failure.
4. Only then renames the `.partial` into place and writes a `.sha256` sidecar.
5. Only then prunes past the retention limit. **A failed verification never
   prunes anything and leaves no partial file behind.**

Running it twice in the same second is a no-op, not an overwrite.

### Options

```
/opt/vortexgpu/scripts/backup-db.sh              # normal run
/opt/vortexgpu/scripts/backup-db.sh --dry-run    # verify the live db, write nothing
```

Environment overrides (absolute paths only): `VORTEX_DB`,
`VORTEX_BACKUP_DIR`, `VORTEX_RETENTION`, `NODE_BIN`.

## Verify a backup by hand

Two independent checks. Run both.

```bash
# 1. the file is bit-for-bit what was written (catches bit rot that
#    integrity_check cannot see, because it ignores unused pages).
#    Absolute paths, no `cd` — the sidecar stores a bare filename, so feed
#    sha256sum the hash and the full path directly:
B=/var/backups/vortexgpu/vortex-<STAMP>.db
sha256sum -c <<<"$(cut -d' ' -f1 < "$B.sha256")  $B"

# 2. it is a structurally valid VortexGPU database, with row counts
node --disable-warning=ExperimentalWarning \
  /opt/vortexgpu/scripts/lib/db-tool.mjs verify \
  /var/backups/vortexgpu/vortex-<STAMP>.db "backup"
```

The second prints `integrity_check: ok`, the size, and `rows <table>: N` for
each required table, and exits non-zero if anything is wrong.

To eyeball the contents without any risk to production:

```bash
node --disable-warning=ExperimentalWarning \
  /opt/vortexgpu/scripts/lib/db-tool.mjs counts \
  /var/backups/vortexgpu/vortex-<STAMP>.db
```

## Restore, step by step

`restore-db.sh` never restarts the service and never overwrites anything before
the backup has verified.

```bash
# 1. pick a backup and check it, without touching production
ls -la /var/backups/vortexgpu/
node --disable-warning=ExperimentalWarning \
  /opt/vortexgpu/scripts/lib/db-tool.mjs verify \
  /var/backups/vortexgpu/vortex-<STAMP>.db "backup"

# 2. dry run: without --yes the script refuses and changes nothing (exit 2)
/opt/vortexgpu/scripts/restore-db.sh /var/backups/vortexgpu/vortex-<STAMP>.db

# 3. do it
/opt/vortexgpu/scripts/restore-db.sh /var/backups/vortexgpu/vortex-<STAMP>.db --yes

# 4. restart the service the approved way — the running process still holds
#    the OLD database open until you do. THIS LOGS EVERY USER OUT.
bash /opt/vortexgpu/deploy.sh

# 5. confirm
curl -s http://10.30.20.127:3000/api/health
```

Step 3 does, in order: check the `.sha256` sidecar → verify the backup →
save the **current** database to `/var/backups/vortexgpu/pre-restore-<STAMP>.db`
→ stage the restored copy next to the target → verify the staged copy → rename
it into place (removing any stale `-wal`/`-shm`/`-journal` sidecars) → verify
the result in place. Any failure before the rename leaves the live database
byte-identical.

### If a restore was the wrong call

The database as it was immediately before the restore is at
`/var/backups/vortexgpu/pre-restore-<STAMP>.db`. Restore that file the same
way. It is a normal verified backup.

## Rules for anyone editing these scripts

These come from the incident that caused the data loss:

- Absolute paths everywhere. **Never** `cd <dir> && rm -rf <relative>` — if the
  `cd` fails, the `rm` runs in the wrong directory. That is exactly what
  destroyed the database.
- The timestamp is computed into a variable and regex-checked before use, so a
  backup can never be written to a file named with a literal, unexpanded
  `$(date)` — the other half of the original failure.
- Verify after writing. **A backup that has not been verified is not a
  backup.** Never prune on the strength of an unverified write.
- `set -euo pipefail`, quote every variable, never overwrite an existing
  backup file.

## Still not covered

- Backups live on the **same host and the same filesystem** as the database
  (`/` — 8 GB, ~6 GB free). This protects against `rm -rf`, a bad migration and
  application-level corruption. It does **not** protect against losing the box
  or the disk. Off-host copies (rsync/rclone to another machine or object
  storage) are not implemented.
- Backups are **not encrypted**. They contain password hashes and Bitcoin
  addresses. `/var/backups/vortexgpu` is mode 700, root-only.
- Point-in-time recovery is not possible: the granularity is whatever the cron
  interval is (daily). Up to 24 hours of writes can be lost.
- `data/nodes.json` is **not** backed up — these scripts cover
  `data/vortex.db` only.
- Nothing alerts if the cron job stops running. Check the log, or add
  monitoring on the age of the newest file in `/var/backups/vortexgpu`.
