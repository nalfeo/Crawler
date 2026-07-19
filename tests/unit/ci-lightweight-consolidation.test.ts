import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Workflow-policy tests for the lightweight CI consolidation (issue #1703).
 *
 * Verifies that:
 * - check-lightweight job replaces the 4 former lightweight jobs (check-types-and-lint,
 *   check-format-and-labs, ci-advisory, human-approval) and is in the merge-gate.
 * - Advisory steps within check-lightweight have continue-on-error: true and
 *   an if: condition so failures remain visible but non-blocking.
 * - Advisory steps are additionally gated on GAMEPLAY_SAFE != 'true' to avoid
 *   shifting the bottleneck for scope-limited PR classes.
 * - Docs-only PRs skip check-lightweight (merge-gate treats the skip as PASS).
 * - The human-approval-rerun.yml automation looks for 'Lightweight Checks' (not
 *   the former 'Human approval' job) to detect approval-state divergence.
 *
 * This test parses real workflow YAML rather than re-implementing the logic, so a
 * wording change to a job name or condition will be caught automatically.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── helpers ──────────────────────────────────────────────────────────────────

function loadCiWorkflow(): {
  jobs: Record<
    string,
    {
      name?: string;
      needs?: string | string[];
      if?: string;
      env?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
        'continue-on-error'?: boolean;
      }>;
    }
  >;
} {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  return parse(raw) as ReturnType<typeof loadCiWorkflow>;
}

function loadHumanApprovalRerunWorkflow(): {
  jobs: Record<string, { steps?: Array<{ with?: { script?: string } }> }>;
} {
  const raw = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/human-approval-rerun.yml'),
    'utf8',
  );
  return parse(raw) as ReturnType<typeof loadHumanApprovalRerunWorkflow>;
}

// ── ci.yml: check-lightweight job ─────────────────────────────────────────────

describe('ci.yml — check-lightweight job exists and consolidates former jobs', () => {
  it('has a check-lightweight job (formerly check-types-and-lint, check-format-and-labs, ci-advisory, human-approval)', () => {
    const doc = loadCiWorkflow();
    expect(doc.jobs['check-lightweight'], 'check-lightweight job').toBeDefined();
  });

  it('does NOT have the former jobs that were consolidated', () => {
    const doc = loadCiWorkflow();
    expect(doc.jobs['check-types-and-lint'], 'check-types-and-lint should be gone').toBeUndefined();
    expect(
      doc.jobs['check-format-and-labs'],
      'check-format-and-labs should be gone',
    ).toBeUndefined();
    expect(doc.jobs['ci-advisory'], 'ci-advisory should be gone').toBeUndefined();
    expect(doc.jobs['human-approval'], 'human-approval should be gone').toBeUndefined();
  });

  it('is named "Lightweight Checks" (the name the rerun automation looks up)', () => {
    const doc = loadCiWorkflow();
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    expect(job.name).toBe('Lightweight Checks');
  });

  it('needs [changes] and is scope-gated on docs_only != true', () => {
    const doc = loadCiWorkflow();
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs ?? ''];
    expect(needs).toContain('changes');
    expect(String(job.if ?? '')).toContain("docs_only != 'true'");
  });

  it('exposes GAMEPLAY_SAFE env var from changes outputs at job level', () => {
    const doc = loadCiWorkflow();
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    expect(job.env?.GAMEPLAY_SAFE).toContain('needs.changes.outputs.gameplay_safe');
  });
});

// ── ci.yml: blocking steps ────────────────────────────────────────────────────

describe('ci.yml — check-lightweight blocking steps', () => {
  function getSteps(doc: ReturnType<typeof loadCiWorkflow>) {
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    return job.steps ?? [];
  }

  it('installs Playwright (required by guard tests that use chromium)', () => {
    const doc = loadCiWorkflow();
    const setupStep = getSteps(doc).find((s) => s.uses?.includes('setup-node'));
    if (!setupStep) throw new Error('setup-node step not found');
    expect(setupStep.with?.['install-playwright']).toBe('true');
  });

  it('contains all required blocking step names', () => {
    const doc = loadCiWorkflow();
    const stepNames = getSteps(doc)
      .map((s) => s.name)
      .filter(Boolean);
    for (const expected of [
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
      'Typecheck & Lint',
      'Human approval',
    ]) {
      expect(stepNames, `blocking step "${expected}"`).toContain(expected);
    }
  });

  it('blocking steps do NOT have continue-on-error', () => {
    const doc = loadCiWorkflow();
    const blockingNames = new Set([
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
      'Typecheck & Lint',
      'Human approval',
    ]);
    const steps = getSteps(doc).filter((s) => s.name && blockingNames.has(s.name));
    for (const step of steps) {
      expect(
        step['continue-on-error'],
        `blocking step "${step.name}" must not have continue-on-error`,
      ).toBeFalsy();
    }
  });

  it('Human approval step has GITHUB_TOKEN env and runs the human-approval-check script', () => {
    const doc = loadCiWorkflow();
    const step = getSteps(doc).find((s) => s.name === 'Human approval');
    if (!step) throw new Error('Human approval step not found');
    expect(step.env?.GITHUB_TOKEN).toContain('GITHUB_TOKEN');
    expect(step.run).toContain('human-approval-check.mjs');
  });
});

