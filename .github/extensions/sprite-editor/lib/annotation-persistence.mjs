/**
 * Sprite Editor annotation handoff state.
 *
 * The git-tracked annotations file is a shared aggregate, while queue publication
 * is per sprite. This helper keeps local cleanup lossless:
 *   - a failed queue request leaves the local edit untouched;
 *   - a successful request restores only that sprite's HEAD value, and only when
 *     no newer local save replaced it;
 *   - a small untracked pending overlay keeps the just-queued value visible until
 *     the promoted branch reaches the worktree;
 *   - cleanup writes only the WORKING TREE file, never the git index. When the
 *     operator already has any pre-existing staged (git-add'ed) edit for the
 *     annotations file, blindly rewriting the working tree can leave that staged
 *     blob stale: a later `git add -A` could silently erase it. `markDurable`
 *     therefore checks the index (via the injected `hasStagedChanges`) before
 *     writing, and throws an actionable error
 *     instead of cleaning when the two cannot be safely reconciled -- the local
 *     (already-queued) annotation is left exactly as-is in that case.
 */

export function normalizeSpriteAnnotation(value) {
  const favorite = value?.favorite === true;
  return {
    favorite,
    disliked: value?.disliked === true && !favorite,
    comment: typeof value?.comment === 'string' ? value.comment.trim().slice(0, 1000) : '',
  };
}

export function equalAnnotation(left, right) {
  if (left === null || right === null) return left === right;
  const lhs = normalizeSpriteAnnotation(left);
  const rhs = normalizeSpriteAnnotation(right);
  return (
    lhs.favorite === rhs.favorite && lhs.disliked === rhs.disliked && lhs.comment === rhs.comment
  );
}

function cloneDocument(value) {
  const sprites =
    value?.sprites && typeof value.sprites === 'object' && !Array.isArray(value.sprites)
      ? value.sprites
      : {};
  return { version: 1, sprites: { ...sprites } };
}

/**
 * Object.prototype keys that must never be used as sprite annotation map
 * keys: assigning `document.sprites[key] = annotation` for one of these
 * mutates the object's prototype/inherited members instead of creating an own
 * enumerable JSON property, silently dropping the annotation (and letting a
 * later lookup like `entries['__proto__']` spuriously resolve to an
 * inherited, non-`undefined` value instead of failing "not found").
 */
const RESERVED_ANNOTATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isReservedAnnotationKey(key) {
  return RESERVED_ANNOTATION_KEYS.has(key);
}

