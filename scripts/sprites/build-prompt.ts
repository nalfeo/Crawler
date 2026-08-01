import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Brief } from './brief-schema.js';
import { variantCount } from './brief-schema.js';
import { resizeSpriteStrategy } from './size-variants.js';
import { CRAWLER_DESIGN_LANGUAGE, floorContextBlock } from './content-direction.js';
import { resolveDesignLanguageAddenda } from './design-language-addenda.js';

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
    .trim()
    .replace('{{CRAWLER_DESIGN_LANGUAGE}}', CRAWLER_DESIGN_LANGUAGE);
}

/**
 * Resolve floor/family design language addenda for a brief and return them
 * as an array of prompt blocks (each prefixed with a blank line separator).
 * Returns an empty array when no addenda apply (e.g. Floor 1 non-enemy sprites).
 */
function designLanguageAddendaBlocks(
  name: string,
  floor: number,
  themeOverride?: string,
): string[] {
  const addenda = resolveDesignLanguageAddenda(name, floor, themeOverride);
  const blocks: string[] = [];
  if (addenda.floor !== undefined) {
    blocks.push('', `## World context\n${addenda.floor}`);
  }
  if (addenda.theme !== undefined) {
    blocks.push('', `## Theme design language\n${addenda.theme}`);
  }
  return blocks;
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
  const addenda = designLanguageAddendaBlocks(brief.name, brief.floor, brief.theme?.designLanguage);
  return [
    styleGuide,
    '',
    floorContextBlock(brief.floor),
    ...addenda,
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
  const count = variants ?? variantCount(brief);
  const rules = typeRulesBlock(brief);
  const variationsBlock = thematicVariationsBlock(brief.variations);
  const addenda = designLanguageAddendaBlocks(brief.name, brief.floor, brief.theme?.designLanguage);
  return [
    styleGuide,
    '',
    ...(brief.seedFrames.length > 0 ? [seedFrameBlock(brief.seedFrames.length), ''] : []),
    floorContextBlock(brief.floor),
    ...addenda,
    '',
    briefSubjectBlock(brief),
    '',
    outputSizeBlock(brief),
    ...(rules ? ['', rules] : []),
    '',
    sheetLayoutBlock(brief, count),
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

/** Pixel dimensions of one source cell on the generated sheet. */
function cellDims(brief: Brief): { cellW: number; cellH: number } {
  const native = brief.generation.sheet.nativeCanvas;
  const { rows, cols } = brief.generation.sheet;
  return { cellW: Math.round(native / cols), cellH: Math.round(native / rows) };
}

/**
 * The source-pixel bounding box the subject should occupy inside its cell so
 * that, once trimmed and fit into the final W×H box, it keeps its aspect ratio
 * without letterboxing. Uniform scale on both axes (the limiting axis wins)
 * reproduces the historical 0.875–0.9375 "224–240 in a 256 cell" band for the
 * default case and, now that cells are reshaped to match the subject aspect,
 * fills wide/tall cells on both axes alike.
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
 * Tell the model the target final dimensions and, for non-square variants, the
 * proportion to draw. Most sprites resolve to exactly the brief W×H. Axis-
 * priority variants (wide/tall and large square occupancy targets) can expand
 * the secondary axis in postprocess to keep silhouette occupancy high, so the
 * prompt calls that out explicitly.
 *
 * Tiles fill their frame edge-to-edge and keep an exact footprint.
 */
function outputSizeBlock(brief: Brief): string {
  const width = brief.size.width;
  const height = brief.size.height;
  const aspect = aspectOf(width, height);
  const strategy = resizeSpriteStrategy(brief.type, width, height, brief.frameSequence?.enabled);
  const lines: string[] = ['## Output size'];
  if (brief.type === 'tile') {
    lines.push(
      `- Each finished tile resolves to exactly ${width}x${height} pixels after post-processing.`,
    );
  } else if (strategy === 'width') {
    lines.push(
      `- Target final frame is ${width}x${height} with width as the main occupancy axis; post-processing may expand height beyond ${height}px to preserve silhouette fill.`,
    );
  } else if (strategy === 'height') {
    lines.push(
      `- Target final frame is ${width}x${height} with height as the main occupancy axis; post-processing may expand width beyond ${width}px to preserve silhouette fill.`,
    );
  } else if (strategy === 'cover') {
    lines.push(
      `- Target final frame is ${width}x${height}; post-processing may expand one axis to preserve large-sprite occupancy without letterboxing.`,
    );
  } else {
    lines.push(
      `- Each finished sprite resolves to exactly ${width}x${height} pixels after post-processing.`,
    );
  }

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
      `- Within each ${cellW}x${cellH} source cell, the subject should span roughly ${loW}-${hiW} source pixels wide and ${loH}-${hiH} source pixels tall, centered, so it keeps its ${aspectRatioText(width, height)} shape without letterboxing.`,
    );
  }
  return lines.join('\n');
}

/**
 * Cartoon-figure rendering rules shared by `character` and `enemy` briefs.
 *
 * WHY THIS EXISTS: Crawler's figures are CARTOONISH (EarthBound, Chrono Trigger,
 * Undertale, Zelda: A Link to the Past), while its props, weapons and tiles stay
 * textured and grungy. That split is deliberate and matches the reference games —
 * chibi characters inhabiting a detailed world.
 *
 * The global style preamble (`docs/agent-os/sprite-style.md`) is authored for
 * WORLD art and asks for grunge, dithering and 3-5 tone stops. Those defaults are
 * wrong for figures, so this block is injected AFTER the preamble and the brief
 * subject, and explicitly overrides them. Do not re-add "realistic proportions",
 * "nose bridge", "pupils and whites", or "avoid flat 2-tone" here — every one of
 * those was previously in this file and is what drove figure art toward
 * semi-realism across multiple regeneration waves.
 *
 * See `docs/knowledge/game-design/art-style-guide.md` ("Character Proportions",
 * "Rendering"), which is the authoritative source this block implements.
 */
function cartoonFigureRules(seedFrameCount: number): readonly string[] {
  const refNote =
    seedFrameCount > 0
      ? `- **About the attached reference images:** The first ${seedFrameCount} image${
          seedFrameCount > 1 ? 's are SEED FRAMES' : ' is a SEED FRAME'
        } (see "Seed frames" section above) — match ${seedFrameCount > 1 ? 'them' : 'it'} EXACTLY in character identity, face and head shape, hair style and colour, outfit and accessory details, colour palette, line weight, and cel-shading style. The remaining reference images provide technique context only: copy their outline weight, palette discipline, and pixel resolution, but NOT their figure proportions or rendering density.`
      : '- **About the attached reference images:** copy their TECHNIQUE ONLY — outline weight, palette discipline, pixel resolution and crispness. Do NOT copy their figure proportions or rendering density. Several references are older, more realistically-proportioned and more heavily textured art that this brief is deliberately moving away from.';
  return [
    '- **Art style (overrides the style preamble for this subject):** draw a CARTOON figure in the tradition of EarthBound, Chrono Trigger, Undertale and Zelda: A Link to the Past. Charming and chunky, NOT gritty, NOT painterly, NOT semi-realistic, NOT photoreal.',
    '- **Proportions are deliberately bobblehead:** for any upright/humanoid figure, roughly 3-4 heads tall in total, with the head about ONE THIRD of the whole height. A big head is REQUIRED, not a defect. Limbs are short, chunky and simplified; hands are mitten shapes without individual fingers.',
    '- **Face:** simple and iconic — large dark dot or bean eyes, little or no nose, one simple mouth shape. Expression comes from a few large features. Do NOT render pupils-and-whites, a nose bridge, wrinkles, pores, stubble texture or individual teeth.',
    '- **Rendering:** flat colour fills with hard-edged cel shading, 2-3 tone stops per material. No gradients, no airbrush blending. Flat is CORRECT here and does not read as unfinished.',
    '- **Minimal dithering.** No dither noise, grain, speckle or grime texture on figures. Wear and age are drawn as a few deliberate simple shapes (a patch, a stain, a bent edge), never as texture.',
    '- Keep the clean, consistent dark outline and the bold value separation that make the silhouette read at 1x.',
    refNote,
  ];
}

/**
 * Generates a high-priority preamble block telling the model that the first N
 * attached reference images are approved seed frames whose identity must be
 * matched exactly, not merely referenced for technique.  Placed at the very top
 * of the sheet prompt so it is the first thing the model reads.
 */
function seedFrameBlock(count: number): string {
  const s = count === 1 ? '' : 's';
  const areIs = count === 1 ? 'is a SEED FRAME' : 'are SEED FRAMES';
  const themIt = count === 1 ? 'it' : 'them';
  return [
    '## Seed frames (HIGHEST PRIORITY — read before all other instructions)',
    `The first ${count} attached reference image${s} ${areIs} — already-approved frame${s} from this exact walk cycle, not general style references.`,
    '',
    `CRITICAL: Your output must be INDISTINGUISHABLE from the seed frame${s} in every visual property: character face and head shape, hair style and colour, outfit and accessory details, colour palette, line weight, cel-shading style, and overall rendering quality. Do NOT introduce any new design detail, colour, or proportion that is absent from the seed frame${s}.`,
    '',
    `Match ${themIt} as your PRIMARY VISUAL REFERENCE for character identity. Treat all other attached images as technique-only style references.`,
  ].join('\n');
}

function typeRulesBlock(brief: Brief): string | null {
  if (brief.type === 'enemy') {
    const { cellW, cellH } = cellDims(brief);
    const { loH, hiH } = sourceFootprint(brief);
    const facing = brief.sensors.enemy?.facing ?? 'three-quarter';
    const facingLine =
      facing === 'front'
        ? '- Draw the mob facing straight forward toward the camera, not angled or in three-quarter view.'
        : facing === 'three-quarter'
          ? '- Draw the mob generally toward the camera at a one-third-to-two-thirds turn. Never use a full side profile.'
          : facing === 'left'
            ? '- Draw the mob camera-facing at a one-third-to-two-thirds turn biased toward the left edge. Never use a full side profile. Keep the pose consistent across every variant on the sheet.'
            : facing === 'right'
              ? '- Draw the mob camera-facing at a one-third-to-two-thirds turn biased toward the right edge. Never use a full side profile. Keep the pose consistent across every variant on the sheet.'
              : '- Keep the mob orientation consistent across every variant on the sheet.';
    const bossLines =
      brief.mobRole === 'boss'
        ? [
            '- **Boss scale:** make the boss substantially taller, wider, or larger in footprint than an ordinary mob. It must fill its large/tall/wide frame and read as visually dominant.',
            '- Give the boss a distinctive threat silhouette and unmistakable visual hierarchy; do not render a normal enemy with extra accessories.',
          ]
        : [];
    const bodyOnlyRule =
      brief.sensors.enemy?.allowSpellMedium === true
        ? '- Keep the sprite body-led and character-centric: no shields, no oversized held weapons, and no detached floating orbs/particle trails. A compact held spell medium and its localized magic glow are allowed when explicitly requested by the brief.'
        : '- Keep the sprite body-only: no held weapons, no shields, no spell effects, no fire, no glow, no floating orbs, and no particle trails.';
    return [
      '## Mob rules',
      ...cartoonFigureRules(brief.seedFrames.length),
      facingLine,
      ...bossLines,
      bodyOnlyRule,
      `- For upright/humanoid mobs, normalize the figure to read as roughly a full ${brief.size.height}px-tall in-game sprite (about ${loH}-${hiH} source pixels tall in a ${cellW}x${cellH} cell). Measure that span from the TOP OF THE BIG HEAD to the soles. Avoid elongated, extra-tall limb/torso stretch.`,
      '- Non-humanoid creatures (slimes, beasts, swarms) keep the same cartoon language: simple bold shapes, flat cel fills, large expressive eyes, no dither grime.',
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
      ...cartoonFigureRules(brief.seedFrames.length),
      '- Keep the character generally camera-facing at a one-third-to-two-thirds turn, with a clear eye line toward camera. Never use a full side profile.',
      `- **Height normalization:** default to a ${brief.size.height}px-tall final character read. In a ${cellW}×${cellH} source cell this is roughly ${loH}-${hiH} source pixels tall (top of head to sole of feet) with small top/bottom breathing room (about ${breatheLo}-${breatheHi} source pixels each). Measure that span from the TOP OF THE BIG HEAD to the soles — do not shrink the body to make room for the head, and do not center a tiny figure in a large empty box.`,
      '- **Hair readability:** hair is a bold simple mass with a clear silhouette (braids/locs/twists/afro shape must read as one deliberate shape). Do not collapse hair into a tiny cap, and do not blend hair into skin or background.',
      '- Avoid drab monochrome outfits. Use high-contrast wardrobe accents from across the available palette (cool + warm hues, not only browns/oranges).',
      '- Ensure hair and skin tones are clearly differentiated from clothing so the silhouette and face stay readable at 1×.',
      '- Preserve practical adventurer styling (functional gear, no ornate royal costume unless explicitly requested).',
    ].join('\n');
  }
  if (brief.type === 'weapon') {
    return [
      '## Weapon rules',
      '- Draw the weapon vertically by default, with the grip at the bottom and business end at the top, unless the brief explicitly requires another orientation.',
    ].join('\n');
  }
  if (brief.type === 'item') {
    return [
      '## Item rules',
      '- Keep the item inanimate. Do not invent eyes, faces, mouths, limbs, expressions, mascot features, or creature anatomy unless the brief explicitly requests them.',
      '- Separate the object, fittings, fabric, and accents with distinct hues or value groups instead of a muddy single-family palette.',
    ].join('\n');
  }
  if (brief.type === 'equipment') {
    return [
      '## Equipment rules',
      '- Draw one isolated wearable or equippable object, centered like an inventory icon.',
      '- Do not include a wearer, mannequin, hands, limbs, room, floor, or environmental scene.',
      '- Keep the equipment inanimate and separate its materials with distinct hues or value groups.',
    ].join('\n');
  }
  if (brief.type === 'prop') {
    return [
      '## Prop rules',
      '- Draw one grounded world-space object with a readable base, top-down perspective, and an appropriate tile footprint.',
      '- Do not present the prop as a floating inventory icon, item card, character, or multi-object scene.',
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
    `- Transparent background, or a single flat high-contrast background color that is clearly distinct from the sprite palette. Prefer ${bg.name} (${bg.hex}). Do NOT use black backgrounds. Do NOT add any ground, cast, contact, or drop shadow beneath or around the subject — it must sit on a clean background with no shadow on the floor (shading and volume on the subject itself are fine). No decorative borders, gradients, or scene elements.`,
    '- No text, numbers, digits, captions, watermarks, signatures, or UI overlays anywhere in the image.',
  ].join('\n');
}

function sheetLayoutBlock(brief: Brief, count: number): string {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  const { cellW, cellH } = cellDims(brief);
  const cellShape =
    cellW === cellH
      ? 'perfectly square'
      : `the same ${aspectRatioText(cellW, cellH)} ${cellW > cellH ? 'landscape' : 'portrait'} rectangle (${cellW}×${cellH} source pixels), matching the sprite proportion`;
  const lines: string[] = [];
  lines.push('## Sheet layout');
  lines.push(
    `Generate exactly ${count} variants on a single sheet, arranged in a regular ${rows}×${cols} grid (${rows} rows, ${cols} columns).`,
  );
  lines.push(
    `Each grid cell must be the same size, ${cellShape}, and the variants must be laid out left-to-right, top-to-bottom in reading order.`,
  );
  if (brief.type !== 'tile') {
    lines.push(
      'Separate every adjacent row and column with a uniform, flat, background-only gutter: a consistent strip of the sheet background color running the full width between rows and the full height between columns, so no two cells touch and a clean background channel divides every neighbouring cell. This gutter is empty background, NOT a drawn line, border, or divider — keep each subject well inside its own cell so nothing bleeds across a gutter into the next cell.',
    );
  }
  if (emptyCells.length > 0) {
    const coords = emptyCells.map(([r, c]) => `(row ${r + 1}, col ${c + 1})`).join(', ');
    lines.push(
      `Leave these cells fully empty (transparent / background only, no subject): ${coords}.`,
    );
  } else {
    lines.push('Every cell must contain exactly one variant — no empty cells.');
  }
  lines.push(brief.frameSequence.enabled ? walkCycleSequenceLine(brief) : variantExplorationLine());
  return lines.join('\n');
}

/**
 * The default (non-sequence) instruction: cells are independent design
 * alternatives of one static sprite, and the model should explore the
 * design space rather than produce near-duplicates.
 */
function variantExplorationLine(): string {
  return 'Treat each cell as a separate exploration of the same subject. VARY along: silhouette proportions, pose within the orientation rule, construction, material distribution, shading direction, and contrasting accent colors. Preserve subject identity, gameplay role, orientation, rendering style, and floor-context intensity. Do not reduce diversity to different shades of one dominant color. If the subject description leaves room for interpretation, cover the design space rather than producing near-duplicates.';
}

/**
 * The frame-sequence instruction: cells are ORDERED FRAMES of ONE walk
 * cycle for the SAME character, not independent design alternatives. This
 * is the opposite intent of `variantExplorationLine` — identity, palette,
 * outfit, and proportions must be held IDENTICAL across every cell, and the
 * only thing allowed to change is the walking pose (limb/leg placement),
 * read in the sheet's reading order (left-to-right, then top-to-bottom row
 * by row) as one continuous stride cycle. Works for any grid shape — a
 * single row (1×N) or a square grid (e.g. 2×2) — since `sheetLayoutBlock`
 * already states the reading order generically; this only needs to spell
 * out the explicit cell→frame-index mapping when there's more than one row,
 * since "reading order" alone is ambiguous about whether row 2 continues
 * the stride or restarts it.
 */
function walkCycleSequenceLine(brief: Brief): string {
  const { frameCount } = brief.frameSequence;
  const { rows, cols } = brief.generation.sheet;
  const rowRanges = Array.from(
    { length: rows },
    (_, r) => `row ${r + 1} left-to-right (frames ${r * cols + 1}..${(r + 1) * cols})`,
  );
  const orderNote =
    rows > 1
      ? ` Cell order follows the grid's reading order: ${rowRanges.join(', then ')} — top-left is frame 1 and bottom-right is frame ${frameCount}.`
      : ' Cells read left-to-right as frames 1 through ' + frameCount + '.';
  return [
    `These ${frameCount} cells are NOT independent design alternatives — they are ORDERED FRAMES of a single side-view walk-cycle animation for the exact same character, forming one continuous walking stride.${orderNote}`,
    'Keep identity strictly IDENTICAL across every frame: the same character, same face/head, same outfit and accessories, same color palette, same body proportions, same overall scale, and the same side-view (profile) orientation and camera angle.',
    'The ONLY thing that may change between frames is the walking pose: leg stride and arm swing progressing smoothly through one gait cycle (for example: left leg forward / neutral mid-stride / right leg forward), so that played back in sequence the character appears to walk in place.',
    "Do not change the character's design, clothing, colors, or size between frames. Do not add or remove props between frames. Do not have the character face a different direction in different frames.",
  ].join('\n');
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
      ? '- Each variant must fit fully within its grid cell — none cut off at any edge. Keep a small but explicit background margin on ALL FOUR sides so hair, feet, and outstretched limbs never touch or cross the cell border and a clean vertical background channel separates every column. Do not fill the horizontal space edge-to-edge: leave the side margins as empty background rather than widening or stretching the subject to fill them.'
      : '- Each variant must fit fully within its grid cell — none cut off at any edge. Leave at least a 10% margin between the subject and the cell edge.',
    aspectOf(brief.size.width, brief.size.height) === 'square'
      ? '- All variants are square, share the same dimensions, and use the same orientation and scale.'
      : `- Every grid cell is the same size; within each cell all subjects share the same ${aspectRatioText(brief.size.width, brief.size.height)} subject proportion, dimensions, orientation, and scale.`,
    '- Do NOT add numbers, labels, captions, watermarks, signatures, borders, dividers, or any text anywhere on the sheet or in any individual cell.',
    `- Use a transparent background, or one flat high-contrast background color that is clearly distinct from the sprite palette, consistently across the whole sheet. Prefer ${bg.name} (${bg.hex}). Do NOT use black backgrounds. Do NOT add any ground, cast, contact, or drop shadow beneath or around any variant — every cell must sit on a clean background with no shadow on the floor (shading and volume on the subject itself are fine). No per-cell background variation, no decorative borders between cells.`,
    '- Do not draw a frame, header, or footer around the grid.',
    ...(brief.frameSequence.enabled
      ? [
          '- REMINDER: these are frames of ONE walk cycle for ONE character — identical identity, outfit, palette, and scale in every cell; only the leg/arm pose progresses between cells.',
        ]
      : []),
  ].join('\n');
}

/**
 * A subject's intended color, resolved either from a color word in the brief
 * prompt or from an explicit per-sprite `palette.colors` entry. We carry the
 * precomputed HSV so the selector can reason about hue families rather than raw
 * RGB distance alone.
 */
interface DominantColor {
  readonly rgb: readonly [number, number, number];
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

/**
 * Curated color-word lexicon mapping natural-language color names — as authors
 * actually write them in briefs (the synth guidance explicitly asks for "the
 * dominant colour by name") — to a representative saturated RGB. Order matters:
 * multi-word phrases come before the bare words they contain so e.g. "sky blue"
 * wins over "blue". Each representative only needs the right HUE; the selector
 * cares about hue family, not the exact shade.
 *
 * Achromatic words (black/white/gray/silver) are deliberately omitted: they
 * carry no hue and must not constrain the background choice.
 */
const COLOR_LEXICON: ReadonlyArray<readonly [RegExp, readonly [number, number, number]]> = [
  // Multi-word phrases first (more specific than the bare words they contain).
  [/\blime green\b/, [150, 210, 40]],
  [/\bforest green\b/, [34, 120, 50]],
  [/\bemerald green\b/, [20, 170, 90]],
  [/\bsky blue\b/, [90, 165, 230]],
  [/\bnavy blue\b/, [20, 30, 110]],
  [/\broyal blue\b/, [40, 70, 200]],
  [/\bdeep purple\b/, [90, 20, 150]],
  [/\bhot pink\b/, [240, 60, 150]],
  [/\bblood red\b/, [150, 15, 20]],
  // Single words.
  [/\bpurple\b/, [140, 40, 175]],
  [/\bviolet\b/, [148, 30, 200]],
  [/\bindigo\b/, [75, 0, 130]],
  [/\blavender\b/, [150, 120, 200]],
  [/\bmagenta\b/, [210, 30, 180]],
  [/\bfuchsia\b/, [220, 40, 170]],
  [/\bpink\b/, [240, 110, 170]],
  [/\bcrimson\b/, [200, 20, 50]],
  [/\bscarlet\b/, [210, 30, 30]],
  [/\bmaroon\b/, [110, 20, 30]],
  [/\bred\b/, [210, 30, 30]],
  [/\borange\b/, [230, 120, 20]],
  [/\bamber\b/, [230, 160, 20]],
  [/\bgold(?:en)?\b/, [220, 180, 40]],
  [/\byellow\b/, [235, 215, 30]],
  [/\bolive\b/, [120, 130, 30]],
  [/\blime\b/, [150, 210, 40]],
  [/\bemerald\b/, [20, 170, 90]],
  [/\bgreen\b/, [40, 160, 55]],
  [/\bteal\b/, [20, 150, 140]],
  [/\bturquoise\b/, [40, 200, 190]],
  [/\baqua\b/, [40, 200, 200]],
  [/\bcyan\b/, [30, 200, 210]],
  [/\bazure\b/, [60, 140, 230]],
  [/\bnavy\b/, [20, 30, 110]],
  [/\bcobalt\b/, [40, 70, 200]],
  [/\bblue\b/, [40, 90, 200]],
  [/\bbronze\b/, [150, 90, 40]],
  [/\bcopper\b/, [180, 95, 50]],
  [/\bbrown\b/, [120, 70, 35]],
];

/** Below this saturation (or value) a color has no reliable hue to contrast. */
const ACHROMATIC_SATURATION = 0.2;
const ACHROMATIC_VALUE = 0.12;
/** Hue scores within this many degrees are treated as a tie (RGB breaks it). */
const HUE_TIE_EPSILON_DEG = 1;

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

/** Smallest angular distance between two hues, in [0, 180] degrees. */
function hueDistanceDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function toDominantColor(rgb: readonly [number, number, number]): DominantColor {
  const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return { rgb, h, s, v };
}

function isChromatic(color: DominantColor): boolean {
  return color.s >= ACHROMATIC_SATURATION && color.v >= ACHROMATIC_VALUE;
}

/**
 * Extract the intended subject colors named in a brief prompt. Returns one
 * representative RGB per matched color word (deduped by representative). Pure
 * and exported so the selection logic can be unit-tested directly.
 */
export function extractPromptColors(prompt: string): Array<readonly [number, number, number]> {
  const text = prompt.toLowerCase();
  const found: Array<readonly [number, number, number]> = [];
  const seen = new Set<string>();
  for (const [pattern, rgb] of COLOR_LEXICON) {
    if (pattern.test(text)) {
      const key = rgb.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        found.push(rgb);
      }
    }
  }
  return found;
}

function minRgbDistanceSq(
  rgb: readonly [number, number, number],
  colors: ReadonlyArray<readonly [number, number, number]>,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const [r, g, b] of colors) {
    const dr = rgb[0] - r;
    const dg = rgb[1] - g;
    const db = rgb[2] - b;
    min = Math.min(min, dr * dr + dg * dg + db * db);
  }
  return min;
}

