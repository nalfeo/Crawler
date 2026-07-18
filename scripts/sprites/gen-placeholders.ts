/**
 * Placeholder pixel-art generator.
 *
 * Generates simple 16×16 PNG placeholder sprites for EVERY item in the
 * catalog that does not yet have an approved generated sprite in the
 * manifest. Items with a hand-authored design (see `PLACEHOLDERS`) use that
 * art; every other catalog item gets a deterministic procedural icon so the
 * inventory never falls back to a text-square placeholder. Runs entirely
 * offline — no AI API required.
 *
 * Usage:
 *   npm run sprites:gen-placeholders
 *   npm run sprites:gen-placeholders -- --dry-run   # preview without writing
 *   npm run sprites:gen-placeholders -- --force     # overwrite existing entries
 *
 * Output:
 *   public/assets/generated/<id>-placeholder.png   (16×16 RGBA PNG)
 *   public/assets/generated/manifest.json          (updated in-place)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { FLOOR2_EQUIPMENT_ART_ENTRIES } from '../../src/shared/floor2-equipment-art-keys.js';
import { ITEM_CATALOG } from '../../src/shared/items.js';
import { SeededRandom } from '../../src/shared/random.js';

// ---------------------------------------------------------------------------
// Pixel art definitions — 16×16 character maps
// ---------------------------------------------------------------------------

/** Color palette: character → [r, g, b, a] */
const PAL: Record<string, [number, number, number, number]> = {
  '.': [0, 0, 0, 0], // transparent
  b: [30, 30, 40, 255], // dark outline
  w: [240, 240, 240, 255], // highlight white
  k: [80, 80, 90, 255], // mid-shadow
  // iron-ore
  m: [140, 130, 120, 255], // ore mid grey-brown
  M: [185, 170, 155, 255], // ore light face
  O: [170, 80, 30, 255], // rust orange
  // rusted-scrap
  o: [130, 55, 18, 255], // dark rust
  // bone
  n: [230, 220, 195, 255], // bone white
  N: [185, 170, 145, 255], // bone shadow
  // sock
  f: [155, 140, 118, 255], // dirty beige-grey
  F: [195, 180, 158, 255], // sock lighter
  // rat tail
  p: [190, 130, 145, 255], // dusty pink
  // charm
  P: [115, 55, 175, 255], // purple
  Q: [160, 100, 215, 255], // purple highlight
  // key
  B: [175, 105, 38, 255], // bronze
  C: [215, 155, 70, 255], // bronze highlight
  // vial
  r: [195, 50, 50, 255], // red glass
  R: [235, 85, 75, 255], // red liquid bright
  // lucky charm
  y: [215, 175, 35, 255], // gold
  Y: [245, 215, 65, 255], // gold highlight
  // pebble
  t: [125, 115, 105, 255], // stone grey
  T: [175, 160, 145, 255], // stone highlight
};

