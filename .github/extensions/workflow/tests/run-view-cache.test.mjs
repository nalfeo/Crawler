/**
 * Deterministic tests for the cache-first / background-revalidate contract
 * (`resolveCacheFirstState`) that the Workflow canvas's `buildState()` relies
 * on to satisfy the "a previously-warmed run paints in under a second with no
 * blocking spinner" requirement.
 *
 * These tests never rely on wall-clock timing (no `setTimeout`/sleep
 * assertions). Instead they use manually-controlled ("deferred") promises to
 * prove, on the microtask level, that:
 *   - a cache HIT resolves WITHOUT ever awaiting the (possibly slow) live
 *     fetch — i.e. the function returns before the live fetch is even given a
 *     chance to settle, which is the actual mechanism behind "under a second";
 *   - a cache MISS is the only path that awaits the live fetch;
 *   - a background revalidation delivers fresh data via `onFresh` once it
 *     completes, but ONLY when the caller is still "current";
 *   - a stale/late completion (the caller has since moved to a different
 *     selection) never invokes `onFresh`, even though the cache itself is
 *     still updated with the fresh value;
 *   - concurrent requests for the same key never start a second overlapping
 *     live fetch while one is already in flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunViewCache, resolveCacheFirstState } from '../lib/run-view-cache.mjs';

/** A promise plus externally-callable resolve/reject — for deterministic control. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness({ current = true } = {}) {
  const cache = createRunViewCache();
  const revalidating = new Set();
  const freshCalls = [];
  const errors = [];
  let liveFetchCalls = 0;
  let currentFlag = current;

  return {
    cache,
    freshCalls,
    errors,
    getLiveFetchCalls: () => liveFetchCalls,
    setCurrent: (value) => {
      currentFlag = value;
    },
    run(key, liveFetch) {
      return resolveCacheFirstState({
        cache,
        key,
        liveFetch: () => {
          liveFetchCalls += 1;
          return liveFetch();
        },
        isCurrent: () => currentFlag,
        onFresh: (fresh) => {
          freshCalls.push(fresh);
        },
        onRevalidateError: (err) => errors.push(err),
        isRevalidating: () => revalidating.has(key),
        setRevalidating: (value) => {
          if (value) revalidating.add(key);
          else revalidating.delete(key);
        },
      });
    },
  };
}

test('cold miss: awaits liveFetch, returns stale:false, and populates the cache', async () => {
  const h = makeHarness();
  const result = await h.run('brief::run-1', async () => ({ candidates: ['a'] }));
  assert.equal(h.getLiveFetchCalls(), 1);
  assert.deepEqual(result, { candidates: ['a'], stale: false });
  assert.deepEqual(h.cache.get('brief::run-1'), { candidates: ['a'] });
});

test('warm hit: resolves with the cached snapshot WITHOUT awaiting a slow live fetch', async () => {
  const h = makeHarness();
  h.cache.set('brief::run-1', { candidates: ['seed'] });

  const slow = deferred(); // deliberately never resolved during this test
  const resultPromise = h.run('brief::run-1', () => slow.promise);

  // If resolveCacheFirstState() incorrectly awaited the live fetch, awaiting
  // resultPromise here would hang forever (the test would time out) because
  // `slow.promise` is never resolved. Racing against Promise.resolve() proves
  // the cache-first branch settles on an earlier microtask than any awaited
  // I/O ever could.
  const racer = Symbol('racer-still-pending');
  const winner = await Promise.race([resultPromise, Promise.resolve(racer)]);
  // Both resultPromise and Promise.resolve(racer) are already-settled/immediate
  // promises, so the RACE ORDER (not a timer) proves resultPromise did not
  // wait on `slow.promise`: assert it resolves to the cache-first shape, not
  // the sentinel, confirming it settled on its own without needing `slow`.
  assert.notEqual(winner, racer, 'resolveCacheFirstState must not still be pending');
  assert.deepEqual(winner, { candidates: ['seed'], stale: true });
  assert.equal(h.getLiveFetchCalls(), 1, 'a background revalidation was still scheduled');
});

test('background revalidation updates the cache and calls onFresh once it completes', async () => {
  const h = makeHarness();
  h.cache.set('brief::run-1', { candidates: ['seed'] });

  const slow = deferred();
  const result = await h.run('brief::run-1', () => slow.promise);
  assert.deepEqual(result, { candidates: ['seed'], stale: true });
  assert.equal(h.freshCalls.length, 0, 'onFresh must not fire before liveFetch resolves');

  slow.resolve({ candidates: ['fresh'] });
  // Let the fire-and-forget chain's microtasks (.then/.finally) run.
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(h.cache.get('brief::run-1'), { candidates: ['fresh'] });
  assert.deepEqual(h.freshCalls, [{ candidates: ['fresh'] }]);
});

test('a stale (late) completion updates the cache but never calls onFresh', async () => {
  const h = makeHarness();
  h.cache.set('brief::run-1', { candidates: ['seed'] });

  const slow = deferred();
  await h.run('brief::run-1', () => slow.promise);

  // Simulate the caller having moved on to a different selection while the
  // background revalidation was still in flight.
  h.setCurrent(false);
  slow.resolve({ candidates: ['fresh-but-stale'] });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    h.cache.get('brief::run-1'),
    { candidates: ['fresh-but-stale'] },
    'the cache itself is still updated so a LATER same-key request sees fresh data',
  );
  assert.equal(h.freshCalls.length, 0, 'onFresh must never fire for a superseded selection');
});

test('an invalidated background completion cannot overwrite a newer persisted-run snapshot', async () => {
  const cache = createRunViewCache();
  cache.set('brief::run-1', { candidates: ['seed'] });
  const slow = deferred();
  let epoch = 0;

  await resolveCacheFirstState({
    cache,
    key: 'brief::run-1',
    liveFetch: () => slow.promise,
    isCurrent: () => false,
    onFresh: () => {},
    isRevalidating: () => false,
    setRevalidating: () => {},
    canWrite: () => epoch === 0,
  });

  epoch += 1;
  cache.set('brief::run-1', { candidates: ['persisted-refresh'] });
  slow.resolve({ candidates: ['pre-persist-revalidation'] });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(cache.get('brief::run-1'), { candidates: ['persisted-refresh'] });
});

test('a failed background revalidation is reported and never crashes the caller', async () => {
  const h = makeHarness();
  h.cache.set('brief::run-1', { candidates: ['seed'] });

  const slow = deferred();
  await h.run('brief::run-1', () => slow.promise);
  slow.reject(new Error('sidecar unreachable'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /sidecar unreachable/);
  assert.equal(h.freshCalls.length, 0);
});

test('concurrent requests for the same key never start a second overlapping live fetch', async () => {
  const h = makeHarness();
  h.cache.set('brief::run-1', { candidates: ['seed'] });

  const slow = deferred();
  const first = await h.run('brief::run-1', () => slow.promise);
  const second = await h.run('brief::run-1', () => slow.promise);

  assert.deepEqual(first, { candidates: ['seed'], stale: true });
  assert.deepEqual(second, { candidates: ['seed'], stale: true });
  assert.equal(h.getLiveFetchCalls(), 1, 'only the FIRST call should have started a live fetch');

  slow.resolve({ candidates: ['fresh'] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.freshCalls.length, 1);
});

test('a null/undefined key (unresolvable target) always goes live and is never cached', async () => {
  const h = makeHarness();
  const result = await h.run(null, async () => ({ candidates: [] }));
  assert.deepEqual(result, { candidates: [], stale: false });
  assert.equal(h.getLiveFetchCalls(), 1);
});

test('deriveWriteKey lets a resolved-but-different run write under its OWN key, never corrupting the guessed read key', async () => {
  const cache = createRunViewCache();
  // Seed a "last viewed" guess under brief-a::run-1 — simulating a bare open
  // with no explicit target that falls back to "whatever was last viewed".
  cache.set('brief-a::run-1', { selected: { briefId: 'brief-a', runId: 'run-1' } });

  let liveFetchCalls = 0;
  const result = await resolveCacheFirstState({
    cache,
    key: 'brief-a::run-1',
    liveFetch: () => {
      liveFetchCalls += 1;
      // The live fetch (no explicit target) resolves to a DIFFERENT run than
      // the guessed key — e.g. "auto-select latest" picked something else.
      return Promise.resolve({ selected: { briefId: 'brief-b', runId: 'run-9' } });
    },
    isCurrent: () => true,
    onFresh: () => {},
    isRevalidating: () => false,
    setRevalidating: () => {},
    deriveWriteKey: (fresh) => `${fresh.selected.briefId}::${fresh.selected.runId}`,
  });

  // The cache-first response still replays the GUESSED key's stale snapshot.
  assert.deepEqual(result, {
    selected: { briefId: 'brief-a', runId: 'run-1' },
    stale: true,
  });

  await Promise.resolve();
  await Promise.resolve();

  // The fresh result is written under ITS OWN resolved key...
  assert.deepEqual(cache.get('brief-b::run-9'), {
    selected: { briefId: 'brief-b', runId: 'run-9' },
  });
  // ...and the originally-guessed key's entry is left untouched (not
  // overwritten with brief-b/run-9's data).
  assert.deepEqual(cache.get('brief-a::run-1'), {
    selected: { briefId: 'brief-a', runId: 'run-1' },
  });
  assert.equal(liveFetchCalls, 1);
});

// ---------------------------------------------------------------------------
// The following tests mirror extension.mjs's `buildState()` key-derivation
// formulas EXACTLY (byte-for-byte logic, not just the generic cache module in
// isolation) — `extension.mjs` cannot be imported directly in a unit test (it
// performs a top-level `joinSession()` SDK side effect on import; see
// tests/feedback-route-http.test.mjs's header comment for the same
// constraint). `simulateBuildState` below is the same "GUESS key ?? lastRunKey,
// bypass on explicit sheet, always reseed lastRunKey from the RESOLVED key"
// formula as `buildState()` — a regression here is a regression there.
// ---------------------------------------------------------------------------

function runViewKey(briefId, runId) {
  return briefId && runId ? `${briefId}::${runId}` : null;
}

/**
 * A minimal stand-in for one `buildState(instanceId, { explicitSheet })` call,
 * reproducing the exact key/lastRunKey formulas from extension.mjs so the
 * fixes for findings #1 (stale sheet replay) and #2 (lastRunKey never seeded
 * on cold bootstrap) are provable without spinning up the whole canvas.
 */
