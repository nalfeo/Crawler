import { describe, expect, it } from 'vitest';
import {
  isSetPieceRenderReady,
  spriteRefRendersPersistentPlaceholder,
  type SetPieceRenderCounts,
} from '../../src/labs/set-piece-lab/readiness.js';
import type { SpriteRef } from '../../src/shared/set-piece-types.js';

/**
 * The set-piece lab's `window.__uiProbe.ready()` must be HONEST: it may only
 * report `true` once the CURRENT piece is rendering real art, so the headless
 * visual-review harness never screenshots grey placeholder rects / villager
 * fallbacks on a cold cache. These tests pin the truth table of that decision.
 */
describe('isSetPieceRenderReady', () => {
  const base: SetPieceRenderCounts = {
    placeholderRectCount: 0,
    imageCount: 0,
    requiredNpcKeyCount: 3,
    resolvedNpcKeyCount: 3,
  };

  it('is NOT ready for the pre-sync empty scene (no images yet)', () => {
    // Before the first sync there are zero images AND zero rects — the absence
    // of rects must not be mistaken for "loaded".
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 0,
        imageCount: 0,
        requiredNpcKeyCount: 0,
        resolvedNpcKeyCount: 0,
      }),
    ).toBe(false);
  });

  it('is NOT ready while any placeholder Rectangle remains', () => {
    // Cold cache: props rendered as grey placeholder boxes, NPC keys resolved.
    expect(isSetPieceRenderReady({ ...base, placeholderRectCount: 1, imageCount: 12 })).toBe(false);
  });

  it('is NOT ready while a required NPC key is still a villager fallback', () => {
    // Props resolved (0 rects, images present) but only 2 of 3 pinned NPC keys
    // are resident — the third NPC is still the villager fallback.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 0,
        imageCount: 14,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 2,
      }),
    ).toBe(false);
  });

  it('is ready when 0 rects, images present, and every required NPC key resolved', () => {
    // The real-art welcome-room state the harness should capture.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 0,
        imageCount: 15,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 3,
      }),
    ).toBe(true);
  });

  it('treats extra resolved NPC keys as still ready (>= threshold, not ==)', () => {
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 0,
        imageCount: 15,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 4,
      }),
    ).toBe(true);
  });

  it('is ready for a piece with no required NPC keys once props render (images>0, 0 rects)', () => {
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 0,
        imageCount: 5,
        requiredNpcKeyCount: 0,
        resolvedNpcKeyCount: 0,
      }),
    ).toBe(true);
  });

  it('a rect still blocks readiness even when NPC keys are all resolved', () => {
    // Guards against a count-only gate: NPCs done, but one prop texture is late.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 2,
        imageCount: 20,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 3,
      }),
    ).toBe(false);
  });

  // --- expectedPersistentPlaceholderCount (intentional queued-art stand-ins) ---
  // welcome-room's Kenney→custom conversion leaves 3 props that render as
  // permanent placeholder Rectangles (honest "art queued" boxes). Those must not
  // wedge ready() at false forever, but a rect ABOVE that expected count is still
  // a transient cold-cache prop the gate must keep waiting on.
  it('is ready once rects fall to the expected persistent count (queued-art boxes)', () => {
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 3,
        imageCount: 15,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 3,
        expectedPersistentPlaceholderCount: 3,
      }),
    ).toBe(true);
  });

  it('is NOT ready while a rect ABOVE the expected persistent count remains', () => {
    // 4 rects but only 3 are the intentional stand-ins — the 4th is a real prop
    // still loading, so the harness must keep waiting.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 4,
        imageCount: 15,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 3,
        expectedPersistentPlaceholderCount: 3,
      }),
    ).toBe(false);
  });

  it('is ready when fewer rects remain than expected (a stand-in resolved anyway)', () => {
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 2,
        imageCount: 15,
        requiredNpcKeyCount: 3,
        resolvedNpcKeyCount: 3,
        expectedPersistentPlaceholderCount: 3,
      }),
    ).toBe(true);
  });

  it('defaults expected persistent count to 0 (any rect blocks a fully-catalog piece)', () => {
    // Omitting the field must preserve the original "zero rects" contract.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 1,
        imageCount: 12,
        requiredNpcKeyCount: 0,
        resolvedNpcKeyCount: 0,
      }),
    ).toBe(false);
  });

  it('still guards liveness with expected persistent placeholders (no images yet)', () => {
    // Pre-sync: even if every rect drawn so far is an expected stand-in, zero
    // images means nothing real has rendered — not ready.
    expect(
      isSetPieceRenderReady({
        placeholderRectCount: 3,
        imageCount: 0,
        requiredNpcKeyCount: 0,
        resolvedNpcKeyCount: 0,
        expectedPersistentPlaceholderCount: 3,
      }),
    ).toBe(false);
  });
});

/**
 * `spriteRefRendersPersistentPlaceholder` decides which prop layers count toward
 * the expected-persistent placeholder budget: only a `custom` ref with NO
 * placeholder fallback renders a forever-Rectangle (mirrors the bridge's
 * `resolveSetPieceSprite` guaranteed-null branch). Everything else either
 * resolves to an Image or is only transiently a Rectangle while its texture
 * loads, so the gate must keep waiting on it.
 */
describe('spriteRefRendersPersistentPlaceholder', () => {
  it('is true for a custom ref with no placeholder (queued-art stand-in)', () => {
    const ref: SpriteRef = {
      source: 'custom',
      requestId: 'welcome-room-potted-plant',
      label: 'Potted plant',
      prompt: 'a leafy potted plant',
    };
    expect(spriteRefRendersPersistentPlaceholder(ref)).toBe(true);
  });

  it('is false for a custom ref WITH a placeholder (renders the fallback art)', () => {
    const ref: SpriteRef = {
      source: 'custom',
      requestId: 'welcome-room-side-table',
      label: 'Side table',
      prompt: 'a small wooden side table',
      placeholder: { source: 'catalog', spriteId: 'table-var-0' },
    };
    expect(spriteRefRendersPersistentPlaceholder(ref)).toBe(false);
  });

  it('is false for catalog and sheet refs (resolve or are only transient rects)', () => {
    const catalog: SpriteRef = { source: 'catalog', spriteId: 'rug-var-0' };
    const sheet: SpriteRef = { source: 'sheet', sheetKey: 'kenney', col: 2, row: 3 };
    expect(spriteRefRendersPersistentPlaceholder(catalog)).toBe(false);
    expect(spriteRefRendersPersistentPlaceholder(sheet)).toBe(false);
  });
});
