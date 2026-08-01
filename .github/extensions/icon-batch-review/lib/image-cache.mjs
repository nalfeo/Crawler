/**
 * image-cache.mjs — a thin, dependency-free PASS-THROUGH relay for binary
 * assets (sprite sheets, processed variants, slice-map overlays) that a canvas
 * extension proxies from the sprite sidecar.
 *
 * WHY THIS IS NOW A PASS-THROUGH (ADR 0065)
 * -----------------------------------------
 * The sidecar is the ONE authoritative cache. Its `CachingRunStore` wraps Azure
 * Blob Storage in a single, shared, size-bounded content-addressable cache
 * (`scripts/sprites/store/shared-cache.ts`) that every worktree and session on
 * the machine shares. A warmed sidecar therefore already serves these bytes
 * fast and from a single physical copy.
 *
 * Previously EACH canvas extension kept its OWN unbounded on-disk cache under
 * `$COPILOT_HOME/extensions/<ext>/cache`. That produced four+ independent,
 * uncapped caches storing duplicate copies of the same bytes — impossible to
 * bound or keep coherent. Those per-extension disk caches are removed. This
 * module keeps the exact same public API and response shapes so extensions need
 * no changes, but it NEVER writes to disk: every request is relayed to the
 * sidecar, which serves from the shared authoritative cache.
 *
 * DESIGN CONTRACT (this is a canonical harness file — extensions reuse it verbatim)
 * --------------------------------------------------------------------------------
 * - NEVER throws from the hot path. Any error falls back to a graceful
 *   pass-through. A relay must never break image serving.
 * - No persistent per-extension disk cache is ever created or written.
 * - Non-OK / bodyless upstream responses are passed back verbatim so the caller
 *   relays the real status/headers.
 * - The path helpers (`resolveCopilotHome`, `resolveExtCacheDir`) are retained
 *   for backward compatibility but no longer back a live disk cache.
 *
 * @module canvas-harness/image-cache
 */

/* global Response */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

/**
 * Resolve `$COPILOT_HOME` (default `~/.copilot`). Retained for backward
 * compatibility; no longer used to create a disk cache.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCopilotHome(env = process.env) {
  const explicit = env.COPILOT_HOME && String(env.COPILOT_HOME).trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.copilot');
}

/**
 * Resolve the (historical) per-extension cache directory path:
 * `$COPILOT_HOME/extensions/<extName>/cache`. Retained for backward
 * compatibility with callers that still compute this path; nothing is written
 * there any more — the sidecar owns the one shared cache.
 * @param {string} extName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveExtCacheDir(extName, env = process.env) {
  return path.join(resolveCopilotHome(env), 'extensions', extName, 'cache');
}

/**
 * Create a pass-through image relay. The `options` are accepted (and ignored
 * for disk-caching purposes) so existing call sites keep working unchanged.
 *
 * @param {{ dir?: string, log?: (msg: string) => void }} [options]
 * @returns {{
 *   enabled: boolean,
 *   dir: string,
 *   entryPath: (segments: string[]) => string | null,
 *   get: (segments: string[]) => Promise<null>,
 *   put: (segments: string[], bytes: Buffer, contentType: string) => Promise<boolean>,
 *   fetchThrough: (
 *     segments: string[],
 *     fetchFn: () => Promise<Response>,
 *   ) => Promise<
 *     | { hit: false, bytes: Buffer, contentType: string, cached: boolean }
 *     | { hit: false, response: Response }
 *   >,
 * }}
 */
export function createImageCache(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};

  // No persistent disk cache: reads always miss, writes are no-ops.
  function entryPath() {
    return null;
  }

  async function get() {
    return null;
  }

  async function put() {
    return false;
  }

  /**
   * Relay through to the sidecar. A successful body is returned as bytes (never
   * persisted locally); non-OK / bodyless responses are passed back verbatim.
   */
  async function fetchThrough(_segments, fetchFn) {
    const response = await fetchFn();
    if (!response || !response.ok || !response.body) {
      return { hit: false, response };
    }
    try {
      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      return { hit: false, bytes, contentType, cached: false };
    } catch (err) {
      log(`image-cache: relay read failed: ${err && err.message ? err.message : err}`);
      // The response body is already disturbed/errored after arrayBuffer()
      // rejects. Return a fresh, readable 502 so callers can relay a usable
      // response instead of an unusable disturbed body.
      return { hit: false, response: new Response(null, { status: 502 }) };
    }
  }

  return { enabled: false, dir: '', entryPath, get, put, fetchThrough };
}
