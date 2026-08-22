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
import { STYLE_PERSONAS, type StylePersonaAiType } from '../shared/data/floor3/styles.js';
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

function pickDistinct<T>(rng: SeededRandom, pool: readonly T[], count: number): readonly T[] {
  const shuffled = rng.shuffle(pool.slice());
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Seeded starter offer: `count` distinct species drawn from the full roster
 * (spec R5 — "offer 4 random species (seeded)"; the signature starter line
 * may seed into the pool, so it is not excluded here).
 */
export function generateStarterOffer(
  rng: SeededRandom,
  count: number = STARTER_OFFER_SIZE,
): readonly PetSpeciesDef[] {
  return pickDistinct(rng, loadPetSpecies(), count);
}

/**
 * Seeded Trainer-poach offer: `count` distinct species drawn from that
 * Trainer's own roster (spec R5 — "offer that Trainer's 2–3 Companions").
 * Unknown species ids are silently dropped rather than throwing, since the
 * offer pool is Trainer-authored content this module does not own.
 */
export function generateTrainerPoachOffer(
  rng: SeededRandom,
  trainerSpeciesIds: readonly string[],
  count: number,
): readonly PetSpeciesDef[] {
  const pool = trainerSpeciesIds
    .map((speciesId) => getPetSpecies(speciesId))
    .filter((species): species is PetSpeciesDef => species !== undefined);
  return pickDistinct(rng, pool, count);
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
