#!/usr/bin/env node
/* global console, process */
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
 *          [--threshold 0.10] [--edge-depth 6] [--interior-inset 24]
 *          [--structure-floor 5]
 * Exit code 1 if any file fails.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

let THRESHOLD = 0.1;
let EDGE_DEPTH = 6;
let INTERIOR_INSET = 24;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const BLOCK = 8;
let STRUCTURE_FLOOR = Number(process.env.STRUCTURE_FLOOR ?? 5);

/**
 * Parse `--flag value` pairs out of argv, leaving the positional PNG paths.
 *
 * Multi-file positional invocation is the original contract (the whole point is
 * sweeping a corpus); the flags came from an independent single-file
 * reimplementation that landed on main in #2226. Supporting both keeps that
 * caller working without giving up corpus sweeps — and, critically, without
 * giving up the structure criterion, which #2226 did not carry.
 */
function parseArgs(argv) {
  const files = [];
  const numeric = {
    '--threshold': (v) => {
      THRESHOLD = v;
    },
    '--edge-depth': (v) => {
      EDGE_DEPTH = v;
    },
    '--interior-inset': (v) => {
      INTERIOR_INSET = v;
    },
    '--structure-floor': (v) => {
      STRUCTURE_FLOOR = v;
    },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      files.push(token);
      continue;
    }
    const apply = numeric[token];
    if (!apply) throw new Error(`Unknown option: ${token}`);
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`Missing value for ${token}`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${token} must be a finite number >= 0 (got ${raw}).`);
    }
    apply(value);
    i += 1;
  }
  if (files.length === 0) throw new Error('Missing required <png-path>.');
  return files;
}

/**
 * Structure score: luma SD after BLOCKxBLOCK box-averaging.
 *
 * Plain luma SD cannot tell a blank field from real art, because an IID noise
 * speckle scores as "varied" per-pixel. Box-averaging annihilates noise (SD of a
 * mean falls as 1/sqrt(n)) while genuine shapes — planks, cables, scuffs, a rug
 * border — survive. So this measures whether the texture carries *shapes* rather
 * than merely non-constant pixels.
 *
 * This exists because three commissioned welcome-room floor plates passed the
 * edge-frame criterion above and were placed in the room, yet rendered as flat
 * grey slabs against the detailed stone floor. The frame check verified the
 * ABSENCE of the v1 defect without verifying the PRESENCE of any content — a
 * blank texture trivially has no border frame.
 *
 * SCOPE — full-bleed tiles ONLY. The score counts transparent pixels as black,
 * so on a cut-out prop it measures the SILHOUETTE against the void, not internal
 * detail, and inflates wildly: `welcome-room-floor-runner-var-10` (70% opaque)
 * scores 43.6 including transparency but only **11.3** on opaque pixels alone;
 * `stanchion-pair-var-4` (25% opaque) scores 13.3 vs **9.9**. The full-bleed
 * guard in analyze() already SKIPs these, so the GATE is correct — but never
 * quote a structure number for a cut-out prop, and never compare one against a
 * full-bleed tile. That cross-class comparison is how "the runner scores 38.7,
 * so it is not flat" got asserted about a sprite that is, in fact, flat.
 *
 * Threshold derived from the whole 470-PNG shipped corpus, not fit to the
 * offending samples. What the corpus measurement establishes is PRECISION: of
 * the 86 files scoring below a floor of 5, exactly 85 are `*-placeholder.png` /
 * `temp_*` scaffolding and exactly ONE is real shipped art —
 * `welcome-room-floor-plate-clean-v2-var-0` (2.5). Zero false positives on
 * legitimate art.
 *
 * It establishes NOTHING about recall, and this check is NOT a placeholder
 * detector: 47 of the 132 placeholder/temp files score ABOVE the floor, up to
 * `temp_slime.png` at 66.2. A placeholder can carry plenty of structure. Do not
 * cite this measurement as evidence that the gate finds unfinished art; it only
 * shows that what it flags is almost never legitimate.
 *
 * (An earlier draft of this docstring claimed the metric "rediscovered every
 * placeholder independently". That was false — generalised from an
 * ascending-sorted top-18 window, where naturally only placeholders appear. The
 * qualifier above is the load-bearing part; a tidier phrasing is the dangerous
 * one.)
 *
 * The finding that motivated it: the v2 plates scored 2.5 / 6.0 / 9.5 while the
 * v1 plates they replaced — rejected for a baked frame — scored 17.5 / 22.7 /
 * 21.0. The regeneration fixed the frame by deleting the content. NEITHER check
 * alone catches that inversion; the frame check passes v2 and this check passes
 * v1, so tile art must clear BOTH.
 *
 * This is a floor for "blank", not a substitute for looking at the room. Art can
 * clear it and still read badly at game scale (low-saturation hue against the
 * base floor is invisible to both checks).
 */
function structureScore(w, h, at) {
  const means = [];
  for (let by = 0; by + BLOCK <= h; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
      let s = 0;
      for (let y = 0; y < BLOCK; y += 1) for (let x = 0; x < BLOCK; x += 1) s += at(bx + x, by + y);
      means.push(s / (BLOCK * BLOCK));
    }
  }
  if (means.length < 2) return Number.POSITIVE_INFINITY;
  const mu = means.reduce((a, b) => a + b, 0) / means.length;
  return Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length);
}

function analyze(file) {
  const png = PNG.sync.read(readFileSync(file));
  const { width: w, height: h, data } = png;
  const at = (x, y) => {
    const i = (w * y + x) << 2;
    return luma(data[i], data[i + 1], data[i + 2]);
  };

  // Both criteria assume a FULL-BLEED tile. Pointed at a cut-out prop (a rug, a
  // stanchion) the transparent surround reads as a pitch-black border and the
  // frame check reports a bogus ~100% failure. Detect and skip rather than emit
  // a confident wrong answer — the author of this check tripped exactly this.
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) opaque += 1;
  const coverage = opaque / (w * h);
  if (coverage < 0.98) {
    return { file, w, h, coverage, skipped: true, pass: true };
  }

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
  const structure = structureScore(w, h, at);
  const framePass = worst < THRESHOLD;
  const structurePass = structure >= STRUCTURE_FLOOR;
  return {
    file,
    w,
    h,
    interior,
    worst,
    worstWhere,
    structure,
    framePass,
    structurePass,
    pass: framePass && structurePass,
  };
}

let failed = 0;
let targets;
try {
  targets = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}`);
  console.error(
    'Usage: node scripts/agent/art/edge-frame-check.mjs <png> [...] [--threshold 0.10] [--edge-depth 6] [--interior-inset 24] [--structure-floor 5]',
  );
  process.exit(2);
}
for (const file of targets) {
  try {
    const r = analyze(file);
    if (!r.pass) failed += 1;
    if (r.skipped) {
      console.log(
        `SKIP  not a full-bleed tile (opaque ${(r.coverage * 100).toFixed(1)}%)  ${r.w}x${r.h}  ${r.file}`,
      );
      continue;
    }
    const why = r.framePass
      ? r.structurePass
        ? ''
        : `  BLANK (structure ${r.structure.toFixed(1)} < ${STRUCTURE_FLOOR})`
      : `  FRAMED worst=${r.worstWhere}`;
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  edge=${(r.worst * 100).toFixed(1)}%  struct=${r.structure.toFixed(1)}  ${r.w}x${r.h}  interior=${r.interior.toFixed(1)}  ${r.file}${why}`,
    );
  } catch (err) {
    failed += 1;
    console.log(`ERROR ${file}: ${err.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
