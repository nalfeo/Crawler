/**
 * Floor 2 · Slice 6 — settlement initialiser.
 *
 * Called once at Floor 2 boot to:
 *   1. Locate the SETTLEMENT cavern (guaranteed to exist per Slice 2 —
 *      `CaveSystemGenerator` seeds exactly one).
 *   2. Retag it as SAFE so the safe-space plumbing treats it as a refuge.
 *   3. Seal its perimeter via `sealSpecialRooms` (same guarantee Floor 1's
 *      welcome office / shop room enjoy).
 *   4. Repaint its floor tiles to `SAFE_ROOM_FLOOR` for the calm-blue tint.
 *   5. Spawn The Broker, a defected family member, one guaranteed
 *      Quartermaster, and 1–2 seeded non-Quartermaster shops onto reachable
 *      settlement-room interior tiles with door buffers + spacing.
 *   6. Generate each shop's inventory via the pure `generateShopInventory`
 *      roller.
 *
 * Deterministic — legacy shop selection/inventory draws use `world.rng`, while
 * supplemental inventory, placement, and defector picks use derived seeded RNGs
 * so the existing shop-roll stream stays stable. Idempotent-safe: an
 * already-initialised settlement is
 * not re-spawned; the existing snapshot is returned so tests can call the
 * function twice without duplication.
 */
import { RoomRole, TerrainType, TileFlags, type RoomData } from '../shared/map-types.js';
import { addComponent, set } from 'bitecs';
import { DoorState } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { sealSpecialRooms } from '../core/map/special-rooms.js';
import { spawnNpc } from '../core/spawners/world-objects.js';
import { createEntity } from '../core/spawners/entity-core.js';
import { generateShopInventory } from '../core/generateShopInventory.js';
import { floodFill } from '../core/map/grid-utils.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import {
  FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  loadShopArchetypes,
  type ShopArchetypeDef,
} from '../shared/data/shop-archetypes.js';
import {
  buildFloor2DefectorDialogue,
  FLOOR2_DEFECTOR_NPC_ID,
  getNpcDef,
} from '../shared/npc-types.js';
import {
  getFloor2FamilyEliteArchetype,
  getFloor2FamilyFallbackArchetype,
} from '../shared/enemy-packs.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import type {
  Floor2SettlementSnapshot,
  Floor2ShopInstance,
  Floor2ShopInventoryItem,
} from '../shared/floor-types.js';
import { createInitialFloor2QuartermasterStock } from './quartermaster-stock.js';
import { getFloor2EquipmentEconomyAccess } from '../core/floor2-equipment-flags.js';

/** Options for {@link initializeFloor2Settlement}. */
export interface InitializeFloor2SettlementOptions {
  /** Override the number of non-Quartermaster shops to spawn (defaults to a seeded roll of 1–2). */
  readonly shopCount?: 1 | 2;
  /**
   * Override the non-Quartermaster archetype pool (defaults to the bundled pack
   * minus the Quartermaster). The Quartermaster is always placed separately and
   * is excluded from this pool regardless.
   */
  readonly archetypes?: readonly ShopArchetypeDef[];
  /**
   * The player level to use for Quartermaster stock item-level rolling.  Pass
   * the carried-over or intended level explicitly when `world.playerLevel` has
   * not yet been updated to the effective play level (e.g. Floor 1→2 carryover
   * or a headless run with a custom `startPlayerLevel` set after scenario
   * configuration).  Defaults to `world.playerLevel.level` when omitted.
   */
  readonly effectivePlayerLevel?: number;
  /**
   * Skip generating initial Quartermaster equipment stock during settlement
   * setup. Set this when the caller is about to restore a player-carryover
   * snapshot: carryover restore requires `world.generatedEquipmentRegistry`
   * to be empty (`restoreGeneratedEquipmentRegistry` hard-fails otherwise),
   * so stock generation — which writes instances into that registry — must
   * happen *after* restore completes, not during settlement init. Callers
   * that set this to `true` are responsible for generating Quartermaster
   * stock themselves once carryover restore has finished (see
   * `floor2Scenario.ts`'s post-restore stock bootstrap).
   */
  readonly skipQuartermasterStock?: boolean;
}

