import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  if?: string;
  id?: string;
  'continue-on-error'?: boolean;
}

interface WorkflowJob {
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  if?: string;
  'continue-on-error'?: boolean;
}

interface TriggerConfig {
  branches?: string[];
  paths?: string[];
}

interface WorkflowDoc {
  on: {
    pull_request?: TriggerConfig;
    push?: TriggerConfig;
  };
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: string | boolean;
  };
  jobs: Record<string, WorkflowJob>;
}

function getStepIf(job: WorkflowJob | undefined, stepName: string): string {
  const step = job?.steps?.find((s) => s.name === stepName);
  if (!step) throw new Error(`step "${stepName}" not found`);
  return String(step.if ?? '').trim();
}

function loadWorkflow(relativePath: string): WorkflowDoc {
  return parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as WorkflowDoc;
}

describe('ci workflow overhead reduction', () => {
  it('consolidates 4 former lightweight jobs into check-lightweight and splits coverage into ci-coverage', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');

    // Former independent jobs must be gone
    expect(workflow.jobs['check-types-and-lint']).toBeUndefined();
    expect(workflow.jobs['check-format-and-labs']).toBeUndefined();
    expect(workflow.jobs['ci-advisory']).toBeUndefined();
    expect(workflow.jobs['human-approval']).toBeUndefined();
    expect(workflow.jobs['test-unit-coverage']).toBeUndefined();

    // check-lightweight: consolidates all 4 former lightweight jobs
    const lightweightJob = workflow.jobs['check-lightweight'];
    expect(lightweightJob, 'check-lightweight job').toBeTruthy();
    expect(lightweightJob?.needs).toEqual(['changes']);
    expect(
      lightweightJob?.steps?.filter((step) => step.uses === 'actions/checkout@v4'),
    ).toHaveLength(1);
    expect(
      lightweightJob?.steps?.filter((step) => step.uses === './.github/actions/setup-node'),
    ).toHaveLength(1);
    // All blocking steps must be present
    const requiredBlockingSteps = [
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
      'Typecheck & Lint',
      'Human approval',
    ];
    for (const name of requiredBlockingSteps) {
      expect(
        lightweightJob?.steps?.find((step) => step.name === name),
        `blocking step "${name}"`,
      ).toBeTruthy();
    }
    // Advisory steps must be present
    const requiredAdvisorySteps = [
      'Dead code detection',
      'Security audit',
      'Typecheck (full — tests + scripts)',
    ];
    for (const name of requiredAdvisorySteps) {
      expect(
        lightweightJob?.steps?.find((step) => step.name === name),
        `advisory step "${name}"`,
      ).toBeTruthy();
    }

    // ci-coverage: independent advisory job for the ~140-second coverage suite
    const coverage = workflow.jobs['ci-coverage'];
    expect(coverage).toBeTruthy();
    expect(coverage?.needs).toEqual(['changes']);
    expect(coverage?.permissions).toMatchObject({ 'pull-requests': 'write' });
    expect(coverage?.steps?.find((step) => step.name === 'Unit tests with coverage')).toBeTruthy();
    expect(coverage?.steps?.find((step) => step.name === 'Upload coverage summary')).toBeTruthy();
    expect(coverage?.steps?.find((step) => step.name === 'Coverage report comment')).toBeTruthy();

    expect(workflow.jobs['merge-gate']?.needs).toContain('check-lightweight');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('static-validation');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-types-and-lint');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-format-and-labs');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('human-approval');
  });

  it('check-lightweight blocking steps fail-fast without continue-on-error; advisory steps have continue-on-error', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const lightweightJob = workflow.jobs['check-lightweight'];
    const steps = lightweightJob?.steps ?? [];

    // Blocking steps must NOT have continue-on-error so any failure stops the job
    const blockingStepNames = [
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
      'Typecheck & Lint',
      'Human approval',
    ];
    for (const name of blockingStepNames) {
      const step = steps.find((s) => s.name === name);
      expect(step, `blocking step "${name}" should exist`).toBeTruthy();
      expect(
        step?.['continue-on-error'],
        `blocking step "${name}" must not have continue-on-error`,
      ).toBeFalsy();
    }

    // Advisory steps must have continue-on-error: true so failures surface without blocking merge
    const advisoryStepNames = [
      'Dead code detection',
      'Security audit',
      'Typecheck (full — tests + scripts)',
    ];
    for (const name of advisoryStepNames) {
      const step = steps.find((s) => s.name === name);
      expect(step, `advisory step "${name}" should exist`).toBeTruthy();
      expect(
        step?.['continue-on-error'],
        `advisory step "${name}" must have continue-on-error: true`,
      ).toBe(true);
    }
  });
});

