/**
 * Pins every set-piece layer's declared real-world size to the art it actually
 * ships, because the game NEVER stretches a sprite to match declared feet.
 *
 * WHY THIS EXISTS. `PhaserBridge.ts` picks a single uniform scale factor:
 *
 *   upright (floorPlane !== true) -> scale = heightPx / nativeH
 *   floor decal (floorPlane === true) -> Math.min(wPx / nativeW, hPx / nativeH)
 *
 * and `floorPlane` is derived from `prop.kind === 'floor'` in stampSetPiece.ts.
 * So for an UPRIGHT prop `widthFt` is read, converted, and then thrown away --
 * the drawn width is always `heightFt * (nativeW / nativeH)`. That made 20 of
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
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import manifest from '../../public/assets/generated/manifest.json' with { type: 'json' };
import setPieces from '../../src/shared/data/set-pieces.json' with { type: 'json' };

const ROOT = process.cwd();
const ENTRIES = manifest.entries as Record<string, { assetPath?: string }>;

/** Native canvas size of a shipped sprite, or null when it has no generated art. */
function nativeSize(spriteId: string): { w: number; h: number } | null {
  const entry = ENTRIES[spriteId];
  if (!entry?.assetPath) return null;
  const file = path.join(ROOT, 'public/assets', entry.assetPath);
  if (!fs.existsSync(file)) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  return { w: png.width, h: png.height };
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

      const drawnWidthFt = layer.heightFt * (native.w / native.h);
      // 0.05ft is well under a pixel at game scale but far tighter than any of
      // the 20 real divergences, which ran from 25% to 89% off.
      if (Math.abs(drawnWidthFt - layer.widthFt) > 0.05) {
        wrong.push(
          `${piece}/${prop.id} L${index}: declares ${layer.widthFt}ft wide, ` +
            `game draws ${drawnWidthFt.toFixed(2)}ft (art ${native.w}x${native.h})`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('declares floor-decal footprints that survive the contain-fit unchanged', () => {
    const wrong: string[] = [];
    for (const { piece, prop, layer, index } of measured) {
      if (prop.kind !== 'floor') continue;
      if (layer.widthFt === undefined || layer.heightFt === undefined) continue;
      const spriteId = layer.sprite?.spriteId;
      if (!spriteId) continue;
      const native = nativeSize(spriteId);
      if (!native) continue;

      const fit = Math.min(layer.widthFt / native.w, layer.heightFt / native.h);
      const drawn = { w: fit * native.w, h: fit * native.h };
      if (Math.abs(drawn.w - layer.widthFt) > 0.05 || Math.abs(drawn.h - layer.heightFt) > 0.05) {
        wrong.push(
          `${piece}/${prop.id} L${index}: declares ${layer.widthFt}x${layer.heightFt}ft, ` +
            `contain-fit draws ${drawn.w.toFixed(2)}x${drawn.h.toFixed(2)}ft`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});
