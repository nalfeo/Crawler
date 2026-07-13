/**
 * Arena lock-in integration — verifies the BT AI prioritizes and kills a
 * locked spawner within a bounded step budget when it enters the arena.
 *
 * This is the "observe before done" gate for the arena-lock-in priority
 * slot (ADR 0045). The pure detector is unit-tested in
 * `tests/unit/ai/arena-lockin.test.ts`, and the BT priority selection is
 * unit-tested in `tests/unit/ai/bt-arena-lockin-priority.test.ts`. Here we
 * drive the real headless AI simulation step (`src/game/ai/simulation-step`)
 * on a hand-built world with one locked spawner in radius of the player and
 * assert:
 *
 *   1. The AI targets the spawner immediately (decision.targetEid = spawner).
 *   2. Within a bounded number of ticks, the spawner is dead and the arena
 *      transitions to `arenaState === 2` (resolved).
 *
 * A regression that reverts the priority (or breaks the detector) leaves
 * the AI wandering to its progression goal and the arena stays locked
 * forever — this test catches that in a few hundred milliseconds.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { spawnPlayer, spawnSpawner } from '../../src/core/spawners/combatants.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { GAME } from '../../src/shared/constants.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

describe('AI arena lock-in — integration', () => {
  it('AI prioritizes and kills a locked spawner within a bounded step budget', () => {
    const world = createTestWorld({ seed: 1 });
    const playerEid = spawnPlayer(world, 0, 0);
    world.stores.health.current[playerEid] = 100;
    world.stores.health.max[playerEid] = 100;
    setActiveWeapon(world, getWeaponDef('sword')!);

    // Locked spawner just inside melee range so the AI can strike it every
    // few frames without needing pathfinding to close the gap. The test's
    // point is *priority selection*, not travel efficiency — the AI must
    // commit to the spawner even though there is no other target.
    const spawnerEid = spawnSpawner(world, 4, 0, RATS_NEST.hp, {
      defIndex: RATS_NEST_INDEX,
      contactDamage: RATS_NEST.contactDamage,
      arenaRadiusFt: 8,
    });
    world.stores.spawner.arenaState[spawnerEid] = 1; // locked
    world.stores.spawner.arenaKind[spawnerEid] = 1; // open-fence
    // Mirror createRingWallBarrier's ANALYTIC ring-WALL handle (tiles:[] + a
    // BarrierRingShape) so the detector treats this as a real barrier the AI
    // cannot walk out of (see arena-lockin.ts) — matches the open-fence runtime.
    world.spawnerArenaBarriers.set(spawnerEid, {
      id: 1,
      kind: 'fence',
      tiles: [],
      shape: { type: 'ring', cxFt: 4, cyFt: 0, innerRadiusFt: 7, outerRadiusFt: 8 },
    });
    // Transition the world past 'menu' so runSimulationStep executes. The
    // integration harness uses the exact state values createGameWorld emits
    // before `selectFloor1StarterWeapon` flips them to `'playing'`.
    world.state = 'playing';

    const ai = new BehaviorTreeAI({ seed: 1 });
    const input = createInputState();

    // Use canonical preSystems (single source of truth, issue #663). Systems
    // that require world.floorScenario (floor1EnemyDirectorSystem etc.) are
    // no-ops on this minimal world; spawnerArenaSystem is required to transition
    // arenaState → 2 after the spawner's HP reaches 0.
    const { preSystems } = createFloor1MainSceneOptions();

    // First tick: the priority selector must choose the spawner.
    ai.poll(input, world);
    expect(ai.getDecision().targetEid).toBe(spawnerEid);
    expect(ai.getDecision().reason.toLowerCase()).toContain('arena');

    // Full loop — advance the sim while the AI drives inputs. Budget is
    // generous (60s of simulated game time) because we want the assertion
    // to be a signal for "AI actually engages", not "AI is optimal".
    const MAX_FRAMES = Math.ceil((60 * 1000) / GAME.DELTA_MS);
    let resolvedFrame = -1;
    for (let f = 0; f < MAX_FRAMES; f += 1) {
      ai.poll(input, world);
      runSimulationStep(world, input, GAME.DELTA_MS, { preSystems });
      if (world.stores.spawner.arenaState[spawnerEid] === 2) {
        resolvedFrame = f;
        break;
      }
    }
    expect(resolvedFrame).toBeGreaterThan(-1);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect((world.stores.health.current[spawnerEid] ?? 0) <= 0).toBe(true);
  });
});
