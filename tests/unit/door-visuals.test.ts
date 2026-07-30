import { describe, expect, it } from 'vitest';
import {
  resolveDoorRenderMode,
  GENERATED_DOOR_TEXTURE_KEYS,
  DOOR_SHEET_KEY,
  DOOR_CLOSED_FRAME,
  DOOR_OPEN_FRAME,
  type DoorOrientation,
} from '../../src/engine/sprites/door-visuals.js';

const K = GENERATED_DOOR_TEXTURE_KEYS;
const ALL_GENERATED_DOOR_TEXTURE_KEYS = Object.values(K);

/** Terse call helper: keys present, sheet on/off, orientation, optional pack key. */
function resolve(
  isOpen: boolean,
  opts: {
    keys?: readonly string[];
    hasSheet?: boolean;
    orientation?: DoorOrientation;
    packDoorTextureKey?: string;
  } = {},
) {
  return resolveDoorRenderMode(isOpen, {
    orientation: opts.orientation ?? 'horizontal',
    availableGeneratedKeys: new Set(opts.keys ?? []),
    hasSheet: opts.hasSheet ?? false,
    packDoorTextureKey: opts.packDoorTextureKey,
  });
}

/**
 * Pure precedence logic for door-tile art selection (mode only — the renderer
 * maps a mode to a concrete Image and derives scale from the loaded texture).
 *
 * The matrix that matters:
 *  - PACK wins outright for both states and both orientations.
 *  - Otherwise, within one open/closed state: exact-orientation generated >
 *    other-orientation generated > that state's Kenney frame > solid color.
 *  - The chain NEVER crosses the open/closed boundary. Closed art on an open
 *    tile would draw a shut leaf on a tile the player is walking through, which
 *    is a worse lie than an honest placeholder. The four `isOpen=true` +
 *    closed-keys-only cases below pin that, and they are the direct successors
 *    of the older "generated never leaks into open" guards — the open state is
 *    now reachable by generated art, but ONLY by generated OPEN art.
 *  - Generated selection is independent of `hasSheet`.
 */
