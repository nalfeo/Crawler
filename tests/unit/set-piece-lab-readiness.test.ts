import { describe, expect, it } from 'vitest';
import {
  isSetPieceRenderReady,
  type SetPieceRenderCounts,
} from '../../src/labs/set-piece-lab/readiness.js';

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
});
