/**
 * manifest-snapshot.mjs — DURABLE, cross-process cache of the composed sprite
 * manifest, so the editor does not re-read 642 per-asset shards on every cold
 * start.
 *
 * WHY THIS EXISTS
 * ---------------
 * The generated manifest's source of truth is a directory of per-asset shards
 * (`public/assets/generated/entries/**.json`). Composing it means one
 * `readFileSync` + `JSON.parse` per shard. Measured on this repo (642 shards):
 *
 *   - compose from shards ......... ~730 ms
 *   - read + parse one snapshot ... ~9 ms   (1.3 MB of JSON)
 *
 * The extension already memoized the composed result in a module-level object,
 * but that memo dies with the process. A new session, an `extensions_reload`, or
 * an app close/reopen therefore paid the full ~730 ms again before the first
 * sprite could render. This module makes that memo DURABLE: the composed
 * manifest is written once to a stable user-global file and re-read on the next
 * cold start.
 *
 * DESIGN CONTRACT
 * ---------------
 * - NEVER throws. Every read/write path degrades to `null`/`false` so a missing,
 *   unreadable, malformed, or concurrently-written snapshot simply falls back to
 *   composing from shards. The snapshot is an accelerator, never a source of
 *   truth.
 * - CORRECTNESS IS FINGERPRINT-GATED. A snapshot is only accepted when its
 *   stored fingerprint matches the live shard fingerprint (sorted shard identity
 *   fingerprint). A stale snapshot is ignored, not served.
 * - USER-GLOBAL, NOT IN-REPO. Per the canvas state-model guidance this lives
 *   under `$COPILOT_HOME/extensions/sprite-editor/artifacts/`, keyed by a hash of
 *   the repo root so sibling worktrees never collide and never dirty the tree.
 * - WRITES ARE ATOMIC. A temp file + rename means a concurrently-reading process
 *   sees either the whole old snapshot or the whole new one, never a torn file.
 *
 * @module sprite-editor/manifest-snapshot
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';

/** Bumped when the snapshot payload shape changes, to invalidate old files. */
export const SNAPSHOT_VERSION = 1;

/**
 * Resolve the durable snapshot file for a given repo root:
 * `$COPILOT_HOME/extensions/sprite-editor/artifacts/manifest.<repoHash>.json`.
 *
 * @param {string} repoRoot absolute git-worktree root.
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: string }} [deps]
 * @returns {string}
 */
export function resolveSnapshotPath(repoRoot, deps = {}) {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();
  const copilotHome =
    env.COPILOT_HOME && String(env.COPILOT_HOME).length > 0
      ? String(env.COPILOT_HOME)
      : path.join(homedir, '.copilot');
  const hash = createHash('sha1').update(String(repoRoot)).digest('hex').slice(0, 12);
  return path.join(
    copilotHome,
    'extensions',
    'sprite-editor',
    'artifacts',
    `manifest.${hash}.json`,
  );
}

/**
 * Read a snapshot, but ONLY return it when it is provably current.
 *
 * The snapshot is rejected (returns `null`) when the file is missing,
 * unreadable, malformed, written by a different payload version, or when its
 * recorded fingerprint does not match the live shard fingerprint. In every
 * rejection case the caller must fall back to composing from shards.
 *
 * @param {string} filePath
 * @param {string} expectedFingerprint live sorted shard identity fingerprint.
 * @param {{ readFile?: (p: string) => string }} [deps]
 * @returns {{ manifest: object } | null}
 */
export function readSnapshot(filePath, expectedFingerprint, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.snapshotVersion !== SNAPSHOT_VERSION) return null;
  if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint !== expectedFingerprint) {
    return null;
  }
  const manifest = parsed.manifest;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !manifest.entries ||
    typeof manifest.entries !== 'object' ||
    Array.isArray(manifest.entries)
  ) {
    return null;
  }
  return { manifest };
}

/**
 * Atomically persist a composed manifest alongside the fingerprint it was
 * composed at. Best-effort: returns `false` (never throws) if the write fails,
 * because failing to accelerate must never fail the request that triggered it.
 *
 * @param {string} filePath
 * @param {string} fingerprint shard fingerprint the manifest was composed at.
 * @param {object} manifest composed `{ version, entries }` manifest.
 * @param {{
 *   writeFile?: (p: string, data: string) => void,
 *   mkdir?: (dir: string) => void,
 *   rename?: (from: string, to: string) => void,
 *   remove?: (p: string) => void,
 * }} [deps]
 * @returns {boolean} whether the snapshot was persisted.
 */
export function writeSnapshot(filePath, fingerprint, manifest, deps = {}) {
  const writeFile = deps.writeFile ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const mkdir = deps.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  const rename = deps.rename ?? ((from, to) => renameSync(from, to));
  const remove = deps.remove ?? ((p) => rmSync(p, { force: true }));
  // Unique temp name: several worktrees/processes may snapshot concurrently, and
  // a shared temp name would let one process truncate another's half-written file.
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdir(path.dirname(filePath));
    writeFile(
      tempPath,
      `${JSON.stringify({ snapshotVersion: SNAPSHOT_VERSION, fingerprint, manifest })}\n`,
    );
    rename(tempPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      remove(tempPath);
    } catch {
      // A successful rename already consumed the temp file; nothing to clean up.
    }
  }
}
