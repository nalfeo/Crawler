import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_PATH = path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.mjs');
const ROUTER_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-recovery-router.yml');
const RECONCILE_TEST_PATH = path.join(REPO_ROOT, '.github/scripts/ci-recovery/reconcile.test.mjs');
const REVIEW_REQUEST_TEST_PATH = path.join(REPO_ROOT, '.github/scripts/ci-recovery/review-request.test.mjs');
const PR_CONCURRENCY_TEST_PATH = path.join(REPO_ROOT, 'tests/unit/pr-workflow-concurrency.test.ts');
const POLICY_PATH = path.join(REPO_ROOT, 'docs/agent-os/policies/ci-config-knobs.md');

describe('ci-config knobs + invariants guard', () => {
  it('router resolves runtime dispatch caps from env and keeps invariant defaults', () => {
    const source = readFileSync(ROUTER_PATH, 'utf8');
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
    const source = readFileSync(ROUTER_WORKFLOW_PATH, 'utf8');
    expect(source).toContain("CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY || '5' }}");
    expect(source).toContain("CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE || '8' }}");
    expect(source).toContain("CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: ${{ vars.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP || '5' }}");
    expect(source).toContain("CI_RECOVERY_MAX_DISPATCH_PER_RUN: ${{ vars.CI_RECOVERY_MAX_DISPATCH_PER_RUN || '8' }}");
  });

  it('policy doc enumerates every must-preserve invariant from the redesign baseline', () => {
    const source = readFileSync(POLICY_PATH, 'utf8');
    expect(source).toContain('Load-aware dispatch budget caps');
    expect(source).toContain('Review-round throttle');
    expect(source).toContain('Per-PR concurrency');
    expect(source).toContain('expected_head_sha fail-closed binding');
    expect(source).toContain('CI-fix-first + blocked-PR exclusion + global FIFO admission');
    expect(source).toContain('Superseded-run cancellation + impact-gated CI dispatch');
    expect(source).toContain('Thundering-herd backpressure and queue-aware sweep behavior');
  });

  it('named regression coverage exists for each invariant family', () => {
    const routerTests = readFileSync(path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.test.mjs'), 'utf8');
    const reconcileTests = readFileSync(RECONCILE_TEST_PATH, 'utf8');
    const reviewRequestTests = readFileSync(REVIEW_REQUEST_TEST_PATH, 'utf8');
    const concurrencyTests = readFileSync(PR_CONCURRENCY_TEST_PATH, 'utf8');

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
    expect(concurrencyTests).toContain('keeps PR groups isolated and separate from non-PR runs');
  });
});
