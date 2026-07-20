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
    expect(needs).toContain('check-lightweight');
    expect(needs).toContain('test-unit');
    expect(needs).toContain('test-integration');
    expect(needs).toContain('test-headless');
    expect(needs).toContain('test-e2e');
    // Old job names and superseded jobs must not appear.
    expect(needs).not.toContain('static-validation');
    expect(needs).not.toContain('check-types-and-lint');
    expect(needs).not.toContain('check-format-and-labs');
    expect(needs).not.toContain('human-approval');
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
