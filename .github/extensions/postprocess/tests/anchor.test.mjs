/**
 * Unit tests for the pure manual-anchor geometry (`lib/anchor.mjs`). These are
 * the SAME functions serialized verbatim into the in-iframe client, so the math
 * asserted here is exactly what runs in the browser (no hand-duplicated drift).
 *
 * Parity target: monolith final-image click handler maps a click to natural
 * pixels with `floor` + clamp to `[0, natural-1]` (`src/devtools-main.ts`
 * ~5616-5657) and positions the marker at `((coord + 0.5) / natural) * 100`%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finalImageClickToAnchor, anchorMarkerPercent, middleAnchor } from '../lib/anchor.mjs';

const rect = (over = {}) => ({ left: 0, top: 0, width: 100, height: 100, ...over });

test('finalImageClickToAnchor: floors a mid-image click into natural pixel space', () => {
  // relX = 55/100 = 0.55 → floor(5.5) = 5 ; relY = 25/100 = 0.25 → floor(2.5) = 2
  assert.deepEqual(
    finalImageClickToAnchor({
      clientX: 55,
      clientY: 25,
      rect: rect(),
      naturalWidth: 10,
      naturalHeight: 10,
    }),
    { x: 5, y: 2 },
  );
});

test('finalImageClickToAnchor: honours a non-zero rect offset', () => {
  // relX = (60-10)/100 = 0.5 → floor(5) = 5
  assert.deepEqual(
    finalImageClickToAnchor({
      clientX: 60,
      clientY: 60,
      rect: rect({ left: 10, top: 10 }),
      naturalWidth: 10,
      naturalHeight: 10,
    }),
    { x: 5, y: 5 },
  );
});

test('finalImageClickToAnchor: clamps to [0, natural-1] on over/undershoot', () => {
  assert.deepEqual(
    finalImageClickToAnchor({
      clientX: 500,
      clientY: -50,
      rect: rect(),
      naturalWidth: 10,
      naturalHeight: 8,
    }),
    { x: 9, y: 0 },
  );
});

test('finalImageClickToAnchor: returns null for unusable geometry', () => {
  assert.equal(
    finalImageClickToAnchor({
      clientX: 1,
      clientY: 1,
      rect: rect({ width: 0 }),
      naturalWidth: 10,
      naturalHeight: 10,
    }),
    null,
  );
  assert.equal(
    finalImageClickToAnchor({
      clientX: 1,
      clientY: 1,
      rect: rect(),
      naturalWidth: 0,
      naturalHeight: 10,
    }),
    null,
  );
  assert.equal(
    finalImageClickToAnchor({
      clientX: Number.NaN,
      clientY: 1,
      rect: rect(),
      naturalWidth: 10,
      naturalHeight: 10,
    }),
    null,
  );
  assert.equal(finalImageClickToAnchor(null), null);
  assert.equal(finalImageClickToAnchor(undefined), null);
});

test('anchorMarkerPercent: projects to center-of-pixel percentages', () => {
  // x=0 → (0.5/10)*100 = 5 ; y=4 → (4.5/8)*100 = 56.25
  assert.deepEqual(anchorMarkerPercent({ x: 0, y: 4, naturalWidth: 10, naturalHeight: 8 }), {
    leftPct: 5,
    topPct: 56.25,
  });
  // last pixel of a 10-wide image → (9.5/10)*100 = 95
  assert.deepEqual(anchorMarkerPercent({ x: 9, y: 9, naturalWidth: 10, naturalHeight: 10 }), {
    leftPct: 95,
    topPct: 95,
  });
});

test('anchorMarkerPercent: returns null for unusable geometry', () => {
  assert.equal(anchorMarkerPercent({ x: 1, y: 1, naturalWidth: 0, naturalHeight: 10 }), null);
  assert.equal(
    anchorMarkerPercent({ x: Number.NaN, y: 1, naturalWidth: 10, naturalHeight: 10 }),
    null,
  );
  assert.equal(anchorMarkerPercent(null), null);
});

test('anchor round-trip: click → marker lands inside the clicked pixel band', () => {
  const naturalWidth = 16;
  const naturalHeight = 16;
  const anchor = finalImageClickToAnchor({
    clientX: 40,
    clientY: 40,
    rect: rect(),
    naturalWidth,
    naturalHeight,
  });

  const marker = anchorMarkerPercent({ ...anchor, naturalWidth, naturalHeight });
  // center-of-pixel must sit within [x/nat, (x+1)/nat] * 100
  assert.ok(marker.leftPct > (anchor.x / naturalWidth) * 100);
  assert.ok(marker.leftPct < ((anchor.x + 1) / naturalWidth) * 100);
});

test('middleAnchor uses floor-half coordinates for odd and even dimensions', () => {
  assert.deepEqual(middleAnchor({ naturalWidth: 163, naturalHeight: 267 }), { x: 81, y: 133 });
  assert.deepEqual(middleAnchor({ naturalWidth: 64, naturalHeight: 32 }), { x: 32, y: 16 });
  assert.deepEqual(middleAnchor({ naturalWidth: 1, naturalHeight: 1 }), { x: 0, y: 0 });
  assert.equal(middleAnchor({ naturalWidth: 0, naturalHeight: 32 }), null);
  assert.equal(middleAnchor(null), null);
});
