import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FEEDBACK_VERSION,
  briefFeedback,
  feedbackForRun,
  feedbackKey,
  normalizeSubjectType,
  readFeedback,
  saveFeedback,
  sheetFeedback,
} from '../sprite-feedback-store.mjs';

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

test('stale lock recovery uses atomic rename, not direct unlink', () => {
  const staleTime = new Date('2026-07-19T00:00:00.000Z');
  const fs = memoryFs();
  fs.writeFileSync('feedback.json.lock', staleTime.toISOString());
  fs.statSync = () => ({ mtimeMs: staleTime.getTime() });

  const renames = [];
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    renames.push({ from, to });
    originalRename(from, to);
  };

  saveFeedback(
    'feedback.json',
    {
      briefId: 'hero',
      runId: 'run-stale-rename',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: '',
    },
    fs,
  );

  const lockRename = renames.find(({ from }) => from === 'feedback.json.lock');
  assert.ok(lockRename);
  assert.match(lockRename.to, /feedback\.json\.lock\.recovering\./);
});

test('token-checked release does not unlink a successor process lock', () => {
  const fs = memoryFs();
  const lockPath = 'feedback.json.lock';
  let lockUnlinkCount = 0;
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (path) => {
    if (path === lockPath) lockUnlinkCount += 1;
    originalUnlink(path);
  };

  const originalRead = fs.readFileSync;
  saveFeedback(
    'feedback.json',
    {
      briefId: 'hero',
      runId: 'run-token-checked',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: '',
    },
    {
      ...fs,
      readFileSync: (path) => (path === lockPath ? 'different-owner-token' : originalRead(path)),
    },
  );

  assert.equal(lockUnlinkCount, 0);
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
    subjectType: 'criterion',
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

// ---- Discriminated union: subjectType brief | sheet | criterion ----------

test('saves and reads sheet feedback, keyed independently of criterion feedback', () => {
  const fs = memoryFs();
  saveFeedback(
    'feedback.json',
    {
      subjectType: 'sheet',
      briefId: 'goblin',
      runId: 'run-9',
      sheet: 'sheet-01.png',
      verdict: 'up',
      comment: 'Nice palette',
    },
    fs,
  );
  const store = readFeedback('feedback.json', fs);
  assert.deepEqual(sheetFeedback(store, 'goblin', 'run-9', 'sheet-01.png'), {
    verdict: 'up',
    comment: 'Nice palette',
    recordedAt: '2026-07-20T04:00:00.000Z',
  });
  assert.equal(sheetFeedback(store, 'goblin', 'run-9', 'other-sheet.png'), null);
  // A sheet entry must never leak into the criterion selector.
  assert.deepEqual(feedbackForRun(store, 'goblin', 'run-9'), {});
});

test('saves and reads brief feedback, independent of runId-scoped sheet/criterion entries', () => {
  const fs = memoryFs();
  saveFeedback(
    'feedback.json',
    {
      subjectType: 'brief',
      briefId: 'goblin',
      runId: 'run-9',
      verdict: 'down',
      comment: 'Too generic',
    },
    fs,
  );
  const store = readFeedback('feedback.json', fs);
  assert.deepEqual(briefFeedback(store, 'goblin', 'run-9'), {
    verdict: 'down',
    comment: 'Too generic',
    recordedAt: '2026-07-20T04:00:00.000Z',
  });
  assert.equal(briefFeedback(store, 'goblin', 'run-other'), null);
  assert.deepEqual(feedbackForRun(store, 'goblin', 'run-9'), {});
});

test('brief, sheet, and criterion identities for the same briefId/runId never collide', () => {
  const fs = memoryFs();
  saveFeedback(
    'feedback.json',
    { subjectType: 'brief', briefId: 'b', runId: 'r', verdict: 'up', comment: '' },
    fs,
  );
  saveFeedback(
    'feedback.json',
    { subjectType: 'sheet', briefId: 'b', runId: 'r', sheet: 's', verdict: 'down', comment: '' },
    fs,
  );
  saveFeedback(
    'feedback.json',
    {
      subjectType: 'criterion',
      briefId: 'b',
      runId: 'r',
      variantIndex: 0,
      kind: 'judge',
      criterion: 'readability',
      verdict: 'up',
      comment: '',
    },
    fs,
  );
  const store = readFeedback('feedback.json', fs);
  assert.equal(Object.keys(store.entries).length, 3);
  assert.equal(briefFeedback(store, 'b', 'r').verdict, 'up');
  assert.equal(sheetFeedback(store, 'b', 'r', 's').verdict, 'down');
  assert.equal(feedbackForRun(store, 'b', 'r')['0'].judge.readability.verdict, 'up');
});

test('normalizeSubjectType treats a missing/unknown subjectType as legacy criterion', () => {
  assert.equal(normalizeSubjectType(undefined), 'criterion');
  assert.equal(normalizeSubjectType(null), 'criterion');
  assert.equal(normalizeSubjectType('bogus'), 'criterion');
  assert.equal(normalizeSubjectType('sheet'), 'sheet');
  assert.equal(normalizeSubjectType('brief'), 'brief');
});

test('mixed-store compatibility: a legacy on-disk entry with no subjectType field is still read as criterion', () => {
  // Simulates a pre-migration on-disk store: hand-craft an entry object with
  // NO `subjectType` field at all, exactly as older code wrote it, and mix it
  // with fresh sheet/brief entries written by the new code.
  const legacyKey = 'goblin::run-legacy::1::judge::readability';
  const legacyStore = {
    version: FEEDBACK_VERSION,
    entries: {
      [legacyKey]: {
        briefId: 'goblin',
        runId: 'run-legacy',
        variantIndex: 1,
        kind: 'judge',
        criterion: 'readability',
        verdict: 'up',
        comment: 'legacy entry, no subjectType',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
  const fs = memoryFs(JSON.stringify(legacyStore));
  saveFeedback(
    'feedback.json',
    {
      subjectType: 'sheet',
      briefId: 'goblin',
      runId: 'run-legacy',
      sheet: 'sheet.png',
      verdict: 'down',
      comment: '',
    },
    fs,
  );
  const store = readFeedback('feedback.json', fs);
  // Legacy criterion entry is still resolved correctly...
  assert.equal(feedbackForRun(store, 'goblin', 'run-legacy')['1'].judge.readability.verdict, 'up');
  // ...and the new sheet entry doesn't leak into the criterion selector.
  assert.equal(Object.keys(feedbackForRun(store, 'goblin', 'run-legacy')['1'].judge).length, 1);
  assert.equal(sheetFeedback(store, 'goblin', 'run-legacy', 'sheet.png').verdict, 'down');
});

test('clearing sheet/brief feedback (null verdict + empty comment) deletes the entry, matching criterion semantics', () => {
  const fs = memoryFs();
  saveFeedback(
    'feedback.json',
    { subjectType: 'brief', briefId: 'b', runId: 'r', verdict: 'up', comment: 'ok' },
    fs,
  );
  const cleared = saveFeedback(
    'feedback.json',
    { subjectType: 'brief', briefId: 'b', runId: 'r', verdict: null, comment: '' },
    fs,
  );
  assert.equal(cleared, null);
  const store = readFeedback('feedback.json', fs);
  assert.equal(briefFeedback(store, 'b', 'r'), null);
});

test('sheet feedback requires a non-empty sheet identifier', () => {
  const fs = memoryFs();
  assert.throws(
    () =>
      saveFeedback(
        'feedback.json',
        { subjectType: 'sheet', briefId: 'b', runId: 'r', sheet: '', verdict: 'up', comment: '' },
        fs,
      ),
    (error) => error.code === 'invalid-feedback' && error.message === 'sheet is required',
  );
});
