/**
 * Pins every set-piece layer's declared real-world size to the art it actually
 * ships, because the game NEVER stretches a sprite to match declared feet.
 *
 * WHY THIS EXISTS. `PhaserBridge.ts` picks a single uniform scale factor via
 * `resolveOpaqueFit`:
 *
 *   upright (floorPlane !== true) -> scale = heightPx / opaqueHeight
 *   floor decal (floorPlane === true) -> Math.min(wPx / opaqueW, hPx / opaqueH)
 *
 * and `floorPlane` is derived from `prop.kind === 'floor'` in stampSetPiece.ts.
 * So for an UPRIGHT prop `widthFt` is read, converted, and then thrown away --
 * the drawn width is always `heightFt * (opaqueW / opaqueH)`. That made 20 of
 * the welcome room's declared widths pure fiction: `welcome-desk` claimed 9.24ft
 * and drew 6.06ft, `welcome-banner` claimed 3.20ft and drew 6.06ft.
 *
 * Fiction in this field is not cosmetic. `composition-score.ts` -- the
 * deterministic gate -- reads `widthFt` for its scale and bulk checks, and every
 * prop brief quotes it as the size to draw to. A number that no renderer honours
 * but two consumers trust is the "green that cannot go red" shape: nothing can
 * ever disagree with it, so nothing can ever catch it being wrong.
 *
 * The assertion below is derived from the CONSUMER (the scale branch above), not
 * from whatever the current props happen to contain -- a rule fitted to today's
 * data is accidentally right until the sample that breaks it.
 *
 * IT CALLS `resolveOpaqueFit` RATHER THAN RE-DERIVING THE MATH, and that is
 * load-bearing. This file previously recomputed the scale from the sprite's full
 * canvas. When the renderer moved to opaque bounds, the test kept passing --
 * because the declared widths had been fitted to the same stale rectangle the
 * test was measuring, so both sides drifted together and nothing could disagree.
 * That is the exact failure this file was written to prevent, reproduced one
 * layer out. Importing the consumer's own function is what makes the pin real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { loadShippedManifest } from '../helpers/generated-manifest.js';
import setPieces from '../../src/shared/data/set-pieces.json' with { type: 'json' };
import { resolveOpaqueFit, type OpaqueBounds } from '../../src/shared/generated-assets.js';

const ROOT = process.cwd();
const ENTRIES = loadShippedManifest().entries as Record<
  string,
  { assetPath?: string; opaqueBounds?: OpaqueBounds }
>;

interface Native {
  readonly w: number;
  readonly h: number;
  readonly bounds: OpaqueBounds | undefined;
}

/** Native canvas size + opaque bounds of a shipped sprite, or null when absent. */
function nativeSize(spriteId: string): Native | null {
  const entry = ENTRIES[spriteId];
  if (!entry?.assetPath) return null;
  const file = path.join(ROOT, 'public/assets', entry.assetPath);
  if (!fs.existsSync(file)) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  return { w: png.width, h: png.height, bounds: entry.opaqueBounds };
}

/**
 * Visible size the game draws for a layer, in feet. Feet are passed where the
 * renderer passes pixels: `resolveOpaqueFit` only ever returns a ratio, so the
 * units cancel and the result is directly comparable to the declared feet.
 */
function drawnFeet(
  native: Native,
  widthFt: number,
  heightFt: number,
  floorPlane: boolean,
): { w: number; h: number } {
  const fit = resolveOpaqueFit({
    bounds: native.bounds,
    canvasWidth: native.w,
    canvasHeight: native.h,
    targetWidthPx: widthFt,
    targetHeightPx: heightFt,
    anchorBase: false,
    floorPlane,
  });
  const box = native.bounds ?? { width: native.w, height: native.h };
  return { w: box.width * fit.scale, h: box.height * fit.scale };
}

interface Layer {
  sprite?: { spriteId?: string };
  widthFt?: number;
  heightFt?: number;
}
interface Prop {
  id: string;
  kind?: string;
  layers?: Layer[];
}

const measured = (setPieces.setPieces as Array<{ id: string; props?: Prop[] }>).flatMap((piece) =>
  (piece.props ?? []).flatMap((prop) =>
    (prop.layers ?? []).map((layer, index) => ({ piece: piece.id, prop, layer, index })),
  ),
);

describe('set-piece declared feet match the shipped art', () => {
  it('has layers to check, so a resolution bug cannot make this vacuous', () => {
    // Without this, a typo in the manifest path would skip every case and the
    // suite would pass by checking nothing at all.
    const resolvable = measured.filter(
      ({ layer }) =>
        layer.widthFt !== undefined &&
        layer.heightFt !== undefined &&
        layer.sprite?.spriteId !== undefined &&
        nativeSize(layer.sprite.spriteId) !== null,
    );
    expect(resolvable.length).toBeGreaterThan(20);
  });

  it('declares upright widths that equal what the height-authoritative scale draws', () => {
    const wrong: string[] = [];
    for (const { piece, prop, layer, index } of measured) {
      if (prop.kind === 'floor') continue;
      if (layer.widthFt === undefined || layer.heightFt === undefined) continue;
      const spriteId = layer.sprite?.spriteId;
      if (!spriteId) continue;
      const native = nativeSize(spriteId);
      if (!native) continue;

      const drawn = drawnFeet(native, layer.widthFt, layer.heightFt, false);
      // 0.05ft is well under a pixel at game scale but far tighter than any of
      // the 20 real divergences, which ran from 25% to 89% off.
      if (Math.abs(drawn.w - layer.widthFt) > 0.05) {
        wrong.push(
          `${piece}/${prop.id} L${index}: declares ${layer.widthFt}ft wide, ` +
            `game draws ${drawn.w.toFixed(2)}ft (art ${native.w}x${native.h})`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps floor-decal opaque footprints within declared contain-fit bounds', () => {
    const wrong: string[] = [];
    for (const { piece, prop, layer, index } of measured) {
      if (prop.kind !== 'floor') continue;
      if (layer.widthFt === undefined || layer.heightFt === undefined) continue;
      const spriteId = layer.sprite?.spriteId;
      if (!spriteId) continue;
      const native = nativeSize(spriteId);
      if (!native) continue;

      const drawn = drawnFeet(native, layer.widthFt, layer.heightFt, true);
      if (drawn.w - layer.widthFt > 0.05 || drawn.h - layer.heightFt > 0.05) {
        wrong.push(
          `${piece}/${prop.id} L${index}: declares max ${layer.widthFt}x${layer.heightFt}ft, ` +
            `contain-fit draws ${drawn.w.toFixed(2)}x${drawn.h.toFixed(2)}ft`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});
