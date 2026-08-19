import { addComponent, query, hasComponent, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  DroppedItem,
  Enemy,
  EnemyBehavior,
  Gold,
  Health,
  Invincible,
  MeleeSwing,
  Position,
  Spawner,
  SpawnAnim,
  Size,
  Sprite,
  XpGem,
} from '../../src/core/components.js';
import {
  createEntity,
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnPlayer,
} from '../../src/core/helpers.js';
import { dropSystem, MINI_SLIME_COLLISION_EPSILON } from '../../src/core/systems/dropSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { MeleeStyle, TeamId } from '../../src/shared/constants.js';
import { spawnMeleeSwing } from '../../src/core/spawners/melee.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { AI_TYPE } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../src/shared/spawn-anim.js';
import type { EntitySpriteMappings } from '../../src/shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';

// 64 deterministic seeds gives ample headroom to find at least one 35% split roll
// without making the regression test search unbounded.
const MAX_SPLIT_BABY_SLIME_SEED_ATTEMPTS = 64;
const babySlimeTextureId = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).enemies.enemy_baby_slime
  ?.textureId;
if (babySlimeTextureId === undefined) {
  throw new Error('Missing enemy_baby_slime texture id in entity sprite mappings fixture.');
}

function setupSplitBabySlimeWorld(unlockedDrops = false): {
  world: ReturnType<typeof createTestWorld>;
  miniSlimes: number[];
} {
  for (let seed = 1; seed <= MAX_SPLIT_BABY_SLIME_SEED_ATTEMPTS; seed += 1) {
    const world = createTestWorld({ seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    if (unlockedDrops) {
      meetTutorialGoon(world);
    }

    const slime = spawnBehaviorEnemy(world, 100, 120, 30, AI_TYPE.LEAPER, 0.9, 320, 0);
    world.floorScenario?.enemyArchetypes.set(slime, 'slime');
    setComponent(world.ecs, slime, Damage, { amount: 7 });
    setComponent(world.ecs, slime, Health, { current: 0, max: 30 });
    dropSystem(world, { spawnLoot: false });

    const miniSlimes = Array.from(query(world.ecs, [Enemy, Health])).filter(
      (eid) => eid !== slime && !hasComponent(world.ecs, eid, Spawner),
    );
    if (miniSlimes.length === 2) {
      return { world, miniSlimes };
    }
  }

  throw new Error('Expected a deterministic seed that produces two split baby slimes');
}

describe('dropSystem', () => {
  it('spawns loot when an enemy dies', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    // Kill the enemy
    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);

    // BASIC_MELEE table always drops XP (chance 1.0)
    const gems = query(world.ecs, [XpGem, Position]);
    expect(gems.length).toBeGreaterThanOrEqual(1);
  });

  it('uses the configured Floor 2 encounter loot table for family bosses', () => {
    const world = createTestWorld({ floor: 2 });
    const bossEid = spawnEnemy(world, 100, 200, 10);
    const familyId = asFamilyId('geese');
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [familyId],
        contestedResource: asResourceId('gold-veins'),
        betrayerFlag: false,
        bossEncounters: new Map([
          [
            familyId,
            {
              familyId,
              roomId: 1,
              doorEids: [],
              activeGoalId: 'boss-active',
              started: true,
              bossEid,
              defeated: false,
              displayName: 'Goose Boss',
              lootTableId: 'boss',
            },
          ],
        ]),
      },
    };
    setComponent(world.ecs, bossEid, Health, { current: 0, max: 10 });

    dropSystem(world);

    expect(query(world.ecs, [XpGem]).length).toBeGreaterThanOrEqual(10);
    expect(query(world.ecs, [Gold]).length).toBeGreaterThanOrEqual(20);
  });

  it('emits a death combat event', () => {
    const world = createTestWorld();
    const playerEid = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 50, 60, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    world.combatEvents.push({
      type: 'hit',
      x: 50,
      y: 60,
      amount: 10,
      targetType: 'enemy',
      timestamp: 0,
      targetEid: eid,
      sourceEid: playerEid,
      sourceX: 0,
      sourceY: 0,
    });
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents.length).toBe(1);
    expect(deathEvents[0]!.x).toBe(50);
    expect(deathEvents[0]!.y).toBe(60);
    expect(deathEvents[0]!.overkill).toBe(0);
    expect(deathEvents[0]!.targetType).toBe('enemy');
    expect(deathEvents[0]!.sourceEid).toBe(playerEid);
  });

  it('authors larger blood pools for larger enemy bodies', () => {
    const createPoolForRadius = (radiusFt: number) => {
      const world = createTestWorld({ seed: 42 });
      const eid = spawnEnemy(world, 50, 60, 10);
      setComponent(world.ecs, eid, Size, {
        radius: radiusFt,
        halfWidth: 0,
        halfHeight: 0,
        shape: world.stores.size.shape[eid] ?? 0,
      });
      setComponent(world.ecs, eid, Health, { current: 0, max: 10 });
      dropSystem(world, { spawnLoot: false });
      return world.bloodPools[0];
    };

    const smallPool = createPoolForRadius(0.5);
    const largePool = createPoolForRadius(2);
    expect(smallPool).toBeDefined();
    expect(largePool).toBeDefined();
    expect(largePool!.contactRadiusFt).toBeGreaterThan(smallPool!.contactRadiusFt);
  });

  it('does not double-process the same entity', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);
    const firstCount = world.combatEvents.filter((e) => e.type === 'death').length;

    dropSystem(world);
    const secondCount = world.combatEvents.filter((e) => e.type === 'death').length;

    expect(secondCount).toBe(firstCount);
  });

  it('does not spawn drops for living enemies', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    dropSystem(world);

    const gems = query(world.ecs, [XpGem]);
    const golds = query(world.ecs, [Gold]);
    expect(gems.length).toBe(0);
    expect(golds.length).toBe(0);
    expect(world.combatEvents.filter((e) => e.type === 'death').length).toBe(0);
  });

  it('uses deterministic drops with seeded RNG', () => {
    function runDrop(seed: number) {
      const world = createTestWorld({ seed });
      spawnEnemy(world, 100, 200, 10);
      const enemies = query(world.ecs, [Enemy]);
      setComponent(world.ecs, enemies[0] as number, Health, { current: 0, max: 10 });
      dropSystem(world);
      return {
        gems: query(world.ecs, [XpGem]).length,
        golds: query(world.ecs, [Gold]).length,
        events: world.combatEvents.length,
      };
    }

    const run1 = runDrop(42);
    const run2 = runDrop(42);
    expect(run1).toEqual(run2);
  });

  it('can suppress loot while preserving death linger timing', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world, { spawnLoot: false, deathLingerMs: 900 });

    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(world.stores.deathTimer.remainingMs[eid]).toBe(900);
    expect(query(world.ecs, [DeathTimer])).toContain(eid);
    expect(world.combatEvents.filter((event) => event.type === 'death')).toHaveLength(1);
  });

  it('suppresses ALL floor1 drops (gold, xp, junk) until the tutorial goon unlocks them', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    // Before meeting the Tutorial Goon, nothing the enemies drop should appear.
    // (The merchant's fetch item is spawned at init, so measure deltas.)
    const itemsAtInit = query(world.ecs, [DroppedItem]).length;
    const lockedEnemy = spawnEnemy(world, 100, 200, 10);
    setComponent(world.ecs, lockedEnemy, Health, { current: 0, max: 10 });
    dropSystem(world);
    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(query(world.ecs, [DroppedItem]).length).toBe(itemsAtInit);

    // Finding the Welcome Office and meeting the Goon unlocks drops.
    meetTutorialGoon(world);
    expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);

    for (let i = 0; i < 4; i++) {
      const unlockedEnemy = spawnEnemy(world, 140 + i * 8, 220 + i * 8, 10);
      setComponent(world.ecs, unlockedEnemy, Health, { current: 0, max: 10 });
      dropSystem(world);
    }
    expect(query(world.ecs, [XpGem]).length).toBeGreaterThanOrEqual(1);
    expect(query(world.ecs, [Gold]).length).toBeGreaterThanOrEqual(1);
  });

  it('gives dead slimes a 50% split roll to spawn two mini slimes with half health and strength', () => {
    let world: ReturnType<typeof createTestWorld> | null = null;
    let slainSlime = -1;
    let miniSlimes: number[] = [];

    for (let seed = 1; seed <= 64; seed += 1) {
      const candidate = createTestWorld({ seed });
      const player = spawnPlayer(candidate, 0, 0);
      initializeFloor1Scenario(candidate, player);
      selectFloor1StarterWeapon(candidate, 0);

      const slime = spawnBehaviorEnemy(candidate, 100, 120, 30, AI_TYPE.LEAPER, 0.9, 320, 0);
      candidate.floorScenario?.enemyArchetypes.set(slime, 'slime');
      setComponent(candidate.ecs, slime, Damage, { amount: 7 });
      setComponent(candidate.ecs, slime, Health, { current: 0, max: 30 });

      dropSystem(candidate, { spawnLoot: false });
      const enemies = query(candidate.ecs, [Enemy, Health]);
      const minis = Array.from(enemies).filter(
        (eid) => eid !== slime && !hasComponent(candidate.ecs, eid, Spawner),
      );
      if (minis.length === 2) {
        world = candidate;
        slainSlime = slime;
        miniSlimes = minis;
        break;
      }
    }

    expect(world).not.toBeNull();
    if (!world) {
      return;
    }

    expect(slainSlime).toBeGreaterThan(0);
    expect(miniSlimes).toHaveLength(2);
    const expectedMiniDamage = Math.max(1, Math.round(7 * 0.5));
    const slainSlimeWeight = world.stores.weight.value[slainSlime] ?? 120;
    for (const miniEid of miniSlimes) {
      expect(world.stores.health.max[miniEid]).toBe(15);
      expect(world.stores.health.current[miniEid]).toBe(15);
      expect(world.stores.damage.amount[miniEid]).toBe(expectedMiniDamage);
      expect(world.floorScenario?.enemyArchetypes.get(miniEid)).toBe('slime-mini');
      expect(world.enemyAppearanceKeys.get(miniEid)).toBe('slime-mini');
      expect(world.stores.weight.value[miniEid]).toBeCloseTo(slainSlimeWeight * 0.5, 4);
      expect(world.stores.enemyBehavior.type[miniEid]).toBe(AI_TYPE.LEAPER);
      // Babies render smaller than their 2 ft parent, and the feet-scale size is
      // preserved exactly (0.65×) rather than rounded up to a whole foot.
      expect(hasComponent(world.ecs, miniEid, Sprite)).toBe(true);
      expect(world.stores.sprite.textureId[miniEid]).toBe(babySlimeTextureId);
      expect(world.stores.sprite.width[miniEid]).toBeCloseTo(2 * 0.65);
      expect(world.stores.sprite.height[miniEid]).toBeCloseTo(2 * 0.65);
      expect(world.stores.sprite.width[miniEid]).not.toBe(1);
      // Babies pop in with a cosmetic spawn animation but are NOT time-invulnerable;
      // they survive only their parent's killing swing (see swing-immunity test below).
      expect(hasComponent(world.ecs, miniEid, SpawnAnim)).toBe(true);
      expect(hasComponent(world.ecs, miniEid, Invincible)).toBe(false);
      expect(world.stores.spawnAnim.remainingMs[miniEid]).toBe(MINI_SLIME_SPAWN_ANIM_MS);
      expect(world.stores.spawnAnim.totalMs[miniEid]).toBe(MINI_SLIME_SPAWN_ANIM_MS);
    }
    expect(query(world.ecs, [EnemyBehavior])).toContain(slainSlime);
  });

  it('never spawns a split baby slime with its footprint inside a wall', () => {
    // Regression test for a dev-build report of a baby slime spawning stuck in
    // a wall: place the parent slime immediately east of a wall column so the
    // unclamped ~1.5-3.5 ft ejection offset can land a baby inside it. Some
    // seeds roll an ejection angle/distance that never reaches the wall, so we
    // must check several seeds (not just the first split) to exercise the
    // footprint-avoidance retry — this reproduces on the un-fixed code at
    // seeds 2 and 3 within this small budget.
    const WALL_ADJACENT_SEED_ATTEMPTS = 10;
    let sawAnySplit = false;

    for (let seed = 1; seed <= WALL_ADJACENT_SEED_ATTEMPTS; seed += 1) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);

      const wallMap = makeWalledMap();
      world.floorMap = wallMap;
      const tileSizeFt = wallMap.config.tileSizeFt;
      // Wall column sits at tile x=5 ([160, 192) ft); spawn just east of it in
      // the adjacent floor tile so babies can be ejected toward the wall.
      const slimeX = 6 * tileSizeFt + 1;
      const slimeY = 4 * tileSizeFt + tileSizeFt / 2;

      const slime = spawnBehaviorEnemy(world, slimeX, slimeY, 30, AI_TYPE.LEAPER, 0.9, 320, 0);
      world.floorScenario?.enemyArchetypes.set(slime, 'slime');
      setComponent(world.ecs, slime, Damage, { amount: 7 });
      setComponent(world.ecs, slime, Health, { current: 0, max: 30 });

      dropSystem(world, { spawnLoot: false });

      const miniSlimes = Array.from(query(world.ecs, [Enemy, Health])).filter(
        (eid) => eid !== slime && !hasComponent(world.ecs, eid, Spawner),
      );
      if (miniSlimes.length === 0) continue;
      sawAnySplit = true;

      for (const miniEid of miniSlimes) {
        const mx = world.stores.position.x[miniEid] ?? 0;
        const my = world.stores.position.y[miniEid] ?? 0;
        const halfWidth = (world.stores.sprite.width[miniEid] ?? 0) / 2;
        const halfHeight = (world.stores.sprite.height[miniEid] ?? 0) / 2;
        // Mirror the exact inset `isMiniSlimeSpawnPassable` applies so this
        // assertion checks the same invariant the production code enforces.
        const left = mx - halfWidth + MINI_SLIME_COLLISION_EPSILON;
        const right = mx + halfWidth - MINI_SLIME_COLLISION_EPSILON;
        const top = my - halfHeight + MINI_SLIME_COLLISION_EPSILON;
        const bottom = my + halfHeight - MINI_SLIME_COLLISION_EPSILON;
        expect(wallMap.isPassableAt(left, top)).toBe(true);
        expect(wallMap.isPassableAt(right, top)).toBe(true);
        expect(wallMap.isPassableAt(left, bottom)).toBe(true);
        expect(wallMap.isPassableAt(right, bottom)).toBe(true);
      }
    }

    expect(sawAnySplit).toBe(true);
  });

  it('baby slimes survive the melee swing that killed their parent, then die to a fresh swing', () => {
    let world: ReturnType<typeof createTestWorld> | null = null;
    let miniSlimes: number[] = [];

    // A wide-area stab centred on the parent, standing in for the swing that just
    // landed the killing blow. It is still active the frame the babies spawn.
    const addKillingSwing = (w: ReturnType<typeof createTestWorld>): number => {
      const swing = createEntity(w);
      addComponent(w.ecs, swing, set(Position, { x: 100, y: 120 }));
      addComponent(
        w.ecs,
        swing,
        set(MeleeSwing, {
          bladeLength: 0,
          arcCenterRad: 0,
          arcHalfRad: 0,
          damage: 5,
          spawnAtMs: w.elapsedMs,
          durationMs: 1000,
          style: MeleeStyle.STAB,
          headRadius: 48,
          shaftDamageMult: 1,
          knockback: 0,
        }),
      );
      return swing;
    };

    for (let seed = 1; seed <= 64; seed += 1) {
      const candidate = createTestWorld({ seed });
      const player = spawnPlayer(candidate, 0, 0);
      initializeFloor1Scenario(candidate, player);
      selectFloor1StarterWeapon(candidate, 0);

      const slime = spawnBehaviorEnemy(candidate, 100, 120, 30, AI_TYPE.LEAPER, 0.9, 320, 0);
      candidate.floorScenario?.enemyArchetypes.set(slime, 'slime');
      setComponent(candidate.ecs, slime, Damage, { amount: 7 });
      setComponent(candidate.ecs, slime, Health, { current: 0, max: 30 });

      // The killing swing must already exist when the split runs so the babies get
      // registered into its hit set.
      addKillingSwing(candidate);
      dropSystem(candidate, { spawnLoot: false });

      const minis = Array.from(query(candidate.ecs, [Enemy, Health])).filter(
        (eid) => eid !== slime && !hasComponent(candidate.ecs, eid, Spawner),
      );
      if (minis.length === 2) {
        world = candidate;
        miniSlimes = minis;
        break;
      }
    }

    expect(world).not.toBeNull();
    if (!world) {
      return;
    }
    expect(miniSlimes).toHaveLength(2);

    // The killing swing is still active, but the freshly-spawned babies were
    // registered in its hit set, so it passes straight through them.
    meleeSwingSystem(world);
    for (const miniEid of miniSlimes) {
      expect(world.stores.health.current[miniEid]).toBe(15);
    }

    // The player swings again — a brand-new swing entity with an empty hit set —
    // and now the babies take the hit. Exact damage depends on each baby's split
    // offset (head vs. shaft of the stab), which varies by seed, so assert the
    // behavioural invariant: they were untouched above and take real damage now.
    addKillingSwing(world);
    meleeSwingSystem(world);
    for (const miniEid of miniSlimes) {
      expect(world.stores.health.current[miniEid]).toBeLessThan(15);
      expect(world.stores.health.current[miniEid]).toBeGreaterThan(0);
    }
  });

  it('suppresses split baby slime drops until the floor1 tutorial unlocks drops', () => {
    const { world, miniSlimes } = setupSplitBabySlimeWorld();

    const itemsAtInit = query(world.ecs, [DroppedItem]).length;
    for (const miniEid of miniSlimes) {
      setComponent(world.ecs, miniEid, Health, {
        current: 0,
        max: world.stores.health.max[miniEid],
      });
    }

    dropSystem(world);

    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(query(world.ecs, [DroppedItem]).length).toBe(itemsAtInit);
  });

  it('still suppresses split baby slime drops after the floor1 tutorial unlock', () => {
    const { world, miniSlimes } = setupSplitBabySlimeWorld(true);
    const itemsAtInit = query(world.ecs, [DroppedItem]).length;

    for (const miniEid of miniSlimes) {
      setComponent(world.ecs, miniEid, Health, {
        current: 0,
        max: world.stores.health.max[miniEid],
      });
    }

    dropSystem(world);

    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(query(world.ecs, [DroppedItem]).length).toBe(itemsAtInit);
  });
});

describe('meleeSwingSystem lethal-hit kill attribution', () => {
  it('retains player EID as sourceEid in the death event after a lethal melee hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // HP=1 so the 15-damage melee hit is lethal; place enemy at (2, 0) within blade reach
    const enemy = spawnEnemy(world, 2, 0, 1);
    // Spawn the swing at t=0; at progress=0.5 (t=500ms) the 360-degree slash sweeps
    // to the right (angle=0) so the blade from (0,0) to (4,0) covers the enemy at (2,0).
    world.elapsedMs = 0;
    spawnMeleeSwing(world, 0, 0, player, 15, 4, 1000, 1, 0, 360, TeamId.PLAYER, MeleeStyle.SLASH);
    world.elapsedMs = 500; // progress = 0.5 → blade tip at (4, 0) → enemy at (2, 0) on segment

    // No collisionResult provided — meleeSwingSystem falls back to the full scan
    meleeSwingSystem(world);
    // Enemy HP should now be ≤ 0
    expect(world.stores.health.current[enemy] ?? 1).toBeLessThanOrEqual(0);

    dropSystem(world, { spawnLoot: false });

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents).toHaveLength(1);
    expect(deathEvents[0]!.sourceEid).toBe(player);
  });
});
