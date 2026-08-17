import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALREADY_LANDED_COMMENT_MARKER,
  analyzeFiles,
  classifyFile,
  FILE_STATUS,
  renderAlreadyLandedComment,
  VERDICT,
} from './already-landed.mjs';

// ---------------------------------------------------------------------------
// Golden fixtures from GitHub issue #2227
//
// PR #2057 — 6 art files, 0 absent from main → ALL_LANDED
// PR #1975 — 14 art files, 0 absent, 2 PNGs differ (main newer) → REGRESSION_CANDIDATE
// PR #2112 — 11 art files, 0 absent → ALL_LANDED
// PR #2124 — 18 art files, 4 absent (genuinely new YAMLs) → PARTIAL (14 landed, 4 new)
// ---------------------------------------------------------------------------

function makeLandedFile(filename, sha = 'aabbcc') {
  return { filename, sha, status: 'added' };
}

function makeModifiedFile(filename, prSha, mainSha) {
  return {
    prFile: { filename, sha: prSha, status: 'modified' },
    mainBlobSha: mainSha,
  };
}

// Helper: build classified files where all are LANDED
function allLandedFiles(count) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `file-${i}.png`,
    status: 'added',
    fileStatus: FILE_STATUS.LANDED,
  }));
}

// ---------------------------------------------------------------------------
// classifyFile — LANDED (blob SHAs match)
// ---------------------------------------------------------------------------

test('classifyFile: added file with matching main blob SHA → LANDED', () => {
  const result = classifyFile({ filename: 'foo.png', sha: 'abc123', status: 'added' }, 'abc123');
  assert.equal(result.fileStatus, FILE_STATUS.LANDED);
  assert.equal(result.filename, 'foo.png');
  assert.equal(result.status, 'added');
});

test('classifyFile: modified file with matching main blob SHA → LANDED', () => {
  const result = classifyFile({ filename: 'bar.ts', sha: 'def456', status: 'modified' }, 'def456');
  assert.equal(result.fileStatus, FILE_STATUS.LANDED);
});

test('classifyFile: renamed file where new path on main has same blob SHA and old path is absent → LANDED', () => {
  const result = classifyFile(
    {
      filename: 'new-name.png',
      sha: 'aaa111',
      status: 'renamed',
      previous_filename: 'old-name.png',
    },
    'aaa111',
    null, // old path absent from main → rename deletion landed
  );
  assert.equal(result.fileStatus, FILE_STATUS.LANDED);
  assert.equal(result.filename, 'new-name.png');
});

test('classifyFile: renamed file where new path matches but old path still on main → DELETION_DIFFERS', () => {
  const result = classifyFile(
    {
      filename: 'new-name.png',
      sha: 'aaa111',
      status: 'renamed',
      previous_filename: 'old-name.png',
    },
    'aaa111',
    'old-blob-sha', // old path still exists on main → rename not fully landed
  );
  assert.equal(result.fileStatus, FILE_STATUS.DELETION_DIFFERS);
  assert.equal(result.filename, 'new-name.png');
});

test('classifyFile: renamed file where mainPreviousFileBlobSha not provided defaults to not checking old path → LANDED', () => {
  // Backward-compat: when caller does not pass mainPreviousFileBlobSha, old-path check is skipped
  const result = classifyFile(
    {
      filename: 'new-name.png',
      sha: 'aaa111',
      status: 'renamed',
      previous_filename: 'old-name.png',
    },
    'aaa111',
    // mainPreviousFileBlobSha omitted
  );
  assert.equal(result.fileStatus, FILE_STATUS.LANDED);
});

test('classifyFile: copied file with matching main blob SHA → LANDED', () => {
  const result = classifyFile({ filename: 'copy.png', sha: 'bbb222', status: 'copied' }, 'bbb222');
  assert.equal(result.fileStatus, FILE_STATUS.LANDED);
});

// ---------------------------------------------------------------------------
// classifyFile — NEW_ON_PR (file absent from main)
// ---------------------------------------------------------------------------

