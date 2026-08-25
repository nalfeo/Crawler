/**
 * Floor 3 Companion League — persistent player reward track (spec
 * `.specify/specs/floor3-companion-league.md` R7, slice 10).
 *
 * Wild Floor 3 pets are plain `Enemy` entities, so `dropSystem` already pays
 * the player for killing them. Rival Companions also carry `Enemy` (they are
 * spawned through `spawnBehaviorEnemy`), but they never die:
 * `companionKOSystem` clamps their `Health.current` back to 1 and raises
 * `Companion.knockedOut` specifically so `dropSystem`'s `[Enemy, Health]` kill
 * query never observes them at 0. This module closes that gap by paying the
 * same persistent reward track when a **rival** Companion is defeated (KO'd),
 * reusing the existing loot tables and pickup spawners so the player collects
 * gems/gold/items through the untouched `itemPickupSystem`
 * (→ `world.playerLevel.xp` / `world.playerGold` / `Inventory`).
 *
 * Two invariants keep this honest:
 * 1. **Once per Companion.** `companion.defeatRewarded` latches on payout, so
 *    the generic engagement-end revival (spec R11) cannot be farmed by
 *    re-KO'ing the same rival. The latch lives in the component store rather
 *    than a world-level set because `createEntity` clears recycled EID store
 *    slots through `clearEntityStores`, making it EID-recycling-safe.
 * 2. **Rivals only.** A Companion on `TeamId.PLAYER` is the player's own party;
 *    its members going down must never pay the player.
 *
 * Called from the head of `floor3ObjectiveTick`, which runs after
 * `companionKOSystem` in the same frame and immediately before that same tick
 * despawns a wiped roster — so the KOs that complete an encounter still pay out.
 */
import { query } from 'bitecs';
import { Companion, Enemy, Position, Team, type GameWorld } from '../core/index.js';
import { spawnDroppedItem, spawnGold, spawnXpGem } from '../core/helpers.js';
import { TeamId } from '../shared/constants.js';
import { getItemIndex } from '../shared/items.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import {
  LOOT_TABLES,
  getLootTable,
  resolveLootTables,
  rollLootTable,
  type LootDrop,
  type LootEntry,
} from '../shared/loot-tables.js';

/**
 * Scatter radius (feet) applied per drop, then again per spawned unit —
 * matches `dropSystem`'s death-drop scatter so a defeated rival's loot reads
 * the same as any other kill's.
 */
const DEFEAT_SCATTER_FT = 2.5;
const DEFEAT_UNIT_SCATTER_FT = 1;

/**
 * Loot layers a defeated rival Companion rolls: the elite type table (these
 * are trained League combatants, not ambient wildlife) unioned with the
 * floor's own manifest-declared table. Balance numbers stay authored in
 * `loot-tables.ts`; slice 16 tunes them against the win-rate sweep.
 */
function resolveRivalDefeatEntries(world: GameWorld): LootEntry[] {
  const floorLootTableId = world.floorId
    ? getFloorManifest(world.floorId)?.floorLootTableId
    : undefined;
  return resolveLootTables(
    LOOT_TABLES.ELITE,
    floorLootTableId ? getLootTable(floorLootTableId) : undefined,
  );
}

function spawnDefeatDrops(
  world: GameWorld,
  x: number,
  y: number,
  drops: readonly LootDrop[],
): void {
  for (const drop of drops) {
    const dx = x + (world.rng.next() - 0.5) * DEFEAT_SCATTER_FT;
    const dy = y + (world.rng.next() - 0.5) * DEFEAT_SCATTER_FT;

    switch (drop.type) {
      case 'gold':
        for (let i = 0; i < drop.quantity; i += 1) {
          spawnGold(
            world,
            dx + (world.rng.next() - 0.5) * DEFEAT_UNIT_SCATTER_FT,
            dy + (world.rng.next() - 0.5) * DEFEAT_UNIT_SCATTER_FT,
            drop.value,
          );
        }
        break;
      case 'xp':
        for (let i = 0; i < drop.quantity; i += 1) {
          spawnXpGem(
            world,
            dx + (world.rng.next() - 0.5) * DEFEAT_UNIT_SCATTER_FT,
            dy + (world.rng.next() - 0.5) * DEFEAT_UNIT_SCATTER_FT,
            drop.value,
          );
        }
        break;
      case 'item': {
        if (drop.itemId === undefined) break;
        const itemIndex = getItemIndex(drop.itemId);
        if (itemIndex < 0) break;
        for (let i = 0; i < drop.quantity; i += 1) {
          spawnDroppedItem(world, dx, dy, itemIndex);
        }
        break;
      }
    }
  }
}

/**
 * Pays the persistent player reward track for every rival Companion that is
 * knocked out and has not been rewarded yet. Idempotent per frame and across
 * frames — a rival only ever pays out once, no matter how often it is revived
 * and knocked out again.
 */
export function awardFloor3CompanionDefeatRewards(world: GameWorld): void {
  const companions = query(world.ecs, [Enemy, Companion, Team, Position]);
  if (companions.length === 0) return;

  const { companion, position, team } = world.stores;
  let entries: LootEntry[] | undefined;

  for (const eid of companions) {
    if ((companion.knockedOut[eid] ?? 0) !== 1) continue;
    if ((companion.defeatRewarded[eid] ?? 0) === 1) continue;
    if ((team.id[eid] ?? TeamId.PLAYER) === TeamId.PLAYER) continue;

    companion.defeatRewarded[eid] = 1;
    entries ??= resolveRivalDefeatEntries(world);
    spawnDefeatDrops(
      world,
      position.x[eid] ?? 0,
      position.y[eid] ?? 0,
      rollLootTable(entries, world.rng),
    );
  }
}
