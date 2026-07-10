/**
 * Unit tests for lib/editor-gestures.mjs
 *
 * Covers the gesture-state-machine helpers that drive the set-piece
 * editor canvas: snap logic, depth/z-ordering parity, NPC center-snap,
 * hit testing, and undo/redo history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nnum,
  normalizeRotationDeg,
  snapToStep,
  setPieceZToDepth,
  ENTITY_DEPTH,
  drawSortKey,
  npcCenterSnapPos,
  hitTestRect,
  historyPush,
  historyUndo,
  historyRedo,
} from '../lib/editor-gestures.mjs';

// ---------------------------------------------------------------------------
// nnum
// ---------------------------------------------------------------------------
test('nnum returns default for non-finite values', () => {
  assert.equal(nnum(undefined, 5), 5);
  assert.equal(nnum(NaN, 3), 3);
  assert.equal(nnum(Infinity, 0), 0);
  assert.equal(nnum('abc', 7), 7);
});

test('nnum returns the numeric value for finite inputs', () => {
  assert.equal(nnum(2.5, 0), 2.5);
  assert.equal(nnum('4', 0), 4);
  assert.equal(nnum(0, 99), 0);
});

// ---------------------------------------------------------------------------
// normalizeRotationDeg
// ---------------------------------------------------------------------------
test('normalizeRotationDeg maps 0 → 0', () => {
  assert.equal(normalizeRotationDeg(0), 0);
});
test('normalizeRotationDeg maps 360 → 0', () => {
  assert.equal(normalizeRotationDeg(360), 0);
});
test('normalizeRotationDeg maps 450 → 90', () => {
  assert.equal(normalizeRotationDeg(450), 90);
});
test('normalizeRotationDeg maps -90 → 270', () => {
  assert.equal(normalizeRotationDeg(-90), 270);
});
test('normalizeRotationDeg returns 0 for non-finite', () => {
  assert.equal(normalizeRotationDeg(NaN), 0);
  assert.equal(normalizeRotationDeg(Infinity), 0);
});

// ---------------------------------------------------------------------------
// snapToStep
// ---------------------------------------------------------------------------
test('snapToStep rounds to nearest integer for step=1', () => {
  assert.equal(snapToStep(2.3, 1), 2);
  assert.equal(snapToStep(2.7, 1), 3);
  assert.equal(snapToStep(2.5, 1), 3); // Math.round ties up
});
test('snapToStep rounds to nearest half for step=0.5', () => {
  assert.equal(snapToStep(1.3, 0.5), 1.5);
  assert.equal(snapToStep(1.7, 0.5), 1.5);
  assert.equal(snapToStep(1.8, 0.5), 2.0);
});
test('snapToStep returns value unchanged for step=0 (free placement)', () => {
  assert.equal(snapToStep(3.14, 0), 3.14);
  assert.equal(snapToStep(3.14, -1), 3.14);
});

// ---------------------------------------------------------------------------
// setPieceZToDepth (matches runtime render-depths.ts)
// ---------------------------------------------------------------------------
test('setPieceZToDepth is monotone non-decreasing across the full ladder', () => {
  const ladder = [0, 10, 12, 20, 30, 40, 50];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      setPieceZToDepth(ladder[i]) > setPieceZToDepth(ladder[i - 1]),
      `depth(z=${ladder[i]}) should be > depth(z=${ladder[i - 1]})`,
    );
  }
});
test('setPieceZToDepth: floor(z=0) is below ENTITY_DEPTH', () => {
  assert.ok(setPieceZToDepth(0) < ENTITY_DEPTH);
});
test('setPieceZToDepth: wall(z=10) is below ENTITY_DEPTH', () => {
  assert.ok(setPieceZToDepth(10) < ENTITY_DEPTH);
});
test('setPieceZToDepth: door(z=12) is below ENTITY_DEPTH', () => {
  assert.ok(setPieceZToDepth(12) < ENTITY_DEPTH);
});
test('setPieceZToDepth: fixture(z=20) is above ENTITY_DEPTH', () => {
  assert.ok(setPieceZToDepth(20) > ENTITY_DEPTH);
});
test('setPieceZToDepth: furniture(z=30) is above fixture(z=20)', () => {
  assert.ok(setPieceZToDepth(30) > setPieceZToDepth(20));
});

// ---------------------------------------------------------------------------
// drawSortKey (scene-layer order parity — issue #997 item 1)
// ---------------------------------------------------------------------------
test('drawSortKey: floor prop (z=0) sorts below ENTITY_DEPTH', () => {
  assert.ok(drawSortKey('prop', 0) < ENTITY_DEPTH);
});
test('drawSortKey: NPC without authored z sorts at ENTITY_DEPTH', () => {
  assert.equal(drawSortKey('npc', undefined), ENTITY_DEPTH);
});
test('drawSortKey: NPC without z sorts above wall prop (z=10)', () => {
  assert.ok(drawSortKey('npc', undefined) > drawSortKey('prop', 10));
});
test('drawSortKey: NPC without z sorts below fixture prop (z=20)', () => {
  assert.ok(drawSortKey('npc', undefined) < drawSortKey('prop', 20));
});
test('drawSortKey: NPC with authored z=60 uses setPieceZToDepth(60)', () => {
  assert.equal(drawSortKey('npc', 60), setPieceZToDepth(60));
});
test('drawSortKey: NPC with z=60 sorts above furniture prop (z=30)', () => {
  assert.ok(drawSortKey('npc', 60) > drawSortKey('prop', 30));
});
test('drawSortKey: correct ordering matches runtime stack', () => {
  // floor < wall < door < [entity] < fixture < furniture < decoration < actor
  const floor = drawSortKey('prop', 0);
  const wall = drawSortKey('prop', 10);
  const door = drawSortKey('prop', 12);
  const npcDefault = drawSortKey('npc', undefined); // ENTITY_DEPTH
  const fixture = drawSortKey('prop', 20);
  const furniture = drawSortKey('prop', 30);
  const decoration = drawSortKey('prop', 40);
  const actor = drawSortKey('prop', 50);

  assert.ok(floor < wall);
  assert.ok(wall < door);
  assert.ok(door < npcDefault);
  assert.ok(npcDefault < fixture);
  assert.ok(fixture < furniture);
  assert.ok(furniture < decoration);
  assert.ok(decoration < actor);
});

// ---------------------------------------------------------------------------
// npcCenterSnapPos (NPC center convention — issue #997 item 3)
// ---------------------------------------------------------------------------
test('npcCenterSnapPos: 1-tile NPC snaps center to nearest tile', () => {
  // NPC with sizeTiles=1, displayed at px=80 in a 48px/tile canvas.
  // topLeft = 80/48 ≈ 1.667 tiles, center = 2.167 tiles → snaps to 2.
  // So topLeft result = 2 - 0.5 = 1.5
  const result = npcCenterSnapPos(
    /* dispPx */ 80,
    /* tileSize */ 48,
    /* sizeTiles */ 1,
    /* snapStep */ 1,
    /* limitTiles */ 8,
  );
  assert.ok(Math.abs(result - 1.5) < 1e-9, `expected 1.5 but got ${result}`);
});

