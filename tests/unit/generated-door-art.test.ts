import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GENERATED_DOOR_TEXTURE_KEYS,
  ALL_GENERATED_DOOR_TEXTURE_KEYS,
  DOOR_TARGET_HEIGHT_FT,
} from '../../src/engine/sprites/door-visuals.js';

/**
 * The door render contract in `MainGameScene.updateDoorOverlay()` is
 * HEIGHT-authoritative and anchored on the sprite's OPAQUE BOX: the texture is
 * scaled by `ftToPx(DOOR_TARGET_HEIGHT_FT) / box.height` and pinned by the box's
 * bottom-centre to the tile's bottom edge, so every door renders at the same
 * real-world height and the WIDTH follows the opaque box's aspect, overhanging
 * onto the neighbouring wall tiles.
 *
 * That is the reverse of the original rule, and the reversal is the point. While
 * the renderer was width-authoritative (`tileSize / box.width`), rendered height
 * was whatever aspect the generator happened to produce — measured at 4.90 ft for
 * the shipped closed leaf, i.e. a doorway shorter than the 5.75 ft player walking
 * through it. Three brief rounds asking for a ~1:1.75 archway moved the delivered
 * aspect by zero, so the aspect is a generator capability limit and the renderer
 * is the only lever that moves.
 *
 * This deliberately does NOT require full-bleed art. An earlier revision asserted
 * it, which was wrong: the image model draws into a SQUARE cell and
 * `sizeVariant: tall` is banned (portrait cells slice into stacked-object
 * columns), so a tall door can ONLY ship as a tall subject inside a square canvas
 * with transparent margins. Anchoring on the opaque box makes canvas padding
 * irrelevant instead.
 *
 * What still matters is the OPAQUE box's aspect, because it now decides how WIDE
 * the door renders — and how far it overhangs. It is invisible in the def, the
 * manifest and every sensor; only decoding the shipped PNG's alpha shows it.
 */

interface ManifestEntry {
  readonly spriteName: string;
  readonly opaqueBounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
  };
}

/**
 * The player avatar's height. Any doorway must clear it — a door shorter than the
 * person walking through it was the defect that drove the height-authoritative
 * render rule (see DOOR_TARGET_HEIGHT_FT).
 */
const PLAYER_HEIGHT_FT = 5.75;
/**
 * A doorway narrower than a person, or wider than the room it opens into, is a
 * brief bug. Under the height-authoritative fit the free axis is WIDTH, so this
 * is the axis worth bounding: rendered width = DOOR_TARGET_HEIGHT_FT * aspect.
 */
const MIN_DOOR_WIDTH_FT = 3;
const MAX_DOOR_WIDTH_FT = 6.5;

