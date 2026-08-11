#!/usr/bin/env tsx
/**
 * walk-cycle-sequential.ts — experimental sequential walk cycle generator.
 *
 * Generates each of the 4 walk cycle keyframes ONE AT A TIME in order,
 * using the previously generated frame as an identity seed for the next.
 * Two modes let us test whether more per-frame options help or hurt:
 *
 *   --mode 1x1   Each frame is a 1×1 sheet (1 cell per generation call).
 *                The pipeline generates multiple variant attempts and picks
 *                the best single cell automatically.
 *
 *   --mode 2x2   Each frame is a 2×2 sheet where ALL 4 CELLS are variants
 *                of the SAME single pose (not 4 different animation frames).
 *                The pipeline picks the best cell from 16 total options
 *                (4 generation attempts × 4 cells each).
 *
 * After all 4 frames are chosen, the script packs them into a horizontal
 * 1×4 strip and saves it to generated/experiments/walk-sequential-<mode>/.
 *
 * Usage:
 *   npx tsx scripts/sprites/experiments/walk-cycle-sequential.ts --mode 1x1
 *   npx tsx scripts/sprites/experiments/walk-cycle-sequential.ts --mode 2x2
 *   npx tsx scripts/sprites/experiments/walk-cycle-sequential.ts --mode both
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { packFrameStrip } from '../pack-frame-strip.js';

// ---------------------------------------------------------------------------
// Frame size normalization — pad frames to uniform dimensions for the strip
// ---------------------------------------------------------------------------

/**
 * Given a set of PNG buffers that may have different heights, pad each one
 * at the TOP with the background colour (taken from the top-left corner of
 * the first frame) so all frames share the tallest frame's height.  Width
 * must already be uniform (it always is — the pipeline fixes the width to
 * brief.size.width).
 */