async function simulateBuildState(session, { explicitSheet = null } = {}) {
  const requested = session.requested;
  const priorSelected = session.selected;
  const targetBriefId = requested.briefId ?? priorSelected?.briefId ?? null;
  const targetRunId = requested.runId ?? priorSelected?.runId ?? null;
  const naturalKey = runViewKey(targetBriefId, targetRunId) ?? session.lastRunKey;
  const key = explicitSheet ? null : naturalKey;

  const view = await resolveCacheFirstState({
    cache: session.cache,
    key,
    liveFetch: session.liveFetch,
    isCurrent: () => true,
    onFresh: () => {},
    isRevalidating: () => (key ? session.revalidatingKeys.has(key) : false),
    setRevalidating: (value) => {
      if (!key) return;
      if (value) session.revalidatingKeys.add(key);
      else session.revalidatingKeys.delete(key);
    },
    deriveWriteKey: (fresh) =>
      runViewKey(fresh.selected?.briefId ?? null, fresh.selected?.runId ?? null),
  });

  const resolvedKey =
    runViewKey(view.selected?.briefId ?? null, view.selected?.runId ?? null) ?? naturalKey;
  if (resolvedKey) session.lastRunKey = resolvedKey;
  session.selected = view.selected ?? null;
  return view;
}

