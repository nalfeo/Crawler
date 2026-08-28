import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateEnvelope,
  transitionLease,
  validateRepository,
} from '../../scripts/agent/ci-contract-validation.mjs';

test('repository contract gate validates inventory, fixtures, and lease lifecycle', () => {
  assert.deepEqual(validateRepository(), { workflows: 6, fixtures: 7 });
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /ci-contract:/);
  assert.match(ci, /npm run validate:ci-contract/);
});

test('invalid or ambiguous state cannot become success-shaped', () => {
  const errors = validateEnvelope({
    contractVersion: 'v1',
    kind: 'state',
    repository: 'nalfeo/Crawler',
    resource: { repository: 'nalfeo/Crawler', prNumber: 1 },
    runId: 'run',
    headSha: '0'.repeat(40),
    lifecyclePhase: 'unknown',
    status: 'succeeded',
    disposition: 'blocked',
    action: 'none',
    outputs: {},
    error: null,
    timestamps: { observedAt: '2026-08-28T00:00:00Z' },
  });
  assert.ok(errors.includes('lifecyclePhase is unknown'));
  assert.ok(errors.includes('success must be acted or no-op'));
});

test('lease rejects stale-owner release and permits only bounded transitions', () => {
  assert.throws(
    () =>
      transitionLease('held', 'releasing', {
        ownerRunId: 'stale',
        leaseId: 'lease',
        currentOwnerRunId: 'new-owner',
        currentLeaseId: 'lease',
      }),
    /stale lease owner/,
  );
  assert.throws(() => transitionLease('absent', 'released', {}), /invalid lease transition/);
  assert.equal(transitionLease('expired', 'takeover', { now: 100 }), 'takeover');
});