function normalizeFrameSizes(buffers: Buffer[]): Buffer[] {
  const decoded = buffers.map((buf) => PNG.sync.read(buf));
  const maxH = Math.max(...decoded.map((p) => p.height));
  const w = decoded[0]!.width;

  // Background colour from top-left pixel of the first frame
  const bg = decoded[0]!.data.slice(0, 4); // [R, G, B, A]

  return decoded.map((src) => {
    if (src.height === maxH) {
      return PNG.sync.write(src);
    }
    const padTop = maxH - src.height;
    const dst = new PNG({ width: w, height: maxH });
    // Fill entire canvas with background colour
    for (let y = 0; y < maxH; y++) {
      for (let x = 0; x < w; x++) {
        const off = (y * w + x) * 4;
        dst.data[off] = bg[0]!;
        dst.data[off + 1] = bg[1]!;
        dst.data[off + 2] = bg[2]!;
        dst.data[off + 3] = bg[3]!;
      }
    }
    // Copy source rows into the bottom of the destination
    for (let y = 0; y < src.height; y++) {
      const srcStart = y * w * 4;
      const dstStart = (padTop + y) * w * 4;
      src.data.copy(dst.data, dstStart, srcStart, srcStart + w * 4);
    }
    return PNG.sync.write(dst);
  });
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const modeArg = args[args.indexOf('--mode') + 1] ?? 'both';
if (!['1x1', '2x2', 'both'].includes(modeArg)) {
  console.error(`Unknown --mode "${modeArg}". Use 1x1, 2x2, or both.`);
  process.exit(1);
}
const modes: Array<'1x1' | '2x2'> =
  modeArg === 'both' ? ['1x1', '2x2'] : [modeArg as '1x1' | '2x2'];

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Frame pose definitions (near/far camera-relative language)
// ---------------------------------------------------------------------------

interface FrameDef {
  readonly slug: string;
  readonly poseDescription: string;
  /** For 2×2 mode: preamble telling model all 4 cells are the same pose */
  readonly variantPreamble?: string;
}

const FRAMES: FrameDef[] = [
  {
    slug: 'contact-far-lead',
    poseDescription: `
FRAME 1 OF 4 — CONTACT POSE (FAR leg leads):
  FAR LEG (furthest from camera, drawn behind torso): heel planted on the floor
    AHEAD of the body center, foot flat. This leg is fully extended forward.
  NEAR LEG (closest to camera, drawn in front of torso): lifted BEHIND the body,
    toe pushing off the ground. This leg is bent and trailing.
  NEAR ARM (closest to camera, drawn in front): swings FORWARD, reaching toward
    the RIGHT edge of the cell — clearly visible, extended ahead.
  FAR ARM (furthest from camera, drawn behind torso): trails BACK, toward the
    LEFT edge of the cell.
  STRIDE IS MAXIMUM: legs are as far apart as possible while both feet remain
    inside the cell. This is the widest-spread pose of the walk cycle.
`,
  },
  {
    slug: 'passing-a',
    poseDescription: `
FRAME 2 OF 4 — PASSING POSE (first):
  Both legs have crossed under the body center and are now nearly vertical,
    weight balanced. Near leg passes through, swinging from back to front.
    Far leg lifts from the floor, transitioning to its forward swing.
  Both arms are near the neutral/vertical position — crossing through center.
    Neither arm is clearly forward or backward; both are close to the body.
  This is the midpoint transition between frame 1 and frame 3.
`,
  },
  {
    slug: 'contact-near-lead',
    poseDescription: `
FRAME 3 OF 4 — CONTACT POSE (NEAR leg leads) — OPPOSITE of frame 1:
  NEAR LEG (closest to camera, drawn in front of torso): heel planted on the
    floor AHEAD of the body center, foot flat. This leg is now fully extended
    forward — it was the trailing leg in frame 1, now it leads.
  FAR LEG (furthest from camera, drawn behind torso): lifted BEHIND the body,
    toe pushing off. This leg is bent and trailing.
  FAR ARM (furthest from camera, drawn behind torso): swings FORWARD, reaching
    toward the RIGHT edge of the cell — clearly extended ahead.
  NEAR ARM (closest to camera, drawn in front): trails BACK, toward the LEFT
    edge of the cell.
  STRIDE IS MAXIMUM: same wide spread as frame 1 but with the opposite leg
    leading. Arms and legs are FULLY SWAPPED compared to frame 1.
  FACING DIRECTION IS UNCHANGED: character still faces right. Only which leg
    is forward has changed — never the facing direction.
`,
  },
  {
    slug: 'passing-b',
    poseDescription: `
FRAME 4 OF 4 — PASSING POSE (second) — OPPOSITE of frame 2:
  Both legs crossing under the body center again, nearly vertical. Far leg
    passes through (swinging from back to front this time). Near leg lifts.
  Both arms near neutral/vertical, crossing through center.
  This is the midpoint transition between frame 3 and frame 1 (the loop).
  Leg crossing direction is opposite to frame 2.
`,
  },
];

// ---------------------------------------------------------------------------
// Shared character base description (identity, style, outfit)
// ---------------------------------------------------------------------------

const BASE_CHARACTER = `
THE PLAYER CHARACTER — a scrappy dungeon-crawling CONTESTANT on a televised
reality-show dungeon crawl. Determined, a little scruffy, clearly the
underdog hero rather than a staff member or monster.

ART STYLE IS THE FIRST PRIORITY. Draw in the style of EARTHBOUND, CHRONO
TRIGGER, UNDERTALE and ZELDA: A LINK TO THE PAST. Charming, cartoonish,
chunky pixel art. NOT gritty, NOT painterly, NOT semi-realistic, NOT dark
fantasy.

PROPORTIONS ARE BOBBLEHEAD: about THREE AND A HALF HEADS TALL total, with a
large rounded head (roughly one third of total height) on a short, chunky
body. Stubby arms and legs, simple block feet, mitten-shaped hands with no
individual fingers. Simple readable face: two dot/bean eyes, small nose,
a determined closed-mouth or slight grin. No realistic facial detail.

GENDER CUE: shoulder-length hair worn back in a simple ponytail or two short
braids, and slightly longer eyelashes suggested with a single thin line above
each eye. Everything else — head size, body proportions, height, silhouette
width, outfit, and stance — must match the male and androgynous variants exactly.
Do NOT draw a dress, skirt, or any outfit piece different from the shared OUTFIT.

RENDERING IS FLAT AND CLEAN: flat colour fills with hard-edged cel shading,
two or three tonal stops per material, no gradients, no dithering or grain
texture. A clean, consistent dark outline around the figure.

OUTFIT: a simple worn adventurer's tunic (belted at the waist) over plain
trousers, sturdy boots, and a small satchel/pack strapped across the back.
No helmet — bare head with simple hair per the GENDER CUE above. The
contestant carries NO visible weapon or shield; equipment is layered separately.

VALUE STRUCTURE: light-to-mid tunic as the largest brightest mass (torso and
arms), clearly separating from darker trousers and boots below. Three distinct
value bands: head, tunic/arms, legs/boots — never one flat blob.

COLOUR: warm desaturated adventurer palette — muted green or brown tunic,
tan/leather belt and satchel, dark brown trousers and boots, warm tan skin
(never orange, amber, or gold), simple brown or dark-blond hair.

HARD NEGATIVES:
 - Do NOT draw a weapon, shield, staff, or any held item in either hand.
 - Do NOT draw armor plating, a cape, a hood, or a helmet.
 - Do NOT draw realistic or adult-proportioned anatomy. Small head = FAILURE.
 - Do NOT draw a dress or skirt.
 - Do NOT use heavy dithering, noise, or grain.
 - Do NOT draw a drop shadow or cast shadow under the figure.
 - Do NOT leave any fully enclosed pocket of background inside the figure.
 - Keep arms close to the torso (natural walking swing) so no background gap
   opens between an upper arm and the body.

FACING DIRECTION: the character faces RIGHTWARD — a right-facing side profile —
in every cell. Face and nose point toward the RIGHT edge. Satchel strap on the
far shoulder. Do NOT mirror or flip the character.

NEAR vs FAR LIMBS — for this right-facing side-view character:
  NEAR arm and NEAR leg = limbs on the side CLOSEST to the camera, drawn
    visually in FRONT of the torso (they overlap/occlude the far limbs).
  FAR arm and FAR leg = limbs on the side FURTHEST from the camera, drawn
    visually BEHIND the torso (partially hidden by the body).

ARM SWING IS OPPOSITE TO LEG STRIDE — this is fundamental to a natural walk:
  When the stride-FORWARD leg is FAR → the stride-FORWARD arm is NEAR.
  When the stride-FORWARD leg is NEAR → the stride-FORWARD arm is FAR.
  The forward arm MUST visibly extend toward the RIGHT edge of the cell.
  The back arm MUST visibly trail toward the LEFT edge of the cell.
  Arm swing must be EXAGGERATED enough to read at 40px tall.

SIZE: the standing figure spans roughly 80-90% of the cell's narrower axis,
centered, feet on a common invisible floor line. Leave a generous visible
margin of background colour around every side of the figure.

SHEET BACKGROUND: one single flat uniform background colour, identical across
all cells, clearly distinct from the figure's colours.
`.trim();

// ---------------------------------------------------------------------------
// Brief YAML builder
// ---------------------------------------------------------------------------

/** Indent every line of a multi-line string by `spaces` spaces (for YAML literal blocks). */
function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

function buildFrameBrief(opts: {
  frameIndex: number;
  frame: FrameDef;
  mode: '1x1' | '2x2';
  seedPath: string | null;
  briefName: string;
}): string {
  const { frameIndex, frame, mode, seedPath, briefName } = opts;

  const rows = mode === '1x1' ? 1 : 2;
  const cols = mode === '1x1' ? 1 : 2;
  // Azure gpt-image-1 minimum canvas size is 1024×1024
  const canvas = mode === '1x1' ? 1024 : 1024;

  const variantPreamble =
    mode === '2x2'
      ? `THIS SHEET HAS ${rows * cols} CELLS — ALL ${rows * cols} CELLS SHOW THE SAME POSE.
You are generating ${rows * cols} DIFFERENT PIXEL-ART INTERPRETATIONS of a single
walk-cycle frame. Every cell must show IDENTICAL limb positions (the pose below),
but may vary slightly in pixel-art rendering details. Do NOT animate or vary the
pose between cells — all cells show the same frame.\n\n`
      : '';

  // Build the full description body, then indent every line by 2 for YAML literal block
  const descBody = (
    variantPreamble +
    BASE_CHARACTER +
    '\n\n' +
    frame.poseDescription.trim()
  ).trimEnd();
  const indentedDesc = indent(descBody);

  const seedBlock =
    seedPath != null
      ? `seedFrames:
  - path: ${JSON.stringify(seedPath)}
    note: 'Previous walk-cycle frame — match CHARACTER IDENTITY (face, hair, outfit, palette) but do NOT copy this pose'
    identityOnly: true
`
      : '';

  return `type: character
name: ${briefName}
description: |
${indentedDesc}
size:
  width: 256
  height: 256
anchor:
  x: 128
  y: 252
${seedBlock}frameSequence:
  enabled: false
generation:
  sheet:
    rows: ${rows}
    cols: ${cols}
    emptyCells: []
    nativeCanvas: ${canvas}
sensors:
  anchor:
    mode: center-of-mass
  interiorHoles:
    maxPixels: 80
judge:
  enabled: false
minVariations: 0
tags:
  - player
  - contestant
  - walk-cycle
  - animation
  - gender-female
  - sequential-experiment
  - frame-${frameIndex + 1}
  - mode-${mode}
`;
}

// ---------------------------------------------------------------------------
// Run one brief, return the processedPath of the chosen candidate
// ---------------------------------------------------------------------------

function runBrief(briefPath: string): { processedPath: string; runDir: string } {
  console.log(`\n  Running: ${path.basename(briefPath)} ...`);

  let stdout: string;
  try {
    stdout = execSync(`npx tsx scripts/sprites/cli.ts --brief ${JSON.stringify(briefPath)}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err: unknown) {
    // CLI exits non-zero when no variant passes all sensors, but still writes summary.json
    // with the best candidate. Extract stdout from the error so we can find the run dir.
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    stdout = execErr.stdout ?? '';
    const exitCode = execErr.status ?? 1;
    if (stdout === '') {
      // Truly fatal (no output at all) — rethrow
      throw err;
    }
    console.warn(`  CLI exited ${exitCode} — using best candidate despite sensor failures.`);
  }

  // Parse run dir from output: "run dir : /absolute/path"
  const runDirMatch = stdout.match(/run dir\s*:\s*(.+)/);
  if (!runDirMatch) {
    console.error('  Could not parse run dir from output:\n', stdout);
    throw new Error('Failed to parse run directory from CLI output');
  }
  const runDir = runDirMatch[1]!.trim();
  console.log(`  Run dir: ${runDir}`);

  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary.json not found at ${summaryPath}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

  if (!summary.chosen) {
    throw new Error(`No chosen candidate in ${summaryPath}. All variants failed?`);
  }

  const chosenEntry = summary.candidates[summary.chosen.index];
  if (!chosenEntry) {
    throw new Error(`chosen.index ${summary.chosen.index} out of range in ${summaryPath}`);
  }

  // processedPath is absolute on disk (it's written by the pipeline as absolute)
  const processedPath: string = chosenEntry.processedPath;
  if (!fs.existsSync(processedPath)) {
    throw new Error(`Chosen processed file not found: ${processedPath}`);
  }

  const score = `${chosenEntry.score}/${chosenEntry.outOf}`;
  console.log(
    `  Chosen: index=${summary.chosen.index}, score=${score}, passed=${chosenEntry.passed}`,
  );
  console.log(`  File: ${processedPath}`);

  return { processedPath, runDir };
}

// ---------------------------------------------------------------------------
// Run one mode
// ---------------------------------------------------------------------------

async function runMode(mode: '1x1' | '2x2'): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const experimentDir = path.join(
    REPO_ROOT,
    'generated',
    'experiments',
    `walk-sequential-${mode}-${timestamp}`,
  );
  const briefsDir = path.join(experimentDir, 'briefs');
  const seedsDir = path.join(experimentDir, 'seeds');
  const framesDir = path.join(experimentDir, 'frames');

  fs.mkdirSync(briefsDir, { recursive: true });
  fs.mkdirSync(seedsDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`MODE: ${mode}`);
  console.log(`Output: ${experimentDir}`);
  console.log('='.repeat(60));

  const chosenFramePaths: string[] = [];
  let lastSeedPath: string | null = null;

  for (let i = 0; i < FRAMES.length; i++) {
    const frame = FRAMES[i]!;
    console.log(`\nFrame ${i + 1}/4: ${frame.slug}`);

    const briefName = `walk-seq-${mode}-f${i + 1}-${frame.slug}`;
    const briefPath = path.join(briefsDir, `frame-${i + 1}.yaml`);

    const briefYaml = buildFrameBrief({
      frameIndex: i,
      frame,
      mode,
      seedPath: lastSeedPath,
      briefName,
    });
    fs.writeFileSync(briefPath, briefYaml, 'utf8');

    const { processedPath } = runBrief(briefPath);

    // Copy to frames dir
    const frameDest = path.join(framesDir, `frame-${i + 1}-${frame.slug}.png`);
    fs.copyFileSync(processedPath, frameDest);
    chosenFramePaths.push(frameDest);

    // Copy as seed for next frame (repo-relative path for the brief YAML)
    const seedDest = path.join(seedsDir, `frame-${i + 1}.png`);
    fs.copyFileSync(processedPath, seedDest);
    // The brief needs a path relative to repo root
    lastSeedPath = path.relative(REPO_ROOT, seedDest).replace(/\\/g, '/');
    console.log(`  Saved seed: ${lastSeedPath}`);
  }

  // Pack into 1×4 strip
  console.log(`\nPacking ${chosenFramePaths.length} frames into strip...`);
  const rawBuffers = chosenFramePaths.map((p) => fs.readFileSync(p));
  const normalizedBuffers = normalizeFrameSizes(rawBuffers);
  const strip = packFrameStrip(normalizedBuffers);
  const stripPath = path.join(experimentDir, 'strip.png');
  fs.writeFileSync(stripPath, strip.buffer);
  console.log(
    `Strip: ${stripPath} (${strip.frameWidth}×${strip.frameHeight} × ${strip.frameCount} frames)`,
  );

  // Summary
  console.log(`\nMode ${mode} complete.`);
  console.log(`  Individual frames: ${framesDir}`);
  console.log(`  Final strip:       ${stripPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  for (const mode of modes) {
    await runMode(mode);
  }
  console.log('\nAll modes complete.');
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
