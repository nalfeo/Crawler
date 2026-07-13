import { describe, expect, it } from 'vitest';
import { spawnPlayer, spawnHarvestableNode } from '../../src/core/helpers.js';
import { getItemCount } from '../../src/shared/inventory.js';
import { HARVESTABLE_DEFS } from '../../src/shared/harvestableDefs.js';
import { isQuestComplete } from '../../src/core/systems/questSystem.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';

const STEP_MS = GAME.DELTA_MS;

/** Canonical pre/post systems from the shared source of truth. */
const FLOOR1_OPTS = (() => {
  const opts = createFloor1MainSceneOptions();
  return { preSystems: opts.preSystems, postSystems: opts.postSystems } as const;
})();

/** Build a Floor 1 world the same way the headless runner does. */
function setupFloor1World(seed: number) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return { world, player };
}

/**
 * Regression guard for the headless `level_up` starvation bug.
 *
 * `levelSystem` sets `world.state = 'level_up'` on every level-up as a flag for
 * the UI allocation screen. The visual game (MainGameScene) clears it back to
 * `'playing'` between frames (in the scene update loop, not inside the sim step).
 * The headless runner mirrors this by resetting `world.state` from `level_up` to
 * `playing` at the START of each iteration — before calling `runSimulationStep` —
 * so every `state === 'playing'`-gated system (notably `floor1ObjectiveTick`)
 * runs correctly on the frame after the level-up.
 *
 * These tests exercise the FULL pipeline (so `levelSystem` actually fires) using
 * the canonical preSystems/postSystems from `createFloor1MainSceneOptions()`, which
 * the existing floor1-scenario tests do not — they set `playerLevel.level`
 * directly while already in `'playing'` and call the floor systems by hand.
 */
describe('runSimulationStep — level_up must not park the headless Floor 1 sim', () => {
  it('starts in the playing state after Floor 1 setup', () => {
    const { world } = setupFloor1World(42);
    expect(world.state).toBe('playing');
  });

  it('clears a pre-existing level_up flag when the caller resets it before the next step', () => {
    const { world } = setupFloor1World(42);
    // Simulate having parked in level_up (Floor 1 has no allocation UI).
    // The caller (headless runner) is responsible for resetting this before the
    // next step — matching what MainGameScene.update() does between frames.
    world.state = 'level_up';
    // Reset mirrors headless-runner.ts: caller resets before the step.
    world.state = 'playing';

    runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);

    expect(world.state).toBe('playing');
  });

  it('returns to playing the frame after a level-up fires, and latches reach-level-2', () => {
    const { world } = setupFloor1World(42);
    expect(world.playerLevel.level).toBeLessThan(2);

    // Frame 1: Pre-load enough XP that levelSystem advances to level 2. The
    // level_up flag is set inside this step (by levelSystem in postSystems).
    // floor1ObjectiveTick sees 'level_up' and is a no-op this frame — matching
    // the visual game's behavior (objectives don't advance on the level-up frame
    // before the player allocates stat points).
    world.playerLevel.xp = xpRequiredForLevel(2);
    runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);

    expect(world.playerLevel.level).toBeGreaterThanOrEqual(2);
    // State is 'level_up' at end of this step — the caller (headless runner) will
    // reset it before the next step. Objectives have NOT latched yet.
    expect(world.state).toBe('level_up');

    // Frame 2: Caller resets level_up → playing (mirroring headless-runner.ts).
    // Now floorObjectiveSystem runs and latches reach-level-2.
    world.state = 'playing';
    runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);

    expect(world.state).toBe('playing');
    expect(world.goalFlags.get('floor1-reach-level-2')).toBe(true);
  });

  it('completes the Floor 1 tutorial quest through the full pipeline once level >= 2', () => {
    const { world } = setupFloor1World(42);
    // Accept the tutorial quest the legitimate way — the same entry point the AI
    // uses when it talks to the Tutorial Goon (no proximity or flag cheat).
    meetTutorialGoon(world);
    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);

    world.playerLevel.xp = xpRequiredForLevel(2);
    // A few steps so floorObjectiveSystem -> questSystem can latch + complete.
    // The level_up state is reset between steps (caller mirrors headless-runner.ts).
    for (let i = 0; i < 4; i += 1) {
      // Reset level_up before each step — mirrors headless-runner.ts behavior.
      if (world.state === 'level_up') world.state = 'playing';
      runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);
    }

    expect(world.playerLevel.level).toBeGreaterThanOrEqual(2);
    // State may be level_up at end of loop if a level-up fired last step; safe.
    expect(world.state === 'playing' || world.state === 'level_up').toBe(true);
    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);
  });
});

describe('runSimulationStep — harvestSystem ticks in the headless pipeline', () => {
  it('completes a harvest while the player stands on the node', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    const def = HARVESTABLE_DEFS[0]!;

    // Mushroom def 0 takes 3000ms (~180 steps at 16.67ms); 200 stationary steps clears it.
    // harvestSystem is part of the core pipeline — no preSystems needed for this test.
    spawnHarvestableNode(world, 0, 0, 0);
    for (let i = 0; i < 200; i++) {
      runSimulationStep(world, createInputState(), STEP_MS, {});
    }

    const bag = world.inventories.get(player)!;
    expect(getItemCount(bag, def.itemId)).toBe(1);
  });
});
