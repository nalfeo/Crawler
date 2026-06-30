import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrereqs, summarizePrereqResult } from './pr-prereq-check.mjs';

const CODE_FILE = 'src/core/components/movement.ts';
const HANDOFF = 'docs/knowledge/handoffs/2026-06-29-prereq-check.md';
const LEDGER = 'docs/knowledge/review-ledgers/2026-06-29-prereq-check.review-ledger.json';

test('summarizePrereqResult returns ok=true when both checks pass', () => {
  const r = summarizePrereqResult({ decision: 'allow' }, { decision: 'allow' });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
});

test('summarizePrereqResult surfaces both failure sections', () => {
  const r = summarizePrereqResult(
    { decision: 'deny', reason: 'handoff missing' },
    { decision: 'deny', reason: 'ledger missing' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0], /\[pr-preflight\]/);
  assert.match(r.failures[1], /\[pr-review-ledger\]/);
});

test('evaluatePrereqs fails when code diff has no handoff and no ledger', () => {
  const r = evaluatePrereqs([CODE_FILE], [], '.');
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /No new handoff file added/);
  assert.match(r.failures.join('\n'), /No review ledger found/);
});

test('evaluatePrereqs passes when handoff + valid 1-apple ledger are added', () => {
  const r = evaluatePrereqs([CODE_FILE, HANDOFF, LEDGER], [HANDOFF, LEDGER], '.', {
    validateFile: () => ({ ok: true, summary: 'valid 1-apple ledger', errors: [] }),
  });
  assert.equal(r.ok, true);
});

test('evaluatePrereqs skips ledger for docs-only changes', () => {
  const r = evaluatePrereqs(['docs/knowledge/handoffs/2026-06-29-note.md'], [], '.');
  assert.equal(r.ok, true);
  assert.match(r.notes.join('\n'), /review ledger not required|docs\/art\/deps-only/);
});