/**
 * Choose the flat background color to request in the generation prompt.
 *
 * Background removal in post-processing is a corner flood-fill keyed on color
 * similarity, so the background must read as a DIFFERENT color family from the
 * sprite — not merely numerically far in RGB. Bright magenta is "far" from a
 * dark purple in raw RGB yet shares its hue family, which is exactly what made
 * a purple slime's background hard to key out. We therefore:
 *
 *   1. Collect the sprite's intended dominant colors — color words named in the
 *      brief prompt plus any explicit per-sprite `palette.colors`.
 *   2. Pick the candidate that maximizes the MINIMUM hue distance to those
 *      colors (so it cannot sit in the same family as any of them), using the
 *      minimum RGB distance only as a tiebreak.
 *
 * Falls back to the previous RGB-maximin behavior when there is no usable hue
 * signal (e.g. a grayscale subject with an explicit palette), and to the first
 * candidate (bright magenta) when there is no color information at all.
 */
export function pickContrastingBackgroundColor(brief: Brief): BackgroundCandidate {
  const explicit = (brief.palette.colors ?? []).map(toDominantColor);
  const fromPrompt = extractPromptColors(brief.prompt).map(toDominantColor);
  const dominant = [...fromPrompt, ...explicit];
  const chromatic = dominant.filter(isChromatic);

  if (chromatic.length > 0) {
    return pickByHueDistance(chromatic, dominant);
  }

  // No reliable hue signal. Preserve the original behavior: maximize the
  // minimum RGB distance to any explicit palette color, or default to the
  // first candidate when the brief carries no color information at all.
  const paletteColors = brief.palette.colors ?? [];
  if (paletteColors.length === 0) {
    return BACKGROUND_CANDIDATES[0]!;
  }
  return pickByRgbDistance(paletteColors);
}

