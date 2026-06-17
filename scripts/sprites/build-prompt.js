import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
export function loadStyleGuide(repoRoot, read = (p) => readFileSync(p, 'utf8')) {
  const path = resolve(repoRoot, STYLE_GUIDE_RELATIVE_PATH);
  const md = read(path);
  return extractPreamble(md);
}
export function extractPreamble(markdown) {
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
export function buildPrompt(brief, styleGuide) {
  const rules = typeRulesBlock(brief);
  return [
    styleGuide,
    '',
    briefSubjectBlock(brief),
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
export function buildSheetPrompt(brief, styleGuide, variants) {
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
    ...(rules ? ['', rules] : []),
    '',
    sheetLayoutBlock(rows, cols, count, emptyCells),
    ...(variationsBlock ? ['', variationsBlock] : []),
    '',
    sheetConstraintsBlock(brief),
  ].join('\n');
}
function briefSubjectBlock(brief) {
  // Tags are intentionally NOT emitted into the prompt: they're an
  // internal taxonomy used downstream (filtering briefs, grouping
  // generations) and the model handles natural-language descriptions
  // better than comma-separated keywords. Authors should put any
  // visual detail in the description / prompt itself.
  return ['## Subject', brief.prompt.trim()].join('\n');
}
function typeRulesBlock(brief) {
  if (brief.type === 'enemy') {
    return [
      '## Mob rules',
      '- Draw the mob facing straight forward, not angled or in three-quarter view.',
      '- Keep the sprite body-only: no held weapons, no shields, no spell effects, no fire, no glow, no floating orbs, and no particle trails.',
      '- For upright/humanoid mobs, normalize the figure to read as roughly a full 64px-tall in-game sprite (about 224-240 source pixels in a 256x256 cell) while keeping natural proportions. Avoid elongated, extra-tall limb/torso stretch.',
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
    return [
      '## Character rules',
      '- Keep the character front-facing with readable facial features and clear eye line toward camera.',
      `- **Height normalization:** default to a 64px-tall final character read. In a 256×256 source cell this is roughly 224-240 source pixels tall (top of head to sole of feet) with small top/bottom breathing room (about 8-16 source pixels each). Keep proportions natural; do NOT stretch the body vertically to chase height, and do NOT center a tiny figure in a large empty box.`,
      '- **Facial detail:** face must have individually readable eyes (pupils, whites), a nose bridge, and a closed or slightly open mouth — each feature rendered with multiple source pixels (4-pixel = 1 output pixel scale). No smeared blobs for a face.',
      '- **Hair readability:** preserve visible hair mass and hairline shape (braids/locs/twists/afro silhouette must be explicit). Do not collapse hair into a tiny cap, and do not blend hair into skin or background.',
      '- **Contrast control:** prioritize strong dark outlines and clear light-vs-dark separation on face, hair, and outfit seams. Keep 3–5 readable tone steps (base/shadow/deep shadow/highlight) and avoid both muddy mid-tone clusters and overly flat 2-tone blocks.',
      '- Avoid drab monochrome outfits. Use high-contrast wardrobe accents from across the available palette (cool + warm hues, not only browns/oranges).',
      '- Ensure hair and skin tones are clearly differentiated from clothing so the silhouette and face stay readable at 1×.',
      '- Preserve practical adventurer styling (functional gear, no ornate royal costume unless explicitly requested).',
    ].join('\n');
  }
  return null;
}
function singleConstraintsBlock(brief) {
  if (brief.type === 'tile') {
    return [
      '## Output requirements',
      '- Exactly one full tile variant in a square frame.',
      '- Fill the frame edge-to-edge with seamless tiling continuity across opposite edges.',
      `- Final output must resolve to exactly ${brief.size.width}x${brief.size.height} pixels after post-processing.`,
      '- No text, numbers, digits, captions, watermarks, signatures, or UI overlays anywhere in the image.',
    ].join('\n');
  }
  return [
    '## Output requirements',
    '- Exactly one subject, centered in a square frame.',
    '- Subject must not be clipped at any edge — leave at least 10% margin on all sides.',
    '- Transparent background or solid neutral fill (pure white, pure black, or pure magenta). No decorative borders, gradients, or scene elements.',
    '- No text, numbers, digits, captions, watermarks, signatures, or UI overlays anywhere in the image.',
  ].join('\n');
}
function sheetLayoutBlock(rows, cols, count, emptyCells) {
  const lines = [];
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
function thematicVariationsBlock(variations) {
  if (variations.length === 0) return null;
  const bullets = variations.map((v) => `- ${v.trim()}`).join('\n');
  return [
    '## Thematic variations',
    "The subject's core identity must stay intact (silhouette, palette, orientation, and overall composition unchanged). Distribute the following on-theme embellishments across the cells. Most cells should incorporate exactly ONE of these variations; a few cells should remain baseline (no extra embellishment). Do not combine multiple embellishments in the same cell. Do not invent variations outside this list.",
    bullets,
  ].join('\n');
}
function sheetConstraintsBlock(brief) {
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
  return [
    '## Per-variant requirements (apply to every cell)',
    brief.type === 'character' || brief.type === 'enemy'
      ? '- Each variant must fit fully within its grid cell — none cut off at any edge. Keep a small but explicit top/bottom margin so hair and feet never touch or cross the cell border. Horizontal side margins are acceptable.'
      : '- Each variant must fit fully within its grid cell — none cut off at any edge. Leave at least a 10% margin between the subject and the cell edge.',
    '- All variants are square, share the same dimensions, and use the same orientation and scale.',
    '- Do NOT add numbers, labels, captions, watermarks, signatures, borders, dividers, or any text anywhere on the sheet or in any individual cell.',
    '- Use a transparent background, or a single flat neutral background color (pure white, pure black, or pure magenta) consistently across the whole sheet. No per-cell background variation, no decorative borders between cells.',
    '- Do not draw a frame, header, or footer around the grid.',
  ].join('\n');
}
//# sourceMappingURL=build-prompt.js.map