// ── ci.yml: advisory steps ────────────────────────────────────────────────────

describe('ci.yml — check-lightweight advisory steps are non-blocking', () => {
  function getSteps(doc: ReturnType<typeof loadCiWorkflow>) {
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    return job.steps ?? [];
  }

  it('advisory steps have continue-on-error: true', () => {
    const doc = loadCiWorkflow();
    const advisoryNames = [
      'Dead code detection',
      'Security audit',
      'Typecheck (full — tests + scripts)',
    ];
    for (const name of advisoryNames) {
      const step = getSteps(doc).find((s) => s.name === name);
      if (!step) throw new Error(`advisory step "${name}" not found`);
      expect(
        step['continue-on-error'],
        `advisory step "${name}" must have continue-on-error: true`,
      ).toBe(true);
    }
  });

  it('advisory steps run even if blocking steps failed (if: always())', () => {
    const doc = loadCiWorkflow();
    const advisoryNames = [
      'Dead code detection',
      'Security audit',
      'Typecheck (full — tests + scripts)',
    ];
    for (const name of advisoryNames) {
      const step = getSteps(doc).find((s) => s.name === name);
      if (!step) throw new Error(`advisory step "${name}" not found`);
      expect(String(step.if ?? ''), `advisory step "${name}" if condition`).toContain('always()');
    }
  });

  it('advisory steps are gated on GAMEPLAY_SAFE != true to avoid critical-path regression', () => {
    const doc = loadCiWorkflow();
    const advisoryNames = [
      'Dead code detection',
      'Security audit',
      'Typecheck (full — tests + scripts)',
    ];
    for (const name of advisoryNames) {
      const step = getSteps(doc).find((s) => s.name === name);
      if (!step) throw new Error(`advisory step "${name}" not found`);
      const ifExpr = String(step.if ?? '');
      expect(ifExpr, `advisory step "${name}" must skip on gameplay_safe`).toContain(
        'GAMEPLAY_SAFE',
      );
    }
  });
});

// ── ci.yml: merge-gate ────────────────────────────────────────────────────────

describe('ci.yml — merge-gate uses check-lightweight', () => {
  it('merge-gate needs check-lightweight (not the former jobs)', () => {
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    const needs = Array.isArray(mergeGate.needs) ? mergeGate.needs : [mergeGate.needs ?? ''];
    expect(needs).toContain('check-lightweight');
    // Former jobs must not be in needs
    for (const former of ['check-types-and-lint', 'check-format-and-labs', 'human-approval']) {
      expect(needs, `merge-gate must not need former job "${former}"`).not.toContain(former);
    }
  });

  it('merge-gate check function references Lightweight Checks (success case)', () => {
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    const mergeGateStep = (mergeGate.steps ?? [])[0];
    if (!mergeGateStep) throw new Error('merge-gate step[0] not found');
    const script = String(mergeGateStep.run ?? '');
    expect(script).toContain('Lightweight Checks');
    expect(script).toContain('check-lightweight');
  });

  it('merge-gate does NOT call check() for the former job names (Types & Lint, Format & Labs, Human approval)', () => {
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    const mergeGateStep = (mergeGate.steps ?? [])[0];
    if (!mergeGateStep) throw new Error('merge-gate step[0] not found');
    const script = String(mergeGateStep.run ?? '');
    // These were the former check() invocations — they must be gone.
    // The strings may appear in comments but not as check() calls.
    expect(script).not.toMatch(/check "Types & Lint"/);
    expect(script).not.toMatch(/check "Format & Labs"/);
    expect(script).not.toMatch(/check "Human approval"/);
  });

  it('merge-gate has always() condition so it runs regardless of upstream outcomes', () => {
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    expect(String(mergeGate.if ?? '')).toContain('always()');
  });

  it('merge-gate docs-only skip logic covers check-lightweight', () => {
    // Verifies that the merge-gate script still has the docs-only skip path
    // so a docs-only PR (where check-lightweight is skipped) still passes.
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    const mergeGateStep = (mergeGate.steps ?? [])[0];
    if (!mergeGateStep) throw new Error('merge-gate step[0] not found');
    const script = String(mergeGateStep.run ?? '');
    expect(script).toContain('docs_only');
    expect(script).toContain('skipped — docs-only change');
  });
});

// ── human-approval-rerun.yml ──────────────────────────────────────────────────

describe('human-approval-rerun.yml — looks for Lightweight Checks job', () => {
  it('automation script references Lightweight Checks, not Human approval', () => {
    const doc = loadHumanApprovalRerunWorkflow();
    const rerunJob = doc.jobs['rerun'];
    if (!rerunJob) throw new Error('rerun job not found');
    const scriptStep = rerunJob.steps?.find((s) => s.with?.script);
    if (!scriptStep) throw new Error('github-script step not found');
    const script = String(scriptStep.with?.script ?? '');
    expect(script).toContain('Lightweight Checks');
    expect(script).not.toContain("'Human approval'");
  });
});
