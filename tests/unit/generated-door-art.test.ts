import { describe, expect, it } from 'vitest';
import { loadShippedManifest } from '../helpers/generated-manifest.js';
import {
  GENERATED_DOOR_TEXTURE_KEYS,
  DOOR_TARGET_HEIGHT_FT,
  resolveGeneratedDoorContainFit,
} from '../../src/engine/sprites/door-visuals.js';

const ALL_GENERATED_DOOR_TEXTURE_KEYS = Object.values(GENERATED_DOOR_TEXTURE_KEYS);

/**
 * The door render contract in `MainGameScene.updateDoorOverlay()` CONTAIN-fits
 * the sprite's OPAQUE BOX into a one-cell (4 ft) × DOOR_TARGET_HEIGHT_FT (6.5 ft)
 * box: a single uniform scale
 *
 *   scale = min(tileSize / box.width, doorTargetHeightPx / box.height)
 *
 * that never exceeds EITHER axis, pinned by the box's bottom-centre to the tile's
 * bottom edge. Whichever term is smaller binds; the other axis comes in under its
 * cap.
 *
 * This clamps WIDTH to one cell. The renderer was formerly HEIGHT-authoritative
 * (`doorTargetHeightPx / box.height` alone): height was pinned at 6.5 ft and width
 * followed the art's ~1:1.25 aspect, rendering a ~5.2 ft leaf in a 4 ft cell. That
 * overhang used to land on solid masonry, but once the wall silhouettes were inset
 * earlier in this series it spilled onto visible floor — the "doors are the wrong
 * widths" defect. Clamping width to one cell removes the spill.
 *
 * The accepted cost, chosen explicitly by the maintainer: the face-on N/S art
 * (aspect ~0.8) now binds on WIDTH and renders SHORTER than 6.5 ft (4.90 ft closed,
 * 5.07 ft open) — a shade under the 5.75 ft player. Taller N/S art hit a hard
 * generator ceiling, so a ~5 ft door that fits its cell was preferred to a 6.5 ft
 * door that spills onto floor. The side-on E/W art (aspect ~0.47) binds on HEIGHT
 * instead and renders as a correct narrow ~3.1 ft × 6.5 ft strip.
 *
 * The OPAQUE box's aspect is what decides which axis binds and how the door reads.
 * It is invisible in the def, the manifest and every sensor; only decoding the
 * shipped PNG's alpha shows it — hence this test measures it directly.
 *
 * NON-TAUTOLOGY NOTE: neutralising the fix in the renderer (reverting the scale to
 * the old height-only `doorTargetHeightPx / box.height`) makes every face-on door
 * render ~5.3 ft wide, which fails both the "no door wider than one cell" gate and
 * the "face-on art binds on width" gate below. Mirror any change to the render
 * rule here.
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
 * One dungeon cell in feet — the WIDTH cap. Matches `DEFAULT_MAP_CONFIG.tileSizeFt`
 * (src/shared/map-types.ts), the tile size Floor 1 renders at, which the renderer
 * reads as `floorMap.config.tileSizeFt`. A door wider than its cell overhangs onto
 * neighbouring floor — the defect this render rule exists to prevent.
 */
const TILE_WIDTH_FT = 4;
/**
 * A doorway narrower than this reads as a slit rather than a passage. The face-on
 * leaves fill the cell (4 ft); the side-on strip is intentionally thin (~3.1 ft),
 * so this floor sits just below it.
 */
const MIN_DOOR_WIDTH_FT = 3;
/** Float slop for equality against a cap (feet). Well below one on-screen pixel. */
const EPS_FT = 1e-6;

/**
 * Rendered size of a door's opaque box under the CONTAIN-fit. The px→ft factor
 * (PIXELS_PER_FOOT) is common to both scale terms and to the box dimensions, so it
 * cancels and the ratio math can be done directly on the opaque-box pixels.
 */
function renderedFt(bounds: NonNullable<ManifestEntry['opaqueBounds']>): {
  widthFt: number;
  heightFt: number;
} {
  const fit = resolveGeneratedDoorContainFit({
    bounds,
    canvasWidth: bounds.canvasWidth,
    canvasHeight: bounds.canvasHeight,
    targetWidth: TILE_WIDTH_FT,
    targetHeight: DOOR_TARGET_HEIGHT_FT,
  });
  return {
    widthFt: fit.scale * bounds.width,
    heightFt: fit.scale * bounds.height,
  };
}

const manifest = loadShippedManifest() as unknown as {
  entries: Record<string, ManifestEntry>;
};

const approved: Array<{ key: string; entry: ManifestEntry }> =
  ALL_GENERATED_DOOR_TEXTURE_KEYS.flatMap((key) => {
    const entry = manifest.entries[key];
    return entry === undefined ? [] : [{ key, entry }];
  });

