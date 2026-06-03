import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';

describe('SeededRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);

    const sequenceA = Array.from({ length: 5 }, () => a.next());
    const sequenceB = Array.from({ length: 5 }, () => b.next());

    expect(sequenceA).toEqual(sequenceB);
  });

  it('produces different sequences for different seeds', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(7);

    const sequenceA = Array.from({ length: 5 }, () => a.next());
    const sequenceB = Array.from({ length: 5 }, () => b.next());

    expect(sequenceA).not.toEqual(sequenceB);
  });

  it('returns integers within the requested range', () => {
    const rng = new SeededRandom(42);

    for (let i = 0; i < 100; i++) {
      const value = rng.nextInt(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });

  it('picks an element from the provided array', () => {
    const options = ['scrap', 'fuel', 'ore'] as const;
    const rng = new SeededRandom(42);
    const value = rng.pick(options);

    expect(options).toContain(value);
  });

  it('shuffles deterministically for the same seed', () => {
    const values = [1, 2, 3, 4, 5, 6];
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);

    const shuffledA = a.shuffle([...values]);
    const shuffledB = b.shuffle([...values]);

    expect(shuffledA).toEqual(shuffledB);
  });
});
