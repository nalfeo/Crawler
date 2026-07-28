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
