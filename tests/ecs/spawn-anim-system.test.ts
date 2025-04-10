import { addComponent, hasComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Invincible, SpawnAnim } from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { spawnAnimSystem } from '../../src/core/systems/spawnAnimSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../src/shared/spawn-anim.js';

/** Tag an enemy as a freshly-spawned, animating baby (cosmetic pop/wiggle only). */
function spawnAnimatingEnemy(world: ReturnType<typeof createTestWorld>): number {
  const eid = spawnEnemy(world, 0, 0, 50);
  addComponent(
    world.ecs,
    eid,
    set(SpawnAnim, { remainingMs: MINI_SLIME_SPAWN_ANIM_MS, totalMs: MINI_SLIME_SPAWN_ANIM_MS }),
  );
  return eid;
}

describe('spawnAnimSystem', () => {
  it('counts the spawn timer down by GAME.DELTA_MS each tick', () => {
    const world = createTestWorld();
    const eid = spawnAnimatingEnemy(world);

    spawnAnimSystem(world);

    expect(world.stores.spawnAnim.remainingMs[eid]).toBeCloseTo(
      MINI_SLIME_SPAWN_ANIM_MS - GAME.DELTA_MS,
      3,
    );
    expect(hasComponent(world.ecs, eid, SpawnAnim)).toBe(true);
  });

  it('strips SpawnAnim once the animation timer expires', () => {
    const world = createTestWorld();
    const eid = spawnAnimatingEnemy(world);

    let ticks = 0;
    while (hasComponent(world.ecs, eid, SpawnAnim) && ticks < 100) {
      spawnAnimSystem(world);
      ticks += 1;
    }

    // ~ceil(MINI_SLIME_SPAWN_ANIM_MS / DELTA_MS) frames; Float32 accumulation may add one.
    const expectedTicks = Math.round(MINI_SLIME_SPAWN_ANIM_MS / GAME.DELTA_MS);
    expect(ticks).toBeGreaterThanOrEqual(expectedTicks);
    expect(ticks).toBeLessThanOrEqual(expectedTicks + 1);
    expect(hasComponent(world.ecs, eid, SpawnAnim)).toBe(false);
  });

  it('is purely cosmetic — SpawnAnim grants no invulnerability', () => {
    const world = createTestWorld();
    const eid = spawnAnimatingEnemy(world);

    // A still-animating baby takes full damage; the pop/wiggle never absorbs a hit.
    expect(hasComponent(world.ecs, eid, Invincible)).toBe(false);
    expect(applyDamage(world, eid, 30, 0, 0, DEFAULT_DAMAGE_OPTIONS)).toBe(30);
    expect(world.stores.health.current[eid]).toBe(20);
  });

  it('strips SpawnAnim even when the entity was never Invincible', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 50);
    addComponent(
      world.ecs,
      eid,
      set(SpawnAnim, { remainingMs: GAME.DELTA_MS, totalMs: GAME.DELTA_MS }),
    );

    spawnAnimSystem(world);

    expect(hasComponent(world.ecs, eid, SpawnAnim)).toBe(false);
  });

  it('ignores entities without SpawnAnim', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 50);

    expect(() => spawnAnimSystem(world)).not.toThrow();
    expect(hasComponent(world.ecs, eid, SpawnAnim)).toBe(false);
  });
});
