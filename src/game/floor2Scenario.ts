/**
 * Floor 2 Slice 4 — bosses, sealed dens, seeded unlock objectives, boss-defeat
 * spawn-gating.
 *
 * This module owns three responsibilities:
 *
 *   1. **`initializeFloor2Bosses`** — floor-init entrypoint. For every present
 *      family on the current run it:
 *        - finds the family's `BOSS_DEN` room (Slice 2 stamped these with the
 *          matching `familyIndex`);
 *        - spawns exactly one boss inside the sealed den, tagged with a
 *          `FamilyMembership { familyId, isBoss: 1 }` component (Slice 1);
 *        - wires the den's existing door to the family-scoped goal flag
 *          `floor2-den-<familyId>-unlocked` via the ADR-0010 door-lock plumbing;
 *        - deterministically picks one den-unlock archetype per family (from
 *          the FR13 pool) and installs the resulting concrete quest pack into
 *          the runtime registry via `installQuestPacks`.
 *
 *   2. **`floor2ObjectiveTick`** — Floor 2's `world.floorObjectiveTick`. Each
 *      frame it watches `world.combatEvents` for boss deaths (`type: 'death'`
 *      on an entity carrying `FamilyMembership.isBoss = 1`) and latches
 *      `floor2-family-<familyId>-boss-defeated`. Latched families are added to
 *      `world.floorExtendedState?.familyState?.decapitatedFamilies` so the spawner can gate them
 *      off (`isFamilySpawnGated`).
 *
 *   3. **`isFamilySpawnGated`** — the read-side of §2 exposed for Slice 8's
 *      spawner/director. Returns true once a family's boss is dead.
 *
 * Reuses (does NOT re-invent): ADR 0010 (door-lock config + goal flags), ADR
 * 0011 (data-driven quest packs), ADR 0023 (special-room sealing already
 * applied by CaveSystemGenerator + the generic sealing pass).
 */
import { addComponent, hasComponent, query, removeComponent, set, setComponent } from 'bitecs';
import {
  BaseStats,
  BroadcastScore,
  Damage,
  DoorState,
  Enemy,
  FamilyMembership,
  Health,
  Invincible,
  Player,
  Position,
  Size,
  Sprite,
  type GameWorld,
} from '../core/index.js';
import { createEntity } from '../core/spawners/entity-core.js';
import { setDoorLockConfig, setGoalFlag } from '../core/door-lock.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import {
  asFamilyId,
  bandFor,
  getRelation,
  initializeFactionRelations,
  selectFloor2Roster,
  type FamilyId,
  type Floor2FamilyBossEncounterState,
  type Floor2State,
} from '../core/faction-relations.js';
import { spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { AI_TYPE } from '../game/enemyAISystem.js';
import {
  BiomeType,
  type MapConfig,
  RoomRole,
  TerrainType,
  type RoomData,
} from '../shared/map-types.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import {
  floor2EnemyPack,
  getFloor2BossArchetype,
  getFloor2FamilyTrash,
  getFloor2NeutralTrash,
  type EnemyArchetypeDef,
} from '../shared/enemy-packs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { loadResources } from '../shared/data/resources.js';
import { loadShopArchetypes } from '../shared/data/shop-archetypes.js';
import {
  loadDenUnlockArchetypes,
  type DenUnlockArchetype,
} from '../shared/data/den-unlock-archetypes.js';
import { loadFamilies, type FamilyDef } from '../shared/data/families.js';
import { initializeFloor2Settlement } from './floor2Settlement.js';
import { isLiveFamilyBoss } from './floor2BossIdentity.js';
import { spawnBossChestForDefeatedBoss } from './boss-chest-resolver.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import { equip, initializeBaseStats, unequip } from '../core/systems/equipmentSystem.js';
import { statSystem } from '../core/systems/index.js';
import { addStatModifier, removeStatModifiers, spendPoints } from './systems/statsSystem.js';
import {
  installQuestPacks,
  type QuestPackDef,
  type QuestPackQuestSource,
  getQuestPacks,
  FLOOR2_FIND_SETTLEMENT_QUEST_ID,
  FLOOR2_LEAVE_FLOOR_QUEST_ID,
} from '../shared/quest-types.js';
import {
  acceptQuest,
  addQuestCounter,
  questSystem,
  setTrackedQuest,
} from '../core/systems/questSystem.js';
import type { SeededRandom } from '../shared/random.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import { setEnemyAppearanceKey } from '../core/spawners/combatants.js';
import { spawnHarvestableNode } from '../core/helpers.js';
import {
  FLOOR2_HARVESTABLE_START_INDEX,
  FLOOR2_HARVESTABLE_END_INDEX,
  HARVESTABLE_DEFS,
} from '../shared/harvestableDefs.js';
import { placePropsForFloor } from './systems/propPlacer.js';
import {
  scaleAmbientSpawnStats,
  pruneAmbientOutOfRange,
  pruneAmbientOverflow,
  countDirectorEnemies,
  countEngagingEnemies,
  evictFurthestAmbient,
  resolveAmbientSpawnPoint,
  getSpawnerState,
  ensureBossBattleSpellReward,
  initializePlayerWeaponSkills,
} from './floorScenario.js';
import {
  mergeSpawnZoneWeights,
  mixSpawnZoneWeights,
  normalizeSpawnZoneWeights,
  pickFromSpawnZones,
  type SpawnZoneWeights,
} from './spawn-zones.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { applyStartPlayerLevel } from './scenarios/playerLevelProgression.js';
import { computeAutoStatAllocation } from './scenarios/playerStatAllocationPolicy.js';
import { restorePlayerCarryover, type PlayerCarryoverSnapshot } from './playerCarryover.js';
import { evaluateAchievementUnlocksForPhase } from './systems/achievementSystem.js';
import type { AchievementCatalogRegistry } from '../shared/achievements.js';

const FLOOR2_BOSS_HP_SCALE = 0.03;
const FLOOR2_BOSS_CONTACT_DAMAGE = 2;
const FLOOR2_DIRECT_START_LEVEL = 5;
export const FLOOR2_TERRITORY_FAMILY_SPAWN_SHARE = 0.75;
export const FLOOR2_TERRITORY_NEUTRAL_SPAWN_SHARE = 0.25;
const floor2CombatEventCursor = new WeakMap<GameWorld, { cursor: number; lastEvent?: object }>();

export function resolveFloor2ArchetypeAIType(archetype: EnemyArchetypeDef): number {
  if (archetype.aiType === 'ranged') return AI_TYPE.RANGED;
  if (archetype.id.includes('slime')) return AI_TYPE.LEAPER;
  return AI_TYPE.CHASE;
}

export const FLOOR2_CAVE_SYSTEM_DEFAULTS = {
  initialFill: 0.55,
  smoothingPasses: 8,
  cavernWidenPasses: 2,
  straightHallwayMinRun: 10,
  bossDenSize: 10,
  resourceHeartDiameterTiles: 30,
  territoryRadiusFraction: 0.5,
  denTargetRadiusMinFraction: 0.5,
  denTargetRadiusMaxFraction: 0.66,
  denTargetMinSeparationTiles: 50,
  denStartAngleJitterFraction: 1,
  denDistanceJitterFraction: 1,
  spawnMinDistanceFromDenTiles: 24,
  spawnMinDistanceFromResourceHeartTiles: 24,
  spawnMinDistanceFromSettlementTiles: 24,
  settlementMinDistanceFromDenTiles: 30,
  settlementMinDistanceFromResourceHeartTiles: 20,
  regionSeparationTiles: 50,
  maxRetries: 8,
} as const;

/**
 * Concrete result of picking a den-unlock archetype for one family. Stored on
 * `world.floorExtendedState?.familyState` for Slice 5's win evaluator + Slice 7's HUD.
 */
export interface Floor2DenObjective {
  readonly familyId: FamilyId;
  readonly archetypeId: string;
  /** Family-scoped quest id installed into the quest registry. */
  readonly questId: string;
  /** Goal flag that unlocks the den door when latched true. */
  readonly unlockGoalId: string;
  /** Goal flag that latches when the boss dies. */
  readonly defeatGoalId: string;
}

/** Latched once either Floor 2 win shape triggers (FR15 / ADR-0040 D7). */
export const FLOOR2_VICTORY_GOAL_ID = 'floor2-victory';
/** Latched once stairs are popped on the resource-heart tile (FR16). */
export const FLOOR2_STAIRS_POPPED_GOAL_ID = 'floor2-stairs-popped';
/** Latched when Floor 2 collapse timer expires (for headless outcome classification). */
export const FLOOR2_TIMEOUT_GOAL_ID = 'floor2-timeout';
/** Latched when the player first enters the settlement cluster. */
export const FLOOR2_SETTLEMENT_FOUND_GOAL_ID = 'floor2-settlement-found';
/** Latched when the player completes the Broker's intro dialogue (all lines read). */
export const FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID = 'floor2-broker-intro-complete';
/** Latched when the player actually takes the popped Floor 2 stairs. */
export const FLOOR2_STAIRS_DISCOVERED_GOAL_ID = 'floor2.objective.staircaseDiscovered';