test('classifyFile: added file not present on main → NEW_ON_PR', () => {
  const result = classifyFile({ filename: 'new.yaml', sha: 'ccc333', status: 'added' }, null);
  assert.equal(result.fileStatus, FILE_STATUS.NEW_ON_PR);
});

test('classifyFile: modified file absent from main → NEW_ON_PR', () => {
  const result = classifyFile({ filename: 'ghost.ts', sha: 'ddd444', status: 'modified' }, null);
  assert.equal(result.fileStatus, FILE_STATUS.NEW_ON_PR);
});

// ---------------------------------------------------------------------------
// classifyFile — DIFFERS (blob SHAs mismatch)
// ---------------------------------------------------------------------------

test('classifyFile: modified file where main has different content → DIFFERS', () => {
  const result = classifyFile(
    { filename: 'sprite.png', sha: 'pr111', status: 'modified' },
    'main222',
  );
  assert.equal(result.fileStatus, FILE_STATUS.DIFFERS);
});

test('classifyFile: added file where main already has different content → DIFFERS', () => {
  const result = classifyFile(
    { filename: 'manifest.json', sha: 'pr_v1', status: 'added' },
    'main_v2',
  );
  assert.equal(result.fileStatus, FILE_STATUS.DIFFERS);
});

// ---------------------------------------------------------------------------
// classifyFile — DELETION_LANDED (PR removes file, main no longer has it)
// ---------------------------------------------------------------------------

test('classifyFile: removed file that no longer exists on main → DELETION_LANDED', () => {
  const result = classifyFile(
    {
      filename: 'old-sprite.png',
      sha: '0000000000000000000000000000000000000000',
      status: 'removed',
    },
    null,
  );
  assert.equal(result.fileStatus, FILE_STATUS.DELETION_LANDED);
});

// ---------------------------------------------------------------------------
// classifyFile — DELETION_DIFFERS (PR removes file, main still has it)
// ---------------------------------------------------------------------------

test('classifyFile: removed file that still exists on main → DELETION_DIFFERS', () => {
  const result = classifyFile(
    { filename: 'kept.ts', sha: '0000000000000000000000000000000000000000', status: 'removed' },
    'main_has_this',
  );
  assert.equal(result.fileStatus, FILE_STATUS.DELETION_DIFFERS);
});

// ---------------------------------------------------------------------------
// classifyFile — edge cases
// ---------------------------------------------------------------------------

test('classifyFile: null prFile returns filename=empty, status=empty', () => {
  const result = classifyFile(null, null);
  assert.equal(result.filename, '');
  assert.equal(result.status, '');
  // status is '' (not 'removed'), so treated as non-deletion; main absent → NEW_ON_PR
  assert.equal(result.fileStatus, FILE_STATUS.NEW_ON_PR);
});

test('classifyFile: empty sha on non-removed file with null main → NEW_ON_PR', () => {
  const result = classifyFile({ filename: 'x', sha: '', status: 'added' }, null);
  assert.equal(result.fileStatus, FILE_STATUS.NEW_ON_PR);
});

// ---------------------------------------------------------------------------
// analyzeFiles — ALL_LANDED
// ---------------------------------------------------------------------------

test('golden fixture PR #2057: 6 landed files → ALL_LANDED', () => {
  const files = allLandedFiles(6);
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.ALL_LANDED);
  assert.equal(result.totalCount, 6);
  assert.equal(result.landedCount, 6);
  assert.equal(result.differsCount, 0);
  assert.equal(result.newCount, 0);
});

test('golden fixture PR #2112: 11 landed files → ALL_LANDED', () => {
  const files = allLandedFiles(11);
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.ALL_LANDED);
  assert.equal(result.totalCount, 11);
  assert.equal(result.landedCount, 11);
});

test('analyzeFiles: mix of LANDED and DELETION_LANDED → ALL_LANDED', () => {
  const files = [
    { filename: 'a.png', status: 'added', fileStatus: FILE_STATUS.LANDED },
    { filename: 'b.png', status: 'removed', fileStatus: FILE_STATUS.DELETION_LANDED },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.ALL_LANDED);
  assert.equal(result.landedCount, 2);
});