test('npcCenterSnapPos: sub-tile NPC (0.625 tiles) snaps center to half-tile step', () => {
  // NPC width = 2.5ft / 4ft/tile = 0.625 tiles, sizeTiles=0.625
  // dispPx = 48*2 = 96 → topLeft = 2 tiles, center = 2.3125 tiles
  // half-step snap (0.5): nearest = 2.5 → topLeft = 2.5 - 0.3125 = 2.1875
  const result = npcCenterSnapPos(
    /* dispPx */ 96,
    /* tileSize */ 48,
    /* sizeTiles */ 0.625,
    /* snapStep */ 0.5,
    /* limitTiles */ 8,
  );
  assert.ok(Math.abs(result - 2.1875) < 1e-9, `expected 2.1875 but got ${result}`);
});

test('npcCenterSnapPos: result clamped to [0, limitTiles - sizeTiles]', () => {
  // dispPx way off right side
  const result = npcCenterSnapPos(
    /* dispPx */ 9999,
    /* tileSize */ 48,
    /* sizeTiles */ 1,
    /* snapStep */ 1,
    /* limitTiles */ 8,
  );
  assert.equal(result, 7); // max = 8 - 1 = 7
});

test('npcCenterSnapPos: result clamped to 0 on left side', () => {
  const result = npcCenterSnapPos(-999, 48, 1, 1, 8);
  assert.equal(result, 0);
});

