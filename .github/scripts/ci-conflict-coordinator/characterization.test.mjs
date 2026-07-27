import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { clusterPullRequests, selectCoordination, shouldDispatchActiveSlot, shouldDispatchSynthesis } from './state.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(DIR, 'characterization', 'verdict-fixtures.json');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

test('ci-conflict characterization fixtures remain tagged and stable', () => {
  const fixture = loadFixture();
  assert.equal(fixture.verdict_fixtures.length, 5);
  for (const entry of fixture.verdict_fixtures) {
    assert.match(entry.id, /^CC\d{2}$/);
    assert.match(entry.dClass, /^D([1-9]|10)$/);
  }
});

test('ci-conflict characterization fixture verdicts match current behavior', () => {
  const fixture = loadFixture();
  for (const entry of fixture.verdict_fixtures) {
    if (entry.kind === 'clusterPullRequests') {
      const clusters = clusterPullRequests(entry.input.pulls, entry.input.minimumSize);
      assert.equal(clusters.length, entry.expected.clusterCount, entry.id);
      const members = clusters[0]?.map((pull) => pull.number) ?? [];
      assert.deepEqual(members, entry.expected.clusterMembers, entry.id);
      continue;
    }
    if (entry.kind === 'selectCoordination') {
      const selected = selectCoordination({
        rankedPulls: entry.input.rankedPulls,
        proofs: entry.input.proofs,
      });
      assert.equal(selected.leader?.number ?? null, entry.expected.leader, entry.id);
      assert.equal(selected.active?.number ?? null, entry.expected.active, entry.id);
      assert.deepEqual(
        selected.ordered.map((pull) => pull.number),
        entry.expected.ordered,
        entry.id,
      );
      assert.deepEqual(
        selected.duplicates.map((pull) => pull.number),
        entry.expected.duplicates,
        entry.id,
      );
      continue;
    }
    if (entry.kind === 'shouldDispatchActiveSlot') {
      assert.equal(
        shouldDispatchActiveSlot({
          prNumber: entry.input.prNumber,
          headSha: entry.input.headSha,
          recoveryState: entry.input.recoveryState,
          priorDispatchKey: entry.input.priorDispatchKey,
          nextKey: entry.input.nextKey,
          lastDispatchAt: entry.input.lastDispatchAt,
          now: new Date(entry.input.now),
        }),
        entry.expected.dispatch,
        entry.id,
      );
      continue;
    }
    if (entry.kind === 'shouldDispatchSynthesis') {
      assert.equal(
        shouldDispatchSynthesis({
          priorSynthesisKey: entry.input.priorSynthesisKey,
          nextSynthesisKey: entry.input.nextSynthesisKey,
          synthesisDispatchAt: entry.input.synthesisDispatchAt,
          now: new Date(entry.input.now),
        }),
        entry.expected.dispatch,
        entry.id,
      );
      continue;
    }
    assert.fail(`unknown fixture kind ${entry.kind}`);
  }
});
