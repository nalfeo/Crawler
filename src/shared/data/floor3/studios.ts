/**
 * Floor 3 Companion League — Studio + Final Four candidate rosters (spec
 * `.specify/specs/floor3-companion-league.md` R6, slice 8).
 *
 * Pure data + a seeded selection helper. `selectFloor3Studios` /
 * `selectFloor3FinalFour` each draw a fixed-size subset of their candidate
 * pool via `SeededRandom`, so the same floor seed always reproduces the same
 * Studio/Final-Four roster AND order (spec R8's hard determinism
 * requirement — see `tests/unit/floor3-studios.test.ts`).
 *
 * Levels here are a first playable pass, not a balance pass — win-rate
 * tuning is spec slice 16, gated on a headless seed sweep (project rule #12),
 * never on these numbers directly.
 */
import type { SeededRandom } from '../../random.js';
import { getPetSpecies } from './species.js';

export interface TrainerCompanionDef {
  readonly speciesId: string;
  readonly level: number;
}

export interface TrainerDef {
  readonly trainerId: string;
  readonly name: string;
  readonly companions: readonly TrainerCompanionDef[];
}

export interface StudioDef {
  readonly studioId: string;
  readonly name: string;
  readonly trainers: readonly TrainerDef[];
}

export interface FinalFourDef {
  readonly handlerId: string;
  readonly name: string;
  readonly companions: readonly TrainerCompanionDef[];
}

/** Studios actually used on a floor run (spec R6: "counter (0→6)"). */
export const FLOOR3_STUDIO_SELECT_COUNT = 6;
/** Final Four handlers actually used on a floor run (spec R5/R6). */
export const FLOOR3_FINAL_FOUR_SELECT_COUNT = 4;

