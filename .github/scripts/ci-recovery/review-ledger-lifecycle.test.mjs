import assert from 'node:assert/strict';
import test from 'node:test';

import { addedLedgerPaths, reviewLedgerBlockers } from './review-ledger-lifecycle.mjs';

const LEDGER = 'docs/knowledge/review-ledgers/2026-08-28-example.review-ledger.json';

const validLedger = JSON.stringify({
  schema_version: 'review-ledger/v2',
  date: '2026-08-28',
  session_slug: 'example',
  task_title: 'Example',
  estimated_apples: 1,
  stages: {},
});

test('addedLedgerPaths only returns newly added review ledgers', () => {
  assert.deepEqual(
    addedLedgerPaths([
      { status: 'added', filename: LEDGER },
      { status: 'modified', filename: LEDGER.replace('example', 'old') },
      { status: 'added', filename: 'src/core/example.ts' },
    ]),
    [LEDGER],
  );
});

test('reviewLedgerBlockers reports an invalid added ledger', async () => {
  const result = await reviewLedgerBlockers(
    [{ status: 'added', filename: LEDGER }],
    async () => '{"invalid":true}',
  );
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].kind, 'review-ledger');
  assert.equal(result.blockers[0].path, LEDGER);
  assert.match(result.blockers[0].summary, /review:ledger -- validate/);
});

test('reviewLedgerBlockers accepts a valid ledger and ignores a missing ledger', async () => {
  const valid = await reviewLedgerBlockers(
    [{ status: 'added', filename: LEDGER }],
    async () => validLedger,
  );
  assert.deepEqual(valid.blockers, []);

  const missing = await reviewLedgerBlockers(
    [{ status: 'added', filename: 'src/core/example.ts' }],
    async () => {
      throw new Error('must not fetch');
    },
  );
  assert.deepEqual(missing, { blockers: [], warnings: [] });
});

test('reviewLedgerBlockers treats transient content fetch failures as warnings', async () => {
  const result = await reviewLedgerBlockers([{ status: 'added', filename: LEDGER }], async () => {
    throw new Error('rate limited');
  });
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings[0], /rate limited/);
});
