import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Workflow-level regressions for ADR 0077 (main-health demoted from a merge-train
// promotion gate to a failure-attribution signal). These properties live in YAML,
// not in the reconcile scripts, so nothing else can catch them.

const workflows = path.resolve(fileURLToPath(new URL('../../workflows', import.meta.url)));
const read = (name) => readFileSync(path.join(workflows, name), 'utf8');

const ci = read('ci.yml');
const incidents = read('ci-recovery-incidents.yml');
const mergeTrain = read('merge-train.yml');
const ciRecovery = read('ci-recovery.yml');
const autoRebase = read('auto-rebase-prs.yml');
const ciRecoveryRouter = read('ci-recovery-router.yml');
const goobersLifecycleOwner = read('goobers-lifecycle-owner.yml');

test('ci.yml runs the full-CI backstop daily, not hourly', () => {
  const crons = [...ci.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(crons, ['0 6 * * *']);
});

test('ci.yml keeps the scheduled run as the unconditionally-full backstop', () => {
  // The scheduled run's value is forcing every scope flag off so a
  // detect-art-only.sh misclassification cannot skip a gate. Deleting the cron
  // (rather than stretching it) would remove the only such run in the system.
  assert.match(ci, /schedule/);
  for (const flag of ['art_only', 'docs_only', 'gameplay_safe', 'sprites_only']) {
    assert.match(
      ci,
      new RegExp(`${flag}=false`),
      `scheduled run must force ${flag}=false to stay unconditionally full`,
    );
  }
});

test('ci.yml no longer gates the changes job on MERGE_TRAIN_ENABLED', () => {
  // The backstop role is independent of the train. Gating it meant a rollback
  // (train disabled) also silently disabled the only full CI run.
  const changesJob = ci.slice(ci.indexOf('\n  changes:'), ci.indexOf('\n    outputs:'));
  assert.doesNotMatch(changesJob, /MERGE_TRAIN_ENABLED/);
  assert.doesNotMatch(changesJob, /if:/);
});

test('ci.yml grounds the train-promoted push skip in the landed-tree proof', () => {
  // The skip is correct because landedCommitProofError proves the landed tree is
  // byte-identical to the validated candidate prefix tree -- NOT because heavy CI
  // is deferred to a scheduled run that no longer arrives hourly.
  assert.match(ci, /byte-identical to the validated candidate/);
  assert.doesNotMatch(ci, /deferred to the hourly health run/);
  assert.doesNotMatch(ci, /Hourly health run disabled with the merge train/);
});

test('ci-recovery-incidents.yml routes scheduled CI regardless of MERGE_TRAIN_ENABLED', () => {
  // Once ci.yml's schedule gate is gone a scheduled run is real work, so a failed
  // daily backstop must raise an incident even during a train rollback -- exactly
  // when it is the only full run left.
  const routeIncident = incidents
    .slice(
      incidents.indexOf('\n  route-incident:'),
      incidents.indexOf('runs-on:', incidents.indexOf('\n  route-incident:')),
    )
    .replace(/^\s*#.*$/gm, '');
  assert.match(routeIncident, /github\.event\.workflow_run\.event != 'pull_request'/);
  assert.doesNotMatch(routeIncident, /MERGE_TRAIN_ENABLED/);
});

test('each legacy lane is gated on its own owner, never the claim selector', () => {
  // The no-downtime contract: selecting Goobers for the pre-PR implementation
  // claim must not turn any unmigrated PR-lifecycle lane observe-only.
  const lanes = [
    [mergeTrain, 'LIFECYCLE_OWNER_MERGE_TRAIN'],
    [ciRecovery, 'LIFECYCLE_OWNER_CI_RECOVERY'],
    [autoRebase, 'LIFECYCLE_OWNER_BRANCH_UPDATE'],
    [ciRecoveryRouter, 'LIFECYCLE_OWNER_CI_RECOVERY'],
  ];
  for (const [content, laneVar] of lanes) {
    assert.match(content, /LEGACY_CI_MUTATION_BRIDGE_ENABLED/);
    assert.match(content, /observe-only/);
    // Legacy keeps writing unless THIS lane migrated to Goobers.
    assert.ok(
      content.includes(
        `vars.${laneVar} != 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'`,
      ),
      `${laneVar} lane gate missing`,
    );
    // The claim-lane selector must never gate a PR-lifecycle lane.
    assert.doesNotMatch(content, /vars\.LIFECYCLE_MUTATION_OWNER/);
  }

  assert.match(mergeTrain, /Observe legacy merge-train triggers without mutation/);
  assert.match(ciRecovery, /Observe legacy CI recovery without mutation/);
  assert.match(autoRebase, /Observe legacy rebase triggers without mutation/);
  assert.match(ciRecoveryRouter, /Observe legacy CI-recovery triggers without dispatch/);
  assert.match(
    ciRecoveryRouter,
    /name: Dispatch per-PR reconciliation[\s\S]*if: vars\.LIFECYCLE_OWNER_CI_RECOVERY != 'goobers' && vars\.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'/,
  );
});

test('Goobers claim ownership is issue-scoped, handed off at publication, and trust-checked', () => {
  // Claim concurrency is its own group so it can never serialize behind, or
  // stall, PR-lifecycle automation.
  assert.match(goobersLifecycleOwner, /group: crawler-implementation-claim-/);
  assert.match(goobersLifecycleOwner, /cancel-in-progress: false/);
  assert.match(goobersLifecycleOwner, /queue: max/);
  assert.match(ciRecovery, /group: crawler-ci-pr-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(ciRecovery, /queue: max/);

  // Publication is a handoff, not a lease acquisition.
  assert.match(goobersLifecycleOwner, /types: \[opened, ready_for_review\]/);
  assert.doesNotMatch(goobersLifecycleOwner, /synchronize/);
  assert.match(goobersLifecycleOwner, /- handoff/);
  assert.match(goobersLifecycleOwner, /closingIssuesReferences/);
  assert.match(goobersLifecycleOwner, /issueNumber/);
  // No PR-head fence remains, because the claim never covers a PR lifecycle.
  assert.doesNotMatch(goobersLifecycleOwner, /liveHeadSha: pull\.head\.sha/);

  assert.match(goobersLifecycleOwner, /getRepoVariable/);
  assert.match(goobersLifecycleOwner, /lifecycleWriterEnabled/);
  assert.match(goobersLifecycleOwner, /markers\.length !== 1/);
  // Both marker scans must go through the trusted-author filter so an external
  // commenter cannot forge or poison the claim state.
  assert.equal(goobersLifecycleOwner.match(/selectLifecycleLeaseComments\(comments\)/g)?.length, 2);
  assert.doesNotMatch(goobersLifecycleOwner, /startsWith\(ownership\.LIFECYCLE_LEASE_MARKER/);
  assert.match(goobersLifecycleOwner, /Refresh lease clock from GitHub server/);
  assert.match(goobersLifecycleOwner, /response\.headers\.date/);
  assert.match(goobersLifecycleOwner, /No stage\.finished\/decide-ownership event found/);
});
