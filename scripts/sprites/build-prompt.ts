import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Brief } from './brief-schema.js';
import { variantCount } from './brief-schema.js';

/**
 * Pure prompt builders for the sprite generation pipeline.
 *
 * The style preamble is the single source of truth for cross-brief visual
 * constraints. It lives in docs/agent-os/sprite-style.md (between the
 * "--- STYLE PREAMBLE (do not deviate) ---" and "--- END STYLE PREAMBLE ---"
 * markers in a blockquote) so that designers can edit it without touching code,
 * and so that every brief-specific prompt starts from the same hard rules.
 *
 * These functions are pure given the styleGuide string; loading the style
 * guide from disk is done by `loadStyleGuide()` (impure) so callers in tests
 * can pass synthetic preambles without touching the filesystem.
 */

const STYLE_GUIDE_RELATIVE_PATH = 'docs/agent-os/sprite-style.md';
const PREAMBLE_START = '--- STYLE PREAMBLE (do not deviate) ---';
const PREAMBLE_END = '--- END STYLE PREAMBLE ---';

interface BackgroundCandidate {
  readonly name: string;
  readonly hex: string;
  readonly rgb: readonly [number, number, number];
}

const BACKGROUND_CANDIDATES: readonly BackgroundCandidate[] = [
  { name: 'bright magenta', hex: '#ff00ff', rgb: [255, 0, 255] },
  { name: 'electric cyan', hex: '#00ffff', rgb: [0, 255, 255] },
  { name: 'neon lime', hex: '#39ff14', rgb: [57, 255, 20] },
  { name: 'vivid yellow', hex: '#fff200', rgb: [255, 242, 0] },
  { name: 'bright sky blue', hex: '#00a2ff', rgb: [0, 162, 255] },
  { name: 'safety orange', hex: '#ff6a00', rgb: [255, 106, 0] },
];

/**
 * Read and parse the style guide markdown file.
 *
 * Looks for the verbatim block between the START and END markers, strips the
 * leading "> " blockquote prefix, and returns the result as a single string.
 * Throws if the markers are missing or out of order — that's a developer
 * error in the style guide, not a runtime input bug.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param read - File reader, injectable for tests.
 */
export function loadStyleGuide(
  repoRoot: string,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  const path = resolve(repoRoot, STYLE_GUIDE_RELATIVE_PATH);
  const md = read(path);
  return extractPreamble(md);
}

export function extractPreamble(markdown: string): string {
  const startIdx = markdown.indexOf(PREAMBLE_START);
  const endIdx = markdown.indexOf(PREAMBLE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      `Style guide is missing the preamble markers. Expected '${PREAMBLE_START}' followed by '${PREAMBLE_END}' in ${STYLE_GUIDE_RELATIVE_PATH}.`,
    );
  }
  const slice = markdown.slice(startIdx, endIdx + PREAMBLE_END.length);
  return slice
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n')
    .trim();
}

/**
 * Build a prompt for a single-variant (non-sheet) generation.
 *
 * Phase 2 always uses sheet mode in the orchestrator, but the single-variant
 * builder is kept available for ad-hoc tools and future single-image refinement
 * passes. Sharing the same structure with the sheet builder also makes it
 * trivial to diff "what's different about sheet mode?" in tests.
 */
export function buildPrompt(brief: Brief, styleGuide: string): string {
  const rules = typeRulesBlock(brief);
  return [
    styleGuide,
    '',
    briefSubjectBlock(brief),
    '',
    outputSizeBlock(brief),
    ...(rules ? ['', rules] : []),
    '',
    singleConstraintsBlock(brief),
  ].join('\n');
}

/**
 * Build a prompt for a multi-variant sheet generation.
 *
 * The generator is told the exact grid shape (rows × cols), the exact total
 * variant count, and the cells (if any) that must be left empty. We also
 * repeat the per-variant constraints (no clipping, square, no text) at the
 * end of the prompt because models in our manual e2e ignored them when they
 * appeared only at the top.
 */
