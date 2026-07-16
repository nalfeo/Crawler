/**
 * Spawner archetype registry.
 *
 * Mirrors the `skills/registry.ts` / `abilities/registry.ts` pattern: a flat,
 * index-addressable table of {@link SpawnerArchetype} definitions plus lookup
 * helpers. The `Spawner` component stores only a `defIndex` into this table, so
 * the index order is stable and append-only.
 */
import { AI_TYPE } from '../enemyAISystem.js';
import type { MobTemplate, SpawnPoolEntry, SpawnerArchetype } from './types.js';
import type { EntitySpriteMappings } from '../../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../shared/data/entity-sprite-mappings.json';

/** Rats bleed red. */
const BLOOD_RAT = 0xcc0000;
/** Slimes bleed green ichor. */
const BLOOD_SLIME = 0x66cc33;
const ENEMY_TEXTURES = (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).enemies;
const RAT_TEXTURE_ID = ENEMY_TEXTURES.enemy_rat?.textureId;
const SLIME_TEXTURE_ID = ENEMY_TEXTURES.enemy_slime?.textureId;
if (RAT_TEXTURE_ID === undefined || SLIME_TEXTURE_ID === undefined) {
  throw new Error('Missing enemy texture ids in entity sprite mappings for spawner registry.');
}

// --- Rats Nest mobs ---------------------------------------------------------

const RAT: MobTemplate = {
  id: 'rat',
  name: 'Rat',
  aiType: AI_TYPE.CHASE,
  hp: 8,
  speed: 0.225,
  aggroRange: 40,
  attackRange: 0,
  contactDamage: 4,
  weight: 6,
  bloodColor: BLOOD_RAT,
  textureId: RAT_TEXTURE_ID,
  spriteWidth: 1.5,
  spriteHeight: 1.5,
};

const RAT_BRUTE: MobTemplate = {
  id: 'rat-brute',
  name: 'Rat Brute',
  aiType: AI_TYPE.CHASE,
  hp: 28,
  speed: 0.15,
  aggroRange: 42.5,
  attackRange: 0,
  contactDamage: 7,
  weight: 30,
  bloodColor: BLOOD_RAT,
  textureId: RAT_TEXTURE_ID,
  // Exactly 25% larger than the baseline rat (1.5ft * 1.25 = 1.875ft).
  spriteWidth: 1.875,
  spriteHeight: 1.875,
};

const RAT_KING: MobTemplate = {
  id: 'rat-king',
  name: 'Rat King',
  aiType: AI_TYPE.CHASE,
  hp: 90,
  speed: 0.175,
  aggroRange: 65,
  attackRange: 0,
  contactDamage: 16,
  weight: 70,
  bloodColor: BLOOD_RAT,
  textureId: RAT_TEXTURE_ID,
  spriteWidth: 3,
  spriteHeight: 3,
};

const RAT_QUEEN: MobTemplate = {
  id: 'rat-queen',
  name: 'Rat Queen',
  aiType: AI_TYPE.CHASE,
  hp: 80,
  speed: 0.2125,
  aggroRange: 70,
  attackRange: 0,
  contactDamage: 14,
  weight: 60,
  bloodColor: BLOOD_RAT,
  textureId: RAT_TEXTURE_ID,
  spriteWidth: 3,
  spriteHeight: 3,
};

// --- Slime Pool mobs --------------------------------------------------------

const SLIME: MobTemplate = {
  id: 'slime',
  name: 'Slime',
  aiType: AI_TYPE.LEAPER,
  hp: 12,
  speed: 0.1125,
  aggroRange: 40,
  attackRange: 0,
  contactDamage: 6,
  weight: 20,
  bloodColor: BLOOD_SLIME,
  textureId: SLIME_TEXTURE_ID,
  spriteWidth: 2,
  spriteHeight: 2,
};

const MAMA_SLIME: MobTemplate = {
  id: 'mama-slime',
  name: 'Mama Slime',
  aiType: AI_TYPE.LEAPER,
  hp: 100,
  speed: 0.0875,
  aggroRange: 52.5,
  attackRange: 0,
  contactDamage: 18,
  weight: 130,
  bloodColor: BLOOD_SLIME,
  textureId: SLIME_TEXTURE_ID,
  spriteWidth: 3.5,
  spriteHeight: 3.5,
};

const PAPA_SLIME: MobTemplate = {
  id: 'papa-slime',
  name: 'Papa Slime',
  aiType: AI_TYPE.LEAPER,
  hp: 120,
  speed: 0.075,
  aggroRange: 52.5,
  attackRange: 0,
  contactDamage: 22,
  weight: 160,
  bloodColor: BLOOD_SLIME,
  textureId: SLIME_TEXTURE_ID,
  spriteWidth: 3.75,
  spriteHeight: 3.75,
};

// --- Archetypes -------------------------------------------------------------

