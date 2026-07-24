import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTER_PATH = '.github/scripts/ci-recovery/router.mjs';
const ROUTER_WORKFLOW_PATH = '.github/workflows/ci-recovery-router.yml';
const ROUTER_TEST_PATH = '.github/scripts/ci-recovery/router.test.mjs';
const RECONCILE_TEST_PATH = '.github/scripts/ci-recovery/reconcile.test.mjs';
const REVIEW_REQUEST_TEST_PATH = '.github/scripts/ci-recovery/review-request.test.mjs';
const PR_CONCURRENCY_TEST_PATH = 'tests/unit/pr-workflow-concurrency.test.ts';
const CI_GATING_POLICY_TEST_PATH = 'tests/unit/ci-gating-policy.test.ts';
const CI_WORKFLOW_OVERHEAD_TEST_PATH = 'tests/unit/ci-workflow-overhead.test.ts';
const SWEEP_WORKFLOW_BUDGET_TEST_PATH = 'tests/unit/sweep-workflow-budget.test.ts';
const AI_SWEEP_WORKFLOW_TEST_PATH = 'tests/unit/ai-sweep-workflow.test.ts';
const POLICY_PATH = 'docs/agent-os/policies/ci-config-knobs.md';

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

// Exhaustive allowlist of exported numeric-literal constants per harness file.
// Adding a new constant to any of these files without registering it here will
// cause the scan test below to fail — forcing an explicit registration decision.
const NUMERIC_KNOBS: Record<string, string[]> = {
  '.github/scripts/ci-recovery/router.mjs': [
    'RUNNER_CEILING',
    'VALIDATION_RESERVED_TRAIN_BUSY',
    'VALIDATION_RESERVED_TRAIN_IDLE',
    'MAX_DISPATCH_BUDGET_TRAIN_BUSY',
    'MAX_DISPATCH_BUDGET_TRAIN_IDLE',
    'SWEEP_RUNNER_WEIGHT',
    'VALIDATION_RUNNER_WEIGHT',
    'REAPER_LANE_CAP',
  ],
  '.github/scripts/ci-recovery/state.mjs': [
    'DEFAULT_LEASE_TTL_MINUTES',
    'DEFAULT_LEASE_GRACE_MINUTES',
    'AUTOMATION_STALE_MINUTES',
  ],
  '.github/scripts/merge-train/state.mjs': ['MAX_TRAIN_SIZE', 'CANDIDATE_VALIDATION_STALE_MS'],
  '.github/scripts/ci-conflict-coordinator/state.mjs': [
    'MIN_CLUSTER_SIZE',
    'MAX_OVERLAP_FILES',
    'DISPATCH_LEASE_MS',
  ],
};

// Matches `export const UPPER_CASE = <numeric literal or arithmetic expression>;`
// Excludes derived constants (right-hand side starts with a letter, e.g. GLOBAL_FOO = OTHER_CONST).
const NUMERIC_EXPORT_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*\d/gm;

describe('CI harness knobs guard', () => {
  it('keeps ci-recovery dispatch budget knobs explicit and exported', () => {
    const source = read(ROUTER_PATH);
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5;');
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8;');
    expect(source).toContain('export const GLOBAL_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_BUSY;');
    expect(source).toContain(
      'export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_IDLE;',
    );
  });

  it('keeps ownership and train-size safety knobs pinned', () => {
    const recoveryState = read('.github/scripts/ci-recovery/state.mjs');
    const trainState = read('.github/scripts/merge-train/state.mjs');
    const conflictState = read('.github/scripts/ci-conflict-coordinator/state.mjs');

    expect(recoveryState).toContain('export const DEFAULT_LEASE_TTL_MINUTES = 30;');
    expect(recoveryState).toContain('export const DEFAULT_LEASE_GRACE_MINUTES = 5;');
    expect(recoveryState).toContain('export const AUTOMATION_STALE_MINUTES = 30;');

    expect(trainState).toContain('export const MAX_TRAIN_SIZE = 6;');

    expect(conflictState).toContain(
      'export const DISPATCH_LEASE_MS = 30 * 60 * 1000; // 30 minutes',
    );
  });

  it('scans all exported numeric-literal constants and rejects unregistered ones', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      const found = [...source.matchAll(NUMERIC_EXPORT_RE)].map((m) => m[1]);

      for (const name of found) {
        expect(
          allowlist,
          `Unregistered numeric constant '${name}' in ${filePath} — add it to NUMERIC_KNOBS or convert it to a structural (non-exported) constant`,
        ).toContain(name);
      }

      for (const name of allowlist) {
        expect(
          source,
          `Allowlisted constant '${name}' missing from ${filePath} — remove it from NUMERIC_KNOBS`,
        ).toMatch(new RegExp(`export const ${name}\\s*=`));
      }
    }
  });

  it('verifies each allowlisted constant is used within its own module (not an orphaned export)', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      for (const name of allowlist) {
        const occurrences = (source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        expect(
          occurrences,
          `Constant '${name}' in ${filePath} appears only once — it is declared but never used within its module`,
        ).toBeGreaterThan(1);
      }
    }
  });
});

