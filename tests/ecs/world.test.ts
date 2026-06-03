import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../../src/core/world.js';
import { SeededRandom } from '../../src/shared/random.js';

describe('createGameWorld', () => {
  it('returns a world with ECS state, RNG, and frame metadata', () => {
    const world = createGameWorld();

    expect(world.ecs).toBeDefined();
    expect(typeof world.ecs).toBe('object');
    expect(world.rng).toBeInstanceOf(SeededRandom);
    expect(world.frameCount).toBe(0);
    expect(world.elapsedMs).toBe(0);
  });

  it('uses the default seed of 42', () => {
    const world = createGameWorld();
    const expected = new SeededRandom(42);

    expect(world.rng.next()).toBe(expected.next());
  });

  it('uses the default floor of 1', () => {
    const world = createGameWorld();

    expect(world.floor).toBe(1);
  });

  it("starts in the 'playing' state", () => {
    const world = createGameWorld();

    expect(world.state).toBe('playing');
  });

  it('allows custom options to override defaults', () => {
    const world = createGameWorld({ seed: 7, floor: 3 });
    const expected = new SeededRandom(7);

    expect(world.floor).toBe(3);
    expect(world.rng.next()).toBe(expected.next());
  });
});
