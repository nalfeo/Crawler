import { abilitySystem, levelSystem, skillSystem, spendPoints } from '../game/systems/index.js';
import {
  enemyAISystem,
  floorObjectiveSystem,
  achievementSystem,
  questSystem,
  spawnerArenaSystem,
  spawnerSystem,
  attackWaveSystem,
  configureAttackWaves,
  weaponSystem,
  capturePlayerCarryover,
  type ScenarioInitializationOptions,
} from '../game/index.js';
import {
  getScenarioDefinition,
  getScenarioPresentationContract,
} from '../game/scenarioDefinitions.js';
import { getBossRewardSpellOptions, selectSpellFromBossBattle } from '../game/floorScenario.js';
import { getAbilityEffectSummary } from '../game/abilities/effect-summary.js';
import { collectHumanRunStats } from '../game/ai/run-stats-collector.js';
import { createPlayerSessionRecorder } from '../game/ai/player-session-recorder.js';
import { submitRunBundleUpload, type RunBundleUploadResult } from '../engine/run-bundle-upload.js';
import {
  statSystem,
  statusEffectSystem,
  familyRelationshipSystem,
  mobAbilitySystem,
  type GameWorld,
} from '../core/index.js';
import { createRunEventCollector } from '../core/run-events.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';
import type { MainGameSceneTransitionOptions } from '../engine/scenes/MainGameScene.js';
import type { RunBundle } from '../shared/run-bundle.js';

export type FloorMainSceneOptions = MainGameSceneTransitionOptions;

/**
 * Default `onRunBundle` sink used by the shipped game. Always resolves with a
 * well-formed {@link RunBundleUploadResult} (never `undefined`, and never a
 * rejected promise) so `MainGameScene`'s completion-telemetry status toast can
 * reliably tell the player whether their RunStats payload actually reached
 * the ingest endpoint. `submitRunBundleUpload` already reports its own
 * disabled/ok/failed states via the `ok`/`used`/`reason` fields — this sink
 * defers to that single source of truth instead of re-checking
 * `resolveRunBundleUploadConfig()` itself, so the two can no longer drift.
 *
 * Previously an unexpected throw from `submitRunBundleUpload` (which normally
 * catches its own fetch/network errors and resolves instead of rejecting) was
 * swallowed into a bare `console.warn` with no return value, silently
 * discarding the failure from any caller that awaited this sink's result.
 */
function defaultRunBundleSink(bundle: RunBundle): Promise<RunBundleUploadResult> | void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent('crawler:run-bundle', { detail: bundle }));
  return submitRunBundleUpload(bundle, { endReason: bundle.meta.endReason }).then(
    (result) => {
      if (!result.ok && typeof console !== 'undefined') {
        console.warn(
          result.used === 'disabled'
            ? (result.reason ?? 'Run bundle upload is disabled because no endpoint is configured.')
            : 'Silent run-bundle upload failed',
          result.reason,
        );
      }
      return result;
    },
    (error: unknown): RunBundleUploadResult => {
      if (typeof console !== 'undefined') {
        console.warn('Silent run-bundle upload failed', error);
      }
      return {
        ok: false,
        used: 'fetch',
        reason: error instanceof Error ? error.message : 'run bundle upload failed',
      };
    },
  );
}

/**
 * Create main scene options for a floor.
 * @param floorId - The floor identifier (e.g., "floor1")
 */
export function createFloorMainSceneOptions(
  floorId: string = 'floor1',
  initializationOptions?: ScenarioInitializationOptions,
  onRunBundle?: (bundle: RunBundle) => Promise<unknown> | void,
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
    configureWorld: (world: GameWorld, playerEid: number) => {
      world.runEvents ??= createRunEventCollector();
      // Applied before scenario configuration ("before play") independent of
      // which floor is active — a floor whose manifest doesn't declare the
      // `trashAttackWaves` behavior flag stays inert regardless (see
      // `attack-wave-system.ts`).
      configureAttackWaves(world, initializationOptions?.attackWaves ?? false);
      scenario.configureWorld(world, playerEid, initializationOptions);
    },
    selectLoadoutOption: scenario.selectLoadoutOption,
    selectKeptCompanion: scenario.selectKeptCompanion,
    onStairDescend: scenario.onStairDescend,
    // Normalized presentation contract for this scenario (terminal outcome,
    // stair marker/proximity, stair-descend confirmation copy, ordered
    // Director milestones, completion-variant copy). Both sides name the
    // shape from `src/shared/scenario-presentation.ts`, so the engine reads
    // it without ever importing `src/game/`.
    scenarioPresentation: getScenarioPresentationContract(scenario),
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
    getAbilityEffectSummary: (world: GameWorld, abilityId: string) =>
      getAbilityEffectSummary(abilityId, world.floorMap?.config.tileSizeFt),
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
      ...(scenario.beforeWeaponSystems ?? []),
      weaponSystem,
      ...(scenario.beforeEnemyAISystems ?? []),
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
      ...(scenario.afterSpawnerSystems ?? []),
    ],
    postSystems: [
      levelSystem,
      skillSystem,
      abilitySystem,
      floorObjectiveSystem,
      questSystem,
      achievementSystem,
      // Default-OFF periodic rat attack waves (Issue #3639). Runs in
      // postSystems (after this frame's spawns/AI/quests) so it doesn't
      // disturb the locked spawnerSystem preSystems adjacency contract in
      // `tests/game/floor1-main-scene-options.test.ts`.
      attackWaveSystem,
    ],
  };
}

/**
 * @deprecated Use createFloorMainSceneOptions instead
 */
export function createFloor1MainSceneOptions() {
  return createFloorMainSceneOptions('floor1');
}
