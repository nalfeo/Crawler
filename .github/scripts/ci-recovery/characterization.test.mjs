import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { automationStallAction, isDuplicateDispatch, isLeaseExpired } from './state.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(DIR, 'characterization', 'reconcile-decision-fixtures.json');
const RECONCILE_TEST_PATH = path.join(DIR, 'reconcile.test.mjs');

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

test('characterization fixture coverage points resolve to concrete existing reconcile tests', () => {
  const fixture = loadFixture();
  const source = readFileSync(RECONCILE_TEST_PATH, 'utf8');

  for (const decision of fixture.decision_points) {
    assert.ok(
      source.includes(`test('${decision.coverageBy}'`) || source.includes(`test(\"${decision.coverageBy}\"`),
      `missing coverage test: ${decision.coverageBy}`,
    );
  }
});

test('lease-transition fixture matrix remains deterministic and offline', () => {
  const fixture = loadFixture();
  for (const entry of fixture.lease_transition_fixtures) {
    const state = { ...entry.state };
    if (entry.expected.isLeaseExpired !== undefined) {
      assert.equal(
        isLeaseExpired(state, new Date('2026-01-01T00:00:00.000Z')),
        entry.expected.isLeaseExpired,
        entry.name,
      );
    }
    if (entry.expected.isDuplicateDispatch !== undefined) {
      assert.equal(isDuplicateDispatch(state, entry.fingerprint), entry.expected.isDuplicateDispatch, entry.name);
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