function makeSession({
  requested = { briefId: null, runId: null },
  selected = null,
  lastRunKey = null,
} = {}) {
  return {
    cache: createRunViewCache(),
    requested,
    selected,
    lastRunKey,
    revalidatingKeys: new Set(),
    liveFetch: async () => {
      throw new Error('liveFetch not stubbed for this call');
    },
  };
}

test('finding #1 — an explicit same-run sheet change ALWAYS honors the requested sheet, never a stale cached one', async () => {
  const session = makeSession({ requested: { briefId: 'goblin', runId: 'run-1' } });

  // First call (no explicit sheet): resolves + caches sheet "walk.png".
  session.liveFetch = async () => ({
    selected: { briefId: 'goblin', runId: 'run-1', sheet: 'walk.png' },
    sheets: ['walk.png', 'idle.png'],
  });
  const first = await simulateBuildState(session);
  assert.equal(first.selected.sheet, 'walk.png');
  assert.equal(session.cache.get('goblin::run-1').selected.sheet, 'walk.png');

  // Second call: the user explicitly picks a DIFFERENT sheet on the SAME run
  // (renderer.mjs's sheetPicker sends `select(sel.briefId, sel.runId,
  // sheetPicker.value)` — briefId/runId unchanged, sheet explicit). Simulate
  // /api/select re-setting entry.selected.sheet to the request BEFORE
  // buildState runs, exactly like the real route handler.
  session.requested = { briefId: 'goblin', runId: 'run-1' };
  session.selected = { briefId: 'goblin', runId: 'run-1', sheet: 'idle.png' };
  session.liveFetch = async () => ({
    selected: { briefId: 'goblin', runId: 'run-1', sheet: 'idle.png' },
    sheets: ['walk.png', 'idle.png'],
  });
  const second = await simulateBuildState(session, { explicitSheet: 'idle.png' });

  // Without the fix, this would resolve from cache (stale:true) and reflect
  // "walk.png" — the OLD sheet — even though "idle.png" was explicitly
  // requested. The fix forces the live path for an explicit sheet request.
  assert.equal(
    second.stale,
    false,
    'an explicit sheet change must never replay the cache-first snapshot',
  );
  assert.equal(second.selected.sheet, 'idle.png', 'the requested sheet must always be honored');
  assert.equal(
    session.cache.get('goblin::run-1').selected.sheet,
    'idle.png',
    'the shared cache must be overlaid with the corrected sheet for later cache-first reads',
  );
});

