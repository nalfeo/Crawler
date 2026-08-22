/**
 * Floor 3 Companion League — recruiting (starter offer + Trainer poach offer
 * + party-fill wiring) per `.specify/specs/floor3-companion-league.md` R5,
 * slice 6.
 *
 * Offer generation is pure and seeded (`SeededRandom`) so a given seed always
 * offers the same species in the same order (spec R8 determinism). Actually
 * spawning a picked species into the party is delegated to the core
 * `recruitPartyCompanion` spawner, which owns `PartySlot` assignment/locking;
 * this module only adds the game-layer concern of mapping a species'
 * `FightingStyle` persona to the numeric `AI_TYPE` the core spawner expects
 * (core must not depend on `src/game/`, spec R4).
 */
import { recruitPartyCompanion, type GameWorld } from '../core/index.js';
import type { SeededRandom } from '../shared/random.js';
import {
  getPetSpecies,
  loadPetSpecies,
  speciesTokenForId,
  type PetSpeciesDef,
} from '../shared/data/floor3/species.js';
import type { Affinity } from '../shared/data/floor3/affinity.js';
import {
  STYLE_PERSONAS,
  type FightingStyle,
  type StylePersonaAiType,
} from '../shared/data/floor3/styles.js';
import { AI_TYPE } from './enemyAISystem.js';

/** Species offered for the initial starter pick (spec R5). Signature lines may seed in. */
export const STARTER_OFFER_SIZE = 4;

const AI_TYPE_BY_PERSONA: Readonly<Record<StylePersonaAiType, number>> = {
  CHASE: AI_TYPE.CHASE,
  RANGED: AI_TYPE.RANGED,
  LEAPER: AI_TYPE.LEAPER,
  GUARDIAN: AI_TYPE.GUARDIAN,
  SUPPORT: AI_TYPE.SUPPORT,
};

/** Numeric `AI_TYPE` a species' fighting style drives (spec R4). */
export function aiTypeForSpecies(species: PetSpeciesDef): number {
  return AI_TYPE_BY_PERSONA[STYLE_PERSONAS[species.fightingStyle].aiType];
}

/**
 * Seeded diversity-constrained sample: greedily picks up to `count` species
 * over a seeded shuffle so that no two chosen species share an affinity
 * (Temperament) or a fighting style. Against the full 7×7 affinity×style grid
 * this always yields `count` species spanning `count` distinct affinities AND
 * `count` distinct styles for any `count <= 7`, so a starter offer can never
 * collapse to one Temperament (spec §6.1). If the pool is too narrow to stay
 * fully distinct, the remaining slots are topped up with any distinct species
 * so the requested offer size is still honored.
 */
function pickDiverse(
  rng: SeededRandom,
  pool: readonly PetSpeciesDef[],
  count: number,
): readonly PetSpeciesDef[] {
  const shuffled = rng.shuffle(pool.slice());
  const chosen: PetSpeciesDef[] = [];
  const usedAffinities = new Set<Affinity>();
  const usedStyles = new Set<FightingStyle>();
  for (const species of shuffled) {
    if (chosen.length >= count) break;
    if (usedAffinities.has(species.affinity) || usedStyles.has(species.fightingStyle)) continue;
    chosen.push(species);
    usedAffinities.add(species.affinity);
    usedStyles.add(species.fightingStyle);
  }
  if (chosen.length < count) {
    const chosenIds = new Set(chosen.map((s) => s.speciesId));
    for (const species of shuffled) {
      if (chosen.length >= count) break;
      if (chosenIds.has(species.speciesId)) continue;
      chosen.push(species);
      chosenIds.add(species.speciesId);
    }
  }
  return chosen;
}

/**
 * Seeded starter offer: `count` species drawn from the full roster under a
 * diversity constraint (spec §6.1 / R5 — "offer 4 random species (seeded),
 * drawn to span distinct affinities and styles so the offer is never all one
 * Temperament"). The signature starter lines may seed into the pool, so they
 * are not excluded here.
 */
export function generateStarterOffer(
  rng: SeededRandom,
  count: number = STARTER_OFFER_SIZE,
): readonly PetSpeciesDef[] {
  return pickDiverse(rng, loadPetSpecies(), count);
}

/**
 * Seeded Trainer-poach offer: the COMPLETE validated roster that Trainer
 * fields (spec §6.2 / R5 — on victory the player "chooses 1 of that Trainer's
 * Companions", so the picker must show every one of that Trainer's 2–3
 * Companions, not a random subset). Returned in a seeded order for stable
 * presentation. Unknown species ids are silently dropped rather than throwing,
 * since the offer pool is Trainer-authored content this module does not own,
 * and duplicate ids are collapsed so the same species is never offered twice.
 */
export function generateTrainerPoachOffer(
  rng: SeededRandom,
  trainerSpeciesIds: readonly string[],
): readonly PetSpeciesDef[] {
  const seen = new Set<string>();
  const pool: PetSpeciesDef[] = [];
  for (const speciesId of trainerSpeciesIds) {
    const species = getPetSpecies(speciesId);
    if (species === undefined || seen.has(species.speciesId)) continue;
    seen.add(species.speciesId);
    pool.push(species);
  }
  return rng.shuffle(pool);
}

export interface RecruitCompanionOptions {
  x: number;
  y: number;
  hp: number;
  speed: number;
  aggroRange: number;
  attackRange: number;
  level?: number;
  ownerTeam: number;
}

/**
 * Recruits `speciesId` into `ownerTeam`'s party (starter pick or Trainer
 * poach), deriving the correct `AI_TYPE` from the species' fighting style.
 * Returns the new entity id, or `undefined` if the party has already locked
 * (spec R5) or `speciesId` is unknown.
 */
export function recruitCompanion(
  world: GameWorld,
  speciesId: string,
  options: RecruitCompanionOptions,
): number | undefined {
  const species = getPetSpecies(speciesId);
  if (species === undefined) return undefined;

  return recruitPartyCompanion(world, {
    x: options.x,
    y: options.y,
    hp: options.hp,
    aiType: aiTypeForSpecies(species),
    speed: options.speed,
    aggroRange: options.aggroRange,
    attackRange: options.attackRange,
    speciesToken: speciesTokenForId(species.speciesId),
    level: options.level ?? 1,
    ownerTeam: options.ownerTeam,
  });
}
