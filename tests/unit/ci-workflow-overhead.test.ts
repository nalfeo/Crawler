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
  jobs: Record<string, WorkflowJob>;
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
    // and no npm audit (that lives in security-review.yml to avoid duplication)
    const advisory = workflow.jobs['ci-advisory'];
    expect(advisory?.steps?.find((step) => step.name === 'Dead code detection')).toBeTruthy();
    expect(advisory?.steps?.find((step) => step.name === 'Security audit')).toBeFalsy();
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
    // E2E has been split into three surface-targeted jobs (PR #1698).
    const allowSkippedJobs = [
      'Unit tests',
      'Integration tests',
      'Sprite pipeline tests',
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
    expect(needs).toContain('static-validation');
    expect(needs).toContain('test-unit');
    expect(needs).toContain('test-integration');
    expect(needs).toContain('test-headless');
    // E2E split into three surface-targeted jobs (PR #1698).
    expect(needs).toContain('test-e2e-game');
    expect(needs).toContain('test-e2e-assets');
    expect(needs).toContain('test-e2e-devtools');
    expect(needs).toContain('human-approval');
    // Old job names must not appear.
    expect(needs).not.toContain('check-types-and-lint');
    expect(needs).not.toContain('check-format-and-labs');
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
