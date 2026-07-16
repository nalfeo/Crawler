import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowDoc {
  on: { workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] } };
  concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
  jobs: { reconcile?: { if?: string } };
}

function loadWorkflow(): WorkflowDoc {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/merge-train.yml'), 'utf8'),
  ) as WorkflowDoc;
}

function evaluatesReconcileCondition(
  condition: string,
  workflowRun: { name: string; event: string; headBranch: string },
  mergeTrainEnabled = 'false',
): boolean {
  const expression = condition
    .replace(/^\s*\${{\s*|\s*}}\s*$/g, '')
    .replace("contains(github.event.pull_request.labels.*.name, 'merge-train')", 'false')
    .replaceAll('github.event.pull_request.head.repo.full_name', JSON.stringify(''))
    .replaceAll('github.event.label.name', JSON.stringify(null))
    .replaceAll('github.repository', JSON.stringify('nalfeo/Crawler'))
    .replaceAll('github.event.repository.default_branch', JSON.stringify('main'))
    .replaceAll('github.event.workflow_run.head_branch', JSON.stringify(workflowRun.headBranch))
    .replaceAll('github.event.workflow_run.event', JSON.stringify(workflowRun.event))
    .replaceAll('github.event.workflow_run.name', JSON.stringify(workflowRun.name))
    .replaceAll('vars.MERGE_TRAIN_ENABLED', JSON.stringify(mergeTrainEnabled))
    .replaceAll('github.event_name', JSON.stringify('workflow_run'));

  return new Function(`return (${expression});`)() as boolean;
}

function evaluatesPullRequestCondition(
  condition: string,
  event: {
    repository: string;
    headRepository: string;
    labels: string[];
    transitionedLabel?: string;
  },
): boolean {
  const expression = condition
    .replace(/^\s*\${{\s*|\s*}}\s*$/g, '')
    .replace(
      "contains(github.event.pull_request.labels.*.name, 'merge-train')",
      JSON.stringify(event.labels.includes('merge-train')),
    )
    .replaceAll(
      'github.event.pull_request.head.repo.full_name',
      JSON.stringify(event.headRepository),
    )
    .replaceAll('github.event.label.name', JSON.stringify(event.transitionedLabel ?? null))
    .replaceAll('github.repository', JSON.stringify(event.repository))
    .replaceAll('github.event_name', JSON.stringify('pull_request_target'));

  return new Function(`return (${expression});`)() as boolean;
}

describe('merge-train workflow wake-ups', () => {
  it('keeps one active reconcile and only the latest pending wake', () => {
    const concurrency = loadWorkflow().concurrency;
    expect(concurrency?.group).toBe('crawler-merge-train');
    expect(concurrency?.queue).toBe('single');
    expect(concurrency?.['cancel-in-progress']).not.toBe(true);
  });

  it.each(['synchronize', 'edited', 'closed', 'ready_for_review'])(
    'admits queued same-repo PR work for %s events',
    () => {
      const condition = loadWorkflow().jobs.reconcile?.if;
      if (!condition) throw new Error('reconcile job condition not found');
      expect(
        evaluatesPullRequestCondition(condition, {
          repository: 'nalfeo/Crawler',
          headRepository: 'nalfeo/Crawler',
          labels: ['merge-train'],
        }),
      ).toBe(true);
    },
  );

  it('admits merge-train label transitions, including removal', () => {
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');
    expect(
      evaluatesPullRequestCondition(condition, {
        repository: 'nalfeo/Crawler',
        headRepository: 'nalfeo/Crawler',
        labels: [],
        transitionedLabel: 'merge-train',
      }),
    ).toBe(true);
  });

  it('rejects unrelated PR wakes and fork PRs', () => {
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');
    expect(
      evaluatesPullRequestCondition(condition, {
        repository: 'nalfeo/Crawler',
        headRepository: 'nalfeo/Crawler',
        labels: [],
        transitionedLabel: 'unrelated',
      }),
    ).toBe(false);
    expect(
      evaluatesPullRequestCondition(condition, {
        repository: 'nalfeo/Crawler',
        headRepository: 'fork/Crawler',
        labels: ['merge-train'],
      }),
    ).toBe(false);
  });

  it('subscribes to only default-branch candidate validation and CI completions', () => {
    const workflowRun = loadWorkflow().on.workflow_run;
    expect(workflowRun?.workflows).toEqual(
      expect.arrayContaining(['Merge Train Validation', 'CI']),
    );
    expect(workflowRun?.types).toEqual(['completed']);
    // This rejects PR and other-branch CI before Actions creates a Merge Train
    // workflow record; the job condition below remains defense-in-depth.
    expect(workflowRun?.branches).toEqual(['main']);
  });

  it('reconciles a completed CI run only when it is a push to the default branch', () => {
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');

    expect(
      evaluatesReconcileCondition(condition, {
        name: 'CI',
        event: 'push',
        headBranch: 'main',
      }),
    ).toBe(true);
    expect(
      evaluatesReconcileCondition(condition, {
        name: 'CI',
        event: 'pull_request',
        headBranch: 'feature/no-reconcile-storm',
      }),
    ).toBe(false);
    expect(
      evaluatesReconcileCondition(condition, {
        name: 'CI',
        event: 'push',
        headBranch: 'release/other-branch',
      }),
    ).toBe(false);
  });

  it('reconciles a completed scheduled CI run only while the merge train is enabled', () => {
    // mainHealthReason() (reconcile-lib.mjs) treats whichever CI run for the
    // current main SHA is newest by created_at as authoritative, regardless of
    // whether it was push- or schedule-triggered. Without this carve-out, a
    // scheduled CI completion that races a push completion would never
    // re-wake reconcile, leaving the train stuck until the unreliable */5 cron
    // fallback (observed arriving ~hourly in production) eventually fires.
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');

    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'CI', event: 'schedule', headBranch: 'main' },
        'true',
      ),
    ).toBe(true);
    // Fail closed: disabled train must not wake reconcile off a scheduled CI
    // completion (matches the existing ci-recovery-incidents.yml precedent).
    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'CI', event: 'schedule', headBranch: 'main' },
        'false',
      ),
    ).toBe(false);
  });

  it('still rejects a PR-triggered CI run even while the merge train is enabled (no storm regression)', () => {
    // Storm guard: enabling the train (MERGE_TRAIN_ENABLED=true) only widens
    // the carve-out to *scheduled* CI completions -- it must not also let a
    // PR-triggered CI completion through, or every PR's CI run would wake
    // reconcile whenever the train happens to be enabled.
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');

    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'CI', event: 'pull_request', headBranch: 'feature/no-reconcile-storm' },
        'true',
      ),
    ).toBe(false);
  });

  it('leaves non-CI workflow_run completions (e.g. Merge Train Validation) unaffected by the new carve-out', () => {
    // The schedule/MERGE_TRAIN_ENABLED carve-out only applies when
    // workflow_run.name == 'CI'; a future edit could accidentally widen or
    // narrow that scoping. Lock in that 'Merge Train Validation' completions
    // still pass regardless of event type or the enabled flag.
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');

    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'Merge Train Validation', event: 'workflow_dispatch', headBranch: 'main' },
        'false',
      ),
    ).toBe(true);
    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'Merge Train Validation', event: 'workflow_dispatch', headBranch: 'main' },
        'true',
      ),
    ).toBe(true);
  });
});
