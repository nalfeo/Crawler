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
import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import {
  BroadcastScore,
  Damage,
  DoorState,
  FamilyMembership,
  Health,
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
  getRelation,
  initializeFactionRelations,
  selectFloor2Roster,
  type FamilyId,
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
import { floor2EnemyPack, getFloor2BossArchetype } from '../shared/enemy-packs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { loadResources } from '../shared/data/resources.js';
import { loadShopArchetypes } from '../shared/data/shop-archetypes.js';
import {
  loadDenUnlockArchetypes,
  type DenUnlockArchetype,
} from '../shared/data/den-unlock-archetypes.js';
import { loadFamilies, type FamilyDef } from '../shared/data/families.js';
import { initializeFloor2Settlement } from './floor2Settlement.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { setActiveWeapon } from './weaponSystem.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import {
  installQuestPacks,
  type QuestPackDef,
  type QuestPackQuestSource,
  getQuestPacks,
} from '../shared/quest-types.js';
import type { SeededRandom } from '../shared/random.js';

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

/** Goal-flag name for a family's den-unlock latch. */
export function denUnlockGoalId(familyId: FamilyId): string {
  return `floor2-den-${familyId}-unlocked`;
}

/** Goal-flag name for a family's boss-defeat latch. */
export function bossDefeatGoalId(familyId: FamilyId): string {
  return `floor2-family-${familyId}-boss-defeated`;
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
  if (archetypes.length === 0) {
    throw new Error('selectDenUnlockObjectives requires at least one archetype');
  }
  const out = new Map<FamilyId, string>();
  for (const familyId of presentFamilies) {
    const idx = rng.nextInt(0, archetypes.length - 1);
    out.set(familyId, archetypes[idx]!.id);
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
    const family = families.get(familyId);
    const familyName = family?.name ?? familyId;
    const questId = `floor2-den-${familyId}-unlock`;
    const goalId = denUnlockGoalId(familyId);
    const label = archetype.objectiveLabel.replace('{familyName}', familyName);

    switch (archetype.kind) {
      case 'killTargets':
        quests.push({
          id: questId,
          title: `${archetype.title} — ${familyName}`,
          summary: archetype.summary,
          onCompleteGoalFlag: goalId,
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
        break;
      case 'collect':
        quests.push({
          id: questId,
          title: `${archetype.title} — ${familyName}`,
          summary: archetype.summary,
          onCompleteGoalFlag: goalId,
          objectives: [
            {
              id: `${questId}-collect`,
              label,
              kind: 'collect',
              itemId: `floor2-${familyId}-${archetype.itemIdSuffix}`,
              target: archetype.collectTarget,
            },
          ],
        });
        break;
      case 'friendly':
        quests.push({
          id: questId,
          title: `${archetype.title} — ${familyName}`,
          summary: archetype.summary,
          onCompleteGoalFlag: goalId,
          template: {
            kind: 'goalFlag',
            objectiveId: `${questId}-friendly`,
            label,
            goalId: `floor2-family-${familyId}-friendly-reached`,
          },
        });
        break;
      case 'goalFlag':
        quests.push({
          id: questId,
          title: `${archetype.title} — ${familyName}`,
          summary: archetype.summary,
          onCompleteGoalFlag: goalId,
          template: {
            kind: 'goalFlag',
            objectiveId: `${questId}-flag`,
            label,
            goalId: `floor2-family-${familyId}-${archetype.goalIdSuffix}`,
          },
        });
        break;
    }
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
  const behaviorType =
    archetype.aiType === 'ranged'
      ? AI_TYPE.CHASE // ranged variants still chase; ranged attack cadence is a Slice 3 concern
      : AI_TYPE.CHASE;
  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    archetype.hp,
    behaviorType,
    archetype.speed,
    archetype.detectRange,
    Math.max(160, archetype.detectRange * 4),
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius: Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  addComponent(world.ecs, eid, set(FamilyMembership, { familyId: familyIdIndex, isBoss: 1 }));
  // Bosses hit hard on contact; ranged behaviour is layered later.
  setComponent(world.ecs, eid, Damage, { amount: 10 });
  // Keep bosses permanently aggressive inside their den.
  world.stores.enemyBehavior.aggroedPermanently[eid] = 1;
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
export function installBossDenDoorLocks(
  world: GameWorld,
  denRoom: RoomData,
  unlockGoalId: string,
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
        isOpen: 0,
        isLocked: 1,
        wasUnlocked: 0,
      }),
    );
    setDoorLockConfig(world, doorEid, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: unlockGoalId }],
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
  const objectives: Floor2DenObjective[] = [];
  for (let familyIndex = 0; familyIndex < floor2State.presentFamilies.length; familyIndex += 1) {
    const familyId = floor2State.presentFamilies[familyIndex]!;
    const archetypeId = assignments.get(familyId);
    if (archetypeId === undefined) continue; // unreachable — assignments covers every present family

    const unlockGoalId = denUnlockGoalId(familyId);
    const defeatGoalId = bossDefeatGoalId(familyId);
    // Seed the flags false so anything that inspects them (Slice 5's win
    // evaluator, HUD) sees a deterministic starting state.
    setGoalFlag(world, unlockGoalId, false);
    setGoalFlag(world, defeatGoalId, false);
    decapitated.delete(familyId);

    const denRoom = findBossDenRoom(floorMap, familyIndex);
    if (!denRoom) {
      // Defensive: skip missing dens rather than crash floor init. The
      // reachability guarantee in CaveSystemGenerator should prevent this.
      continue;
    }
    installBossDenDoorLocks(world, denRoom, unlockGoalId);
    const spawn = pickBossSpawnTile(denRoom);
    spawnFamilyBoss(world, spawn.x, spawn.y, familyIndex, familyId);

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
 */
export function floor2ObjectiveTick(world: GameWorld): void {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State) return;
  const decapitated = ensureDecapitatedSet(world);
  const familyIdField = world.stores.familyMembership.familyId;
  const isBossField = world.stores.familyMembership.isBoss;

  for (const event of world.combatEvents) {
    if (event.type !== 'death') continue;
    const eid = event.targetEid;
    if (eid === undefined) continue;
    if (!hasComponent(world.ecs, eid, FamilyMembership)) continue;
    if ((isBossField[eid] ?? 0) !== 1) continue;
    const familyIndex = familyIdField[eid] ?? 0;
    const familyId = floor2State.presentFamilies[familyIndex];
    if (!familyId) continue;
    if (decapitated.has(familyId)) continue;

    decapitated.add(familyId);
    setGoalFlag(world, bossDefeatGoalId(familyId), true);
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
  const soleAliveFamily = aliveFamilies.length === 1 ? aliveFamilies[0]! : null;
  const soleAllyWin =
    soleAliveFamily !== null && getRelation(world, soleAliveFamily) > 75 && !allBossesDead;

  if (!soleAllyWin && !allBossesDead) return;

  setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
  popFloor2ResourceHeartStairs(world);
}

/**
 * Called when the player confirms exit descent on Floor 2.
 * Sets `staircaseDiscovered` and transitions `world.state` to `'safe_room'`.
 * Returns `true` on success, `false` if preconditions not met.
 */
export function confirmFloor2StairDescend(world: GameWorld, _playerEid: number): boolean {
  const floor2State = world.floorExtendedState?.familyState;
  if (!floor2State || world.state !== 'playing') return false;
  if (!floor2State.staircaseSpawned || !floor2State.staircaseUnlocked) return false;
  if (floor2State.staircaseDiscovered) return false;
  floor2State.staircaseDiscovered = true;
  world.state = 'safe_room';
  return true;
}

/**
 * Floor 2 scenario initializer used by scenario wiring (Slice 8).
 */
export function initializeFloor2Scenario(world: GameWorld, playerEid: number): void {
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
    },
  };
  world.floorScenario = null;
  setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, false);
  setGoalFlag(world, FLOOR2_STAIRS_POPPED_GOAL_ID, false);

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
    caveSystem: { presentCount: roster.presentFamilies.length },
  };
  const floorMap = getGenerator(mapConfig.biome).generate(mapConfig, world.rng);
  world.floorMap = floorMap;
  world.floor = 2;
  world.floorId = 'floor2';
  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }
  const maxHp = (world.stores.health.max[playerEid] ?? 100) + manifest.player.hpBonus;
  setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });

  const objectives = initializeFloor2Bosses(
    world,
    floorMap,
    world.floorExtendedState!.familyState!,
  );
  if (floor2Config?.governor?.autoUnlockDens === true) {
    for (const objective of objectives) {
      setGoalFlag(world, objective.unlockGoalId, true);
    }
    for (const doorEid of query(world.ecs, [DoorState])) {
      world.stores.doorState.isLocked[doorEid] = 0;
      world.stores.doorState.isOpen[doorEid] = 1;
    }
  }

  const settlementShopRange = floor2Config?.settlement?.shopCountRange;
  const shopCount =
    settlementShopRange !== undefined
      ? world.rng.nextInt(settlementShopRange[0], settlementShopRange[1])
      : undefined;

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

  initializeFloor2Settlement(world, {
    ...(shopCount === 1 || shopCount === 2 ? { shopCount } : {}),
    ...(settlementArchetypes ? { archetypes: settlementArchetypes } : {}),
  });

  const starterWeapon = manifest.starterWeapons[0];
  if (starterWeapon) {
    const weaponDef = getWeaponDef(starterWeapon);
    if (weaponDef) {
      setActiveWeapon(world, weaponDef);
    }
  }

  if (floor2Config?.governor?.autoVictoryOnStart === true) {
    setGoalFlag(world, FLOOR2_VICTORY_GOAL_ID, true);
  }
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

/**
 * Number of families defined in the Floor 2 enemy pack that have a boss
 * archetype registered. Used by the schema tests to catch drift between
 * families.json and enemies.floor2.json.
 */
export function countFloor2BossArchetypes(): number {
  return floor2EnemyPack.archetypes.filter((a) => a.isBoss === true).length;
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
