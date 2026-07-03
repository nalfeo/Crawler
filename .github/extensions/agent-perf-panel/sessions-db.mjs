// sessions-db: read-only accessor over ~/.copilot/session-store.db (SQLite).
//
// Uses Node's built-in `node:sqlite` module (available since Node 22) so this
// stays zero-dep. We only ever read, and we open with `readOnly: true` so the
// live CLI's writer isn't blocked by the extension.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

let cachedDb = null;
let cachedDbPath = null;
let cachedDbMtime = 0;

function dbPath() {
  return join(homedir(), '.copilot', 'session-store.db');
}

function events_jsonl_path(id) {
  return join(homedir(), '.copilot', 'session-state', id, 'events.jsonl');
}

/**
 * Get a read-only handle to the session store. Re-opens if the file mtime has
 * changed (Copilot rewrites the file during major migrations).
 */
function getDb() {
  const path = dbPath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cachedDb && cachedDbPath === path && cachedDbMtime === mtime) return cachedDb;
  try {
    if (cachedDb) cachedDb.close();
  } catch {
    /* ignore */
  }
  cachedDb = new DatabaseSync(path, { readOnly: true });
  cachedDbPath = path;
  cachedDbMtime = mtime;
  return cachedDb;
}

/**
 * List sessions, optionally filtered by repository substring and date range.
 * Fast: SQLite index lookup + one existsSync per row.
 * @param {{ repository?: string, sinceIso?: string, untilIso?: string, limit?: number }} opts
 */
export function listSessions(opts = {}) {
  const db = getDb();
  if (!db) return [];
  const clauses = [];
  const params = {};
  if (opts.repository) {
    clauses.push('repository LIKE :repo');
    params.repo = `%${opts.repository}%`;
  }
  if (opts.sinceIso) {
    clauses.push('updated_at >= :since');
    params.since = opts.sinceIso;
  }
  if (opts.untilIso) {
    clauses.push('updated_at <= :until');
    params.until = opts.untilIso;
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const limit = opts.limit ? `LIMIT ${Math.max(1, Math.min(500, opts.limit | 0))}` : 'LIMIT 200';
  const sql = `SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at
               FROM sessions ${where}
               ORDER BY datetime(updated_at) DESC ${limit}`;
  const rows = db.prepare(sql).all(params);
  return rows.map((r) => ({
    id: r.id,
    cwd: r.cwd,
    repository: r.repository,
    hostType: r.host_type,
    branch: r.branch,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasEventLog: existsSync(events_jsonl_path(r.id)),
    eventLogBytes: safeFileSize(events_jsonl_path(r.id)),
  }));
}

/** Lightweight session-metadata lookup by id. */
export function getSessionMetadata(sessionId) {
  const db = getDb();
  if (!db) return null;
  const row = db
    .prepare(
      'SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions WHERE id = ?',
    )
    .get(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    cwd: row.cwd,
    repository: row.repository,
    hostType: row.host_type,
    branch: row.branch,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasEventLog: existsSync(events_jsonl_path(row.id)),
    eventLogBytes: safeFileSize(events_jsonl_path(row.id)),
  };
}

/** Distinct repositories seen in the store, sorted by activity. */
export function listRepositories() {
  const db = getDb();
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT repository, COUNT(*) AS session_count, MAX(updated_at) AS last_active
       FROM sessions
       WHERE repository IS NOT NULL AND repository != ''
       GROUP BY repository
       ORDER BY datetime(last_active) DESC`,
    )
    .all();
  return rows.map((r) => ({
    repository: r.repository,
    sessionCount: r.session_count,
    lastActive: r.last_active,
  }));
}

function safeFileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
