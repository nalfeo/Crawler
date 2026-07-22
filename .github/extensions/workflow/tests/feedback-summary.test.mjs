import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  summarizeJudge,
  summarizeSensors,
  readCriterionFeedback,
  writeCriterionFeedback,
} from '../lib/feedback-summary.mjs';

test('summarizeJudge: unjudged uses the skip message', () => {
  const summary = summarizeJudge({ judge: null, judgeSkipMessage: 'Awaiting judge pass.' });
  assert.equal(summary.state, 'unjudged');
  assert.equal(summary.text, 'Awaiting judge pass.');
});

test('summarizeJudge: unjudged falls back to a default message with no skip reason', () => {
  const summary = summarizeJudge({ judge: null });
  assert.equal(summary.state, 'unjudged');
  assert.equal(summary.text, 'Not judged yet.');
});

test('summarizeJudge: pass reports the lowest axis score', () => {
  const summary = summarizeJudge({ judge: { passed: true, minScore: 4 } });
  assert.equal(summary.state, 'pass');
  assert.match(summary.text, /passed/);
  assert.match(summary.text, /4\/5/);
});

test('summarizeJudge: fail lists which axes rejected it', () => {
  const summary = summarizeJudge({
    judge: { passed: false, minScore: 2, rejectedBy: ['readability', 'briefMatch'] },
  });
  assert.equal(summary.state, 'fail');
  assert.match(summary.text, /rejected/);
  assert.match(summary.text, /readability, briefMatch/);
});

test('summarizeSensors: no sensor detail but overall passed', () => {
  const summary = summarizeSensors({ sensors: [], passed: true });
  assert.equal(summary.state, 'none');
  assert.match(summary.text, /All sensors passed/);
});

test('summarizeSensors: no sensor detail and overall failed', () => {
  const summary = summarizeSensors({ sensors: [], passed: false });
  assert.equal(summary.state, 'none');
  assert.match(summary.text, /No per-sensor detail/);
});

test('summarizeSensors: all pass', () => {
  const summary = summarizeSensors({
    sensors: [
      { sensor: 'a', ok: true },
      { sensor: 'b', ok: true },
    ],
  });
  assert.equal(summary.state, 'pass');
  assert.match(summary.text, /All 2 sensors passed/);
  assert.deepEqual(summary.failingNames, []);
});

test('summarizeSensors: some fail, lists failing names', () => {
  const summary = summarizeSensors({
    sensors: [
      { sensor: 'palette', ok: false },
      { sensor: 'opaque-ratio', ok: true },
      { sensor: 'silhouette', ok: false },
    ],
  });
  assert.equal(summary.state, 'fail');
  assert.equal(summary.text, '2/3 sensors failed (palette, silhouette)');
  assert.deepEqual(summary.failingNames, ['palette', 'silhouette']);
});

// ---------------------------------------------------------------------------
// readCriterionFeedback / writeCriterionFeedback — fix for the review finding
// that a first-time-confirmed criterion's feedback disappeared on the next
// render (renderCriterionFeedback's fallback object for a never-before-seen
// criterion was disconnected from `c.feedback[kind][criterion]`; confirming
// only mutated the fallback, never the canonical location).
// ---------------------------------------------------------------------------

test('readCriterionFeedback: returns the empty default when the candidate has no feedback yet', () => {
  const candidate = { feedback: { judge: {}, sensor: {} } };
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'readability'), {
    verdict: null,
    comment: '',
  });
});

test('readCriterionFeedback: returns the empty default when `feedback` itself is missing', () => {
  const candidate = {};
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'readability'), {
    verdict: null,
    comment: '',
  });
});

test('readCriterionFeedback: returns the persisted value when present', () => {
  const candidate = {
    feedback: { judge: { readability: { verdict: 'up', comment: 'Great' } }, sensor: {} },
  };
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'readability'), {
    verdict: 'up',
    comment: 'Great',
  });
});

test('writeCriterionFeedback: creates feedback/kind containers on a candidate that never had any', () => {
  const candidate = {}; // no `feedback` at all yet — the first-ever confirm for this candidate
  writeCriterionFeedback(candidate, 'judge', 'readability', { verdict: 'up', comment: 'Nice' });
  assert.deepEqual(candidate.feedback.judge.readability, { verdict: 'up', comment: 'Nice' });
});

test('writeCriterionFeedback: a first-time-confirmed criterion survives a subsequent read (the actual regression)', () => {
  // Mirrors composeState's shape: every candidate always has `feedback: {
  // sensor: {}, judge: {} }`, but a criterion with NO prior feedback has no
  // key under `feedback[kind]` yet.
  const candidate = { index: 2, feedback: { sensor: {}, judge: {} } };

  // Render #1: nothing confirmed yet.
  const beforeConfirm = readCriterionFeedback(candidate, 'judge', 'readability');
  assert.deepEqual(beforeConfirm, { verdict: null, comment: '' });

  // User confirms a thumbs-up with a comment; the save resolves with the
  // server's canonical feedback payload (mirrors POST /api/feedback's
  // response shape).
  const serverResult = { feedback: { verdict: 'up', comment: 'Looks great' } };
  writeCriterionFeedback(candidate, 'judge', 'readability', serverResult.feedback);

  // Render #2 (e.g. a tab switch, or any other lastState re-render that does
  // NOT trigger a server rebuild) — the SAME candidate object is read again.
  // Before the fix, `beforeConfirm` was a disconnected fallback object that
  // confirm() mutated in place, so this second read would still see
  // {verdict:null, comment:''} instead of the just-confirmed value.
  const afterConfirm = readCriterionFeedback(candidate, 'judge', 'readability');
  assert.deepEqual(afterConfirm, { verdict: 'up', comment: 'Looks great' });
});

test('writeCriterionFeedback: a deselected-thumb confirm (null feedback payload) clears back to the empty default', () => {
  const candidate = {
    feedback: { judge: { readability: { verdict: 'up', comment: 'x' } }, sensor: {} },
  };
  // Mirrors the server returning `{ feedback: null }` for a deselected-thumb
  // confirm (see tests/feedback-route-http.test.mjs).
  writeCriterionFeedback(candidate, 'judge', 'readability', null);
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'readability'), {
    verdict: null,
    comment: '',
  });
});

test('writeCriterionFeedback: writing one criterion never disturbs a DIFFERENT criterion or kind on the same candidate', () => {
  const candidate = {
    feedback: {
      judge: { readability: { verdict: 'down', comment: 'meh' } },
      sensor: { palette: { verdict: 'up', comment: '' } },
    },
  };
  writeCriterionFeedback(candidate, 'judge', 'briefMatch', { verdict: 'up', comment: 'On brief' });
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'readability'), {
    verdict: 'down',
    comment: 'meh',
  });
  assert.deepEqual(readCriterionFeedback(candidate, 'sensor', 'palette'), {
    verdict: 'up',
    comment: '',
  });
  assert.deepEqual(readCriterionFeedback(candidate, 'judge', 'briefMatch'), {
    verdict: 'up',
    comment: 'On brief',
  });
});
