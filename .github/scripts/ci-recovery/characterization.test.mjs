import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { automationStallAction, isDuplicateDispatch, isLeaseExpired } from './state.mjs';
import { shouldRequestReview } from './review-request.mjs';
import { isRepairWakeEligible } from './router.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(DIR, 'characterization', 'reconcile-decision-fixtures.json');
const RECONCILE_TEST_PATH = path.join(DIR, 'reconcile.test.mjs');
const REVIEW_REQUEST_TEST_PATH = path.join(DIR, 'review-request.test.mjs');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

test('characterization fixture pins exactly 34 reconcile decision points with D-class tags', () => {
  const fixture = loadFixture();
  const decisions = fixture.decision_points;
  assert.equal(decisions.length, 34);

  const ids = new Set(decisions.map((entry) => entry.id));
  assert.equal(ids.size, 34);

  for (const entry of decisions) {
    assert.match(entry.id, /^R\d{2}$/);
    assert.match(entry.dClass, /^D([1-9]|10)$/);
    assert.ok(entry.guard.length > 0);
    assert.ok(entry.coverageBy.length > 0);
  }

  const classes = new Set(decisions.map((entry) => entry.dClass));
  for (const dClass of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']) {
    assert.ok(classes.has(dClass), `missing ${dClass}`);
  }
});

// Fallback evidence patterns for verdicts that do not appear verbatim in test
// bodies (e.g. because the test asserts on HTTP calls rather than log keywords).
// Each entry is tried in order; the first regex match against the test body wins.
const VERDICT_FALLBACK_PATTERNS = {
  skip: [/notEqual.*code/, /fails.closed/, /doesNotMatch/, /merge.conflict/],
  release: [/DELETE/, /idle/, /reacquire/],
  'fail-closed': [/fail.closed/, /mutatingCalls.*\[\]/],
  annotate: [/doesNotMatch.*resolv/s, /recovery hint/],
  retry: [/retry/, /retries/, /attempt/],
};

/** Extract the source block from `test('name', ...)` to the next top-level test. */
function extractTestBody(source, testName) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = source.search(new RegExp(`^test\\('${escaped}'`, 'm'));
  if (start === -1) return null;
  const rest = source.slice(start);
  const nextTest = rest.search(/^test\(/m);
  return nextTest > 0 ? rest.slice(0, nextTest) : rest;
}

test('characterization fixture coverage points resolve to concrete existing reconcile tests', () => {
  const fixture = loadFixture();
  const reconcileSource = readFileSync(RECONCILE_TEST_PATH, 'utf8');
  const reviewRequestSource = readFileSync(REVIEW_REQUEST_TEST_PATH, 'utf8');

  for (const decision of fixture.decision_points) {
    const sources = [reconcileSource, reviewRequestSource];
    const source = sources.find(
      (s) =>
        s.includes(`test('${decision.coverageBy}'`) || s.includes(`test("${decision.coverageBy}"`),
    );
    assert.ok(source != null, `missing coverage test: ${decision.coverageBy}`);

    // Also verify the test body contains evidence of the expected verdict so
    // that a behavior change (e.g. release → skip) is not silently masked.
    const body = extractTestBody(source, decision.coverageBy);
    assert.ok(body != null, `could not extract body for: ${decision.coverageBy}`);

    const verdict = decision.verdict;
    const fallbacks = VERDICT_FALLBACK_PATTERNS[verdict] ?? [];
    const patterns = [new RegExp(verdict, 'i'), ...fallbacks];
    const hasEvidence = patterns.some((re) => re.test(body));
    assert.ok(
      hasEvidence,
      `verdict '${verdict}' has no evidence in test body for ${decision.id}: ${decision.coverageBy}`,
    );
  }
});

test('lease-transition fixture matrix remains deterministic and offline', () => {
  const fixture = loadFixture();
  for (const entry of fixture.lease_transition_fixtures) {
    const state = entry.state ? { ...entry.state } : null;
    if (entry.expected.isLeaseExpired !== undefined) {
      assert.equal(
        isLeaseExpired(state, new Date('2026-01-01T00:00:00.000Z')),
        entry.expected.isLeaseExpired,
        entry.name,
      );
    }
    if (entry.expected.isDuplicateDispatch !== undefined) {
      assert.equal(
        isDuplicateDispatch(state, entry.fingerprint),
        entry.expected.isDuplicateDispatch,
        entry.name,
      );
    }
    if (entry.expected.stallAction !== undefined) {
      assert.equal(
        automationStallAction({
          state,
          fingerprint: entry.fingerprint,
          now: new Date('2026-01-01T00:00:00.000Z'),
        }),
        entry.expected.stallAction,
        entry.name,
      );
    }
  }
});

test('absorbed regressions inventory includes the required superseded PRs', () => {
  const fixture = loadFixture();
  const prs = new Set(fixture.absorbed_regressions.map((entry) => entry.pr));
  for (const expected of [1782, 1797, 1833, 1813, 1791]) {
    assert.ok(prs.has(expected), `missing absorbed regression PR #${expected}`);
  }
});

test('wake-gap fixtures pin separate review and repair behavior (D3)', () => {
  const fixture = loadFixture();
  for (const entry of fixture.review_wake_gap_fixtures) {
    const comments = (entry.input.comments || []).map((body, index) => ({
      id: index + 1,
      body,
      authorAssociation: 'OWNER',
    }));
    const decision = shouldRequestReview({
      trigger: entry.input.trigger,
      pr: entry.input.pr,
      hasMergeConflict: entry.input.hasMergeConflict,
      requiredChecksPassing: entry.input.requiredChecksPassing,
      blockers: entry.input.blockers,
      comments,
    });
    const expectedReview =
      entry.expected && typeof entry.expected === 'object' && 'review' in entry.expected
        ? entry.expected.review
        : entry.expected;
    if (expectedReview === null) {
      assert.equal(decision, null, entry.name);
    } else {
      assert.equal(decision?.reason, expectedReview.reason, entry.name);
      assert.equal(decision?.requestReviewer, expectedReview.requestReviewer, entry.name);
    }
    if (
      entry.expected &&
      typeof entry.expected === 'object' &&
      'repairEligible' in entry.expected
    ) {
      assert.equal(
        isRepairWakeEligible({
          ...entry.input.pr,
          labels: entry.input.pr.labels || [],
          recoveryState: entry.input.recoveryState ?? null,
        }),
        entry.expected.repairEligible,
        `${entry.name} repair wake`,
      );
    }
  }
});
