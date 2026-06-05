/**
 * Palette extractor.
 *
 * Walks every opaque pixel of the source PNG, dedupes RGB tuples, sorts them in
 * a stable order, and writes a JSON array of `[r, g, b]` triples.
 *
 * Deterministic: same input -> byte-identical output.
 *
 * CLI:
 *   npm run sprites:extract-palette -- --source <png> --out <json>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

export type RgbTriple = readonly [number, number, number];

/**
 * Extract a sorted, deduped list of opaque RGB triples from a PNG buffer.
 *
 * - Pixels with alpha < 255 are ignored (they are background or anti-alias
 *   fringes; we want pure palette colors only).
 * - The output order is lexicographic on (r, g, b). This is what makes the
 *   function deterministic across runs and platforms.
 */
export function extractPalette(pngBuffer: Buffer): RgbTriple[] {
  const png = PNG.sync.read(pngBuffer);
  const { data, width, height } = png;
  const seen = new Set<number>();
  const colors: RgbTriple[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3] ?? 0;
      if (a !== 255) continue;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const key = (r << 16) | (g << 8) | b;
      if (seen.has(key)) continue;
      seen.add(key);
      colors.push([r, g, b]);
    }
  }

  colors.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
  });

  return colors;
}

/**
 * Serialize the palette as a stable, human-readable JSON document. One color
 * per line keeps diffs tiny when palettes are added or removed.
 */
export function serializePalette(colors: readonly RgbTriple[]): string {
  const lines = colors.map((c) => `  [${c[0]}, ${c[1]}, ${c[2]}]`);
  return `[\n${lines.join(',\n')}\n]\n`;
}

interface CliArgs {
  source: string;
  out: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      args.source = argv[i + 1];
      i++;
    } else if (arg === '--out') {
      args.out = argv[i + 1];
      i++;
    }
  }
  if (!args.source) throw new Error('Missing required --source <png>');
  if (!args.out) throw new Error('Missing required --out <json>');
  return args as CliArgs;
}

function main(): void {
  const { source, out } = parseArgs(process.argv.slice(2));
  const pngBuffer = readFileSync(source);
  const colors = extractPalette(pngBuffer);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializePalette(colors));
  process.stdout.write(`extracted ${colors.length} colors -> ${out}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main();
}
