import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for a real production finding: merge-train.yml's only
 * post-validation wake-up was a `workflow_run` on 'Merge Train Validation'
 * that never fired (evidenced by zero workflow_run Merge Train runs in
 * production, including after successful validation runs 29460650109,
 * 29460650185, 29460995287), and its 5-minute cron schedule was arriving hourly --
 * leaving manual `workflow_dispatch` as the only reliable trigger.
 *
 * A second gap surfaced by production run 29461261403: reconcile correctly
 * paused the train because "full-CI run for current main ... is still
 * in_progress". Once that push's CI finishes, the train needs a reliable
 * wake-up too -- the push event that originally triggered merge-train.yml
 * already ran (and passed its own gate) *before* CI resolved, so nothing
 * re-invoked reconcile when CI later completed.
 *
 * The fix covers both wake-ups:
 *   1. merge-train-validate.yml's `publish` job explicitly workflow_dispatches
 *      merge-train.yml after publishing the candidate check (see
 *      merge-train-validate-publish.test.ts) -- defense-in-depth alongside
 *      the retained (but historically unreliable) workflow_run/schedule.
 *   2. merge-train.yml adds a `workflow_run` entry for the 'CI' workflow so a
 *      completed push-to-main CI run wakes reconcile. 'CI' also runs on every
 *      PR and on an hourly schedule, so without a filter this would storm
 *      reconcile on every PR-CI completion. `branches: [main]` alone is not a
 *      sufficient filter (GitHub's workflow_run branch filter matches a PR's
 *      *base* branch too), so the job-level `if:` additionally requires
 *      `event == 'push'` for the 'CI' workflow specifically -- mirroring the
 *      identical, already-shipped storm guard in
 *      `.github/workflows/deploy.yml` (see deploy-workflow-gating.test.ts).
 *
 * A follow-up review finding closed a real gap in wake-up #2: reconcile.mjs's
 * own mainHealthAllowsPromotion()/mainHealthReason() treat scheduled 'CI' runs
 * for the current main SHA as authoritative health evidence too, picking
 * whichever run (push or schedule) is newest. If an hourly schedule run
 * starts after the push run and is still running when reconcile wakes on the
 * push completion, reconcile pauses on the schedule run instead -- and without
 * ALSO waking on that schedule run's completion, the train falls back to the
 * unreliable ~hourly cron to notice it finished, reproducing the original
 * bug. The job-level `if:` therefore also allows a scheduled 'CI' completion
 * to wake reconcile, but only while `vars.MERGE_TRAIN_ENABLED == 'true'` --
 * mirroring the identical carve-out already shipped in
 * `.github/workflows/ci-recovery-incidents.yml`.
 *
 * This test parses the REAL workflow YAML (no reimplementation of the YAML
 * itself) and additionally runs a small, literal re-transcription of the
 * job's `if:` boolean logic against representative event payloads, so a
 * regression either in the trigger wiring or in the gate's behavior is
 * caught deterministically.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowRunTrigger {
  workflows?: string[];
  types?: string[];
  branches?: string[];
}

interface WorkflowJob {
  if?: string;
}

interface WorkflowDoc {
  on: {
    push?: { branches?: string[] };
    pull_request_target?: { types?: string[] };
    workflow_run?: WorkflowRunTrigger;
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  jobs: Record<string, WorkflowJob>;
}

function loadMergeTrainWorkflow(): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/merge-train.yml'), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getReconcileJob(doc: WorkflowDoc): WorkflowJob {
  const job = doc.jobs.reconcile;
  if (!job) throw new Error('job "reconcile" not found in merge-train.yml');
  return job;
}

/**
 * Literal re-transcription of `jobs.reconcile.if` in merge-train.yml. Kept
 * intentionally line-for-line with the real expression (see the exact-string
 * assertion below, which fails if they drift apart) so this function can be
 * exercised against representative payloads as a truth table.
 */
function evaluateReconcileGate(payload: {
  eventName: string;
  pullRequestHeadRepoFullName?: string;
  repositoryFullName?: string;
  workflowRunName?: string;
  workflowRunEvent?: string;
  mergeTrainEnabled?: string;
}): boolean {
  const {
    eventName,
    pullRequestHeadRepoFullName,
    repositoryFullName,
    workflowRunName,
    workflowRunEvent,
    mergeTrainEnabled,
  } = payload;

  const forkGuardPasses =
    eventName !== 'pull_request_target' || pullRequestHeadRepoFullName === repositoryFullName;

  const ciStormGuardPasses =
    eventName !== 'workflow_run' ||
    workflowRunName !== 'CI' ||
    workflowRunEvent === 'push' ||
    (workflowRunEvent === 'schedule' && mergeTrainEnabled === 'true');

  return forkGuardPasses && ciStormGuardPasses;
}