describe('merge-gate aggregation policy', () => {
  it('runs when dependencies fail but is skipped on cancellation (if: !cancelled())', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const mergeGate = workflow.jobs['merge-gate'];
    // !cancelled() preserves fail-closed behavior on dependency failures while
    // allowing superseded PR runs to stop cleanly under concurrency cancellation.
    expect(mergeGate?.if).toBe('${{ !cancelled() }}');
  });

  it('final ci job mirrors merge-gate cancellation policy', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    expect(workflow.jobs.ci?.if).toBe('${{ !cancelled() }}');
  });

  it('changes detection job failure blocks the gate (no allow_skipped)', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const step = workflow.jobs['merge-gate']?.steps?.[0];
    const script = String(step?.run ?? '');
    // `changes` must be checked with no third allow_skipped argument so a failed
    // detect-art-only run cannot silently bypass the heavy gates.
    expect(script).toContain('check "Change scope detection"');
    // The changes check line must not pass "true" as the allow_skipped arg.
    expect(script).not.toMatch(/check "Change scope detection"\s+[^\n]+"true"/);
  });

  it('Lightweight Checks always blocks (no allow_skipped, no docs-only escape)', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const step = workflow.jobs['merge-gate']?.steps?.[0];
    const script = String(step?.run ?? '');
    expect(script).toContain('check "Lightweight Checks"');
    // Lightweight Checks must NOT have allow_skipped=true; it blocks on all changes.
    expect(script).not.toMatch(/check "Lightweight Checks"\s+[^\n]+"true"/);
  });

  it('docs-only skip path is present for scope-gated jobs', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const step = workflow.jobs['merge-gate']?.steps?.[0];
    const script = String(step?.run ?? '');
    // docs-only PRs are allowed to skip heavy jobs; this logic must be explicit.
    expect(script).toContain('docs_only');
    expect(script).toContain('skipped — docs-only change');
  });

  it('scope-gated jobs carry allow_skipped=true so art/sprites-only changes pass', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const step = workflow.jobs['merge-gate']?.steps?.[0];
    const script = String(step?.run ?? '');
    // Unit tests, integration tests, and E2E all use allow_skipped=true via the check() helper.
    // Headless Floor 1 uses a custom sim_touched validation block instead — see ci-gating-policy.test.ts.
    // E2E has been split into three surface-targeted jobs (PR #1698).
    const allowSkippedJobs = [
      'Unit tests',
      'Integration tests',
      'Sprite pipeline tests',
      'Set-piece reachability',
      'E2E Visual — Game/UI',
      'E2E Visual — Asset Smoke',
      'E2E Visual — Devtools',
    ];
    for (const name of allowSkippedJobs) {
      expect(script, `"${name}" check should have allow_skipped=true`).toMatch(
        new RegExp(`check "${name.replace(/[()]/g, '\\$&')}"[^\\n]+"true"`),
      );
    }
  });

  it('merge-gate needs lists all required blocking jobs', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const needs = workflow.jobs['merge-gate']?.needs ?? [];
    expect(needs).toContain('changes');
    expect(needs).toContain('check-lightweight');
    expect(needs).toContain('test-unit');
    expect(needs).toContain('test-integration');
    expect(needs).toContain('test-headless');
    expect(needs).toContain('set-piece-reachability');
    // E2E split into three surface-targeted jobs (PR #1698).
    expect(needs).toContain('test-e2e-game');
    expect(needs).toContain('test-e2e-assets');
    expect(needs).toContain('test-e2e-devtools');
    // Old job names and superseded jobs must not appear.
    expect(needs).not.toContain('static-validation');
    expect(needs).not.toContain('check-types-and-lint');
    expect(needs).not.toContain('check-format-and-labs');
    expect(needs).not.toContain('human-approval');
    expect(needs).not.toContain('test-e2e');
  });
});

describe('epic drift audit trigger scope', () => {
  it('limits PR/push runs to the Floor 2 equipment control plane and direct execution inputs', () => {
    const workflow = loadWorkflow('.github/workflows/epic-drift-audit.yml');
    const expectedPaths = [
      'docs/knowledge/epics/floor-2-equipment/**',
      'scripts/agent/epics/**',
      'tests/unit/agent/epic-status.test.ts',
      'tests/unit/agent/epic-status-inaccessible-commit.test.ts',
      '.github/workflows/epic-drift-audit.yml',
    ];

    expect(workflow.on.pull_request?.paths).toEqual(expectedPaths);
    expect(workflow.on.push?.paths).toEqual(expectedPaths);
    expect(workflow.on.pull_request?.paths).not.toContain('docs/knowledge/epics/**');
    expect(workflow.on.pull_request?.paths).toContain('tests/unit/agent/epic-status.test.ts');
  });
});

