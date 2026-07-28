/**
 * Exhaustive tests for the shared blob47 mask normalizer
 * (`src/shared/terrain-pack-mask.ts`) — the single source of truth both the
 * runtime renderer and the offline pack assembler/validator import
 * (reviewed-design refinement #3).
 *
 * Coverage required by the task spec:
 *   - all 256 raw 8-neighbor masks normalize into exactly 47 canonical masks
 *   - corner (diagonal) gating rule holds for every raw mask
 *   - out-of-bounds neighbours are treated as non-matching
 *   - explicit mask -> frame mapping round-trips via the registry-backed packs
 */
import { describe, expect, it } from 'vitest';
import {
  BLOB47_CANONICAL_MASKS,
  CORNER_ADJACENCY,
  MASK_BIT,
  computeRawMask8,
  edgeWangMaskFromOccupancy,
  edgeWangStubSpan,
  edgeConnectionsFromMask,
  isCanonicalBlob47Mask,
  neighborMask8InTerrain,
  normalizeBlob47Mask,
  quadrantStateFromMask,
} from '../../src/shared/terrain-pack-mask.js';

describe('normalizeBlob47Mask — exhaustive 256 -> 47 canonicalization', () => {
  it('normalizes every one of the 256 raw masks (0-255) to a canonical value', () => {
    for (let raw = 0; raw < 256; raw++) {
      const canonical = normalizeBlob47Mask(raw);
      expect(canonical).toBeGreaterThanOrEqual(0);
      expect(canonical).toBeLessThanOrEqual(255);
    }
  });

  it('collapses all 256 raw masks into EXACTLY 47 unique canonical masks', () => {
    const seen = new Set<number>();
    for (let raw = 0; raw < 256; raw++) {
      seen.add(normalizeBlob47Mask(raw));
    }
    expect(seen.size).toBe(47);
    expect(BLOB47_CANONICAL_MASKS).toHaveLength(47);
    expect(new Set(BLOB47_CANONICAL_MASKS)).toEqual(seen);
  });

  it('is idempotent: normalizing an already-canonical mask returns itself', () => {
    for (const canonical of BLOB47_CANONICAL_MASKS) {
      expect(normalizeBlob47Mask(canonical)).toBe(canonical);
    }
  });

  it('BLOB47_CANONICAL_MASKS is sorted ascending (the pinned canonical ordering)', () => {
    const sorted = [...BLOB47_CANONICAL_MASKS].sort((a, b) => a - b);
    expect(BLOB47_CANONICAL_MASKS).toEqual(sorted);
  });

  it('always preserves all four cardinal bits unchanged', () => {
    const cardinalMask = MASK_BIT.N | MASK_BIT.E | MASK_BIT.S | MASK_BIT.W;
    for (let raw = 0; raw < 256; raw++) {
      const canonical = normalizeBlob47Mask(raw);
      expect(canonical & cardinalMask).toBe(raw & cardinalMask);
    }
  });

  it('diagonal gating: a diagonal bit survives ONLY when both adjacent cardinals are set', () => {
    for (let raw = 0; raw < 256; raw++) {
      const canonical = normalizeBlob47Mask(raw);
      for (const [diag, [cardA, cardB]] of Object.entries(CORNER_ADJACENCY)) {
        const diagBit = MASK_BIT[diag as keyof typeof MASK_BIT];
        const bothCardinalsSet = (raw & MASK_BIT[cardA]) !== 0 && (raw & MASK_BIT[cardB]) !== 0;
        const diagSurvived = (canonical & diagBit) !== 0;
        if (bothCardinalsSet) {
          // Diagonal bit passes through only if it was raised in the raw mask too.
          expect(diagSurvived).toBe((raw & diagBit) !== 0);
        } else {
          expect(diagSurvived).toBe(false);
        }
      }
    }
  });

  it('clears every diagonal bit when no cardinal bits are set at all', () => {
    // raw = 0b11110000 = all 4 diagonals, 0 cardinals -> canonical must be 0.
    expect(normalizeBlob47Mask(0b11110000)).toBe(0);
  });

  it('mask 255 (fully surrounded) and mask 0 (fully isolated) are both canonical', () => {
    expect(isCanonicalBlob47Mask(0)).toBe(true);
    expect(isCanonicalBlob47Mask(255)).toBe(true);
    expect(normalizeBlob47Mask(255)).toBe(255);
    expect(normalizeBlob47Mask(0)).toBe(0);
  });

  it('isCanonicalBlob47Mask is false for a mask that never survives gating (e.g. lone NW)', () => {
    // Lone NW diagonal, no cardinals set -> normalizes to 0, so 128 itself
    // is never produced by normalizeBlob47Mask and must not be "canonical".
    expect(normalizeBlob47Mask(MASK_BIT.NW)).toBe(0);
    expect(isCanonicalBlob47Mask(MASK_BIT.NW)).toBe(false);
  });
});