/**
 * Call when the player finishes reading the Broker's introductory dialogue.
 * Latches `floor2-broker-intro-complete`; `floor2ObjectiveTick` uses this to
 * activate the reputation system.
 */
export function meetBroker(world: GameWorld): void {
  setGoalFlag(world, FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
}

/** Goal-flag name for a family's den-unlock latch. */
export function denUnlockGoalId(familyId: FamilyId): string {
  return `floor2-den-${familyId}-unlocked`;
}

/** Goal-flag name for a family's boss-defeat latch. */
export function bossDefeatGoalId(familyId: FamilyId): string {
  return `floor2-family-${familyId}-boss-defeated`;
}

/**
 * Goal-flag name for the *favor* den-unlock route (FR13 `win-favor`). Latched
 * the first frame a family's relation reaches the Friendly band; kept separate
 * from {@link denUnlockGoalId} so HUD/telemetry can tell "opened by favor"
 * apart from "opened by the assigned objective".
 */
export function denFavorGoalId(familyId: FamilyId): string {
  return `floor2-family-${familyId}-favor-earned`;
}

/**
 * Second route into a boss den (FR13 `win-favor`): the peaceful path. Any
 * present family whose relation reaches the Friendly band (>75, see
 * {@link bandFor}) invites the player in, opening its den regardless of the
 * kill-based objective assigned to it at floor init.
 *
 * This is a *parallel* route, not a replacement — the assigned objective still
 * unlocks the den on its own, so a player (or the headless AI) who only fights
 * is unaffected. Pure read: callers latch, so a later relation drop can never
 * re-seal a den the player already earned entry to.
 */
export function hasEarnedDenFavor(world: GameWorld, familyId: FamilyId): boolean {
  const familyState = world.floorExtendedState?.familyState;
  // `=== false` is intentional: `undefined` means "active by default" (labs and
  // tests that never ran the Broker intro).
  if (familyState?.reputationSystemActive === false) return false;
  return bandFor(getRelation(world, familyId)) === 'friendly';
}

/**
 * Deterministically pick one den-unlock archetype id per present family, in
 * roster order. Duplicates are allowed (by design — the pool is small and the
 * FR13 spec neither requires nor forbids uniqueness), which keeps the mapping
 * total for any presentCount up to and past the archetype pool size.
 */
export function selectDenUnlockObjectives(
  rng: SeededRandom,
  presentFamilies: readonly FamilyId[],
  archetypes: readonly DenUnlockArchetype[] = loadDenUnlockArchetypes(),
): Map<FamilyId, string> {
  const supportedArchetypes = archetypes.filter((archetype) => archetype.kind === 'killTargets');
  if (supportedArchetypes.length === 0) {
    throw new Error('selectDenUnlockObjectives requires at least one killTargets archetype');
  }
  const out = new Map<FamilyId, string>();
  for (const familyId of presentFamilies) {
    const idx = rng.nextInt(0, supportedArchetypes.length - 1);
    out.set(familyId, supportedArchetypes[idx]!.id);
  }
  return out;
}

/**
 * Build a concrete quest pack from a per-family archetype assignment. Every
 * quest's `onCompleteGoalFlag` is the family-scoped `floor2-den-<id>-unlocked`
 * so the door-lock plumbing (ADR 0010) can gate the boss den on it.
 */
export function buildDenUnlockQuestPack(
  assignments: ReadonlyMap<FamilyId, string>,
  families: ReadonlyMap<FamilyId, FamilyDef>,
  archetypes: readonly DenUnlockArchetype[] = loadDenUnlockArchetypes(),
): QuestPackDef {
  const archetypeById = new Map(archetypes.map((a) => [a.id, a] as const));
  const quests: QuestPackQuestSource[] = [];
  for (const [familyId, archetypeId] of assignments) {
    const archetype = archetypeById.get(archetypeId);
    if (!archetype) {
      throw new Error(`Unknown den-unlock archetype: ${archetypeId}`);
    }
    if (archetype.kind !== 'killTargets') {
      throw new Error(`Unsupported den-unlock archetype kind: ${archetype.kind}`);
    }
    const family = families.get(familyId);
    const familyName = family?.name ?? familyId;
    const questId = `floor2-den-${familyId}-unlock`;
    const goalId = denUnlockGoalId(familyId);
    const label = archetype.objectiveLabel.replace('{familyName}', familyName);

    quests.push({
      id: questId,
      title: `${archetype.title} — ${familyName}`,
      summary: archetype.summary,
      onCompleteGoalFlag: goalId,
      // Den-unlock kill-counter quests are passive background conditions; they
      // track mechanically but should never appear in the HUD quest tracker.
      hidden: true,
      template: {
        kind: 'killTargets',
        targets: [
          {
            objectiveId: `${questId}-kills`,
            label,
            target: archetype.killTarget,
          },
        ],
      },
    });
  }
  return {
    version: 1,
    packId: 'floor2-den-unlocks',
    quests,
  };
}

/**
 * Find the BOSS_DEN room for a given family index on a Floor 2 map. Returns
 * `undefined` when no matching room exists (defensive — the generator is
 * supposed to stamp one per present family).
 */
export function findBossDenRoom(
  floorMap: Pick<FloorMap, 'roomGraph'>,
  familyIndex: number,
): RoomData | undefined {
  return floorMap.roomGraph
    .getAll()
    .find((r) => r.role === RoomRole.BOSS_DEN && r.familyIndex === familyIndex);
}

/** Interior spawn tile for a boss inside its den. */
function pickBossSpawnTile(room: RoomData): { x: number; y: number } {
  if (room.interiorCells && room.interiorCells.length > 0) {
    const mid = room.interiorCells[Math.floor(room.interiorCells.length / 2)]!;
    return { x: mid.x, y: mid.y };
  }
  return {
    x: room.bounds.x + Math.floor(room.bounds.width / 2),
    y: room.bounds.y + Math.floor(room.bounds.height / 2),
  };
}

/**
 * Spawn a single family boss at (x, y) tagged with `FamilyMembership`. Uses
 * the shared enemy-archetype record for hp/speed/detect-range so tuning stays
 * data-driven.
 */
export function spawnFamilyBoss(
  world: GameWorld,
  x: number,
  y: number,
  familyIdIndex: number,
  familyId: FamilyId,
): number {
  const archetype = getFloor2BossArchetype(familyId);
  if (!archetype) {
    throw new Error(`No boss archetype registered for family "${familyId}"`);
  }
  const behaviorType = resolveFloor2ArchetypeAIType(archetype);
  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    Math.max(1, Math.round(archetype.hp * FLOOR2_BOSS_HP_SCALE)),
    behaviorType,
    archetype.speed,
    archetype.detectRange,
    behaviorType === AI_TYPE.RANGED ? Math.max(160, archetype.detectRange * 4) : 0,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  // Resolve the boss's dedicated generated art (keyed by archetype id, e.g.
  // "goblin-boss") through the same appearance-key path the grunts/ambient use.
  // Without this the boss falls back to the shared enemy_family_boss type art
  // (GENERATED_BRIEF_BY_TYPE -> "goblin-boss") instead of its own family art.
  setEnemyAppearanceKey(world, eid, archetype.id);
  setComponent(world.ecs, eid, Size, {
    radius:
      archetype.collisionRadius ?? Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: familyIdIndex, isBoss: 1 }));
  // Bosses hit hard on contact; ranged behaviour is layered later.
  setComponent(world.ecs, eid, Damage, { amount: FLOOR2_BOSS_CONTACT_DAMAGE });
  return eid;
}

/**
 * Wire a BOSS_DEN room's doors to the family-scoped unlock goal flag. The
 * doors start closed + locked; when the flag latches true the door-lock
 * evaluator flips `isLocked` to 0 and the doorSystem opens the tile.
 *
 * Slice 2's CaveSystemGenerator only stamps the tile as `DOOR_CLOSED` — this
 * function creates the ECS entity + `DoorState` component + lock config that
 * makes the door player-interactable and goal-gated.
 */
function installBossDenDoorLocks(
  world: GameWorld,
  denRoom: RoomData,
  unlockGoalId: string,
  activeGoalId: string,
): number[] {
  const created: number[] = [];
  for (const door of denRoom.doors) {
    const doorEid = createEntity(world);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, {
        tileX: door.x,
        tileY: door.y,
        logicalOpen: 0,
        isLocked: 1,
        wasUnlocked: 0,
      }),
    );
    setDoorLockConfig(world, doorEid, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: unlockGoalId }],
      },
      relock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: activeGoalId }],
      },
    });
    created.push(doorEid);
  }
  return created;
}

/**
 * Wire RESOURCE_HEART doors to the floor2-victory latch.
 * Doors start closed+locked and unlock once the floor victory condition is met.
 */
