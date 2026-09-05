#!/usr/bin/env node
// db-tool.mjs — SQLite helpers for the VortexGPU backup/restore scripts.
//
// Subcommands:
//   backup <src.db> <dest.db>   crash-consistent copy via the SQLite backup API
//   verify <db>                 PRAGMA integrity_check + required tables + row counts
//   counts <db>                 print "table<TAB>count" lines (machine readable)
//
// Never writes to the source database. Exits non-zero on any failure.

import { DatabaseSync, backup } from 'node:sqlite';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Tables that must exist in a database for it to count as a valid VortexGPU
// database. An EMPTY table is valid; a MISSING table is not.
const REQUIRED_TABLES = ['users', 'invoices', 'sessions', 'vms'];

function die(msg) {
  console.error(`db-tool: ERROR: ${msg}`);
  process.exit(1);
}

function requireAbsolute(p, what) {
  if (!isAbsolute(p)) die(`${what} must be an absolute path, got: ${p}`);
  return p;
}

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    die(`cannot open ${path} read-only: ${err.message}`);
  }
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function rowCounts(db, tables) {
  const out = {};
  for (const t of tables) {
    // Table names come from sqlite_master, not user input; still quoted.
    out[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
  }
  return out;
}

// Full verification. Returns the row counts. Exits non-zero (via die) on failure.
function verify(path, label) {
  requireAbsolute(path, 'database path');

  let st;
  try {
    st = statSync(path);
  } catch {
    die(`${label} does not exist: ${path}`);
  }
  if (!st.isFile()) die(`${label} is not a regular file: ${path}`);
  if (st.size === 0) die(`${label} is zero bytes: ${path}`);

  const db = openReadOnly(path);
  try {
    let integrity;
    try {
      integrity = db.prepare('PRAGMA integrity_check').all();
    } catch (err) {
      die(`${label} failed integrity_check (not a readable SQLite database?): ${err.message}`);
    }
    const verdict = integrity.map((r) => r.integrity_check).join('; ');
    if (verdict !== 'ok') die(`${label} failed PRAGMA integrity_check: ${verdict}`);

    const present = tableNames(db);
    const missing = REQUIRED_TABLES.filter((t) => !present.includes(t));
    if (missing.length) {
      die(
        `${label} is missing required table(s): ${missing.join(', ')} ` +
          `(present: ${present.join(', ') || 'none'})`,
      );
    }

    const counts = rowCounts(db, REQUIRED_TABLES);
    console.log(`  integrity_check: ok`);
    console.log(`  size: ${st.size} bytes`);
    for (const t of REQUIRED_TABLES) console.log(`  rows ${t}: ${counts[t]}`);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`  rows total: ${total}`);
    return counts;
  } finally {
    db.close();
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'backup') {
    const [src, dest] = args;
    if (!src || !dest) die('usage: db-tool.mjs backup <src.db> <dest.db>');
    requireAbsolute(src, 'source');
    requireAbsolute(dest, 'destination');
    if (src === dest) die('source and destination are the same path');
    const db = openReadOnly(src);
    try {
      // SQLite online backup API: safe against concurrent writers, unlike cp.
      const bytes = await backup(db, dest);
      console.log(`  backup API copied ${bytes} page(s)`);
    } catch (err) {
      die(`backup failed: ${err.message}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === 'verify') {
    const [path, label] = args;
    if (!path) die('usage: db-tool.mjs verify <db> [label]');
    verify(path, label || 'database');
    return;
  }

  if (cmd === 'counts') {
    const [path] = args;
    if (!path) die('usage: db-tool.mjs counts <db>');
    requireAbsolute(path, 'database path');
    const db = openReadOnly(path);
    try {
      const counts = rowCounts(db, REQUIRED_TABLES.filter((t) => tableNames(db).includes(t)));
      for (const [t, n] of Object.entries(counts)) console.log(`${t}\t${n}`);
    } finally {
      db.close();
    }
    return;
  }

  die(`unknown subcommand: ${cmd ?? '(none)'} — expected backup|verify|counts`);
}

await main();
