/**
 * Exhaustive unit tests for the C2 persist payload pipeline — the server's
 * highest-risk "never trust the client" branch. `normalizePersistRequest`
 * validates + clamps a raw request body; `buildPersistPostprocessPayload` turns
 * the normalized args into the EXACT sidecar body, byte-for-byte parity with the
 * monolith "Apply changes" handler (`src/devtools-main.ts` ~5717-5754).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePersistRequest,
  buildPersistPostprocessPayload,
  DEFAULT_BACKGROUND_TWEAKS,
  MAX_BACKGROUND_TOLERANCE_SQ,
} from '../lib/postprocess-client.mjs';

// --- normalizePersistRequest: rejection branches -------------------------------

test('normalizePersistRequest: rejects non-object bodies', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const out = normalizePersistRequest(bad);
    assert.equal(out.ok, false);
    assert.match(out.error, /body must be an object/);
  }
});

test('normalizePersistRequest: requires non-empty briefId and runId', () => {
  assert.equal(normalizePersistRequest({ runId: 'r', mode: 'reset' }).ok, false);
  assert.equal(normalizePersistRequest({ briefId: 'b', mode: 'reset' }).ok, false);
  assert.equal(normalizePersistRequest({ briefId: '', runId: 'r', mode: 'reset' }).ok, false);
  const out = normalizePersistRequest({ briefId: 'b', mode: 'reset' });
  assert.match(out.error, /briefId and runId are required/);
});

test('normalizePersistRequest: rejects an unknown mode', () => {
  const out = normalizePersistRequest({ briefId: 'b', runId: 'r', mode: 'nuke' });
  assert.equal(out.ok, false);
  assert.match(out.error, /mode must be "replace" or "reset"/);
});

// --- normalizePersistRequest: reset short-circuit ------------------------------

test('normalizePersistRequest: reset short-circuits and ignores every extra field', () => {
  const out = normalizePersistRequest({
    briefId: 'b',
    runId: 'r',
    mode: 'reset',
    variantIndex: 999,
    facingDirection: 'bogus',
    manualAnchor: { x: 1, y: 2 },
  });
  assert.deepEqual(out, { ok: true, args: { briefId: 'b', runId: 'r', mode: 'reset' } });
});

// --- normalizePersistRequest: replace validation -------------------------------

test('normalizePersistRequest: replace requires a non-negative integer variantIndex', () => {
  const base = { briefId: 'b', runId: 'r', mode: 'replace', facingDirection: 'right' };
  assert.equal(normalizePersistRequest({ ...base, variantIndex: -1 }).ok, false);
  assert.equal(normalizePersistRequest({ ...base, variantIndex: 1.5 }).ok, false);
  assert.equal(normalizePersistRequest({ ...base, variantIndex: 'x' }).ok, false);
  const out = normalizePersistRequest({ ...base, variantIndex: -1 });
  assert.match(out.error, /variantIndex must be a non-negative integer/);
});

test('normalizePersistRequest: replace requires a left/right facingDirection', () => {
  const base = { briefId: 'b', runId: 'r', mode: 'replace', variantIndex: 0 };
  assert.equal(normalizePersistRequest({ ...base, facingDirection: 'up' }).ok, false);
  assert.equal(normalizePersistRequest({ ...base }).ok, false); // missing
  const out = normalizePersistRequest({ ...base, facingDirection: 'up' });
  assert.match(out.error, /facingDirection must be "left" or "right"/);
});

test('normalizePersistRequest: replace with defaults (no anchor, no applyToAll, no tolerances)', () => {
  const out = normalizePersistRequest({
    briefId: 'b',
    runId: 'r',
    mode: 'replace',
    variantIndex: 3,
    facingDirection: 'left',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.args, {
    briefId: 'b',
    runId: 'r',
    mode: 'replace',
    variantIndex: 3,
    applyToAll: false,
    facingDirection: 'left',
    manualAnchorClear: false,
    manualAnchor: undefined,
    colorToleranceSq: DEFAULT_BACKGROUND_TWEAKS.colorToleranceSq,
    fringeToleranceSq: DEFAULT_BACKGROUND_TWEAKS.fringeToleranceSq,
    disabledModules: [],
  });
});

test('normalizePersistRequest: canonicalizes disabled modules and rejects unknown IDs', () => {
  const base = {
    briefId: 'b',
    runId: 'r',
    mode: 'replace',
    variantIndex: 0,
    facingDirection: 'right',
  };
  const valid = normalizePersistRequest({
    ...base,
    disabledModules: ['resize', 'background-removal', 'resize'],
  });
  assert.deepEqual(valid.args.disabledModules, ['background-removal', 'resize']);

  const invalid = normalizePersistRequest({ ...base, disabledModules: ['not-a-module'] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /canonical module IDs/);
});

test('normalizePersistRequest: manualAnchor is truncated and only honoured when finite + not cleared', () => {
  const base = {
    briefId: 'b',
    runId: 'r',
    mode: 'replace',
    variantIndex: 0,
    facingDirection: 'right',
  };
  // finite → truncated
  assert.deepEqual(
    normalizePersistRequest({ ...base, manualAnchor: { x: 4.9, y: 7.2 } }).args.manualAnchor,
    { x: 4, y: 7 },
  );
  // NaN coord → no-op (undefined), mirrors monolith syncManualAnchorFromInputs
  assert.equal(
    normalizePersistRequest({ ...base, manualAnchor: { x: Number.NaN, y: 7 } }).args.manualAnchor,
    undefined,
  );
  // clear wins over a provided anchor
  const cleared = normalizePersistRequest({
    ...base,
    manualAnchorClear: true,
    manualAnchor: { x: 4, y: 7 },
  }).args;
  assert.equal(cleared.manualAnchorClear, true);
  assert.equal(cleared.manualAnchor, undefined);
});

test('normalizePersistRequest: clamps out-of-range tolerances with the shared defaults', () => {
  const out = normalizePersistRequest({
    briefId: 'b',
    runId: 'r',
    mode: 'replace',
    variantIndex: 0,
    facingDirection: 'right',
    colorToleranceSq: -100,
    fringeToleranceSq: MAX_BACKGROUND_TOLERANCE_SQ + 9999,
  });
  assert.equal(out.args.colorToleranceSq, 0);
  assert.equal(out.args.fringeToleranceSq, MAX_BACKGROUND_TOLERANCE_SQ);
});

// --- buildPersistPostprocessPayload: reset -------------------------------------

test('buildPersistPostprocessPayload: reset → {mode:"reset"} only (ignores extras)', () => {
  assert.deepEqual(buildPersistPostprocessPayload({ mode: 'reset', variantIndex: 5 }), {
    mode: 'reset',
  });
  assert.deepEqual(buildPersistPostprocessPayload(null), { mode: 'reset' });
  assert.deepEqual(buildPersistPostprocessPayload(undefined), { mode: 'reset' });
});

// --- buildPersistPostprocessPayload: replace (single variant) ------------------

test('buildPersistPostprocessPayload: single-variant replace carries variantIndexes and no applyToAllVariants', () => {
  const payload = buildPersistPostprocessPayload({
    mode: 'replace',
    variantIndex: 2,
    applyToAll: false,
    facingDirection: 'left',
    colorToleranceSq: 4000,
    fringeToleranceSq: 12000,
    manualAnchorClear: false,
    manualAnchor: { x: 5, y: 6 },
  });
  assert.deepEqual(payload, {
    mode: 'replace',
    options: {
      background: { colorToleranceSq: 4000, fringeToleranceSq: 12000 },
      disabledModules: [],
    },
    facing: { variantIndex: 2, direction: 'left' },
    manualAnchor: { variantIndex: 2, x: 5, y: 6 },
    variantIndexes: [2],
  });
});

// --- buildPersistPostprocessPayload: replace (apply to all) --------------------

test('buildPersistPostprocessPayload: apply-to-all stamps applyToAllVariants and omits variantIndexes', () => {
  const payload = buildPersistPostprocessPayload({
    mode: 'replace',
    variantIndex: 0,
    applyToAll: true,
    facingDirection: 'right',
    colorToleranceSq: 4000,
    fringeToleranceSq: 12000,
    manualAnchorClear: false,
    manualAnchor: { x: 1, y: 2 },
  });
  assert.deepEqual(payload, {
    mode: 'replace',
    options: {
      background: { colorToleranceSq: 4000, fringeToleranceSq: 12000 },
      disabledModules: [],
    },
    facing: { variantIndex: 0, direction: 'right', applyToAllVariants: true },
    manualAnchor: { variantIndex: 0, x: 1, y: 2, applyToAllVariants: true },
  });
  assert.equal('variantIndexes' in payload, false);
});

// --- buildPersistPostprocessPayload: manualAnchor tri-state --------------------

test('buildPersistPostprocessPayload: manualAnchor tri-state (clear=null, absent=omitted, set)', () => {
  const base = {
    mode: 'replace',
    variantIndex: 1,
    applyToAll: false,
    facingDirection: 'right',
    colorToleranceSq: 4000,
    fringeToleranceSq: 12000,
  };
  // clear → explicit null
  const cleared = buildPersistPostprocessPayload({ ...base, manualAnchorClear: true });
  assert.equal(cleared.manualAnchor, null);
  assert.ok('manualAnchor' in cleared);
  // absent (undefined) → key omitted entirely
  const absent = buildPersistPostprocessPayload({
    ...base,
    manualAnchorClear: false,
    manualAnchor: undefined,
  });
  assert.equal('manualAnchor' in absent, false);
  // non-finite anchor → also omitted
  const bad = buildPersistPostprocessPayload({
    ...base,
    manualAnchorClear: false,
    manualAnchor: { x: Number.NaN, y: 3 },
  });
  assert.equal('manualAnchor' in bad, false);
});

test('buildPersistPostprocessPayload: re-clamps tolerances defensively', () => {
  const payload = buildPersistPostprocessPayload({
    mode: 'replace',
    variantIndex: 0,
    applyToAll: false,
    facingDirection: 'right',
    colorToleranceSq: -5,
    fringeToleranceSq: MAX_BACKGROUND_TOLERANCE_SQ + 1,
    manualAnchorClear: false,
  });
  assert.equal(payload.options.background.colorToleranceSq, 0);
  assert.equal(payload.options.background.fringeToleranceSq, MAX_BACKGROUND_TOLERANCE_SQ);
});

// --- end-to-end: normalize → build parity --------------------------------------

test('normalize→build: a this-variant replace produces the monolith body shape', () => {
  const norm = normalizePersistRequest({
    briefId: 'goblin',
    runId: 'run-1',
    mode: 'replace',
    variantIndex: 0,
    facingDirection: 'right',
    manualAnchor: { x: 8, y: 8 },
    colorToleranceSq: 4000,
    fringeToleranceSq: 12000,
  });
  assert.equal(norm.ok, true);
  const payload = buildPersistPostprocessPayload(norm.args);
  assert.deepEqual(payload, {
    mode: 'replace',
    options: {
      background: { colorToleranceSq: 4000, fringeToleranceSq: 12000 },
      disabledModules: [],
    },
    facing: { variantIndex: 0, direction: 'right' },
    manualAnchor: { variantIndex: 0, x: 8, y: 8 },
    variantIndexes: [0],
  });
});

test('normalize→build: a reset request produces {mode:"reset"} end-to-end', () => {
  const norm = normalizePersistRequest({ briefId: 'b', runId: 'r', mode: 'reset' });
  assert.deepEqual(buildPersistPostprocessPayload(norm.args), { mode: 'reset' });
});
