/**
 * Fetch free equipment icons for the placeholder gear catalog.
 *
 * Pulls one CC BY 3.0 icon per placeholder gear item from game-icons.net
 * (white-on-transparent, 512×512), downscales it to a 128×128 white silhouette
 * (alpha box-filter — RGB is forced to white so anti-aliased edges never pick
 * up dark fringes), writes `public/assets/generated/<id>-placeholder.png`, and
 * upserts a `placeholder` manifest entry per item. This replaces the ugly
 * 2-letter text fallback (e.g. duplicate "IR"/"LE"/"ST") that showed whenever a
 * gear item had no generated sprite.
 *
 * Assets are CC BY 3.0 by game-icons.net (authors: lorc, delapouite). Provenance
 * + attribution live in `public/assets/generated/GEAR_ICON_ATTRIBUTION.md`.
 *
 * Runs offline-adjacent (one HTTPS GET per icon). No AI API required.
 *
 * Usage:
 *   npm run sprites:fetch-gear-icons
 *   npm run sprites:fetch-gear-icons -- --dry-run   # fetch + report, no writes
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

/** White foreground, transparent background, square aspect. */
const ICON_BASE = 'https://game-icons.net/icons/ffffff/transparent/1x1';
/** Output edge length. 128px keeps UI icons crisp at the 64px slot on hi-dpi. */
const OUT_SIZE = 128;

interface GearIcon {
  /** Item id / manifest briefId. */
  readonly id: string;
  /** game-icons.net author slug (for the URL + attribution). */
  readonly author: string;
  /** game-icons.net icon slug. */
  readonly name: string;
}

/**
 * gear item id → game-icons.net icon. Every entry was verified to resolve
 * (HTTP 200) against the PNG CDN. Icons are chosen to read clearly for the
 * slot even at a glance.
 */
const GEAR_ICONS: readonly GearIcon[] = [
  { id: 'iron-helm', author: 'lorc', name: 'crested-helmet' },
  { id: 'iron-visor', author: 'lorc', name: 'visored-helm' },
  { id: 'steel-pauldrons', author: 'lorc', name: 'spiked-armor' },
  { id: 'iron-breastplate', author: 'lorc', name: 'breastplate' },
  { id: 'travelers-cloak', author: 'delapouite', name: 'cape' },
  { id: 'sturdy-belt', author: 'delapouite', name: 'black-belt' },
  { id: 'iron-greaves', author: 'delapouite', name: 'leg-armor' },
  { id: 'leather-boots', author: 'lorc', name: 'leather-boot' },
  { id: 'leather-gloves', author: 'delapouite', name: 'gloves' },
  { id: 'bronze-vambrace', author: 'delapouite', name: 'bracer' },
  { id: 'iron-armguard', author: 'lorc', name: 'mailed-fist' },
  { id: 'leather-bracer', author: 'delapouite', name: 'arm-bandage' },
  { id: 'beaded-bracelet', author: 'delapouite', name: 'prayer-beads' },
  { id: 'band-of-fortune', author: 'delapouite', name: 'ring' },
  { id: 'signet-of-focus', author: 'delapouite', name: 'diamond-ring' },
  // Merchant's Magic Charm (neck) — quest reward accessory. Shipped as a tiny
  // 16px pixel-art gem that integer-snapped to a smaller rendered size than the
  // 128px gear silhouettes; a matching high-res pendant keeps the paper-doll
  // icon set coherent (same style + rendered size across all slots).
  { id: 'merchants-stained-charm', author: 'lorc', name: 'gem-pendant' },
];

interface ManifestEntry {
  briefId: string;
  spriteName: string;
  assetPath: string;
  approvedAt: string;
  sourceRun: string;
  variantIndex: number;
  anchor: null;
  sensorScore: string;
  judgeScore: null;
  type: 'item';
}

interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

/** GET a URL to a Buffer, following up to 5 redirects. */
function fetchBuffer(url: string, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects for ${url}`));
            return;
          }
          res.resume();
          const next = new URL(location, url).toString();
          resolve(fetchBuffer(next, redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Downscale a white-on-transparent source PNG to `size`×`size`. Only the alpha
 * channel is averaged (box filter); RGB is pinned to white so edges stay clean.
 */
export function downscaleWhite(src: PNG, size: number): PNG {
  const out = new PNG({ width: size, height: size });
  const sw = src.width;
  const sh = src.height;
  for (let oy = 0; oy < size; oy++) {
    const y0 = Math.floor((oy * sh) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * sh) / size));
    for (let ox = 0; ox < size; ox++) {
      const x0 = Math.floor((ox * sw) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * sw) / size));
      let alphaSum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          alphaSum += src.data[(sw * sy + sx) * 4 + 3] ?? 0;
          count++;
        }
      }
      const alpha = count > 0 ? Math.round(alphaSum / count) : 0;
      const idx = (size * oy + ox) * 4;
      out.data[idx] = 255;
      out.data[idx + 1] = 255;
      out.data[idx + 2] = 255;
      out.data[idx + 3] = alpha;
    }
  }
  return out;
}

function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, entries: {} };
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

export interface RunOptions {
  dryRun: boolean;
  generatedDir: string;
  manifestPath: string;
}

export async function run(options: RunOptions): Promise<{ written: number }> {
  const { dryRun, generatedDir, manifestPath } = options;
  const manifest = loadManifest(manifestPath);
  let written = 0;

  for (const icon of GEAR_ICONS) {
    const url = `${ICON_BASE}/${icon.author}/${icon.name}.png`;
    const raw = await fetchBuffer(url);
    const srcPng = PNG.sync.read(raw);
    const scaled = downscaleWhite(srcPng, OUT_SIZE);
    const pngFilename = `${icon.id}-placeholder.png`;
    const pngPath = path.join(generatedDir, pngFilename);

    if (!dryRun) {
      fs.mkdirSync(generatedDir, { recursive: true });
      fs.writeFileSync(pngPath, PNG.sync.write(scaled));
      manifest.entries[`${icon.id}-placeholder`] = {
        briefId: icon.id,
        spriteName: icon.id,
        assetPath: `generated/${pngFilename}`,
        approvedAt: '2026-07-06T00:00:00.000Z',
        sourceRun: 'placeholder',
        variantIndex: 0,
        anchor: null,
        sensorScore: 'placeholder',
        judgeScore: null,
        type: 'item',
      };
    }
    console.log(`  ${dryRun ? 'fetch' : 'write'} ${icon.id} ← ${icon.author}/${icon.name}`);
    written++;
  }

  if (!dryRun && written > 0) {
    // Sort keys with localeCompare for stable, reviewable diffs — mirrors
    // approve.ts upsertManifest and must match check:sort-assets validator.
    const sortedKeys = Object.keys(manifest.entries).sort((a, b) => a.localeCompare(b));
    const sortedEntries: Record<string, ManifestEntry> = {};
    for (const key of sortedKeys) {
      sortedEntries[key] = manifest.entries[key]!;
    }
    manifest.entries = sortedEntries;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  console.log(
    `\n${dryRun ? '[dry-run] ' : ''}${written} gear icon(s) ${dryRun ? 'fetched' : 'written'}.`,
  );
  return { written };
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifestPath = path.join(generatedDir, 'manifest.json');
  run({
    dryRun: process.argv.slice(2).includes('--dry-run'),
    generatedDir,
    manifestPath,
  }).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