describe('superseded-run concurrency cancellation policy (#1689)', () => {
  // Both PR-triggered workflows must cancel superseded runs on the same PR while
  // never cancelling across workflows or across different PRs, and must keep a
  // distinct non-cancelling group for push/schedule/manual events.
  for (const relPath of ['.github/workflows/ci.yml', '.github/workflows/security-review.yml']) {
    it(`${relPath} defines a workflow-namespaced, PR-scoped concurrency group`, () => {
      const workflow = loadWorkflow(relPath);
      const group = String(workflow.concurrency?.group ?? '');
      expect(group, `${relPath} must define a concurrency.group`).toBeTruthy();
      // A stable per-workflow literal prefix prevents cross-workflow collisions.
      const expectedPrefix =
        relPath === '.github/workflows/ci.yml' ? 'crawler-ci-' : 'crawler-security-review-';
      expect(group).toContain(expectedPrefix);
      // PRs group by PR number so a newer synchronize cancels the older head.
      expect(group).toContain("github.event_name == 'pull_request'");
      expect(group).toContain("format('pr-{0}', github.event.pull_request.number)");
      // Non-PR events fall back to a unique per-run group (never cancel).
      expect(group).toContain('github.run_id');
    });

    it(`${relPath} only cancels in-progress runs for pull_request events`, () => {
      const workflow = loadWorkflow(relPath);
      const cancel = String(workflow.concurrency?.['cancel-in-progress'] ?? '');
      // Must be gated on the event being a pull_request so push/schedule/manual
      // runs are never cancelled mid-flight.
      expect(cancel).toContain("github.event_name == 'pull_request'");
    });
  }
});

describe('impact-flag job gating contracts (#1697/#1698)', () => {
  it('surface-targeted E2E jobs gate on per-surface visual flags', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const gameIf = String(workflow.jobs['test-e2e-game']?.if ?? '').trim();
    const assetIf = String(workflow.jobs['test-e2e-assets']?.if ?? '').trim();
    const devtoolIf = String(workflow.jobs['test-e2e-devtools']?.if ?? '').trim();

    expect(gameIf).toContain("game_visual_touched == 'true'");
    expect(assetIf).toContain("asset_visual_touched == 'true'");
    expect(devtoolIf).toContain("devtool_visual_touched == 'true'");

    expect(gameIf).toContain("docs_only != 'true'");
    expect(assetIf).toContain("docs_only != 'true'");
    expect(devtoolIf).toContain("docs_only != 'true'");
  });

  it('security-review npm audit and dependency allowlist gate on dependencies_touched (fail-closed: != false)', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const job = workflow.jobs['security-checks'];
    for (const step of ['npm audit', 'Dependency allowlist']) {
      const stepDef = job?.steps?.find((s) => s.name === step);
      const condition = getStepIf(job, step);
      // Fail-closed: only explicit 'false' skips; blank/missing output keeps the gate running.
      expect(condition, `${step} must gate on dependencies_touched != false`).toContain(
        "dependencies_touched != 'false'",
      );
      // The old fail-open form must not be present.
      expect(condition, `${step} must not use fail-open == true`).not.toContain(
        "dependencies_touched == 'true'",
      );
      // Non-PR events (schedule/workflow_dispatch) must not hard-fail the workflow
      // on advisory findings; that is expressed via continue-on-error, not the if:.
      expect(stepDef?.['continue-on-error'], `${step} must not hard-fail on non-PR events`).toBe(
        "${{ github.event_name != 'pull_request' }}",
      );
    }
  });

  it('security-review secret scanning stays fail-closed (not gated on dependencies_touched)', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const job = workflow.jobs['security-checks'];
    // Secret scanning must run for every relevant PR change set regardless of
    // dependency-manifest scope: it is split into a docs/asset-only variant and a
    // non-docs variant (train-promotion + not-cancelled), never gated on
    // dependencies_touched.
    for (const step of [
      'Scan for committed secrets (docs/asset-only)',
      'Scan for committed secrets',
    ]) {
      const condition = getStepIf(job, step);
      expect(condition, `${step} must gate on train_promoted`).toContain(
        "train_promoted != 'true'",
      );
      expect(condition, `${step} must not be gated on dependencies_touched`).not.toContain(
        'dependencies_touched',
      );
    }
  });

  it('security-checks job is skipped when the workflow is cancelled but runs on changes failure (if: !cancelled())', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const securityChecks = workflow.jobs['security-checks'];
    // !cancelled() skips the job when the concurrency policy cancels a superseded run
    // (preserving the intent of the concurrency block), while still running when the
    // changes job fails normally — preventing scope-detection failure from silently
    // bypassing the security gate.
    // always() would keep the job running even after cancellation, undermining #1689.
    expect(securityChecks?.if).toBe('${{ !cancelled() }}');
  });
});
