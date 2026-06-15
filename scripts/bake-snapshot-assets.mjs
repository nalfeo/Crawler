// Bakes cohesive CC0 Kenney "tiny-dungeon" frames into 64x64 PNGs for the
// visual-snapshot lab. TEMPORARY art bridge (not the sprite pipeline).
//
// Source: public/assets/kenney/tiny-dungeon/spritesheet.png (CC0, 16x16, 1px spacing).
// Frame = row*12 + col. sx = col*17, sy = row*17.
//
// Usage: node scripts/bake-snapshot-assets.mjs
/* global console */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHEET = resolve(ROOT, 'public/assets/kenney/tiny-dungeon/spritesheet.png');
const OUT = resolve(ROOT, 'public/assets/generated');
const SCALE = 4; // 16 -> 64
const TILE = 16;
const STEP = 17; // tile + 1px spacing

mkdirSync(OUT, { recursive: true });
const sheet = PNG.sync.read(readFileSync(SHEET));

function cropFrame(frame) {
  const col = frame % 12;
  const row = Math.floor(frame / 12);
  const sx = col * STEP;
  const sy = row * STEP;
  const out = new PNG({ width: TILE, height: TILE });
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const si = ((sy + y) * sheet.width + (sx + x)) << 2;
      const di = (y * TILE + x) << 2;
      out.data[di] = sheet.data[si];
      out.data[di + 1] = sheet.data[si + 1];
      out.data[di + 2] = sheet.data[si + 2];
      out.data[di + 3] = sheet.data[si + 3];
    }
  }
  return out;
}

// Keep only warm flame pixels, drop grey brick + dark mortar -> transparent.
function flameKey(img) {
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const a = img.data[i + 3];
    const warm = a > 0 && r > 110 && r - b > 40 && r >= g - 10;
    if (!warm) img.data[i + 3] = 0;
  }
  return img;
}

function upscale(img, scale) {
  const w = img.width * scale;
  const h = img.height * scale;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * img.width + sx) << 2;
      const di = (y * w + x) << 2;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

function bake(name, frame, opts = {}) {
  let img = cropFrame(frame);
  if (opts.flame) img = flameKey(img);
  const big = upscale(img, SCALE);
  writeFileSync(resolve(OUT, `${name}.png`), PNG.sync.write(big));
  return big;
}

// Floors: only the two seamless tan tiles (flat + lightly speckled). Frames
// 50-53 carry a dark top band that reads as horizontal grid banding, so we drop
// them. The lab weights toward the flat tile and sprinkles the speckled one.
const FLOORS = [48, 49];
FLOORS.forEach((f, i) => bake(`temp_floor_${i}`, f));

bake('temp_wall', 40); // clean plain grey brick block (no grate/banding)
bake('temp_door_closed', 46); // closed brown wooden door with handle
bake('temp_door_open', 34); // door swung open, wide dark passage (clearly see-through)
bake('temp_hero', 96); // knight
bake('temp_npc', 99); // princess
bake('temp_slime', 108); // teal ooze
bake('temp_rat', 122); // spider (no rat exists in any vendored CC0 pack)
bake('temp_fireball', 29, { flame: true }); // color-keyed flame

// Contact sheet for quick visual verification.
const picks = [
  ['floor_0', 48],
  ['floor_1', 49],
  ['wall', 40],
  ['door_closed', 46],
  ['door_open', 34],
  ['hero', 96],
  ['npc', 99],
  ['slime', 108],
  ['rat/spider', 122],
  ['flame', -1],
];
const COLS = 7;
const ROWS = Math.ceil(picks.length / COLS);
const CELL = 64;
const PAD = 6;
const cw = COLS * (CELL + PAD) + PAD;
const ch = ROWS * (CELL + PAD) + PAD;
const contact = new PNG({ width: cw, height: ch });
for (let i = 0; i < contact.data.length; i += 4) {
  contact.data[i] = 30;
  contact.data[i + 1] = 26;
  contact.data[i + 2] = 38;
  contact.data[i + 3] = 255;
}
picks.forEach(([label, frame], idx) => {
  const cx = (idx % COLS) * (CELL + PAD) + PAD;
  const cy = Math.floor(idx / COLS) * (CELL + PAD) + PAD;
  let img = frame === -1 ? flameKey(cropFrame(29)) : cropFrame(frame);
  const big = upscale(img, SCALE);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const si = (y * CELL + x) << 2;
      if (big.data[si + 3] === 0) continue;
      const di = ((cy + y) * cw + (cx + x)) << 2;
      contact.data[di] = big.data[si];
      contact.data[di + 1] = big.data[si + 1];
      contact.data[di + 2] = big.data[si + 2];
      contact.data[di + 3] = 255;
    }
  }
  void label;
});
writeFileSync(resolve(__dirname, '_bake-preview.png'), PNG.sync.write(contact));

console.log('Baked snapshot assets ->', OUT);