const FLOOR2_SETTLEMENT_NPC_SPACING_TILES = 3;
export const FLOOR2_SETTLEMENT_DOOR_BUFFER_TILES = 1;

/** @deprecated Use {@link FLOOR2_QUARTERMASTER_ARCHETYPE_ID} from shop-archetypes instead. */
export const QUARTERMASTER_ARCHETYPE_ID = FLOOR2_QUARTERMASTER_ARCHETYPE_ID;

export interface PlannedFloor2SettlementShop {
  readonly archetype: ShopArchetypeDef;
  readonly inventory: readonly Floor2ShopInventoryItem[];
}

/**
 * Initialise the Floor 2 settlement. Returns the snapshot written to
 * `world.floorExtendedState.settlement`. Throws when there is no floor map or no
 * SETTLEMENT room (both are Slice-2 invariants).
 */
export function initializeFloor2Settlement(
  world: GameWorld,
  options: InitializeFloor2SettlementOptions = {},
): Floor2SettlementSnapshot {
  if (world.floorExtendedState?.settlement != null) {
    return world.floorExtendedState!.settlement!;
  }
  const floorMap = world.floorMap;
  if (!floorMap) {
    throw new Error('initializeFloor2Settlement: world.floorMap is null');
  }
  const settlements = floorMap.roomGraph.getRoomsByRole(RoomRole.SETTLEMENT);
  const settlement = settlements.find((room) => room.label === 'settlement_bar') ?? settlements[0];
  if (!settlement || settlements.length < 2 || settlements.length > 3) {
    throw new Error(
      `initializeFloor2Settlement: expected 2-3 settlement rooms, found ${settlements.length}`,
    );
  }
  const presentFamilies = world.floorExtendedState?.familyState?.presentFamilies;
  if (!presentFamilies || presentFamilies.length === 0) {
    throw new Error('initializeFloor2Settlement: world.floorExtendedState.familyState is missing');
  }

  // Preflight: reject an invalid economy dependency closure before any RNG
  // consumption or world mutation so a caller that corrects the config and
  // retries does not duplicate side effects.
  const economyAccess = getFloor2EquipmentEconomyAccess(world);
  if (economyAccess.kind === 'invalid') {
    throw new Error(economyAccess.message);
  }

  const settlementRng = new SeededRandom(hashStringToSeed(`floor2-settlement:${world.seed}`));

  // Route all shop planning through planFloor2SettlementShops: preserves the
  // legacy full-pack shuffle/inventory-draw stream, enforces archetype validation,
  // and supplies pre-rolled inventories for both the Quartermaster and non-QM shops.
  //
  // options.archetypes is documented as a *non-Quartermaster* override pool (e.g.
  // floor2Scenario forwards manifest shopArchetypes which may omit the QM).
  // The Quartermaster is always sourced from the canonical pack and prepended so
  // planFloor2SettlementShops always receives exactly one QM entry regardless of
  // what the override pool contains.
  const baseArchetypes = options.archetypes ?? loadShopArchetypes();
  const hasQm = baseArchetypes.some((a) => a.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID);
  const allArchetypes: readonly ShopArchetypeDef[] = hasQm
    ? baseArchetypes
    : (() => {
        const canonicalQm = loadShopArchetypes().find(
          (a) => a.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
        );
        if (!canonicalQm) {
          throw new Error(
            `initializeFloor2Settlement: canonical "${FLOOR2_QUARTERMASTER_ARCHETYPE_ID}" archetype not found`,
          );
        }
        return [canonicalQm, ...baseArchetypes];
      })();
  validateSettlementNpcDefs(allArchetypes);
  const shopCount = options.shopCount ?? (world.rng.next() < 0.5 ? 1 : 2);
  const plannedShops = planFloor2SettlementShops(world.rng, world.seed, shopCount, allArchetypes);
  const qmPlan = plannedShops.find((p) => p.archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID)!;
  const nonQmPlans = plannedShops.filter(
    (p) => p.archetype.id !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  );
  const picked = nonQmPlans.map((p) => p.archetype);
  const shopRooms = settlements.filter((room) => room.id !== settlement.id);
  const fallbackShopRoom = shopRooms[0] ?? settlement;
  const assignedRooms = picked.map(
    (_archetype, idx) => shopRooms[idx % Math.max(1, shopRooms.length)] ?? fallbackShopRoom,
  );
  const defectorFamilyId = settlementRng.pick(presentFamilies);
  const fallbackArchetype = getFloor2FamilyFallbackArchetype(defectorFamilyId);
  if (!fallbackArchetype) {
    throw new Error(
      `initializeFloor2Settlement: missing fallback archetype for "${defectorFamilyId}"`,
    );
  }
  const eliteArchetype = getFloor2FamilyEliteArchetype(defectorFamilyId);
  const defectorAppearanceKey = eliteArchetype?.id ?? fallbackArchetype.id;
  const defectorFallbackAppearanceKey = fallbackArchetype.id;
  const placementPlan = buildSettlementPlacementPlan(
    settlement,
    settlements,
    assignedRooms,
    true /* includeQuartermaster */,
  );
  const spawnTiles = prepareSettlementMapAndPlacement(world, placementPlan, settlements, floorMap);
  const brokerTile = spawnTiles.get('broker');
  const defectorTile = spawnTiles.get('defector');
  const quartermasterTile = spawnTiles.get('quartermaster');
  if (!brokerTile || !defectorTile || !quartermasterTile) {
    throw new Error(
      'initializeFloor2Settlement: failed to place broker, defector, or quartermaster',
    );
  }
  for (const room of settlements) {
    installSettlementDoorEntities(world, room);
  }

  const brokerPos = floorMap.tileToWorld(brokerTile.x, brokerTile.y);
  const brokerEid = spawnNpc(world, brokerPos.x, brokerPos.y, 'the-broker');
  const defectorPos = floorMap.tileToWorld(defectorTile.x, defectorTile.y);
  const defectorEid = spawnNpc(world, defectorPos.x, defectorPos.y, FLOOR2_DEFECTOR_NPC_ID, {
    dialogueOverride: buildFloor2DefectorDialogue(defectorFamilyId),
    appearanceKey: defectorAppearanceKey,
    appearanceFallbackKey: defectorFallbackAppearanceKey,
  });

  // Spawn guaranteed Quartermaster — archetype and pre-rolled inventory come
  // from planFloor2SettlementShops so the RNG state is consistent with the plan.
  const qmWorldPos = floorMap.tileToWorld(quartermasterTile.x, quartermasterTile.y);
  const qmNpcEid = spawnNpc(world, qmWorldPos.x, qmWorldPos.y, qmPlan.archetype.npcId);
  const quartermasterShop: Floor2ShopInstance = {
    archetypeId: qmPlan.archetype.id,
    npcId: qmPlan.archetype.npcId,
    npcEid: qmNpcEid,
    inventory: [...qmPlan.inventory],
  };

  const shops: Floor2ShopInstance[] = [];
  picked.forEach((archetype, idx) => {
    const spawnTile = spawnTiles.get(`shop:${idx}`);
    if (!spawnTile) {
      throw new Error(`initializeFloor2Settlement: failed to place shop ${archetype.id}`);
    }
    const worldPos = floorMap.tileToWorld(spawnTile.x, spawnTile.y);
    const npcEid = spawnNpc(world, worldPos.x, worldPos.y, archetype.npcId);
    shops.push({
      archetypeId: archetype.id,
      npcId: archetype.npcId,
      npcEid,
      inventory: [...nonQmPlans[idx]!.inventory],
    });
  });

  const quartermasterStock = options.skipQuartermasterStock
    ? undefined
    : createInitialFloor2QuartermasterStock(world, options.effectivePlayerLevel);
  const snapshot: Floor2SettlementSnapshot = {
    settlementRoomId: settlement.id,
    settlementRoomIds: settlements.map((room) => room.id),
    brokerEid,
    defectorEid,
    defectorFamilyId,
    defectorAppearanceKey,
    defectorFallbackAppearanceKey,
    quartermasterShop,
    ...(quartermasterStock ? { quartermasterStock } : {}),
    shops,
  };
  world.floorExtendedState = { ...(world.floorExtendedState ?? {}), settlement: snapshot };
  return snapshot;
}

