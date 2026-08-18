/**
 * Read-only access to the Sprite Editor's queued-but-unpromoted annotation
 * overlay (see annotation-persistence.mjs). `markDurable` there resets the
 * tracked `sprite-editor-annotations.json` working-tree file back to HEAD as
 * soon as a queue-commit succeeds, so a sprite that was just disliked and
 * durably queued is briefly invisible in the tracked file until the async
 * reconciler promotes assets/queue and this worktree fetches it. The pending
 * overlay (an untracked, per-worktree JSON file) is the only place that state
 * is still visible in the meantime.
 *
 * Consumers OUTSIDE the editor -- notably `scripts/sprites/generate-one.ts`,
 * which excludes disliked sprites from reference selection -- must be able to
 * see this state too, without recreating a tracked diff after queueing. This
 * module is therefore READ-ONLY BY DESIGN: it never creates, writes, or
 * deletes the overlay file, and it must stay that way -- a read-side mutation
 * here would race the editor's own writer (annotation-persistence.mjs) and
 * could reintroduce a tracked diff the whole queue-commit design exists to
 * avoid.
 *
 * @module sprite-editor/pending-annotation-overlay
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveSnapshotPath } from './manifest-snapshot.mjs';
import { equalAnnotation } from './annotation-persistence.mjs';

/**
 * The pending-overlay file path for a given repo root. MUST stay byte-for-byte
 * identical to `PENDING_ANNOTATIONS_PATH` in `extension.mjs` (the overlay's
 * only writer) -- both now derive it from the same `resolveSnapshotPath` call,
 * so there is a single source of truth rather than two formulas to keep in
 * sync.
 *
 * @param {string} repoRoot
 * @param {{ env?: NodeJS.ProcessEnv, homedir?: string }} [deps]
 * @returns {string}
 */
export function resolvePendingAnnotationsPath(repoRoot, deps = {}) {
  return `${resolveSnapshotPath(repoRoot, deps)}.pending-annotations.json`;
}

const PENDING_PARSE_ATTEMPTS = 3;

/**
 * Sprite keys whose queued-but-unpromoted overlay value is currently
 * disliked. Fails safe to an EMPTY set (never throws) on a missing,
 * malformed, or transiently torn file -- losing sight of one pending dislike
 * for a single caller is far cheaper than crashing reference selection, and
 * the editor's own writes are atomic (temp file + rename) so a torn read
 * should be exceedingly rare; the bounded retry exists only as cheap
 * insurance during that rename window, mirroring the tracked-annotations
 * reader's own fail-safe retry policy.
 *
 * A pending record only counts while the tracked annotation for that sprite
 * still matches the `base` value captured when the dislike was queued (the
 * same base/current reconciliation `annotationPersistence.overlay` applies in
 * the editor). Once another worktree's promotion supersedes it -- the tracked
 * value has moved on from `base` -- the queued dislike is stale and this
 * reader stops counting it; from that point the tracked-annotations reader is
 * the sole source of truth for that sprite.
 *
 * @param {string} pendingAnnotationsPath
 * @param {{ readFile?: (path: string) => string, exists?: (path: string) => boolean, getCurrentAnnotation?: (key: string) => unknown }} [deps]
 * @returns {ReadonlySet<string>}
 */
export function readPendingDislikedSpriteNames(pendingAnnotationsPath, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const fileExists = deps.exists ?? ((p) => existsSync(p));
  const getCurrentAnnotation = deps.getCurrentAnnotation ?? (() => null);
  if (!fileExists(pendingAnnotationsPath)) return new Set();
  for (let attempt = 0; attempt < PENDING_PARSE_ATTEMPTS; attempt += 1) {
    try {
      const raw = JSON.parse(readFile(pendingAnnotationsPath));
      const sprites =
        raw?.sprites && typeof raw.sprites === 'object' && !Array.isArray(raw.sprites)
          ? raw.sprites
          : {};
      const disliked = new Set();
      for (const [key, record] of Object.entries(sprites)) {
        if (!record || typeof record !== 'object' || record.annotation?.disliked !== true) {
          continue;
        }
        const base = Object.hasOwn(record, 'base') ? record.base : null;
        const current = getCurrentAnnotation(key);
        if (equalAnnotation(current, base)) {
          disliked.add(key);
        }
      }
      return disliked;
    } catch {
      // Concurrent editor writes are atomic (temp + rename); retry a bounded
      // number of times, then fail safe to an empty set.
    }
  }
  return new Set();
}
