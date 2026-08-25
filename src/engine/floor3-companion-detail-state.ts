/**
 * Pure view model for the Floor 3 Companion detail / roster screen
 * (game-design §15 surface 5): stats, affinity, style, ability milestones, and
 * the evolution track.
 *
 * Derived on read from `Companion` + the static species/style registries, so
 * the panel can never disagree with what the simulation believes about a
 * Companion. No Phaser imports — the widget renders what this returns.
 */
import type { GameWorld } from '../core/world.js';
import { TeamId } from '../shared/constants.js';
import type { Affinity } from '../shared/data/floor3/affinity.js';
import { predatorsOf, strongAgainst } from '../shared/data/floor3/affinity.js';
import {
  ABILITY_MILESTONE_LEVELS,
  formForLevel,
  speciesForToken,
  type PetSpeciesDef,
} from '../shared/data/floor3/species.js';
import { STYLE_PERSONAS, type FightingStyle } from '../shared/data/floor3/styles.js';
import {
  abilityDisplayName,
  AFFINITY_HUD_COLORS,
  partyMemberKey,
  resolvePartyMemberEids,
  type PartyMemberKey,
} from './floor3-party-state.js';

/** One row of the evolution track (baby → adolescent → adult). */
export interface CompanionFormStep {
  readonly form: 0 | 1 | 2;
  readonly name: string;
  readonly minLevel: number;
  /** Multiplier this form applies over the style's base archetype. */
  readonly statScale: number;
  /** True once the Companion's level has reached `minLevel`. */
  readonly reached: boolean;
  /** True when this is the Companion's CURRENT form. */
  readonly current: boolean;
}

/** One row of the ability milestone track. */
export interface CompanionAbilityStep {
  readonly level: number;
  readonly abilityId: string;
  readonly name: string;
  readonly learned: boolean;
}

/** Full detail view model for one Companion. */
export interface CompanionDetail {
  readonly eid: number;
  readonly key: PartyMemberKey;
  readonly slot: number;
  readonly speciesId: string;
  readonly displayName: string;
  readonly affinity: Affinity;
  readonly affinityColor: number;
  readonly fightingStyle: FightingStyle;
  readonly level: number;
  readonly xp: number;
  readonly form: 0 | 1 | 2;
  readonly knockedOut: boolean;
  readonly hpCurrent: number;
  readonly hpMax: number;
  /** Persona parameters the fighting style drives (spec R4). */
  readonly persona: {
    readonly aiType: string;
    readonly rangeProfile: string;
    readonly cadence: number;
    readonly hpProfile: string;
    readonly dmgProfile: string;
    readonly speedProfile: string;
  };
  /** Affinities this Companion hits for x2 (spec R3 ring). */
  readonly strongAgainst: readonly Affinity[];
  /** Affinities that hit this Companion for x2. */
  readonly weakTo: readonly Affinity[];
  readonly formTrack: readonly CompanionFormStep[];
  readonly abilityTrack: readonly CompanionAbilityStep[];
  /** Next form the Companion evolves into, or `undefined` at adult. */
  readonly nextForm: CompanionFormStep | undefined;
  /** Next ability milestone, or `undefined` once all five are learned. */
  readonly nextAbility: CompanionAbilityStep | undefined;
}

/** Evolution track for a species at `level` (pure; no world reads). */
export function resolveFormTrack(
  species: PetSpeciesDef,
  level: number,
): readonly CompanionFormStep[] {
  const currentForm = formForLevel(species, level).form;
  return species.forms.map((form) => ({
    form: form.form,
    name: form.name,
    minLevel: form.minLevel,
    statScale: form.statScale,
    reached: level >= form.minLevel,
    current: form.form === currentForm,
  }));
}

/** Ability milestone track for a species at `level` (pure; no world reads). */
export function resolveAbilityTrack(
  species: PetSpeciesDef,
  level: number,
): readonly CompanionAbilityStep[] {
  return ABILITY_MILESTONE_LEVELS.map((milestone) => ({
    level: milestone,
    abilityId: species.abilityIdsByLevel[String(milestone) as `${typeof milestone}`],
    name: abilityDisplayName(species, milestone),
    learned: level >= milestone,
  }));
}

/** Detail view model for one Companion entity, or `undefined` when unknown. */
export function resolveCompanionDetail(world: GameWorld, eid: number): CompanionDetail | undefined {
  const store = world.stores.companion;
  const speciesToken = store.speciesToken[eid] ?? 0;
  const species = speciesForToken(speciesToken);
  if (species === undefined) return undefined;

  const level = store.level[eid] ?? 1;
  const form = formForLevel(species, level);
  const persona = STYLE_PERSONAS[species.fightingStyle];
  const formTrack = resolveFormTrack(species, level);
  const abilityTrack = resolveAbilityTrack(species, level);
  const slot = world.stores.partySlot.slot[eid] ?? 0;

  return {
    eid,
    key: partyMemberKey(slot, speciesToken),
    slot,
    speciesId: species.speciesId,
    displayName: form.name,
    affinity: species.affinity,
    affinityColor: AFFINITY_HUD_COLORS[species.affinity],
    fightingStyle: species.fightingStyle,
    level,
    xp: store.xp[eid] ?? 0,
    form: form.form,
    knockedOut: (store.knockedOut[eid] ?? 0) === 1,
    hpCurrent: world.stores.health.current[eid] ?? 0,
    hpMax: world.stores.health.max[eid] ?? 0,
    persona: {
      aiType: persona.aiType,
      rangeProfile: persona.rangeProfile,
      cadence: persona.cadence,
      hpProfile: persona.hpProfile,
      dmgProfile: persona.dmgProfile,
      speedProfile: persona.speedProfile,
    },
    strongAgainst: strongAgainst(species.affinity),
    weakTo: predatorsOf(species.affinity),
    formTrack,
    abilityTrack,
    nextForm: formTrack.find((step) => !step.reached),
    nextAbility: abilityTrack.find((step) => !step.learned),
  };
}

/** Detail view models for the whole party, in slot order (roster screen). */
export function resolveRosterEntries(
  world: GameWorld,
  ownerTeam: number = TeamId.PLAYER,
): readonly CompanionDetail[] {
  const entries: CompanionDetail[] = [];
  for (const eid of resolvePartyMemberEids(world, ownerTeam)) {
    const detail = resolveCompanionDetail(world, eid);
    if (detail !== undefined) entries.push(detail);
  }
  return entries;
}

/**
 * Clamp a roster cursor into `[0, count - 1]`, wrapping at both ends so the
 * roster screen's next/previous keys cycle. Returns 0 for an empty roster.
 */
export function wrapRosterIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
