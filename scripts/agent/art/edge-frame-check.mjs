#!/usr/bin/env node
/**
 * edge-frame-check.mjs — measure whether a tile PNG carries a baked-in border
 * frame (dark keyline, pale rim, vignette, matte residue) around its canvas.
 *
 * A framed plate laid edge-to-edge on a grid composites into a continuous
 * lattice across the whole floor — the `tile-stone-floor-v1-var-2` magenta-ring
 * failure class. `check-tile-seams.ts` only catches *magenta* mattes and
 * explicitly puts border continuity out of scope; this closes that gap for the
 * welcome-room floor-plate family, colour-agnostically, on luma.
 *
 * Criterion (from the rejection of the v1 wave):
 *   interiorLuma = mean luma of rows/cols 24 .. (N-25)
 *   for each of the outer 6 rows and 6 cols on all four sides:
 *     abs(edgeLuma - interiorLuma) / interiorLuma  MUST be < 0.10
 *
 * Usage: node scripts/agent/art/edge-frame-check.mjs <png> [...]
 * Exit code 1 if any file fails.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const THRESHOLD = 0.1;
const EDGE_DEPTH = 6;
const INTERIOR_INSET = 24;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function analyze(file) {
  const png = PNG.sync.read(readFileSync(file));
  const { width: w, height: h, data } = png;
  const at = (x, y) => {
    const i = (w * y + x) << 2;
    return luma(data[i], data[i + 1], data[i + 2]);
  };

  let sum = 0;
  let n = 0;
  for (let y = INTERIOR_INSET; y < h - INTERIOR_INSET; y += 1) {
    for (let x = INTERIOR_INSET; x < w - INTERIOR_INSET; x += 1) {
      sum += at(x, y);
      n += 1;
    }
  }
  const interior = sum / n;

  const lines = [];
  const rowLuma = (y) => {
    let s = 0;
    for (let x = 0; x < w; x += 1) s += at(x, y);
    return s / w;
  };
  const colLuma = (x) => {
    let s = 0;
    for (let y = 0; y < h; y += 1) s += at(x, y);
    return s / h;
  };
  for (let k = 0; k < EDGE_DEPTH; k += 1) {
    lines.push([`row top ${k}`, rowLuma(k)]);
    lines.push([`row bottom ${k}`, rowLuma(h - 1 - k)]);
    lines.push([`col left ${k}`, colLuma(k)]);
    lines.push([`col right ${k}`, colLuma(w - 1 - k)]);
  }

  let worst = 0;
  let worstWhere = '';
  for (const [where, val] of lines) {
    const delta = Math.abs(val - interior) / interior;
    if (delta > worst) {
      worst = delta;
      worstWhere = `${where} (luma ${val.toFixed(1)})`;
    }
  }
  return { file, w, h, interior, worst, worstWhere, pass: worst < THRESHOLD };
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  try {
    const r = analyze(file);
    if (!r.pass) failed += 1;
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${(r.worst * 100).toFixed(1)}%  ${r.w}x${r.h}  interior=${r.interior.toFixed(1)}  worst=${r.worstWhere}  ${r.file}`,
    );
  } catch (err) {
    failed += 1;
    console.log(`ERROR ${file}: ${err.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
