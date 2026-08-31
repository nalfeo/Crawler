/**
 * Regression guard for the Floor 3 league projection's Studio identity.
 *
 * `selectFloor3Studios()` and the territory-room assignment are independently
 * shuffled per seed, so projecting the biome-affinity ring by the Studio's
 * array index labelled versus cards with an unrelated affinity. The projection
 * must resolve each Studio's own authored affinity by id.
 */
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { resolveFloor3LeagueView } from '../../src/engine/floor3-league-state.js';
import {
  initializeFloor3Scenario,
  selectFloor3LoadoutOption,
} from '../../src/game/floor3Scenario.js';
import { STUDIO_CANDIDATES } from '../../src/shared/data/floor3/studios.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Floor 3 league view projection', () => {
  it.each([101, 202, 303])('labels every Studio with its authored affinity (seed %i)', (seed) => {
    const world = createTestWorld({ seed, floor: 3 });
    const playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    selectFloor3LoadoutOption(world, 0);

    const league = resolveFloor3LeagueView(world);
    expect(league.visible).toBe(true);
    expect(league.studios.length).toBeGreaterThan(0);
    for (const studio of league.studios) {
      const authored = STUDIO_CANDIDATES.find((candidate) => candidate.studioId === studio.id);
      expect(authored, `unknown Studio id ${studio.id}`).toBeDefined();
      expect(studio.affinity).toBe(authored!.affinity);
    }
  });
});
