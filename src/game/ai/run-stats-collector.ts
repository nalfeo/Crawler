import type { GameWorld } from '../../core/world.js';
import { assembleRunStats } from '../../shared/run-stats-collector.js';
import type { SessionRecorderStats } from '../../shared/session-recorder-types.js';
import type { RunStats } from './types.js';
import { computeVendorInteractions } from './vendor-interactions.js';
import { getFloor4ArenaRunStats } from '../floor4Scenario.js';

/**
 * Builds the common RunStats shape for a human run. World-specific harvesters
 * stay in this layer; the shared assembler only fixes the stable object shape.
 */
export function collectHumanRunStats(
  world: GameWorld,
  playerEid: number,
  outcome: RunStats['outcome'],
  runStartXp = world.playerLevel?.xp ?? 0,
  recorderStats?: SessionRecorderStats,
): RunStats {
  const maxHealth = world.stores.health.max[playerEid] ?? 0;
  const currentHealth = world.stores.health.current[playerEid] ?? 0;
  const finalHealthPercent = maxHealth > 0 ? currentHealth / maxHealth : 0;
  const totalKills = countPlayerAttributedEnemyDeaths(world, playerEid);
  const stats: RunStats = {
    totalFrames: world.frameCount,
    wallTimeMs: 0,
    gameTimeMs: world.elapsedMs,
    safeRoomMs: 0,
    finalFloor: world.floor,
    finalScore: world.stores.broadcastScore?.current[playerEid] ?? 0,
    outcome,
    levelUps: [],
    combat: {
      totalKills,
      killsByType: {},
      combatTimeMs: 0,
      engagementCount: 0,
      damageDealt: 0,
      damageTaken: 0,
      damageTakenBySource: {},
    },
    health: {
      minHealthPercent: recorderStats?.minHealthPercent ?? finalHealthPercent,
      closeCallCount: recorderStats?.closeCallCount ?? (finalHealthPercent < 0.2 ? 1 : 0),
      lowHealthCount: recorderStats?.lowHealthCount ?? (finalHealthPercent < 0.5 ? 1 : 0),
      finalHealthPercent,
    },
    quests: {
      questsAccepted: 0,
      questsCompleted: 0,
      questsFailed: [],
      mainQuestAcceptedMs: null,
      mainQuestCompletedMs: null,
      firstQuestCompletedMs: null,
      questLogAccepts: {},
      questLogCompletions: {},
    },
    finalLevel: world.playerLevel?.level ?? 0,
    totalXp: world.playerLevel?.xp ?? 0,
    runStartXp,
    totalGold: world.playerGold,
    floor4Arena: getFloor4ArenaRunStats(world),
    startingWeapon:
      world.floorScenario?.selectedWeaponId ?? world.floorScenario?.starterChoices[0] ?? 'unknown',
    vendors: computeVendorInteractions(world),
    // Floor 2 den-boss diagnostics come from the session recorder's tracker,
    // which accumulated them frame-by-frame; the same rollup the headless
    // runner puts on `RunStats.denBoss`, so both paths are directly comparable.
    ...(recorderStats?.denBoss ? { denBoss: recorderStats.denBoss } : {}),
  };
  return assembleRunStats(stats);
}

function countPlayerAttributedEnemyDeaths(world: GameWorld, playerEid: number): number {
  let kills = 0;
  for (const event of world.combatEvents) {
    if (event.type === 'death' && event.targetType === 'enemy' && event.sourceEid === playerEid) {
      kills += 1;
    }
  }
  return kills;
}
