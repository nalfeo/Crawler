import { describe, expect, it } from 'vitest';
import {
  resolveDoorRenderMode,
  GENERATED_DOOR_TEXTURE_KEYS,
  ALL_GENERATED_DOOR_TEXTURE_KEYS,
  DOOR_SHEET_KEY,
  DOOR_CLOSED_FRAME,
  DOOR_OPEN_FRAME,
  type DoorOrientation,
} from '../../src/engine/sprites/door-visuals.js';

const K = GENERATED_DOOR_TEXTURE_KEYS;

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
      quarterTurnsCcw: 0,
    });
  });

  it('closed + generated + NO sheet → generated (independent of the Kenney sheet)', () => {
    expect(resolve(false, { keys: [K.closedHorizontal], hasSheet: false })).toEqual({
      kind: 'generated',
      textureKey: K.closedHorizontal,
      quarterTurnsCcw: 0,
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
    it('vertical doorway prefers the vertical key when both are available', () => {
      expect(
        resolve(false, {
          keys: [K.closedHorizontal, K.closedVertical],
          orientation: 'vertical',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.closedVertical, quarterTurnsCcw: 1 });
    });

    it('horizontal doorway prefers the horizontal key when both are available', () => {
      expect(
        resolve(false, {
          keys: [K.closedHorizontal, K.closedVertical],
          orientation: 'horizontal',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal, quarterTurnsCcw: 0 });
    });

    it('vertical doorway falls back to the horizontal key rather than to Kenney', () => {
      // Today's shipped state: only closed-horizontal art exists. A side doorway
      // must keep the generated art family instead of regressing to Kenney —
      // this is the assertion that makes the change a no-op until new art lands.
      expect(
        resolve(false, { keys: [K.closedHorizontal], orientation: 'vertical', hasSheet: true }),
      ).toEqual({ kind: 'generated', textureKey: K.closedHorizontal, quarterTurnsCcw: 0 });
    });

    it('open vertical doorway falls back to open-horizontal, not to closed art', () => {
      expect(
        resolve(true, {
          keys: [K.openHorizontal, K.closedVertical],
          orientation: 'vertical',
          hasSheet: true,
        }),
      ).toEqual({ kind: 'generated', textureKey: K.openHorizontal, quarterTurnsCcw: 0 });
    });
  });

  describe('quarter-turn (vertical art is authored face-on and rotated by the renderer)', () => {
    // The turn is a property of the ASSET, not of the requested orientation.
    // Deriving it from the resolved key — not from `orientation` — is what keeps
    // every fallback path byte-identical to its pre-rotation behaviour, which is
    // the whole safety argument for the change.
    it('turns both vertical keys exactly one quarter CCW', () => {
      for (const [key, isOpen] of [
        [K.closedVertical, false],
        [K.openVertical, true],
      ] as const) {
        expect(resolve(isOpen, { keys: [key], orientation: 'vertical', hasSheet: true })).toEqual({
          kind: 'generated',
          textureKey: key,
          quarterTurnsCcw: 1,
        });
      }
    });

    it('never turns a horizontal key, even when it is serving a vertical doorway', () => {
      // The regression this pins: rotating on `orientation === "vertical"` rather
      // than on the chosen key would turn face-on horizontal art sideways the
      // moment vertical art is missing — strictly worse than the un-turned
      // fallback it replaced.
      for (const orientation of ['horizontal', 'vertical'] as const) {
        for (const [key, isOpen] of [
          [K.closedHorizontal, false],
          [K.openHorizontal, true],
        ] as const) {
          expect(resolve(isOpen, { keys: [key], orientation, hasSheet: true })).toEqual({
            kind: 'generated',
            textureKey: key,
            quarterTurnsCcw: 0,
          });
        }
      }
    });

    it('leaves every non-generated mode free of rotation state', () => {
      // Pack art is authored per-orientation and must never be turned.
      expect(
        resolve(false, {
          keys: ALL_GENERATED_DOOR_TEXTURE_KEYS,
          orientation: 'vertical',
          hasSheet: true,
          packDoorTextureKey: 'terrain-pack-industrial-cave-door-closed-vertical',
        }),
      ).not.toHaveProperty('quarterTurnsCcw');
      expect(resolve(false, { orientation: 'vertical', hasSheet: true })).not.toHaveProperty(
        'quarterTurnsCcw',
      );
    });
  });

  it('exports the wired manifest keys + Kenney frames the renderer stamps', () => {
    // Lock the constants the renderer depends on so a rename can't silently
    // un-wire a door variant or swap the open/closed frames.
    expect(K).toEqual({
      closedHorizontal: 'tile-door-v1-var-9',
      closedVertical: 'tile-door-side-v1-var-0',
      openHorizontal: 'tile-door-open-v1-var-0',
      openVertical: 'tile-door-open-side-v1-var-0',
    });
    expect(new Set(ALL_GENERATED_DOOR_TEXTURE_KEYS).size).toBe(4);
    expect(DOOR_SHEET_KEY).toBe('kenney-tiny-dungeon');
    expect(DOOR_CLOSED_FRAME).toBe(46);
    expect(DOOR_OPEN_FRAME).toBe(34);
  });
});