/** Rendered size of a door's opaque box under the height-authoritative fit. */
function renderedFt(bounds: { width: number; height: number }): {
  widthFt: number;
  heightFt: number;
} {
  return {
    heightFt: DOOR_TARGET_HEIGHT_FT,
    widthFt: DOOR_TARGET_HEIGHT_FT * (bounds.width / bounds.height),
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/assets/generated/manifest.json'), 'utf8'),
) as { entries: Record<string, ManifestEntry> };

const approved = ALL_GENERATED_DOOR_TEXTURE_KEYS.map((key) => ({
  key,
  entry: manifest.entries[key],
})).filter((row): row is { key: string; entry: ManifestEntry } => row.entry !== undefined);

describe('generated door art contract', () => {
  it('at least one generated door variant is approved and wired', () => {
    // Guards the suite against passing vacuously: if every door key were
    // unapproved, every per-key assertion below would silently vanish and this
    // file would be a window rather than a test.
    expect(approved.length).toBeGreaterThanOrEqual(1);
    expect(approved.map((r) => r.key)).toContain(GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal);
  });

  it('open and closed render at the SAME WIDTH (two frames of one door)', () => {
    // A doorway is a fixed hole in the wall: swinging the leaf must not resize it.
    // Two independently-sampled states silently disagree about size, and nothing
    // else in the stack can see it — both PNGs are valid, both pass every sensor
    // and the VLM judge, and each is individually plausible. The defect exists
    // only in the RELATIONSHIP between the two. The first approved pair rendered
    // 5.92 ft closed and 4.47 ft open, so a door SHRANK 24% when it opened.
    //
    // This assertion is on WIDTH, and that axis choice is the whole point. The
    // original version asserted HEIGHT parity, which was correct while the
    // renderer was width-authoritative (width pinned to the tile, height free to
    // follow the art's aspect). The renderer is now height-authoritative, so
    // height is pinned to DOOR_TARGET_HEIGHT_FT for every door by construction
    // and a height assertion could no longer fail for any input — it would be a
    // window, not a test. Width is now the free axis, so width is what must be
    // checked. Same defect, moved axis.
    const closed = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal]?.opaqueBounds;
    const open = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.openHorizontal]?.opaqueBounds;
    expect(closed).toBeDefined();
    expect(open).toBeDefined();

    const closedWidthFt = renderedFt(closed!).widthFt;
    const openWidthFt = renderedFt(open!).widthFt;
    // 0.5 ft = 4 px on screen at the real 32 px tile — below the threshold where
    // a state change reads as a size pop rather than as the door moving.
    expect(Math.abs(closedWidthFt - openWidthFt)).toBeLessThanOrEqual(0.5);
  });

  it('every door renders taller than the player', () => {
    // The requirement this whole render rule exists to satisfy, asserted directly
    // rather than inferred from the constant. Kept as a real check (not a tautology
    // on DOOR_TARGET_HEIGHT_FT alone) because lowering that constant below the
    // avatar's height is precisely the silent regression worth catching.
    expect(DOOR_TARGET_HEIGHT_FT).toBeGreaterThan(PLAYER_HEIGHT_FT);
    for (const { entry } of approved) {
      expect(renderedFt(entry.opaqueBounds!).heightFt).toBeGreaterThan(PLAYER_HEIGHT_FT);
    }
  });

  it('both HORIZONTAL door keys name art that actually exists', () => {
    // The wired key is a hand-typed variant index, and `sprites:approve` writes
    // whichever index won review — so the two are free to drift apart silently.
    // When they do, the renderer's fallback chain hides it perfectly: the door
    // simply keeps rendering Kenney placeholder art and nothing fails. That is
    // exactly how `welcome-room-door-var-2` sat approved with zero consumers.
    // Vertical keys are deliberately exempt: their art is not generated yet, and
    // falling back is the intended behaviour until it is.
    expect(manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal]).toBeDefined();
    expect(manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.openHorizontal]).toBeDefined();
  });

  for (const key of ALL_GENERATED_DOOR_TEXTURE_KEYS) {
    const entry = manifest.entries[key];
    if (!entry) {
      // Not yet generated. The renderer's fallback chain covers it; nothing to
      // assert until the art lands.
      continue;
    }

    describe(key, () => {
      const bounds = entry.opaqueBounds;

      it('declares opaqueBounds (the render contract reads it)', () => {
        expect(bounds).toBeDefined();
      });

      it('has a non-degenerate opaque box', () => {
        expect(bounds!.width).toBeGreaterThan(0);
        expect(bounds!.height).toBeGreaterThan(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(bounds!.canvasWidth);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(bounds!.canvasHeight);
      });

      it('renders to a plausible doorway WIDTH once height-fitted', () => {
        // Measured on the OPAQUE box, not the canvas: transparent margins are
        // scaled away by the same factor, so they cannot change the result.
        // Width is the free axis under the height-authoritative fit — an arch
        // this wide overhangs onto the neighbouring wall tiles, which is
        // accepted, but only up to a point.
        const { widthFt } = renderedFt(bounds!);
        expect(widthFt).toBeGreaterThanOrEqual(MIN_DOOR_WIDTH_FT);
        expect(widthFt).toBeLessThanOrEqual(MAX_DOOR_WIDTH_FT);
      });
    });
  }
});
