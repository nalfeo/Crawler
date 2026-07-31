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

/** Terse call helper: keys present, sheet on/off, orientation. */
function resolve(
  isOpen: boolean,
  opts: {
    keys?: readonly string[];
    hasSheet?: boolean;
    orientation?: DoorOrientation;
  } = {},
) {
  return resolveDoorRenderMode(isOpen, {
    orientation: opts.orientation ?? 'horizontal',
    availableGeneratedKeys: new Set(opts.keys ?? []),
    hasSheet: opts.hasSheet ?? false,
  });
}

/**
 * Pure precedence logic for door-tile art selection (mode only — the renderer
 * maps a mode to a concrete Image and derives scale from the loaded texture via
 * the ONE shared contain-fit).
 *
 * The matrix that matters:
 *  - There is no longer a terrain-pack branch. Packs used to win outright for
 *    both states and both orientations with their own full-cell geometry rule;
 *    that entire path is retired, so art source no longer decides door size.
 *  - Within one open/closed state: exact-orientation generated >
 *    other-orientation generated > that state's Kenney frame > solid color.
 *  - A borrowed-orientation pick is reported as `orientationMatch: 'cross'` so
 *    the renderer can count it and the e2e gate can require zero.
 *  - The chain NEVER crosses the open/closed boundary. Closed art on an open
 *    tile would draw a shut leaf on a tile the player is walking through, which
 *    is a worse lie than an honest placeholder. The four `isOpen=true` +
 *    closed-keys-only cases below pin that.
 *  - Generated selection is independent of `hasSheet`.
 */
describe('resolveDoorRenderMode', () => {
  it('no pack branch exists — art source can no longer override generated art', () => {
    // INVERTED GUARD. This replaces two tests that asserted a pack texture key
    // beat generated art for both states. Packs no longer carry door art, and
    // the resolver no longer accepts a pack key at all, so the only way to
    // regress is to reintroduce the branch — which would have to reintroduce
    // this input. The type-level absence is pinned by the resolve() helper
    // above; this pins the behaviour: generated always wins when available.
    expect(resolve(true, { keys: ALL_GENERATED_DOOR_TEXTURE_KEYS, hasSheet: true })).toEqual({
      kind: 'generated',
      textureKey: K.openHorizontal,
      orientationMatch: 'exact',
    });
    expect(
      resolve(false, {
        keys: ALL_GENERATED_DOOR_TEXTURE_KEYS,
        hasSheet: true,
        orientation: 'vertical',
      }),
    ).toEqual({
      kind: 'generated',
      textureKey: K.closedVertical,
      orientationMatch: 'exact',
    });
  });

  it('closed + generated + sheet → generated (generated wins the closed precedence)', () => {
    expect(resolve(false, { keys: [K.closedHorizontal], hasSheet: true })).toEqual({
      kind: 'generated',
      textureKey: K.closedHorizontal,
      orientationMatch: 'exact',
    });
  });

  it('closed + generated + NO sheet → generated (independent of the Kenney sheet)', () => {
    expect(resolve(false, { keys: [K.closedHorizontal], hasSheet: false })).toEqual({
      kind: 'generated',
      textureKey: K.closedHorizontal,
      orientationMatch: 'exact',
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
      ).toEqual({ kind: 'generated', textureKey: K.closedVertical, orientationMatch: 'exact' });
    });

    it('horizontal doorway prefers the horizontal key when both are available', () => {
      expect(
        resolve(false, {
          keys: [K.closedHorizontal, K.closedVertical],
          orientation: 'horizontal',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal, orientationMatch: 'exact' });
    });

    it('vertical doorway falls back to the horizontal key, reported as cross', () => {
      // When the side-on art is unavailable, a side doorway must keep the
      // generated art family (face-on leaf) instead of regressing to Kenney —
      // but the borrow is REPORTED, not silent, so the e2e gate can require zero.
      expect(
        resolve(false, { keys: [K.closedHorizontal], orientation: 'vertical', hasSheet: true }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal, orientationMatch: 'cross' });
    });

    it('open vertical doorway falls back to open-horizontal (cross), not to closed art', () => {
      expect(
        resolve(true, {
          keys: [K.openHorizontal, K.closedVertical],
          orientation: 'vertical',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.openHorizontal, orientationMatch: 'cross' });
    });

    it('every exact-orientation pick reports exact, every borrow reports cross', () => {
      // Exhaustive over state x orientation: with ONLY the doorway's own key
      // present the match is exact; with ONLY the other key present it is cross.
      const own = {
        'false:horizontal': K.closedHorizontal,
        'false:vertical': K.closedVertical,
        'true:horizontal': K.openHorizontal,
        'true:vertical': K.openVertical,
      } as const;
      for (const isOpen of [false, true] as const) {
        for (const orientation of ['horizontal', 'vertical'] as const) {
          const mine = own[`${isOpen}:${orientation}`];
          const theirs = own[`${isOpen}:${orientation === 'vertical' ? 'horizontal' : 'vertical'}`];
          expect(resolve(isOpen, { keys: [mine], orientation, hasSheet: true })).toEqual({
            kind: 'generated',
            textureKey: mine,
            orientationMatch: 'exact',
          });
          expect(resolve(isOpen, { keys: [theirs], orientation, hasSheet: true })).toEqual({
            kind: 'generated',
            textureKey: theirs,
            orientationMatch: 'cross',
          });
        }
      }
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
        [K.openVertical, true],
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
