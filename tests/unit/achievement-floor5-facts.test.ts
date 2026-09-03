import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  collectCurrentFloorAchievementFacts,
  evaluateAchievementUnlocksForPhase,
} from '../../src/game/systems/achievementSystem.js';
import { floor5Manifest } from '../../src/shared/floor-manifest.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor5World() {
  const world = createTestWorld({ seed: 505 });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor5').configureWorld?.(world, player);
  const siege = world.floorExtendedState?.floor5Siege;
  if (!siege) throw new Error('Floor 5 siege state missing');
  return { world, siege };
}

describe('Floor 5 achievement facts', () => {
  it('derives breach/capture/clean-sweep facts from authoritative Floor 5 state', () => {
    const { world, siege } = initFloor5World();
    const cleanSweepFloor = floor5Manifest.floor5!.releaseGate!.cleanSweepMinCommandPostHealthPct;
    const commandPostMaxHealth = siege.structures['command-post'].maxHealth;

    world.goalFlags.set('floor5.siege.wallBreached', true);
    world.goalFlags.set('floor5.siege.castleCaptured', true);
    siege.phase = { kind: 'CAPTURED' };
    siege.commandPostHealth = Math.ceil(commandPostMaxHealth * cleanSweepFloor);

    const facts = collectCurrentFloorAchievementFacts(world);

    expect(facts.booleanFacts.floor5WallBreached).toBe(true);
    expect(facts.booleanFacts.floor5CastleCaptured).toBe(true);
    expect(facts.booleanFacts.floor5CleanSweep).toBe(true);
    expect(facts.booleanFacts.runClearedFloor).toBe(true);
  });

  it('rejects clean-sweep fact when command post health falls below the approved floor', () => {
    const { world, siege } = initFloor5World();
    const cleanSweepFloor = floor5Manifest.floor5!.releaseGate!.cleanSweepMinCommandPostHealthPct;
    const commandPostMaxHealth = siege.structures['command-post'].maxHealth;

    world.goalFlags.set('floor5.siege.castleCaptured', true);
    siege.phase = { kind: 'CAPTURED' };
    siege.commandPostHealth = Math.max(0, Math.floor(commandPostMaxHealth * cleanSweepFloor) - 1);

    const facts = collectCurrentFloorAchievementFacts(world);
    expect(facts.booleanFacts.floor5CleanSweep).toBe(false);
  });

  it('unlocks capture and clean-sweep achievements only at run-end clear', () => {
    const { world, siege } = initFloor5World();
    const cleanSweepFloor = floor5Manifest.floor5!.releaseGate!.cleanSweepMinCommandPostHealthPct;
    const commandPostMaxHealth = siege.structures['command-post'].maxHealth;

    world.goalFlags.set('floor5.siege.wallBreached', true);
    world.goalFlags.set('floor5.siege.castleCaptured', true);
    siege.phase = { kind: 'CAPTURED' };
    siege.commandPostHealth = Math.ceil(commandPostMaxHealth * cleanSweepFloor);

    evaluateAchievementUnlocksForPhase(world, 'tick');
    expect(world.achievements.unlockedIds.has('floor5-breach-opened')).toBe(true);
    expect(world.achievements.unlockedIds.has('floor5-castle-captured')).toBe(false);
    expect(world.achievements.unlockedIds.has('floor5-clean-sweep')).toBe(false);

    evaluateAchievementUnlocksForPhase(world, 'run_end_clear');
    expect(world.achievements.unlockedIds.has('floor5-castle-captured')).toBe(true);
    expect(world.achievements.unlockedIds.has('floor5-clean-sweep')).toBe(true);
  });
});