/**
 * Compose one guaranteed Quartermaster with the legacy seeded count of random
 * non-Quartermaster shops while preserving the old world-RNG draw stream.
 */
export function planFloor2SettlementShops(
  rng: SeededRandom,
  worldSeed: number,
  shopCount: 1 | 2,
  archetypes: readonly ShopArchetypeDef[],
): readonly PlannedFloor2SettlementShop[] {
  validateSettlementShopArchetypes(archetypes, shopCount);
  const shuffled = [...archetypes];
  rng.shuffle(shuffled);
  const quartermaster = shuffled.find(
    (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  )!;
  const randomShops = shuffled
    .filter((archetype) => archetype.id !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID)
    .slice(0, shopCount);
  const selected = [quartermaster, ...randomShops];
  const selectedIds = new Set(selected.map((archetype) => archetype.id));
  const inventoryByArchetype = new Map<string, readonly Floor2ShopInventoryItem[]>();

  // Consume exactly the inventory draws the legacy 1–2 picked-prefix consumed.
  // Every selected prefix shop therefore retains its prior seeded inventory and
  // the world RNG exits in the same state as before the guaranteed addition.
  for (const archetype of shuffled.slice(0, shopCount)) {
    const inventory = rollFloor2ShopInventory(rng, archetype);
    if (selectedIds.has(archetype.id)) {
      inventoryByArchetype.set(archetype.id, inventory);
    }
  }

  // Shops pulled in beyond the legacy prefix use a stable derived stream. This
  // adds their inventory without perturbing any downstream gameplay RNG draws.
  for (const archetype of selected) {
    if (inventoryByArchetype.has(archetype.id)) continue;
    const supplementalRng = new SeededRandom(
      hashStringToSeed(`floor2-settlement-supplemental-shop:${worldSeed}:${archetype.id}`),
    );
    inventoryByArchetype.set(archetype.id, rollFloor2ShopInventory(supplementalRng, archetype));
  }

  return selected.map((archetype) => ({
    archetype,
    inventory: inventoryByArchetype.get(archetype.id)!,
  }));
}

function rollFloor2ShopInventory(
  rng: SeededRandom,
  archetype: ShopArchetypeDef,
): readonly Floor2ShopInventoryItem[] {
  return generateShopInventory(rng, archetype).items.map((item) => ({
    itemId: item.itemId,
    unitPrice: item.unitPrice,
    stock: item.stock,
  }));
}

function validateSettlementShopArchetypes(
  archetypes: readonly ShopArchetypeDef[],
  shopCount: 1 | 2,
): void {
  const seen = new Set<string>();
  for (const archetype of archetypes) {
    if (seen.has(archetype.id)) {
      throw new Error(`initializeFloor2Settlement: duplicate shop archetype id "${archetype.id}"`);
    }
    seen.add(archetype.id);
  }
  const quartermasterCount = archetypes.filter(
    (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  ).length;
  if (quartermasterCount !== 1) {
    throw new Error(
      `initializeFloor2Settlement: expected exactly one "${FLOOR2_QUARTERMASTER_ARCHETYPE_ID}" archetype, found ${quartermasterCount}`,
    );
  }
  const nonQuartermasterCount = archetypes.length - quartermasterCount;
  if (nonQuartermasterCount < shopCount) {
    throw new Error(
      `initializeFloor2Settlement: requires ${shopCount} non-Quartermaster shop archetypes, found ${nonQuartermasterCount}`,
    );
  }
}

function validateSettlementNpcDefs(archetypes: readonly ShopArchetypeDef[]): void {
  const requiredNpcIds = ['the-broker', FLOOR2_DEFECTOR_NPC_ID, ...archetypes.map((a) => a.npcId)];
  for (const npcId of requiredNpcIds) {
    if (!getNpcDef(npcId)) {
      throw new Error(`initializeFloor2Settlement: missing NPC definition "${npcId}"`);
    }
  }
}

/**
 * Mirror Floor 1's special-room door plumbing so sealed settlement doors are
 * represented in ECS and actively synced by doorSystem.
 */
function installSettlementDoorEntities(world: GameWorld, settlement: RoomData): void {
  for (const door of settlement.doors) {
    const doorEid = createEntity(world);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, {
        tileX: door.x,
        tileY: door.y,
        logicalOpen: 1,
        isLocked: 0,
        wasUnlocked: 1,
      }),
    );
  }
}

