import type {
  Floor4ActIndex,
  Floor4HeadlinerCardEntry,
  Floor4HeadlinerGrade,
  Floor4HeadlinerPoolEntry,
} from './floor-types.js';
import { SeededRandom, hashStringToSeed } from './random.js';

export interface Floor4HeadlinerSlotConfig {
  readonly act: number;
  readonly eligibleGrades: readonly Floor4HeadlinerGrade[];
  readonly fixedArchetypeId?: string;
  readonly appearanceFeeGold: number;
}

export interface Floor4HeadlinerConfig {
  readonly pool: readonly Floor4HeadlinerPoolEntry[];
  readonly slots: readonly Floor4HeadlinerSlotConfig[];
}

function floor4HeadlinerSlotId(act: Floor4ActIndex): string {
  return `floor4-headliner-act-${act}`;
}

function floor4HeadlineStreamKey(seed: number): string {
  return `${seed}:floor4:headline`;
}

function asFloor4ActIndex(act: number): Floor4ActIndex {
  if (act < 1 || act > 5 || !Number.isInteger(act)) {
    throw new Error(`Floor 4 Headliner act must be 1..5, got ${act}`);
  }
  return act as Floor4ActIndex;
}

function toCardEntry(
  slot: Floor4HeadlinerSlotConfig,
  picked: Floor4HeadlinerPoolEntry,
  fixedFinale: boolean,
): Floor4HeadlinerCardEntry {
  const act = asFloor4ActIndex(slot.act);
  return Object.freeze({
    act,
    slotId: floor4HeadlinerSlotId(act),
    archetypeId: picked.archetypeId,
    grade: picked.grade,
    displayName: picked.displayName,
    entranceAnnouncement: picked.entranceAnnouncement,
    appearanceFeeGold: slot.appearanceFeeGold,
    fixedFinale,
  });
}

/**
 * Build the five-act Headliner card from one isolated stream (spec FR4.1/FR7.2).
 *
 * Acts 1–4 draw without replacement from eligible grades. Fixed slots (act 5 in
 * the authored manifest) do not consume the random stream and still participate
 * in the returned act-slot identity list.
 */
export function buildFloor4HeadlinerCard(
  config: Floor4HeadlinerConfig,
  seed: number,
): readonly Floor4HeadlinerCardEntry[] {
  const rng = new SeededRandom(hashStringToSeed(floor4HeadlineStreamKey(seed)));
  const used = new Set<string>();
  const card: Floor4HeadlinerCardEntry[] = [];

  for (const slot of config.slots) {
    const eligible = config.pool.filter((entry) => slot.eligibleGrades.includes(entry.grade));
    const candidates = eligible.filter((entry) => !used.has(entry.archetypeId));
    const picked = slot.fixedArchetypeId
      ? eligible.find((entry) => entry.archetypeId === slot.fixedArchetypeId)
      : candidates.length > 0
        ? rng.pick(candidates)
        : undefined;
    if (!picked) {
      throw new Error(`Floor 4 Headliner slot ${slot.act} has no eligible unused candidate`);
    }
    used.add(picked.archetypeId);
    card.push(toCardEntry(slot, picked, slot.fixedArchetypeId !== undefined));
  }

  return Object.freeze(card);
}
