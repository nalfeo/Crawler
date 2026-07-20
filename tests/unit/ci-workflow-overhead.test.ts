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
  it('reuses one shared setup job for static validation and splits coverage into its own advisory job', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');

    expect(workflow.jobs['check-types-and-lint']).toBeUndefined();
    expect(workflow.jobs['check-format-and-labs']).toBeUndefined();
    expect(workflow.jobs['test-unit-coverage']).toBeUndefined();
    expect(workflow.jobs.build).toBeUndefined();

    const staticValidation = workflow.jobs['static-validation'];
    expect(staticValidation?.needs).toEqual(['changes']);
    expect(
      staticValidation?.steps?.filter((step) => step.uses === 'actions/checkout@v4'),
    ).toHaveLength(1);
    expect(
      staticValidation?.steps?.filter((step) => step.uses === './.github/actions/setup-node'),
    ).toHaveLength(1);
    expect(staticValidation?.steps?.find((step) => step.name === 'Types & Lint')).toBeTruthy();
    expect(staticValidation?.steps?.find((step) => step.name === 'Format check')).toBeTruthy();
    expect(staticValidation?.steps?.find((step) => step.name === 'Lab gate check')).toBeTruthy();
    expect(
      staticValidation?.steps?.find((step) => step.name === 'Orphaned-system wiring guard'),
    ).toBeTruthy();
    expect(
      staticValidation?.steps?.find((step) => step.name === 'Guard + review-ledger tests'),
    ).toBeTruthy();

    // static-validation MUST install Playwright: test:guards includes
    // .github/extensions/sprite-editor/tests which launch Chromium via Playwright.
    const setupNodeStep = staticValidation?.steps?.find(
      (step) => step.uses === './.github/actions/setup-node',
    );
    expect(setupNodeStep?.with?.['install-playwright']).toBe('true');

    // ci-advisory: lightweight checks only — no coverage (that lives in ci-coverage)
    const advisory = workflow.jobs['ci-advisory'];
    expect(advisory?.steps?.find((step) => step.name === 'Dead code detection')).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Security audit')).toBeTruthy();
    expect(
      advisory?.steps?.find((step) => step.name === 'Typecheck (full — tests + scripts)'),
    ).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Build')).toBeTruthy();
    // Coverage must NOT be in ci-advisory (it is now its own independent job)
    expect(advisory?.steps?.find((step) => step.name === 'Unit tests with coverage')).toBeFalsy();
    expect(advisory?.steps?.find((step) => step.name === 'Coverage report comment')).toBeFalsy();

    // ci-coverage: independent advisory job for the ~140-second coverage suite
    const coverage = workflow.jobs['ci-coverage'];
    expect(coverage).toBeTruthy();
    expect(coverage?.needs).toEqual(['changes']);
    expect(coverage?.permissions).toMatchObject({ 'pull-requests': 'write' });
    expect(coverage?.steps?.find((step) => step.name === 'Unit tests with coverage')).toBeTruthy();
    expect(coverage?.steps?.find((step) => step.name === 'Upload coverage summary')).toBeTruthy();
    expect(coverage?.steps?.find((step) => step.name === 'Coverage report comment')).toBeTruthy();

    expect(workflow.jobs['merge-gate']?.needs).toContain('static-validation');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-types-and-lint');
    expect(workflow.jobs['merge-gate']?.needs).not.toContain('check-format-and-labs');
  });

  it('static-validation steps each run with continue-on-error and are aggregated by a final result check', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const staticValidation = workflow.jobs['static-validation'];
    const steps = staticValidation?.steps ?? [];

    // Each substantive check step must have continue-on-error: true so a failure
    // does not suppress the remaining checks (preserves attribution parity with
    // the former two-parallel-job layout).
    const checkStepNames = [
      'Types & Lint',
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
    ];
    for (const name of checkStepNames) {
      const step = steps.find((s) => s.name === name);
      expect(step, `Step "${name}" should exist`).toBeTruthy();
      expect(
        step?.['continue-on-error'],
        `Step "${name}" should have continue-on-error: true`,
      ).toBe(true);
    }

    // A final aggregation step must run even after failures (if: always()) and
    // must not itself have continue-on-error (it IS the gate).
    const resultStep = steps.find((s) => s.name === 'Check static validation results');
    expect(resultStep, 'Check static validation results step should exist').toBeTruthy();
    expect(resultStep?.if).toBe('always()');
    expect(resultStep?.['continue-on-error']).toBeFalsy();

    // The aggregation script must reference every check step's outcome by id
    // so no check can be silently omitted from the gate.
    const aggregationScript = String(resultStep?.run ?? '');
    const expectedStepIds = [
      'types-lint',
      'format-check',
      'lab-gate',
      'wiring-guard',
      'guard-tests',
    ];
    for (const id of expectedStepIds) {
      expect(aggregationScript, `Aggregation script must reference step id '${id}'`).toContain(
        `steps.${id}.outcome`,
      );
    }
  });
});