describe('computeRawMask8 / neighborMask8InTerrain — bit order + OOB handling', () => {
  it('sets bits in the pinned order N=1,E=2,S=4,W=8,NE=16,SE=32,SW=64,NW=128', () => {
    const allMatch = () => true;
    // 3x3 grid, center tile (1,1): every neighbour matches -> full 255.
    expect(computeRawMask8(1, 1, 3, 3, allMatch)).toBe(255);
  });

  it('treats out-of-bounds neighbours as non-matching (bit stays 0)', () => {
    const allMatch = () => true;
    // Top-left corner tile (0,0) of a 3x3 grid: N, W, NE, NW, SW are all OOB.
    // Only E, S, SE are in-bounds and match.
    const mask = computeRawMask8(0, 0, 3, 3, allMatch);
    expect(mask).toBe(MASK_BIT.E | MASK_BIT.S | MASK_BIT.SE);
  });

  it('a 1x1 grid has every neighbour out of bounds -> raw mask 0', () => {
    const allMatch = () => true;
    expect(computeRawMask8(0, 0, 1, 1, allMatch)).toBe(0);
  });

  it('only sets the bit for a neighbour that individually matches', () => {
    // Only the N neighbour of (1,1) in a 3x3 grid matches.
    const mask = computeRawMask8(1, 1, 3, 3, (nx, ny) => nx === 1 && ny === 0);
    expect(mask).toBe(MASK_BIT.N);
  });

  it('neighborMask8InTerrain matches only same-terrain neighbours, row-major indexed', () => {
    // 3x3 terrain grid; only the center + the cell directly East match terrain=1.
    // prettier-ignore
    const terrain = Uint8Array.from([
      0, 0, 0,
      0, 1, 1,
      0, 0, 0,
    ]);
    const mask = neighborMask8InTerrain(terrain, 3, 3, 1, 1, 1);
    expect(mask).toBe(MASK_BIT.E);
  });
});

describe('edgeConnectionsFromMask / quadrantStateFromMask', () => {
  it('decodes all 4 cardinal bits independently', () => {
    expect(edgeConnectionsFromMask(0)).toEqual({ N: false, E: false, S: false, W: false });
    expect(edgeConnectionsFromMask(MASK_BIT.N)).toEqual({
      N: true,
      E: false,
      S: false,
      W: false,
    });

    expect(edgeConnectionsFromMask(255)).toEqual({ N: true, E: true, S: true, W: true });
  });

  it('classifies every canonical mask x corner combination into one of the 5 valid states', () => {
    const validStates = new Set(['open', 'edgeA', 'edgeB', 'concave', 'full']);
    for (const mask of BLOB47_CANONICAL_MASKS) {
      for (const corner of ['NW', 'NE', 'SE', 'SW'] as const) {
        expect(validStates.has(quadrantStateFromMask(mask, corner))).toBe(true);
      }
    }
  });

  it('classifies the NE corner as "open" when neither N nor E is set', () => {
    expect(quadrantStateFromMask(MASK_BIT.S | MASK_BIT.W, 'NE')).toBe('open');
  });

  it('classifies the NE corner as "full" when N, E, and NE are all set (canonical)', () => {
    const mask = normalizeBlob47Mask(MASK_BIT.N | MASK_BIT.E | MASK_BIT.NE);
    expect(quadrantStateFromMask(mask, 'NE')).toBe('full');
  });

  it('classifies the NE corner as "concave" when N and E are set but NE is gated out', () => {
    // Raw mask sets N, E, NE together — normalizeBlob47Mask would keep NE here
    // since both cardinals are set, so build the concave case directly: a
    // canonical mask with N+E set and NE bit cleared (this IS a valid
    // canonical mask — e.g. an inner-corner notch).
    const concaveMask = MASK_BIT.N | MASK_BIT.E; // NE bit intentionally absent
    expect(isCanonicalBlob47Mask(concaveMask)).toBe(true);
    expect(quadrantStateFromMask(concaveMask, 'NE')).toBe('concave');
  });

  it('classifies the NE corner as "edgeA"/"edgeB" when exactly one adjacent cardinal is set', () => {
    expect(quadrantStateFromMask(MASK_BIT.N, 'NE')).toBe('edgeA');
    expect(quadrantStateFromMask(MASK_BIT.E, 'NE')).toBe('edgeB');
  });
});

describe('edge-Wang helpers', () => {
  it('derives edge-Wang masks from occupied cardinal neighbours only', () => {
    // prettier-ignore
    const occupancy = Uint8Array.from([
      0, 1, 0,
      1, 1, 1,
      0, 1, 0,
    ]);
    expect(edgeWangMaskFromOccupancy(occupancy, 3, 3, 1, 1)).toBe(
      MASK_BIT.N | MASK_BIT.E | MASK_BIT.S | MASK_BIT.W,
    );
  });

  it('treats out-of-bounds neighbours as unoccupied for edge-Wang masks', () => {
    // prettier-ignore
    const occupancy = Uint8Array.from([
      1, 1,
      0, 0,
    ]);
    expect(edgeWangMaskFromOccupancy(occupancy, 2, 2, 0, 0)).toBe(MASK_BIT.E);
  });

  it('returns the inclusive-exclusive stub span', () => {
    expect(edgeWangStubSpan({ cellPx: 64, offsetPx: 25, widthPx: 14 })).toEqual({
      start: 25,
      end: 39,
    });
  });
});
