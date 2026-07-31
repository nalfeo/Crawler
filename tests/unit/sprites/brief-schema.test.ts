import { describe, it, expect } from 'vitest';
import {
  briefSchema,
  minimalBriefSchema,
  type Brief,
  SPRITE_TYPES,
  variantCount,
} from '../../../scripts/sprites/brief-schema.js';

const validBrief: Brief = {
  type: 'weapon',
  name: 'iron-sword',
  size: { width: 32, height: 32 },
  palette: { id: 'kenney-roguelike' },
  anchor: { x: 16, y: 28 },
  tags: ['blade', 'melee'],
  prompt: 'A pixel-art iron sword on a transparent background, blade pointing up.',
  floor: 1,
  references: [
    { path: 'docs/refs/sword-1.png', note: 'silhouette inspiration' },
    { path: 'docs/refs/sword-2.png', note: 'palette anchor' },
  ],
  generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
  sensors: {},
  variations: [],
  minVariations: 4,
  judge: { enabled: false, maxVariants: 16 },
  postprocessing: { trimAndFit: false, minDimension: 256, paletteMode: 'strict' },
  frameSequence: { enabled: false, frameCount: 3, frameRate: 8, loop: true },
};

describe('briefSchema', () => {
  it('accepts a fully valid weapon brief', () => {
    const result = briefSchema.safeParse(validBrief);
    expect(result.success).toBe(true);
  });

  it('accepts a brief with inline palette colors', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      palette: {
        id: 'kenney-roguelike',
        colors: [
          [0, 0, 0],
          [255, 255, 255],
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('defaults tags and references to empty arrays; references are optional (Kenney retired)', () => {
    const minimal = {
      type: 'weapon',
      name: 'iron-sword',
      size: { width: 32, height: 32 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 0, y: 0 },
      prompt: 'p',
    };
    // `references` is retired as a generation input — generate-time reference
    // selection (reference-selector.ts) draws from our approved manifest — so a
    // brief with no `references` is valid and the field defaults to `[]`.
    const result = briefSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.references).toEqual([]);
    }

    const withRefs = briefSchema.safeParse({
      ...minimal,
      references: [{ path: 'a.png' }, { path: 'b.png' }],
    });
    expect(withRefs.success).toBe(true);
    if (withRefs.success) {
      expect(withRefs.data.references).toHaveLength(2);
    }
  });

  it('accepts fewer than 2 references now that the min-2 rule is retired', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      references: [{ path: 'docs/refs/sword-1.png' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.references).toHaveLength(1);
    }
  });

  it('defaults minVariations to 4 and accepts 0 (opt-out) and integers up to 20', () => {
    const { minVariations: _omit, ...withoutMin } = validBrief;
    void _omit;
    const parsed = briefSchema.parse(withoutMin);
    expect(parsed.minVariations).toBe(4);

    expect(briefSchema.safeParse({ ...validBrief, minVariations: 0 }).success).toBe(true);
    expect(briefSchema.safeParse({ ...validBrief, minVariations: 20 }).success).toBe(true);
    expect(briefSchema.safeParse({ ...validBrief, minVariations: -1 }).success).toBe(false);
    expect(briefSchema.safeParse({ ...validBrief, minVariations: 21 }).success).toBe(false);
    expect(briefSchema.safeParse({ ...validBrief, minVariations: 4.5 }).success).toBe(false);
  });

  it('defaults postprocessing.minDimension to 256 when postprocessing is entirely absent', () => {
    // Guards the schema default: a regression to 64 would pass the `validBrief`
    // fixture (which supplies minDimension explicitly), but fails here.
    const { postprocessing: _omit, ...withoutPostprocessing } = validBrief;
    void _omit;
    const parsed = briefSchema.parse(withoutPostprocessing);
    expect(parsed.postprocessing.minDimension).toBe(256);
  });

  it('defaults floor to 1 and accepts only integers from 1 through 20', () => {
    const { floor: _omit, ...withoutFloor } = validBrief;
    void _omit;
    expect(briefSchema.parse(withoutFloor).floor).toBe(1);
    expect(briefSchema.safeParse({ ...validBrief, floor: 20 }).success).toBe(true);
    expect(briefSchema.safeParse({ ...validBrief, floor: 0 }).success).toBe(false);
    expect(briefSchema.safeParse({ ...validBrief, floor: 21 }).success).toBe(false);
    expect(briefSchema.safeParse({ ...validBrief, floor: 2.5 }).success).toBe(false);
  });

  it('accepts every documented sprite type', () => {
    for (const type of SPRITE_TYPES) {
      const result = briefSchema.safeParse({ ...validBrief, type });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a brief missing required fields', () => {
    const { name: _name, ...withoutName } = validBrief;
    const result = briefSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('name');
    }
  });

  it('rejects a non-existent sprite type', () => {
    const result = briefSchema.safeParse({ ...validBrief, type: 'mech' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['type']);
    }
  });

  it('rejects a palette id that is not kebab-case', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      palette: { id: 'Kenney_Roguelike' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const palettePathHit = result.error.issues.some((i) =>
        i.path.join('.').startsWith('palette'),
      );
      expect(palettePathHit).toBe(true);
    }
  });

  it('rejects an inline palette color with out-of-range channel', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      palette: {
        id: 'kenney-roguelike',
        colors: [
          [0, 0, 0],
          [256, 0, 0],
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an anchor outside size bounds (x)', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      anchor: { x: 32, y: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('anchor.x'))).toBe(true);
    }
  });

  it('rejects an anchor outside size bounds (y)', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      anchor: { x: 0, y: 32 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('anchor.y'))).toBe(true);
    }
  });

  it('rejects unknown extra fields (strict)', () => {
    const result = briefSchema.safeParse({ ...validBrief, mood: 'fierce' });
    expect(result.success).toBe(false);
  });

  it('defaults generation.sheet to a 4x4 grid with 16 variants and no empty cells', () => {
    const minimal = {
      type: 'weapon',
      name: 'iron-sword',
      size: { width: 16, height: 16 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 8, y: 14 },
      prompt: 'p',
      references: [{ path: 'a.png' }, { path: 'b.png' }],
    };
    const result = briefSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generation.sheet.rows).toBe(4);
      expect(result.data.generation.sheet.cols).toBe(4);
      expect(result.data.generation.sheet.emptyCells).toEqual([]);
      expect(result.data.generation.sheet.nativeCanvas).toBe(1024);
      expect(variantCount(result.data)).toBe(16);
    }
  });

  it('honors brief-declared sheet overrides and reflects empty cells in variantCount', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [[3, 3]], nativeCanvas: 1024 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(variantCount(result.data)).toBe(15);
    }
  });

  it('rejects a sheet whose nativeCanvas is not divisible by both rows and cols', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      generation: { sheet: { rows: 3, cols: 3, emptyCells: [], nativeCanvas: 1024 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('not evenly divisible'))).toBe(true);
    }
  });

  it('rejects empty-cell coordinates outside the declared grid', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      generation: { sheet: { rows: 2, cols: 2, emptyCells: [[5, 5]] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('outside the 2x2 grid'))).toBe(true);
    }
  });

  it('rejects duplicate empty-cell coordinates', () => {
    // A duplicate would make variantCount (rows*cols - emptyCells.length)
    // under-count the real cells and let a same-count grid change slip past the
    // rerun guard, so parsing must reject it at the source.
    const result = briefSchema.safeParse({
      ...validBrief,
      generation: {
        sheet: {
          rows: 2,
          cols: 2,
          emptyCells: [
            [0, 0],
            [0, 0],
          ],
          nativeCanvas: 1024,
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('duplicate empty cell [0, 0]'))).toBe(true);
    }
  });

  it('rejects sensors override with an out-of-range opaqueRatio', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      sensors: { opaqueRatio: { min: -0.1 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only variations entries (trim happens in the schema)', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      variations: ['real entry', '   '],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.startsWith('variations'))).toBe(true);
    }
  });

  it('trims surrounding whitespace from valid variations entries', () => {
    const result = briefSchema.safeParse({
      ...validBrief,
      variations: ['  spiked pommel  '],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variations).toEqual(['spiked pommel']);
    }
  });

  describe('frameSequence (opt-in walk-cycle mode)', () => {
    it('defaults to disabled, leaving existing briefs completely unaffected', () => {
      const parsed = briefSchema.parse(validBrief);
      expect(parsed.frameSequence).toEqual({
        enabled: false,
        frameCount: 3,
        frameRate: 8,
        loop: true,
      });
    });

    it('defaults to disabled when frameSequence is entirely absent from the brief', () => {
      // This guards the key backward-compat contract: an existing brief that
      // predates the frameSequence field must parse successfully and default to
      // the disabled state — the schema must supply the default, not the caller.
      const { frameSequence: _removed, ...briefWithoutFrameSequence } = validBrief;
      const result = briefSchema.safeParse(briefWithoutFrameSequence);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.frameSequence).toMatchObject({ enabled: false });
      }
    });

    it('accepts an enabled sequence brief whose sheet is a single row of frameCount cells', () => {
      const result = briefSchema.safeParse({
        ...validBrief,
        generation: { sheet: { rows: 1, cols: 3, emptyCells: [], nativeCanvas: 384 } },
        frameSequence: { enabled: true, frameCount: 3, frameRate: 8, loop: true },
      });
      expect(result.success).toBe(true);
    });

    it('accepts an enabled sequence brief with a multi-row grid (rows × cols === frameCount)', () => {
      // Any rectangular layout is valid as long as rows × cols === frameCount.
      // A 2×2 grid for a 4-frame walk cycle is the canonical migrated layout.
      const result = briefSchema.safeParse({
        ...validBrief,
        generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
        frameSequence: { enabled: true, frameCount: 4, frameRate: 8, loop: true },
      });
      expect(result.success).toBe(true);
    });

    it('rejects an enabled sequence brief whose rows × cols does not match frameCount', () => {
      const result = briefSchema.safeParse({
        ...validBrief,
        generation: { sheet: { rows: 2, cols: 3, emptyCells: [], nativeCanvas: 192 } },
        frameSequence: { enabled: true, frameCount: 4, frameRate: 8, loop: true },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes('rows × cols === frameSequence.frameCount'))).toBe(
          true,
        );
      }
    });

    it('rejects an enabled sequence brief with any empty cells', () => {
      const result = briefSchema.safeParse({
        ...validBrief,
        generation: { sheet: { rows: 1, cols: 3, emptyCells: [[0, 1]], nativeCanvas: 192 } },
        frameSequence: { enabled: true, frameCount: 3, frameRate: 8, loop: true },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes('no empty cells'))).toBe(true);
      }
    });

    it('does not apply frameSequence cross-validation when disabled, even with a mismatched grid', () => {
      // A 2x2 grid would violate every frameSequence rule, but since it's
      // disabled the normal (non-sequence) sheet validation still applies
      // and this remains a perfectly ordinary valid brief.
      const result = briefSchema.safeParse({
        ...validBrief,
        generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 } },
        frameSequence: { enabled: false, frameCount: 3, frameRate: 8, loop: true },
      });
      expect(result.success).toBe(true);
    });

    it('rejects frameCount outside the documented [2, 8] range', () => {
      expect(
        briefSchema.safeParse({
          ...validBrief,
          frameSequence: { enabled: false, frameCount: 1, frameRate: 8, loop: true },
        }).success,
      ).toBe(false);
      expect(
        briefSchema.safeParse({
          ...validBrief,
          frameSequence: { enabled: false, frameCount: 9, frameRate: 8, loop: true },
        }).success,
      ).toBe(false);
    });
  });
});

describe('minimalBriefSchema — sizeVariant', () => {
  const base = { type: 'enemy', name: 'slime', description: 'a green slime' } as const;

  it('accepts a brief with no sizeVariant', () => {
    const result = minimalBriefSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it.each(['default', 'wide', 'tall', 'large'])('accepts sizeVariant=%s', (variant) => {
    const result = minimalBriefSchema.safeParse({ ...base, sizeVariant: variant });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown sizeVariant', () => {
    const result = minimalBriefSchema.safeParse({ ...base, sizeVariant: 'huge' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('sizeVariant');
    }
  });
});
