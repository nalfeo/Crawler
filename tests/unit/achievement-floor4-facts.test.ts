import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  collectCurrentFloorAchievementFacts,
  evaluateAchievementUnlocksForPhase,
} from '../../src/game/systems/achievementSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor4World() {
  const world = createTestWorld({ seed: 404 });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor4').configureWorld?.(world, player);
  const arena = world.floorExtendedState?.floor4Arena;
  if (!arena) throw new Error('Floor 4 arena state missing');
  return { world, arena };
}

describe('Floor 4 achievement facts', () => {
  it('derives measured arena, Headliner, Green Room, and victory facts', () => {
    const { world, arena } = initFloor4World();

    arena.timeline.push(
      {
        frame: 1,
        worldElapsedMs: 1,
        arenaElapsedMs: 1,
        phase: { kind: 'INTERMISSION', act: 1 },
        reason: 'test',
      },
      {
        frame: 2,
        worldElapsedMs: 2,
        arenaElapsedMs: 2,
        phase: { kind: 'INTERMISSION', act: 2 },
        reason: 'test',
      },
      {
        frame: 3,
        worldElapsedMs: 3,
        arenaElapsedMs: 3,
        phase: { kind: 'INTERMISSION', act: 3 },
        reason: 'test',
      },
      {
        frame: 4,
        worldElapsedMs: 4,
        arenaElapsedMs: 4,
        phase: { kind: 'INTERMISSION', act: 4 },
        reason: 'test',
      },
      {
        frame: 5,
        worldElapsedMs: 5,
        arenaElapsedMs: 5,
        phase: { kind: 'INTERMISSION', act: 5 },
        reason: 'test',
      },
    );
    arena.phase = { kind: 'VICTORY' };
    arena.waveTelemetry.wavesReleased = 12;
    arena.waveTelemetry.enemiesSpawned = 100;
    arena.headlinerTelemetry.spawned = 5;
    arena.headlinerTelemetry.defeated = 5;
    arena.headlinerTelemetry.overtimeStarted = 0;
    arena.actIncome.push(
      { act: 1, waveGold: 20, appearanceFeeGold: 18, totalGold: 38 },
      { act: 2, waveGold: 40, appearanceFeeGold: 28, totalGold: 68 },
      { act: 3, waveGold: 40, appearanceFeeGold: 40, totalGold: 80 },
    );
    world.floorExtendedState!.floor4GreenRoom = {
      retiredVisitCount: 5,
      lastOpenedVisitIndex: 4,
    };

    const facts = collectCurrentFloorAchievementFacts(world);

    expect(facts.numberFacts).toMatchObject({
      floor4ActsCompleted: 5,
      floor4WavesReleased: 12,
      floor4EnemiesSpawned: 100,
      floor4HeadlinersSpawned: 5,
      floor4HeadlinersDefeated: 5,
      floor4GreenRoomVisits: 5,
      floor4GoldEarned: 186,
    });
    expect(facts.booleanFacts).toMatchObject({
      floor4Victory: true,
      floor4NoOvertime: true,
      runClearedFloor: true,
    });
  });

  it('only unlocks the clear achievement after the real Floor 4 victory phase', () => {
    const { world, arena } = initFloor4World();

    arena.headlinerTelemetry.overtimeStarted = 0;
    expect(collectCurrentFloorAchievementFacts(world).booleanFacts.floor4NoOvertime).toBe(false);

    evaluateAchievementUnlocksForPhase(world, 'run_end_clear');
    expect(world.achievements.unlockedIds.has('floor4-main-event-clear')).toBe(false);

    arena.phase = { kind: 'VICTORY' };
    expect(collectCurrentFloorAchievementFacts(world).booleanFacts.floor4NoOvertime).toBe(true);
    evaluateAchievementUnlocksForPhase(world, 'run_end_clear');

    expect(world.achievements.unlockedIds.has('floor4-main-event-clear')).toBe(true);
  });

  it('counts an opened Green Room visit before it is retired', () => {
    const { world } = initFloor4World();
    world.floorExtendedState!.floor4GreenRoom = {
      retiredVisitCount: 0,
      lastOpenedVisitIndex: 0,
    };

    const facts = collectCurrentFloorAchievementFacts(world);

    expect(facts.numberFacts.floor4GreenRoomVisits).toBe(1);

    evaluateAchievementUnlocksForPhase(world, 'tick');
    expect(world.achievements.unlockedIds.has('floor4-commercial-break')).toBe(true);
  });
});
