import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowDoc {
  on: {
    workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] };
    pull_request_target?: { types?: string[] };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
  jobs: {
    reconcile?: {
      if?: string;
      concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
      steps?: Array<{
        name?: string;
        id?: string;
        if?: string;
        uses?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }>;
    };
  };
}

interface ValidationWorkflowDoc {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { required?: boolean; type?: string }>;
    };
  };
  jobs: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }>;
    }
  >;
}

function loadWorkflow(): WorkflowDoc {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/merge-train.yml'), 'utf8'),
  ) as WorkflowDoc;
}

function loadValidationWorkflow(): ValidationWorkflowDoc {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'), 'utf8'),
  ) as ValidationWorkflowDoc;
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
    const workflow = loadWorkflow();
    // Workflow-level concurrency applies before `jobs.<job>.if`. We must not use it,
    // otherwise unrelated events could steal the `queue: single` slot and displace
    // a valid wake, only to skip the job later.
    expect(workflow.concurrency).toBeUndefined();

    const concurrency = workflow.jobs.reconcile?.concurrency;
    expect(concurrency?.group).toBe('crawler-merge-train');
    expect(concurrency?.queue).toBe('single');
    expect(concurrency?.['cancel-in-progress']).not.toBe(true);
  });

  describe('merge-train candidate transport', () => {
    it('materializes every candidate job from an opaque custom-ref bundle', () => {
      const workflow = loadValidationWorkflow();
      expect(workflow.on.workflow_dispatch.inputs.candidate_ref?.required).toBe(true);
      expect(workflow.on.workflow_dispatch.inputs.attestation_sha?.required).toBe(true);

      for (const jobName of ['static', 'unit-tests', 'sprite-tests', 'health', 'security']) {
        const steps = workflow.jobs[jobName]?.steps ?? [];
        const checkout = steps.find(
          (step) => step.name === 'Check out trusted candidate materializer',
        );
        const materialize = steps.find((step) => step.name === 'Materialize immutable candidate');
        expect(checkout?.with?.ref).toBe('${{ github.event.repository.default_branch }}');
        expect(checkout?.with?.['persist-credentials']).toBe(false);
        expect(materialize?.run).toBe('bash .github/scripts/merge-train/materialize-candidate.sh');
        expect(materialize?.env?.CANDIDATE_REF).toBe('${{ inputs.candidate_ref }}');
        expect(materialize?.env?.CANDIDATE_SHA).toBe('${{ inputs.candidate_sha }}');
      }
    });

    it('publishes validation evidence on the trusted main attestation commit', () => {
      const publish = loadValidationWorkflow().jobs.publish?.steps?.find(
        (step) => step.name === 'Publish immutable candidate result',
      );
      expect(publish?.env?.ATTESTATION_SHA).toBe('${{ inputs.attestation_sha }}');
      expect(publish?.with?.script).toContain("const { createHash } = require('crypto')");
      expect(publish?.with?.script).toContain(
        "createHash('sha256').update(`${process.env.FINGERPRINT}:${(process.env.CANDIDATE_SHA || '').toLowerCase()}`).digest('hex')",
      );
      expect(publish?.with?.script).not.toContain(
        '`${process.env.FINGERPRINT}:${process.env.CANDIDATE_SHA}`',
      );
      // Shared attestation SHAs require the fallback to inspect every same-name check.
      expect(publish?.with?.script).toContain('head_sha: process.env.ATTESTATION_SHA');
      expect(publish?.with?.script).not.toContain('head_sha: process.env.CANDIDATE_SHA');
    });

    it('requests all check runs (filter: all) in the fallback recovery step to prevent hidden results masking bisection', () => {
      const steps = loadValidationWorkflow().jobs.publish?.steps ?? [];
      const fallback = steps.find(
        (step) => step.name === 'Mark candidate check retryable if publishing failed',
      );
      // The fallback listForRef must request all runs so a newer in_progress run
      // is never hidden behind an earlier terminal result for the same check name.
      expect(fallback?.with?.script).toContain("filter: 'all'");
    });
  });

  it('uses the App checkout credential for candidates and never exposes a PAT', () => {
    const workflow = loadWorkflow();
    expect(workflow.permissions?.contents).toBe('read');
    expect(workflow.permissions?.workflows).toBeUndefined();

    const steps = workflow.jobs.reconcile?.steps ?? [];
    const checkoutStep = steps.find(
      (step) => step.name === 'Checkout trusted merge-train implementation',
    );
    const reconcileStep = steps.find((step) => step.name === 'Reconcile six-PR build-expiry train');
    expect(checkoutStep?.with?.token).toBe('${{ steps.app-token.outputs.token }}');
    expect(reconcileStep?.env?.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(steps.every((step) => step.env?.MERGE_TRAIN_WORKFLOW_TOKEN === undefined)).toBe(true);
    expect(
      steps.every(
        (step) => !Object.values(step.env ?? {}).includes('${{ secrets.CRAWLER_CI_PAT }}'),
      ),
    ).toBe(true);
  });

  it('subscribes to all required pull_request_target event types', () => {
    const types = loadWorkflow().on.pull_request_target?.types ?? [];
    expect(types).toEqual(
      expect.arrayContaining([
        'labeled',
        'unlabeled',
        'synchronize',
        'edited',
        'closed',
        'ready_for_review',
      ]),
    );
    expect(types).toHaveLength(6);
  });

  it('admits same-repository PRs that carry the merge-train label', () => {
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');
    expect(
      evaluatesPullRequestCondition(condition, {
        repository: 'nalfeo/Crawler',
        headRepository: 'nalfeo/Crawler',
        labels: ['merge-train'],
      }),
    ).toBe(true);
  });

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

  it('reconciles a completed scheduled CI run when the job-level if allows it through', () => {
    // The schedule+MERGE_TRAIN_ENABLED gate was moved from the job-level if: into
    // the .github/actions/train-gate composite action (step-level) so that the
    // gate logic is defined once. The job-level if: now admits all schedule events
    // and delegates MERGE_TRAIN_ENABLED enforcement to the train-gate step.
    // See .github/actions/train-gate/action.yml for the canonical gate definition.
    const condition = loadWorkflow().jobs.reconcile?.if;
    if (!condition) throw new Error('reconcile job condition not found');

    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'CI', event: 'schedule', headBranch: 'main' },
        'true',
      ),
    ).toBe(true);
    // The job-level if: no longer gates on MERGE_TRAIN_ENABLED for schedule events;
    // the train-gate step handles that. The condition must admit the event so the
    // step can decide.
    expect(
      evaluatesReconcileCondition(
        condition,
        { name: 'CI', event: 'schedule', headBranch: 'main' },
        'false',
      ),
    ).toBe(true);
  });

  it('train-gate step enforces MERGE_TRAIN_ENABLED for schedule-triggered CI wakes', () => {
    // The train-gate composite action is the canonical "schedule && train-enabled"
    // gate. Verify the step is present and wired correctly.
    const steps = loadWorkflow().jobs.reconcile?.steps ?? [];
    const gateStep = steps.find((step) => step.name === 'Train gate');
    expect(gateStep).toBeDefined();
    expect(gateStep?.with?.['event-is-schedule']).toContain(
      "github.event.workflow_run.name == 'CI'",
    );
    expect(gateStep?.with?.['event-is-schedule']).toContain(
      "github.event.workflow_run.event == 'schedule'",
    );
    expect(gateStep?.with?.['merge-train-enabled']).toContain('MERGE_TRAIN_ENABLED');
    // Downstream steps must be gated on the action output so they are skipped
    // when the train is disabled on a schedule event.
    const reconcileStep = steps.find((step) => step.name === 'Reconcile six-PR build-expiry train');
    expect(reconcileStep?.if).toBe("steps.train-gate.outputs.enabled == 'true'");
    // Checkout must precede the train-gate step (local composite actions
    // require the repo to be checked out before they can be resolved).
    const gateIdx = steps.indexOf(gateStep!);
    const checkoutIdx = steps.findIndex((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeLessThan(gateIdx);
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
