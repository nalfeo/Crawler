import assert from 'node:assert/strict';
import { test } from 'node:test';

import { feedbackForRun, feedbackKey, readFeedback, saveFeedback } from '../lib/feedback-store.mjs';

function memoryFs(initial = null) {
  let text = initial;
  return {
    existsSync: () => text !== null,
    readFileSync: () => text,
    writeFileSync: (_path, next) => {
      text = next;
    },
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    text: () => text,
  };
}

test('saves and reloads criterion feedback without touching other entries', () => {
  const fs = memoryFs();
  const input = {
    briefId: 'rat-boss',
    runId: 'run-1',
    variantIndex: 2,
    kind: 'sensor',
    criterion: 'opaque-ratio',
    verdict: 'down',
    comment: 'False negative',
  };
  saveFeedback('feedback.json', input, fs);
  const store = readFeedback('feedback.json', fs);
  assert.deepEqual(store.entries[feedbackKey(input)], {
    briefId: 'rat-boss',
    runId: 'run-1',
    variantIndex: 2,
    kind: 'sensor',
    criterion: 'opaque-ratio',
    verdict: 'down',
    comment: 'False negative',
    recordedAt: '2026-07-20T04:00:00.000Z',
  });
});

test('indexes feedback by run, variant, kind, and criterion', () => {
  const fs = memoryFs();
  saveFeedback(
    'feedback.json',
    {
      briefId: 'hero',
      runId: 'run-2',
      variantIndex: 1,
      kind: 'judge',
      criterion: 'pose_orientation',
      verdict: 'up',
      comment: '',
    },
    fs,
  );
  assert.equal(
    feedbackForRun(readFeedback('feedback.json', fs), 'hero', 'run-2')['1'].judge.pose_orientation
      .verdict,
    'up',
  );
});

test('accepts partial dependency overrides and clears empty feedback', () => {
  const fs = memoryFs();
  const base = {
    briefId: 'hero',
    runId: 'run-3',
    variantIndex: 0,
    kind: 'judge',
    criterion: 'readability',
  };
  saveFeedback('feedback.json', { ...base, verdict: 'down', comment: 'Too muddy' }, fs);
  const cleared = saveFeedback(
    'feedback.json',
    { ...base, verdict: null, comment: '' },
    { ...fs, now: undefined },
  );
  assert.equal(cleared, null);
});
