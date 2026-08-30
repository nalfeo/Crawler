/**
 * Floor 5 · Hostile Takeover — the append-only field-Hero roster and the seeded
 * without-replacement card draw (spec `FR6.1`, `FR8.3`).
 *
 * Parallel to `floor4-headliners.ts`, but adapted to Floor 5's contract:
 *
 * - the roster has eight stably ordered entries (design bible §9 table),
 * - exactly ONE field Hero is active at a time (`HUMAN_GATE-3`),
 * - the run's whole draw order is committed once, up front, from the isolated
 *   `heroes` stream, so no respawn ever consumes an RNG draw (`FR6.4`).
 *
 * Determinism: the only randomness is `SeededRandom` over the derived
 * `<seed>:floor5:heroes` stream key. No `Math.random()`, no `Date.now()`.
 */

import type { Floor5FieldHeroCardEntry, Floor5FieldHeroPoolEntry } from './floor-types.js';
import { SeededRandom, hashStringToSeed } from './random.js';

/**
 * The append-only field-Hero roster (spec `FR6.1`/`FR8.3`, design bible §9).
 *
 * **APPEND ONLY.** New Heroes must be added to the END with the next unused
 * `order`. Never renumber, never reorder, never remove, never recycle a
 * `heroId` — the roster ordinal is a stable content identity that recorded
 * cards, saved runs, and regression tests refer to.
 *
 * `displayName`, `role`, and `gimmick` are content owned by the design bible.
 * `hp`/`attackDamage`/`attackCooldownMs`/`speedFtPerFrame`/ranges are
 * within-role Game AI Engineer tuning per `HUMAN_GATE-4`.
 */
export const FLOOR5_FIELD_HERO_ROSTER: readonly Floor5FieldHeroPoolEntry[] = Object.freeze([
  Object.freeze({
    order: 1,
    heroId: 'turnaround-consultant',
    displayName: 'The Turnaround Consultant',
    role: 'counter-push',
    gimmick:
      'Retakes lost ground and "restructures" (reinforces) whatever checkpoint it recaptures',
    hp: 180,
    attackDamage: 14,
    attackCooldownMs: 900,
    speedFtPerFrame: 1.0,
    engageRangeFt: 3,
    aggroRadiusFt: 16,
    leashRadiusFt: 26,
  }),
  Object.freeze({
    order: 2,
    heroId: 'proxy-fighter',
    displayName: 'The Proxy Fighter',
    role: 'counter-push',
    gimmick:
      'Leads the counter-wave personally; buffs nearby minions like a stock proxy rallying votes',
    hp: 165,
    attackDamage: 12,
    attackCooldownMs: 800,
    speedFtPerFrame: 1.05,
    engageRangeFt: 3,
    aggroRadiusFt: 16,
    leashRadiusFt: 26,
  }),
  Object.freeze({
    order: 3,
    heroId: 'compliance-officer-vex',
    displayName: 'Compliance Officer Vex',
    role: 'checkpoint-defense',
    gimmick: 'Anchors a checkpoint behind a slowing "audit zone" nobody is allowed to stand in',
    hp: 210,
    attackDamage: 11,
    attackCooldownMs: 850,
    speedFtPerFrame: 0.8,
    engageRangeFt: 3,
    aggroRadiusFt: 12,
    leashRadiusFt: 10,
  }),
  Object.freeze({
    order: 4,
    heroId: 'the-notary',
    displayName: 'The Notary',
    role: 'checkpoint-defense',
    gimmick: 'Layers paperwork-themed shield stacks that must be "filed" (broken) in sequence',
    hp: 230,
    attackDamage: 9,
    attackCooldownMs: 900,
    speedFtPerFrame: 0.75,
    engageRangeFt: 3,
    aggroRadiusFt: 12,
    leashRadiusFt: 10,
  }),
  Object.freeze({
    order: 5,
    heroId: 'the-union-rep',
    displayName: 'The Union Rep',
    role: 'engine-disruption',
    gimmick: 'Calls a "wildcat strike" that stalls the Ram\'s advance for a telegraphed window',
    hp: 175,
    attackDamage: 13,
    attackCooldownMs: 850,
    speedFtPerFrame: 1.0,
    engageRangeFt: 3,
    aggroRadiusFt: 14,
    leashRadiusFt: 60,
  }),
  Object.freeze({
    order: 6,
    heroId: 'risk-assessment-karen',
    displayName: 'Risk Assessment Karen',
    role: 'engine-disruption',
    gimmick:
      "Debuffs the Ram's escort rather than the Ram itself — asks to speak to the manager of your buffs",
    hp: 170,
    attackDamage: 12,
    attackCooldownMs: 800,
    speedFtPerFrame: 1.0,
    engageRangeFt: 3,
    aggroRadiusFt: 14,
    leashRadiusFt: 60,
  }),
  Object.freeze({
    order: 7,
    heroId: 'the-middle-manager',
    displayName: 'The Middle Manager',
    role: 'minion-support',
    gimmick:
      'Buffs and heals nearby minions; the fight gets meaningfully worse if this one is ignored',
    hp: 160,
    attackDamage: 8,
    attackCooldownMs: 950,
    speedFtPerFrame: 0.9,
    engageRangeFt: 3,
    aggroRadiusFt: 10,
    leashRadiusFt: 18,
  }),
  Object.freeze({
    order: 8,
    heroId: 'the-activist-investor',
    displayName: 'The Activist Investor',
    role: 'artillery',
    gimmick:
      'Ranged Hero lobbing "hostile bids" from range, forcing repositioning like a shareholder forcing a vote',
    hp: 140,
    attackDamage: 10,
    attackCooldownMs: 1_100,
    speedFtPerFrame: 0.7,
    engageRangeFt: 14,
    aggroRadiusFt: 22,
    leashRadiusFt: 16,
  }),
] satisfies Floor5FieldHeroPoolEntry[]);

