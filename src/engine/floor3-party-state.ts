/**
 * Pure resolvers for the Floor 3 Companion League party surfaces
 * (game-design §15 surface 4 "Party HUD" and the shared party identity the
 * roster/notice/command surfaces key off).
 *
 * Everything here is derived on read from data the ECS already stores
 * (`Companion`, `PartySlot`, `Team`, `Health`) plus the static species/style
 * registries — no new component, no new system, and no world mutation, so the
 * simulation stays byte-identical whether or not the HUD is mounted.
 *
 * No Phaser and no rendering imports: this module exists so the row/visibility
 * logic can be unit-tested without mounting the widget (mirrors
 * `family-relationships-state.ts`).
 */
import { query } from 'bitecs';
import { Companion, PartySlot, Team } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { TeamId } from '../shared/constants.js';
import { AFFINITY_RING, type Affinity } from '../shared/data/floor3/affinity.js';
import {
  ABILITY_MILESTONE_LEVELS,
  formForLevel,
  learnedAbilityIds,
  speciesForToken,
  type PetSpeciesDef,
} from '../shared/data/floor3/species.js';
import { STYLE_PERSONAS, type FightingStyle } from '../shared/data/floor3/styles.js';

/** Floor id the Companion League party surfaces belong to. */
export const FLOOR3_FLOOR_ID = 'floor3';

/** Per-affinity HUD swatch color (`0xRRGGBB`), one per Temperament. */
export const AFFINITY_HUD_COLORS: Readonly<Record<Affinity, number>> = Object.freeze({
  ember: 0xf97316,
  bloom: 0x65a30d,
  stone: 0xa16207,
  gale: 0x38bdf8,
  tide: 0x2563eb,
  gloom: 0x7c3aed,
  lumen: 0xfacc15,
});

/**
 * Single-character glyph per fighting style, used where a row is too narrow
 * for the style name. Sprites do not exist for Floor 3 yet (spec "known
 * gaps"), so the party HUD reads affinity by color swatch and style by glyph.
 */
export const STYLE_HUD_GLYPHS: Readonly<Record<FightingStyle, string>> = Object.freeze({
  charger: '»',
  bruiser: '#',
  slinger: '↗',
  burster: '◎',
  pouncer: '^',
  warden: '▣',
  kindler: '+',
});

/**
 * Stable identity for one party member across frames.
 *
 * Entity ids are recycled by the ECS, so anything that compares two frames
 * (level-up notices, command cooldowns) must key off this instead of the eid.
 * Floor 3 never reorders or swaps a filled `PartySlot` — `recruitPartyCompanion`
 * only ever appends the next index — so `slot` plus the species token is a
 * stable, collision-free key for the lifetime of the floor.
 */
export type PartyMemberKey = `${number}:${number}`;

/** Build the stable {@link PartyMemberKey} for a slot/species pair. */
export function partyMemberKey(slot: number, speciesToken: number): PartyMemberKey {
  return `${slot}:${speciesToken}`;
}

/** One rendered party-HUD row (game-design §15 surface 4). */
export interface Floor3PartyRow {
  /** Entity id — valid for the current frame only; never persist it. */
  readonly eid: number;
  /** Stable cross-frame identity (see {@link PartyMemberKey}). */
  readonly key: PartyMemberKey;
  /** Ordered 0-based party slot. */
  readonly slot: number;
  readonly speciesId: string;
  /** Display name of the Companion's CURRENT form (baby/adolescent/adult). */
  readonly formName: string;
  /** 0 baby / 1 adolescent / 2 adult, derived from level (canonical). */
  readonly form: 0 | 1 | 2;
  readonly level: number;
  readonly affinity: Affinity;
  readonly affinityColor: number;
  readonly fightingStyle: FightingStyle;
  readonly styleGlyph: string;
  readonly hpCurrent: number;
  readonly hpMax: number;
  /** `hpCurrent / hpMax` clamped to [0, 1]; 0 when `hpMax <= 0`. */
  readonly hpFraction: number;
  /** True while this Companion is down for the current engagement (spec R5). */
  readonly knockedOut: boolean;
  /** Ability ids this Companion has learned, in milestone order. */
  readonly learnedAbilityIds: readonly string[];
  /** Display name of the highest-milestone ability it can be commanded to use. */
  readonly signatureAbilityName: string;
}