function pickByHueDistance(
  chromatic: ReadonlyArray<DominantColor>,
  allDominant: ReadonlyArray<DominantColor>,
): BackgroundCandidate {
  const dominantRgb = allDominant.map((c) => c.rgb);
  let best = BACKGROUND_CANDIDATES[0]!;
  let bestHue = -1;
  let bestRgb = -1;
  for (const candidate of BACKGROUND_CANDIDATES) {
    const candidateHue = rgbToHsv(candidate.rgb[0], candidate.rgb[1], candidate.rgb[2]).h;
    let hueScore = Number.POSITIVE_INFINITY;
    for (const color of chromatic) {
      hueScore = Math.min(hueScore, hueDistanceDeg(candidateHue, color.h));
    }
    const rgbScore = minRgbDistanceSq(candidate.rgb, dominantRgb);
    const better =
      hueScore > bestHue + HUE_TIE_EPSILON_DEG ||
      (Math.abs(hueScore - bestHue) <= HUE_TIE_EPSILON_DEG && rgbScore > bestRgb);
    if (better) {
      best = candidate;
      bestHue = hueScore;
      bestRgb = rgbScore;
    }
  }
  return best;
}

function pickByRgbDistance(
  paletteColors: ReadonlyArray<readonly [number, number, number]>,
): BackgroundCandidate {
  let best = BACKGROUND_CANDIDATES[0]!;
  let bestMinDistance = -1;
  for (const candidate of BACKGROUND_CANDIDATES) {
    const minDistance = minRgbDistanceSq(candidate.rgb, paletteColors);
    if (minDistance > bestMinDistance) {
      bestMinDistance = minDistance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Build a prompt for an icon-batch sheet — a sheet where each cell is a
 * DIFFERENT icon concept, not a variant of one subject.
 *
 * Used for achievement icons, ability icons, and other UI icon families.
 * Each `iconBatch` entry describes one cell by concept name and optional
 * visual description.
 */
export function buildIconBatchSheetPrompt(brief: Brief, styleGuide: string): string {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  const { cellW, cellH } = cellDims(brief);
  const count = brief.iconBatch!.length;
  const bg = pickContrastingBackgroundColor(brief);
  const emptyCellKey = new Set(emptyCells.map(([r, c]) => `${r},${c}`));
  const filledCells: Array<readonly [number, number]> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!emptyCellKey.has(`${row},${col}`)) {
        filledCells.push([row, col]);
      }
    }
  }

  const cellListLines: string[] = ['## Cell assignments (left-to-right, top-to-bottom)'];
  for (let i = 0; i < count; i++) {
    const [rowZero, colZero] = filledCells[i] ?? [Math.floor(i / cols), i % cols];
    const row = rowZero + 1;
    const col = colZero + 1;
    const entry = brief.iconBatch![i]!;
    const desc = entry.description ? ` — ${entry.description}` : '';
    cellListLines.push(`- Cell ${i + 1} (row ${row}, col ${col}): **${entry.concept}**${desc}`);
  }
  const emptyCellLine =
    emptyCells.length === 0
      ? 'Every cell must contain exactly one icon — no empty cells.'
      : `Leave these cells fully empty (transparent/background only, no icon): ${emptyCells
          .map(([r, c]) => `(row ${r + 1}, col ${c + 1})`)
          .join(', ')}.`;

  return [
    styleGuide,
    '',
    floorContextBlock(brief.floor),
    '',
    '## Subject',
    brief.prompt.trim(),
    '',
    '## Output size',
    `- Each finished icon resolves to exactly ${brief.size.width}x${brief.size.height} pixels after post-processing.`,
    `- Draw each icon at a 1:1 (square) proportion, centered within its square ${cellW}x${cellH} source cell.`,
    '',
    '## Sheet layout',
    `Generate exactly ${count} distinct icons on a single sheet, arranged in a ${rows}×${cols} grid (${rows} rows, ${cols} columns).`,
    `Each grid cell must be the same size (${cellW}×${cellH} source pixels) and icons must be laid out left-to-right, top-to-bottom in reading order.`,
    'Separate every adjacent row and column with a uniform, flat, background-only gutter — a consistent strip of the sheet background running the full width/height between cells so no two cells touch.',
    emptyCellLine,
    '',
    ...cellListLines,
    '',
    '## Icon rules',
    '- Each icon is a clear pixel-art symbol recognizable at small sizes. Think inventory/achievement icons from classic RPGs.',
    '- Icons should be bold, readable symbols — not detailed scenes or full character art.',
    '- Do NOT include any frame, border, rounded-corner border, or UI chrome baked into the icon. The frame is composited separately.',
    '- Each icon should express its own concept clearly. Do NOT reuse compositions across cells; each must be visually distinct.',
    '',
    '## Per-variant requirements (apply to every cell)',
    '- Each icon must fit fully within its grid cell — none cut off at any edge. Leave at least a 10% margin between the icon and the cell edge.',
    '- All icons are square, share the same dimensions, and use the same scale.',
    '- Do NOT add numbers, labels, captions, watermarks, signatures, borders, dividers, or any text anywhere on the sheet or in any individual cell.',
    `- Transparent background, or one flat high-contrast background color consistently across the whole sheet. Prefer ${bg.name} (${bg.hex}). Do NOT use black backgrounds. No drop shadow on the floor (shading and volume on the icon itself are fine). No per-cell background variation. No decorative borders between cells.`,
    '- Do not draw a frame, header, or footer around the grid.',
  ].join('\n');
}