describe('merge-train.yml trigger wiring (dual post-completion wake-up)', () => {
  it('parses merge-train.yml and finds the reconcile job', () => {
    const doc = loadMergeTrainWorkflow();
    expect(doc.jobs.reconcile).toBeDefined();
  });

  it('keeps push/pull_request_target/schedule/workflow_dispatch triggers as defense-in-depth', () => {
    const doc = loadMergeTrainWorkflow();
    expect(doc.on.push?.branches).toEqual(['main']);
    expect(doc.on.pull_request_target?.types).toEqual(
      expect.arrayContaining(['labeled', 'unlabeled', 'synchronize', 'edited', 'closed']),
    );
    expect(doc.on.schedule?.[0]?.cron).toBe('*/5 * * * *');
    expect(doc.on.workflow_dispatch).toBeDefined();
  });

  it('adds a workflow_run entry for BOTH Merge Train Validation and CI, scoped to main', () => {
    const doc = loadMergeTrainWorkflow();
    const workflowRun = doc.on.workflow_run;
    expect(workflowRun?.workflows).toEqual(
      expect.arrayContaining(['Merge Train Validation', 'CI']),
    );
    expect(workflowRun?.types).toEqual(['completed']);
    expect(workflowRun?.branches).toEqual(['main']);
  });

  it('gates the reconcile job with the exact expected fail-closed condition', () => {
    const doc = loadMergeTrainWorkflow();
    const condition = String(getReconcileJob(doc).if).trim();
    expect(condition).toBe(
      "(github.event_name != 'pull_request_target' || github.event.pull_request.head.repo.full_name == github.repository) && " +
        "(github.event_name != 'workflow_run' || github.event.workflow_run.name != 'CI' || github.event.workflow_run.event == 'push' || (github.event.workflow_run.event == 'schedule' && vars.MERGE_TRAIN_ENABLED == 'true'))",
    );
  });

  it('does not restrict the reconcile job on ordinary push/schedule/dispatch events', () => {
    expect(evaluateReconcileGate({ eventName: 'push' })).toBe(true);
    expect(evaluateReconcileGate({ eventName: 'schedule' })).toBe(true);
    expect(evaluateReconcileGate({ eventName: 'workflow_dispatch' })).toBe(true);
  });

  it('blocks pull_request_target events sourced from a fork (unchanged behavior)', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'pull_request_target',
        pullRequestHeadRepoFullName: 'someone-else/Crawler',
        repositoryFullName: 'nalfeo/Crawler',
      }),
    ).toBe(false);
    expect(
      evaluateReconcileGate({
        eventName: 'pull_request_target',
        pullRequestHeadRepoFullName: 'nalfeo/Crawler',
        repositoryFullName: 'nalfeo/Crawler',
      }),
    ).toBe(true);
  });

  it('wakes reconcile on a push-triggered CI completion on main (the new wake-up)', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'push',
      }),
    ).toBe(true);
  });

  it('does NOT wake reconcile on a PR-triggered CI completion (no storm)', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'pull_request',
      }),
    ).toBe(false);
  });

  it('does NOT wake reconcile on CI’s own hourly scheduled run completion when the train is disabled', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'schedule',
      }),
    ).toBe(false);
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'schedule',
        mergeTrainEnabled: 'false',
      }),
    ).toBe(false);
  });

  it('DOES wake reconcile on a scheduled CI completion once the train is enabled (closes the mainHealthReason gap)', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'schedule',
        mergeTrainEnabled: 'true',
      }),
    ).toBe(true);
  });

  it('does NOT wake reconcile on a PR-triggered CI completion even when the train is enabled (no storm)', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'CI',
        workflowRunEvent: 'pull_request',
        mergeTrainEnabled: 'true',
      }),
    ).toBe(false);
  });

  it('always wakes reconcile on Merge Train Validation completion, regardless of its triggering event', () => {
    expect(
      evaluateReconcileGate({
        eventName: 'workflow_run',
        workflowRunName: 'Merge Train Validation',
        workflowRunEvent: 'workflow_dispatch',
      }),
    ).toBe(true);
  });
});