describe('generated door art contract', () => {
  it('at least one generated door variant is approved and wired', () => {
    // Guards the suite against passing vacuously: if every door key were
    // unapproved, every per-key assertion below would silently vanish and this
    // file would be a window rather than a test.
    expect(approved.length).toBeGreaterThanOrEqual(1);
    expect(approved.map((r) => r.key)).toContain(GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal);
  });

  it('NO door renders wider than one cell, in EITHER orientation', () => {
    // The hard gate for the width-clamp fix. Under the old height-authoritative
    // rule the face-on leaves rendered ~5.3 ft wide in a 4 ft cell and overhung
    // onto visible floor; contain-fitting caps width at one cell. Asserted for
    // every approved key (face-on AND side-on) so a regression in either
    // orientation is caught.
    for (const { key, entry } of approved) {
      const { widthFt } = renderedFt(entry.opaqueBounds!);
      expect(widthFt, `${key} rendered width`).toBeLessThanOrEqual(TILE_WIDTH_FT + EPS_FT);
    }
  });

  it('NO door renders taller than DOOR_TARGET_HEIGHT_FT', () => {
    // The other axis of the contain-fit: height is a maximum, not a target. A
    // door taller than the cap would overhang the wall above into the room north.
    for (const { key, entry } of approved) {
      const { heightFt } = renderedFt(entry.opaqueBounds!);
      expect(heightFt, `${key} rendered height`).toBeLessThanOrEqual(
        DOOR_TARGET_HEIGHT_FT + EPS_FT,
      );
    }
  });

  it('face-on N/S art binds on WIDTH; side-on E/W art binds on HEIGHT', () => {
    // The two door families are shaped differently on purpose, and the contain-fit
    // must respect that. A face-on leaf (aspect ~0.8) is meant to fill the 4 ft
    // cell and come in short — it binds on WIDTH. The side-on leaf (aspect ~0.47)
    // is viewed edge-on and should render as a narrow tall strip — it binds on
    // HEIGHT and reaches the full 6.5 ft. If the side-on key ever regressed to
    // face-on art (the bug PR #2375 fixed), it would bind on width instead and
    // this fails.
    const closedH = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal]?.opaqueBounds;
    const openH = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.openHorizontal]?.opaqueBounds;
    const closedV = manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedVertical]?.opaqueBounds;
    expect(closedH).toBeDefined();
    expect(openH).toBeDefined();
    expect(closedV, 'side-on E/W art must be shipped and wired').toBeDefined();

    // Face-on leaves width-bind: they fill the cell while staying under max height.
    expect(Math.abs(renderedFt(closedH!).widthFt - TILE_WIDTH_FT)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(renderedFt(openH!).widthFt - TILE_WIDTH_FT)).toBeLessThanOrEqual(0.01);
    expect(renderedFt(closedV!).widthFt).toBeLessThan(TILE_WIDTH_FT);
    // Side-on strip height-binds: it reaches max height while staying under width cap.
    expect(Math.abs(renderedFt(closedV!).heightFt - DOOR_TARGET_HEIGHT_FT)).toBeLessThanOrEqual(
      0.01,
    );
    expect(renderedFt(closedH!).heightFt).toBeLessThan(DOOR_TARGET_HEIGHT_FT);
  });

  it('open and closed FACE-ON leaves render at the SAME WIDTH (two frames of one door)', () => {
    // A doorway is a fixed hole in the wall: swinging the leaf must not resize it.
    // Both face-on leaves bind on width and fill the cell, so their rendered widths
    // must agree. Two independently-sampled states can silently disagree about
    // size, and nothing else in the stack can see it — both PNGs are valid, both
    // pass every sensor and the VLM judge. The defect exists only in the
    // RELATIONSHIP between the two.
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

  it('both HORIZONTAL door keys name art that actually exists', () => {
    // The wired key is a hand-typed variant index, and `sprites:approve` writes
    // whichever index won review — so the two are free to drift apart silently.
    // When they do, the renderer's fallback chain hides it perfectly: the door
    // simply keeps rendering Kenney placeholder art and nothing fails. That is
    // exactly how `welcome-room-door-var-2` sat approved with zero consumers.
    expect(manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedHorizontal]).toBeDefined();
    expect(manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.openHorizontal]).toBeDefined();
  });

  it('the side-on (closed E/W) key names art that actually exists', () => {
    // PR #2375 shipped genuine side-on art for the closed E/W door and this PR
    // wired it. Unlike the still-missing OPEN E/W key, the closed side-on key must
    // resolve to a real entry or the renderer silently falls back to the face-on
    // leaf and the edge-on read is lost with nothing failing.
    expect(manifest.entries[GENERATED_DOOR_TEXTURE_KEYS.closedVertical]).toBeDefined();
  });

  for (const key of ALL_GENERATED_DOOR_TEXTURE_KEYS) {
    const entry = manifest.entries[key];
    if (!entry) {
      // Not yet generated (e.g. the OPEN E/W door failed generation). The
      // renderer's fallback chain covers it; nothing to assert until the art lands.
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

      it('renders to a plausible doorway WIDTH once contain-fitted', () => {
        // Measured on the OPAQUE box, not the canvas: transparent margins are
        // scaled away by the same factor, so they cannot change the result. The
        // contain-fit caps width at one cell; the floor keeps a side-on strip from
        // collapsing to a slit.
        const { widthFt } = renderedFt(bounds!);
        expect(widthFt).toBeGreaterThanOrEqual(MIN_DOOR_WIDTH_FT);
        expect(widthFt).toBeLessThanOrEqual(TILE_WIDTH_FT + EPS_FT);
      });
    });
  }
});