/** Repaint any CAVE_FLOOR / STONE_FLOOR inside the room to SAFE_ROOM_FLOOR. */
function repaintSafeRoomFloor(world: GameWorld, room: RoomData): void {
  const floorMap = world.floorMap;
  if (!floorMap) return;
  const w = floorMap.config.widthTiles;
  const { x: rx, y: ry, width, height } = room.bounds;
  for (let ty = ry; ty < ry + height; ty += 1) {
    for (let tx = rx; tx < rx + width; tx += 1) {
      const idx = ty * w + tx;
      const t = floorMap.terrain[idx];
      if (t === TerrainType.STONE_FLOOR || t === TerrainType.CAVE_FLOOR) {
        floorMap.terrain[idx] = TerrainType.SAFE_ROOM_FLOOR;
      }
    }
  }
}

interface SettlementPlacementEntry {
  readonly key: string;
  readonly roomIds: readonly number[];
}

function prepareSettlementMapAndPlacement(
  world: GameWorld,
  placementPlan: readonly SettlementPlacementEntry[],
  settlements: readonly RoomData[],
  floorMap: FloorMap,
): ReadonlyMap<string, { x: number; y: number }> {
  const rooms = floorMap.roomGraph.getAll();
  const rolesBefore = rooms.map((room) => room.role);
  const doorsBefore = rooms.map((room) => room.doors);
  const terrainBefore = floorMap.terrain.slice();
  const flagsBefore = floorMap.tileMap.flags.slice();

  try {
    for (const room of settlements) {
      floorMap.roomGraph.setRole(room.id, RoomRole.SAFE);
      repaintSafeRoomFloor(world, room);
    }
    sealSpecialRooms(floorMap, { extraRoomIds: settlements.map((room) => room.id) });
    return placeSettlementNpcs(world.seed, placementPlan, settlements, floorMap);
  } catch (error) {
    floorMap.terrain.set(terrainBefore);
    floorMap.tileMap.flags.set(flagsBefore);
    rooms.forEach((room, index) => {
      room.role = rolesBefore[index]!;
      Object.assign(room, { doors: doorsBefore[index]! });
    });
    throw error;
  }
}

