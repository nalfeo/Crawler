// Tests for the review-ledger CLI input hardening. These spawn the real CLI
// and assert on exit code + stderr. Every case here hits a validation failure
// path that returns BEFORE any file IO, so the tests never write to the repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
