import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveActiveSheet } from '../lib/run-selection.mjs';

test('a requested sheet present on the run is preselected over the last-sheet fallback', () => {
  const sheets = ['sheet-00.png', 'sheet-01.png', 'sheet-02.png'];
  assert.equal(resolveActiveSheet(sheets, 'sheet-01.png'), 'sheet-01.png');
});

test('a requested sheet NOT present on the run falls back to the last sheet', () => {
  const sheets = ['sheet-00.png', 'sheet-01.png', 'sheet-02.png'];
  assert.equal(resolveActiveSheet(sheets, 'nonexistent.png'), 'sheet-02.png');
});

test('no requested sheet falls back to the last sheet (monolith sheetFiles[len-1] convention)', () => {
  const sheets = ['sheet-00.png', 'sheet-01.png', 'sheet-02.png'];
  assert.equal(resolveActiveSheet(sheets, null), 'sheet-02.png');
  assert.equal(resolveActiveSheet(sheets, undefined), 'sheet-02.png');
});

test('an explicit fallback overrides the default last-sheet convention', () => {
  const sheets = ['sheet-00.png', 'sheet-01.png'];
  assert.equal(resolveActiveSheet(sheets, null, 'sheet-00.png'), 'sheet-00.png');
});

test('an empty/missing sheet list resolves to null', () => {
  assert.equal(resolveActiveSheet([], 'sheet-00.png'), null);
  assert.equal(resolveActiveSheet(undefined, 'sheet-00.png'), null);
});

// ---- Exact multi-sheet preselection scenario (refinement C) --------------
// Mirrors the cold-open resolution path in extension.mjs's buildState: a run
// with SEVERAL sheets, and a canvas.open input that requested one that is
// NEITHER the first nor the last — proving preselection genuinely honours the
// requested sheet rather than only ever landing on the trivial first/last case.
test('multi-sheet preselection: a middle sheet requested at cold-open is honoured, not the last-sheet default', () => {
  const run = { briefId: 'goblin-warrior', runId: 'run-2026-01-01T00-00-00' };
  const sheets = ['sheet-00.png', 'sheet-01.png', 'sheet-02.png', 'sheet-03.png'];
  const requested = {
    briefId: run.briefId,
    runId: run.runId,
    variantIndex: null,
    sheet: 'sheet-02.png',
  };

  // Cold-open selection construction (byte-for-byte with extension.mjs's
  // `reqRun` branch): sheet flows through from `requested` unresolved...
  const coldSelected = {
    briefId: run.briefId,
    runId: run.runId,
    variantIndex: 0,
    sheet: typeof requested.sheet === 'string' ? requested.sheet : null,
  };
  // ...then buildState's activeSheet resolution validates it against the
  // run's REAL sheet list.
  const activeSheet = resolveActiveSheet(
    sheets,
    coldSelected.sheet,
    sheets[sheets.length - 1] ?? null,
  );

  assert.equal(activeSheet, 'sheet-02.png');
  assert.notEqual(
    activeSheet,
    sheets[sheets.length - 1],
    'must not silently fall back to the last sheet',
  );
});