export function createAnnotationPersistence({
  readCurrent,
  writeCurrent,
  readHead,
  readPending,
  writePending,
  invalidate,
  /**
   * Optional async git-index probe for the annotations file (the moral
   * equivalent of `git diff --cached --quiet -- <path>`). Any staged change to
   * this shared aggregate makes a working-tree-only cleanup unsafe, even when it
   * belongs to another sprite key: the hard post-queue invariant cannot be
   * reached without touching user-owned staged state. Production wiring MUST
   * supply this; isolated callers that have no git index may omit it.
   */
  hasStagedChanges,
}) {
  const versions = new Map();
  let pending = readPending();
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) pending = {};

  function persistPending() {
    writePending({ version: 1, sprites: pending });
  }

  return {
    /**
     * Write the local aggregate and mint a monotonic per-sprite token. The token
     * prevents an earlier queue completion from cleaning a later local save.
     */
    saveLocal(key, rawAnnotation) {
      if (isReservedAnnotationKey(key)) {
        throw new Error(
          `Invalid sprite annotation key ${JSON.stringify(key)}. Reserved object properties are not allowed.`,
        );
      }
      const annotation = normalizeSpriteAnnotation(rawAnnotation);
      // Always start from the raw tracked file. A presentation document may
      // contain pending overlays for other sprites; serializing that view would
      // reintroduce already-durable annotation diffs into the worktree.
      const document = cloneDocument(readCurrent());
      document.sprites[key] = annotation;
      writeCurrent(document);
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      invalidate();
      return { key, version, annotation };
    },

    /**
     * Overlay queued-but-not-yet-promoted values for presentation. A local value
     * different from both the captured base and queued value wins and retires the
     * stale overlay; this prevents a failed/newer local save from being hidden.
     */
    overlay(currentDocument) {
      const document = cloneDocument(currentDocument);
      let changed = false;
      for (const [key, record] of Object.entries(pending)) {
        const current = Object.hasOwn(document.sprites, key) ? document.sprites[key] : null;
        const base = record?.base ?? null;
        const annotation = record?.annotation ?? null;
        if (annotation === null) {
          delete pending[key];
          changed = true;
        } else if (equalAnnotation(current, annotation)) {
          // The promoted/checked-out file now carries the durable value.
          delete pending[key];
          changed = true;
        } else if (equalAnnotation(current, base)) {
          document.sprites[key] = normalizeSpriteAnnotation(annotation);
        } else {
          // The worktree moved independently or has a newer failed local edit.
          delete pending[key];
          changed = true;
        }
      }
      if (changed) persistPending();
      return document;
    },

    /**
     * After durable queue success, safely clean this sprite's local aggregate
     * entry back to HEAD. Returns false when a newer save/local edit makes cleanup
     * unsafe; in that case the local data is deliberately retained. Throws (does
     * NOT return false) when the annotations file has any pre-existing staged
     * git-index edit that cannot be safely reconciled with the cleanup write -- the caller must
     * surface that failure rather than silently swallow it, and the local
     * (already-queued) annotation is left untouched either way.
     */
    async markDurable(token) {
      if (versions.get(token.key) !== token.version) return false;
      const current = cloneDocument(readCurrent());
      const currentAnnotation = Object.hasOwn(current.sprites, token.key)
        ? current.sprites[token.key]
        : null;
      if (!equalAnnotation(currentAnnotation, token.annotation)) return false;

      const head = cloneDocument(await readHead());
      // A newer save can land while the asynchronous HEAD read is in flight.
      // Re-check both the version and current bytes before touching the file.
      if (versions.get(token.key) !== token.version) return false;
      const latest = cloneDocument(readCurrent());
      const latestAnnotation = Object.hasOwn(latest.sprites, token.key)
        ? latest.sprites[token.key]
        : null;
      if (!equalAnnotation(latestAnnotation, token.annotation)) return false;
      const base = Object.hasOwn(head.sprites, token.key) ? head.sprites[token.key] : null;

      // Cleanup below writes ONLY the working tree, never the git index. Any
      // pre-existing staged edit to this shared aggregate makes the requested
      // annotation-only clean state impossible without mutating user-owned
      // staged state. Fail closed before writing anything.
      if (hasStagedChanges) {
        let stagedChanges;
        try {
          stagedChanges = await hasStagedChanges();
        } catch (error) {
          throw new Error(
            `Cannot safely clean the local annotation for "${token.key}": failed to read the ` +
              `staging state of public/assets/generated/sprite-editor-annotations.json, so a ` +
              `pre-existing staged edit ` +
              `cannot be ruled out. ${error?.message ?? error}`,
          );
        }
        // A newer save or direct file edit can land while the index probe is in
        // flight. Re-check both before writing.
        if (versions.get(token.key) !== token.version) return false;
        const cleanupCurrent = cloneDocument(readCurrent());
        const cleanupAnnotation = Object.hasOwn(cleanupCurrent.sprites, token.key)
          ? cleanupCurrent.sprites[token.key]
          : null;
        if (!equalAnnotation(cleanupAnnotation, token.annotation)) return false;
        if (stagedChanges) {
          throw new Error(
            `Cannot safely clean the local annotation for "${token.key}": ` +
              `public/assets/generated/sprite-editor-annotations.json already has a staged edit. ` +
              `Cleanup will not rewrite the working tree or index because a later "git add" could ` +
              `silently erase user-owned staged data. Commit it, or run ` +
              `"git restore --staged -- public/assets/generated/sprite-editor-annotations.json", ` +
              `then re-save this sprite.`,
          );
        }
        latest.sprites = cleanupCurrent.sprites;
      }

      pending[token.key] = {
        annotation: normalizeSpriteAnnotation(token.annotation),
        base: base === null ? null : normalizeSpriteAnnotation(base),
      };
      persistPending();

      if (base === null) delete latest.sprites[token.key];
      else latest.sprites[token.key] = normalizeSpriteAnnotation(base);
      writeCurrent(latest);
      invalidate();
      return true;
    },

    pendingForTests() {
      return structuredClone(pending);
    },
  };
}
