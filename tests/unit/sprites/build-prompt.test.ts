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
  extractPromptColors,
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
    expect(out).toContain('FLOOR: 1 of 20');
  });

  it('adds the shocking/wonderful apex guidance for floor 20', () => {
    const out = buildPrompt(makeBrief({ floor: 20 }), FAKE_STYLE_GUIDE);
    expect(out).toContain('FLOOR: 20 of 20');
    expect(out).toMatch(/shocking\/wonderful apex/i);
  });

  it('includes an authored theme design language for floor 1 equipment', () => {
    const out = buildPrompt(
      makeBrief({
        type: 'equipment',
        theme: {
          setId: 'classic-fantasy',
          displayName: 'Classic Fantasy',
          designLanguage:
            'Practical late-medieval steel, leather, wool, and carved hardwood with restrained heraldry.',
        },
      }),
      FAKE_STYLE_GUIDE,
    );

    expect(out).toContain('## Theme design language');
    expect(out).toContain('Practical late-medieval steel');
  });

  it('keeps item briefs explicitly inanimate', () => {
    const out = buildPrompt(makeBrief({ type: 'item' }), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Keep the item inanimate/i);
    expect(out).toMatch(/Do not invent eyes, faces, mouths, limbs/i);
  });

  it('frames weapon orientation as a default that explicit briefs can override', () => {
    const out = buildPrompt(
      makeBrief({ prompt: 'A horizontal double-ended wrench weapon.' }),
      FAKE_STYLE_GUIDE,
    );
    expect(out).toMatch(/vertically by default/i);
    expect(out).toMatch(/unless the brief explicitly requires another orientation/i);
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

  it('allows a compact held spell medium for caster enemy briefs that opt in', () => {
    const enemy = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: {
        enemy: { allowSpellMedium: true },
      } as Brief['sensors'],
    });

    const out = buildPrompt(enemy, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/held spell medium/i);
    expect(out).toMatch(/localized magic glow are allowed/i);
    expect(out).not.toMatch(/no held weapons/i);
    expect(out).not.toMatch(/no spell effects/i);
  });

  it('defaults enemy briefs to a camera-facing three-quarter pose when facing is omitted', () => {
    const enemy = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: { anchor: { mode: 'center-of-mass' } } as Brief['sensors'],
    });
    const out = buildPrompt(enemy, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/one-third-to-two-thirds turn/i);
    expect(out).toMatch(/Never use a full side profile/i);
  });

  it('honors an explicit left bias without allowing a full side profile', () => {
    const enemy = makeBrief({
      type: 'enemy',
      anchor: { x: 8, y: 8 },
      sensors: { enemy: { facing: 'left' } } as Brief['sensors'],
    });
    const out = buildPrompt(enemy, FAKE_STYLE_GUIDE);
    expect(out).toMatch(/turn biased toward the left edge/i);
    expect(out).toMatch(/Never use a full side profile/i);
  });

  it('makes boss enemies large and visually dominant', () => {
    const out = buildPrompt(
      makeBrief({
        type: 'enemy',
        mobRole: 'boss',
        size: { width: 64, height: 48 },
        anchor: { x: 32, y: 47 },
      }),
      FAKE_STYLE_GUIDE,
    );
    expect(out).toMatch(/Boss scale/i);
    expect(out).toMatch(/substantially taller, wider, or larger in footprint/i);
    expect(out).toMatch(/visually dominant/i);
  });

  it('presents equipment as an isolated wearable icon', () => {
    const out = buildPrompt(makeBrief({ type: 'equipment' }), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Equipment rules/i);
    expect(out).toMatch(/one isolated wearable or equippable object/i);
    expect(out).toMatch(/Do not include a wearer/i);
  });

  it('presents props as grounded world-space objects rather than inventory icons', () => {
    const out = buildPrompt(makeBrief({ type: 'prop' }), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Prop rules/i);
    expect(out).toMatch(/grounded world-space object/i);
    expect(out).toMatch(/Do not present the prop as a floating inventory icon/i);
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
    expect(out).toMatch(/one-third-to-two-thirds turn/i);
    expect(out).toMatch(/Never use a full side profile/i);
  });

  it('includes per-variant constraints (no clipping, no text, high-contrast bg)', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/margin/i);
    expect(out).toMatch(/no text|no.*numbers/i);
    expect(out).toMatch(/transparent|high-contrast/i);
    expect(out).toMatch(/Do NOT use black backgrounds/i);
    expect(out).toMatch(/Do NOT add any ground, cast, contact, or drop shadow/i);
    expect(out).toMatch(/no shadow on the floor/i);
  });

  it('forbids ground shadows on the single-sprite path and drops the old cast-shadow coloring rule', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Do NOT add any ground, cast, contact, or drop shadow/i);
    // Volume/form shading on the subject itself stays allowed.
    expect(out).toMatch(/shading and volume on the subject itself are fine/i);
    // The previous wording told the model how to color cast shadows — it is gone.
    expect(out).not.toMatch(/shadows must be neutral\/dark/i);
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
    expect(out).toMatch(/Do NOT add any ground, cast, contact, or drop shadow/i);
    expect(out).toMatch(/no shadow on the floor/i);
    // No decorative borders.
    expect(out).toMatch(/no.*decorative|no.*borders|no per-cell/i);
  });

  it('forbids ground shadows on the sheet path and drops the old cast-shadow coloring rule', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Do NOT add any ground, cast, contact, or drop shadow/i);
    expect(out).toMatch(/shading and volume on the subject itself are fine/i);
    expect(out).not.toMatch(/shadows must be neutral\/dark/i);
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