describe('resolveDoorRenderMode', () => {
  it('open + pack door variant → pack texture (pack doorSet takes precedence)', () => {
    expect(
      resolve(true, {
        keys: ALL_GENERATED_DOOR_TEXTURE_KEYS,
        hasSheet: true,
        packDoorTextureKey: 'terrain-pack-industrial-cave-door-open-horizontal',
      }),
    ).toEqual({
      kind: 'pack',
      textureKey: 'terrain-pack-industrial-cave-door-open-horizontal',
    });
  });

  it('closed + pack door variant → pack texture (pack doorSet beats generated/kenney)', () => {
    expect(
      resolve(false, {
        keys: ALL_GENERATED_DOOR_TEXTURE_KEYS,
        hasSheet: true,
        orientation: 'vertical',
        packDoorTextureKey: 'terrain-pack-industrial-cave-door-closed-vertical',
      }),
    ).toEqual({
      kind: 'pack',
      textureKey: 'terrain-pack-industrial-cave-door-closed-vertical',
    });
  });

  it('closed + generated + sheet → generated (generated wins the closed precedence)', () => {
    expect(resolve(false, { keys: [K.closedHorizontal], hasSheet: true })).toEqual({
      kind: 'generated',
      textureKey: K.closedHorizontal,
    });
  });

  it('closed + generated + NO sheet → generated (independent of the Kenney sheet)', () => {
    expect(resolve(false, { keys: [K.closedHorizontal], hasSheet: false })).toEqual({
      kind: 'generated',
      textureKey: K.closedHorizontal,
    });
  });

  it('closed + no generated + sheet → kenney-closed', () => {
    expect(resolve(false, { hasSheet: true })).toEqual({ kind: 'kenney-closed' });
  });

  it('closed + no generated + no sheet → color(open=false)', () => {
    expect(resolve(false, { hasSheet: false })).toEqual({ kind: 'color', open: false });
  });

  it('open + sheet → kenney-open', () => {
    expect(resolve(true, { hasSheet: true })).toEqual({ kind: 'kenney-open' });
  });

  it('open + no sheet → color(open=true)', () => {
    expect(resolve(true, { hasSheet: false })).toEqual({ kind: 'color', open: true });
  });

  describe('the open/closed boundary is never crossed', () => {
    // Successors to the original "generated never leaks into open" guards. The
    // rule is no longer "generated is unreachable when open" (open art is now a
    // first-class variant) but the stricter, still-load-bearing "CLOSED art is
    // unreachable when open". All four isOpen=true × closed-keys-only × sheet ×
    // orientation combinations are pinned.
    for (const orientation of ['horizontal', 'vertical'] as const) {
      it(`open + BOTH closed keys + sheet (${orientation}) → kenney-open`, () => {
        expect(
          resolve(true, {
            keys: [K.closedHorizontal, K.closedVertical],
            hasSheet: true,
            orientation,
          }),
        ).toEqual({ kind: 'kenney-open' });
      });

      it(`open + BOTH closed keys + NO sheet (${orientation}) → color(open=true)`, () => {
        expect(
          resolve(true, {
            keys: [K.closedHorizontal, K.closedVertical],
            hasSheet: false,
            orientation,
          }),
        ).toEqual({ kind: 'color', open: true });
      });
    }

    it('closed + BOTH open keys + sheet → kenney-closed (open art never leaks into closed)', () => {
      expect(resolve(false, { keys: [K.openHorizontal, K.openVertical], hasSheet: true })).toEqual({
        kind: 'kenney-closed',
      });
    });
  });

  describe('orientation selection within a state', () => {
    it('vertical doorway prefers the vertical (side-on) key when both are available', () => {
      // The vertical key is genuine side-on E/W art; no rotation is applied.
      expect(
        resolve(false, {
          keys: [K.closedHorizontal, K.closedVertical],
          orientation: 'vertical',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.closedVertical });
    });

    it('horizontal doorway prefers the horizontal key when both are available', () => {
      expect(
        resolve(false, {
          keys: [K.closedHorizontal, K.closedVertical],
          orientation: 'horizontal',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal });
    });

    it('vertical doorway falls back to the horizontal key rather than to Kenney', () => {
      // When the side-on art is unavailable, a side doorway must keep the
      // generated art family (face-on leaf) instead of regressing to Kenney.
      expect(
        resolve(false, { keys: [K.closedHorizontal], orientation: 'vertical', hasSheet: true }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal });
    });

    it('open vertical doorway falls back to open-horizontal, not to closed art', () => {
      // The OPEN E/W door has no art (failed generation), so an open side doorway
      // always falls back to the face-on open leaf. Never to closed art.
      expect(
        resolve(true, {
          keys: [K.openHorizontal, K.closedVertical],
          orientation: 'vertical',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.openHorizontal });
    });
  });

  it('the generated mode carries no rotation state (side-on art needs no turn)', () => {
    // Regression guard for the retired `quarterTurnsCcw` field: the vertical key is
    // now genuine side-on art, so no generated mode may carry a rotation flag.
    for (const orientation of ['horizontal', 'vertical'] as const) {
      for (const [key, isOpen] of [
        [K.closedHorizontal, false],
        [K.closedVertical, false],
        [K.openHorizontal, true],
      ] as const) {
        expect(resolve(isOpen, { keys: [key], orientation, hasSheet: true })).not.toHaveProperty(
          'quarterTurnsCcw',
        );
      }
    }
  });

  it('exports the wired manifest keys + Kenney frames the renderer stamps', () => {
    // Lock the constants the renderer depends on so a rename can't silently
    // un-wire a door variant or swap the open/closed frames.
    expect(K).toEqual({
      closedHorizontal: 'tile-door-v1-var-9',
      closedVertical: 'tile-door-sideon-v1-var-0',
      openHorizontal: 'tile-door-open-v1-var-0',
      openVertical: 'tile-door-open-side-v1-var-0',
    });
    expect(new Set(ALL_GENERATED_DOOR_TEXTURE_KEYS).size).toBe(4);
    expect(DOOR_SHEET_KEY).toBe('kenney-tiny-dungeon');
    expect(DOOR_CLOSED_FRAME).toBe(46);
    expect(DOOR_OPEN_FRAME).toBe(34);
  });
});