describe('ci-config knobs + invariants guard', () => {
  it('router resolves runtime dispatch caps from env and keeps invariant defaults', () => {
    const source = read(ROUTER_PATH);
    expect(source).toContain('export function resolveGlobalDispatchCaps');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE');
    expect(source).toContain('CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_PER_RUN');
    expect(source).toContain('MAX_DISPATCH_BUDGET_TRAIN_BUSY');
    expect(source).toContain('MAX_DISPATCH_BUDGET_TRAIN_IDLE');
    expect(source).toContain('GLOBAL_TRAIN_DISPATCH_CAP');
    expect(source).toContain('DEFAULT_MAX_DISPATCH_PER_RUN');
  });

  it('router workflow wires knob vars with fail-closed defaults', () => {
    const source = read(ROUTER_WORKFLOW_PATH);
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY || '5' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE || '8' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: ${{ vars.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP || '5' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_PER_RUN: ${{ vars.CI_RECOVERY_MAX_DISPATCH_PER_RUN || '8' }}",
    );
  });

  it('policy doc enumerates every must-preserve invariant from the redesign baseline', () => {
    const source = read(POLICY_PATH);
    expect(source).toContain('Load-aware dispatch budget caps');
    expect(source).toContain('Review-round throttle');
    expect(source).toContain('Per-PR concurrency');
    expect(source).toContain('`expected_head_sha` fail-closed binding');
    expect(source).toContain('CI-fix-first + blocked-PR exclusion + global FIFO admission');
    expect(source).toContain('Superseded-run cancellation + impact-gated CI dispatch');
    expect(source).toContain('Thundering-herd backpressure and queue-aware sweep behavior');
  });

  it('named regression coverage exists for each invariant family', () => {
    const routerTests = read(ROUTER_TEST_PATH);
    const reconcileTests = read(RECONCILE_TEST_PATH);
    const reviewRequestTests = read(REVIEW_REQUEST_TEST_PATH);
    const concurrencyTests = read(PR_CONCURRENCY_TEST_PATH);
    const ciGatingPolicyTests = read(CI_GATING_POLICY_TEST_PATH);
    const ciWorkflowOverheadTests = read(CI_WORKFLOW_OVERHEAD_TEST_PATH);
    const sweepWorkflowBudgetTests = read(SWEEP_WORKFLOW_BUDGET_TEST_PATH);
    const aiSweepWorkflowTests = read(AI_SWEEP_WORKFLOW_TEST_PATH);

    expect(routerTests).toContain(
      '25 concurrent router-trigger events are bounded by runner headroom while the train queue is non-empty',
    );
    expect(routerTests).toContain(
      'flag-off schedule dispatches CI-fix PRs before normal PRs, both oldest-first',
    );
    expect(routerTests).toContain('flag-off schedule sweeps exclude blocked-labeled PRs from dispatch');
    expect(routerTests).toContain('flag-off sweeps order PRs oldest-first (global FIFO) across sweeps');
    expect(routerTests).toContain(
      'runFromEnv respects runtime busy/global caps under a simulated schedule burst',
    );
    expect(reviewRequestTests).toContain('allows exactly one review per conflict episode');
    expect(reconcileTests).toContain(
      'expected_head_sha mismatch: reconcile fails closed before any mutation, even in live mode',
    );
    expect(reconcileTests).toContain(
      'reconcile ignores stale action-required run when a newer run of the same workflow succeeded',
    );
    expect(reconcileTests).toContain(
      'reconcile escalates required-check action-required runs as ci-retrigger blockers',
    );
    expect(concurrencyTests).toContain('cancels superseded runs only for pull_request');
    expect(concurrencyTests).toContain('keeps PR groups isolated and separate from non-PR runs');
    expect(ciGatingPolicyTests).toContain(
      'ci-coverage skips on PR only when coverage_touched is explicitly false (fail-closed)',
    );
    expect(ciWorkflowOverheadTests).toContain(
      'scope-gated jobs carry allow_skipped=true so art/sprites-only changes pass',
    );
    expect(sweepWorkflowBudgetTests).toContain(
      'gives every job a non-cancelling global semaphore token',
    );
    expect(aiSweepWorkflowTests).toContain(
      'stays read-only with only the metadata permissions required by queue-aware admission and cross-run artifact download',
    );
  });
});
