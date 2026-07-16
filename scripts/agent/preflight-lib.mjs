#!/usr/bin/env node
/**
 * preflight-lib.mjs — portable helpers for agent session preflight.
 *
 * Provides testable JS implementations of the cache-detection and
 * node-resolution logic that `preflight.sh` also implements in bash.
 * Kept as a pure utility module (no side-effects on import) so the
 * functions can be unit-tested without touching the filesystem.
 *
 * Exports
 * -------
 *  getPlaywrightChromiumRevision(repoRoot)  → string | null
 *  isPlaywrightChromiumCached(opts)         → boolean
 *  resolveNodeBin(opts)                     → string
 *  formatTimingArtifact(phases, opts)       → string  (JSON)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Playwright chromium cache detection
// ---------------------------------------------------------------------------

/**
 * Read the expected Chromium browser revision from the playwright-core
 * `browsers.json` manifest that ships with the installed package.
 *
 * Returns the numeric revision string (e.g. `"1223"`) or `null` when the
 * manifest is absent or cannot be parsed.
 *
 * @param {string} repoRoot  — absolute path to the repository root
 * @returns {string | null}
 */
export function getPlaywrightChromiumRevision(repoRoot) {
  const manifest = join(repoRoot, 'node_modules', 'playwright-core', 'browsers.json');
  if (!existsSync(manifest)) return null;
  try {
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    const chromium = (data.browsers ?? []).find(
      (b) => b.name === 'chromium' && b.installByDefault === true,
    );
    return chromium?.revision ?? null;
  } catch {
    return null;
  }
}

/**
 * Return `true` when the Playwright Chromium binary for `revision` already
 * exists in the local browser cache.  Checks all platform layouts:
 *
 * - Linux:       `chromium-<rev>/chrome-linux64/chrome`
 * - Windows:     `chromium-<rev>/chrome-win64/chrome.exe`
 * - macOS arm64: `chromium-<rev>/chrome-mac-arm64/Chromium.app`
 * - macOS x64:   `chromium-<rev>/chrome-mac-x64/Chromium.app`
 *
 * @param {{ revision: string; cacheDir?: string; _existsSync?: (p:string)=>boolean }} opts
 * @returns {boolean}
 */
export function isPlaywrightChromiumCached({
  revision,
  cacheDir = join(homedir(), '.cache', 'ms-playwright'),
  _existsSync = existsSync,
}) {
  if (!revision) return false;
  const base = join(cacheDir, `chromium-${revision}`);
  return (
    _existsSync(join(base, 'chrome-linux64', 'chrome')) ||
    _existsSync(join(base, 'chrome-win64', 'chrome.exe')) ||
    _existsSync(join(base, 'chrome-mac-arm64', 'Chromium.app')) ||
    _existsSync(join(base, 'chrome-mac-x64', 'Chromium.app'))
  );
}

// ---------------------------------------------------------------------------
// Portable node binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a usable `node` executable path.
 *
 * Under Git Bash on Windows the shell `PATH` often omits the node installation
 * directory even though `npm` (a `.cmd` wrapper) is present.  In that
 * situation `node` is typically co-located with the `npm` script in the same
 * prefix directory.  This function probes that sibling location as a fallback.
 *
 * The injected `_which` / `_existsSync` parameters exist solely to make the
 * function unit-testable without touching the real filesystem or spawning
 * processes.
 *
 * @param {{
 *   npmBin?: string | null;   explicit path to the npm binary (default: search PATH)
 *   _which?: (cmd:string) => string | null;
 *   _existsSync?: (p:string) => boolean;
 *   _realpathSync?: (p:string) => string;
 * }} opts
 * @returns {string}  the `node` command name when found on PATH; absolute path otherwise;
 *                    `""` when node cannot be located at all.
 */
export function resolveNodeBin({
  npmBin = null,
  _which = defaultWhich,
  _existsSync = existsSync,
  _realpathSync = defaultRealpathSync,
} = {}) {
  // Fast path: node is directly on the shell PATH.
  const nodeOnPath = _which('node');
  if (nodeOnPath) return nodeOnPath;

  // Git Bash fallback: locate node next to the npm binary.
  const npmPath = npmBin ?? _which('npm');
  if (!npmPath) return '';

  const resolvedNpm = _realpathSync(npmPath);
  const npmDir = dirname(resolvedNpm || npmPath);
  for (const candidate of [join(npmDir, 'node'), join(npmDir, 'node.exe')]) {
    if (_existsSync(candidate)) return candidate;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Timing artifact formatter
// ---------------------------------------------------------------------------

/**
 * Serialise a preflight phase array into the `agent-os-preflight-timing/v1`
 * JSON string.
 *
 * Each `phase` object shape:
 * ```
 * {
 *   name:      string,
 *   startS:    number,   // seconds since preflight start (0-based)
 *   durationS: number,   // wall-clock seconds for the phase
 *   skipped:   boolean,
 *   note:      string,
 * }
 * ```
 *
 * @param {Array<{name:string;startS:number;durationS:number;skipped:boolean;note:string}>} phases
 * @param {{ timestamp?: string; warmCache?: boolean; targetS?: number }} opts
 * @returns {string}
 */
export function formatTimingArtifact(
  phases,
  { timestamp = '', warmCache = true, targetS = 30 } = {},
) {
  const totalS = phases.reduce((acc, p) => Math.max(acc, p.startS + p.durationS), 0);
  const metTarget = totalS <= targetS;
  return JSON.stringify(
    {
      schema: 'agent-os-preflight-timing/v1',
      timestamp,
      phases,
      totalS,
      targetS,
      warmCache,
      metTarget30s: metTarget,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultWhich(cmd) {
  // Synchronous PATH search mirroring POSIX `which`/Windows `where`.
  // Only used as a default; tests always inject their own _which.
  try {
    const result = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function defaultRealpathSync(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