const RATS_NEST: SpawnerArchetype = {
  id: 'rats-nest',
  name: 'Rats Nest',
  hp: 120,
  weight: 200,
  bloodColor: BLOOD_RAT,
  textureId: RAT_TEXTURE_ID,
  spriteWidth: 3.25,
  spriteHeight: 3.25,
  contactDamage: 4,
  // Slightly larger than the pool because rats emerge from further away and
  // the nest is meant to feel like a bigger room presence.
  arenaRadiusFt: 7,
  // Passive: a slow trickle of rats, with the occasional brute. Concurrent cap
  // kept low so the nest reads as juicy (regular spawn pulses) without flooding
  // Floor 1 — tuned against the headless win-rate gate.
  passive: {
    intervalMs: 3600,
    maxAlive: 3,
    perPulse: 1,
    pool: [
      { weight: 85, mob: RAT },
      { weight: 15, mob: RAT_BRUTE },
    ],
  },
  // Defensive: once hit, the nest boils over — faster, a higher cap, and far
  // more brutes in the mix (still capped so an engaged nest is a spike, not a
  // wipe).
  defensive: {
    intervalMs: 2000,
    maxAlive: 5,
    perPulse: 2,
    pool: [
      { weight: 60, mob: RAT },
      { weight: 40, mob: RAT_BRUTE },
    ],
  },
  // On death: a monarch (king or queen) bursts out alongside a few stragglers.
  onDeath: [
    {
      count: 1,
      pool: [
        { weight: 1, mob: RAT_KING },
        { weight: 1, mob: RAT_QUEEN },
      ],
    },
    { count: 3, pool: [{ weight: 1, mob: RAT }] },
  ],
};

const SLIME_POOL: SpawnerArchetype = {
  id: 'slime-pool',
  name: 'Slime Pool',
  hp: 140,
  weight: 250,
  bloodColor: BLOOD_SLIME,
  textureId: SLIME_TEXTURE_ID,
  spriteWidth: 3.5,
  spriteHeight: 3.5,
  contactDamage: 5,
  // Default arena size (6 ft, per registry policy); leapers close distance
  // faster than the rats so the arena reads plenty large.
  arenaRadiusFt: 6,
  // Passive: lone slimes ooze out slowly. Low concurrent cap keeps the pool
  // visibly active (steady spawn pulses) without swamping Floor 1.
  passive: {
    intervalMs: 4200,
    maxAlive: 3,
    perPulse: 1,
    pool: [{ weight: 100, mob: SLIME }],
  },
  // Defensive: more slimes, faster — the pool churns once disturbed (capped so
  // it stays a manageable surge).
  defensive: {
    intervalMs: 2200,
    maxAlive: 5,
    perPulse: 2,
    pool: [{ weight: 100, mob: SLIME }],
  },
  // On death: a parent slime (Mama or Papa) heaves up plus a couple of slimes.
  onDeath: [
    {
      count: 1,
      pool: [
        { weight: 1, mob: MAMA_SLIME },
        { weight: 1, mob: PAPA_SLIME },
      ],
    },
    { count: 2, pool: [{ weight: 1, mob: SLIME }] },
  ],
};

/**
 * All spawner archetypes, in stable index order. The `Spawner.defIndex` store
 * value indexes into this array, so only ever append new entries.
 */
export const SPAWNER_ARCHETYPES: readonly SpawnerArchetype[] = [RATS_NEST, SLIME_POOL];

const INDEX_BY_ID = new Map<string, number>(
  SPAWNER_ARCHETYPES.map((archetype, index) => [archetype.id, index]),
);

/** Look up a spawner archetype by id. */
export function getSpawnerArchetype(id: string): SpawnerArchetype | undefined {
  const index = INDEX_BY_ID.get(id);
  return index === undefined ? undefined : SPAWNER_ARCHETYPES[index];
}

/** Registry index for an archetype id, or -1 if unknown. */
export function getSpawnerArchetypeIndex(id: string): number {
  return INDEX_BY_ID.get(id) ?? -1;
}

/** Look up a spawner archetype by its registry index. */
export function getSpawnerArchetypeByIndex(index: number): SpawnerArchetype | undefined {
  return SPAWNER_ARCHETYPES[index];
}

/**
 * Deterministically pick a mob from a weighted pool.
 *
 * Pure function: `roll` is a value in [0, 1) (e.g. from `SeededRandom.next()`),
 * which keeps selection seed-stable and trivially unit-testable. Entries with
 * non-positive weight are ignored. Returns undefined only for an empty pool.
 */
export function pickFromPool(
  pool: readonly SpawnPoolEntry[],
  roll: number,
): MobTemplate | undefined {
  if (pool.length === 0) return undefined;

  let total = 0;
  for (const entry of pool) {
    if (entry.weight > 0) total += entry.weight;
  }
  if (total <= 0) return pool[0]?.mob;

  const clamped = roll < 0 ? 0 : roll >= 1 ? 0.999999 : roll;
  let cursor = clamped * total;
  for (const entry of pool) {
    if (entry.weight <= 0) continue;
    cursor -= entry.weight;
    if (cursor < 0) return entry.mob;
  }
  return pool[pool.length - 1]?.mob;
}