describe('merge-gate aggregation policy', () => {
  it('runs even when a required job fails (fail-closed: if: always())', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const mergeGate = workflow.jobs['merge-gate'];
    // Without `if: always()`, a failing needed job causes merge-gate to be skipped,
    // which silently counts as PASS and lets broken changes through.
    expect(mergeGate?.if).toBe('always()');
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

  it('static-validation always blocks (no allow_skipped, no docs-only escape)', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const step = workflow.jobs['merge-gate']?.steps?.[0];
    const script = String(step?.run ?? '');
    expect(script).toContain('check "Static validation"');
    // Static validation must NOT have allow_skipped=true; it blocks on all non-docs-only changes.
    expect(script).not.toMatch(/check "Static validation"\s+[^\n]+"true"/);
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
    const allowSkippedJobs = [
      'Unit tests',
      'Integration tests',
      'Sprite pipeline tests',
      'E2E Visual Regression',
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
    expect(needs).toContain('static-validation');
    expect(needs).toContain('test-unit');
    expect(needs).toContain('test-integration');
    expect(needs).toContain('test-headless');
    expect(needs).toContain('test-e2e');
    expect(needs).toContain('human-approval');
    // Old job names must not appear.
    expect(needs).not.toContain('check-types-and-lint');
    expect(needs).not.toContain('check-format-and-labs');
  });
});

describe('epic drift audit trigger scope', () => {
  it('limits PR/push runs to the Floor 2 equipment control plane and direct execution inputs', () => {
    const workflow = loadWorkflow('.github/workflows/epic-drift-audit.yml');
    const expectedPaths = [
      'docs/knowledge/epics/floor-2-equipment/**',
      'scripts/agent/epics/**',
      'tests/unit/agent/epic-status.test.ts',
      '.github/actions/setup-node/action.yml',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
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
      // Workflow name in the key prevents ci.yml cancelling security-review.yml.
      expect(group).toContain('github.workflow');
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
  it('test-e2e is skipped on PRs when visual_touched is not true (non-PR runs unconditionally)', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const condition = String(workflow.jobs['test-e2e']?.if ?? '').trim();
    expect(condition).toContain("visual_touched != 'true'");
    expect(condition).toContain("github.event_name == 'pull_request'");
    // Still skipped for art_only / docs_only / sprites_only.
    expect(condition).toContain("art_only != 'true'");
    expect(condition).toContain("docs_only != 'true'");
    expect(condition).toContain("sprites_only != 'true'");
  });

  it('ci-advisory Security audit runs on PRs only when dependencies_touched (non-PR backstop)', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');
    const condition = getStepIf(workflow.jobs['ci-advisory'], 'Security audit');
    expect(condition).toContain("dependencies_touched == 'true'");
    expect(condition).toContain("github.event_name != 'pull_request'");
  });

  it('security-review npm audit and dependency allowlist gate on dependencies_touched (fail-closed: != false)', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const job = workflow.jobs['security-checks'];
    for (const step of ['npm audit', 'Dependency allowlist']) {
      const condition = getStepIf(job, step);
      // Fail-closed: only explicit 'false' skips; blank/missing output keeps the gate running.
      expect(condition, `${step} must gate on dependencies_touched != false`).toContain(
        "dependencies_touched != 'false'",
      );
      // The old fail-open form must not be present.
      expect(condition, `${step} must not use fail-open == true`).not.toContain(
        "dependencies_touched == 'true'",
      );
      expect(condition, `${step} must still run on non-PR events`).toContain(
        "github.event_name != 'pull_request'",
      );
    }
  });

  it('security-review secret scanning stays fail-closed (not gated on scope flags)', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const condition = getStepIf(workflow.jobs['security-checks'], 'Scan for committed secrets');
    // Secret scanning must run for every relevant PR change set: it must NOT be
    // gated on docs_only or dependencies_touched, only on train-promotion + not-cancelled.
    expect(condition).toContain("train_promoted != 'true'");
    expect(condition).not.toContain('dependencies_touched');
    expect(condition).not.toContain('docs_only');
  });

  it('security-checks job runs even when changes job fails (fail-closed: if: always())', () => {
    const workflow = loadWorkflow('.github/workflows/security-review.yml');
    const securityChecks = workflow.jobs['security-checks'];
    // Without if: always(), a failing changes job skips security-checks entirely —
    // that silently passes the security gate when scope detection is broken.
    expect(securityChecks?.if).toBe('always()');
  });
});
