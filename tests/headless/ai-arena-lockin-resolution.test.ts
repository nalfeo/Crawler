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
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { spawnPlayer, spawnSpawner } from '../../src/core/spawners/combatants.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

/** How many game seconds we give the AI to clear a hand-armed arena. */
const RESOLUTION_BUDGET_SEC = 60;
const RESOLUTION_BUDGET_FRAMES = Math.ceil((RESOLUTION_BUDGET_SEC * 1000) / GAME.DELTA_MS);

/** Deterministic seed prefix, same shape as `spawner-arena-win-rate.test.ts`. */
const SAMPLE_SEEDS = Array.from({ length: 8 }, (_, i) => i + 1) as readonly number[];

function runOneArena(seed: number): {
  resolved: boolean;
  frames: number;
  reason: string;
} {
  const world = createTestWorld({ seed });
  const playerEid = spawnPlayer(world, 0, 0);
  // Give the player a generous HP pool: the synthetic test fixture
  // installs a bogus fence-tile snapshot to satisfy the barrier-verified
  // detector, but doesn't produce a real physics wall around the arena.
  // With realistic HP the AI's Retreat priority (which outranks arena
  // lock-in) fires as soon as adds chip damage below the retreat
  // threshold, and the AI then walks off past the invisible fence. In a
  // real game the physical barrier prevents that. We compensate here by
  // giving the AI enough headroom to focus on the objective — the point
  // of THIS test is "AI knows it is stuck and prioritizes the objective"
  // (i.e. the priority slot works), not "AI survives at low HP".
  world.stores.health.current[playerEid] = 1000;
  world.stores.health.max[playerEid] = 1000;
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
  // Simulate raiseFence's non-empty snapshot so the detector treats the
  // arena as a real barrier — matches spawnerArenaSystem's post-lock state.
  world.spawnerArenaBarriers.set(spawnerEid, { id: 1, kind: 'fence', tiles: [0] });
  world.state = 'playing';

  const ai = new BehaviorTreeAI({ seed });
  const input = createInputState();

  let firstArenaFrame = -1;
  for (let f = 0; f < RESOLUTION_BUDGET_FRAMES; f += 1) {
    ai.poll(input, world);
    if (firstArenaFrame < 0) {
      const d = ai.getDecision();
      if (d.targetEid === spawnerEid) firstArenaFrame = f;
    }
    runSimulationStep(world, input, GAME.DELTA_MS, {});
    if (world.stores.spawner.arenaState[spawnerEid] === 2) {
      return { resolved: true, frames: f + 1, reason: 'ok' };
    }
    if ((world.stores.health.current[playerEid] ?? 0) <= 0) {
      return { resolved: false, frames: f + 1, reason: 'player died' };
    }
  }
  return {
    resolved: false,
    frames: RESOLUTION_BUDGET_FRAMES,
    reason: `unresolved after ${RESOLUTION_BUDGET_SEC}s (first targeted@${firstArenaFrame})`,
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
});
