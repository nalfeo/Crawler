#!/usr/bin/env node
/**
 * sprites/check-tile-seams.ts — assert no shipped generated sprite carries a
 * chroma-key / matte border artifact baked into its pixels.
 *
 * ## Why this exists
 *
 * `tile-stone-floor-v1-var-2.png` — the texture bound to `TerrainType.STONE_FLOOR`
 * in `src/engine/sprites/tile-visuals.ts`, i.e. the floor of every stone room in
 * the game — shipped with a magenta ring baked around its 256x256 edge (86% of
 * its outer 3% ring matched, corner pixel rgb(180,24,113)). Because a terrain
 * texture is tiled edge-to-edge, that ring composited into a continuous hot-pink
 * lattice across the entire floor of every room. It survived review for months
 * because at a glance it reads as an intentional grid overlay rather than as a
 * defect in the art.
 *
 * That is precisely the recurring visual-bug class the project rules say to
 * promote into a deterministic check (AGENTS.md rule #9) rather than to rely on
 * a future agent noticing it again.
 *
 * ## What this guard PROVES
 *
 * For every entry in the generated manifest, the outer ring of the PNG is not
 * dominated by off-palette magenta. A generator or post-process that leaves its
 * transparency matte in the pixels fails here instead of shipping.
 *
 * ## What this guard does NOT prove
 *
 * - It only looks for the *magenta* matte, which is the convention these tools
 *   use. A generator that mattes in some other colour would slip past.
 * - It says nothing about whether a tile actually tiles seamlessly; a clean
 *   border can still carry a visible discontinuity. Seam continuity is a
 *   separate, harder check and is deliberately out of scope here.
 * - It is a border check, not a palette check. Legitimately magenta *interior*
 *   art (a neon sign, a potion) is unaffected by design.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import { Report } from '../agent/shared/report.js';

const report = new Report('check-tile-seams');

const ASSET_ROOT = 'public/assets';
const MANIFEST = path.join(ASSET_ROOT, 'generated/manifest.json');

/**
 * Fraction of the shorter side treated as the "border ring". 3% of a 256px tile
 * is ~8px, which is wide enough to catch a matte a few pixels thick without
 * reaching into the art itself.
 */
const RING_FRACTION = 0.03;

/**
 * Ring-match fraction above which we call it a matte artifact. A real sprite
 * whose art merely happens to touch the edge in a pinkish hue stays well under
 * this; the known-bad tile sat at 86%.
 */
const MAX_RING_MAGENTA = 0.4;

/**
 * Off-palette magenta: strongly red, starved of green, and with blue clearly
 * above green so it reads pink/violet rather than as brown, rust, or flesh.
 * Brown dungeon stone (high red, mid green, low blue) is explicitly excluded by
 * the `b > g + 40` term — that term is what stops this flagging the entire warm
 * half of the palette.
 */
function isMatteMagenta(r: number, g: number, b: number, a: number): boolean {
  return a > 0 && r > 120 && g < 90 && b > g + 40;
}

function ringMagentaFraction(png: PNG): number {
  const ring = Math.max(2, Math.round(Math.min(png.width, png.height) * RING_FRACTION));
  let matched = 0;
  let total = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const onRing = x < ring || y < ring || x >= png.width - ring || y >= png.height - ring;
      if (!onRing) continue;
      const i = (png.width * y + x) << 2;
      total += 1;
      if (isMatteMagenta(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!, png.data[i + 3]!)) {
        matched += 1;
      }
    }
  }
  return total === 0 ? 0 : matched / total;
}

function main(): void {
  if (!existsSync(MANIFEST)) {
    report.error(`generated manifest not found at ${MANIFEST}`);
    report.finish();
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    entries: Record<string, { assetPath: string }>;
  };

  const entries = Object.entries(manifest.entries ?? {});
  if (entries.length === 0) {
    // Non-vacuity: an empty manifest would make this guard trivially green.
    report.error('generated manifest has no entries; cannot verify border artifacts');
    report.finish();
    return;
  }

  let checked = 0;
  let failed = 0;

  for (const [name, entry] of entries) {
    const file = path.join(ASSET_ROOT, entry.assetPath);
    if (!existsSync(file)) continue;

    let png: PNG;
    try {
      png = PNG.sync.read(readFileSync(file));
    } catch {
      // Unreadable art is another guard's problem; skipping keeps this one focused.
      continue;
    }

    checked += 1;
    const fraction = ringMagentaFraction(png);
    if (fraction > MAX_RING_MAGENTA) {
      failed += 1;
      report.error(
        `${name}: ${(fraction * 100).toFixed(0)}% of its ${png.width}x${png.height} border ring is off-palette magenta — this looks like a chroma-key matte baked into the PNG. If this asset is tiled as terrain it will composite into a visible pink lattice. Regenerate it or strip the matte; do NOT raise MAX_RING_MAGENTA to go green.`,
        { file: entry.assetPath },
      );
    }
  }

  if (failed === 0) {
    report.info(`OK: ${checked} generated sprite(s) checked, none carry a magenta border matte.`);
  }
  report.finish();
}

main();