test('analyzeFiles: single LANDED file → ALL_LANDED', () => {
  const files = [{ filename: 'a.ts', status: 'modified', fileStatus: FILE_STATUS.LANDED }];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.ALL_LANDED);
});

// ---------------------------------------------------------------------------
// analyzeFiles — DIFFERS files are treated as "not confirmed landed" (not regression)
// ---------------------------------------------------------------------------

test('golden fixture PR #1975: 12 landed + 2 differs → PARTIAL (differs treated as unconfirmed, not regression)', () => {
  const files = [
    ...Array.from({ length: 12 }, (_, i) => ({
      filename: `sprite-${i}.png`,
      status: 'modified',
      fileStatus: FILE_STATUS.LANDED,
    })),
    { filename: 'old-version-a.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
    { filename: 'old-version-b.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
  ];
  const result = analyzeFiles(files);
  assert.equal(
    result.verdict,
    VERDICT.PARTIAL,
    'DIFFERS prevents ALL_LANDED but does not trigger REGRESSION_CANDIDATE',
  );
  assert.equal(result.totalCount, 14);
  assert.equal(result.landedCount, 12);
  assert.equal(result.differsCount, 2);
  assert.equal(result.newCount, 0);
});

test('analyzeFiles: single DIFFERS file with landed → PARTIAL (not REGRESSION_CANDIDATE)', () => {
  const files = [
    { filename: 'good.png', status: 'added', fileStatus: FILE_STATUS.LANDED },
    { filename: 'bad.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
    { filename: 'new.yaml', status: 'added', fileStatus: FILE_STATUS.NEW_ON_PR },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.PARTIAL, 'DIFFERS with some landed → PARTIAL');
  assert.equal(result.differsCount, 1);
});

test('analyzeFiles: only DIFFERS files → NOT_LANDED (no landed files)', () => {
  const files = [{ filename: 'a.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS }];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.NOT_LANDED, 'only DIFFERS, no landed files → NOT_LANDED');
  assert.equal(result.landedCount, 0);
  assert.equal(result.differsCount, 1);
});

// ---------------------------------------------------------------------------
// analyzeFiles — PARTIAL
// ---------------------------------------------------------------------------

test('golden fixture PR #2124: 14 landed + 4 new → PARTIAL', () => {
  const files = [
    ...Array.from({ length: 14 }, (_, i) => ({
      filename: `art-${i}.png`,
      status: 'added',
      fileStatus: FILE_STATUS.LANDED,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      filename: `new-brief-${i}.yaml`,
      status: 'added',
      fileStatus: FILE_STATUS.NEW_ON_PR,
    })),
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.PARTIAL);
  assert.equal(result.totalCount, 18);
  assert.equal(result.landedCount, 14);
  assert.equal(result.differsCount, 0);
  assert.equal(result.newCount, 4);
});

test('analyzeFiles: landed + deletion-differs → PARTIAL', () => {
  const files = [
    { filename: 'a.png', status: 'added', fileStatus: FILE_STATUS.LANDED },
    { filename: 'b.png', status: 'removed', fileStatus: FILE_STATUS.DELETION_DIFFERS },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.PARTIAL);
  assert.equal(result.landedCount, 1);
  assert.equal(result.newCount, 1);
});

// ---------------------------------------------------------------------------
// analyzeFiles — NOT_LANDED
// ---------------------------------------------------------------------------

test('analyzeFiles: all NEW_ON_PR → NOT_LANDED', () => {
  const files = [
    { filename: 'brand-new.yaml', status: 'added', fileStatus: FILE_STATUS.NEW_ON_PR },
    { filename: 'also-new.png', status: 'added', fileStatus: FILE_STATUS.NEW_ON_PR },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.NOT_LANDED);
  assert.equal(result.landedCount, 0);
  assert.equal(result.differsCount, 0);
  assert.equal(result.newCount, 2);
});

test('analyzeFiles: empty array → NOT_LANDED with zero counts', () => {
  const result = analyzeFiles([]);
  assert.equal(result.verdict, VERDICT.NOT_LANDED);
  assert.equal(result.totalCount, 0);
  assert.equal(result.landedCount, 0);
  assert.equal(result.differsCount, 0);
  assert.equal(result.newCount, 0);
});

test('analyzeFiles: null input → NOT_LANDED with zero counts', () => {
  const result = analyzeFiles(null);
  assert.equal(result.verdict, VERDICT.NOT_LANDED);
  assert.equal(result.totalCount, 0);
});

// ---------------------------------------------------------------------------
// Conservatism invariant
// ---------------------------------------------------------------------------

test('conservatism: DIFFERS prevents ALL_LANDED even when most files are landed → PARTIAL', () => {
  const files = [
    ...allLandedFiles(100),
    { filename: 'one-differs.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.PARTIAL, 'DIFFERS prevents ALL_LANDED, yields PARTIAL');
});

test('conservatism: DIFFERS prevents ALL_LANDED if all other files are landed → PARTIAL', () => {
  const files = [
    { filename: 'landed.png', status: 'added', fileStatus: FILE_STATUS.LANDED },
    { filename: 'differs.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
  ];
  const result = analyzeFiles(files);
  assert.equal(result.verdict, VERDICT.PARTIAL, 'DIFFERS with landed → PARTIAL not ALL_LANDED');
});

// ---------------------------------------------------------------------------
// renderAlreadyLandedComment
// ---------------------------------------------------------------------------

test('renderAlreadyLandedComment: includes ALREADY_LANDED_COMMENT_MARKER', () => {
  const analysis = analyzeFiles(allLandedFiles(3));
  const comment = renderAlreadyLandedComment(42, analysis, 'abc1234567890');
  assert.ok(
    comment.startsWith(ALREADY_LANDED_COMMENT_MARKER),
    'comment must start with the managed marker',
  );
});

test('renderAlreadyLandedComment: ALL_LANDED includes auto-close note', () => {
  const analysis = analyzeFiles(allLandedFiles(6));
  const comment = renderAlreadyLandedComment(2057, analysis, 'deadbeef1234');
  assert.ok(comment.includes('auto-closed'), 'ALL_LANDED comment should mention auto-close');
  assert.ok(comment.includes('2057'), 'comment should include the PR number');
});

test('renderAlreadyLandedComment: PARTIAL with differs includes differ note and NOT auto-closed', () => {
  const files = [
    ...allLandedFiles(12),
    { filename: 'differs.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
    { filename: 'differs2.png', status: 'modified', fileStatus: FILE_STATUS.DIFFERS },
  ];
  const analysis = analyzeFiles(files);
  assert.equal(analysis.verdict, VERDICT.PARTIAL);
  const comment = renderAlreadyLandedComment(1975, analysis, 'abc');
  assert.ok(comment.includes('NOT auto-closed'), 'PARTIAL comment should say NOT auto-closed');
  assert.ok(comment.includes('different content'), 'should note differing content');
  assert.ok(comment.includes('1975'));
});

test('renderAlreadyLandedComment: PARTIAL includes landed count and new count', () => {
  const files = [
    ...allLandedFiles(14),
    ...Array.from({ length: 4 }, (_, i) => ({
      filename: `new-${i}.yaml`,
      status: 'added',
      fileStatus: FILE_STATUS.NEW_ON_PR,
    })),
  ];
  const analysis = analyzeFiles(files);
  const comment = renderAlreadyLandedComment(2124, analysis, 'deadbeef');
  assert.ok(comment.includes('14 of 18'), 'PARTIAL comment should include fraction landed');
  assert.ok(comment.includes('NOT auto-closed'), 'PARTIAL should not auto-close');
});

test('renderAlreadyLandedComment: evidence table contains filenames', () => {
  const files = [
    {
      filename: 'public/assets/generated/manifest.json',
      status: 'modified',
      fileStatus: FILE_STATUS.LANDED,
    },
    {
      filename: 'src/shared/data/sprite-catalog.json',
      status: 'modified',
      fileStatus: FILE_STATUS.DIFFERS,
    },
  ];
  const analysis = analyzeFiles(files);
  const comment = renderAlreadyLandedComment(99, analysis, 'sha1');
  assert.ok(comment.includes('manifest.json'), 'table must include filename');
  assert.ok(comment.includes('sprite-catalog.json'), 'table must include filename');
  assert.ok(comment.includes('✅'), 'landed file shows checkmark');
  assert.ok(comment.includes('⚠️'), 'differs file shows warning');
});

test('renderAlreadyLandedComment: main SHA is truncated to 12 chars in output', () => {
  const analysis = analyzeFiles(allLandedFiles(1));
  const fullSha = 'abcdef1234567890abcdef';
  const comment = renderAlreadyLandedComment(1, analysis, fullSha);
  assert.ok(comment.includes('abcdef123456'), 'truncated SHA appears in comment');
  assert.ok(!comment.includes('abcdef1234567890'), 'full SHA must NOT appear');
});

test('renderAlreadyLandedComment: long filenames are truncated to 80 chars with ellipsis', () => {
  const longName = 'a/'.repeat(50) + 'file.png'; // > 80 chars
  const files = [{ filename: longName, status: 'added', fileStatus: FILE_STATUS.LANDED }];
  const analysis = analyzeFiles(files);
  const comment = renderAlreadyLandedComment(1, analysis, 'sha');
  // The truncated filename should appear but not the full path
  assert.ok(comment.includes('…'), 'long filename should use ellipsis');
});

test('renderAlreadyLandedComment bounds and stably sorts evidence rows', () => {
  const files = Array.from({ length: 25 }, (_, index) => ({
    filename: `z-${String(index).padStart(2, '0')}.txt`,
    status: 'modified',
    fileStatus: FILE_STATUS.LANDED,
  })).reverse();
  const comment = renderAlreadyLandedComment(1, analyzeFiles(files), 'sha');

  assert.match(comment, /\| \| _…and 5 more_ \| \| \|/);
  assert.equal(
    comment.split('\n').filter((line) => line.startsWith('| ✅ |')).length,
    20,
    'only the bounded sample should render',
  );
  assert.ok(comment.indexOf('z-00.txt') < comment.indexOf('z-19.txt'));
  assert.ok(!comment.includes('z-20.txt'));
});

// ---------------------------------------------------------------------------
// classifyFile round-trips through analyzeFiles
// ---------------------------------------------------------------------------

test('end-to-end: classifyFile + analyzeFiles for all-matching files → ALL_LANDED', () => {
  const prFiles = [
    { filename: 'a.png', sha: 'sha1', status: 'added' },
    { filename: 'b.json', sha: 'sha2', status: 'modified' },
  ];
  const mainMap = { 'a.png': 'sha1', 'b.json': 'sha2' };
  const classified = prFiles.map((f) => classifyFile(f, mainMap[f.filename] ?? null));
  const result = analyzeFiles(classified);
  assert.equal(result.verdict, VERDICT.ALL_LANDED);
});

test('end-to-end: one file absent from main → PARTIAL', () => {
  const prFiles = [
    { filename: 'landed.png', sha: 'sha1', status: 'modified' },
    { filename: 'new.yaml', sha: 'sha99', status: 'added' },
  ];
  const mainMap = { 'landed.png': 'sha1' }; // new.yaml absent
  const classified = prFiles.map((f) => classifyFile(f, mainMap[f.filename] ?? null));
  const result = analyzeFiles(classified);
  assert.equal(result.verdict, VERDICT.PARTIAL);
  assert.equal(result.landedCount, 1);
  assert.equal(result.newCount, 1);
});

test('end-to-end: one file differs → PARTIAL (not REGRESSION_CANDIDATE)', () => {
  const prFiles = [{ filename: 'reg.png', sha: 'pr-old', status: 'modified' }];
  const classified = prFiles.map((f) => classifyFile(f, 'main-newer'));
  const result = analyzeFiles(classified);
  assert.equal(
    result.verdict,
    VERDICT.NOT_LANDED,
    'single differs file with no landed → NOT_LANDED',
  );
  assert.equal(result.differsCount, 1);
});
