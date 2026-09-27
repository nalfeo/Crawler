import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import {
  FAMILY_COMBAT_CASES,
  observeFamilyCombat,
  readFamilyCombat,
  stageFamilyCombat,
} from '../../src/labs/main-scene-probe-lab/family-combat-probe.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Floor 2 relationship combat through canonical headless pipeline', () => {
  it.each(FAMILY_COMBAT_CASES)('%s', (kind) => {
    const world = createTestWorld({ floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    stageFamilyCombat(world, player, kind);
    const options = createFloorMainSceneOptions('floor2');
    for (let frame = 0; frame < (kind.startsWith('defend') ? 12 : 2); frame++)
      runSimulationStep(world, createInputState(), GAME.DELTA_MS, {
        preSystems: options.preSystems,
        postSystems: [...options.postSystems!, observeFamilyCombat],
      });
    const result = readFamilyCombat(world)!;
    const expectedHit =
      !kind.startsWith('friendly') &&
      !kind.startsWith('neutral') &&
      !kind.startsWith('same-family');
    expect(result.targetDamaged).toBe(expectedHit);
    expect(result.targetHits).toBe(expectedHit ? 1 : 0);
    expect(result.deaths).toBe(0);
    if (kind.startsWith('defend')) {
      expect(result.allyTargetsAttacker).toBe(true);
      expect(result.attackerDamaged).toBe(true);
      expect(result.allyMoved).toBe(true);
    }
    expect(result.relations[1]).toBe(90);
  });
});