function installResourceHeartDoorLocks(world: GameWorld, floorMap: FloorMap): number[] {
  const created: number[] = [];
  const room = floorMap.roomGraph.getFirstRoomByRole(RoomRole.RESOURCE_HEART);
  if (!room) return created;
  for (const door of room.doors) {
    const doorEid = createEntity(world);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, {
        tileX: door.x,
        tileY: door.y,
        logicalOpen: 0,
        isLocked: 1,
        wasUnlocked: 0,
      }),
    );
    setDoorLockConfig(world, doorEid, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: FLOOR2_VICTORY_GOAL_ID }],
      },
    });
    created.push(doorEid);
  }
  return created;
}

/**
 * Full floor-init pipeline for Slice 4. Idempotent under a same-seed rerun
 * because both the roster and the archetype pick derive from `world.rng` /
 * static data.
 *
 * Returns the per-family objective assignment for downstream slices (Slice 5's
 * win evaluator inspects this; Slice 7's HUD renders it).
 */
export function initializeFloor2Bosses(
  world: GameWorld,
  floorMap: FloorMap,
  floor2State: Floor2State,
): readonly Floor2DenObjective[] {
  const archetypes = loadDenUnlockArchetypes();
  const familyDefs = new Map<FamilyId, FamilyDef>(
    loadFamilies().map((f) => [asFamilyId(f.id), f] as const),
  );
  const assignments = selectDenUnlockObjectives(world.rng, floor2State.presentFamilies, archetypes);

  // Concrete quest pack — must be installed alongside any other packs already
  // in the registry so the Floor-1 packs aren't clobbered by Floor 2 init.
  const denPack = buildDenUnlockQuestPack(assignments, familyDefs, archetypes);
  const existing = getQuestPacks();
  installQuestPacks([...existing.filter((p) => p.packId !== denPack.packId), denPack]);

  const decapitated = ensureDecapitatedSet(world);
  floor2State.trashKillsByFamily = new Map<FamilyId, number>();
  floor2State.bossEncounters = new Map();
  const objectives: Floor2DenObjective[] = [];
  for (let familyIndex = 0; familyIndex < floor2State.presentFamilies.length; familyIndex += 1) {
    const familyId = floor2State.presentFamilies[familyIndex]!;
    const archetypeId = assignments.get(familyId);
    if (archetypeId === undefined) continue; // unreachable — assignments covers every present family

    const unlockGoalId = denUnlockGoalId(familyId);
    const defeatGoalId = bossDefeatGoalId(familyId);
    const activeGoalId = `floor2-den-${familyId}-boss-active`;
    // Seed the flags false so anything that inspects them (Slice 5's win
    // evaluator, HUD) sees a deterministic starting state.
    setGoalFlag(world, unlockGoalId, false);
    setGoalFlag(world, defeatGoalId, false);
    setGoalFlag(world, activeGoalId, false);
    setGoalFlag(world, denFavorGoalId(familyId), false);
    decapitated.delete(familyId);
    floor2State.trashKillsByFamily.set(familyId, 0);

    const denRoom = findBossDenRoom(floorMap, familyIndex);
    if (!denRoom) {
      // Defensive: skip missing dens rather than crash floor init. The
      // reachability guarantee in CaveSystemGenerator should prevent this.
      continue;
    }
    const doorEids = installBossDenDoorLocks(world, denRoom, unlockGoalId, activeGoalId);
    const spawnTile = pickBossSpawnTile(denRoom);
    const spawnWorld = floorMap.tileToWorld(spawnTile.x, spawnTile.y);
    const bossEid = spawnFamilyBoss(world, spawnWorld.x, spawnWorld.y, familyIndex, familyId);
    addComponent(world.ecs, bossEid, Invincible);
    const bossArchetype = getFloor2BossArchetype(familyId);
    floor2State.bossEncounters.set(familyId, {
      familyId,
      roomId: denRoom.id,
      doorEids,
      activeGoalId,
      started: false,
      bossEid,
      defeated: false,
      displayName: bossArchetype?.name ?? `${familyId} Boss`,
      lootTableId: 'boss',
      bossSpawnX: spawnWorld.x,
      bossSpawnY: spawnWorld.y,
    });

    objectives.push({
      familyId,
      archetypeId,
      questId: `floor2-den-${familyId}-unlock`,
      unlockGoalId,
      defeatGoalId,
    });
  }

  return objectives;
}

/**
 * Latch one family's boss as defeated and reconcile its den encounter.
 *
 * Single home for every defeat route (combat-event death, vanished-boss safety
 * net, victory-path reconciliation) so a family can never be latched
 * "defeated" while its den encounter still holds `activeGoalId` true — the den
 * doors relock on that flag, and a latched-but-unreconciled encounter seals the
 * player inside a boss-less room for the rest of the run.
 *
 * `chestX`/`chestY` place the boss chest; callers that saw the real death pass
 * the boss's death position, and reconciliation callers fall back to the
 * recorded den spawn point. Chest creation runs BEFORE any latch (ADR 0070
 * fail-closed boundary): if it throws on a genuine catalog integrity bug, the
 * family stays retryable on the next tick instead of being permanently latched
 * as defeated with no chest ever created. It is idempotent, so calling it for
 * an already-chested family is a no-op.
 *
 * `markStarted` is opt-in so a reconciliation of a boss that vanished before
 * the player ever entered its den does not retroactively claim the encounter
 * was engaged — `encounter.started` is diagnostic history that den telemetry
 * reports, and the encounter-start block is already gated on `defeated`.
 */
function latchFloor2FamilyDefeated(
  world: GameWorld,
  familyId: FamilyId,
  options: {
    readonly chestX?: number;
    readonly chestY?: number;
    readonly markStarted?: boolean;
  } = {},
): void {
  const encounter = world.floorExtendedState?.familyState?.bossEncounters?.get(familyId);
  spawnBossChestForDefeatedBoss(
    world,
    familyId,
    options.chestX ?? encounter?.bossSpawnX,
    options.chestY ?? encounter?.bossSpawnY,
  );

  ensureDecapitatedSet(world).add(familyId);
  setGoalFlag(world, bossDefeatGoalId(familyId), true);
  if (encounter) {
    if (options.markStarted === true) {
      encounter.started = true;
    }
    encounter.defeated = true;
    encounter.bossEid = null;
    setGoalFlag(world, encounter.activeGoalId, false);
  }
}

/**
 * Floor 2's `floorObjectiveTick`. Registered by the Floor 2 scenario at init
 * time. Called every frame by `floorObjectiveSystem` (already wired into the
 * postSystems pipeline for Floor 1; Slice 8 wires the Floor 2 entry point).
 *
 * Responsibilities in Slice 5:
 *   - Detect boss deaths from `world.combatEvents` and latch
 *     `floor2-family-<id>-boss-defeated`.
 *   - Track defeated families in `world.floorExtendedState?.familyState?.decapitatedFamilies` so the
 *     spawner (Slice 8) can gate future spawns.
 *   - Run the per-tick Floor 2 win evaluator (Win A / Win B) and, on first
 *     trigger, latch `floor2-victory` + pop resource-heart stairs.
 *   - Run the floor2 enemy director system for quadrant-based trash spawning.
 */
