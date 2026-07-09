/**
 * image-cache.mjs — a small, dependency-free, on-disk cache for immutable
 * binary assets (sprite sheets, processed variants, slice-map overlays) that a
 * canvas extension proxies from a slow upstream (the sprite sidecar → Azure
 * Blob Storage).
 *
 * WHY THIS EXISTS
 * ---------------
 * The sprite sidecar streams sheets from Azure. A cold sheet fetch can take
 * several seconds and the same bytes are re-fetched every time a canvas
 * instance re-renders — in every worktree. Sidecar runs are timestamped and
 * IMMUTABLE (a `runId` never changes its bytes), so the cache needs no
 * invalidation: once a `(kind, briefId, runId, file)` tuple is on disk it is
 * valid forever.
 *
 * The cache dir lives OUTSIDE any git worktree (under `$COPILOT_HOME`, default
 * `~/.copilot`), so every worktree on the machine SHARES one cache. This is the
 * "outside-of-worktree caching for the sheets we pull from azure for perf" ask.
 *
 * DESIGN CONTRACT (this is a canonical harness file — B–E reuse it verbatim)
 * -------------------------------------------------------------------------
 * - NEVER throws from the hot path. Any invalid key, fs error, or race falls
 *   back to a graceful cache MISS / pass-through. A broken cache must never
 *   break image relaying.
 * - Path-traversal safe: every key segment is validated against a strict
 *   charset AND the resolved entry path is asserted to be under the cache root.
 * - Atomic writes: bytes are written to a temp file then renamed, so a
 *   concurrent reader never sees a half-written asset.
 * - Content-Type is preserved alongside the bytes in a sibling `.ctype` file.
 *
 * @module canvas-harness/image-cache
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

/** Segment charset: alnum first char, then alnum / dot / underscore / hyphen. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve `$COPILOT_HOME` (default `~/.copilot`). Mirrors the SDK's own
 * home-dir resolution so caches land where the rest of Copilot state lives.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCopilotHome(env = process.env) {
  const explicit = env.COPILOT_HOME && String(env.COPILOT_HOME).trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.copilot');
}

/**
 * Resolve the per-extension cache directory:
 * `$COPILOT_HOME/extensions/<extName>/cache`. This is intentionally OUTSIDE the
 * git worktree so sibling worktrees share the cache.
 * @param {string} extName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveExtCacheDir(extName, env = process.env) {
  return path.join(resolveCopilotHome(env), 'extensions', extName, 'cache');
}

/** True if every segment is a non-empty, traversal-safe token. */
function segmentsValid(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0) return false;
    if (seg === '.' || seg === '..') return false;
    if (!SEGMENT_RE.test(seg)) return false;
  }
  return true;
}

/**
 * Create an on-disk image cache rooted at `dir`.
 *
 * @param {{ dir: string, log?: (msg: string) => void }} options
 * @returns {{
 *   enabled: boolean,
 *   dir: string,
 *   entryPath: (segments: string[]) => string | null,
 *   get: (segments: string[]) => Promise<{ bytes: Buffer, contentType: string } | null>,
 *   put: (segments: string[], bytes: Buffer, contentType: string) => Promise<boolean>,
 *   fetchThrough: (
 *     segments: string[],
 *     fetchFn: () => Promise<Response>,
 *   ) => Promise<
 *     | { hit: true, bytes: Buffer, contentType: string }
 *     | { hit: false, bytes: Buffer, contentType: string, cached: boolean }
 *     | { hit: false, response: Response }
 *   >,
 * }}
 */
export function createImageCache(options = {}) {
  const dir = options.dir;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let enabled = Boolean(dir);

  if (enabled) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      enabled = false;
      log(
        `image-cache: disabled (cannot create ${dir}): ${err && err.message ? err.message : err}`,
      );
    }
  }

  const rootResolved = enabled ? path.resolve(dir) : null;

  /** Resolve the on-disk path for a key, or null if the key is unsafe. */
  function entryPath(segments) {
    if (!enabled || !segmentsValid(segments)) return null;
    const candidate = path.resolve(rootResolved, ...segments);
    // Defense-in-depth: even with a valid charset, assert containment.
    const rel = path.relative(rootResolved, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return candidate;
  }

  async function get(segments) {
    const file = entryPath(segments);
    if (!file) return null;
    try {
      const [bytes, ctypeRaw] = await Promise.all([
        fs.promises.readFile(file),
        fs.promises.readFile(`${file}.ctype`, 'utf8').catch(() => ''),
      ]);
      const contentType = ctypeRaw.trim() || 'application/octet-stream';
      return { bytes, contentType };
    } catch {
      return null; // miss (ENOENT or any read error)
    }
  }

  async function put(segments, bytes, contentType) {
    const file = entryPath(segments);
    if (!file) return false;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return false;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const suffix = randomBytes(6).toString('hex');
      const tmp = `${file}.tmp-${suffix}`;
      const tmpCtype = `${file}.ctype.tmp-${suffix}`;
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.writeFile(tmpCtype, String(contentType || 'application/octet-stream'));
      // Rename bytes last: a reader that sees the bytes file always finds a
      // ctype file too (written+renamed first).
      await fs.promises.rename(tmpCtype, `${file}.ctype`);
      await fs.promises.rename(tmp, file);
      return true;
    } catch (err) {
      log(
        `image-cache: put failed for ${segments.join('/')}: ${err && err.message ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * Serve from cache if present, else run `fetchFn`, cache a successful body,
   * and return the bytes. Non-OK / bodyless upstream responses are passed back
   * verbatim (uncached) so the caller can relay the real status/headers.
   */
  async function fetchThrough(segments, fetchFn) {
    const cached = await get(segments);
    if (cached) return { hit: true, bytes: cached.bytes, contentType: cached.contentType };

    const response = await fetchFn();
    if (!response || !response.ok || !response.body) {
      return { hit: false, response };
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const didCache = await put(segments, bytes, contentType);
    return { hit: false, bytes, contentType, cached: didCache };
  }

  return { enabled, dir: enabled ? dir : '', entryPath, get, put, fetchThrough };
}
