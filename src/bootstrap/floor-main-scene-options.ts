import { abilitySystem, levelSystem, skillSystem, spendPoints } from '../game/systems/index.js';
import {
  enemyAISystem,
  familyFeudSystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  achievementSystem,
  emergentEventSystem,
  getScenarioDefinition,
  questSystem,
  spawnerArenaSystem,
  spawnerSystem,
  weaponSystem,
  capturePlayerCarryover,
  type ScenarioInitializationOptions,
} from '../game/index.js';
import { getBossRewardSpellOptions, selectSpellFromBossBattle } from '../game/floorScenario.js';
import { collectHumanRunStats } from '../game/ai/run-stats-collector.js';
import { createPlayerSessionRecorder } from '../game/ai/player-session-recorder.js';
import { floor2VictorySystem } from '../game/floor2Scenario.js';
import {
  resolveRunBundleUploadConfig,
  submitRunBundleUpload,
} from '../shared/run-bundle-telemetry.js';
import {
  statSystem,
  statusEffectSystem,
  familyRelationshipSystem,
  mobAbilitySystem,
  type GameWorld,
} from '../core/index.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';
import type { MainGameSceneTransitionOptions } from '../engine/scenes/MainGameScene.js';
import type { RunBundle } from '../shared/run-bundle.js';

export type FloorMainSceneOptions = MainGameSceneTransitionOptions;

function defaultRunBundleSink(bundle: RunBundle): void {
  const config = resolveRunBundleUploadConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crawler:run-bundle', { detail: bundle }));
  }
  if (!config.enabled || !config.endpoint) {
    if (typeof console !== 'undefined') {
      console.warn(
        config.reason ?? 'Run bundle upload is disabled because no endpoint is configured.',
      );
    }
    return;
  }
  void submitRunBundleUpload(bundle, { endReason: bundle.meta.endReason }).catch((error) => {
    if (typeof console !== 'undefined') {
      console.warn('Silent run-bundle upload failed', error);
    }
  });
}

/**
 * Create main scene options for a floor.
 * @param floorId - The floor identifier (e.g., "floor1")
 */
export function createFloorMainSceneOptions(
  floorId: string = 'floor1',
  initializationOptions?: ScenarioInitializationOptions,
  onRunBundle?: (bundle: RunBundle) => void,
): FloorMainSceneOptions {
  const scenario = getScenarioDefinition(floorId);
  const manifest = getFloorManifest(floorId);
  if (!manifest) {
    throw new Error(`Unknown floor manifest: ${floorId}`);
  }
  const nextFloorId = scenario.nextFloorId;
  return {
    floorId,
    terrainPackId: manifest.terrainPackId,
    terrainPacks: manifest.terrainPacks,
    lightingConfig: { ambient: manifest.lighting.ambient },
    sessionRecorderFactory: (world, playerEid) =>
      createPlayerSessionRecorder(world, playerEid, { recordWeaponTelemetry: true }),
    runStatsFactory: collectHumanRunStats,
    onRunBundle: onRunBundle ?? defaultRunBundleSink,
    configureWorld: (world: GameWorld, playerEid: number) =>
      scenario.configureWorld(world, playerEid, initializationOptions),
    selectLoadoutOption: scenario.selectLoadoutOption,
    director: scenario.director,
    onStairDescend: scenario.onStairDescend,
    onFloor1Cleared: nextFloorId
      ? (world: GameWorld, playerEid: number) => {
          const playerCarryover = capturePlayerCarryover(world, playerEid);
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.set('floor', nextFloorId);
            window.history.replaceState(window.history.state, '', url);
          }
          return {
            ...createFloorMainSceneOptions(nextFloorId, { playerCarryover }, onRunBundle),
            worldSeed: world.seed,
            generatedEquipmentRunKey: playerCarryover.generatedEquipmentRegistry?.runKey,
          };
        }
      : undefined,
    selectSpellFromBossBattle: (world: GameWorld, playerEid: number, spellId: string) => {
      selectSpellFromBossBattle(world, playerEid, spellId as Floor1BossRewardSpellId);
    },
    getSpellRewardOptions: (world: GameWorld) => getBossRewardSpellOptions(world),
    allocateStatPoints: (
      world: GameWorld,
      _playerEid: number,
      allocations: Parameters<typeof spendPoints>[1],
    ) => {
      spendPoints(world, allocations);
    },
    shopkeeper: scenario.npcs?.shopkeeper,
    tutorialGoon: scenario.npcs?.tutorialGoon,
    spellQuestGiver: scenario.npcs?.spellQuestGiver,
    broker: scenario.npcs?.broker,
    preSystems: [
      statSystem,
      // Drain queued faction-relation deltas early so any preSystem or
      // postSystem downstream this frame reads consistent post-adjust bands.
      // Always-safe: on Floor 1 the deltas queue stays empty (near-noop).
      familyRelationshipSystem,
      // Floor 2 Slice 5: per-tick dynamic victory evaluator (sole-ally or
      // all-bosses-dead). Always-safe no-op on Floor 1 / non-Floor-2 worlds.
      floor2VictorySystem,
      emergentEventSystem,
      floor1PlayerStatSystem,
      weaponSystem,
      // Floor 2 Slice 3: band-driven AI prepass runs AFTER familyRelationshipSystem
      // (so this frame's post-adjust bands are visible) and BEFORE enemyAISystem
      // (so it can plant a virtual target + hate speed ramp the AI will consume).
      // Always-safe on Floor 1 (no FamilyMembership → near-noop).
      familyFeudSystem,
      enemyAISystem,
      // statusEffectSystem runs AFTER enemyAISystem (and playerInputSystem, which
      // runs before all preSystems) so player + enemy speed folds see the same
      // pre-expiry effect set — expiry/HoT then apply before movement/damage/health.
      statusEffectSystem,
      // Typed mob-ability runtime (Queen Mab Verdigris Glamour + future generic
      // mob abilities). Wired into the canonical path but DEFAULT-OFF: the real
      // game never enables the runtime, registers no active boss definitions,
      // and emits zero casts/events. Only the combat-arena lab enables it. Runs
      // after statusEffectSystem so casts applied this frame (e.g. Tarnished)
      // last their full authored duration before the next expiry tick.
      mobAbilitySystem,
      // spawnerArenaSystem runs IMMEDIATELY BEFORE spawnerSystem so the
      // spawner ↔ director adjacency (locked by the preSystems contract test
      // in `tests/game/floor1-main-scene-options.test.ts`) stays intact.
      // Runs before spawnerSystem so any fence-tile mutation this frame is
      // visible when spawnerSystem chooses child spawn positions in the same
      // tick.
      spawnerArenaSystem,
      spawnerSystem,
      floor1EnemyDirectorSystem,
    ],
    postSystems: [
      levelSystem,
      skillSystem,
      abilitySystem,
      floorObjectiveSystem,
      questSystem,
      achievementSystem,
    ],
  };
}

/**
 * @deprecated Use createFloorMainSceneOptions instead
 */
export function createFloor1MainSceneOptions() {
  return createFloorMainSceneOptions('floor1');
}
