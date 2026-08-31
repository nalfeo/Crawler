import type { GameWorld } from '../../core/world.js';
import { getGeneratedEquipmentInstance } from '../../core/generated-equipment-registry.js';
import { assembleRunStats } from '../../shared/run-stats-collector.js';
import type { GeneratedEquipmentInstanceId } from '../../shared/generated-equipment-types.js';
import type { SessionRecorderStats } from '../../shared/session-recorder-types.js';
import type {
  ItemInteractionEntry,
  ItemInteractionKind,
  ItemInteractionSummary,
  RunStats,
} from './types.js';
import { computeVendorInteractions } from './vendor-interactions.js';
import { getFloor4ArenaRunStats } from '../floor4Scenario.js';
import { getFloor5SiegeRunStats } from '../floor5Scenario.js';
import { generatedEquipmentCatalogKey } from './headless-run-data.js';

const GENERATED_EQUIPMENT_INSTANCE_SOURCE_PREFIX = 'generated-equipment-instance:';

function floor4CountdownSafeMs(world: GameWorld): number {
  const floor4 = getFloor4ArenaRunStats(world);
  if (!floor4) return 0;
  const countdownIndex = floor4.timeline.findIndex((entry) => entry.phase.kind === 'COUNTDOWN');
  if (countdownIndex < 0) return 0;
  const countdownStart = floor4.timeline[countdownIndex]?.worldElapsedMs ?? 0;
  for (let index = countdownIndex + 1; index < floor4.timeline.length; index += 1) {
    const entry = floor4.timeline[index];
    if (entry && entry.phase.kind !== 'COUNTDOWN') {
      return Math.max(0, entry.worldElapsedMs - countdownStart);
    }
  }
  return floor4.phase.kind === 'COUNTDOWN' ? Math.max(0, world.elapsedMs - countdownStart) : 0;
}

interface MutableHumanItemInteraction {
  readonly catalogKey: string;
  readonly kind: ItemInteractionKind;
  offeredCount: number;
  selectableExposureCount: number;
  selectionCount: number;
  activationCount: number;
  activeTimeMs: number;
}

function ensureHumanItem(
  items: Map<string, MutableHumanItemInteraction>,
  catalogKey: string,
  kind: ItemInteractionKind,
): MutableHumanItemInteraction {
  const existing = items.get(catalogKey);
  if (existing) return existing;
  const created: MutableHumanItemInteraction = {
    catalogKey,
    kind,
    offeredCount: 0,
    selectableExposureCount: 0,
    selectionCount: 0,
    activationCount: 0,
    activeTimeMs: 0,
  };
  items.set(catalogKey, created);
  return created;
}

function collectHumanItemInteractions(world: GameWorld, playerEid: number): ItemInteractionSummary {
  const items = new Map<string, MutableHumanItemInteraction>();
  const selectedWeapon = world.floorScenario?.selectedWeaponId;
  if (selectedWeapon) {
    const item = ensureHumanItem(items, `weapon:${selectedWeapon}`, 'starter_weapon');
    item.offeredCount = Math.max(item.offeredCount, 1);
    item.selectableExposureCount = Math.max(item.selectableExposureCount, 1);
    item.selectionCount = Math.max(item.selectionCount, 1);
  }

  const bossRewardAvailable =
    world.goalFlags.get('floor1-boss-battle-complete') === true ||
    world.goalFlags.get('floor1-boss-spellbook-claimed') === true;
  if (bossRewardAvailable) {
    for (const spellId of world.floorScenario?.offeredRewardSpellIds ?? []) {
      const item = ensureHumanItem(items, `spell:${spellId}`, 'spell');
      item.offeredCount = Math.max(item.offeredCount, 1);
      item.selectableExposureCount = Math.max(item.selectableExposureCount, 1);
    }
  }

  for (const spellId of world.abilityStatesByEntity.get(playerEid)?.learnedSpellIds ?? []) {
    const item = ensureHumanItem(items, `spell:${spellId}`, 'spell');
    item.selectionCount = Math.max(item.selectionCount, 1);
  }

  let uniqueActivationCount = 0;
  for (const activation of world.runEvents?.itemActivations ?? []) {
    uniqueActivationCount += 1;
    const creditedKeys = new Set<string>();
    for (const source of activation.itemSources) {
      let catalogKey: string | undefined;
      let kind: ItemInteractionKind;
      if (source.startsWith('weapon:')) {
        catalogKey = source;
        kind = 'starter_weapon';
      } else if (source.startsWith('spell:')) {
        catalogKey = source;
        kind = 'spell';
      } else if (source.startsWith(GENERATED_EQUIPMENT_INSTANCE_SOURCE_PREFIX)) {
        const instanceId = source.slice(
          GENERATED_EQUIPMENT_INSTANCE_SOURCE_PREFIX.length,
        ) as GeneratedEquipmentInstanceId;
        const instance = getGeneratedEquipmentInstance(world, instanceId);
        catalogKey = instance ? generatedEquipmentCatalogKey(instance) : undefined;
        kind = 'generated_equipment';
      } else {
        continue;
      }
      if (!catalogKey || creditedKeys.has(catalogKey)) continue;
      creditedKeys.add(catalogKey);
      ensureHumanItem(items, catalogKey, kind).activationCount += 1;
    }
  }

  const sortedItems: ItemInteractionEntry[] = [...items.values()]
    .map((item) => ({ ...item }))
    .sort((left, right) => left.catalogKey.localeCompare(right.catalogKey));
  const dominantActivationCount = sortedItems.reduce(
    (maximum, item) => Math.max(maximum, item.activationCount),
    0,
  );
  return {
    items: sortedItems,
    uniqueActivationCount,
    dominantActivationCount,
  };
}

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
    // Time excluded from active-time budget calculations for this run:
    // authored time-stopping safe rooms + Floor 4's COUNTDOWN exception.
    safeRoomMs: world.safeRoomElapsedMs + floor4CountdownSafeMs(world),
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
    floor5Siege: getFloor5SiegeRunStats(world),
    startingWeapon:
      world.floorScenario?.selectedWeaponId ?? world.floorScenario?.starterChoices[0] ?? 'unknown',
    vendors: computeVendorInteractions(world),
    itemInteractions: collectHumanItemInteractions(world, playerEid),
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
