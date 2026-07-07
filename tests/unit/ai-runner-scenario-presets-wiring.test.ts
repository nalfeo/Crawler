import { describe, expect, it } from 'vitest';
import {
  AI_RUNNER_SCENARIO_PRESETS,
  AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS,
  DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,
  getAiRunnerScenarioPreset,
} from '../../src/labs/ai-runner-lab/scenario-presets.js';
import { TerrainType, TilePresets } from '../../src/shared/map-types.js';

describe('AI runner scenario presets wiring', () => {
  it('defines deterministic scenario catalog and lookup', () => {
    const ids = AI_RUNNER_SCENARIO_PRESETS.map((preset) => preset.id);
    expect(DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID).toBe('floor1-default');
    expect(ids).toEqual([
      'floor1-default',
      'spawner-sealable-room',
      'spawner-unsealable-room',
      'spawner-cave',
    ]);
    expect(getAiRunnerScenarioPreset('spawner-sealable-room')?.defaultSeed).toBe(4206);
    expect(getAiRunnerScenarioPreset('spawner-unsealable-room')?.defaultSeed).toBe(4206);
    expect(getAiRunnerScenarioPreset('spawner-cave')?.defaultSeed).toBe(4208);
  });

  it('builds a two-room sealed slice: lockable doorway, side room, and passable gap', () => {
    const sealed = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeSealedRoomSliceMap(true);
    const unsealable = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeSealedRoomSliceMap(false);
    const cave = AI_RUNNER_SCENARIO_PRESET_TEST_HOOKS.makeCaveSliceMap();

    // Doorway gap between the two rooms (tile 7,15). Starts OPEN (passable but
    // lockable) so the AI can walk through and the arena seals it on arming.
    const doorIdx = 15 * sealed.width + 7;
    expect(sealed.flags[doorIdx]).toBe(TilePresets.DOOR_OPEN);
    expect(unsealable.flags[doorIdx]).toBe(TilePresets.FLOOR);
    expect(sealed.terrain[doorIdx]).toBe(TerrainType.DOOR);
    expect(unsealable.terrain[doorIdx]).toBe(TerrainType.STONE_FLOOR);

    // The divider is a real wall either side of the doorway gap.
    expect(sealed.flags[15 * sealed.width + 6]).toBe(TilePresets.WALL);
    expect(sealed.flags[15 * sealed.width + 8]).toBe(TilePresets.WALL);

    // Spawner (arena room) and player (starter room) sit in DIFFERENT rooms so
    // the arena only arms once the AI walks through the doorway.
    const arenaRoom = sealed.roomGraph.getRoomAt(7, 7);
    const starterRoom = sealed.roomGraph.getRoomAt(7, 18);
    expect(arenaRoom).toBeGreaterThanOrEqual(0);
    expect(starterRoom).toBeGreaterThanOrEqual(0);
    expect(arenaRoom).not.toBe(starterRoom);

    // Both spawn tiles and the doorway are passable so the AI can path in.
    expect(sealed.tileMap.isPassable(7, 7)).toBe(true);
    expect(sealed.tileMap.isPassable(7, 18)).toBe(true);

    expect(cave.terrain[8 * cave.width + 12]).toBe(TerrainType.CAVE_FLOOR);
    expect(cave.terrain[0]).toBe(TerrainType.CAVE_WALL);
  });
});