/** ~10-candidate Studio pool (spec R8: "6-of-~10 Studio pick"). */
export const STUDIO_CANDIDATES: readonly StudioDef[] = [
  {
    studioId: 'emberforge',
    name: 'Emberforge Studio',
    trainers: [
      {
        trainerId: 'emberforge-kess',
        name: 'Kess',
        companions: [
          { speciesId: 'ember-charger', level: 8 },
          { speciesId: 'ember-bruiser', level: 9 },
        ],
      },
      {
        trainerId: 'emberforge-rho',
        name: 'Rho',
        companions: [
          { speciesId: 'ember-slinger', level: 8 },
          { speciesId: 'ember-kindler', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'bloomhollow',
    name: 'Bloomhollow Studio',
    trainers: [
      {
        trainerId: 'bloomhollow-wisp',
        name: 'Wisp',
        companions: [
          { speciesId: 'bloom-pouncer', level: 8 },
          { speciesId: 'bloom-warden', level: 9 },
        ],
      },
      {
        trainerId: 'bloomhollow-nell',
        name: 'Nell',
        companions: [
          { speciesId: 'bloom-burster', level: 8 },
          { speciesId: 'bloom-slinger', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'stoneward',
    name: 'Stoneward Studio',
    trainers: [
      {
        trainerId: 'stoneward-grix',
        name: 'Grix',
        companions: [
          { speciesId: 'stone-bruiser', level: 9 },
          { speciesId: 'stone-warden', level: 10 },
        ],
      },
      {
        trainerId: 'stoneward-talia',
        name: 'Talia',
        companions: [
          { speciesId: 'stone-charger', level: 8 },
          { speciesId: 'stone-kindler', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'galeloft',
    name: 'Galeloft Studio',
    trainers: [
      {
        trainerId: 'galeloft-yara',
        name: 'Yara',
        companions: [
          { speciesId: 'gale-slinger', level: 8 },
          { speciesId: 'gale-burster', level: 9 },
        ],
      },
      {
        trainerId: 'galeloft-denn',
        name: 'Denn',
        companions: [
          { speciesId: 'gale-charger', level: 8 },
          { speciesId: 'gale-pouncer', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'tidereach',
    name: 'Tidereach Studio',
    trainers: [
      {
        trainerId: 'tidereach-marlo',
        name: 'Marlo',
        companions: [
          { speciesId: 'tide-warden', level: 9 },
          { speciesId: 'tide-bruiser', level: 10 },
        ],
      },
      {
        trainerId: 'tidereach-coral',
        name: 'Coral',
        companions: [
          { speciesId: 'tide-kindler', level: 8 },
          { speciesId: 'tide-slinger', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'gloomvale',
    name: 'Gloomvale Studio',
    trainers: [
      {
        trainerId: 'gloomvale-ashen',
        name: 'Ashen',
        companions: [
          { speciesId: 'gloom-pouncer', level: 9 },
          { speciesId: 'gloom-burster', level: 10 },
        ],
      },
      {
        trainerId: 'gloomvale-vess',
        name: 'Vess',
        companions: [
          { speciesId: 'gloom-charger', level: 8 },
          { speciesId: 'gloom-warden', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'lumenspire',
    name: 'Lumenspire Studio',
    trainers: [
      {
        trainerId: 'lumenspire-iris',
        name: 'Iris',
        companions: [
          { speciesId: 'lumen-kindler', level: 9 },
          { speciesId: 'lumen-slinger', level: 10 },
        ],
      },
      {
        trainerId: 'lumenspire-otto',
        name: 'Otto',
        companions: [
          { speciesId: 'lumen-bruiser', level: 8 },
          { speciesId: 'lumen-charger', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'cinderveil',
    name: 'Cinderveil Studio',
    trainers: [
      {
        trainerId: 'cinderveil-rask',
        name: 'Rask',
        companions: [
          { speciesId: 'ember-kindler', level: 9 },
          { speciesId: 'gloom-bruiser', level: 10 },
        ],
      },
      {
        trainerId: 'cinderveil-nia',
        name: 'Nia',
        companions: [
          { speciesId: 'ember-pouncer', level: 9 },
          { speciesId: 'gloom-slinger', level: 9 },
        ],
      },
    ],
  },
  {
    studioId: 'verdant-tide',
    name: 'Verdant Tide Studio',
    trainers: [
      {
        trainerId: 'verdant-tide-sable',
        name: 'Sable',
        companions: [
          { speciesId: 'bloom-bruiser', level: 9 },
          { speciesId: 'tide-pouncer', level: 9 },
        ],
      },
      {
        trainerId: 'verdant-tide-umbo',
        name: 'Umbo',
        companions: [
          { speciesId: 'bloom-charger', level: 9 },
          { speciesId: 'tide-burster', level: 10 },
        ],
      },
    ],
  },
  {
    studioId: 'skyroot',
    name: 'Skyroot Studio',
    trainers: [
      {
        trainerId: 'skyroot-pike',
        name: 'Pike',
        companions: [
          { speciesId: 'gale-warden', level: 9 },
          { speciesId: 'stone-slinger', level: 10 },
        ],
      },
      {
        trainerId: 'skyroot-bex',
        name: 'Bex',
        companions: [
          { speciesId: 'gale-kindler', level: 9 },
          { speciesId: 'stone-pouncer', level: 9 },
        ],
      },
    ],
  },
];

/** ~7-candidate Final Four pool (spec R8: "4-of-~7 Final Four pick"). */
export const FINAL_FOUR_CANDIDATES: readonly FinalFourDef[] = [
  {
    handlerId: 'final-four-draven',
    name: 'Draven the Unbound',
    companions: [
      { speciesId: 'ember-warden', level: 22 },
      { speciesId: 'gloom-bruiser', level: 23 },
      { speciesId: 'lumen-slinger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-sela',
    name: 'Sela Windrider',
    companions: [
      { speciesId: 'gale-burster', level: 22 },
      { speciesId: 'tide-warden', level: 23 },
      { speciesId: 'stone-charger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-moss',
    name: 'Moss Query',
    companions: [
      { speciesId: 'bloom-kindler', level: 22 },
      { speciesId: 'stone-pouncer', level: 23 },
      { speciesId: 'ember-slinger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-ferrous',
    name: 'Ferrous Vale',
    companions: [
      { speciesId: 'stone-bruiser', level: 23 },
      { speciesId: 'gale-pouncer', level: 22 },
      { speciesId: 'lumen-charger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-nyx',
    name: 'Nyx Halcyon',
    companions: [
      { speciesId: 'gloom-warden', level: 23 },
      { speciesId: 'lumen-burster', level: 22 },
      { speciesId: 'tide-slinger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-coda',
    name: 'Coda Brightwater',
    companions: [
      { speciesId: 'tide-bruiser', level: 23 },
      { speciesId: 'bloom-burster', level: 22 },
      { speciesId: 'gale-charger', level: 22 },
    ],
  },
  {
    handlerId: 'final-four-riven',
    name: 'Riven Ashcourt',
    companions: [
      { speciesId: 'signature-volcanix', level: 25 },
      { speciesId: 'signature-tempestryn', level: 25 },
      { speciesId: 'signature-eclipsewyrm', level: 25 },
    ],
  },
];

function assertKnownSpecies(companions: readonly TrainerCompanionDef[], ownerId: string): void {
  for (const companion of companions) {
    if (!getPetSpecies(companion.speciesId)) {
      throw new Error(
        `Floor 3 roster ${ownerId} references unknown speciesId "${companion.speciesId}"`,
      );
    }
  }
}

for (const studio of STUDIO_CANDIDATES) {
  for (const trainer of studio.trainers) {
    assertKnownSpecies(trainer.companions, trainer.trainerId);
  }
}
for (const handler of FINAL_FOUR_CANDIDATES) {
  assertKnownSpecies(handler.companions, handler.handlerId);
}

/**
 * Seeded selection of `count` distinct candidates via a full seeded shuffle,
 * taking the first `count` entries. Same seed -> same subset AND order
 * (spec R8).
 */
function selectSeeded<T>(rng: SeededRandom, candidates: readonly T[], count: number): readonly T[] {
  // Fixed-size selection contract: reject any count that is not a non-negative
  // integer (negative, fractional, NaN, or Infinity) before it can reach
  // `slice`, where e.g. `-1` would silently return "all but one" candidate.
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`selectSeeded: requested count=${count} must be a non-negative integer`);
  }
  if (count > candidates.length) {
    throw new Error(
      `selectSeeded: requested count=${count} exceeds candidate pool size=${candidates.length}`,
    );
  }
  return rng.shuffle(candidates.slice()).slice(0, count);
}

/** Seeded pick of {@link FLOOR3_STUDIO_SELECT_COUNT} Studios, in seeded order. */
export function selectFloor3Studios(
  rng: SeededRandom,
  count: number = FLOOR3_STUDIO_SELECT_COUNT,
): readonly StudioDef[] {
  return selectSeeded(rng, STUDIO_CANDIDATES, count);
}

/** Seeded pick of {@link FLOOR3_FINAL_FOUR_SELECT_COUNT} Final Four handlers, in seeded order. */
export function selectFloor3FinalFour(
  rng: SeededRandom,
  count: number = FLOOR3_FINAL_FOUR_SELECT_COUNT,
): readonly FinalFourDef[] {
  return selectSeeded(rng, FINAL_FOUR_CANDIDATES, count);
}