/**
 * Player-facing name for a species' milestone ability.
 *
 * Only the L1 innate and L25 adult signature names are authored today
 * (`species.json` carries opaque `f3.*` ids for the other three milestones),
 * so the remaining milestones fall back to a deterministic
 * `<Form name> · L<level>` label rather than leaking a raw id into the HUD.
 * The authored names for L8/L16/L34 arrive with the ability-content slice.
 */
export function abilityDisplayName(species: PetSpeciesDef, milestoneLevel: number): string {
  if (milestoneLevel <= 1) return species.innateAbilityName;
  if (milestoneLevel === 25) return species.adultSignatureAbilityName;
  const form = formForLevel(species, milestoneLevel);
  return `${form.name} · L${milestoneLevel}`;
}

/**
 * The highest milestone this Companion has already reached — the ability the
 * commander verb (surface 7) fires.
 */
export function signatureMilestoneLevel(level: number): number {
  let milestone: number = ABILITY_MILESTONE_LEVELS[0];
  for (const candidate of ABILITY_MILESTONE_LEVELS) {
    if (level >= candidate) milestone = candidate;
  }
  return milestone;
}

/** Whether the Floor 3 party surfaces are unlocked for the current world. */
export function shouldShowFloor3Party(world: Pick<GameWorld, 'floorId'>): boolean {
  return world.floorId === FLOOR3_FLOOR_ID;
}

/**
 * Every recruited party Companion on `ownerTeam`, ordered by `PartySlot.slot`.
 *
 * ECS query order is an implementation detail, so the result is explicitly
 * sorted (slot first, entity id as a total-order tie-break) to keep row order
 * deterministic across runs and across headless/browser.
 */
export function resolvePartyMemberEids(
  world: GameWorld,
  ownerTeam: number = TeamId.PLAYER,
): readonly number[] {
  return Array.from(query(world.ecs, [Companion, PartySlot, Team]))
    .filter((eid) => (world.stores.team.id[eid] ?? -1) === ownerTeam)
    .sort((a, b) => {
      const slotDelta =
        (world.stores.partySlot.slot[a] ?? 0) - (world.stores.partySlot.slot[b] ?? 0);
      return slotDelta !== 0 ? slotDelta : a - b;
    });
}

/** Resolve one party row, or `undefined` when the species token is unknown. */
export function resolvePartyRow(world: GameWorld, eid: number): Floor3PartyRow | undefined {
  const store = world.stores.companion;
  const speciesToken = store.speciesToken[eid] ?? 0;
  const species = speciesForToken(speciesToken);
  if (species === undefined) return undefined;

  const level = store.level[eid] ?? 1;
  const form = formForLevel(species, level);
  const hpMax = world.stores.health.max[eid] ?? 0;
  const hpCurrent = world.stores.health.current[eid] ?? 0;
  const slot = world.stores.partySlot.slot[eid] ?? 0;

  return {
    eid,
    key: partyMemberKey(slot, speciesToken),
    slot,
    speciesId: species.speciesId,
    formName: form.name,
    form: form.form,
    level,
    affinity: species.affinity,
    affinityColor: AFFINITY_HUD_COLORS[species.affinity],
    fightingStyle: species.fightingStyle,
    styleGlyph: STYLE_HUD_GLYPHS[species.fightingStyle],
    hpCurrent,
    hpMax,
    hpFraction: hpMax > 0 ? Math.max(0, Math.min(1, hpCurrent / hpMax)) : 0,
    knockedOut: (store.knockedOut[eid] ?? 0) === 1,
    learnedAbilityIds: learnedAbilityIds(species, level),
    signatureAbilityName: abilityDisplayName(species, signatureMilestoneLevel(level)),
  };
}

/**
 * Rows for the whole party, in slot order. Returns an empty array off Floor 3
 * so the caller can hide the widget in one branch.
 */
export function resolveFloor3PartyRows(
  world: GameWorld,
  ownerTeam: number = TeamId.PLAYER,
): readonly Floor3PartyRow[] {
  if (!shouldShowFloor3Party(world)) return [];
  const rows: Floor3PartyRow[] = [];
  for (const eid of resolvePartyMemberEids(world, ownerTeam)) {
    const row = resolvePartyRow(world, eid);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** Affinity ring order, re-exported so widgets can render a stable legend. */
export const PARTY_AFFINITY_ORDER: readonly Affinity[] = AFFINITY_RING;

/** Persona summary shown by the party HUD tooltip and the roster screen. */
export function stylePersonaSummary(style: FightingStyle): string {
  const persona = STYLE_PERSONAS[style];
  return `${persona.aiType} · ${persona.rangeProfile} · ${persona.cadence.toFixed(1)}/s`;
}
