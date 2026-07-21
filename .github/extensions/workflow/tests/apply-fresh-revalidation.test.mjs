/**
 * Deterministic, behavior-level tests for `applyFreshRevalidation`
 * (lib/run-view-cache.mjs) — the guard that closes the round-2 remediation
 * race in `buildState()`'s `onFresh` callback (extension.mjs):
 *
 *   `onFresh` re-reads the static half of the view model (`getStatic(entry)`)
 *   right before composing/pushing state (see extension.mjs for why it must
 *   never reuse the outer `stat` snapshot). But `resolveCacheFirstState`'s own
 *   `isCurrent()` check only covers the window up to the moment `onFresh` is
 *   INVOKED — if the entry's selection changes (bumping `selectionVersion`)
 *   WHILE that second `getStatic` await is in flight, the check made when
 *   `onFresh` started has gone stale by the time it would mutate
 *   `entry.selected` / push state. Pre-fix, nothing re-verified currentness
 *   after that await, so a superseded revalidation could still clobber a
 *   newer selection with stale "fresh" state.
 *
 * These tests use manually-controlled ("deferred") promises — never
 * wall-clock timers — to deterministically land a selection change squarely
 * inside the `getStatic` await window, then prove neither `applyMutation` nor
 * `pushState` fire for the superseded completion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFreshRevalidation } from '../lib/run-view-cache.mjs';

/** A promise plus externally-callable resolve/reject — for deterministic control. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('supersession DURING the getStatic await: neither applyMutation nor pushState fire, and the function reports false', async () => {
  let selectionVersion = 1;
  const versionAtCall = selectionVersion;
  const staticFetch = deferred();

  let mutationCalls = 0;
  let pushCalls = 0;

  const resultPromise = applyFreshRevalidation({
    isCurrent: () => selectionVersion === versionAtCall,
    getStatic: () => staticFetch.promise,
    applyMutation: () => {
      mutationCalls += 1;
    },
    pushState: () => {
      pushCalls += 1;
    },
  });

  // Nothing has settled yet — getStatic() is still pending.
  assert.equal(mutationCalls, 0);
  assert.equal(pushCalls, 0);

  // Simulate the entry's selection changing WHILE the static re-read is still
  // in flight (e.g. a user click bumps selectionVersion, or an
  // accept-and-queue invalidates entry.cache concurrently).
  selectionVersion += 1;

  // NOW let the deferred getStatic() resolve — this is the exact race window
  // the finding described: currentness was fine when the call STARTED, but
  // has since been superseded before the mutation/push would happen.
  staticFetch.resolve({ backlog: 'post-accept-static' });
  const applied = await resultPromise;

  assert.equal(applied, false, 'a superseded completion must report it did not apply');
  assert.equal(
    mutationCalls,
    0,
    'entry.selected must never be mutated for a superseded completion',
  );
  assert.equal(pushCalls, 0, 'no stale fresh state may ever be pushed for a superseded completion');
});

test('still current after the getStatic await: applyMutation and pushState both fire exactly once, in order, with the re-read static snapshot', async () => {
  let selectionVersion = 1;
  const versionAtCall = selectionVersion;
  const staticFetch = deferred();

  const calls = [];

  const resultPromise = applyFreshRevalidation({
    isCurrent: () => selectionVersion === versionAtCall,
    getStatic: () => staticFetch.promise,
    applyMutation: (currentStat) => calls.push(['mutate', currentStat]),
    pushState: (currentStat) => calls.push(['push', currentStat]),
  });

  // No unrelated selection change this time — resolve the static re-read.
  staticFetch.resolve({ backlog: 'current-static' });
  const applied = await resultPromise;

  assert.equal(applied, true);
  assert.deepEqual(calls, [
    ['mutate', { backlog: 'current-static' }],
    ['push', { backlog: 'current-static' }],
  ]);
});

test('a completion that was ALREADY superseded before getStatic() even resolves the first time is still a no-op (regression sanity check)', async () => {
  let selectionVersion = 1;
  const versionAtCall = selectionVersion;
  selectionVersion += 1; // superseded before applyFreshRevalidation is even called

  let mutationCalls = 0;
  let pushCalls = 0;

  const applied = await applyFreshRevalidation({
    isCurrent: () => selectionVersion === versionAtCall,
    getStatic: async () => ({ backlog: 'irrelevant' }),
    applyMutation: () => {
      mutationCalls += 1;
    },
    pushState: () => {
      pushCalls += 1;
    },
  });

  assert.equal(applied, false);
  assert.equal(mutationCalls, 0);
  assert.equal(pushCalls, 0);
});
