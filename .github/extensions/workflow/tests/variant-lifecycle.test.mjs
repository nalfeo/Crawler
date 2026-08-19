/**
 * Unit tests for the per-VARIANT lifecycle classifier
 * (`unaccepted`|`accepted-staged`|`integrated`|`unverified`). Covers the plan
 * review's core concern: lifecycle must be derived from an EXACT
 * {briefId, runId, variantIndex} manifest match, never from "this run is
 * promoted" alone, and must degrade to the explicit `unverified` (never a
 * guessed integrated/accepted) whenever provenance is incomplete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVariantLifecycle, findMatchingAsset } from '../lib/variant-lifecycle.mjs';

function report(assets) {
  return { planId: 'p1', title: 'Plan', assets };
}

test('unaccepted: no manifest match and no in-session acceptance', () => {
  const result = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.deepEqual(result, { state: 'unaccepted', detail: null, manifestKey: null });
});

test('accepted-staged: no manifest match yet, but this session queued it', () => {
  const result = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: { state: 'queued' },
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'accepted-staged');
  assert.match(result.detail, /not yet reflected/);
});

test('unaccepted even with an acceptance entry that is still "accepting" (transient, not queued)', () => {
  const result = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: { state: 'accepting' },
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'unaccepted');
});

test('unaccepted even with an acceptance entry that errored (nothing was actually queued)', () => {
  const result = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: { state: 'error', message: 'boom' },
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'unaccepted');
});

test('integrated: manifest selects the exact variant AND the asset is runtime-integrated', () => {
  const reports = [
    report([
      {
        briefId: 'goblin',
        variantIndex: 2,
        sourceRun: 'goblin/run-1',
        approvedAssetExists: true,
        integrationState: 'integrated',
      },
    ]),
  ];
  const result = computeVariantLifecycle({
    backlogReports: reports,
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 2,
  });
  assert.deepEqual(result, { state: 'integrated', detail: null, manifestKey: null });
});

test('never infers from "this run is promoted" alone: a DIFFERENT variant of the same run is unaccepted', () => {
  const reports = [
    report([
      {
        briefId: 'goblin',
        variantIndex: 2, // variant #2 won, not #0
        sourceRun: 'goblin/run-1',
        approvedAssetExists: true,
        integrationState: 'integrated',
      },
    ]),
  ];
  const result = computeVariantLifecycle({
    backlogReports: reports,
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0, // asking about variant #0, which did NOT win
  });
  assert.equal(result.state, 'unaccepted');
});

test('accepted-staged: manifest selects the exact variant but integration is missing or not-applicable', () => {
  const missing = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'goblin',
          variantIndex: 0,
          sourceRun: 'goblin/run-1',
          approvedAssetExists: true,
          integrationState: 'missing',
        },
      ]),
    ],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(missing.state, 'accepted-staged');

  const notApplicable = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'goblin',
          variantIndex: 0,
          sourceRun: 'goblin/run-1',
          approvedAssetExists: true,
          integrationState: 'not-applicable',
        },
      ]),
    ],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(notApplicable.state, 'accepted-staged');
});

test('unverified: matched but the approved asset file is missing on disk', () => {
  const result = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'goblin',
          variantIndex: 0,
          sourceRun: 'goblin/run-1',
          approvedAssetExists: false,
          integrationState: 'integrated',
        },
      ]),
    ],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'unverified');
  assert.match(result.detail, /missing on disk/);
});

test('unverified: matched but the sprite/item registry could not be resolved', () => {
  const result = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'goblin',
          variantIndex: 0,
          sourceRun: 'goblin/run-1',
          approvedAssetExists: true,
          integrationState: 'unverified',
        },
      ]),
    ],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'unverified');
  assert.match(result.detail, /registry could not be loaded/);
});

test('findMatchingAsset matches Windows-style backslash sourceRun paths', () => {
  const asset = findMatchingAsset(
    [report([{ briefId: 'goblin', variantIndex: 0, sourceRun: 'goblin\\run-1' }])],
    'goblin',
    'run-1',
    0,
  );
  assert.ok(asset);
});

test('accepted-staged: manifest-approved variant with NO corresponding art-plan asset falls back to manifestApprovals', () => {
  // Real-repo regression: a manifest entry can exist for a briefId that no
  // art plan references at all (e.g. an ad-hoc accepted variant) — the
  // plan-scoped backlogReports will NEVER contain an asset for it, so without
  // this fallback the variant would show "unaccepted" despite plainly having
  // a manifest entry.
  const result = computeVariantLifecycle({
    backlogReports: [], // no plan references this briefId at all
    manifestApprovals: [
      {
        briefId: 'iron-cleaver',
        assetPath: 'generated/iron-cleaver-var-0.png',
        sourceRun: 'iron-cleaver/2026-07-18T03-40-12-d4269ad7',
        variantIndex: 0,
        exists: true,
      },
    ],
    acceptanceEntry: null,
    briefId: 'iron-cleaver',
    runId: '2026-07-18T03-40-12-d4269ad7',
    variantIndex: 0,
  });
  assert.equal(result.state, 'accepted-staged');
  assert.match(result.detail, /no art-plan asset/);
});

test('unverified: manifest-approved (plan-less) variant whose file is missing on disk', () => {
  const result = computeVariantLifecycle({
    backlogReports: [],
    manifestApprovals: [
      {
        briefId: 'iron-cleaver',
        assetPath: 'generated/iron-cleaver-var-5.png',
        sourceRun: 'iron-cleaver/2026-07-18T03-40-12-d4269ad7',
        variantIndex: 5,
        exists: false,
      },
    ],
    acceptanceEntry: null,
    briefId: 'iron-cleaver',
    runId: '2026-07-18T03-40-12-d4269ad7',
    variantIndex: 5,
  });
  assert.equal(result.state, 'unverified');
});

test('a plan-asset match takes priority over the manifestApprovals fallback', () => {
  const result = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'goblin',
          variantIndex: 0,
          sourceRun: 'goblin/run-1',
          approvedAssetExists: true,
          integrationState: 'integrated',
        },
      ]),
    ],
    manifestApprovals: [
      {
        briefId: 'goblin',
        assetPath: 'generated/goblin.png',
        sourceRun: 'goblin/run-1',
        variantIndex: 0,
        exists: true,
      },
    ],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(result.state, 'integrated');
});

test('findMatchingAsset returns null when no report/asset matches', () => {
  assert.equal(findMatchingAsset([], 'goblin', 'run-1', 0), null);
  assert.equal(
    findMatchingAsset(
      [report([{ briefId: 'rat', variantIndex: 0, sourceRun: 'rat/run-1' }])],
      'goblin',
      'run-1',
      0,
    ),
    null,
  );
});

test('computeVariantLifecycle returns manifestKey from manifestApprovals.mapKey for canonicalized item briefs', () => {
  // Regression fixture: approveVariant strips '-vN' from item briefs, so a run
  // named 'flame-dagger-v2' produces manifest key 'flame-dagger-var-1', not
  // 'flame-dagger-v2-var-1'. The lifecycle must carry the exact manifest key so
  // the renderer can unapprove without reconstructing from the (wrong) run briefId.
  const result = computeVariantLifecycle({
    backlogReports: [],
    manifestApprovals: [
      {
        mapKey: 'flame-dagger-var-1',
        briefId: 'flame-dagger',
        assetPath: 'generated/flame-dagger-var-1.png',
        sourceRun: 'flame-dagger-v2/run-1',
        variantIndex: 1,
        exists: true,
      },
    ],
    acceptanceEntry: null,
    briefId: 'flame-dagger-v2',
    runId: 'run-1',
    variantIndex: 1,
  });
  assert.equal(result.state, 'accepted-staged');
  assert.equal(result.manifestKey, 'flame-dagger-var-1');
});

test('computeVariantLifecycle derives manifestKey from assetPath when matched via backlog reports', () => {
  const result = computeVariantLifecycle({
    backlogReports: [
      report([
        {
          briefId: 'flame-dagger',
          variantIndex: 1,
          assetPath: 'generated/flame-dagger-var-1.png',
          sourceRun: 'flame-dagger-v2/run-1',
          approvedAssetExists: true,
          integrationState: 'integrated',
        },
      ]),
    ],
    acceptanceEntry: null,
    briefId: 'flame-dagger-v2',
    runId: 'run-1',
    variantIndex: 1,
  });
  assert.equal(result.state, 'integrated');
  assert.equal(result.manifestKey, 'flame-dagger-var-1');
});

test('computeVariantLifecycle returns manifestKey null when no manifest match (queued-only or unaccepted)', () => {
  const queued = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: { state: 'queued' },
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(queued.manifestKey, null);

  const unaccepted = computeVariantLifecycle({
    backlogReports: [],
    acceptanceEntry: null,
    briefId: 'goblin',
    runId: 'run-1',
    variantIndex: 0,
  });
  assert.equal(unaccepted.manifestKey, null);
});
