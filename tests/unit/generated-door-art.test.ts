import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GENERATED_DOOR_TEXTURE_KEYS,
  ALL_GENERATED_DOOR_TEXTURE_KEYS,
} from '../../src/engine/sprites/door-visuals.js';

/**
 * The door render contract in `MainGameScene.updateDoorOverlay()` is
 * WIDTH-authoritative and BOTTOM-anchored: the texture is scaled by
 * `tileSize / srcWidth` and pinned by its bottom-centre to the tile's bottom
 * edge, so the height follows the art's aspect ratio and any excess grows upward
 * into the wall tile above.
 *
 * That math is only correct if the art is full-bleed horizontally (leaf + jambs
 * touch both side edges, so canvas width == doorway width) and bottom-aligned
 * (canvas bottom == the floor line). Those were brief instructions; this makes
 * them a check, because a brief is a hope and art regenerates.
 *
 * A door sprite that violates either one renders narrower than its doorway or
 * floating above the floor — both invisible in the def, the manifest and every
 * sensor, and only visible by decoding the shipped PNG's alpha.
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

      it('is full-bleed horizontally, so canvas width == doorway width', () => {
        expect(bounds!.x).toBe(0);
        expect(bounds!.x + bounds!.width).toBe(bounds!.canvasWidth);
      });

      it('is bottom-aligned, so the canvas bottom is the floor line', () => {
        expect(bounds!.y + bounds!.height).toBe(bounds!.canvasHeight);
      });

      it('renders to a plausible door height once width-fitted to one tile', () => {
        const heightFt = FEET_PER_TILE * (bounds!.canvasHeight / bounds!.canvasWidth);
        expect(heightFt).toBeGreaterThanOrEqual(MIN_DOOR_HEIGHT_FT);
        expect(heightFt).toBeLessThanOrEqual(MAX_DOOR_HEIGHT_FT);
      });
    });
  }
});