/** All items that need placeholders, keyed by item id. */
const PLACEHOLDERS: Record<string, string[]> = {
  'iron-ore': [
    '................',
    '................',
    '......bbbbb.....',
    '.....bmmmmmb....',
    '....bmMOmmmb....',
    '....bmmMmmmb....',
    '....bmmmOmmb....',
    '....bmmmmmmb....',
    '.....bmmmmb.....',
    '......bbbbb.....',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  'rusted-scrap': [
    '................',
    '................',
    '....bbbbb.......',
    '....bOOObb......',
    '....bOoOOb......',
    '....bOOObb......',
    '....bbbbb.......',
    '.....bbbbbbb....',
    '.....bOOOOOb....',
    '.....bOoOOOb....',
    '.....bOOOOOb....',
    '.....bbbbbbb....',
    '................',
    '................',
    '................',
    '................',
  ],
  'old-sock': [
    '................',
    '....bbbbbbb.....',
    '....bFFFFFb.....',
    '.....bfffb......',
    '.....bfffb......',
    '.....bfffb......',
    '.....bfffb......',
    '.....bfffb......',
    '.....bfffffb....',
    '....bfffffffb...',
    '....bfffffffb...',
    '....bfffffffb...',
    '.....bbbbbbb....',
    '................',
    '................',
    '................',
  ],
  'bone-shard': [
    '................',
    '.........b......',
    '........bnn.....',
    '.......bnnnb....',
    '......bNnnnb....',
    '.....bNnnnnb....',
    '....bNnnnnnb....',
    '...bnnnnnnnnb...',
    '...bnnNnnnnnb...',
    '...bnnnnnnnnb...',
    '....bbbbbbbb....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  pebble: [
    '................',
    '................',
    '................',
    '................',
    '.......bbb......',
    '......btTtb.....',
    '.....btTtttb....',
    '.....bttttb.....',
    '......bttb......',
    '.......bb.......',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  'glistening-rat-tail': [
    '................',
    '................',
    '...bbb..........',
    '..bpppb.........',
    '...bppppb.......',
    '....bpwppb......',
    '.....bppppb.....',
    '.....bpppppb....',
    '......bpppwb....',
    '.......bpppb....',
    '........bppb....',
    '.........bb.....',
    '................',
    '................',
    '................',
    '................',
  ],
  'merchants-stained-charm': [
    '................',
    '........b.......',
    '.......bPb......',
    '......bQPPb.....',
    '.....bPPwPPb....',
    '....bPPPPPPPb...',
    '.....bPwPPPb....',
    '......bPPPb.....',
    '.......bPb......',
    '........b.......',
    '........bb......',
    '........bb......',
    '................',
    '................',
    '................',
    '................',
  ],
  'floor-key-bronze': [
    '................',
    '....bbbbbb......',
    '...bBBBBBBb.....',
    '...bBCCBBBb.....',
    '...bBCCBBBb.....',
    '...bBBBBBBb.....',
    '....bbbbbb......',
    '......bb........',
    '......bb........',
    '......bBb.......',
    '.....bbbbb......',
    '......bBb.......',
    '......bb........',
    '................',
    '................',
    '................',
  ],
  'health-vial': [
    '................',
    '.......bb.......',
    '......bwwb......',
    '.....bwwwwb.....',
    '.....bRRRRb.....',
    '.....bRRRRb.....',
    '.....bRwRRb.....',
    '.....bRRRRb.....',
    '.....bRRRRb.....',
    '.....bRRRRb.....',
    '.....bRrRRb.....',
    '......bbbb......',
    '................',
    '................',
    '................',
    '................',
  ],
  'lucky-charm': [
    '................',
    '................',
    '....yy...yy.....',
    '...yyyyyyyyyyy..',
    '...yYyyyyyyyyy..',
    '...yyyyyyyyyyy..',
    '....yyyyyyyy....',
    '.....yYyyyyy....',
    '....yyyyy.......',
    '...yyyyy........',
    '..yyyyy.........',
    '...yyy..........',
    '................',
    '................',
    '................',
    '................',
  ],
  'floor-key-silver': [
    '................',
    '....bbbbbb......',
    '...bMMMMMMb.....',
    '...bMwwMMMb.....',
    '...bMwwMMMb.....',
    '...bMMMMMMb.....',
    '....bbbbbb......',
    '......bb........',
    '......bb........',
    '......bMb.......',
    '.....bbbbb......',
    '......bMb.......',
    '......bb........',
    '................',
    '................',
    '................',
  ],
  'floor-key-gold': [
    '................',
    '....bbbbbb......',
    '...bYYYYYYb.....',
    '...bYyyYYYb.....',
    '...bYyyYYYb.....',
    '...bYYYYYYb.....',
    '....bbbbbb......',
    '......bb........',
    '......bb........',
    '......bYb.......',
    '.....bbbbb......',
    '......bYb.......',
    '......bb........',
    '................',
    '................',
    '................',
  ],
  'floor-key-void': [
    '................',
    '....bbbbbb......',
    '...bPPPPPPb.....',
    '...bPQQPPPb.....',
    '...bPQQPPPb.....',
    '...bPPPPPPb.....',
    '....bbbbbb......',
    '......bb........',
    '......bb........',
    '......bPb.......',
    '.....bbbbb......',
    '......bPb.......',
    '......bb........',
    '................',
    '................',
    '................',
  ],
};

// ---------------------------------------------------------------------------
// PNG writer (exported for testing)
// ---------------------------------------------------------------------------

export function renderSprite(rows: string[]): Buffer {
  const W = 16;
  const H = 16;
  const png = new PNG({ width: W, height: H });
  // Clear to transparent
  for (let i = 0; i < W * H * 4; i++) png.data[i] = 0;

  for (let y = 0; y < H; y++) {
    const line = rows[y] ?? '';
    for (let x = 0; x < W; x++) {
      const ch = line[x] ?? '.';
      const color = PAL[ch] ?? PAL['.']!;
      const idx = (W * y + x) * 4;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }

  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// Procedural sprite generator (deterministic per item id)
// ---------------------------------------------------------------------------

/** FNV-1a hash of a string → 32-bit signed seed for SeededRandom. */
function hashStringToSeed(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0 || 0x9e3779b9;
}

/** Convert HSL (h in [0,360), s/l in [0,1]) to an [r,g,b] byte triple. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r: number;
  let g: number;
  let b: number;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Render a deterministic procedural 16×16 icon for an item id. Produces a
 * horizontally-symmetric coloured blob with a dark outline and a small
 * highlight — distinct per item, and visually clearly an icon rather than a
 * text square. Pure: identical bytes for the same id on every run.
 */
export function renderProceduralSprite(id: string): Buffer {
  const W = 16;
  const H = 16;
  const rng = new SeededRandom(hashStringToSeed(id));

  const hue = rng.next() * 360;
  const body = hslToRgb(hue, 0.55, 0.55);
  const outline = hslToRgb(hue, 0.6, 0.22);
  const highlight = hslToRgb(hue, 0.45, 0.82);

  // Superellipse exponent selects the silhouette: 1 = diamond, 2 = ellipse,
  // 3.5 = rounded square.
  const exps = [1, 2, 3.5];
  const exp = exps[rng.nextInt(0, exps.length - 1)]!;
  const rx = 4.3 + rng.next() * 1.6;
  const ry = 4.3 + rng.next() * 2.0;
  const cx = 7.5;
  const cy = 8;

  const filled: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x <= 7; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const v = Math.pow(Math.abs(dx) / rx, exp) + Math.pow(Math.abs(dy) / ry, exp);
      let on = v <= 1;
      // Ragged edge: thin out the outermost ring so silhouettes vary.
      if (on && v > 0.78) {
        on = rng.next() < 0.72;
      }
      if (on) {
        filled[y]![x] = true;
        filled[y]![W - 1 - x] = true;
      }
    }
  }

  const isFilled = (x: number, y: number): boolean =>
    x >= 0 && x < W && y >= 0 && y < H && filled[y]![x] === true;

  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H * 4; i++) png.data[i] = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!filled[y]![x]) continue;
      const edge =
        !isFilled(x - 1, y) || !isFilled(x + 1, y) || !isFilled(x, y - 1) || !isFilled(x, y + 1);
      let color = edge ? outline : body;
      if (!edge && x >= 4 && x <= 6 && y >= 4 && y <= 6 && rng.next() < 0.6) {
        color = highlight;
      }
      const idx = (W * y + x) * 4;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

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
}

interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, entries: {} };
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface RunOptions {
  dryRun: boolean;
  force: boolean;
  generatedDir: string;
  manifestPath: string;
}

export function run(options: RunOptions): { added: number; skipped: number } {
  const { dryRun, force, generatedDir, manifestPath: mPath } = options;
  const manifest = loadManifest(mPath);
  let added = 0;
  let skipped = 0;

  for (const item of ITEM_CATALOG) {
    const id = item.id;
    const outerKey = `${id}-placeholder`;
    const handAuthored = PLACEHOLDERS[id];

    // Always skip if a real (non-placeholder) entry already exists for this briefId.
    // --force must not overwrite real approvals — it only refreshes existing placeholders.
    const existingEntry = Object.values(manifest.entries).find((e) => e.briefId === id);
    if (existingEntry && existingEntry.sourceRun !== 'placeholder') {
      console.log(`  skip  ${id} — real sprite already approved`);
      skipped++;
      continue;
    }

    // Also skip if this exact placeholder key already exists and --force not passed
    if (manifest.entries[outerKey] && !force) {
      console.log(`  skip  ${id} — placeholder already exists`);
      skipped++;
      continue;
    }

    const pngFilename = `${id}-placeholder.png`;
    const pngPath = path.join(generatedDir, pngFilename);
    const buffer = handAuthored ? renderSprite(handAuthored) : renderProceduralSprite(id);

    if (!dryRun) {
      fs.mkdirSync(generatedDir, { recursive: true });
      fs.writeFileSync(pngPath, buffer);
    }

    const entry: ManifestEntry = {
      briefId: id,
      spriteName: id,
      assetPath: `generated/${pngFilename}`,
      approvedAt: new Date().toISOString(),
      sourceRun: 'placeholder',
      variantIndex: 0,
      anchor: null,
      sensorScore: 'placeholder',
      judgeScore: null,
    };

    if (!dryRun) {
      manifest.entries[outerKey] = entry;
    }

    const kind = handAuthored ? 'art' : 'proc';
    console.log(`  ${dryRun ? 'dry ' : ''}write ${id} (${kind}) → ${pngFilename}`);
    added++;
  }

  // ---------------------------------------------------------------------------
  // Floor 2 equipment art keys
  // Generates procedural placeholder PNGs for every Floor 2 equipment art key
  // (weapon.iron-cleaver, head.iron-visor, etc.) that does not yet have a real
  // approved sprite. The manifest key is `<artKey>-placeholder`; the PNG is
  // `<artKey>-placeholder.png`. Art keys use dot notation which is valid in
  // both manifest keys and filenames.
  // ---------------------------------------------------------------------------
  for (const entry of FLOOR2_EQUIPMENT_ART_ENTRIES) {
    const artKey = entry.artKey;
    const outerKey = `${artKey}-placeholder`;

    // Skip if a real (non-placeholder) entry already exists for this briefId.
    const existingReal = Object.values(manifest.entries).find(
      (e) => e.briefId === artKey && e.sourceRun !== 'placeholder',
    );
    if (existingReal) {
      console.log(`  skip  ${artKey} — real sprite already approved`);
      skipped++;
      continue;
    }

    // Skip if this exact placeholder key already exists and --force not passed.
    if (manifest.entries[outerKey] && !force) {
      console.log(`  skip  ${artKey} — placeholder already exists`);
      skipped++;
      continue;
    }

    const pngFilename = `${artKey}-placeholder.png`;
    const pngPath = path.join(generatedDir, pngFilename);
    const buffer = renderProceduralSprite(artKey);

    if (!dryRun) {
      fs.mkdirSync(generatedDir, { recursive: true });
      fs.writeFileSync(pngPath, buffer);
    }

    const f2Entry: ManifestEntry = {
      briefId: artKey,
      spriteName: artKey,
      assetPath: `generated/${pngFilename}`,
      approvedAt: new Date().toISOString(),
      sourceRun: 'placeholder',
      variantIndex: 0,
      anchor: null,
      sensorScore: 'placeholder',
      judgeScore: null,
    };

    if (!dryRun) {
      manifest.entries[outerKey] = f2Entry;
    }

    console.log(`  ${dryRun ? 'dry ' : ''}write ${artKey} (proc) → ${pngFilename}`);
    added++;
  }

  if (!dryRun && added > 0) {
    // Sort keys for stable, reviewable diffs — mirrors approve.ts upsertManifest behaviour.
    const sortedKeys = Object.keys(manifest.entries).sort();
    const sortedEntries: Record<string, ManifestEntry> = {};
    for (const key of sortedKeys) {
      sortedEntries[key] = manifest.entries[key]!;
    }
    manifest.entries = sortedEntries;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nWrote ${added} placeholder(s) to manifest. Skipped ${skipped}.`);
  } else {
    console.log(
      `\n${dryRun ? '[dry-run] ' : ''}${added} placeholder(s) would be written. Skipped ${skipped}.`,
    );
  }

  return { added, skipped };
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
  const manifestPath = path.join(generatedDir, 'manifest.json');
  run({
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    generatedDir,
    manifestPath,
  });
}
