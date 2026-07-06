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
 *   5. Spawn The Broker quest-giver at the cavern centroid.
 *   6. Seeded-pick 1–2 shop archetypes and spawn their shopkeeper NPCs on
 *      opposite sides of the cavern, generating each shop's inventory via
 *      the pure `generateShopInventory` roller.
 *
 * Deterministic — every random draw uses `world.rng`. Idempotent-safe: an
 * already-initialised settlement is not re-spawned; the existing snapshot is
 * returned so tests can call the function twice without duplication.
 */
import { RoomRole, TerrainType, type RoomData } from '../shared/map-types.js';
import type { GameWorld } from '../core/world.js';
import { sealSpecialRooms } from '../core/map/special-rooms.js';
import { spawnNpc } from '../core/spawners/world-objects.js';
import { generateShopInventory } from '../core/generateShopInventory.js';
import { loadShopArchetypes, type ShopArchetypeDef } from '../shared/data/shop-archetypes.js';
import type {
  Floor2SettlementSnapshot,
  Floor2ShopInstance,
  Floor2ShopInventoryItem,
} from '../shared/floor-types.js';

/** Options for {@link initializeFloor2Settlement}. */
export interface InitializeFloor2SettlementOptions {
  /** Override the number of shops to spawn (defaults to a seeded roll of 1–2). */
  readonly shopCount?: 1 | 2;
  /** Override the pool of archetypes (defaults to the bundled pack). */
  readonly archetypes?: readonly ShopArchetypeDef[];
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
  const settlement = settlements[0];
  if (!settlement) {
    throw new Error('initializeFloor2Settlement: no SETTLEMENT room in floor map');
  }

  // 1. Retag as SAFE + repaint floor tiles.
  floorMap.roomGraph.setRole(settlement.id, RoomRole.SAFE);
  repaintSafeRoomFloor(world, settlement);

  // 2. Seal the perimeter — mirrors Floor 1's shop / welcome-office pass.
  sealSpecialRooms(floorMap, { extraRoomIds: [settlement.id] });

  // 3. Compute centroid + spawn positions (tile → world).
  const centreTile = roomCentroidTile(settlement);
  const centrePos = floorMap.tileToWorld(centreTile.x, centreTile.y);

  // 4. Spawn The Broker at the centroid.
  const brokerEid = spawnNpc(world, centrePos.x, centrePos.y, 'the-broker');

  // 5. Seeded shop roll.
  const archetypes = options.archetypes ?? loadShopArchetypes();
  const shopCount = options.shopCount ?? (world.rng.next() < 0.5 ? 1 : 2);
  const shuffled = [...archetypes];
  world.rng.shuffle(shuffled);
  const picked = shuffled.slice(0, Math.min(shopCount, shuffled.length));

  const shopOffsetTiles = 3;
  const shops: Floor2ShopInstance[] = [];
  picked.forEach((archetype, idx) => {
    // Fan shops out along the room's x axis relative to the centroid.
    const offsetSign = idx === 0 ? -1 : 1;
    const desiredTx = centreTile.x + offsetSign * shopOffsetTiles;
    const clampedTx = Math.min(
      settlement.bounds.x + settlement.bounds.width - 2,
      Math.max(settlement.bounds.x + 1, desiredTx),
    );
    const worldPos = floorMap.tileToWorld(clampedTx, centreTile.y);
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
    brokerEid,
    shops,
  };
  world.floorExtendedState = { ...(world.floorExtendedState ?? {}), settlement: snapshot };
  return snapshot;
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

/**
 * Room centroid — prefer the mean of interiorCells (irregular cavern shape)
 * when available, otherwise fall back to bounds centre.
 */
function roomCentroidTile(room: RoomData): { x: number; y: number } {
  if (room.interiorCells && room.interiorCells.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const cell of room.interiorCells) {
      sx += cell.x;
      sy += cell.y;
    }
    return {
      x: Math.round(sx / room.interiorCells.length),
      y: Math.round(sy / room.interiorCells.length),
    };
  }
  return {
    x: room.bounds.x + Math.floor(room.bounds.width / 2),
    y: room.bounds.y + Math.floor(room.bounds.height / 2),
  };
}
