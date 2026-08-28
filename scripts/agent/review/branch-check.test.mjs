import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateAddedBranchLedgers } from './branch-check.mjs';

test('branch ledger validation skips outside pull-request context', () => {
  const result = validateAddedBranchLedgers({
    cwd: '/repo',
    baseSha: '',
    headSha: '',
    git: () => {
      throw new Error('must not run');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test('branch ledger validation succeeds when no ledger was added', () => {
  const result = validateAddedBranchLedgers({
    cwd: '/repo',
    baseSha: 'base',
    headSha: 'head',
    git: () => 'src/core/example.ts\n',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

test('branch ledger validation fails for an invalid added ledger', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'crawler-ledger-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = 'docs/knowledge/review-ledgers/2026-08-28-invalid.review-ledger.json';
  const absolutePath = join(cwd, path);
  mkdirSync(join(cwd, 'docs/knowledge/review-ledgers'), { recursive: true });
  writeFileSync(absolutePath, '{"invalid":true}');
  const result = validateAddedBranchLedgers({
    cwd,
    baseSha: 'base',
    headSha: 'head',
    git: () => `${path}\n`,
  });
  assert.equal(result.ok, false);
  assert.match(result.results[0].result.errors.join('\n'), /schema_version/);
});