/** The isolated derived stream every field-Hero draw comes from (spec `FR8.1`). */
export function floor5FieldHeroStreamKey(seed: number): string {
  return `${seed}:floor5:heroes`;
}

/** Stable slot identity for the Nth Hero fielded in a run. */
export function floor5FieldHeroSlotId(slotIndex: number): string {
  return `floor5-field-hero-slot-${slotIndex}`;
}

function toCardEntry(
  slotIndex: number,
  picked: Floor5FieldHeroPoolEntry,
): Floor5FieldHeroCardEntry {
  return Object.freeze({
    slotIndex,
    slotId: floor5FieldHeroSlotId(slotIndex),
    order: picked.order,
    heroId: picked.heroId,
    displayName: picked.displayName,
    role: picked.role,
    hp: picked.hp,
    attackDamage: picked.attackDamage,
  });
}

/**
 * Build the run's field-Hero card: the full without-replacement draw order for
 * the single field slot (spec `FR6.1`).
 *
 * The card is committed ONCE, at floor initialization, from the isolated
 * `heroes` stream. Every later respawn just advances a cursor into this frozen
 * card, which is what lets `FR6.4` guarantee that respawn depends on neither
 * the wall clock nor an RNG draw.
 *
 * The draw does NOT cycle: `card.length === roster.length`, so once the last
 * entry is defeated the slot is permanently retired ("remain defeated according
 * to their slot", `FR6.4`). See ADR 0096.
 */
export function buildFloor5FieldHeroCard(
  roster: readonly Floor5FieldHeroPoolEntry[],
  streamKey: string,
): readonly Floor5FieldHeroCardEntry[] {
  if (roster.length === 0) {
    throw new Error('Floor 5 field-Hero roster must not be empty');
  }
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  for (const entry of roster) {
    if (seenIds.has(entry.heroId)) {
      throw new Error(`Floor 5 field-Hero roster has duplicate heroId "${entry.heroId}"`);
    }
    if (seenOrders.has(entry.order)) {
      throw new Error(`Floor 5 field-Hero roster has duplicate order ${entry.order}`);
    }
    seenIds.add(entry.heroId);
    seenOrders.add(entry.order);
  }

  const rng = new SeededRandom(hashStringToSeed(streamKey));
  const remaining = [...roster];
  const card: Floor5FieldHeroCardEntry[] = [];
  for (let slotIndex = 0; remaining.length > 0; slotIndex += 1) {
    const picked = rng.pick(remaining);
    remaining.splice(
      remaining.findIndex((entry) => entry.heroId === picked.heroId),
      1,
    );
    card.push(toCardEntry(slotIndex, picked));
  }
  return Object.freeze(card);
}
