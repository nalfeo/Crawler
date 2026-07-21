/**
 * Source-wiring regression guards for three `buildState()`/action-path
 * freshness findings. Intentionally SOURCE-TEXT assertions (not a live
 * import) — `extension.mjs` performs a top-level `joinSession()` side effect
 * on import, so it cannot be safely `import`-ed in a plain unit test (see
 * `extension-security-guards.test.mjs`).
 *
 * 1. A background run-view revalidation's `onFresh` callback must recompute
 *    the CURRENT static state (`getStatic(entry)`) right before pushing,
 *    never reuse the `stat` snapshot captured when the (possibly long-lived,
 *    cache-first) `buildState()` call started. `isCurrent()` only tracks
 *    `selectionVersion`, which `acceptAndQueue()` does not bump — so a
 *    revalidation started BEFORE an accept but completing AFTER it would
 *    still be "current" and, with the old `stat` closure, would silently
 *    clobber the just-rebuilt post-accept backlog/promotedRunIds/
 *    manifestApprovals (and therefore per-variant lifecycle) with the
 *    pre-accept snapshot.
 * 2. The `select_run` action must thread `sheet` into `buildState()` as
 *    `explicitSheet`, exactly like the HTTP `/api/select` route, so an
 *    explicit same-run sheet selection via the action path cannot replay an
 *    unrelated cached sheet/slice-map.
 * 3. That same `onFresh` callback must re-check currentness AFTER the
 *    `getStatic(entry)` re-read (via `applyFreshRevalidation`, see
 *    `lib/run-view-cache.mjs` and `tests/apply-fresh-revalidation.test.mjs`
 *    for the deterministic behavior-level proof), never mutate
 *    `entry.selected` / push unconditionally once the async re-read
 *    completes — a selection change DURING that await must be a no-op.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '..', 'extension.mjs');

function readSource() {
  return readFileSync(EXTENSION_PATH, 'utf8');
}

test('REGRESSION: a background run-view revalidation delegates to applyFreshRevalidation, which recomputes CURRENT static state before mutating/pushing, never the stale pre-mutation `stat` snapshot, and never mutates/pushes unconditionally', () => {
  const source = readSource();

  // The onFresh callback must delegate to the dependency-injected
  // applyFreshRevalidation helper (lib/run-view-cache.mjs), not inline its
  // own unconditional getStatic-then-push sequence.
  const onFreshStart = source.indexOf('onFresh: async (fresh) =>');
  assert.ok(onFreshStart >= 0, 'buildState must wire an onFresh callback');
  const onFreshEnd = source.indexOf('onRevalidateError:', onFreshStart);
  assert.ok(onFreshEnd > onFreshStart, 'onRevalidateError must follow onFresh');
  const onFreshBody = source.slice(onFreshStart, onFreshEnd);

  assert.match(
    onFreshBody,
    /applyFreshRevalidation\(\{/,
    'onFresh must delegate to applyFreshRevalidation, which re-checks currentness AFTER the async getStatic() re-read',
  );
  // Must re-read the static half via getStatic(entry)...
  assert.match(onFreshBody, /getStatic: \(\) => getStatic\(entry\)/);
  // ...and compose/push with THAT fresh read (currentStat), not the outer
  // `stat` variable captured when buildState() started.
  assert.match(onFreshBody, /composeState\(entry, currentStat, fresh\)/);
  assert.doesNotMatch(
    onFreshBody,
    /composeState\(entry, stat, fresh\)/,
    'onFresh must not push using the stale closed-over `stat` snapshot',
  );
  // The pre-fix pattern mutated entry.selected unconditionally-guarded-only-
  // BEFORE the async re-read, then pushed with no re-check at all afterward.
  // That inline pattern must be gone in favor of the delegated helper.
  assert.doesNotMatch(
    source,
    /if \(entry\.selectionVersion === versionAtCall\) entry\.selected = fresh\.selected \?\? null;/,
    'entry.selected must not be mutated unconditionally before the getStatic() re-read with no re-check after it',
  );

  // The helper itself (lib/run-view-cache.mjs) must be imported.
  assert.match(source, /applyFreshRevalidation/);
});

test('REGRESSION: applyFreshRevalidation (lib/run-view-cache.mjs) re-checks isCurrent() AFTER the async getStatic() re-read and before either applyMutation or pushState', () => {
  const libPath = path.join(HERE, '..', 'lib', 'run-view-cache.mjs');
  const libSource = readFileSync(libPath, 'utf8');

  const fnStart = libSource.indexOf('export async function applyFreshRevalidation(');
  assert.ok(fnStart >= 0, 'applyFreshRevalidation must be exported from lib/run-view-cache.mjs');
  const fnEnd = libSource.indexOf('\n}', fnStart);
  assert.ok(fnEnd > fnStart);
  const fnBody = libSource.slice(fnStart, fnEnd);

  const getStaticIdx = fnBody.indexOf('await getStatic()');
  assert.ok(getStaticIdx >= 0, 'must await the caller-supplied getStatic()');
  const isCurrentIdx = fnBody.indexOf('isCurrent()', getStaticIdx);
  assert.ok(
    isCurrentIdx > getStaticIdx,
    'isCurrent() must be re-checked AFTER the getStatic() await',
  );
  const applyMutationIdx = fnBody.indexOf('applyMutation(');
  const pushStateIdx = fnBody.indexOf('pushState(');
  assert.ok(
    applyMutationIdx > isCurrentIdx,
    'applyMutation must run AFTER the post-await currentness re-check',
  );
  assert.ok(
    pushStateIdx > isCurrentIdx,
    'pushState must run AFTER the post-await currentness re-check',
  );
});

test('REGRESSION: the select_run action threads `sheet` into buildState() as explicitSheet, matching the HTTP /api/select route', () => {
  const source = readSource();
  const selectRunStart = source.indexOf("name: 'select_run',");
  assert.ok(selectRunStart >= 0, 'the select_run action must exist');
  const acceptVariantStart = source.indexOf("name: 'accept_variant',", selectRunStart);
  assert.ok(acceptVariantStart > selectRunStart, 'accept_variant must follow select_run');
  const selectRunBody = source.slice(selectRunStart, acceptVariantStart);

  assert.match(
    selectRunBody,
    /buildState\(ctx\.instanceId, \{ explicitSheet: sheet \|\| null \}\)/,
    'select_run must call buildState with explicitSheet, exactly like /api/select',
  );
  assert.doesNotMatch(
    selectRunBody,
    /const state = await buildState\(ctx\.instanceId\);/,
    'select_run must not call buildState() without explicitSheet — that can replay an unrelated cached sheet',
  );

  // Cross-check against the HTTP route's own wiring so the two paths cannot
  // silently drift apart again.
  const selectRouteStart = source.indexOf("path: '/api/select',");
  assert.ok(selectRouteStart >= 0, 'the /api/select route must exist');
  const feedbackRouteStart = source.indexOf("path: '/api/feedback'", selectRouteStart);
  assert.ok(feedbackRouteStart > selectRouteStart, '/api/feedback must follow /api/select');
  const selectRouteBody = source.slice(selectRouteStart, feedbackRouteStart);
  assert.match(selectRouteBody, /buildState\(instanceId, \{ explicitSheet: sheet \|\| null \}\)/);
});
