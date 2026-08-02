// Tests for the review-ledger CLI. Most cases spawn the real CLI and assert on
// exit code + stderr, hitting a validation failure path that returns BEFORE any
// file IO (those never touch disk). The init-scaffold cases at the bottom run
// `init` with cwd set to an OS temp dir (never the repo) and assert the
// generated ledger's stage shape (ADR 0051).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

function runCli(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

test('init: bare --apples (no value) is rejected, not coerced to 1', () => {
  const r = runCli(['init', '--apples', '--slug', 'x', '--title', 'T']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--apples requires a value/);
});

test('init: --apples out of range is rejected (=-form parsing works)', () => {
  const r = runCli(['init', '--apples=7', '--slug=x', '--title=T']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /integer 1\.\.5/);
});

test('init: --date with path traversal is rejected', () => {
  const r = runCli(['init', '--apples=4', '--slug=x', '--title=T', '--date=../../evil']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--date must be a YYYY-MM-DD string/);
});

test('init: bare --slug (no value) is rejected', () => {
  const r = runCli(['init', '--apples=4', '--slug', '--title=T']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--slug must be kebab-case/);
});

test('stage: unknown stage name is rejected before mutating the ledger', () => {
  const r = runCli(['stage', 'some/path.json', 'code_reviev', '--json', '{}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown stage 'code_reviev'/);
  assert.match(r.stderr, /plan_review, dual_plan_synthesis, code_review, multi_model_review/);
});

test('unknown subcommand prints usage and exits non-zero', () => {
  const r = runCli(['bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: review:ledger/);
});

// --- init scaffold shape (ADR 0051). Runs in an OS temp dir, never the repo. ---

function initLedgerInTemp(apples) {
  const dir = mkdtempSync(join(tmpdir(), 'review-ledger-cli-'));
  try {
    execFileSync(
      'node',
      [CLI, 'init', `--apples=${apples}`, '--slug=scaffold-test', '--title=T', '--date=2026-07-08'],
      { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const p = join(
      dir,
      'docs',
      'knowledge',
      'review-ledgers',
      '2026-07-08-scaffold-test.review-ledger.json',
    );
    return JSON.parse(readFileSync(p, 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('init at 4🍎 scaffolds adversarial plan_review + no dual_plan_synthesis (ADR 0051)', () => {
  const led = initLedgerInTemp(4);
  assert.deepEqual(Object.keys(led.stages), [
    'plan_review',
    'code_review',
    'multi_model_review',
    'independent_grade',
  ]);
  assert.equal('dual_plan_synthesis' in led.stages, false);
  // adversarial + instrumentation fields scaffolded as invalid placeholders to force the author to fill them.
  assert.equal(led.stages.plan_review.adversarial, false);
  assert.equal(led.stages.plan_review.alternatives_considered, 0);
  assert.equal(led.stages.plan_review.plan_divergence, '');
});

test('init at 3🍎 scaffolds plan_divergence but NOT adversarial/alternatives (ADR 0051)', () => {
  const led = initLedgerInTemp(3);
  assert.deepEqual(Object.keys(led.stages), ['plan_review', 'code_review', 'independent_grade']);
  assert.equal(led.stages.plan_review.plan_divergence, '');
  assert.equal('adversarial' in led.stages.plan_review, false);
  assert.equal('alternatives_considered' in led.stages.plan_review, false);
});

test('init at 2🍎 scaffolds no required stages', () => {
  const led = initLedgerInTemp(2);
  assert.deepEqual(led.stages, {});
});

test('init at 3🍎 scaffolds independent_grade with placeholders the grader CLI must fill', () => {
  const led = initLedgerInTemp(3);
  const grade = led.stages.independent_grade;
  assert.equal(grade.completed, false);
  assert.equal(grade.grader_model, '');
  assert.equal(grade.head_sha, '');
  assert.deepEqual(grade.criteria, {});
});

test('init at 2🍎 scaffolds no independent_grade', () => {
  const led = initLedgerInTemp(2);
  assert.equal('independent_grade' in led.stages, false);
});