function buildSettlementPlacementPlan(
  settlement: RoomData,
  settlements: readonly RoomData[],
  assignedRooms: readonly RoomData[],
  includeQuartermaster: boolean,
): readonly SettlementPlacementEntry[] {
  const entries: SettlementPlacementEntry[] = [
    { key: 'broker', roomIds: [settlement.id] },
    { key: 'defector', roomIds: settlements.map((room) => room.id) },
  ];
  if (includeQuartermaster) {
    // Guaranteed Quartermaster: prefer non-bar settlement rooms, fall back to any.
    const shopRoomIds = settlements
      .filter((room) => room.id !== settlement.id)
      .map((room) => room.id);
    entries.push({
      key: 'quartermaster',
      roomIds: [...shopRoomIds, ...settlements.map((room) => room.id)],
    });
  }
  assignedRooms.forEach((room, idx) => {
    entries.push({
      key: `shop:${idx}`,
      roomIds: [room.id, ...settlements.map((candidate) => candidate.id)],
    });
  });
  return entries;
}

function placeSettlementNpcs(
  worldSeed: number,
  entries: readonly SettlementPlacementEntry[],
  settlements: readonly RoomData[],
  floorMap: FloorMap,
): ReadonlyMap<string, { x: number; y: number }> {
  const byRoom = new Map(settlements.map((room) => [room.id, room]));
  const reachable = reachableFloorTiles(floorMap);
  const candidateSets = entries
    .map((entry, index) => ({
      entry,
      index,
      candidates: settlementPlacementCandidatesForEntry(
        worldSeed,
        entry,
        settlements,
        byRoom,
        floorMap,
        reachable,
      ),
    }))
    .sort((a, b) => a.candidates.length - b.candidates.length || a.index - b.index);
  const placements = new Map<string, { x: number; y: number }>();
  const reservedTiles: Array<{ x: number; y: number }> = [];
  const placeNext = (index: number): boolean => {
    if (index >= candidateSets.length) return true;
    const current = candidateSets[index]!;
    for (const tile of current.candidates) {
      if (
        !reservedTiles.every(
          (reserved) => tileDistanceSq(tile, reserved) >= FLOOR2_SETTLEMENT_NPC_SPACING_TILES ** 2,
        )
      ) {
        continue;
      }
      placements.set(current.entry.key, tile);
      reservedTiles.push(tile);
      if (placeNext(index + 1)) return true;
      reservedTiles.pop();
      placements.delete(current.entry.key);
    }
    return false;
  };
  if (!placeNext(0)) {
    const uniqueCandidates = new Set(
      candidateSets.flatMap(({ candidates }) => candidates.map((tile) => `${tile.x},${tile.y}`)),
    );
    throw new Error(
      `initializeFloor2Settlement: settlement capacity insufficient; required=${entries.length}, reachableCandidates=${uniqueCandidates.size}, rooms=${settlements.length}, spacingTiles=${FLOOR2_SETTLEMENT_NPC_SPACING_TILES}, doorBufferTiles=${FLOOR2_SETTLEMENT_DOOR_BUFFER_TILES}`,
    );
  }
  return placements;
}

