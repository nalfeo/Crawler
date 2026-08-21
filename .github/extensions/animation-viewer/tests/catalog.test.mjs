import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_FRAME_RATE,
  MAX_GRID_DIMENSION,
  MAX_OUTPUT_DIMENSION,
  buildAnimationCatalog,
  isPositiveFrameRate,
  isPositiveInteger,
  normalizeSheetFields,
  toCatalogEntry,
} from '../catalog.mjs';

const alwaysExists = () => true;

function validEntry(overrides = {}) {
  return {
    spriteName: 'player-walk-cycle-female',
    assetPath: 'generated/player-walk-cycle-female.png',
    animation: { frameCount: 8, frameRate: 8, frameWidth: 96, frameHeight: 144 },
    ...overrides,
  };
}

test('isPositiveInteger rejects zero, negatives, fractions and oversized values', () => {
  assert.equal(isPositiveInteger(1, 10), true);
  assert.equal(isPositiveInteger(0, 10), false);
  assert.equal(isPositiveInteger(-3, 10), false);
  assert.equal(isPositiveInteger(1.5, 10), false);
  assert.equal(isPositiveInteger(11, 10), false);
  assert.equal(isPositiveInteger('4', 10), false);
  assert.equal(isPositiveInteger(Number.NaN, 10), false);
});

test('isPositiveFrameRate bounds the playback rate', () => {
  assert.equal(isPositiveFrameRate(8), true);
  assert.equal(isPositiveFrameRate(0), false);
  assert.equal(isPositiveFrameRate(-1), false);
  assert.equal(isPositiveFrameRate(MAX_FRAME_RATE + 1), false);
  assert.equal(isPositiveFrameRate(Number.POSITIVE_INFINITY), false);
});

test('normalizeSheetFields applies defaults when nothing is supplied', () => {
  const result = normalizeSheetFields();
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    rows: 1,
    cols: 1,
    frameRate: 8,
    outputW: 128,
    outputH: 128,
  });
});

test('normalizeSheetFields layers input over the previous state', () => {
  const result = normalizeSheetFields(
    { cols: 6 },
    { rows: 2, cols: 4, frameRate: 12, outputW: 64, outputH: 96 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { rows: 2, cols: 6, frameRate: 12, outputW: 64, outputH: 96 });
});

test('normalizeSheetFields rejects a zero column count that would divide by zero', () => {
  const result = normalizeSheetFields({ cols: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /cols must be an integer between 1 and /);
});

test('normalizeSheetFields rejects negative, fractional and oversized dimensions', () => {
  assert.equal(normalizeSheetFields({ rows: -1 }).ok, false);
  assert.equal(normalizeSheetFields({ cols: 2.5 }).ok, false);
  assert.equal(normalizeSheetFields({ outputW: 0 }).ok, false);
  assert.equal(normalizeSheetFields({ outputH: MAX_OUTPUT_DIMENSION + 1 }).ok, false);
  assert.equal(normalizeSheetFields({ rows: MAX_GRID_DIMENSION + 1 }).ok, false);
});

test('normalizeSheetFields rejects a non-positive frame rate', () => {
  const result = normalizeSheetFields({ frameRate: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error, /frameRate must be greater than 0/);
});

test('toCatalogEntry maps an approved animation entry to catalog fields', () => {
  const entry = toCatalogEntry(validEntry(), '/repo', 'fallback', alwaysExists);
  assert.deepEqual(entry, {
    label: 'player-walk-cycle-female',
    sheetPath: path.join('public', 'assets', 'generated', 'player-walk-cycle-female.png'),
    rows: 1,
    cols: 8,
    frameRate: 8,
    outputW: 96,
    outputH: 144,
  });
});

test('toCatalogEntry falls back to briefId then filename for the label', () => {
  const withBrief = toCatalogEntry(
    validEntry({ spriteName: undefined, briefId: 'brief-42' }),
    '/repo',
    'fallback',
    alwaysExists,
  );
  assert.equal(withBrief.label, 'brief-42');

  const withFallback = toCatalogEntry(
    validEntry({ spriteName: undefined, briefId: undefined }),
    '/repo',
    'fallback',
    alwaysExists,
  );
  assert.equal(withFallback.label, 'fallback');
});

test('toCatalogEntry rejects invalid animation metadata', () => {
  const cases = [
    undefined,
    {},
    validEntry({ animation: undefined }),
    validEntry({ assetPath: undefined }),
    validEntry({ animation: { frameCount: 0, frameRate: 8, frameWidth: 96, frameHeight: 96 } }),
    validEntry({ animation: { frameCount: 8, frameRate: 0, frameWidth: 96, frameHeight: 96 } }),
    validEntry({ animation: { frameCount: 8, frameRate: 8, frameWidth: -96, frameHeight: 96 } }),
    validEntry({ animation: { frameCount: 8, frameRate: 8, frameWidth: 96, frameHeight: 1.5 } }),
  ];
  for (const candidate of cases) {
    assert.equal(toCatalogEntry(candidate, '/repo', 'fallback', alwaysExists), null);
  }
});

test('toCatalogEntry rejects asset paths that escape the generated root', () => {
  const entry = toCatalogEntry(
    validEntry({ assetPath: '../../../etc/passwd.png' }),
    '/repo',
    'fallback',
    alwaysExists,
  );
  assert.equal(entry, null);
});

test('toCatalogEntry rejects a sheet that is missing on disk', () => {
  assert.equal(
    toCatalogEntry(validEntry(), '/repo', 'fallback', () => false),
    null,
  );
});

test('buildAnimationCatalog reads entries, skips invalid JSON, and sorts by label', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'animation-viewer-'));
  try {
    const generated = path.join(repoRoot, 'public', 'assets', 'generated');
    const entries = path.join(generated, 'entries');
    mkdirSync(entries, { recursive: true });
    writeFileSync(path.join(generated, 'male.png'), '');
    writeFileSync(path.join(generated, 'female.png'), '');
    writeFileSync(
      path.join(entries, 'male.json'),
      JSON.stringify(validEntry({ spriteName: 'zed-walk', assetPath: 'generated/male.png' })),
    );
    writeFileSync(
      path.join(entries, 'female.json'),
      JSON.stringify(validEntry({ spriteName: 'alpha-walk', assetPath: 'generated/female.png' })),
    );
    writeFileSync(path.join(entries, 'broken.json'), '{ not json');
    writeFileSync(
      path.join(entries, 'missing-sheet.json'),
      JSON.stringify(validEntry({ assetPath: 'generated/nope.png' })),
    );

    const catalog = buildAnimationCatalog(repoRoot);
    assert.deepEqual(
      catalog.map((animation) => animation.label),
      ['alpha-walk', 'zed-walk'],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildAnimationCatalog returns an empty catalog when no entries directory exists', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'animation-viewer-empty-'));
  try {
    assert.deepEqual(buildAnimationCatalog(repoRoot), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
