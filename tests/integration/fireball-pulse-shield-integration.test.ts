/**
 * Fireball & Pulse Shield auto-trigger — visual-pipeline integration guard.
 *
 * The isolated `abilitySystem` tests (`tests/game/ability-system.test.ts`) prove
 * the trigger predicates fire under textbook conditions, but users reported that
 * neither spell ever activates in real Floor 1 gameplay. That gap is precisely
 * the class of bug the spawner integration test in this folder was written for:
 * a system that works in isolation but is starved by something in the real
 * pipeline (init order, position units, state gating, feature flags…).
 *
 * This test drives the SHIPPED VISUAL PIPELINE end-to-end via
 * `createFloor1MainSceneOptions()` and the engine `runSimulationStep`, initializes
 * a real Floor 1 scenario, unlocks the spell using the same
 * `selectSpellFromBossBattle` codepath the boss-reward modal calls, spawns a
 * live enemy right next to the player, and asserts the ability actually
 * triggers within a handful of frames.
 */
import { addComponent, addEntity, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Enemy,
  Health,
  Position,
  Velocity,
  Weight,
  createGameWorld,
  spawnPlayer,
  type GameWorld,
} from '../../src/core/index.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
  selectSpellFromBossBattle,
} from '../../src/game/index.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';

function createPlayingFloor1World(seed: number): { world: GameWorld; playerEid: number } {
  const world = createGameWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, playerEid);
  selectFloor1StarterWeapon(world, 0);
  return { world, playerEid };
}

/**
 * Plant a stationary training-dummy enemy `offsetFt` feet to the +x side of the
 * player (coordinates are feet-space, see src/shared/units.ts), with high HP
 * (500) so the melee weapon doesn't finish it before the trigger check runs. We
 * spawn directly (not via the enemy AI catalog) so we get an entity that stays
 * still, has zero attack range, and only exercises the ability trigger radius.
 */
function spawnStationaryEnemyNearPlayer(
  world: GameWorld,
  playerEid: number,
  offsetFt: number,
): number {
  const playerXFt = world.stores.position.x[playerEid] ?? 0;
  const playerYFt = world.stores.position.y[playerEid] ?? 0;
  // Reuse the raw ECS setup used by combatants.spawnEnemy so we don't drag in
  // AI / spawn-anim components — this dummy just needs Position + Enemy + Health.
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: playerXFt + offsetFt, y: playerYFt }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 500, max: 500 }));
  addComponent(world.ecs, eid, set(Weight, { value: 120 }));
  addComponent(world.ecs, eid, Enemy);
  return eid;
}

function stepVisualPipeline(
  world: GameWorld,
  options: ReturnType<typeof createFloor1MainSceneOptions>,
  frames: number,
): void {
  const input = createInputState();
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += GAME.DELTA_MS;
    runSimulationStep(world, input, {
      preSystems: options.preSystems,
      postSystems: options.postSystems,
    });
  }
}

describe('Fireball auto-triggers in the shipped visual pipeline', () => {
  it('fires within seconds when an enemy is next to the player after boss-reward pick', () => {
    const { world, playerEid } = createPlayingFloor1World(7);
    const options = createFloor1MainSceneOptions();

    // Simulate boss defeat + the player's pick from the spell-selection modal.
    world.goalFlags.set('floor1-boss-battle-complete', true);
    const learned = selectSpellFromBossBattle(world, playerEid, 'fireball');
    expect(learned).toBe(true);
    expect(world.featureUnlocks.spells).toBe(true);
    const state = world.abilityStatesByEntity.get(playerEid);
    expect(state?.equippedActiveAbilityIds).toContain('fireball');

    const dummyEid = spawnStationaryEnemyNearPlayer(world, playerEid, 3);
    // Confirm the training dummy is a live, queryable enemy (Enemy + Position +
    // Health) so the fireball has a real target. The earlier assertion queried
    // [Enemy, Position, Health, Player] — which no entity ever matches, since an
    // entity is never both Enemy and Player — and asserted `.length >= 0`, a
    // tautology that verified nothing.
    expect([...query(world.ecs, [Enemy, Position, Health])]).toContain(dummyEid);

    // Fireball's trigger is enemy_cluster (withinFeet=6, minEnemies=1) with no
    // cooldown history yet, so it should latch on the very first frame the
    // abilitySystem sees the dummy. Give it a small budget in case some other
    // preSystem needs a frame to initialize (statsSystem, manaSystem).
    stepVisualPipeline(world, options, 5);

    const cooldownFrame = state?.cooldownByAbilityId.get('fireball');
    expect(cooldownFrame).toBeDefined();
    expect(cooldownFrame).toBeGreaterThan(0);
    // The user reported "I never saw the fireball cooldown bar trigger". That
    // was VFX-blindness (no cast visual). Guard the fix here: the fireball
    // blast VFX must land on the world.vfxEvents queue as the abilitySystem
    // runs inside the shipped pipeline, so `EffectsVfx` can render it.
    const blasts = world.vfxEvents.filter((e) => e.kind === 'fireballBlast');
    expect(blasts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Pulse Shield auto-triggers in the shipped visual pipeline', () => {
  it('fires when the player is at low HP surrounded by 3 enemies within 5 ft', () => {
    const { world, playerEid } = createPlayingFloor1World(11);
    const options = createFloor1MainSceneOptions();

    world.goalFlags.set('floor1-boss-battle-complete', true);
    const learned = selectSpellFromBossBattle(world, playerEid, 'pulse-shield');
    expect(learned).toBe(true);
    expect(world.featureUnlocks.spells).toBe(true);

    // Step one frame FIRST so floor1PlayerStatSystem latches its one-shot HP
    // bonus (it forces current=max on its first run) before we drop the player
    // to low HP. In real gameplay the bonus latches on frame 1 of the scenario,
    // long before any boss fight leaves the player wounded.
    stepVisualPipeline(world, options, 1);

    // low_health_crowded needs HP < 50% and 3+ enemies within 5 ft.
    const maxHp = world.stores.health.max[playerEid] ?? 100;
    setComponent(world.ecs, playerEid, Health, {
      current: Math.floor(maxHp * 0.25),
      max: maxHp,
    });
    spawnStationaryEnemyNearPlayer(world, playerEid, 2);
    spawnStationaryEnemyNearPlayer(world, playerEid, -2);
    spawnStationaryEnemyNearPlayer(world, playerEid, 3);

    stepVisualPipeline(world, options, 5);

    const state = world.abilityStatesByEntity.get(playerEid);
    const cooldownFrame = state?.cooldownByAbilityId.get('pulse-shield');
    expect(cooldownFrame).toBeDefined();
    expect(cooldownFrame).toBeGreaterThan(0);
    // Same visibility guard as fireball above — the pulse-shield wave VFX must
    // land on the queue during a shipped-pipeline auto-cast.
    const waves = world.vfxEvents.filter((e) => e.kind === 'pulseShieldWave');
    expect(waves.length).toBeGreaterThanOrEqual(1);
  });
});