describe('buildSheetPrompt — Bug B inter-cell gutters', () => {
  // The incident's root cause: the old character/enemy prompt said "Horizontal
  // side margins are acceptable", so adjacent columns could touch and the
  // content-aware slicer merged 4 columns into 2 (16 → 8). The fix requires a
  // background gutter between every row AND column so the slicer recovers the
  // full grid, while keeping the honest 16-variant target.
  it('requires a background gutter between every row and column on a character sheet', () => {
    const character = makeBrief({
      type: 'character',
      anchor: { x: 8, y: 8 },
      sensors: { enemy: { facing: 'front' } } as Brief['sensors'],
    });
    const out = buildSheetPrompt(character, FAKE_STYLE_GUIDE);
    // New mandatory gutter language is present…
    expect(out).toMatch(/Separate every adjacent row and column/i);
    expect(out).toMatch(/background-only gutter/i);
    expect(out).toMatch(/background margin on ALL FOUR sides/i);
    // …and the permissive wording that allowed touching columns is gone.
    expect(out).not.toMatch(/Horizontal side margins are acceptable/i);
    // The honest target is unchanged: still 16 variants on a 4×4 grid.
    expect(out).toMatch(/exactly 16 variants/i);
    expect(out).toMatch(/4 rows.*4 columns/i);
  });

  it('keeps the inter-cell gutter and the 10% margin for weapon/item sheets', () => {
    const out = buildSheetPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/Separate every adjacent row and column/i);
    expect(out).toMatch(/at least.*10%.*margin/i);
  });

  it('does NOT add an inter-cell gutter to tile sheets (tiles need seamless edges)', () => {
    const tile = makeBrief({
      type: 'tile',
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 63 },
    });
    const out = buildSheetPrompt(tile, FAKE_STYLE_GUIDE);
    expect(out).not.toMatch(/background-only gutter/i);
    expect(out).toMatch(/seamless tiling continuity/i);
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

  it('describes a wide subject in an aspect-matched landscape cell', () => {
    // wide reshapes the grid to 4 rows × 2 cols on a fixed 1024 canvas → 512×256.
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 128, height: 64 },
      generation: { sheet: { rows: 4, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'Target final frame is 128x64 with width as the main occupancy axis; post-processing may expand height beyond 64px to preserve silhouette fill.',
    );
    expect(out).toContain('landscape (wider than tall) at a 2:1 aspect ratio');
    expect(out).toContain('span roughly 448-480 source pixels wide and 224-240 source pixels tall');
    expect(out).toContain('Within each 512x256 source cell');
    // The cell is no longer square — the wording must not call it square.
    expect(out).not.toContain('square 512x256');
  });

  it('describes a tall subject in an aspect-matched portrait cell', () => {
    // tall reshapes the grid to 2 rows × 4 cols → 256×512 cells.
    const brief = makeBrief({
      type: 'character',
      size: { width: 64, height: 128 },
      anchor: { x: 32, y: 126 },
      generation: { sheet: { rows: 2, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'Target final frame is 64x128 with height as the main occupancy axis; post-processing may expand width beyond 64px to preserve silhouette fill.',
    );
    expect(out).toContain('portrait (taller than wide) at a 1:2 aspect ratio');
    expect(out).toContain('span roughly 224-240 source pixels wide and 448-480 source pixels tall');
    expect(out).toContain('Within each 256x512 source cell');
  });

  it('treats a large (2x2) subject as square at the reshaped cell size', () => {
    // large reshapes the grid to 2 rows × 2 cols → 512×512 square cells.
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 128, height: 128 },
      generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'Target final frame is 128x128; post-processing may expand one axis to preserve large-sprite occupancy without letterboxing.',
    );
    expect(out).toContain(
      'Draw each subject at a 1:1 (square) proportion, centered within its square 512x512 source cell.',
    );
  });

  it('tells tiles to fill a non-square frame edge-to-edge', () => {
    const brief = makeBrief({
      type: 'tile',
      size: { width: 128, height: 64 },
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
    // tall enemy reshapes to 2 rows × 4 cols → 256×512 cells.
    const brief = makeBrief({
      type: 'enemy',
      size: { width: 64, height: 128 },
      anchor: { x: 32, y: 64 },
      generation: { sheet: { rows: 2, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    } as Partial<Brief>);
    const out = buildPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain(
      'roughly a full 128px-tall in-game sprite (about 448-480 source pixels tall in a 256x512 cell)',
    );
  });
});

describe('extractPromptColors', () => {
  it('extracts the named dominant color from a prompt', () => {
    expect(extractPromptColors('A gelatinous purple slime, glistening.')).toEqual([[140, 40, 175]]);
  });

  it('returns an empty list when no color word is present', () => {
    expect(extractPromptColors('An iron sword, pixel-art style, blade up-right.')).toEqual([]);
  });

  it('does not match color words embedded inside other words', () => {
    // "evergreen" must not register as green; "goldfish" must not register as gold.
    expect(extractPromptColors('An evergreen goldfish ornament.')).toEqual([]);
  });

  it('extracts every distinct color named in a multi-color prompt', () => {
    const colors = extractPromptColors('A purple slime with glowing lime-green eyes.');
    expect(colors).toContainEqual([140, 40, 175]); // purple
    expect(colors).toContainEqual([150, 210, 40]); // lime green
    expect(colors).toContainEqual([40, 160, 55]); // green
  });

  it('prefers the multi-word phrase over the bare color word', () => {
    // "sky blue" maps to its own representative, not the generic "blue".
    expect(extractPromptColors('A sky blue sprite.')).toContainEqual([90, 165, 230]);
  });
});

describe('pickContrastingBackgroundColor — hue-aware selection', () => {
  const bgFor = (prompt: string) =>
    pickContrastingBackgroundColor(makeBrief({ prompt } as Partial<Brief>));

  it('picks green (not magenta) for a purple slime — the reported regression', () => {
    const bg = bgFor('A gelatinous purple slime, translucent and glistening.');
    expect(bg.name).toBe('neon lime');
    expect(bg.hex).toBe('#39ff14');
    expect(bg.name).not.toBe('bright magenta');
  });

  it('avoids the magenta/purple family for violet and magenta subjects', () => {
    // Both are the same hue family that broke background removal; the picker
    // must steer well clear of bright magenta for them.
    expect(bgFor('A violet wisp creature.').name).not.toBe('bright magenta');
    expect(bgFor('A magenta blob monster.').name).not.toBe('bright magenta');
  });

  it('picks complementary backgrounds for primary-colored subjects', () => {
    // Red -> cyan, green -> magenta, blue -> yellow (opposite hue families).
    expect(bgFor('A bright red imp with horns.').name).toBe('electric cyan');
    expect(bgFor('A green goblin warrior.').name).toBe('bright magenta');
    expect(bgFor('A deep blue water elemental.').name).toBe('vivid yellow');
  });

  it('steers clear of every hue named in a multi-color subject', () => {
    // Purple body + lime-green eyes: the background must avoid BOTH families,
    // so neither magenta (purple-adjacent) nor lime (green) is acceptable.
    const bg = bgFor('A purple slime with glowing lime-green eyes.');
    expect(bg.name).not.toBe('bright magenta');
    expect(bg.name).not.toBe('neon lime');
  });

  it('falls back to the magenta default for achromatic or color-less subjects', () => {
    // No reliable hue to contrast against -> keep the classic chroma-key default.
    expect(bgFor('A grey stone golem.').name).toBe('bright magenta');
    expect(bgFor('An iron sword, pixel-art style, blade up-right.').name).toBe('bright magenta');
  });

  it('still honors an explicit per-sprite palette when no color word is present', () => {
    const brief = makeBrief({
      prompt: 'A blade, pixel-art style.',
      palette: {
        id: 'kenney-roguelike',
        colors: [
          [210, 25, 25],
          [170, 40, 40],
          [120, 20, 20],
        ],
      },
    } as Partial<Brief>);
    // Red-heavy palette (hue ~0) -> complementary cyan, never a red-family color.
    expect(pickContrastingBackgroundColor(brief).name).toBe('electric cyan');
  });

  it('embeds the hue-chosen background color into the generated sheet prompt', () => {
    const out = buildSheetPrompt(
      makeBrief({ prompt: 'A gelatinous purple slime, translucent.' } as Partial<Brief>),
      FAKE_STYLE_GUIDE,
    );
    expect(out).toContain('Prefer neon lime (#39ff14)');
  });
});

describe('buildSheetPrompt — frameSequence (walk-cycle) mode', () => {
  function makeWalkCycleBrief(overrides: Partial<Brief> = {}): Brief {
    return makeBrief({
      type: 'character',
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 63 },
      generation: { sheet: { rows: 1, cols: 3, emptyCells: [], nativeCanvas: 384 } },
      frameSequence: { enabled: true, frameCount: 3, frameRate: 8, loop: true },
      ...overrides,
    } as Partial<Brief>);
  }

  it('emits ordered-frame instructions instead of the independent-variant exploration line', () => {
    const out = buildSheetPrompt(makeWalkCycleBrief(), FAKE_STYLE_GUIDE);
    expect(out).toContain('ORDERED FRAMES of a single side-view walk-cycle animation');
    expect(out).not.toContain('Treat each cell as a separate exploration');
  });

  it('instructs identity/palette/outfit to stay identical across frames', () => {
    const out = buildSheetPrompt(makeWalkCycleBrief(), FAKE_STYLE_GUIDE);
    expect(out).toContain('Keep identity strictly IDENTICAL across every frame');
    expect(out).toContain('leg/arm pose progresses between cells');
  });

  it('a normal (non-sequence) brief with the same grid still gets the exploration line', () => {
    const brief = makeWalkCycleBrief({
      frameSequence: { enabled: false, frameCount: 3, frameRate: 8, loop: true },
    } as Partial<Brief>);
    const out = buildSheetPrompt(brief, FAKE_STYLE_GUIDE);
    expect(out).toContain('Treat each cell as a separate exploration');
    expect(out).not.toContain('ORDERED FRAMES');
  });
});
