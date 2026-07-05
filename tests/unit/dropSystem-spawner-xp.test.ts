/**
 * Unit tests for the spawner-arena XP intercept in `dropSystem`.
 *
 * Guarantees:
 *   1. When a spawner-owned enemy dies, no XpGem entity is spawned but the
 *      owning spawner's `bankedXp` grows by the same amount.
 *   2. Requirement 4 — a spawner-owned child NEVER drops an on-map XP gem, even
 *      beyond `SPAWNER_MAX_BANKED_CHILDREN` (10). Past the cap the bank stops
 *      growing (anti-farm), but the child's XP gem stays suppressed.
 *   3. Non-owned enemy kills follow the normal path: XpGem entities are
 *      spawned and no spawner bank is touched.
 */
import { addComponent, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health, Owner, Position, XpGem } from '../../src/core/components.js';
import { spawnEnemy, spawnBehaviorEnemy, spawnSpawner } from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { AI_TYPE } from '../../src/game/index.js';
import { SPAWNER_MAX_BANKED_CHILDREN } from '../../src/core/spawner-arena.js';
import { createTestWorld } from '../helpers/world-factory.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

function makeSpawnerFixture() {
  const world = createTestWorld();
  const spawnerEid = spawnSpawner(world, 100, 100, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
    arenaRadiusFt: RATS_NEST.arenaRadiusFt,
  });
  return { world, spawnerEid };
}

function killOwnedChild(
  world: ReturnType<typeof createTestWorld>,
  spawnerEid: number,
  x = 120,
  y = 120,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 10, AI_TYPE.CHASE, 1, 200, 0);
  addComponent(world.ecs, eid, set(Owner, { eid: spawnerEid }));
  setComponent(world.ecs, eid, Health, { current: 0, max: 10 });
  return eid;
}

function xpGemCount(world: ReturnType<typeof createTestWorld>): number {
  return query(world.ecs, [XpGem, Position]).length;
}

describe('dropSystem — spawner-owned XP intercept', () => {
  it('banks XP on the owner and spawns no XpGem for a spawner-owned kill', () => {
    const { world, spawnerEid } = makeSpawnerFixture();
    const before = xpGemCount(world);
    killOwnedChild(world, spawnerEid);
    dropSystem(world);
    // No XpGem spawned.
    expect(xpGemCount(world)).toBe(before);
    // Bank grew by >= 1 XP (BASIC_MELEE guarantees ≥1 XP drop).
    expect(world.stores.spawner.bankedXp[spawnerEid] ?? 0).toBeGreaterThan(0);
    expect(world.stores.spawner.bankedChildren[spawnerEid] ?? 0).toBe(1);
  });

  it('spawns XP gems normally for a non-owned enemy kill', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 50, 60, 10);
    setComponent(world.ecs, enemy, Health, { current: 0, max: 10 });
    const before = xpGemCount(world);
    dropSystem(world);
    // Non-owned kill produced at least one XpGem — spawn count grew.
    expect(xpGemCount(world)).toBeGreaterThan(before);
  });

  it('caps banking at SPAWNER_MAX_BANKED_CHILDREN but keeps XP suppressed beyond the cap', () => {
    const { world, spawnerEid } = makeSpawnerFixture();
    // First 10 kills: banked, no XpGem.
    for (let i = 0; i < SPAWNER_MAX_BANKED_CHILDREN; i += 1) {
      // Advance the frame so processedDeaths tracking doesn't dedupe.
      world.frameCount += 1;
      killOwnedChild(world, spawnerEid, 120 + i, 120);
      dropSystem(world);
    }
    expect(world.stores.spawner.bankedChildren[spawnerEid] ?? 0).toBe(SPAWNER_MAX_BANKED_CHILDREN);
    const bankedAtCap = world.stores.spawner.bankedXp[spawnerEid] ?? 0;
    expect(bankedAtCap).toBeGreaterThan(0);
    const gemsAtCap = xpGemCount(world);
    // No owned kill ever produced an on-map XP gem, even the banked ones.
    expect(gemsAtCap).toBe(0);

    // Kills 11–15 (beyond the cap): the bank must NOT grow, and — per
    // requirement 4 — NO XP gems may appear. The cap only limits banked XP,
    // it must never re-enable on-map XP drops for spawner-owned children.
    for (let i = 0; i < 5; i += 1) {
      world.frameCount += 1;
      killOwnedChild(world, spawnerEid, 200 + i, 200);
      dropSystem(world);
    }
    expect(world.stores.spawner.bankedChildren[spawnerEid] ?? 0).toBe(SPAWNER_MAX_BANKED_CHILDREN);
    expect(world.stores.spawner.bankedXp[spawnerEid] ?? 0).toBe(bankedAtCap);
    // Requirement 4: zero XP gems from any spawner-owned kill, cap or no cap.
    expect(xpGemCount(world)).toBe(gemsAtCap);
    expect(xpGemCount(world)).toBe(0);
  });

  it('does not touch the bank when the owner is not a Spawner', () => {
    // An Owner component pointing at a non-spawner entity should NOT trigger
    // the intercept path — an Owner is a generic "who spawned me" pointer.
    const world = createTestWorld();
    const dummyOwner = spawnEnemy(world, 10, 10, 100);
    const child = spawnBehaviorEnemy(world, 50, 50, 10, AI_TYPE.CHASE, 1, 200, 0);
    addComponent(world.ecs, child, set(Owner, { eid: dummyOwner }));
    setComponent(world.ecs, child, Health, { current: 0, max: 10 });
    const before = xpGemCount(world);
    dropSystem(world);
    // Normal loot roll → XpGem appears (BASIC_MELEE has 100% XP chance).
    expect(xpGemCount(world)).toBeGreaterThan(before);
  });

  it('does not bank XP when Floor-1 drop gating is active', () => {
    // Reviewer finding: the arena must not smuggle XP through the pre-Welcome
    // Office onboarding gate. The user's verbatim requirement is "equal to
    // the amount that would have dropped from killing the number of spawned
    // mobs" — when drops are gated to 0, the bank should also stay at 0.
    const { world, spawnerEid } = makeSpawnerFixture();
    // Attach a floor1 context so `allowFloorDrops` gates on the goal flag.
    world.floorScenario = { enemyArchetypes: new Map() } as typeof world.floorScenario;
    // goalFlag `floor1-drops-unlocked` is unset → allowFloorDrops = false.
    killOwnedChild(world, spawnerEid);
    const gemsBefore = xpGemCount(world);
    dropSystem(world);
    // No bank growth and no XP gems — the whole XP economy is suppressed.
    expect(world.stores.spawner.bankedXp[spawnerEid] ?? 0).toBe(0);
    expect(world.stores.spawner.bankedChildren[spawnerEid] ?? 0).toBe(0);
    expect(xpGemCount(world)).toBe(gemsBefore);
  });
});