export function floor2ObjectiveTick(world: GameWorld): void {
  if (world.state !== 'playing') {
    return;
  }

  unstickFloor2Bosses(world);

  // Run the enemy director for quadrant-based trash spawning
  floor2EnemyDirectorSystem(world);

  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) return;

  const playerEid = query(world.ecs, [Player])[0];
  const settlement = world.floorExtendedState?.settlement;
  const floorMap = world.floorMap;
  if (
    playerEid !== undefined &&
    settlement &&
    floorMap &&
    world.goalFlags.get(FLOOR2_SETTLEMENT_FOUND_GOAL_ID) !== true
  ) {
    const playerTile = floorMap.worldToTile(
      world.stores.position.x[playerEid] ?? 0,
      world.stores.position.y[playerEid] ?? 0,
    );
    const playerRoomId = floorMap.roomGraph.getRoomAt(playerTile.x, playerTile.y);
    if (playerRoomId !== undefined && settlement.settlementRoomIds.includes(playerRoomId)) {
      setGoalFlag(world, FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    }
  }

  if (playerEid !== undefined && floorMap && floor2State.bossEncounters) {
    const playerTile = floorMap.worldToTile(
      world.stores.position.x[playerEid] ?? 0,
      world.stores.position.y[playerEid] ?? 0,
    );
    const playerRoomId = floorMap.roomGraph.getRoomAt(playerTile.x, playerTile.y);
    for (const encounter of floor2State.bossEncounters.values()) {
      if (
        encounter.started ||
        encounter.defeated ||
        playerRoomId !== encounter.roomId ||
        world.goalFlags.get(denUnlockGoalId(encounter.familyId)) !== true
      ) {
        continue;
      }
      // Containment before latching: the den doors RELOCK on `activeGoalId`, so
      // starting the encounter while the boss is outside its den seals the
      // player in with an unreachable boss. The boss is mobile and aggressive
      // from floor init, so once the unlock flag opens the doors it can walk
      // out on its own. Return it to its den spawn tile first — the fight stays
      // intact and the relock can never produce a boss-less sealed room.
      const bossEid = encounter.bossEid;
      if (
        bossEid === null ||
        encounter.bossSpawnX === undefined ||
        encounter.bossSpawnY === undefined ||
        !isLiveFamilyBoss(world, encounter)
      ) {
        // Do not relock a den around an absent boss, nor around a recycled
        // entity id that now belongs to unrelated trash. The victory path below
        // reconciles vanished bosses once every den is unlocked; until then,
        // keeping this den open prevents a second sealed-room softlock.
        continue;
      }
      containFloor2BossInDen(world, encounter);
      encounter.started = true;
      removeComponent(world.ecs, bossEid, Invincible);
      world.stores.enemyBehavior.aggroedPermanently[bossEid] = 1;
      setGoalFlag(world, encounter.activeGoalId, true);
    }
  }

  // Activate the reputation system once the Broker has explained the floor
  // (player completed all of the Broker's intro dialogue lines). meetBroker()
  // latches FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID; MainGameScene fires it when
  // the player advances past the Broker's last dialogue line.
  // NOTE: `=== false` is intentional — `undefined` means "active by default"
  // (backwards compat for labs that don't set reputationSystemActive).
  if (
    floor2State.reputationSystemActive === false &&
    world.goalFlags.get(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) === true
  ) {
    floor2State.reputationSystemActive = true;
  }

  const decapitated = ensureDecapitatedSet(world);
  const cursorState = floor2CombatEventCursor.get(world) ?? { cursor: 0 };
  floor2CombatEventCursor.set(world, cursorState);
  const combatEvents = world.combatEvents;
  if (
    cursorState.cursor > combatEvents.length ||
    (cursorState.cursor > 0 && combatEvents[cursorState.cursor - 1] !== cursorState.lastEvent)
  ) {
    cursorState.cursor = 0;
  }
  const familyIdField = world.stores.familyMembership.familyId;
  const isBossField = world.stores.familyMembership.isBoss;

  for (let eventIndex = cursorState.cursor; eventIndex < combatEvents.length; eventIndex += 1) {
    const event = combatEvents[eventIndex]!;
    if (event.type !== 'death') continue;
    const eid = event.targetEid;
    if (eid === undefined) continue;
    const storeIsBoss = (isBossField[eid] ?? 0) as 0 | 1;
    const isBoss =
      event.isBoss !== undefined ? event.isBoss : storeIsBoss === 1 ? (1 as const) : (0 as const);
    const familyIndex =
      event.familyIndex !== undefined
        ? event.familyIndex
        : isBoss === 1 || hasComponent(world.ecs, eid, FamilyMembership)
          ? (familyIdField[eid] ?? -1)
          : -1;
    if (familyIndex < 0 || familyIndex >= floor2State.presentFamilies.length) continue;
    const familyId = floor2State.presentFamilies[familyIndex];
    if (!familyId) continue;
    if (isBoss === 0) {
      const sourceEid = event.sourceEid;
      if (sourceEid === undefined || !hasComponent(world.ecs, sourceEid, Player)) {
        continue;
      }
      const kills = (floor2State.trashKillsByFamily?.get(familyId) ?? 0) + 1;
      floor2State.trashKillsByFamily?.set(familyId, kills);
      addQuestCounter(
        world,
        `floor2-den-${familyId}-unlock`,
        `floor2-den-${familyId}-unlock-kills`,
        1,
      );
      continue;
    }
    if (decapitated.has(familyId)) continue;

    // Chest creation boundary (ADR 0070): resolves the family's boss-chest
    // reward bundle and registers its lifecycle record BEFORE the boss is
    // latched as defeated below. `spawnBossChestForDefeatedBoss` can throw a
    // `RewardBundleResolutionError` on a genuine config/catalog integrity bug
    // (fail-closed per ADR 0070 §6); ordering it first means such a throw
    // leaves `decapitated`/goal flags untouched, so this family stays
    // retryable on the next tick instead of being permanently latched as
    // "defeated" with no chest ever created. No-op (never throws) on Floor 1
    // (structurally unreachable here anyway), with the economy flag
    // disabled, or on re-entry for an already-chested family.
    // Spawn the chest at the boss's position so it drops in-world.
    const bossX = world.stores.position.x[eid] ?? 0;
    const bossY = world.stores.position.y[eid] ?? 0;
    latchFloor2FamilyDefeated(world, familyId, { chestX: bossX, chestY: bossY, markStarted: true });
  }
  cursorState.cursor = combatEvents.length;
  cursorState.lastEvent = combatEvents.at(-1);

  // Sealed-den safety net. A started encounter relocks its den doors on
  // `activeGoalId`, and ONLY a defeat latch clears that flag — so an encounter
  // whose boss entity vanishes without a `death` combat event (recycled id,
  // stripped components, any despawn path) leaves the player sealed inside a
  // boss-less room with no way to ever satisfy the unlock condition. That is a
  // permanent softlock, and it is the largest single failure bucket in the
  // release sweep's chained leg. Resolving the family here reopens the den.
  //
  // This runs AFTER the combat-event loop so a normal kill always latches
  // first, with the boss's real death position for the chest — the net is
  // reachable only for a boss that is already gone from the ECS. A
  // dead-but-lingering corpse still satisfies `isLiveFamilyBoss`, so the net
  // never front-runs `dropSystem`'s death event.
  if (floor2State.bossEncounters) {
    for (const encounter of floor2State.bossEncounters.values()) {
      if (!encounter.started || encounter.defeated) continue;
      if (isLiveFamilyBoss(world, encounter)) continue;
      latchFloor2FamilyDefeated(world, encounter.familyId);
    }
  }

  for (const familyId of floor2State.presentFamilies) {
    const questId = `floor2-den-${familyId}-unlock`;
    if (world.questLog.get(questId)?.status === 'complete') {
      setGoalFlag(world, denUnlockGoalId(familyId), true);
    }
    // FR13 `win-favor` — the peaceful route. Reaching the Friendly band opens
    // the den in parallel with the assigned objective. Latched: relation may
    // decay afterwards, but the door stays open.
    if (
      world.goalFlags.get(denFavorGoalId(familyId)) !== true &&
      hasEarnedDenFavor(world, familyId)
    ) {
      setGoalFlag(world, denFavorGoalId(familyId), true);
      setGoalFlag(world, denUnlockGoalId(familyId), true);
    }
  }

  // Check collapse timer and end floor if expired
  const manifest = getFloorManifest('floor2');
  if (manifest?.timer && world.elapsedMs >= manifest.timer.durationMs) {
    setGoalFlag(world, FLOOR2_TIMEOUT_GOAL_ID, true);
    world.state = 'game_over';
  }

  floor2VictorySystem(world);
}

/**
 * Per-tick Floor 2 win evaluator (FR15 / ADR-0040 D7).
 *
 * Win A ("sole ally"): exactly one present family is alive and its relation > 75.
 * Win B ("total war"): every present family's boss is defeated.
 *
 * On first trigger, latches `floor2-victory` and pops stairs at a
 * `BOSS_STAIR_FLOOR` tile in the resource-heart room.
 */
export function floor2VictorySystem(world: GameWorld): void {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) return;
  if (world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID) === true) return;

  const presentFamilies = floor2State.presentFamilies;
  if (presentFamilies.length === 0) return;
  const decapitated = ensureDecapitatedSet(world);
  const aliveFamilies = presentFamilies.filter((familyId) => !decapitated.has(familyId));
  const allBossesDead = aliveFamilies.length === 0;
  const livingBossFamilies = new Set<FamilyId>();
  const familyIdField = world.stores.familyMembership.familyId;
  const isBossField = world.stores.familyMembership.isBoss;
  for (const eid of query(world.ecs, [Enemy, Health, FamilyMembership])) {
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    if ((isBossField[eid] ?? 0) !== 1) continue;
    const familyIndex = familyIdField[eid] ?? -1;
    if (familyIndex < 0 || familyIndex >= presentFamilies.length) continue;
    const familyId = presentFamilies[familyIndex];
    if (familyId) {
      livingBossFamilies.add(familyId);
    }
  }
  const allDensUnlocked = presentFamilies.every(
    (familyId) => world.goalFlags.get(denUnlockGoalId(familyId)) === true,
  );
  const allBossEntitiesGone = livingBossFamilies.size === 0;
  if (!allBossesDead && allDensUnlocked && allBossEntitiesGone) {
    for (const familyId of presentFamilies) {
      // Second defeat-latch: fires when a family's boss ECS entity vanishes
      // without a normal `death` combat event (e.g. all dens unlocked while the
      // boss entity was otherwise despawned/recycled). Routed through the
      // shared latch so the family's den encounter is reconciled too — chest
      // created at the recorded den spawn point, defeat goal latched, and the
      // den's relock flag cleared so a player standing in that den is never
      // sealed in behind a boss that no longer exists.
      latchFloor2FamilyDefeated(world, familyId);
    }
  }
  const allBossesResolved = allBossesDead || (allDensUnlocked && allBossEntitiesGone);
  const soleAliveFamily = aliveFamilies.length === 1 ? aliveFamilies[0]! : null;
  const soleAllyWin =
    soleAliveFamily !== null && getRelation(world, soleAliveFamily) > 75 && !allBossesResolved;

  if (!soleAllyWin && !allBossesResolved) return;

  latchFloor2Victory(world);
}

