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
 * - Docs-only PRs do NOT skip check-lightweight at the job level (the human-approval
 *   step must run unconditionally). Instead, non-approval blocking steps carry their
 *   own DOCS_ONLY step-level conditions so build/lint work is still skipped for
 *   documentation-only changes.
 * - The human-approval-rerun.yml automation looks for 'Lightweight Checks' (not the
 *   former 'Human approval' job) AND at the step-level conclusion to avoid rerun loops
 *   when a non-approval blocking step (e.g. lint) fails with approval already granted.
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

  it('needs [changes] but does NOT have a job-level docs_only skip (human-approval must run on all PRs)', () => {
    const doc = loadCiWorkflow();
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs ?? ''];
    expect(needs).toContain('changes');
    // No job-level docs_only gate — the human-approval step must run unconditionally.
    expect(String(job.if ?? '')).not.toContain('docs_only');
  });

  it('exposes GAMEPLAY_SAFE and DOCS_ONLY env vars from changes outputs at job level', () => {
    const doc = loadCiWorkflow();
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    expect(job.env?.GAMEPLAY_SAFE).toContain('needs.changes.outputs.gameplay_safe');
    expect(job.env?.DOCS_ONLY).toContain('needs.changes.outputs.docs_only');
  });
});

// ── ci.yml: blocking steps ────────────────────────────────────────────────────

describe('ci.yml — check-lightweight blocking steps', () => {
  function getSteps(doc: ReturnType<typeof loadCiWorkflow>) {
    const job = doc.jobs['check-lightweight'];
    if (!job) throw new Error('check-lightweight job not found');
    return job.steps ?? [];
  }

  it('installs Playwright conditionally: true for non-docs PRs, false for docs-only', () => {
    const doc = loadCiWorkflow();
    const setupStep = getSteps(doc).find((s) => s.uses?.includes('setup-node'));
    if (!setupStep) throw new Error('setup-node step not found');
    // The value is a GitHub Actions expression that resolves to 'true' for non-docs
    // and 'false' for docs-only PRs (guard tests use chromium; docs-only skips them).
    const playwrightInput = String(setupStep.with?.['install-playwright'] ?? '');
    expect(playwrightInput).toContain('docs_only');
    expect(playwrightInput).toContain("'true'");
    expect(playwrightInput).toContain("'false'");
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

  it('Orphaned-system wiring guard step has GITHUB_TOKEN env and runs the wired-systems check', () => {
    const doc = loadCiWorkflow();
    const step = getSteps(doc).find((s) => s.name === 'Orphaned-system wiring guard');
    if (!step) throw new Error('Orphaned-system wiring guard step not found');
    expect(['${{ github.token }}', '${{ secrets.GITHUB_TOKEN }}']).toContain(
      step.env?.GITHUB_TOKEN,
    );
    expect(step.run).toContain('npm run check:wired-systems');
  });

  it('Human approval step does NOT have a DOCS_ONLY guard (must run even on docs-only PRs)', () => {
    const doc = loadCiWorkflow();
    const step = getSteps(doc).find((s) => s.name === 'Human approval');
    if (!step) throw new Error('Human approval step not found');
    expect(String(step.if ?? '')).not.toContain('DOCS_ONLY');
  });

  it('all non-approval blocking steps have if: env.DOCS_ONLY != true so they skip on docs-only PRs', () => {
    const doc = loadCiWorkflow();
    const nonApprovalBlocking = [
      'Format check',
      'Lab gate check',
      'Orphaned-system wiring guard',
      'Guard + review-ledger tests',
      'Typecheck & Lint',
    ];
    for (const name of nonApprovalBlocking) {
      const step = getSteps(doc).find((s) => s.name === name);
      if (!step) throw new Error(`blocking step "${name}" not found`);
      expect(
        String(step.if ?? ''),
        `blocking step "${name}" must have DOCS_ONLY step-level guard`,
      ).toContain('DOCS_ONLY');
    }
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

  it('merge-gate has !cancelled() condition so it runs regardless of upstream failures but stops on cancellation', () => {
    const doc = loadCiWorkflow();
    const mergeGate = doc.jobs['merge-gate'];
    if (!mergeGate) throw new Error('merge-gate job not found');
    expect(String(mergeGate.if ?? '')).toContain('!cancelled()');
  });

  it('merge-gate docs-only skip logic is present (skipped check-lightweight result is tolerated)', () => {
    // check-lightweight now runs on all PRs (no job-level docs_only skip).
    // However, on docs-only PRs the merge-gate still tolerates a 'skipped'
    // result (from earlier CI history or corner cases) via the standard
    // docs-only skip logic in the check() shell function.
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

describe('human-approval-rerun.yml — step-level approval lookup prevents rerun loops', () => {
  it('pull_request_review trigger keys owner checks to the review author, not actor', () => {
    const doc = loadHumanApprovalRerunWorkflow();
    const rerunJob = doc.jobs['rerun'];
    if (!rerunJob) throw new Error('rerun job not found');
    const condition = String((rerunJob as { if?: string }).if ?? '');
    expect(condition).toContain('github.event.review.user.login == github.repository_owner');
    expect(condition).not.toContain(
      "github.event_name == 'pull_request_review'\n        && github.actor == github.repository_owner",
    );
  });

  it('automation script references Lightweight Checks, not Human approval job', () => {
    const doc = loadHumanApprovalRerunWorkflow();
    const rerunJob = doc.jobs['rerun'];
    if (!rerunJob) throw new Error('rerun job not found');
    const scriptStep = rerunJob.steps?.find((s) => s.with?.script);
    if (!scriptStep) throw new Error('github-script step not found');
    const script = String(scriptStep.with?.script ?? '');
    expect(script).toContain('Lightweight Checks');
    // Must NOT use the old job-level lookup "job.name === 'Human approval'"
    // ('Human approval' may still appear as the step name in a step-level lookup
    // which is the correct, non-looping approach).
    expect(script).not.toMatch(/job\.name === 'Human approval'/);
  });

  it('automation inspects the step-level conclusion (not just job conclusion) to avoid rerun loops', () => {
    const doc = loadHumanApprovalRerunWorkflow();
    const rerunJob = doc.jobs['rerun'];
    if (!rerunJob) throw new Error('rerun job not found');
    const scriptStep = rerunJob.steps?.find((s) => s.with?.script);
    if (!scriptStep) throw new Error('github-script step not found');
    const script = String(scriptStep.with?.script ?? '');
    // The script must look for the "Human approval" step within the job.
    expect(script).toContain("step.name === 'Human approval'");
    // The script must treat a 'skipped' step as a non-rerun condition so that
    // when lint/format fails before the approval step, approval reruns don't loop.
    expect(script).toContain("'skipped'");
  });
});