test('finding #1 — an explicit sheet change is never suppressed by an in-flight revalidation for the same run key', async () => {
  const session = makeSession({ requested: { briefId: 'goblin', runId: 'run-1' } });
  session.liveFetch = async () => ({
    selected: { briefId: 'goblin', runId: 'run-1', sheet: 'walk.png' },
    sheets: ['walk.png', 'idle.png'],
  });
  await simulateBuildState(session);

  // Simulate a background revalidation already in flight for this run's key
  // (e.g. from a prior cache-first serve) — if the explicit-sheet path used
  // the SAME key, `resolveCacheFirstState` would treat this as "already
  // revalidating" and skip starting a fresh fetch for the new sheet entirely.
  session.revalidatingKeys.add('goblin::run-1');

  session.selected = { briefId: 'goblin', runId: 'run-1', sheet: 'idle.png' };
  let explicitFetchCalls = 0;
  session.liveFetch = async () => {
    explicitFetchCalls += 1;
    return {
      selected: { briefId: 'goblin', runId: 'run-1', sheet: 'idle.png' },
      sheets: ['walk.png', 'idle.png'],
    };
  };
  const result = await simulateBuildState(session, { explicitSheet: 'idle.png' });

  assert.equal(
    explicitFetchCalls,
    1,
    'the explicit sheet request must always trigger its own live fetch',
  );
  assert.equal(result.selected.sheet, 'idle.png');
});

test('finding #2 — a cold, no-input bootstrap seeds lastRunKey so the very next bare open paints cache-first with no AWAITED live fetch', async () => {
  const session = makeSession(); // nothing requested/selected yet; lastRunKey starts null

  let liveFetchCalls = 0;
  session.liveFetch = async () => {
    liveFetchCalls += 1;
    // "auto-select latest" resolves to SOME run even though nothing was
    // explicitly requested.
    return {
      selected: { briefId: 'goblin', runId: 'run-9', sheet: 'walk.png' },
      sheets: ['walk.png'],
    };
  };

  const first = await simulateBuildState(session);
  assert.equal(
    liveFetchCalls,
    1,
    'the first-ever bootstrap has nothing cached, so it must go live',
  );
  assert.equal(first.stale, false);
  assert.equal(
    session.lastRunKey,
    'goblin::run-9',
    'lastRunKey must be seeded from the RESOLVED run, not the (null) natural key',
  );

  // A brand-new "bare open" instance: nothing requested/selected either, but
  // module-scope lastRunKey (simulated here via the same `session.lastRunKey`
  // a real second instance would read) is now seeded. Its liveFetch resolves
  // to DIFFERENT data than what is cached — if the second call incorrectly
  // went live for its immediate response (i.e. lastRunKey was NOT reseeded,
  // per the pre-fix bug, forcing a cold miss), the returned selection would
  // reflect THIS stub's run instead of the cached one.
  session.requested = { briefId: null, runId: null };
  session.selected = null;
  session.liveFetch = async () => {
    liveFetchCalls += 1;
    return {
      selected: { briefId: 'someone-else', runId: 'run-unrelated', sheet: 'x.png' },
      sheets: ['x.png'],
    };
  };

  const second = await simulateBuildState(session);
  assert.equal(second.stale, true, 'the second bare open must be a cache-first (stale) hit');
  assert.equal(
    second.selected.briefId,
    'goblin',
    'a cache HIT must reflect the cached run, not whatever the (unawaited) background fetch resolves to',
  );
  assert.equal(second.selected.runId, 'run-9');
  // A background revalidation is still scheduled (fire-and-forget) — that is
  // expected/correct cache-first behavior.
  assert.equal(liveFetchCalls, 2);
});
