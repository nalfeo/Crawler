/**
 * Derive `opaqueBounds` for every approved sprite and write it into
 * `public/assets/generated/manifest.json`.
 *
 * ## Why this is a separate field and not `anchor`
 *
 * `anchor` is derived per-brief by whichever sensor mode that brief configured,
 * so its meaning is not uniform across sprites. Measured across the welcome
 * room's 34 base layers: 16 anchors sit at the opaque bottom, 18 sit at the
 * opaque centre, and one is `0,0`. Any consumer that needs "where does this
 * object actually end" therefore cannot read `anchor` — it would be correct on
 * roughly half the corpus and silently wrong on the rest, with no signal to
 * distinguish the two. `opaqueBounds` has one meaning for every sprite.
 *
 * ## Why derive instead of trimming the PNGs
 *
 * Trimming the transparent margin out of the shipped files would break the
 * manifest `contentHash` (a live integrity check — `reconcile-queue.ts` closes
 * an asset only when path AND hash match, and `load-reference-pngs.ts` fails
 * loudly on drift), make `sourceRun` describe bytes that no longer exist, and
 * be reverted by the next regeneration. Deriving bounds leaves the art
 * untouched and is reproducible from it.
 *
 * Idempotent: re-running on an unchanged tree rewrites nothing.
 *
 * Usage: `npm run sprites:derive-opaque-bounds [-- --check]`
 *   --check  exit non-zero if any entry is missing or stale (CI-safe)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const MANIFEST = path.join('public', 'assets', 'generated', 'manifest.json');
const ASSET_ROOT = path.join('public', 'assets');
/** Alpha at or below this is treated as transparent, matching the sprite sensors. */
const ALPHA_THRESHOLD = 8;

export interface DerivedBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/**
 * Bounding box of pixels with alpha > {@link ALPHA_THRESHOLD}.
 * Returns the full canvas for fully transparent art so downstream consumers
 * never divide by zero — a blank sprite is a content bug for the sensors to
 * catch, not something this should encode as a degenerate box.
 */
export function deriveOpaqueBounds(png: {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}): DerivedBounds {
  let x0 = png.width;
  let y0 = png.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if ((png.data[(png.width * y + x) * 4 + 3] ?? 0) <= ALPHA_THRESHOLD) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0 || y1 < 0) {
    return {
      x: 0,
      y: 0,
      width: png.width,
      height: png.height,
      canvasWidth: png.width,
      canvasHeight: png.height,
    };
  }
  return {
    x: x0,
    y: y0,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    canvasWidth: png.width,
    canvasHeight: png.height,
  };
}

function same(a: DerivedBounds | undefined, b: DerivedBounds): boolean {
  return (
    a !== undefined &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight
  );
}

function main(): void {
  const check = process.argv.includes('--check');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as {
    version: number;
    entries: Record<string, Record<string, unknown>>;
  };

  let updated = 0;
  let missingArt = 0;
  const stale: string[] = [];

  for (const [key, entry] of Object.entries(manifest.entries)) {
    const assetPath = entry.assetPath;
    if (typeof assetPath !== 'string') continue;
    const file = path.join(ASSET_ROOT, assetPath);
    if (!fs.existsSync(file)) {
      missingArt += 1;
      continue;
    }
    const bounds = deriveOpaqueBounds(PNG.sync.read(fs.readFileSync(file)));
    if (same(entry.opaqueBounds as DerivedBounds | undefined, bounds)) continue;
    stale.push(key);
    entry.opaqueBounds = bounds;
    updated += 1;
  }

  if (check) {
    if (stale.length > 0) {
      console.error(
        `${stale.length} manifest entr${stale.length === 1 ? 'y is' : 'ies are'} missing or ` +
          `have stale opaqueBounds:\n  ${stale.slice(0, 20).join('\n  ')}` +
          (stale.length > 20 ? `\n  ... and ${stale.length - 20} more` : '') +
          `\nRun: npm run sprites:derive-opaque-bounds`,
      );
      process.exit(1);
    }
    console.log(`opaqueBounds up to date for ${Object.keys(manifest.entries).length} entries.`);
    return;
  }

  if (updated > 0) fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `opaqueBounds: ${updated} entr${updated === 1 ? 'y' : 'ies'} written` +
      (missingArt > 0 ? `, ${missingArt} skipped (art not on disk)` : ''),
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main();
}
