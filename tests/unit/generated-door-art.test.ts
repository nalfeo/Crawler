import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GENERATED_DOOR_TEXTURE_KEYS,
  ALL_GENERATED_DOOR_TEXTURE_KEYS,
} from '../../src/engine/sprites/door-visuals.js';

/**
 * The door render contract in `MainGameScene.updateDoorOverlay()` is
 * WIDTH-authoritative and anchored on the sprite's OPAQUE BOX: the texture is
 * scaled by `tileSize / box.width` and pinned by the box's bottom-centre to the
 * tile's bottom edge, so the rendered height follows the opaque box's aspect and
 * any excess grows upward into the wall tile above.
 *
 * Note this deliberately does NOT require full-bleed or bottom-aligned art.
 * An earlier revision of this file asserted both, which was wrong: the image
 * model draws into a SQUARE cell and `sizeVariant: tall` is banned (portrait
 * cells slice into stacked-object columns), so a door taller than it is wide
 * can ONLY ship as a tall subject inside a square canvas with transparent
 * margins. Requiring full-bleed would have made a 7 ft door unrepresentable.
 * Anchoring on the opaque box makes canvas padding irrelevant instead.
 *
 * What still matters is the OPAQUE box's aspect, because that alone decides how
 * tall the door renders once its width is pinned to the doorway. A door whose
 * opaque box is square renders 4 ft — shorter than the 5.75 ft player, which is
 * the defect this whole change exists to fix, and it is invisible in the def,
 * the manifest and every sensor. Only decoding the shipped PNG's alpha shows it.
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

const FEET_PER_TILE = 4;
/** A door narrower than the doorway or taller than a two-storey arch is a brief bug. */
const MIN_DOOR_HEIGHT_FT = 4;
const MAX_DOOR_HEIGHT_FT = 8.5;

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

  it('open and closed render at the SAME height (two frames of one door)', () => {
    // A doorway is a fixed hole in the wall: swinging the leaf must not resize
    // it. Because the renderer pins width to the tile and lets height follow the
    // opaque box's aspect, two independently-sampled states silently disagree —
    // the first approved pair rendered 5.92 ft closed and 4.47 ft open, so a door
    // SHRANK 24% when it opened. Nothing else in the stack can see that: both
    // PNGs are valid, both pass every sensor, and each is individually plausible.
    // The defect exists only in the RELATIONSHIP between the two.
    const closed = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal]?.opaqueBounds;
    const open = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.openHorizontal]?.opaqueBounds;
    expect(closed).toBeDefined();
    expect(open).toBeDefined();

    const closedFt = FEET_PER_TILE * (closed!.height / closed!.width);
    const openFt = FEET_PER_TILE * (open!.height / open!.width);
    // 0.5 ft ~= 4 px on screen at the real 32 px tile — below the threshold where
    // a state change reads as a size pop rather than as the door moving.
    expect(Math.abs(closedFt - openFt)).toBeLessThanOrEqual(0.5);
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

      it('renders to a plausible door height once width-fitted to one tile', () => {
        // Measured on the OPAQUE box, not the canvas: transparent margins are
        // scaled away by the same factor, so they cannot change the result.
        const heightFt = FEET_PER_TILE * (bounds!.height / bounds!.width);
        expect(heightFt).toBeGreaterThanOrEqual(MIN_DOOR_HEIGHT_FT);
        expect(heightFt).toBeLessThanOrEqual(MAX_DOOR_HEIGHT_FT);
      });
    });
  }
});
