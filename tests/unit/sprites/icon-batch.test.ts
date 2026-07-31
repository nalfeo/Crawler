import { describe, it, expect } from 'vitest';
import { briefSchema } from '../../../scripts/sprites/brief-schema.js';
import { buildIconBatchSheetPrompt } from '../../../scripts/sprites/build-prompt.js';

// Minimal valid base for an icon-type brief. Grid is 4×4 = 16 cells.
const iconBase = {
  type: 'icon' as const,
  name: 'achv-icons-batch-01',
  prompt: 'Achievement icon batch — symbolic pixel-art icons for Floor 1 achievements.',
  size: { width: 128, height: 128 },
  palette: { id: 'kenney-roguelike' },
  anchor: { x: 64, y: 64 },
  tags: ['icon', 'achievement'],
  floor: 1,
  generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
  sensors: {},
  variations: [],
  minVariations: 0,
  judge: { enabled: true, maxVariants: 16 },
  postprocessing: { trimAndFit: true, minDimension: 32 },
  frameSequence: { enabled: false, frameCount: 2, frameRate: 8, loop: false },
  references: [],
};

// 4-entry batch. Pair with a 2×2 grid.
const sampleEntries = Array.from({ length: 4 }, (_, i) => ({
  id: `achv-icon-${i}`,
  concept: `Achievement ${i}`,
  description: `Description ${i}`,
}));

describe('briefSchema — iconBatch', () => {
  it('accepts a valid icon brief with iconBatch matching cell count', () => {
    const result = briefSchema.safeParse({
      ...iconBase,
      // 2×2 grid = 4 cells, matching the 4-entry batch.
      generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 512 } },
      iconBatch: sampleEntries,
    });
    expect(result.success).toBe(true);
  });

  it('rejects iconBatch when length does not match grid cell count', () => {
    const result = briefSchema.safeParse({
      ...iconBase,
      // Base is 4×4 = 16 cells, but iconBatch only has 4 entries → mismatch.
      iconBatch: sampleEntries,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('iconBatch length');
  });

  it('rejects duplicate iconBatch ids', () => {
    const dupes = [
      { id: 'same-id', concept: 'A' },
      { id: 'same-id', concept: 'B' },
    ];
    const result = briefSchema.safeParse({
      ...iconBase,
      // 1×2 grid = 2 cells, matching the 2-entry batch.
      generation: { sheet: { rows: 1, cols: 2, emptyCells: [], nativeCanvas: 256 } },
      iconBatch: dupes,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('duplicate iconBatch id');
  });

  it('allows up to 16 icons in a batch', () => {
    const batch = Array.from({ length: 16 }, (_, i) => ({
      id: `icon-${i}`,
      concept: `Icon ${i}`,
    }));
    const result = briefSchema.safeParse({
      ...iconBase,
      // Base 4×4 = 16 cells, matches 16-entry batch.
      iconBatch: batch,
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 16 icons in a batch', () => {
    const batch = Array.from({ length: 17 }, (_, i) => ({
      id: `icon-${i}`,
      concept: `Icon ${i}`,
    }));
    const result = briefSchema.safeParse({
      ...iconBase,
      iconBatch: batch,
    });
    expect(result.success).toBe(false);
  });
});

describe('buildIconBatchSheetPrompt', () => {
  it('includes concept labels for each cell', () => {
    const fakeBrief = {
      ...iconBase,
      // 1×3 grid = 3 cells, matching 3-entry iconBatch.
      generation: { sheet: { rows: 1, cols: 3, emptyCells: [], nativeCanvas: 384 } },
      iconBatch: [
        { id: 'achv-first-kill', concept: 'First Kill', description: 'Defeat your first enemy' },
        { id: 'achv-big-combo', concept: 'Big Combo' },
        { id: 'achv-speedrun', concept: 'Speedrun', description: 'Win in under 5 minutes' },
      ],
    } as unknown as Parameters<typeof buildIconBatchSheetPrompt>[0];

    const prompt = buildIconBatchSheetPrompt(fakeBrief, '');
    expect(prompt).toContain('First Kill');
    expect(prompt).toContain('Big Combo');
    expect(prompt).toContain('Speedrun');
    // Should instruct NO baked-in frame (prohibition is correct — word appears as negative).
    expect(prompt).toMatch(/do not include any frame/i);
  });

  it('contains cell-grid layout instructions', () => {
    const fakeBrief = {
      ...iconBase,
      // 1×2 grid = 2 cells, matching 2-entry iconBatch.
      generation: { sheet: { rows: 1, cols: 2, emptyCells: [], nativeCanvas: 256 } },
      iconBatch: [
        { id: 'a', concept: 'Alpha' },
        { id: 'b', concept: 'Beta' },
      ],
    } as unknown as Parameters<typeof buildIconBatchSheetPrompt>[0];

    const prompt = buildIconBatchSheetPrompt(fakeBrief, '');
    // Should describe a grid layout.
    expect(prompt).toMatch(/grid|cell|row|col/i);
  });

  it('maps iconBatch cells to non-empty coordinates and instructs empty cells explicitly', () => {
    const fakeBrief = {
      ...iconBase,
      generation: {
        sheet: {
          rows: 2,
          cols: 2,
          emptyCells: [[0, 0]] as ReadonlyArray<readonly [number, number]>,
          nativeCanvas: 256,
        },
      },
      iconBatch: [
        { id: 'a', concept: 'Alpha' },
        { id: 'b', concept: 'Beta' },
        { id: 'c', concept: 'Gamma' },
      ],
    } as unknown as Parameters<typeof buildIconBatchSheetPrompt>[0];

    const prompt = buildIconBatchSheetPrompt(fakeBrief, '');
    expect(prompt).toContain('Leave these cells fully empty');
    expect(prompt).toContain('(row 1, col 1)');
    expect(prompt).toContain('Cell 1 (row 1, col 2): **Alpha**');
    expect(prompt).toContain('Cell 2 (row 2, col 1): **Beta**');
    expect(prompt).toContain('Cell 3 (row 2, col 2): **Gamma**');
  });
});
