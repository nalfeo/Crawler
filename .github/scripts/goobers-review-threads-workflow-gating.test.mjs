import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Phase 3, Lane A workflow-level properties for goobers-review-threads.yml.
// These live in YAML, not in the pure decision script, so nothing else in the
// test suite can catch a regression here.

const workflows = path.resolve(fileURLToPath(new URL('../workflows', import.meta.url)));
const reviewThreads = readFileSync(path.join(workflows, 'goobers-review-threads.yml'), 'utf8');

test('goobers-review-threads.yml only mutates when the lane is explicitly migrated', () => {
  // Fail-closed for THIS workflow: it is the Goobers-side writer, so unlike a
  // legacy lane (which fails operational and keeps writing), an unset or
  // malformed selector must leave it a no-op -- only the literal 'goobers'
  // arms it. This is the inverse of, and never in conflict with, legacy's own
  // fail-operational gate in reconcile.mjs (legacyReviewThreadWritesEnabled).
  assert.match(reviewThreads, /LIFECYCLE_OWNER_REVIEW_THREADS.*!==\s*'goobers'/);
  assert.match(reviewThreads, /observe-only no-op/);
  assert.match(reviewThreads, /core\.setOutput\('skip', 'true'\)/);
});

test('goobers-review-threads.yml never touches merge-train admission/promotion', () => {
  assert.doesNotMatch(reviewThreads, /LIFECYCLE_OWNER_MERGE_TRAIN/);
  assert.doesNotMatch(reviewThreads, /resolveAdmissionChecks/);
  assert.doesNotMatch(reviewThreads, /merge-train\.yml/);
});

test('goobers-review-threads.yml is scoped per-PR and never drops a queued dispatch', () => {
  assert.match(reviewThreads, /group: crawler-review-threads-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(reviewThreads, /cancel-in-progress: false/);
  assert.match(reviewThreads, /queue: max/);
});

test('goobers-review-threads.yml pins the same Goobers release used by the lifecycle-owner workflow', () => {
  const lifecycleOwner = readFileSync(path.join(workflows, 'goobers-lifecycle-owner.yml'), 'utf8');
  const version = lifecycleOwner.match(/GOOBERS_VERSION:\s*(\S+)/)?.[1];
  const sha256 = lifecycleOwner.match(/GOOBERS_SHA256:\s*(\S+)/)?.[1];
  assert.ok(
    version && sha256,
    'expected goobers-lifecycle-owner.yml to declare pinned Goobers values',
  );
  assert.match(reviewThreads, new RegExp(`GOOBERS_VERSION:\\s*${version}\\b`));
  assert.match(reviewThreads, new RegExp(`GOOBERS_SHA256:\\s*${sha256}\\b`));
});

test('goobers-review-threads.yml re-validates state immediately before every mutating write', () => {
  assert.match(reviewThreads, /Re-fetch both the head SHA and the thread state immediately/);
  assert.match(reviewThreads, /reason=head-changed/);
  assert.match(reviewThreads, /reason=already-resolved-or-missing/);
  assert.match(reviewThreads, /reason=marker-already-present/);
  assert.match(reviewThreads, /decision\.requiresPostedMarker/);
  assert.match(reviewThreads, /reviewAfterPostedMarkers \?\?= await currentThreads\(\)/);
  assert.match(reviewThreads, /reason=paired-marker-not-posted/);
  assert.match(
    reviewThreads,
    /state_\.shouldResolveThread\(thread, headNow, emptyReachableCommitShas\)/,
  );
  assert.match(reviewThreads, /posted-marker-not-yet-visible/);
});

test('goobers-review-threads.yml requests least-privilege permissions', () => {
  const permissionsBlock = reviewThreads.slice(
    reviewThreads.indexOf('\npermissions:'),
    reviewThreads.indexOf('\njobs:'),
  );
  assert.match(permissionsBlock, /actions: read/);
  assert.match(permissionsBlock, /contents: read/);
  assert.match(permissionsBlock, /pull-requests: write/);
  assert.doesNotMatch(permissionsBlock, /issues: write/);
});
