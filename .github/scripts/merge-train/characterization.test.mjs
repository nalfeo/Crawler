import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  admissionFingerprint,
  planPrefixPromotion,
  queueEntries,
  shouldWaitForCiConflictOrder,
  unsatisfiedChecks,
} from './state.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(DIR, 'characterization', 'verdict-fixtures.json');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

test('merge-train characterization fixtures are tagged and deterministic', () => {
  const fixture = loadFixture();
  assert.equal(fixture.verdict_fixtures.length, 11);
  for (const entry of fixture.verdict_fixtures) {
    assert.match(entry.id, /^MT\d{2}$/);
    assert.match(entry.dClass, /^D([1-9]|10)$/);
  }
});

test('merge-train fixture verdicts match current pure-function behavior', () => {
  const fixture = loadFixture();
  for (const entry of fixture.verdict_fixtures) {
    if (entry.kind === 'queueEntries') {
      const ordered = queueEntries(entry.input.pulls, entry.input.repository).map(
        (pull) => pull.number,
      );
      assert.deepEqual(ordered, entry.expected.orderedNumbers, entry.id);
      continue;
    }
    if (entry.kind === 'waitLabel') {
      assert.equal(shouldWaitForCiConflictOrder(entry.input.labels), entry.expected.wait, entry.id);
      continue;
    }
    if (entry.kind === 'admissionFingerprintStable') {
      const left = admissionFingerprint({
        headSha: entry.input.args.headSha,
        title: entry.input.args.title,
        baseRef: entry.input.args.baseRef,
        checkRuns: entry.input.args.checkRunsA,
        requiredNames: entry.input.args.requiredNames,
        reviewThreads: entry.input.args.threads,
      });
      const right = admissionFingerprint({
        headSha: entry.input.args.headSha,
        title: entry.input.args.title,
        baseRef: entry.input.args.baseRef,
        checkRuns: entry.input.args.checkRunsB,
        requiredNames: entry.input.args.requiredNames,
        reviewThreads: entry.input.args.threads,
      });
      assert.equal(left === right, entry.expected.equal, entry.id);
      continue;
    }
    if (entry.kind === 'planPrefixPromotion') {
      const plan = planPrefixPromotion(entry.input.states);
      assert.equal(plan.action, entry.expected.action, entry.id);
      // Only assert greenPrefixLength and firstFailure when the fixture declares them,
      // so noop/wait/validate entries don't require fields they don't have.
      if (entry.expected.greenPrefixLength !== undefined) {
        assert.equal(plan.greenPrefixLength, entry.expected.greenPrefixLength, entry.id);
      }
      if (entry.expected.firstFailure !== undefined) {
        assert.equal(plan.firstFailure, entry.expected.firstFailure, entry.id);
      }
      continue;
    }
    if (entry.kind === 'unsatisfiedChecks') {
      assert.deepEqual(
        unsatisfiedChecks(entry.input.runs, entry.input.required),
        entry.expected.missing,
        entry.id,
      );
      continue;
    }
    assert.fail(`unknown fixture kind ${entry.kind}`);
  }
});
