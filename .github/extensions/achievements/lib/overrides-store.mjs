/**
 * overrides-store.mjs — DURABLE, server-side persistence for achievement
 * overrides. This closes the parity gap the plan review flagged: the harness
 * serves each canvas instance on `127.0.0.1:0` (a random port), and browser
 * `localStorage` is origin-scoped, so client-only localStorage does NOT survive
 * a close/reopen or an `extensions_reload` (new port ⇒ new origin ⇒ empty
 * store). The monolith's dev server has a STABLE origin, so its localStorage
 * overrides persist across reloads.
 *
 * To match that behavior, this module persists the override map to a stable
 * user-global file, keyed by the repo root so sibling worktrees don't collide.
 * Per the canvas state-model guidance, user-global data lives under
 * `$COPILOT_HOME/extensions/<name>/artifacts/`, NOT inside the repo. The client
 * still mirrors every write to `localStorage` under the same key/shape (that is
 * the explicitly-requested in-page persistence), but this file is the durable
 * source of truth that lets overrides survive a new port.
 *
 * Only `node:` builtins + the pure `sanitizeOverrides` helper are used; all fs
 * touchpoints are injectable so the logic is unit-testable without real disk IO.
 *
 * @module achievements/overrides-store
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { sanitizeOverrides } from './overrides-model.mjs';

/**
 * Resolve the durable overrides file for a given repo root.
 * `$COPILOT_HOME/extensions/achievements/artifacts/overrides.<repoHash>.json`.
 * @param {string} repoRoot absolute git-worktree root.
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: string }} [deps]
 * @returns {string}
 */
export function resolveStorePath(repoRoot, deps = {}) {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();
  const copilotHome =
    env.COPILOT_HOME && env.COPILOT_HOME.length > 0
      ? env.COPILOT_HOME
      : path.join(homedir, '.copilot');
  const hash = createHash('sha1').update(String(repoRoot)).digest('hex').slice(0, 12);
  return path.join(
    copilotHome,
    'extensions',
    'achievements',
    'artifacts',
    `overrides.${hash}.json`,
  );
}

/**
 * Read + sanitize the persisted override map. NEVER throws — a missing,
 * unreadable, or malformed file degrades to an empty map (parity with the
 * monolith's `loadAchievementOverrides` try/catch fallback).
 * @param {string} filePath
 * @param {{ readFile?: (p: string) => string }} [deps]
 * @returns {Record<string, object>}
 */
export function readOverridesStore(filePath, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let raw;
  try {
    raw = readFile(filePath);
  } catch {
    return {};
  }
  try {
    return sanitizeOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Sanitize + persist the override map (pretty-printed). Ensures the parent
 * directory exists first. Returns the sanitized map that was written.
 * @param {string} filePath
 * @param {unknown} overrides
 * @param {{ writeFile?: (p: string, data: string) => void, mkdir?: (dir: string) => void }} [deps]
 * @returns {Record<string, object>}
 */
export function writeOverridesStore(filePath, overrides, deps = {}) {
  const writeFile = deps.writeFile ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const mkdir = deps.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  const clean = sanitizeOverrides(overrides);
  mkdir(path.dirname(filePath));
  writeFile(filePath, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}
