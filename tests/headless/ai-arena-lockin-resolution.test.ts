/**
 * Arena lock-in resolution sweep — asserts the BT AI clears a
 * barrier-armed spawner arena within a bounded step budget across multiple
 * deterministic seeds.
 *
 * The user's caveat from PR #764 was that the AI would walk past a
 * triggered arena without engaging. The natural Floor-1 sweep in
 * `spawner-arena-win-rate.test.ts` reports the metric but currently
 * observes 0 barrier-armed arenas (Floor-1 spawner placement produces
 * empty fence rings and roomless doors — see ADR 0045 §Semantics). This
 * gate side-steps that by *hand-arming* a barrier around a rats-nest
 * spawner in a minimal test world for each seed and asserts every one
 * resolves. Together with the natural sweep it covers both halves:
 *
 *   - Natural: "the priority slot doesn't regress the win-rate floor."
 *   - Synthetic (this file): "when the AI IS trapped, it fights and wins
 *     ≥95% of the time."
 *
 * The user's requirement was quoted verbatim in the PR body — the two
 * halves together are the observable "AI knows it is stuck AND
 * prioritizes the objective" contract.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { AIState } from '../../src/game/ai/types.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { spawnEnemy, spawnPlayer, spawnSpawner } from '../../src/core/spawners/combatants.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

/** How many game seconds we give the AI to clear a hand-armed arena. */
const RESOLUTION_BUDGET_SEC = 60;
const RESOLUTION_BUDGET_FRAMES = Math.ceil((RESOLUTION_BUDGET_SEC * 1000) / GAME.DELTA_MS);

/** Deterministic seed prefix, same shape as `spawner-arena-win-rate.test.ts`. */
const SAMPLE_SEEDS = Array.from({ length: 8 }, (_, i) => i + 1) as readonly number[];

function runOneArena(
  seed: number,
  options: { lowHealthWithPressure?: boolean } = {},
): {
  resolved: boolean;
  frames: number;
  reason: string;
  retreatFrames: number;
} {
  const world = createTestWorld({ seed });
  const playerEid = spawnPlayer(world, 0, 0);
  if (options.lowHealthWithPressure === true) {
    world.stores.health.current[playerEid] = 1000;
    world.stores.health.max[playerEid] = 10000;
    spawnEnemy(world, 3, 0, 1);
  } else {
    // Give the player a generous HP pool because this synthetic fixture
    // mirrors lock-in detection but does not install full gameplay/map
    // pacing context. The test's contract is lock-in objective resolution
    // across seeds, not balance-pressure survivability tuning.
    world.stores.health.current[playerEid] = 1000;
    world.stores.health.max[playerEid] = 1000;
  }
  setActiveWeapon(world, getWeaponDef('sword')!);

  // Place the spawner just outside the player's melee gate so the run
  // exercises the "close-in then kite" path, not "already touching".
  const spawnerEid = spawnSpawner(world, 5, 0, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
    arenaRadiusFt: 8,
  });
  world.stores.spawner.arenaState[spawnerEid] = 1; // locked
  world.stores.spawner.arenaKind[spawnerEid] = 1; // open-fence
  // Mirror createRingWallBarrier's ANALYTIC ring-WALL handle (tiles:[] + a
  // BarrierRingShape) so the detector treats the arena as a real barrier —
  // matches spawnerArenaSystem's post-lock open-fence state.
  world.spawnerArenaBarriers.set(spawnerEid, {
    id: 1,
    kind: 'fence',
    tiles: [],
    shape: { type: 'ring', cxFt: 5, cyFt: 0, innerRadiusFt: 7, outerRadiusFt: 8 },
  });
  world.state = 'playing';

  const ai = new BehaviorTreeAI({ seed });
  const input = createInputState();

  const { preSystems } = createFloor1MainSceneOptions();

  let firstArenaFrame = -1;
  let retreatFrames = 0;
  for (let f = 0; f < RESOLUTION_BUDGET_FRAMES; f += 1) {
    ai.poll(input, world);
    if (ai.getDecision().state === AIState.RETREAT) {
      retreatFrames += 1;
    }
    if (firstArenaFrame < 0) {
      const d = ai.getDecision();
      if (d.targetEid === spawnerEid) firstArenaFrame = f;
    }
    // Use canonical preSystems (single source of truth, issue #663). Systems
    // that require world.floorScenario are no-ops on this minimal world;
    // spawnerArenaSystem is required to transition arenaState → 2.
    runSimulationStep(world, input, GAME.DELTA_MS, { preSystems });
    if (world.stores.spawner.arenaState[spawnerEid] === 2) {
      return { resolved: true, frames: f + 1, reason: 'ok', retreatFrames };
    }
    if ((world.stores.health.current[playerEid] ?? 0) <= 0) {
      return { resolved: false, frames: f + 1, reason: 'player died', retreatFrames };
    }
  }
  return {
    resolved: false,
    frames: RESOLUTION_BUDGET_FRAMES,
    reason: `unresolved after ${RESOLUTION_BUDGET_SEC}s (first targeted@${firstArenaFrame})`,
    retreatFrames,
  };
}

describe('AI arena lock-in — synthetic barrier-armed sweep', () => {
  it(`resolves ≥95% of barrier-armed arenas across ${SAMPLE_SEEDS.length} seeds`, () => {
    const outcomes = SAMPLE_SEEDS.map((seed) => ({ seed, ...runOneArena(seed) }));
    const resolved = outcomes.filter((o) => o.resolved).length;
    const rate = resolved / SAMPLE_SEEDS.length;
    const misses = outcomes
      .filter((o) => !o.resolved)
      .map((o) => `${o.seed}:${o.reason}`)
      .join(', ');
    console.log(
      `arena-lockin synthetic sweep: ${outcomes
        .map((o) => `${o.seed}:${o.resolved ? 'R' : '_'}@${o.frames}f`)
        .join(' ')} — rate ${(rate * 100).toFixed(0)}%`,
    );
    expect(
      rate,
      `[synthetic arena-lockin] resolved ${(rate * 100).toFixed(0)}% ` +
        `(${resolved}/${SAMPLE_SEEDS.length}) below 95% floor — misses: [${misses}]`,
    ).toBeGreaterThanOrEqual(0.95);
  });

  it('resolves from low HP with nearby pressure without a retreat loop', () => {
    const outcome = runOneArena(42, { lowHealthWithPressure: true });

    expect(outcome.resolved, outcome.reason).toBe(true);
    expect(outcome.retreatFrames).toBeLessThan(5);
  });
});
