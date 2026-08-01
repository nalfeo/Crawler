#!/usr/bin/env tsx
/** Temporary helper: assemble the 1x1 strip from already-generated frames */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { packFrameStrip } from '../pack-frame-strip.js';

const FRAMES_DIR = 'generated/experiments/walk-sequential-1x1-2026-08-01T17-33-05/frames';
const OUT = 'generated/experiments/walk-sequential-1x1-2026-08-01T17-33-05/strip.png';

const frameFiles = fs
  .readdirSync(FRAMES_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort();
console.log('Frames:', frameFiles);

const rawBuffers = frameFiles.map((f) => fs.readFileSync(path.join(FRAMES_DIR, f)));
const decoded = rawBuffers.map((b) => PNG.sync.read(b));
console.log('Sizes:', decoded.map((p) => `${p.width}x${p.height}`).join(', '));

const maxH = Math.max(...decoded.map((p) => p.height));
const w = decoded[0]!.width;
const bg = decoded[0]!.data.slice(0, 4);
console.log(`maxH=${maxH} w=${w} bg=[${[...bg]}]`);

const normed: Buffer[] = decoded.map((src) => {
  if (src.height === maxH) return PNG.sync.write(src);
  const padTop = maxH - src.height;
  const dst = new PNG({ width: w, height: maxH });
  for (let y = 0; y < maxH; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      dst.data[off] = bg[0]!;
      dst.data[off + 1] = bg[1]!;
      dst.data[off + 2] = bg[2]!;
      dst.data[off + 3] = bg[3]!;
    }
  }
  for (let y = 0; y < src.height; y++) {
    const srcStart = y * w * 4;
    src.data.copy(dst.data, (padTop + y) * w * 4, srcStart, srcStart + w * 4);
  }
  return PNG.sync.write(dst);
});

const strip = packFrameStrip(normed);
fs.writeFileSync(OUT, strip.buffer);
console.log(
  `Strip written: ${OUT} (${strip.frameWidth}x${strip.frameHeight} x${strip.frameCount})`,
);
