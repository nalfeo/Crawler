/**
 * Seeded pseudo-random number generator.
 * All game randomness MUST use this — never Math.random().
 * This ensures deterministic replays when given the same seed.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // xorshift32 has a fixed point at 0 — guard against it
    this.state = seed | 0 || 0x9e3779b9;
  }

  /** Returns a float in [0, 1) — deterministic for a given seed sequence. */
  next(): number {
    // xorshift32 (canonical unsigned variant)
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return ((this.state >>> 0) % 1_000_000) / 1_000_000;
  }

  /** Returns an integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a random element from an array. */
  pick<T>(array: readonly T[]): T {
    const item = array[this.nextInt(0, array.length - 1)];
    if (item === undefined) {
      throw new Error('Cannot pick from empty array');
    }
    return item;
  }

  /** Shuffles an array in place (Fisher-Yates). */
  shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
    return array;
  }
}
