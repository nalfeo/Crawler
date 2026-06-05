import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { computeDiversity, hammingDistance, perceptualHash } from '../../../scripts/sprites/diversity.js';

/** Build a 16x16 PNG where `paint(x, y)` returns the RGBA pixel. */
function build16(paint: (x: number, y: number) => readonly [number, number, number, number]): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const idx = (y * 16 + x) * 4;
      const [r, g, b, a] = paint(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const TRANSPARENT = [0, 0, 0, 0] as const;
const WHITE = [255, 255, 255, 255] as const;
const BLACK = [0, 0, 0, 255] as const;

describe('perceptualHash', () => {
  it('returns a 32-byte (256-bit) hash for a 16x16 sprite', () => {
    const png = build16(() => TRANSPARENT);
    const hash = perceptualHash(png);
    expect(hash.length).toBe(32);
  });

  it('produces identical hashes for identical inputs', () => {
    const png = build16((x) => (x < 8 ? WHITE : BLACK));
    const a = perceptualHash(png);
    const b = perceptualHash(png);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('treats transparent pixels as luminance 0', () => {
    // A sprite with one bright dot on a transparent field should have a
    // hash dominated by zero bits (background) and a small cluster of
    // set bits where the dot is.
    const png = build16((x, y) => (x === 8 && y === 8 ? WHITE : TRANSPARENT));
    const hash = perceptualHash(png);
    let setBits = 0;
    for (const byte of hash) {
      let b = byte;
      while (b) {
        b &= b - 1;
        setBits++;
      }
    }
    // The mean luminance is tiny (one bright pixel out of 256), so the
    // threshold sits just above 0 — every transparent pixel contributes
    // 0 (below threshold) and the one bright pixel contributes >= threshold.
    expect(setBits).toBe(1);
  });
});

describe('hammingDistance', () => {
  it('returns 0 for identical bit vectors', () => {
    const a = new Uint8Array([0xff, 0x00, 0xaa, 0x55]);
    const b = new Uint8Array([0xff, 0x00, 0xaa, 0x55]);
    expect(hammingDistance(a, b, 32)).toBe(0);
  });

  it('returns 1 for perfectly inverted vectors', () => {
    const a = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const b = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    expect(hammingDistance(a, b, 32)).toBe(1);
  });

  it('computes intermediate distances correctly', () => {
    // 0b11110000 vs 0b00001111 = 8 differing bits in 8 total = 1.0
    const a = new Uint8Array([0xf0]);
    const b = new Uint8Array([0x0f]);
    expect(hammingDistance(a, b, 8)).toBe(1);
    // 0b11111111 vs 0b11110000 = 4 differing bits / 8 = 0.5
    const c = new Uint8Array([0xff]);
    const d = new Uint8Array([0xf0]);
    expect(hammingDistance(c, d, 8)).toBe(0.5);
  });

  it('throws on byte-length mismatch', () => {
    const a = new Uint8Array([0]);
    const b = new Uint8Array([0, 0]);
    expect(() => hammingDistance(a, b, 8)).toThrow(/byte length mismatch/);
  });
});

describe('computeDiversity', () => {
  it('returns null for fewer than 2 sprites', () => {
    expect(computeDiversity([])).toBeNull();
    expect(computeDiversity([build16(() => WHITE)])).toBeNull();
  });

  it('reports 0 mean diversity when all sprites are identical', () => {
    const png = build16((x) => (x < 8 ? WHITE : BLACK));
    const result = computeDiversity([png, png, png]);
    expect(result).not.toBeNull();
    expect(result!.variantCount).toBe(3);
    expect(result!.pairCount).toBe(3);
    expect(result!.meanHamming).toBe(0);
    expect(result!.minHamming).toBe(0);
    expect(result!.maxHamming).toBe(0);
  });

  it('reports high mean diversity when sprites are structurally different', () => {
    // Two sprites with non-overlapping bright regions: their hashes will
    // disagree on most bits.
    const leftHalf = build16((x) => (x < 8 ? WHITE : TRANSPARENT));
    const rightHalf = build16((x) => (x >= 8 ? WHITE : TRANSPARENT));
    const result = computeDiversity([leftHalf, rightHalf]);
    expect(result).not.toBeNull();
    expect(result!.meanHamming).toBeGreaterThan(0.4);
  });

  it('min and max track the extreme pair distances', () => {
    const a = build16((x) => (x < 8 ? WHITE : BLACK));
    const aClone = build16((x) => (x < 8 ? WHITE : BLACK));
    const opposite = build16((x) => (x < 8 ? BLACK : WHITE));
    const result = computeDiversity([a, aClone, opposite]);
    expect(result).not.toBeNull();
    expect(result!.pairCount).toBe(3);
    // a vs aClone -> 0; a vs opposite -> 1; aClone vs opposite -> 1.
    expect(result!.minHamming).toBe(0);
    expect(result!.maxHamming).toBe(1);
    expect(result!.meanHamming).toBeCloseTo(2 / 3, 5);
  });
});
