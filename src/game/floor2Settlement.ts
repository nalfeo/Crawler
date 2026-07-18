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
 *   5. Spawn The Broker, a defected family member, one guaranteed Quartermaster,
 *      and 1–2 seeded non-Quartermaster shops onto settlement-room interior
 *      tiles with door buffers + spacing.
 *   6. Generate each shop's inventory via the pure `generateShopInventory`
 *      roller.
 *
 * Deterministic — shop selection/inventory use `world.rng`, while the new
 * placement/defector picks use a derived seeded RNG so the existing shop-roll
 * stream stays stable. Idempotent-safe: an already-initialised settlement is
 * not re-spawned; the existing snapshot is returned so tests can call the
 * function twice without duplication.
 */
import { RoomRole, TerrainType, type RoomData } from '../shared/map-types.js';
import { addComponent, set } from 'bitecs';
import { DoorState } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { sealSpecialRooms } from '../core/map/special-rooms.js';
import { spawnNpc } from '../core/spawners/world-objects.js';
import { createEntity } from '../core/spawners/entity-core.js';
import { generateShopInventory } from '../core/generateShopInventory.js';
import { loadShopArchetypes, type ShopArchetypeDef } from '../shared/data/shop-archetypes.js';
import { buildFloor2DefectorDialogue, FLOOR2_DEFECTOR_NPC_ID } from '../shared/npc-types.js';
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
}

