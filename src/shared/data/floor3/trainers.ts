/**
 * Floor 3's field Trainer circuit. These are intentionally small, authored
 * encounters: their escalating order teaches the player to grow a party before
 * the larger Studio objective begins.
 */
import type { TrainerCompanionDef } from './studios.js';

export interface Floor3FieldTrainerDef {
  readonly trainerId: string;
  readonly name: string;
  readonly title: string;
  readonly goldReward: number;
  readonly companions: readonly TrainerCompanionDef[];
}

/** Ordered, deterministic, and deliberately affinity-diverse poach choices. */
export const FLOOR3_FIELD_TRAINERS: readonly Floor3FieldTrainerDef[] = [
  {
    trainerId: 'field-trainer-mara',
    name: 'Mara',
    title: 'Scout Trainer',
    goldReward: 12,
    companions: [
      { speciesId: 'bloom-pouncer', level: 4 },
      { speciesId: 'tide-warden', level: 4 },
    ],
  },
  {
    trainerId: 'field-trainer-oren',
    name: 'Oren',
    title: 'Trail Trainer',
    goldReward: 18,
    companions: [
      { speciesId: 'stone-bruiser', level: 6 },
      { speciesId: 'gale-slinger', level: 6 },
    ],
  },
  {
    trainerId: 'field-trainer-sable',
    name: 'Sable',
    title: 'League Trainer',
    goldReward: 25,
    companions: [
      { speciesId: 'gloom-burster', level: 8 },
      { speciesId: 'lumen-charger', level: 8 },
      { speciesId: 'ember-kindler', level: 8 },
    ],
  },
];