test('npcCenterSnapPos: free placement (step=0) preserves exact center', () => {
  // topLeft = 2.3 tiles, center = 2.3 + 0.3125 = 2.6125 → no snap
  const result = npcCenterSnapPos(
    /* dispPx */ 48 * 2.3,
    /* tileSize */ 48,
    /* sizeTiles */ 0.625,
    /* snapStep */ 0,
    /* limitTiles */ 8,
  );
  // Expected topLeft = center - 0.3125 = 2.6125 - 0.3125 = 2.3
  assert.ok(Math.abs(result - 2.3) < 1e-9, `expected 2.3 but got ${result}`);
});

// ---------------------------------------------------------------------------
// hitTestRect
// ---------------------------------------------------------------------------
test('hitTestRect returns true for point inside the bounding box', () => {
  // prop at tile (2,3), 2x1, tileSize=48
  assert.equal(hitTestRect(2, 3, 2, 1, 100, 150, 48), true); // (100,150) inside
});
test('hitTestRect returns false for point outside the bounding box', () => {
  assert.equal(hitTestRect(2, 3, 2, 1, 0, 0, 48), false);
  assert.equal(hitTestRect(2, 3, 2, 1, 200, 200, 48), false);
});
test('hitTestRect: left edge is inclusive, right edge is exclusive', () => {
  // Prop at (0,0) size 2x2, tileSize=48 → x ∈ [0,96), y ∈ [0,96)
  assert.equal(hitTestRect(0, 0, 2, 2, 0, 0, 48), true); // left/top edge inclusive
  assert.equal(hitTestRect(0, 0, 2, 2, 96, 0, 48), false); // right edge exclusive
  assert.equal(hitTestRect(0, 0, 2, 2, 0, 96, 48), false); // bottom edge exclusive
});

// ---------------------------------------------------------------------------
// historyPush / historyUndo / historyRedo
// ---------------------------------------------------------------------------
test('historyPush adds state and advances index', () => {
  const { hist, histIdx } = historyPush([], -1, 'a');
  assert.deepEqual(hist, ['a']);
  assert.equal(histIdx, 0);
});
test('historyPush trims redo tail', () => {
  // Start with hist=[a,b,c] at idx=1 (b is current, c is redo)
  const { hist, histIdx } = historyPush(['a', 'b', 'c'], 1, 'd');
  assert.deepEqual(hist, ['a', 'b', 'd']);
  assert.equal(histIdx, 2);
});
test('historyPush caps at maxLen and keeps newest entries', () => {
  const base = Array.from({ length: 5 }, (_, i) => String(i));
  const { hist, histIdx } = historyPush(base, 4, 'new', 5);
  assert.equal(hist.length, 5);
  assert.equal(hist[hist.length - 1], 'new');
  assert.equal(histIdx, 4);
});

test('historyUndo moves back one step', () => {
  const hist = ['a', 'b', 'c'];
  const result = historyUndo(hist, 2);
  assert.equal(result.histIdx, 1);
  assert.equal(result.state, 'b');
});
test('historyUndo returns null at beginning', () => {
  assert.equal(historyUndo(['a'], 0), null);
});

test('historyRedo moves forward one step', () => {
  const hist = ['a', 'b', 'c'];
  const result = historyRedo(hist, 0);
  assert.equal(result.histIdx, 1);
  assert.equal(result.state, 'b');
});
test('historyRedo returns null at end', () => {
  assert.equal(historyRedo(['a', 'b'], 1), null);
});

test('undo/redo round-trip preserves state', () => {
  let { hist, histIdx } = historyPush([], -1, 'state-0');
  ({ hist, histIdx } = historyPush(hist, histIdx, 'state-1'));
  ({ hist, histIdx } = historyPush(hist, histIdx, 'state-2'));

  // Undo twice
  let step = historyUndo(hist, histIdx);
  assert.equal(step.state, 'state-1');
  step = historyUndo(hist, step.histIdx);
  assert.equal(step.state, 'state-0');

  // Redo to state-1
  step = historyRedo(hist, step.histIdx);
  assert.equal(step.state, 'state-1');

  // Cannot redo further than state-2 from idx=1
  const atEnd = historyRedo(hist, 2);
  assert.equal(atEnd, null);
});
