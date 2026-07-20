import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FEEDBACK_VERSION,
  feedbackForRun,
  feedbackKey,
  readFeedback,
  saveFeedback,
} from '../lib/feedback-store.mjs';

function memoryFs(initial = null) {
  const files = new Map(initial === null ? [] : [['feedback.json', initial]]);
  const mtimes = new Map();
  const fds = new Map();
  let nextFd = 10;
  const touch = (path) => mtimes.set(path, Date.now());
  return {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => files.get(path),
    openSync: (path) => {
      if (files.has(path)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.set(path, '');
      touch(path);
      const fd = nextFd++;
      fds.set(fd, path);
      return fd;
    },
    closeSync: (fd) => {
      fds.delete(fd);
    },
    writeFileSync: (path, next) => {
      files.set(path, next);
      touch(path);
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      touch(to);
      files.delete(from);
      mtimes.delete(from);
    },
    unlinkSync: (path) => {
      files.delete(path);
      mtimes.delete(path);
    },
    statSync: (path) => ({ mtimeMs: mtimes.get(path) ?? Date.now() }),
    now: () => new Date('2026-07-20T04:00:00.000Z'),
    randomUUID: () => 'test-id',
    text: () => files.get('feedback.json') ?? null,
  };
}

test('stale lock files are recovered before writing feedback', () => {
  const staleTime = new Date('2026-07-19T00:00:00.000Z');
  const fs = memoryFs();
  fs.writeFileSync('feedback.json.lock', staleTime.toISOString());
  fs.statSync = () => ({ mtimeMs: staleTime.getTime() });
  fs.now = () => new Date('2026-07-20T04:00:00.000Z');
  saveFeedback(
    'feedback.json',
    {
      briefId: 'hero',
      runId: 'run-stale',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: '',
    },
    fs,
  );
  const store = readFeedback('feedback.json', fs);
  assert.equal(Object.keys(store.entries).length, 1);
});

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

test('recovers from a truncated feedback file and replaces it atomically', () => {
  const fs = memoryFs('{"version":1,"entries":');
  assert.deepEqual(readFeedback('feedback.json', fs), { version: FEEDBACK_VERSION, entries: {} });

  saveFeedback(
    'feedback.json',
    {
      briefId: 'hero',
      runId: 'run-4',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: '',
    },
    fs,
  );

  assert.equal(JSON.parse(fs.text()).entries !== undefined, true);
  assert.equal(fs.existsSync('feedback.json.tmp.test-id'), false);
});

test('classifies invalid feedback as a client error', () => {
  const fs = memoryFs();
  assert.throws(
    () =>
      saveFeedback(
        'feedback.json',
        {
          briefId: 'hero',
          runId: 'run-5',
          variantIndex: -1,
          kind: 'judge',
          criterion: 'readability',
          verdict: 'up',
        },
        fs,
      ),
    (error) =>
      error.code === 'invalid-feedback' &&
      error.message === 'variantIndex must be a non-negative integer',
  );
});
