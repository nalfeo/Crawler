/**
 * Placeholder pixel-art generator.
 *
 * Generates simple 16×16 PNG placeholder sprites for every item that does
 * not yet have an approved generated sprite in the manifest. Runs entirely
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
import { PNG } from 'pngjs';

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
// PNG writer
// ---------------------------------------------------------------------------

function renderSprite(rows: string[]): Buffer {
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
// Manifest helpers
// ---------------------------------------------------------------------------

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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const generatedDir = path.join(repoRoot, 'public', 'assets', 'generated');
const manifestPath = path.join(generatedDir, 'manifest.json');

const manifest = loadManifest(manifestPath);
let added = 0;
let skipped = 0;

for (const [id, rows] of Object.entries(PLACEHOLDERS)) {
  const outerKey = `${id}-placeholder`;

  // Check if a real (non-placeholder) entry already exists for this briefId
  const existingEntry = Object.values(manifest.entries).find((e) => e.briefId === id);
  if (existingEntry && existingEntry.sourceRun !== 'placeholder' && !force) {
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

  if (!dryRun) {
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(pngPath, renderSprite(rows));
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

  console.log(`  ${dryRun ? 'dry ' : ''}write ${id} → ${pngFilename}`);
  added++;
}

if (!dryRun && added > 0) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWrote ${added} placeholder(s) to manifest. Skipped ${skipped}.`);
} else {
  console.log(
    `\n${dryRun ? '[dry-run] ' : ''}${added} placeholder(s) would be written. Skipped ${skipped}.`,
  );
}
