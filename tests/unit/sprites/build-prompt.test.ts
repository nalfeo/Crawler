/**
 * Unit tests for the prompt builder.
 *
 * The builder is pure given a `(brief, styleGuide)` pair. We synthesise a
 * small fake style guide and a minimal brief and assert that all the hard
 * constraints the user explicitly called out last session appear verbatim
 * in the prompt — these are what stop the model from emitting numbered
 * cells, partial sprites, decorative borders, etc.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  buildSheetPrompt,
  extractPreamble,
  pickContrastingBackgroundColor,
} from '../../../scripts/sprites/build-prompt.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';
import { briefSchema } from '../../../scripts/sprites/brief-schema.js';

const FAKE_STYLE_GUIDE =
  '--- STYLE PREAMBLE (do not deviate) ---\nFAKE_PREAMBLE_MARKER\n--- END STYLE PREAMBLE ---';

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'iron-sword',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 14 },
    tags: ['sword', 'melee'],
    prompt: 'An iron sword, pixel-art style, blade up-right.',
    references: [
      { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' },
      { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' },
    ],
    ...overrides,
  });
}

describe('extractPreamble', () => {
  it('returns the text between the markers, with blockquote prefixes stripped', () => {
    const md = [
      '# Style guide',
      '',
      'Some prose.',
      '',
      '> --- STYLE PREAMBLE (do not deviate) ---',
      '>',
      '> Rule 1: no text.',
      '> Rule 2: square.',
      '>',
      '> --- END STYLE PREAMBLE ---',
      '',
      '## After',
      'More prose.',
    ].join('\n');
    const preamble = extractPreamble(md);
    expect(preamble).toContain('Rule 1: no text.');
    expect(preamble).toContain('Rule 2: square.');
    expect(preamble).not.toContain('Some prose');
    expect(preamble).not.toContain('More prose');
    expect(preamble).not.toMatch(/^>/m);
  });

  it('throws if the markers are missing', () => {
    expect(() => extractPreamble('# Style guide\nNo markers here.')).toThrow(/preamble markers/);
  });
});

describe('buildPrompt (single)', () => {
  it('starts with the style guide and includes the subject', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out.startsWith(FAKE_STYLE_GUIDE)).toBe(true);
    expect(out).toContain('FAKE_PREAMBLE_MARKER');
    expect(out).toContain('An iron sword');
  });

  it('adds mob rules for enemy briefs', () => {
    const enemy = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        enemy: { facing: 'front' },
        anchor: { mode: 'center-of-mass' },
      } as Brief['sensors'],
    });

    const out = buildPrompt(enemy, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Mob rules/i);
    expect(out).toMatch(/straight forward/i);
    expect(out).toMatch(/no held weapons/i);
    expect(out).toMatch(/no shields/i);
    expect(out).toMatch(/no spell effects/i);
  });

  it('adds tile rules for tile briefs including exact output size', () => {
    const tile = makeBrief({
      type: 'tile',
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 63 },
    });
    const out = buildPrompt(tile, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Tile rules/i);
    expect(out).toMatch(/tileable background tile/i);
    expect(out).toMatch(/exactly 64x64 pixels/i);
    expect(out).toMatch(/seamlessly in both axes/i);
  });

  it('adds character rules encouraging non-drab clothing and readable tones', () => {
    const character = makeBrief({
      type: 'character',
      anchor: { x: 8, y: 8 },
      sensors: { enemy: { facing: 'front' } } as Brief['sensors'],
    });
    const out = buildPrompt(character, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Character rules/i);
    expect(out).toMatch(/Avoid drab monochrome outfits/i);
    expect(out).toMatch(/not only browns\/oranges/i);
    expect(out).toMatch(/hair and skin tones are clearly differentiated/i);
  });

  it('includes per-variant constraints (no clipping, no text, high-contrast bg)', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/margin/i);
    expect(out).toMatch(/no text|no.*numbers/i);
    expect(out).toMatch(/transparent|high-contrast/i);
    expect(out).toMatch(/Do NOT use black backgrounds/i);
    expect(out).toMatch(/shadows must be neutral\/dark/i);
    expect(out).toMatch(/must NOT be in the same color family as the background/i);
  });
});

describe('buildSheetPrompt', () => {
  it('starts with the style preamble (hard constraint)', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out.startsWith(FAKE_STYLE_GUIDE)).toBe(true);
  });

  it('asks for exactly the right variant count and grid shape', () => {
    const brief = makeBrief();
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    // Default sheet is 4x4 = 16 variants.
    expect(out).toMatch(/exactly 16 variants/i);
    expect(out).toMatch(/4×4|4x4/);
    expect(out).toMatch(/4 rows.*4 columns/i);
  });

  it('honors a custom override for variant count', () => {
    const brief = makeBrief();
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE, 4);
    expect(out).toMatch(/exactly 4 variants/i);
  });

  it('honors a non-default grid (4x2 = 8)', () => {
    const brief = makeBrief({
      generation: { sheet: { rows: 4, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
    } as Partial<Brief>);
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/exactly 8 variants/i);
    expect(out).toMatch(/4 rows.*2 columns/i);
  });

  it('communicates empty cells with 1-based human-friendly coordinates', () => {
    const brief = makeBrief({
      generation: {
        sheet: {
          rows: 4,
          cols: 4,
          // [row, col] tuples, 0-based. Output should be 1-based for humans/model.
          emptyCells: [[0, 0]] as ReadonlyArray<readonly [number, number]>,
          nativeCanvas: 1024,
        },
      },
    } as Partial<Brief>);
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/exactly 15 variants/i);
    expect(out).toMatch(/row 1.*col 1/);
  });

  it('says "no empty cells" when none are declared', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/no empty cells/i);
  });

  it('includes every hard constraint the spec calls out', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    // The "do not clip" rule the user repeatedly emphasised.
    expect(out).toMatch(/none cut off|fit fully within/i);
    expect(out).toMatch(/at least.*10%.*margin/i);
    // No-text constraint.
    expect(out).toMatch(/NOT add.*numbers/);
    expect(out).toMatch(/labels|captions/);
    expect(out).toMatch(/watermarks/);
    // Square, same dimensions.
    expect(out).toMatch(/square/i);
    expect(out).toMatch(/same dimensions/i);
    // Background rule.
    expect(out).toMatch(/transparent.*background|high-contrast background/i);
    expect(out).toMatch(/Do NOT use black backgrounds/i);
    expect(out).toMatch(/shadows must be neutral\/dark/i);
    expect(out).toMatch(/must NOT be in the same color family as the background/i);
    // No decorative borders.
    expect(out).toMatch(/no.*decorative|no.*borders|no per-cell/i);
  });

  it('puts subject info between preamble and layout instructions', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    const preambleEnd = out.indexOf(FAKE_STYLE_GUIDE) + FAKE_STYLE_GUIDE.length;
    const subjectIdx = out.indexOf('An iron sword');
    const layoutIdx = out.indexOf('Sheet layout');
    expect(subjectIdx).toBeGreaterThan(preambleEnd);
    expect(layoutIdx).toBeGreaterThan(subjectIdx);
  });

  it('adds mob rules to enemy sheet prompts', () => {
    const enemy = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        enemy: { facing: 'front' },
        anchor: { mode: 'center-of-mass' },
      } as Brief['sensors'],
    });
    const out = buildSheetPrompt(enemy, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Mob rules/i);
    expect(out).toMatch(/centered around the body mass/i);
  });

  it('adds tile-specific sheet constraints for seamless edge-to-edge tiles', () => {
    const tile = makeBrief({
      type: 'tile',
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 63 },
    });
    const out = buildSheetPrompt(tile, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Tile rules/i);
    expect(out).toMatch(/exactly 64x64 pixels/i);
    expect(out).toMatch(/no transparent padding and no subject margin/i);
    expect(out).toMatch(/seamless tiling continuity/i);
  });

  it('adds character rules to character sheet prompts', () => {
    const character = makeBrief({
      type: 'character',
      anchor: { x: 8, y: 8 },
      sensors: { enemy: { facing: 'front' } } as Brief['sensors'],
    });
    const out = buildSheetPrompt(character, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Character rules/i);
    expect(out).toMatch(/Avoid drab monochrome outfits/i);
  });
});

describe('buildSheetPrompt — thematic variations', () => {
  it('omits the variations block entirely when none are declared', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).not.toMatch(/## Thematic variations/);
    expect(out).not.toMatch(/on-theme embellishments/);
  });

  describe('pickContrastingBackgroundColor', () => {
    it('defaults to bright magenta when the brief palette has no inline colors', () => {
      const out = pickContrastingBackgroundColor(makeBrief());
      expect(out.name).toBe('bright magenta');
      expect(out.hex).toBe('#ff00ff');
    });

    it('avoids magenta for red-heavy palettes by choosing a farther color', () => {
      const brief = makeBrief({
        palette: {
          id: 'kenney-roguelike',
          colors: [
            [210, 25, 25],
            [170, 40, 40],
            [120, 20, 20],
          ],
        },
      } as Partial<Brief>);
      const out = pickContrastingBackgroundColor(brief);
      expect(out.name).not.toBe('bright magenta');
      expect(out.hex).not.toBe('#ff00ff');
    });
  });

  it('emits the variations block with bullets in declared order', () => {
    const brief = makeBrief({
      variations: ['spiked pommel', 'wolf skull', 'rune-etched band'],
    } as Partial<Brief>);
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/## Thematic variations/);
    // The hard rails that stop the model from inventing or stacking variations.
    expect(out).toMatch(/Do not combine/i);
    expect(out).toMatch(/Do not invent variations outside this list/i);
    expect(out).toMatch(/Most cells.*ONE.*variations/);
    // Bullets in declared order, each prefixed with "- ".
    const spikedIdx = out.indexOf('- spiked pommel');
    const wolfIdx = out.indexOf('- wolf skull');
    const runeIdx = out.indexOf('- rune-etched band');
    expect(spikedIdx).toBeGreaterThan(-1);
    expect(wolfIdx).toBeGreaterThan(spikedIdx);
    expect(runeIdx).toBeGreaterThan(wolfIdx);
  });

  it('places the variations block between the layout block and the per-variant constraints', () => {
    const brief = makeBrief({ variations: ['spiked pommel'] } as Partial<Brief>);
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    const layoutIdx = out.indexOf('## Sheet layout');
    const variationsIdx = out.indexOf('## Thematic variations');
    const constraintsIdx = out.indexOf('## Per-variant requirements');
    expect(layoutIdx).toBeGreaterThan(-1);
    expect(variationsIdx).toBeGreaterThan(layoutIdx);
    expect(constraintsIdx).toBeGreaterThan(variationsIdx);
  });

  it('does not emit the variations block in single-image (non-sheet) mode', () => {
    // Single mode generates one image, so "distribute across cells" is
    // semantically meaningless — the block must stay out of buildPrompt.
    const brief = makeBrief({ variations: ['spiked pommel'] } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).not.toMatch(/## Thematic variations/);
  });
});

describe('output size block', () => {
  const sheet2048 = { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 2048 } };

  it('describes the default square subject without a footprint band', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toContain('## Output size');
    expect(out).toContain('Each finished sprite resolves to exactly 16x16 pixels');
    expect(out).toContain(
      'Draw each subject at a 1:1 (square) proportion, centered within its square 256x256 source cell.',
    );
    // The square branch must not emit a stretched footprint band.
    expect(out).not.toMatch(/source pixels wide and/);
  });

  it('describes a wide subject with a landscape proportion and footprint', () => {
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 128, height: 64 },
      generation: sheet2048,
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain('Each finished sprite resolves to exactly 128x64 pixels');
    expect(out).toContain('landscape (wider than tall) at a 2:1 aspect ratio');
    expect(out).toContain('span roughly 448-480 source pixels wide and 224-240 source pixels tall');
    expect(out).toContain('square 512x512 source cell');
  });

  it('describes a tall subject with a portrait proportion and footprint', () => {
    const brief = makeBrief({
      type: 'character',
      size: { width: 64, height: 128 },
      anchor: { x: 32, y: 126 },
      generation: sheet2048,
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain('Each finished sprite resolves to exactly 64x128 pixels');
    expect(out).toContain('portrait (taller than wide) at a 1:2 aspect ratio');
    expect(out).toContain('span roughly 224-240 source pixels wide and 448-480 source pixels tall');
  });

  it('treats a large (2x2) subject as square at the scaled cell size', () => {
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 128, height: 128 },
      generation: sheet2048,
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain('Each finished sprite resolves to exactly 128x128 pixels');
    expect(out).toContain(
      'Draw each subject at a 1:1 (square) proportion, centered within its square 512x512 source cell.',
    );
  });

  it('tells tiles to fill a non-square frame edge-to-edge', () => {
    const brief = makeBrief({
      type: 'tile',
      size: { width: 128, height: 64 },
      generation: sheet2048,
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'The tile frame is landscape (128x64, 2:1); fill it edge-to-edge across both axes',
    );
    // Tiles use the footprint-free variant.
    expect(out).not.toMatch(/source pixels wide and/);
  });

  it('keeps a square tile description simple', () => {
    const brief = makeBrief({ type: 'tile', size: { width: 32, height: 32 } } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain('The tile frame is square (32x32); fill it edge-to-edge.');
  });
});

describe('type rules scale with the brief size', () => {
  const sheet2048 = { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 2048 } };

  it('quotes the default 64px enemy band in a 256x256 cell', () => {
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 32 },
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'roughly a full 64px-tall in-game sprite (about 224-240 source pixels tall in a 256x256 cell)',
    );
  });

  it('scales the enemy band for a tall variant', () => {
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 64, height: 128 },
      anchor: { x: 32, y: 64 },
      generation: sheet2048,
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'roughly a full 128px-tall in-game sprite (about 448-480 source pixels tall in a 512x512 cell)',
    );
  });
});
