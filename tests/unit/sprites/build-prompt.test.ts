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

  it('includes per-variant constraints (no clipping, no text, neutral bg)', () => {
    const out = buildPrompt(makeBrief(), FAKE_STYLE_GUIDE);
    expect(out).toMatch(/margin/i);
    expect(out).toMatch(/no text|no.*numbers/i);
    expect(out).toMatch(/transparent|neutral/i);
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
    expect(out).toMatch(/transparent.*background|neutral background/i);
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
});