export function buildSheetPrompt(brief: Brief, styleGuide: string, variants?: number): string {
  const rows = brief.generation.sheet.rows;
  const cols = brief.generation.sheet.cols;
  const emptyCells = brief.generation.sheet.emptyCells;
  const count = variants ?? variantCount(brief);
  const rules = typeRulesBlock(brief);
  const variationsBlock = thematicVariationsBlock(brief.variations);
  return [
    styleGuide,
    '',
    briefSubjectBlock(brief),
    '',
    outputSizeBlock(brief),
    ...(rules ? ['', rules] : []),
    '',
    sheetLayoutBlock(rows, cols, count, emptyCells),
    ...(variationsBlock ? ['', variationsBlock] : []),
    '',
    sheetConstraintsBlock(brief),
  ].join('\n');
}

function briefSubjectBlock(brief: Brief): string {
  // Tags are intentionally NOT emitted into the prompt: they're an
  // internal taxonomy used downstream (filtering briefs, grouping
  // generations) and the model handles natural-language descriptions
  // better than comma-separated keywords. Authors should put any
  // visual detail in the description / prompt itself.
  return ['## Subject', brief.prompt.trim()].join('\n');
}

type Aspect = 'square' | 'wide' | 'tall';

function aspectOf(width: number, height: number): Aspect {
  if (width > height) return 'wide';
  if (height > width) return 'tall';
  return 'square';
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Reduced `W:H` ratio text, e.g. 128×64 → "2:1", 64×128 → "1:2". */
function aspectRatioText(width: number, height: number): string {
  const divisor = gcd(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}

/** Pixel dimensions of one (square) source cell on the generated sheet. */
function cellDims(brief: Brief): { cellW: number; cellH: number } {
  const native = brief.generation.sheet.nativeCanvas;
  const { rows, cols } = brief.generation.sheet;
  return { cellW: Math.round(native / cols), cellH: Math.round(native / rows) };
}

/**
 * The source-pixel bounding box the subject should occupy inside its square
 * cell so that, once trimmed and fit into the final W×H box, it keeps its
 * aspect ratio without letterboxing. Uniform scale on both axes (the limiting
 * axis wins) reproduces the historical 0.875–0.9375 "224–240 in a 256 cell"
 * band for the default square case and stretches correctly for wide/tall.
 */
function sourceFootprint(brief: Brief): {
  loW: number;
  hiW: number;
  loH: number;
  hiH: number;
} {
  const { cellW, cellH } = cellDims(brief);
  const width = brief.size.width;
  const height = brief.size.height;
  const scaleLo = Math.min((cellW * 0.875) / width, (cellH * 0.875) / height);
  const scaleHi = Math.min((cellW * 0.9375) / width, (cellH * 0.9375) / height);
  return {
    loW: Math.round(width * scaleLo),
    hiW: Math.round(width * scaleHi),
    loH: Math.round(height * scaleLo),
    hiH: Math.round(height * scaleHi),
  };
}

/**
 * Tell the model the exact final pixel dimensions and, for non-square
 * variants, the proportion to draw. The post-processor fits the trimmed
 * subject into the brief's W×H box preserving aspect, so a subject drawn at
 * the wrong proportion would letterbox; this block keeps wide/tall/large
 * subjects shaped correctly. Tiles fill their frame edge-to-edge and so get a
 * simpler footprint-free variant.
 */
function outputSizeBlock(brief: Brief): string {
  const width = brief.size.width;
  const height = brief.size.height;
  const aspect = aspectOf(width, height);
  const lines: string[] = ['## Output size'];
  lines.push(
    `- Each finished sprite resolves to exactly ${width}x${height} pixels after post-processing.`,
  );

  if (brief.type === 'tile') {
    lines.push(
      aspect === 'square'
        ? `- The tile frame is square (${width}x${height}); fill it edge-to-edge.`
        : `- The tile frame is ${aspect === 'wide' ? 'landscape' : 'portrait'} (${width}x${height}, ${aspectRatioText(width, height)}); fill it edge-to-edge across both axes — do not center a square motif.`,
    );
    return lines.join('\n');
  }

  const { cellW, cellH } = cellDims(brief);
  if (aspect === 'square') {
    lines.push(
      `- Draw each subject at a 1:1 (square) proportion, centered within its square ${cellW}x${cellH} source cell.`,
    );
  } else {
    const orientation =
      aspect === 'wide' ? 'landscape (wider than tall)' : 'portrait (taller than wide)';
    const { loW, hiW, loH, hiH } = sourceFootprint(brief);
    lines.push(
      `- The final sprite is ${orientation} at a ${aspectRatioText(width, height)} aspect ratio. Draw each subject to fill that proportion — do NOT default to a square subject.`,
    );
    lines.push(
      `- Within each square ${cellW}x${cellH} source cell, the subject should span roughly ${loW}-${hiW} source pixels wide and ${loH}-${hiH} source pixels tall, centered, so it keeps its ${aspectRatioText(width, height)} shape without letterboxing.`,
    );
  }
  return lines.join('\n');
}

function typeRulesBlock(brief: Brief): string | null {
  if (brief.type === 'enemy') {
    const { cellW, cellH } = cellDims(brief);
    const { loH, hiH } = sourceFootprint(brief);
    return [
      '## Mob rules',
      '- Draw the mob facing straight forward, not angled or in three-quarter view.',
      '- Keep the sprite body-only: no held weapons, no shields, no spell effects, no fire, no glow, no floating orbs, and no particle trails.',
      `- For upright/humanoid mobs, normalize the figure to read as roughly a full ${brief.size.height}px-tall in-game sprite (about ${loH}-${hiH} source pixels tall in a ${cellW}x${cellH} cell) while keeping natural proportions. Avoid elongated, extra-tall limb/torso stretch.`,
      '- Anchor and composition should read from the mob silhouette itself, centered around the body mass.',
    ].join('\n');
  }
  if (brief.type === 'tile') {
    return [
      '## Tile rules',
      `- This sprite is a tileable background tile and must be authored at exactly ${brief.size.width}x${brief.size.height} pixels after post-processing.`,
      '- Fill the tile frame edge-to-edge; do not center a floating icon, object, or isolated subject.',
      '- Make edges tile seamlessly in both axes: left matches right and top matches bottom.',
      '- Avoid directional lighting seams that break when repeated in a grid.',
    ].join('\n');
  }
  if (brief.type === 'character') {
    const { cellW, cellH } = cellDims(brief);
    const { loH, hiH } = sourceFootprint(brief);
    const breatheLo = Math.round((cellH - hiH) / 2);
    const breatheHi = Math.round((cellH - loH) / 2);
    return [
      '## Character rules',
      '- Keep the character front-facing with readable facial features and clear eye line toward camera.',
      `- **Height normalization:** default to a ${brief.size.height}px-tall final character read. In a ${cellW}×${cellH} source cell this is roughly ${loH}-${hiH} source pixels tall (top of head to sole of feet) with small top/bottom breathing room (about ${breatheLo}-${breatheHi} source pixels each). Keep proportions natural; do NOT stretch the body vertically to chase height, and do NOT center a tiny figure in a large empty box.`,
      '- **Facial detail:** face must have individually readable eyes (pupils, whites), a nose bridge, and a closed or slightly open mouth — each feature rendered with several source pixels per output pixel. No smeared blobs for a face.',
      '- **Hair readability:** preserve visible hair mass and hairline shape (braids/locs/twists/afro silhouette must be explicit). Do not collapse hair into a tiny cap, and do not blend hair into skin or background.',
      '- **Contrast control:** prioritize strong dark outlines and clear light-vs-dark separation on face, hair, and outfit seams. Keep 3–5 readable tone steps (base/shadow/deep shadow/highlight) and avoid both muddy mid-tone clusters and overly flat 2-tone blocks.',
      '- Avoid drab monochrome outfits. Use high-contrast wardrobe accents from across the available palette (cool + warm hues, not only browns/oranges).',
      '- Ensure hair and skin tones are clearly differentiated from clothing so the silhouette and face stay readable at 1×.',
      '- Preserve practical adventurer styling (functional gear, no ornate royal costume unless explicitly requested).',
    ].join('\n');
  }
  return null;
}

function singleConstraintsBlock(brief: Brief): string {
  if (brief.type === 'tile') {
    return [
      '## Output requirements',
      '- Exactly one full tile variant in a square frame.',
      '- Fill the frame edge-to-edge with seamless tiling continuity across opposite edges.',
      `- Final output must resolve to exactly ${brief.size.width}x${brief.size.height} pixels after post-processing.`,
      '- No text, numbers, digits, captions, watermarks, signatures, or UI overlays anywhere in the image.',
    ].join('\n');
  }
  const bg = pickContrastingBackgroundColor(brief);
  const aspect = aspectOf(brief.size.width, brief.size.height);
  const subjectLine =
    aspect === 'square'
      ? '- Exactly one subject, centered in a square frame.'
      : `- Exactly one subject, centered in the frame at a ${aspectRatioText(brief.size.width, brief.size.height)} (${aspect === 'wide' ? 'landscape' : 'portrait'}) proportion.`;
  const clipLine =
    aspect === 'square'
      ? '- Subject must not be clipped at any edge — leave at least 10% margin on all sides.'
      : '- Subject must not be clipped at any edge — keep a small margin so nothing touches the edges, but do not shrink the subject to a square footprint.';
  return [
    '## Output requirements',
    subjectLine,
    clipLine,
    `- Transparent background, or a single flat high-contrast background color that is clearly distinct from the sprite palette. Prefer ${bg.name} (${bg.hex}). Do NOT use black backgrounds. Cast shadows must be neutral/dark (gray, cool gray, or brown) and must NOT be in the same color family as the background (never pink/magenta-family shadows on pink/magenta backgrounds). No decorative borders, gradients, or scene elements.`,
    '- No text, numbers, digits, captions, watermarks, signatures, or UI overlays anywhere in the image.',
  ].join('\n');
}

function sheetLayoutBlock(
  rows: number,
  cols: number,
  count: number,
  emptyCells: ReadonlyArray<readonly [number, number]>,
): string {
  const lines: string[] = [];
  lines.push('## Sheet layout');
  lines.push(
    `Generate exactly ${count} variants on a single sheet, arranged in a regular ${rows}×${cols} grid (${rows} rows, ${cols} columns).`,
  );
  lines.push(
    'Each grid cell must be the same size, perfectly square, and the variants must be laid out left-to-right, top-to-bottom in reading order.',
  );
  if (emptyCells.length > 0) {
    const coords = emptyCells.map(([r, c]) => `(row ${r + 1}, col ${c + 1})`).join(', ');
    lines.push(
      `Leave these cells fully empty (transparent / background only, no subject): ${coords}.`,
    );
  } else {
    lines.push('Every cell must contain exactly one variant — no empty cells.');
  }
  lines.push(
    'Treat each cell as a separate exploration of the same subject. VARY along: silhouette proportions, pose / angle within the orientation rule, internal detail density, shading direction, individual material color choices (e.g. a different brown for a wrapped hilt, a different grey for steel). DO NOT vary along: art style, outline thickness, subject identity, orientation, level of stylization. If the subject description is short or leaves room for interpretation, lean into the variation axes above so the sheet covers the design space rather than producing 16 near-duplicates.',
  );
  return lines.join('\n');
}

/**
 * Optional thematic-variations block — emitted only when the brief lists
 * concrete on-theme embellishments. The block sits between the layout
 * block (which fixes count/grid/orientation) and the per-variant
 * constraints block (which fixes square/no-text/no-borders) so the model
 * reads "here's WHAT to do" → "here are the SPECIFIC variations" → "here
 * are the FORMATTING rules" in that order.
 *
 * Returns `null` when no variations are declared so the caller can skip
 * the surrounding blank line cleanly.
 */
function thematicVariationsBlock(variations: ReadonlyArray<string>): string | null {
  if (variations.length === 0) return null;
  const bullets = variations.map((v) => `- ${v.trim()}`).join('\n');
  return [
    '## Thematic variations',
    "The subject's core identity must stay intact (silhouette, palette, orientation, and overall composition unchanged). Distribute the following on-theme embellishments across the cells. Most cells should incorporate exactly ONE of these variations; a few cells should remain baseline (no extra embellishment). Do not combine multiple embellishments in the same cell. Do not invent variations outside this list.",
    bullets,
  ].join('\n');
}

function sheetConstraintsBlock(brief: Brief): string {
  if (brief.type === 'tile') {
    return [
      '## Per-variant requirements (apply to every cell)',
      '- Each variant must occupy the full square tile area with no transparent padding and no subject margin.',
      `- Each output tile must resolve to exactly ${brief.size.width}x${brief.size.height} pixels after post-processing.`,
      '- Preserve seamless tiling continuity: opposite edges must align when repeated.',
      '- Do NOT add numbers, labels, captions, watermarks, signatures, borders, dividers, or any text anywhere on the sheet or in any individual cell.',
      '- Use a transparent background only where the tile design intentionally includes transparency; otherwise keep a flat tile background. No decorative sheet borders between cells.',
      '- Do not draw a frame, header, or footer around the grid.',
    ].join('\n');
  }
  const bg = pickContrastingBackgroundColor(brief);
  return [
    '## Per-variant requirements (apply to every cell)',
    brief.type === 'character' || brief.type === 'enemy'
      ? '- Each variant must fit fully within its grid cell — none cut off at any edge. Keep a small but explicit top/bottom margin so hair and feet never touch or cross the cell border. Horizontal side margins are acceptable.'
      : '- Each variant must fit fully within its grid cell — none cut off at any edge. Leave at least a 10% margin between the subject and the cell edge.',
    aspectOf(brief.size.width, brief.size.height) === 'square'
      ? '- All variants are square, share the same dimensions, and use the same orientation and scale.'
      : `- Every grid cell is the same square size; within each cell all subjects share the same ${aspectRatioText(brief.size.width, brief.size.height)} subject proportion, dimensions, orientation, and scale.`,
    '- Do NOT add numbers, labels, captions, watermarks, signatures, borders, dividers, or any text anywhere on the sheet or in any individual cell.',
    `- Use a transparent background, or one flat high-contrast background color that is clearly distinct from the sprite palette, consistently across the whole sheet. Prefer ${bg.name} (${bg.hex}). Do NOT use black backgrounds. Cast shadows must be neutral/dark (gray, cool gray, or brown) and must NOT be in the same color family as the background (never pink/magenta-family shadows on pink/magenta backgrounds). No per-cell background variation, no decorative borders between cells.`,
    '- Do not draw a frame, header, or footer around the grid.',
  ].join('\n');
}

export function pickContrastingBackgroundColor(brief: Brief): BackgroundCandidate {
  const paletteColors = brief.palette.colors ?? [];
  if (paletteColors.length === 0) {
    return BACKGROUND_CANDIDATES[0]!;
  }

  let best = BACKGROUND_CANDIDATES[0]!;
  let bestMinDistance = -1;
  for (const candidate of BACKGROUND_CANDIDATES) {
    const minDistance = paletteColors.reduce((min, color) => {
      const [r, g, b] = color;
      const dr = candidate.rgb[0] - r;
      const dg = candidate.rgb[1] - g;
      const db = candidate.rgb[2] - b;
      const distSq = dr * dr + dg * dg + db * db;
      return Math.min(min, distSq);
    }, Number.POSITIVE_INFINITY);
    if (minDistance > bestMinDistance) {
      bestMinDistance = minDistance;
      best = candidate;
    }
  }
  return best;
}
