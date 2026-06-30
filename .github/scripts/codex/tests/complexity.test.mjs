import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRepairComplexity, getRepairBudgets } from '../utils.mjs';

const DEFAULTS = {
  enabled: true,
  maxChangedFiles: 20,
  maxDiffLines: 1500,
  maxFailingChecks: 6,
};

test('getRepairBudgets returns documented defaults for an empty env', () => {
  assert.deepEqual(getRepairBudgets({}), DEFAULTS);
});

test('getRepairBudgets reads overrides and coerces integers', () => {
  const budgets = getRepairBudgets({
    CODEX_BOUNCE_ENABLED: 'false',
    CODEX_BOUNCE_MAX_CHANGED_FILES: '5',
    CODEX_BOUNCE_MAX_DIFF_LINES: '100',
    CODEX_BOUNCE_MAX_FAILING_CHECKS: '2',
  });
  assert.deepEqual(budgets, {
    enabled: false,
    maxChangedFiles: 5,
    maxDiffLines: 100,
    maxFailingChecks: 2,
  });
});

test('getRepairBudgets falls back to defaults for non-numeric overrides', () => {
  const budgets = getRepairBudgets({ CODEX_BOUNCE_MAX_CHANGED_FILES: 'lots' });
  assert.equal(budgets.maxChangedFiles, 20);
});

test('a small PR within all budgets is not bounced', () => {
  const result = evaluateRepairComplexity(
    { changedFiles: 3, additions: 40, deletions: 10, failingChecks: 1 },
    getRepairBudgets({}),
  );
  assert.equal(result.tooComplex, false);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.metrics, { changedFiles: 3, diffLines: 50, failingChecks: 1 });
});

test('exceeding the changed-files budget bounces with a reason', () => {
  const result = evaluateRepairComplexity(
    { changedFiles: 21, additions: 10, deletions: 0, failingChecks: 0 },
    getRepairBudgets({}),
  );
  assert.equal(result.tooComplex, true);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /21 changed files exceeds budget of 20/);
});

test('the changed-files budget is inclusive at the boundary', () => {
  const atLimit = evaluateRepairComplexity(
    { changedFiles: 20, additions: 0, deletions: 0, failingChecks: 0 },
    getRepairBudgets({}),
  );
  assert.equal(atLimit.tooComplex, false);
});

test('diff lines combine additions and deletions', () => {
  const result = evaluateRepairComplexity(
    { changedFiles: 1, additions: 800, deletions: 701, failingChecks: 0 },
    getRepairBudgets({}),
  );
  assert.equal(result.metrics.diffLines, 1501);
  assert.equal(result.tooComplex, true);
  assert.match(result.reasons[0], /1501 changed lines exceeds budget of 1500/);
});

test('too many failing checks bounces', () => {
  const result = evaluateRepairComplexity(
    { changedFiles: 1, additions: 1, deletions: 0, failingChecks: 7 },
    getRepairBudgets({}),
  );
  assert.equal(result.tooComplex, true);
  assert.match(result.reasons[0], /7 failing checks exceeds budget of 6/);
});

test('multiple exceeded budgets are all reported', () => {
  const result = evaluateRepairComplexity(
    { changedFiles: 50, additions: 2000, deletions: 500, failingChecks: 10 },
    getRepairBudgets({}),
  );
  assert.equal(result.tooComplex, true);
  assert.equal(result.reasons.length, 3);
});

test('a negative budget disables that single dimension', () => {
  const budgets = getRepairBudgets({ CODEX_BOUNCE_MAX_CHANGED_FILES: '-1' });
  const result = evaluateRepairComplexity(
    { changedFiles: 999, additions: 0, deletions: 0, failingChecks: 0 },
    budgets,
  );
  assert.equal(result.tooComplex, false);
});

test('disabling bouncing never marks a PR too complex', () => {
  const budgets = getRepairBudgets({ CODEX_BOUNCE_ENABLED: 'false' });
  const result = evaluateRepairComplexity(
    { changedFiles: 999, additions: 9999, deletions: 9999, failingChecks: 99 },
    budgets,
  );
  assert.equal(result.tooComplex, false);
  assert.ok(result.reasons.length > 0, 'reasons are still computed for transparency');
});

test('missing metrics are treated as zero', () => {
  const result = evaluateRepairComplexity({}, getRepairBudgets({}));
  assert.equal(result.tooComplex, false);
  assert.deepEqual(result.metrics, { changedFiles: 0, diffLines: 0, failingChecks: 0 });
});
