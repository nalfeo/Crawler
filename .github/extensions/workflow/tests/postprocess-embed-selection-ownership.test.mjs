/**
 * Behavioral test for the versioned-selection OWNERSHIP guard that
 * `buildPostprocessState` (extension.mjs) uses to protect
 * `entry.postprocess.selected` from a stale, late-resolving build clobbering
 * a newer selection.
 *
 * `extension.mjs` cannot be imported directly here (top-level `joinSession()`
 * SDK side effect — see `extension-security-guards.test.mjs`'s header), so
 * this test reproduces the EXACT guard shape
 * (`const versionAtCall = pp.selectionVersion; ...await...; if
 * (pp.selectionVersion === versionAtCall) { pp.selected = ...; }`) against a
 * fake entry + a controllable-delay fake sidecar fetch, and proves the race
 * it exists to prevent. `postprocess-embed-guards.test.mjs`'s
 * "buildPostprocessState captures a version BEFORE awaiting…" test is the
 * source-text guard that the REAL function still contains this exact shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal reproduction of buildPostprocessState's ownership-guarded commit.
 * `fetchSelected(target)` stands in for the chain of sidecar awaits
 * (probeHealth/listRuns/fetchRunSummary/fetchSheets/fetchSliceMap) that sit
 * between capturing `versionAtCall` and committing `pp.selected`.
 */
async function buildAndMaybeCommit(pp, target, fetchSelected) {
  const versionAtCall = pp.selectionVersion;
  const resolved = await fetchSelected(target);
  if (pp.selectionVersion === versionAtCall) {
    pp.selected = resolved;
  }
  return resolved;
}

function makePp(initial) {
  return { selected: initial, selectionVersion: 0 };
}

test('a slower build for an OLDER selection does not clobber a newer selection that already committed', async () => {
  const pp = makePp(null);

  // Build A starts for "run-A" with a slow fetch...
  const buildA = buildAndMaybeCommit(pp, 'run-A', async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { briefId: 'brief', runId: target };
  });

  // ...then, before A resolves, a real user action selects "run-B" — this is
  // exactly what /postprocess/api/select and a persist success do: bump
  // selectionVersion FIRST, then kick off (and await) a FRESH build.
  pp.selectionVersion += 1;
  const resultB = await buildAndMaybeCommit(pp, 'run-B', async (target) => ({
    briefId: 'brief',
    runId: target,
  }));
  assert.equal(pp.selected.runId, 'run-B', 'the newer, faster build commits immediately');

  // Now A's slow fetch finally resolves. Its OWN return value is still
  // correct (the caller — e.g. the HTTP response awaiting buildA — gets a
  // valid view of run-A), but it must NOT overwrite pp.selected=run-B.
  const resultA = await buildA;
  assert.equal(resultA.runId, 'run-A', "the stale build's own resolved value is unaffected");
  assert.equal(
    pp.selected.runId,
    'run-B',
    'REGRESSION GUARD: the stale build must not clobber the newer selection',
  );
  assert.equal(resultB.runId, 'run-B');
});

test('with NO intervening selection change, the (only) build commits normally', async () => {
  const pp = makePp(null);
  const result = await buildAndMaybeCommit(pp, 'run-only', async (target) => ({
    briefId: 'brief',
    runId: target,
  }));
  assert.equal(pp.selected.runId, 'run-only');
  assert.equal(result.runId, 'run-only');
});

test('three overlapping builds: only the one matching the FINAL selectionVersion at its own start ever commits', async () => {
  const pp = makePp(null);
  const order = [];

  const b1 = buildAndMaybeCommit(pp, 'one', async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('one-resolved');
    return { runId: target };
  });
  pp.selectionVersion += 1;
  const b2 = buildAndMaybeCommit(pp, 'two', async (target) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push('two-resolved');
    return { runId: target };
  });
  pp.selectionVersion += 1;
  const b3 = buildAndMaybeCommit(pp, 'three', async (target) => {
    order.push('three-resolved');
    return { runId: target }; // resolves immediately (version 2, the current one)
  });

  await Promise.all([b1, b2, b3]);
  // "three" resolves first (no delay) while selectionVersion is already 2 —
  // it commits. "two" and "one" resolve later but were captured at STALE
  // versions (0 and 1) — by the time they check, selectionVersion is 2, so
  // neither commits, regardless of resolution order.
  assert.deepEqual(order, ['three-resolved', 'two-resolved', 'one-resolved']);
  assert.equal(
    pp.selected.runId,
    'three',
    'only the build whose version matched at commit time wins',
  );
});
