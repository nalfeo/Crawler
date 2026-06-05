import { describe, it, expect } from 'vitest';
import { briefSchema, type Brief, SPRITE_TYPES } from '../../scripts/sprites/brief-schema.js';

const validBrief: Brief = {
  type: 'weapon',
  name: 'iron-sword',
  size: { width: 32, height: 32 },
  palette: { id: 'kenney-roguelike' },
  anchor: { x: 16, y: 28 },
  tags: ['blade', 'melee'],
  prompt: 'A pixel-art iron sword on a transparent background, blade pointing up.',
  references: [{ path: 'docs/refs/sword-1.png', note: 'silhouette inspiration' }],
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

  it('defaults tags and references to empty arrays', () => {
    const minimal = {
      type: 'weapon',
      name: 'iron-sword',
      size: { width: 32, height: 32 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 0, y: 0 },
      prompt: 'p',
    };
    const result = briefSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.references).toEqual([]);
    }
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
});