/**
 * Called when the player confirms exit descent on Floor 2.
 * Sets `staircaseDiscovered` and transitions `world.state` to `'safe_room'`.
 * Returns `true` on success, `false` if preconditions not met.
 */
export function confirmFloor2StairDescend(
  world: GameWorld,
  _playerEid: number,
  achievementRegistry?: AchievementCatalogRegistry,
): boolean {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State || world.state !== 'playing') return false;
  if (!floor2State.staircaseSpawned || !floor2State.staircaseUnlocked) return false;
  if (floor2State.staircaseDiscovered) return false;
  floor2State.staircaseDiscovered = true;
  setGoalFlag(world, FLOOR2_STAIRS_DISCOVERED_GOAL_ID, true);
  // The visual scene switches to safe_room immediately after this callback returns,
  // so complete any goal-backed finale quests before the state flip.
  questSystem(world);
  evaluateAchievementUnlocksForPhase(world, 'run_end_clear', achievementRegistry);
  world.state = 'safe_room';
  return true;
}

/**
 * Spawn Floor 2 harvestable ore and gem nodes across passable tiles in normal
 * and spawn rooms. Only the Floor 2 entries in HARVESTABLE_DEFS (indices
 * FLOOR2_HARVESTABLE_START_INDEX and above) are considered — Floor 1 mushroom/
 * flower/lichen defs are never placed here. Each def spawns between 2 and
 * maxPerFloor nodes, spaced ≥3 ft apart.
 *
 * Accepts an explicit `rng` so callers can pass an isolated SeededRandom
 * derived from world.seed without consuming the main world.rng stream (which
 * would shift AI decisions and break headless telemetry invariants).
 */
function spawnFloor2HarvestableNodes(world: GameWorld, rng: SeededRandom): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;

  const normalRooms = floorMap.roomGraph
    .getAll()
    .filter((room) => room.role === RoomRole.NORMAL || room.role === RoomRole.SPAWN);

  if (normalRooms.length === 0) return;

  for (
    let defIndex = FLOOR2_HARVESTABLE_START_INDEX;
    defIndex < FLOOR2_HARVESTABLE_END_INDEX;
    defIndex++
  ) {
    const def = HARVESTABLE_DEFS[defIndex]!;
    const count = 2 + rng.nextInt(0, def.maxPerFloor - 2);

    const placed: Array<{ x: number; y: number }> = [];

    const maxAttempts = count * 12;
    for (let attempt = 0; attempt < maxAttempts && placed.length < count; attempt++) {
      const room = normalRooms[rng.nextInt(0, normalRooms.length - 1)]!;
      const { x: bx, y: by, width: bw, height: bh } = room.bounds;

      const tx = bx + 1 + rng.nextInt(0, Math.max(0, bw - 3));
      const ty = by + 1 + rng.nextInt(0, Math.max(0, bh - 3));

      if (!floorMap.tileMap.isPassable(tx, ty)) continue;

      const pos = floorMap.tileToWorld(tx, ty);

      const tooClose = placed.some((p) => {
        const ddx = p.x - pos.x;
        const ddy = p.y - pos.y;
        return ddx * ddx + ddy * ddy < 9;
      });
      if (tooClose) continue;

      placed.push(pos);
      spawnHarvestableNode(world, pos.x, pos.y, defIndex);
    }
  }
}

/**
 * Floor 2 scenario initializer used by scenario wiring (Slice 8).
 */
