/**
 * Loot Tables — data-driven drop configuration and roll logic.
 *
 * Loot resolution uses a 4-layer union:
 *   1. Entity-level (unique named enemies)
 *   2. Type-level (enemy species/class)
 *   3. Area/geography (current map zone)
 *   4. Global/floor (floor-wide drops)
 *
 * All layers are merged and each entry rolled independently via SeededRandom.
 */
import type { SeededRandom } from './random.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LootEntry {
  /** What to drop. */
  type: 'gold' | 'xp' | 'item';
  /** For 'item': item id from ITEM_CATALOG. Ignored for gold/xp. */
  itemId?: string;
  /** Base value (gold amount or xp gem value). */
  value: number;
  /** Drop chance 0..1 (1 = always drops). */
  chance: number;
  /** Minimum quantity (inclusive). */
  min: number;
  /** Maximum quantity (inclusive). */
  max: number;
}

export interface LootTable {
  id: string;
  entries: LootEntry[];
}

export interface LootDrop {
  type: 'gold' | 'xp' | 'item';
  /** For 'item': item id from ITEM_CATALOG. */
  itemId?: string;
  /** Resolved value per unit (gold amount or xp value). */
  value: number;
  /** How many to spawn (rolled from min..max). */
  quantity: number;
}

export interface EnemyDropConfig {
  /** Whether this enemy archetype is allowed to spawn loot at all. */
  dropsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Roll logic (pure functions)
// ---------------------------------------------------------------------------

/** Roll a single loot entry. Returns a LootDrop if the chance succeeds, else null. */
export function rollEntry(entry: LootEntry, rng: SeededRandom): LootDrop | null {
  if (entry.chance <= 0) return null;
  if (rng.next() > entry.chance) return null;

  const quantity =
    entry.min === entry.max
      ? entry.min
      : entry.min + Math.floor(rng.next() * (entry.max - entry.min + 1));

  if (quantity <= 0) return null;

  return {
    type: entry.type,
    itemId: entry.itemId,
    value: entry.value,
    quantity,
  };
}

/** Roll all entries in a loot table independently. Returns array of successful drops. */
export function rollLootTable(entries: readonly LootEntry[], rng: SeededRandom): LootDrop[] {
  const drops: LootDrop[] = [];
  for (const entry of entries) {
    const drop = rollEntry(entry, rng);
    if (drop) drops.push(drop);
  }
  return drops;
}

/**
 * Merge entries from multiple loot table layers into a single entry list.
 * All provided tables contribute entries; `undefined` layers are skipped.
 */
export function resolveLootTables(...tables: (LootTable | undefined)[]): LootEntry[] {
  const merged: LootEntry[] = [];
  for (const table of tables) {
    if (table) merged.push(...table.entries);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Default loot tables
// ---------------------------------------------------------------------------

export const LOOT_TABLES = {
  // Type-level tables
  BASIC_MELEE: {
    id: 'basic_melee',
    entries: [
      { type: 'xp' as const, value: 1, chance: 1.0, min: 1, max: 1 },
      { type: 'gold' as const, value: 1, chance: 0.5, min: 1, max: 3 },
      { type: 'item' as const, itemId: 'bone-shard', value: 1, chance: 0.05, min: 1, max: 1 },
    ],
  } satisfies LootTable,

  BASIC_RANGED: {
    id: 'basic_ranged',
    entries: [
      { type: 'xp' as const, value: 1, chance: 1.0, min: 1, max: 1 },
      { type: 'gold' as const, value: 2, chance: 0.6, min: 1, max: 4 },
      { type: 'item' as const, itemId: 'bone-shard', value: 1, chance: 0.08, min: 1, max: 1 },
    ],
  } satisfies LootTable,

  ELITE: {
    id: 'elite',
    entries: [
      { type: 'xp' as const, value: 5, chance: 1.0, min: 1, max: 3 },
      { type: 'gold' as const, value: 5, chance: 0.8, min: 3, max: 8 },
      { type: 'item' as const, itemId: 'iron-ore', value: 1, chance: 0.2, min: 1, max: 2 },
    ],
  } satisfies LootTable,

  // Minor boss (slime-rat mid-floor encounter): dramatic but not final-boss scale.
  // Drops a shower of XP gems + gold coins for a satisfying mid-floor payoff.
  BOSS_MINOR: {
    id: 'boss_minor',
    entries: [
      { type: 'xp' as const, value: 2, chance: 1.0, min: 4, max: 8 },
      { type: 'gold' as const, value: 5, chance: 1.0, min: 14, max: 20 },
      { type: 'item' as const, itemId: 'iron-ore', value: 1, chance: 0.3, min: 1, max: 1 },
    ],
  } satisfies LootTable,

  // Major boss (staircase end-of-floor): the climactic finale drop.
  // Many XP gems + a big haul of gold so the kill looks spectacular.
  BOSS: {
    id: 'boss',
    entries: [
      { type: 'xp' as const, value: 2, chance: 1.0, min: 10, max: 16 },
      { type: 'gold' as const, value: 8, chance: 1.0, min: 20, max: 28 },
      { type: 'item' as const, itemId: 'iron-ore', value: 1, chance: 0.5, min: 1, max: 3 },
    ],
  } satisfies LootTable,

  // Floor-level tables
  FLOOR_1: {
    id: 'floor_1',
    entries: [
      // Reduced from value 4 → 1 so regular kills contribute ~2 XP each (BASIC_MELEE+FLOOR_1).
      // Boss kills now provide the bulk of XP so the player reaches ~level 6 by floor end.
      { type: 'xp' as const, value: 1, chance: 1.0, min: 1, max: 1 },
      { type: 'item' as const, itemId: 'pebble', value: 1, chance: 0.2, min: 1, max: 1 },
      { type: 'item' as const, itemId: 'rusted-scrap', value: 1, chance: 0.14, min: 1, max: 1 },
      { type: 'item' as const, itemId: 'old-sock', value: 1, chance: 0.08, min: 1, max: 1 },
    ],
  } satisfies LootTable,

  // Floor 2 floor-level bonus: adds 1 XP per kill on top of BASIC_MELEE (1 XP) → 2 XP/kill total.
  // Matches the FLOOR_1 pattern (+1 bonus on Floor 1 → 2 XP/kill total).
  // Starting at level 5 (66 XP), reaching level 10 (200 XP) requires 134 XP = ~67 kills.
  // With Floor 2's ambient director spawning continuously this is achievable before
  // the first boss den encounter, so the level-10 fight level is delivered as intended.
  FLOOR_2: {
    id: 'floor_2',
    entries: [
      { type: 'xp' as const, value: 1, chance: 1.0, min: 1, max: 1 },
    ],
  } satisfies LootTable,
} as const;

/**
 * Per-archetype drop overrides layered on top of the default loot tables.
 * Omitted archetypes inherit the standard enemy drop behavior.
 */
const ENEMY_DROP_CONFIGS: Readonly<Record<string, EnemyDropConfig>> = {
  'slime-mini': {
    dropsEnabled: false,
  },
};

export function getEnemyDropConfig(archetypeId: string | undefined): EnemyDropConfig | undefined {
  return archetypeId ? ENEMY_DROP_CONFIGS[archetypeId] : undefined;
}

/** Convenience lookup by string id. */
export function getLootTable(id: string): LootTable | undefined {
  return Object.values(LOOT_TABLES).find((t) => t.id === id);
}