function uniqueRoomOrder(
  preferred: readonly number[],
  fallback: readonly number[],
): readonly number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const id of [...preferred, ...fallback]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function settlementPlacementCandidatesForEntry(
  worldSeed: number,
  entry: SettlementPlacementEntry,
  settlements: readonly RoomData[],
  byRoom: ReadonlyMap<number, RoomData>,
  floorMap: FloorMap,
  reachable: Uint8Array,
): Array<{ x: number; y: number }> {
  const roomIds = uniqueRoomOrder(
    entry.roomIds,
    settlements.map((room) => room.id),
  );
  const ordered: Array<{ x: number; y: number }> = [];
  for (const roomId of roomIds) {
    const room = byRoom.get(roomId);
    if (!room) continue;
    const candidates = settlementPlacementCandidates(room, floorMap, reachable);
    const candidateRng = new SeededRandom(
      hashStringToSeed(`floor2-settlement-placement:${worldSeed}:${entry.key}:${roomId}`),
    );
    candidateRng.shuffle(candidates);
    ordered.push(...candidates);
  }
  return ordered;
}

function settlementPlacementCandidates(
  room: RoomData,
  floorMap: FloorMap,
  reachable: Uint8Array,
): Array<{ x: number; y: number }> {
  const base =
    room.interiorCells && room.interiorCells.length > 0
      ? room.interiorCells.map((cell) => ({ x: cell.x, y: cell.y }))
      : boundedInteriorCells(room);
  const width = floorMap.config.widthTiles;
  return base.filter(
    (tile) =>
      floorMap.tileMap.isPassable(tile.x, tile.y) &&
      reachable[tile.y * width + tile.x] === 1 &&
      room.doors.every(
        (door) =>
          Math.max(Math.abs(tile.x - door.x), Math.abs(tile.y - door.y)) >
          FLOOR2_SETTLEMENT_DOOR_BUFFER_TILES,
      ),
  );
}

function reachableFloorTiles(floorMap: FloorMap): Uint8Array {
  const width = floorMap.config.widthTiles;
  const height = floorMap.config.heightTiles;
  return floodFill(
    floorMap.playerSpawn.y * width + floorMap.playerSpawn.x,
    width,
    height,
    (index) => (floorMap.tileMap.flags[index]! & (TileFlags.PASSABLE | TileFlags.DOOR)) !== 0,
  );
}

function boundedInteriorCells(room: RoomData): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  const minX = room.bounds.x + 1;
  const maxXExclusive = room.bounds.x + room.bounds.width - 1;
  const minY = room.bounds.y + 1;
  const maxYExclusive = room.bounds.y + room.bounds.height - 1;
  for (let y = minY; y < maxYExclusive; y += 1) {
    for (let x = minX; x < maxXExclusive; x += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function tileDistanceSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