export function initializeFloor2Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const manifest = getFloorManifest('floor2');
  if (!manifest) {
    throw new Error('Missing floor2 manifest');
  }

  const floor2Config = manifest.floor2;
  const families = loadFamilies();
  const resources = loadResources();

  const configuredFamilyPool = floor2Config?.familyPool;
  if (configuredFamilyPool && configuredFamilyPool.length > 0) {
    const knownFamilyIds = new Set(families.map((family) => family.id));
    const unknownFamilyIds = configuredFamilyPool.filter(
      (familyId) => !knownFamilyIds.has(familyId),
    );
    if (unknownFamilyIds.length > 0) {
      throw new Error(
        `floor2 manifest misconfigured: floor2.familyPool contains unknown family ids: ${unknownFamilyIds.join(', ')}`,
      );
    }
  }
  const familyPool =
    configuredFamilyPool && configuredFamilyPool.length > 0
      ? families.filter((family) => configuredFamilyPool.includes(family.id))
      : families;
  if (familyPool.length < 4) {
    throw new Error(
      `floor2 manifest misconfigured: floor2.familyPool resolves to ${familyPool.length} families (minimum 4 required for roster selection)`,
    );
  }

  const configuredResourcePool = floor2Config?.resourcePool;
  if (configuredResourcePool && configuredResourcePool.length > 0) {
    const knownResourceIds = new Set(resources.map((resource) => resource.id));
    const unknownResourceIds = configuredResourcePool.filter(
      (resourceId) => !knownResourceIds.has(resourceId),
    );
    if (unknownResourceIds.length > 0) {
      throw new Error(
        `floor2 manifest misconfigured: floor2.resourcePool contains unknown resource ids: ${unknownResourceIds.join(', ')}`,
      );
    }
  }
  const resourcePool =
    configuredResourcePool && configuredResourcePool.length > 0
      ? resources.filter((resource) => configuredResourcePool.includes(resource.id))
      : resources;
  if (resourcePool.length === 0) {
    throw new Error(
      'floor2 manifest misconfigured: floor2.resourcePool resolves to zero resources',
    );
  }

  const presentCount = floor2Config?.presentCount;
  const roster = selectFloor2Roster(world.rng, familyPool, resourcePool, {
    presentCountFourProbability: presentCount === 4 ? 1 : presentCount === 3 ? 0 : undefined,
  });
  initializeFactionRelations(world, roster.presentFamilies);

  world.floorExtendedState = {
    familyState: {
      presentFamilies: roster.presentFamilies.slice(),
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
      // Reputation system starts locked; unlocked by floor2ObjectiveTick once
      // the Broker intro completion flag (FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID) is set.
      reputationSystemActive: false,
    },
    trashTerritories: assignQuadrantTrashTerritories(world),
    ambientEnemyArchetypes: new Map<number, string>(),
  };
  world.floorScenario = null;
  setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_STAIRS_POPPED_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_TIMEOUT_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_SETTLEMENT_FOUND_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_STAIRS_DISCOVERED_GOAL_ID, false);
  setGoalFlag(world, 'floor2-leave-floor-complete', false);

  // All Floor 1 progressive systems are active from the start of Floor 2.
  // Players arrive here having already unlocked these features on Floor 1.
  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.equipmentPanel = true;
  world.featureUnlocks.spells = true;
  // Floor 2 runtime owns the generated-equipment reward economy; enable the
  // full dependency closure so Floor 2 achievement equipment rewards, the
  // Quartermaster/shop stock economy, and boss-chest reward resolution can all
  // run in shipped gameplay paths. `floor2EquipmentEconomy` gates
  // Quartermaster stock generation/purchasing (quartermaster-stock.ts,
  // quartermaster-purchase.ts) and boss chest reward resolution
  // (boss-chest-resolver.ts) — both already wired to real Floor 2 events but
  // previously inert because this flag defaulted to false in the shipped
  // path. Boss chests currently resolve at Common rarity (tier1, see
  // boss-chest-resolver.ts); the 85/15 Uncommon/Rare split from
  // PLAN.md §E3-C is a future task not yet implemented.
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentRewards = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  // `floor2EquipmentAiMaintenance` gates the headless/behavior-tree AI's
  // ability to act on the generated stock this flag closure produces
  // (purchase + equip via `runSettlementMaintenancePlanner`). Without this,
  // the economy would be generated but have zero real consumer that ever
  // acts on it — the same "shipped inert" failure class this flag closure
  // exists to eliminate. Interactive gameplay consumes the same economy
  // through MainGameScene's settlement shop interaction flow.
  world.floor2EquipmentFlags.floor2EquipmentAiMaintenance = true;
  if (!options?.playerCarryover) {
    applyFloor2DirectStartPlayerState(world, playerEid);
    initializePlayerWeaponSkills(world, playerEid);
    ensureBossBattleSpellReward(world, playerEid);
  }
  setGoalFlag(world, 'floor1-drops-unlocked', true);

  removeStatModifiers(world, 'floor', 'floor2-manifest-player');
  if (manifest.player.moveSpeedBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: 'floor2-manifest-player',
      stat: 'moveSpeed',
      op: 'add',
      value: manifest.player.moveSpeedBonus,
    });
  }
  if (manifest.player.pickupRangeBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: 'floor2-manifest-player',
      stat: 'pickupRange',
      op: 'add',
      value: manifest.player.pickupRangeBonus,
    });
  }

  const configuredShopArchetypes = floor2Config?.settlement?.shopArchetypes;
  let settlementArchetypes: ReturnType<typeof loadShopArchetypes> | undefined;
  if (configuredShopArchetypes && configuredShopArchetypes.length > 0) {
    const allArchetypes = loadShopArchetypes();
    const knownArchetypeIds = new Set(allArchetypes.map((archetype) => archetype.id));
    const unknownArchetypes = configuredShopArchetypes.filter((id) => !knownArchetypeIds.has(id));
    if (unknownArchetypes.length > 0) {
      throw new Error(
        `floor2 manifest misconfigured: floor2.settlement.shopArchetypes contains unknown ids: ${unknownArchetypes.join(', ')}`,
      );
    }
    settlementArchetypes = allArchetypes.filter((archetype) =>
      configuredShopArchetypes.includes(archetype.id),
    );
    if (settlementArchetypes.length === 0) {
      throw new Error(
        'floor2 manifest misconfigured: floor2.settlement.shopArchetypes resolves to zero archetypes',
      );
    }
  }

  const mapConfig: MapConfig = {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.CAVE_SYSTEM,
    seed: world.rng.nextInt(1, 2_000_000),
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    caveSystem: {
      ...FLOOR2_CAVE_SYSTEM_DEFAULTS,
      presentCount: roster.presentFamilies.length,
    },
  };
  const floorMap = getGenerator(mapConfig.biome).generate(mapConfig, world.rng);
  world.floorMap = floorMap;
  attachBarriersToFloorMap(world);
  installResourceHeartDoorLocks(world, floorMap);
  world.floor = 2;
  world.floorId = 'floor2';
  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }
  if (!options?.playerCarryover) {
    const maxHp = (world.stores.health.max[playerEid] ?? 100) + manifest.player.hpBonus;
    setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });
  }

  const objectives = initializeFloor2Bosses(
    world,
    floorMap,
    world.floorExtendedState!.familyState!,
  );
  acceptQuest(world, FLOOR2_FIND_SETTLEMENT_QUEST_ID);
  for (const objective of objectives) {
    acceptQuest(world, objective.questId);
  }
  setTrackedQuest(world, FLOOR2_FIND_SETTLEMENT_QUEST_ID);
  if (floor2Config?.governor?.autoUnlockDens === true) {
    for (const objective of objectives) {
      setGoalFlag(world, objective.unlockGoalId, true);
    }
    for (const doorEid of query(world.ecs, [DoorState])) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.logicalOpen[doorEid] = 1;
    }
  }

  const settlementShopRange = floor2Config?.settlement?.shopCountRange;
  const shopCount =
    settlementShopRange !== undefined
      ? world.rng.nextInt(settlementShopRange[0], settlementShopRange[1])
      : undefined;

  if (options?.playerCarryover) {
    restorePlayerCarryover(world, playerEid, options.playerCarryover);
    initializePlayerWeaponSkills(world, playerEid);
  }

  initializeFloor2Settlement(world, {
    ...(shopCount === 1 || shopCount === 2 ? { shopCount } : {}),
    ...(settlementArchetypes ? { archetypes: settlementArchetypes } : {}),
    ...(options?.playerCarryover
      ? { effectivePlayerLevel: options.playerCarryover.playerLevel.level }
      : {}),
  });

  if (!options?.playerCarryover) {
    // Use seeded RNG to pick starter weapon, matching Floor 1 pattern
    // so player gets the same weapon on the same seed for consistency.
    const starterWeaponPool = manifest.starterWeapons;
    let selectedWeaponId: string | null = null;
    if (starterWeaponPool && starterWeaponPool.length > 0) {
      const weaponRng = new SeededRandomClass(
        hashStringToSeed(`${world.seed}:floor2-starter-weapon`),
      );
      const picked = starterWeaponPool[weaponRng.nextInt(0, starterWeaponPool.length - 1)];
      if (picked) {
        const weaponDef = getWeaponDef(picked);
        if (weaponDef) {
          selectedWeaponId = weaponDef.id;
          equipStarterOrFallback(world, weaponDef.id, weaponDef);
        }
      }
    }

    if (!selectedWeaponId && manifest.starterWeapons && manifest.starterWeapons.length > 0) {
      const fallbackId = manifest.starterWeapons[0];
      if (fallbackId) {
        const fallbackDef = getWeaponDef(fallbackId);
        if (fallbackDef) {
          equipStarterOrFallback(world, fallbackDef.id, fallbackDef);
        }
      }
    }
  }

  if (floor2Config?.governor?.autoVictoryOnStart === true) {
    latchFloor2Victory(world);
  }

  // Place ambient scene-dressing props (mining carts, support beams, cave
  // rubble, pipe sections, lanterns, glowing crystals) using an isolated RNG
  // seeded from world.seed so the main world.rng stream is unaffected and
  // headless simulation results stay deterministic and unchanged.
  if (manifest.props !== undefined) {
    const propsRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor2-props`));
    placePropsForFloor(world, world.floorMap!, manifest.props, propsRng);
  }

  // Spawn Floor 2 harvestable ore / gem nodes after map and settlement are
  // fully set up so room roles are final before tile sampling.  Uses an
  // isolated RNG so the main world.rng stream is unaffected.
  const harvestRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor2-harvestables`));
  spawnFloor2HarvestableNodes(world, harvestRng);

  world.state = 'playing';
  world.floorObjectiveTick = floor2ObjectiveTick;
}

/**
 * Read-side of the spawn-gating rule (FR14). Returns true once the family's
 * boss has been defeated; the spawner should skip that family thereafter.
 * Already-spawned members persist naturally via the enemy lifecycle.
 */
export function isFamilySpawnGated(world: GameWorld, familyId: FamilyId): boolean {
  return ensureDecapitatedSet(world).has(familyId);
}

/**
 * Whether a family's boss-den has been unlocked. Reads the goal flag so any
 * caller (HUD, AI system, tests) can share the same truth.
 */
export function isDenUnlocked(world: GameWorld, familyId: FamilyId): boolean {
  return world.goalFlags.get(denUnlockGoalId(familyId)) === true;
}

/**
 * Mark a family's den as unlocked. Test/lab-friendly helper — production
 * callers set the flag via quest completion (which routes through
 * `questSystem` → `onCompleteGoalFlag`).
 */
export function markDenUnlocked(world: GameWorld, familyId: FamilyId): void {
  setGoalFlag(world, denUnlockGoalId(familyId), true);
}

// Internal helpers ---------------------------------------------------------

function ensureDecapitatedSet(world: GameWorld): Set<FamilyId> {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) {
    // No Floor-2 state on non-Floor-2 worlds; return a throwaway set so
    // callers can no-op through this helper safely.
    return new Set<FamilyId>();
  }
  if (!floor2State.decapitatedFamilies) {
    floor2State.decapitatedFamilies = new Set<FamilyId>();
  }
  return floor2State.decapitatedFamilies;
}

function popFloor2ResourceHeartStairs(world: GameWorld): void {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) return;
  if (world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID) === true) return;

  const stairTile = findResourceHeartStairTile(world);
  if (!stairTile || !world.floorMap) return;

  floor2State.staircasePos = world.floorMap.tileToWorld(stairTile.x, stairTile.y);
  floor2State.staircaseSpawned = true;
  floor2State.staircaseUnlocked = true;
  setGoalFlag(world, FLOOR2_STAIRS_POPPED_GOAL_ID, true);
  if (!world.questLog.has(FLOOR2_LEAVE_FLOOR_QUEST_ID)) {
    acceptQuest(world, FLOOR2_LEAVE_FLOOR_QUEST_ID);
    setTrackedQuest(world, FLOOR2_LEAVE_FLOOR_QUEST_ID);
  }
}

function latchFloor2Victory(world: GameWorld): void {
  setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
  popFloor2ResourceHeartStairs(world);
}

function applyFloor2DirectStartPlayerState(world: GameWorld, playerEid: number): void {
  if (!hasComponent(world.ecs, playerEid, BaseStats)) {
    initializeBaseStats(world, playerEid);
  }

  applyStartPlayerLevel(world, FLOOR2_DIRECT_START_LEVEL);
  const allocations = computeAutoStatAllocation(world, playerEid, world.playerLevel.unspentPoints);
  if (Object.keys(allocations).length > 0) {
    spendPoints(world, allocations);
  }
  statSystem(world);

  unequip(world, playerEid, 'neck', { force: true });
  equip(world, playerEid, MERCHANTS_CHARM_DEF, { force: true });
}

