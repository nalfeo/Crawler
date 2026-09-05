import { describe, expect, it } from 'vitest';
import {
  setEnemyAppearanceKey,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../src/core/spawners/combatants.js';
import { pickGeneratedEnemyTextureKey } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { runSimulationStep as runVisualSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { runSimulationStep as runHeadlessSimulationStep } from '../../src/game/ai/simulation-step.js';
import {
  buildGeneratedSpriteRegistry,
  normalizeGeneratedSpriteConceptId,
  resolveGeneratedSpriteVariantForEntity,
} from '../../src/shared/generated-assets.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

const baseEntry = {
  spriteName: 'welcome-goon-var-0',
  assetPath: 'generated/welcome-goon-var-0.png',
  approvedAt: '2026-09-04T00:00:00.000Z',
  sourceRun: 'generated/runs/welcome-goon/test',
  anchor: { x: 8, y: 8, source: 'brief' as const },
  sensorScore: '7/7',
  judgeScore: '4',
};

const registry = buildGeneratedSpriteRegistry({
  version: 1,
  entries: {
    'npc-welcome-goon-var-8': {
      ...baseEntry,
      briefId: 'npc-welcome-goon',
      spriteName: 'npc-welcome-goon-var-8',
      assetPath: 'generated/npc-welcome-goon-var-8.png',
      variantIndex: 8,
    },
    'welcome-goon-var-1': {
      ...baseEntry,
      briefId: 'welcome-goon',
      spriteName: 'welcome-goon-var-1',
      assetPath: 'generated/welcome-goon-var-1.png',
      variantIndex: 1,
    },
    'welcome-goon-v2-var-2': {
      ...baseEntry,
      briefId: 'welcome-goon-v2',
      spriteName: 'welcome-goon-v2-var-2',
      assetPath: 'generated/welcome-goon-v2-var-2.png',
      variantIndex: 2,
      disliked: true,
    },
  },
});

function spawnVariantSequence(seed: number, runtime: 'visual' | 'headless'): string[] {
  const world = createTestWorld({ seed, generatedSpriteRegistry: registry });
  const playerEid = spawnPlayer(world, -100, -100);
  initializeFloor1Scenario(world, playerEid);
  const choices: string[] = [];
  const spawned: Array<{ eid: number; appearanceKey: string }> = [];

  for (let index = 0; index < 32; index++) {
    const eid = spawnBehaviorEnemy(world, index, 0, 10, 0, 1, 10, 1);
    const appearanceKey =
      index % 3 === 0 ? 'npc-welcome-goon' : index % 3 === 1 ? 'welcome-goon' : 'welcome-goon-v2';
    setEnemyAppearanceKey(world, eid, appearanceKey);
    spawned.push({ eid, appearanceKey });
  }

  if (runtime === 'visual') {
    runVisualSimulationStep(world, createInputState());
  } else {
    runHeadlessSimulationStep(world, createInputState(), GAME.DELTA_MS);
  }

  for (const { eid, appearanceKey } of spawned) {
    const visualChoice = pickGeneratedEnemyTextureKey(
      registry,
      'enemy_rat',
      world.stores.sprite.variantRoll[eid],
      appearanceKey,
    );
    const headlessChoice = resolveGeneratedSpriteVariantForEntity(world, eid)?.textureKey ?? null;

    expect(headlessChoice).toBe(visualChoice);
    expect(visualChoice).not.toBe('welcome-goon-v2-var-2');
    choices.push(visualChoice!);
  }

  return choices;
}

function appearanceStateAfterHeadlessSpawn(seed: number, injectRegistry: boolean) {
  const world = injectRegistry
    ? createTestWorld({ seed, generatedSpriteRegistry: registry })
    : createTestWorld({ seed });
  const playerEid = spawnPlayer(world, -100, -100);
  initializeFloor1Scenario(world, playerEid);
  const spawned: number[] = [];

  for (let index = 0; index < 32; index++) {
    const eid = spawnBehaviorEnemy(world, index, 0, 10, 0, 1, 10, 1);
    const appearanceKey =
      index % 3 === 0 ? 'npc-welcome-goon' : index % 3 === 1 ? 'welcome-goon' : 'welcome-goon-v2';
    setEnemyAppearanceKey(world, eid, appearanceKey);
    spawned.push(eid);
  }

  runHeadlessSimulationStep(world, createInputState(), GAME.DELTA_MS);
  return {
    variantRolls: spawned.map((eid) => world.stores.sprite.variantRoll[eid]),
    gameplayRngTail: Array.from({ length: 8 }, () => world.rng.next()),
  };
}

describe('seeded sprite variant runtime contract', () => {
  it('normalizes historical role and lineage IDs to one concept', () => {
    expect(
      ['npc-welcome-goon', 'welcome-goon', 'welcome-goon-v2'].map(
        normalizeGeneratedSpriteConceptId,
      ),
    ).toEqual(['welcome-goon', 'welcome-goon', 'welcome-goon']);
    expect(normalizeGeneratedSpriteConceptId('angry-roomba-v2-var-1')).toBe('angry-roomba-mk2');
    expect(registry.briefIds()).toEqual(['welcome-goon']);
  });

  it('replays choices across visual and headless seams while excluding disliked variants', () => {
    const first = spawnVariantSequence(42, 'visual');
    const replay = spawnVariantSequence(42, 'visual');
    const headless = spawnVariantSequence(42, 'headless');

    expect(replay).toEqual(first);
    expect(headless).toEqual(first);
    expect(new Set(first)).toEqual(new Set(['npc-welcome-goon-var-8', 'welcome-goon-var-1']));
  });

  it('leaves gameplay RNG state identical with and without a generated sprite registry', () => {
    const defaultHeadless = appearanceStateAfterHeadlessSpawn(42, false);
    const registryInjected = appearanceStateAfterHeadlessSpawn(42, true);

    expect(registryInjected.gameplayRngTail).toEqual(defaultHeadless.gameplayRngTail);
    expect(registryInjected.variantRolls).toEqual(defaultHeadless.variantRolls);
  });
});