/** Archetype id of the guaranteed Quartermaster shop. */
export const QUARTERMASTER_ARCHETYPE_ID = 'the-quartermaster';

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
  const settlementRng = new SeededRandom(hashStringToSeed(`floor2-settlement:${world.seed}`));

  // 1. Retag all settlement-cluster rooms as SAFE + repaint floor tiles.
  for (const room of settlements) {
    floorMap.roomGraph.setRole(room.id, RoomRole.SAFE);
    repaintSafeRoomFloor(world, room);
  }

  // 2. Seal perimeters — mirrors Floor 1's shop / welcome-office pass.
  sealSpecialRooms(floorMap, { extraRoomIds: settlements.map((room) => room.id) });
  for (const room of settlements) {
    installSettlementDoorEntities(world, room);
  }

  // 3. Seeded shop roll — preserve the existing world.rng flow for shop selection
  // and inventories; all new placement/defector randomness uses a derived RNG.
  // Quartermaster is excluded from the random pool and always placed separately.
  const allArchetypes = options.archetypes ?? loadShopArchetypes();
  const quartermasterArchetype = loadShopArchetypes().find(
    (a) => a.id === QUARTERMASTER_ARCHETYPE_ID,
  );
  if (!quartermasterArchetype) {
    throw new Error(
      `initializeFloor2Settlement: Quartermaster archetype "${QUARTERMASTER_ARCHETYPE_ID}" not found`,
    );
  }
  const randomPool = allArchetypes.filter((a) => a.id !== QUARTERMASTER_ARCHETYPE_ID);
  const shopCount = options.shopCount ?? (world.rng.next() < 0.5 ? 1 : 2);
  const shuffled = [...randomPool];
  world.rng.shuffle(shuffled);
  const picked = shuffled.slice(0, Math.min(shopCount, shuffled.length));

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
  const reservedTiles: Array<{ x: number; y: number }> = [];
  const placementPlan = buildSettlementPlacementPlan(
    settlement,
    settlements,
    assignedRooms,
    true /* includeQuartermaster */,
  );
  const spawnTiles = placeSettlementNpcs(settlementRng, placementPlan, settlements, reservedTiles);
  const brokerTile = spawnTiles.get('broker');
  const defectorTile = spawnTiles.get('defector');
  const quartermasterTile = spawnTiles.get('quartermaster');
  if (!brokerTile || !defectorTile || !quartermasterTile) {
    throw new Error(
      'initializeFloor2Settlement: failed to place broker, defector, or quartermaster',
    );
  }
  const brokerPos = floorMap.tileToWorld(brokerTile.x, brokerTile.y);
  const brokerEid = spawnNpc(world, brokerPos.x, brokerPos.y, 'the-broker');
  const defectorPos = floorMap.tileToWorld(defectorTile.x, defectorTile.y);
  const defectorEid = spawnNpc(world, defectorPos.x, defectorPos.y, FLOOR2_DEFECTOR_NPC_ID, {
    dialogueOverride: buildFloor2DefectorDialogue(defectorFamilyId),
    appearanceKey: defectorAppearanceKey,
    appearanceFallbackKey: defectorFallbackAppearanceKey,
  });

  // Spawn guaranteed Quartermaster.
  const qmWorldPos = floorMap.tileToWorld(quartermasterTile.x, quartermasterTile.y);
  const qmNpcEid = spawnNpc(world, qmWorldPos.x, qmWorldPos.y, quartermasterArchetype.npcId);
  const qmRolled = generateShopInventory(world.rng, quartermasterArchetype);
  const qmInventory: Floor2ShopInventoryItem[] = qmRolled.items.map((item) => ({
    itemId: item.itemId,
    unitPrice: item.unitPrice,
    stock: item.stock,
  }));
  const quartermasterShop: Floor2ShopInstance = {
    archetypeId: quartermasterArchetype.id,
    npcId: quartermasterArchetype.npcId,
    npcEid: qmNpcEid,
    inventory: qmInventory,
  };

  const shops: Floor2ShopInstance[] = [];
  picked.forEach((archetype, idx) => {
    const spawnTile = spawnTiles.get(`shop:${idx}`);
    if (!spawnTile) {
      throw new Error(`initializeFloor2Settlement: failed to place shop ${archetype.id}`);
    }
    const worldPos = floorMap.tileToWorld(spawnTile.x, spawnTile.y);
    const npcEid = spawnNpc(world, worldPos.x, worldPos.y, archetype.npcId);
    const rolled = generateShopInventory(world.rng, archetype);
    const inventory: Floor2ShopInventoryItem[] = rolled.items.map((item) => ({
      itemId: item.itemId,
      unitPrice: item.unitPrice,
      stock: item.stock,
    }));
    shops.push({
      archetypeId: archetype.id,
      npcId: archetype.npcId,
      npcEid,
      inventory,
    });
  });

  const snapshot: Floor2SettlementSnapshot = {
    settlementRoomId: settlement.id,
    settlementRoomIds: settlements.map((room) => room.id),
    brokerEid,
    defectorEid,
    defectorFamilyId,
    defectorAppearanceKey,
    defectorFallbackAppearanceKey,
    quartermasterShop,
    shops,
  };
  world.floorExtendedState = { ...(world.floorExtendedState ?? {}), settlement: snapshot };
  return snapshot;
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
  rng: SeededRandom,
  entries: readonly SettlementPlacementEntry[],
  settlements: readonly RoomData[],
  reservedTiles: Array<{ x: number; y: number }>,
): ReadonlyMap<string, { x: number; y: number }> {
  const byRoom = new Map(settlements.map((room) => [room.id, room]));
  const placements = new Map<string, { x: number; y: number }>();
  for (const entry of entries) {
    const preferredRooms = uniqueRoomOrder(
      entry.roomIds,
      settlements.map((room) => room.id),
    );
    const tile = pickSettlementPlacementTile(rng, preferredRooms, byRoom, reservedTiles);
    if (!tile) {
      throw new Error(
        `initializeFloor2Settlement: could not place settlement NPC "${entry.key}" with spacing constraints`,
      );
    }
    placements.set(entry.key, tile);
    reservedTiles.push(tile);
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

function pickSettlementPlacementTile(
  rng: SeededRandom,
  roomIds: readonly number[],
  byRoom: ReadonlyMap<number, RoomData>,
  reservedTiles: readonly { x: number; y: number }[],
): { x: number; y: number } | null {
  for (const roomId of roomIds) {
    const room = byRoom.get(roomId);
    if (!room) continue;
    const candidates = settlementPlacementCandidates(room).filter((tile) =>
      reservedTiles.every((reserved) => tileDistanceSq(tile, reserved) >= 9),
    );
    if (candidates.length === 0) continue;
    return candidates[rng.nextInt(0, candidates.length - 1)]!;
  }
  return null;
}

function settlementPlacementCandidates(room: RoomData): Array<{ x: number; y: number }> {
  const base =
    room.interiorCells && room.interiorCells.length > 0
      ? room.interiorCells.map((cell) => ({ x: cell.x, y: cell.y }))
      : boundedInteriorCells(room);
  const filtered = base.filter((tile) =>
    room.doors.every((door) => Math.max(Math.abs(tile.x - door.x), Math.abs(tile.y - door.y)) > 1),
  );
  return filtered.length > 0 ? filtered : base;
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