function findResourceHeartStairTile(world: GameWorld): { x: number; y: number } | null {
  const floorMap = world.floorMap;
  if (!floorMap) return null;

  const heart = floorMap.roomGraph.getFirstRoomByRole(RoomRole.RESOURCE_HEART);
  const terrain = floorMap.terrain;
  const w = floorMap.width;
  const h = floorMap.height;
  const cx = heart ? heart.bounds.x + heart.bounds.width / 2 : w / 2;
  const cy = heart ? heart.bounds.y + heart.bounds.height / 2 : h / 2;

  let best: { x: number; y: number; dist2: number; idx: number } | null = null;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = y * w + x;
      if (terrain[idx] !== TerrainType.BOSS_STAIR_FLOOR) continue;
      if (!floorMap.tileMap.isPassable(x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      const dist2 = dx * dx + dy * dy;
      if (!best || dist2 < best.dist2 || (dist2 === best.dist2 && idx < best.idx)) {
        best = { x, y, dist2, idx };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/**
 * Determine which quadrant contains a world position.
 * Returns 'N', 'S', 'E', or 'W'.
 */
export function getQuadrantForPosition(
  world: GameWorld,
  x: number,
  y: number,
): 'N' | 'S' | 'E' | 'W' {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return 'N';
  }
  const centerX = (floorMap.width * floorMap.config.tileSizeFt) / 2;
  const centerY = (floorMap.height * floorMap.config.tileSizeFt) / 2;

  const isWest = x < centerX;
  const isNorth = y < centerY;

  if (isWest) {
    return isNorth ? 'N' : 'S';
  } else {
    return isNorth ? 'E' : 'W';
  }
}

/**
 * Determine spawn weight for each quadrant based on player position.
 * Returns a map of quadrant ID to weight (0-1).
 */
export function getQuadrantSpawnWeights(playerQuadrant: string): Map<string, number> {
  const weights = new Map<string, number>();
  const neighbors = new Map<string, string[]>([
    ['N', ['E', 'S']],
    ['S', ['N', 'W']],
    ['E', ['N', 'W']],
    ['W', ['S', 'E']],
  ]);
  const opposite = new Map<string, string>([
    ['N', 'W'],
    ['S', 'E'],
    ['E', 'S'],
    ['W', 'N'],
  ]);

  weights.set(playerQuadrant, 0.5); // Main: 50%
  for (const neighbor of neighbors.get(playerQuadrant) || []) {
    weights.set(neighbor, 0.2); // Neighbors: 20% each
  }
  weights.set(opposite.get(playerQuadrant) || 'N', 0.1); // Opposite: 10%
  return weights;
}

const FLOOR2_QUADRANTS = ['N', 'S', 'E', 'W'] as const;

function assignQuadrantTrashTerritories(world: GameWorld): Map<string, string> {
  const out = new Map<string, string>();
  const neutralTrash = getFloor2NeutralTrash();
  if (neutralTrash.length === 0) {
    return out;
  }
  const pool = neutralTrash.map((archetype) => archetype.id);
  const quadrantRng = new SeededRandomClass(
    hashStringToSeed(`${world.seed}:floor2-trash-territories`),
  );
  for (const quadrant of FLOOR2_QUADRANTS) {
    if (pool.length === 0) {
      out.set(quadrant, neutralTrash[quadrantRng.nextInt(0, neutralTrash.length - 1)]!.id);
      continue;
    }
    const pickIndex = quadrantRng.nextInt(0, pool.length - 1);
    out.set(quadrant, pool[pickIndex]!);
    pool.splice(pickIndex, 1);
  }
  return out;
}

/**
 * Resolve Floor 2 ambient probabilities at the player's current position.
 * Family territories reserve 75% of the probability mass and neutral trash
 * reserves 25%. Overlapping family territories share the family mass instead
 * of stacking independent 75% allocations.
 */
export function resolveFloor2TrashSpawnWeights(
  world: GameWorld,
  x: number,
  y: number,
): ReadonlyMap<string, number> {
  const familyZone = collectFamilyTerritoryZoneWeights(world, x, y);
  const quadrantZone = collectQuadrantZoneWeights(world, x, y);
  const globalZone = collectGlobalFallbackZoneWeights(world);
  const neutralZone = mergeSpawnZoneWeights([quadrantZone, globalZone]);
  if (familyZone.size === 0) {
    return normalizeSpawnZoneWeights(neutralZone);
  }
  return mixSpawnZoneWeights([
    { weights: familyZone, share: FLOOR2_TERRITORY_FAMILY_SPAWN_SHARE },
    { weights: neutralZone, share: FLOOR2_TERRITORY_NEUTRAL_SPAWN_SHARE },
  ]);
}

function pickFloor2TrashArchetype(world: GameWorld, x: number, y: number): EnemyArchetypeDef {
  const weights = resolveFloor2TrashSpawnWeights(world, x, y);
  const { pickedId } = pickFromSpawnZones(
    [weights] as const satisfies readonly SpawnZoneWeights[],
    () => world.rng.next(),
  );
  if (pickedId !== null) {
    const picked = floor2EnemyPack.archetypes.find((entry) => entry.id === pickedId);
    if (picked) {
      return picked;
    }
  }

  // Hard fallback only for malformed/empty packs.
  const neutralTrash = getFloor2NeutralTrash();
  const neutralFallback = floor2EnemyPack.archetypes[0];
  if (!neutralFallback) {
    throw new Error('No archetypes available in floor2EnemyPack');
  }
  if (neutralTrash.length > 0) {
    return neutralTrash[world.rng.nextInt(0, neutralTrash.length - 1)]!;
  }
  return neutralFallback;
}

export function resolveAmbientFamilyIndex(world: GameWorld, archetypeId: string): number {
  const familyState = world.floorExtendedState?.familyState;
  const presentFamilies = familyState?.presentFamilies ?? [];
  if (presentFamilies.length === 0) {
    return -1;
  }
  const archetype = floor2EnemyPack.archetypes.find((entry) => entry.id === archetypeId);
  if (!archetype?.familyId) {
    return -1;
  }
  return presentFamilies.indexOf(archetype.familyId as (typeof presentFamilies)[number]);
}

function addWeight(weights: Map<string, number>, archetypeId: string, weight: number): void {
  if (!(weight > 0) || !Number.isFinite(weight)) {
    return;
  }
  weights.set(archetypeId, (weights.get(archetypeId) ?? 0) + weight);
}

function collectFamilyTerritoryZoneWeights(
  world: GameWorld,
  x: number,
  y: number,
): Map<string, number> {
  const weights = new Map<string, number>();
  const familyState = world.floorExtendedState?.familyState;
  const floorMap = world.floorMap;
  if (!familyState || !floorMap) {
    return weights;
  }
  const zones = floorMap.territoryZones;
  if (zones.length === 0) {
    return weights;
  }
  const tile = floorMap.worldToTile(x, y);
  for (const zone of zones) {
    if (zone.familyIndex < 0 || zone.familyIndex >= familyState.presentFamilies.length) {
      continue;
    }
    const dx = tile.x - zone.centerX;
    const dy = tile.y - zone.centerY;
    if (dx * dx + dy * dy > zone.radius * zone.radius) {
      continue;
    }
    const familyId = familyState.presentFamilies[zone.familyIndex]!;
    if (isFamilySpawnGated(world, familyId)) {
      continue;
    }
    const familyTrash = getFloor2FamilyTrash(familyId);
    for (const archetype of familyTrash) {
      addWeight(weights, archetype.id, archetype.spawnWeight);
    }
  }
  return weights;
}

function collectQuadrantZoneWeights(world: GameWorld, x: number, y: number): Map<string, number> {
  const weights = new Map<string, number>();
  const territories = world.floorExtendedState?.trashTerritories;
  if (!territories || territories.size === 0) {
    return weights;
  }
  const quadrant = getQuadrantForPosition(world, x, y);
  const archetypeId = territories.get(quadrant);
  if (!archetypeId) {
    return weights;
  }
  addWeight(weights, archetypeId, 1);
  return weights;
}

function collectGlobalFallbackZoneWeights(world: GameWorld): Map<string, number> {
  const weights = new Map<string, number>();
  const territories = world.floorExtendedState?.trashTerritories;
  if (territories && territories.size > 0) {
    for (const archetypeId of territories.values()) {
      addWeight(weights, archetypeId, 1);
    }
    return weights;
  }
  const neutralTrash = getFloor2NeutralTrash();
  for (const archetype of neutralTrash) {
    addWeight(weights, archetype.id, archetype.spawnWeight);
  }
  return weights;
}

function isBossDenSpawn(world: GameWorld, x: number, y: number): boolean {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return false;
  }
  const tile = floorMap.worldToTile(x, y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) {
    return false;
  }
  return floorMap.roomGraph.get(roomId)?.role === RoomRole.BOSS_DEN;
}

function findNearestPassableTile(
  world: GameWorld,
  startX: number,
  startY: number,
  maxRadius: number = 6,
): { x: number; y: number } | null {
  const floorMap = world.floorMap;
  if (!floorMap) return null;
  const tileMap = floorMap.tileMap;
  if (tileMap.inBounds(startX, startY) && tileMap.isPassable(startX, startY)) {
    return { x: startX, y: startY };
  }
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) {
          continue;
        }
        const x = startX + dx;
        const y = startY + dy;
        if (!tileMap.inBounds(x, y) || !tileMap.isPassable(x, y)) {
          continue;
        }
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * Return a Floor 2 family boss to its den if it has left the den room.
 *
 * The den doors relock on the encounter's `activeGoalId`, so an out-of-den boss
 * at encounter start seals the player into an empty room with a boss that is
 * still `started` (HUD bar visible, damageable through walls by homing spells)
 * but can never be killed — and the relock only clears on the boss-death latch.
 * That is a hard softlock, so containment is unconditional rather than
 * best-effort: if the boss is anywhere other than its own den room, it is
 * teleported back to the spawn tile recorded at floor init.
 *
 * No-op when the boss is already inside its den, so calling this every start
 * attempt is free in the common case.
 *
 * @returns `true` when the boss was relocated.
 */
function containFloor2BossInDen(
  world: GameWorld,
  encounter: Floor2FamilyBossEncounterState,
): boolean {
  const floorMap = world.floorMap;
  const bossEid = encounter.bossEid;
  const spawnX = encounter.bossSpawnX;
  const spawnY = encounter.bossSpawnY;
  if (!floorMap || bossEid === null || spawnX === undefined || spawnY === undefined) {
    return false;
  }
  const tile = floorMap.worldToTile(
    world.stores.position.x[bossEid] ?? 0,
    world.stores.position.y[bossEid] ?? 0,
  );
  if (floorMap.roomGraph.getRoomAt(tile.x, tile.y) === encounter.roomId) {
    return false;
  }
  world.stores.position.x[bossEid] = spawnX;
  world.stores.position.y[bossEid] = spawnY;
  return true;
}

function unstickFloor2Bosses(world: GameWorld): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  const encounterByBossEid = new Map<number, Floor2FamilyBossEncounterState>();
  const encounters = world.floorExtendedState?.familyState?.bossEncounters;
  if (encounters) {
    for (const encounter of encounters.values()) {
      // A recycled `bossEid` can point at unrelated trash; keying the den-spawn
      // fallback on it would teleport that entity into the den.
      if (encounter.bossEid !== null && isLiveFamilyBoss(world, encounter)) {
        encounterByBossEid.set(encounter.bossEid, encounter);
      }
    }
  }
  for (const eid of query(world.ecs, [Enemy, Health, FamilyMembership, Position])) {
    if ((world.stores.familyMembership.isBoss[eid] ?? 0) !== 1) {
      continue;
    }
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    const tile = floorMap.worldToTile(x, y);
    if (floorMap.tileMap.inBounds(tile.x, tile.y) && floorMap.tileMap.isPassable(tile.x, tile.y)) {
      continue;
    }
    const nearest = findNearestPassableTile(world, tile.x, tile.y);
    if (!nearest) {
      continue;
    }
    // Never unstick a boss OUT of its own den: the den doors relock on the
    // encounter flag, and a boss nudged into an adjacent room or corridor
    // produces the same sealed-room softlock as an out-of-den encounter start.
    // Fall back to the recorded den spawn tile instead of the nearest tile.
    const encounter = encounterByBossEid.get(eid);
    if (
      encounter &&
      encounter.bossSpawnX !== undefined &&
      encounter.bossSpawnY !== undefined &&
      floorMap.roomGraph.getRoomAt(nearest.x, nearest.y) !== encounter.roomId
    ) {
      world.stores.position.x[eid] = encounter.bossSpawnX;
      world.stores.position.y[eid] = encounter.bossSpawnY;
      continue;
    }
    const worldPos = floorMap.tileToWorld(nearest.x, nearest.y);
    world.stores.position.x[eid] = worldPos.x;
    world.stores.position.y[eid] = worldPos.y;
  }
}

/**
 * Spawn one Floor 2 ambient archetype with quadrant-based trash weighting,
 * scaling stats based on distance from spawn.
 */
function spawnFloor2AmbientArchetype(
  world: GameWorld,
  x: number,
  y: number,
  selectionX: number,
  selectionY: number,
): number {
  const selectedArchetype = pickFloor2TrashArchetype(world, selectionX, selectionY);
  let hp = selectedArchetype.hp;
  let speed = selectedArchetype.speed;
  if (world.floorMap) {
    const spawnWorld = world.floorMap.tileToWorld(
      world.floorMap.playerSpawn.x,
      world.floorMap.playerSpawn.y,
    );
    const scaled = scaleAmbientSpawnStats(
      selectedArchetype.hp,
      selectedArchetype.speed,
      x,
      y,
      spawnWorld.x,
      spawnWorld.y,
    );
    hp = scaled.hp;
    speed = scaled.speed;
  }

  const aiType = resolveFloor2ArchetypeAIType(selectedArchetype);
  const attackRange = aiType === AI_TYPE.RANGED ? selectedArchetype.detectRange * 0.65 : 0;
  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    hp,
    aiType,
    speed,
    selectedArchetype.detectRange,
    attackRange,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: selectedArchetype.spriteTexture,
    width: selectedArchetype.spriteWidth,
    height: selectedArchetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius:
      selectedArchetype.collisionRadius ??
      Math.max(selectedArchetype.spriteWidth, selectedArchetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, selectedArchetype.id);
  const familyIndex = resolveAmbientFamilyIndex(world, selectedArchetype.id);
  if (familyIndex >= 0) {
    addComponent(world.ecs, eid, set(FamilyMembership, { familyId: familyIndex, isBoss: 0 }));
  }

  world.floorExtendedState?.ambientEnemyArchetypes?.set(eid, selectedArchetype.id);
  return eid;
}

/**
 * Floor 2 enemy director system — continuous ambient spawning with quadrant-based trash territories.
 *
 * Divides the map into 4 quadrants (N, S, E, W) and assigns one trash archetype per
 * quadrant. When spawning, uses weighted probabilities based on player position:
 *   - 50% chance: main archetype for the player's current quadrant
 *   - 20% chance each: neighboring quadrants
 *   - 10% chance: opposite quadrant
 *
 * Otherwise reuses Floor 1's continuous ambient director logic: maintains a global
 * enemy cap, pre-populates rooms with waves, and burst-spawns near the player.
 */
export function floor2EnemyDirectorSystem(world: GameWorld): void {
  if (world.state !== 'playing') {
    return;
  }

  // For Floor 2, we don't have world.floorScenario (it's null).
  // Check for Floor 2 state instead.
  if (world.floor !== 2) {
    return;
  }

  const players = query(world.ecs, [Player, Position]);
  const player = players[0];
  if (player === undefined) {
    return;
  }

  const pack = floor2EnemyPack;
  const playerX = world.stores.position.x[player] ?? 0;
  const playerY = world.stores.position.y[player] ?? 0;

  // Recycle mobs left far behind, then enforce the global ceiling.
  pruneAmbientOutOfRange(world, playerX, playerY);
  const overflow = countDirectorEnemies(world) - pack.enemyCap;
  if (overflow > 0) {
    pruneAmbientOverflow(world, playerX, playerY, overflow);
  }

  // Engagement top-up, throttled to one burst per spawn interval.
  const state = getSpawnerState(world);
  if (world.elapsedMs - state.lastSpawnMs < pack.spawnIntervalMs) {
    return;
  }

  const engageRadiusSq = pack.engageRadiusFt * pack.engageRadiusFt;
  const engaging = countEngagingEnemies(world, playerX, playerY, engageRadiusSq);
  if (engaging >= pack.engageTarget) {
    return;
  }

  const burst = Math.min(pack.engageTarget - engaging, pack.maxSpawnsPerTick);
  for (let i = 0; i < burst; i += 1) {
    // At the global cap, make room near the player by recycling the furthest straggler.
    if (countDirectorEnemies(world) >= pack.enemyCap) {
      if (evictFurthestAmbient(world, playerX, playerY, engageRadiusSq, 1) === 0) {
        break;
      }
    }
    let spawnPoint: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = resolveAmbientSpawnPoint(world, playerX, playerY);
      if (!candidate) {
        break;
      }
      if (isBossDenSpawn(world, candidate.x, candidate.y)) {
        continue;
      }
      spawnPoint = candidate;
      break;
    }
    if (!spawnPoint) {
      break;
    }
    spawnFloor2AmbientArchetype(world, spawnPoint.x, spawnPoint.y, playerX, playerY);
  }
  state.lastSpawnMs = world.elapsedMs;
}
