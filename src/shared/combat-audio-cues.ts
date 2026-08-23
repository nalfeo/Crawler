/**
 * combat-audio-cues — pure, deterministic mapping from THREE ALREADY-EXISTING
 * event queues to an audio "cue" decision (kind + intensity, never a sound):
 * `world.combatEvents` (`combat-events.ts`), `world.abilityActivations`
 * (`ability-activation-events.ts`), and — for loot pickups only, where no
 * more authoritative source exists — `world.vfxEvents` (`vfx-events.ts`). No
 * Phaser/WebAudio imports, no `Date.now()`, no `Math.random()` — this module
 * is a plain function of the event fields `damageSystem.ts` /
 * `apply-damage.ts` / `weaponSystem.ts` / `abilitySystem.ts` /
 * `skillSystem.ts` / `itemPickupSystem.ts` already populate every tick, so it
 * needs ZERO new core/game plumbing to cover weapons, spells, abilities,
 * damage taken, and loot pickups (see
 * `docs/knowledge/adr/2026-08-23-combat-loot-audio-cues.md` for the
 * reused-queue rationale and why a brand new `audioEvents` queue was
 * rejected).
 *
 * `world.abilityActivations` — not `vfxEvents`' `abilityActivateFlash` /
 * spell-cast VFX kinds — is the audio source for spells/abilities: it is the
 * one AUTHORITATIVE "a player active/spell ability fired" signal (carries
 * `kind: 'active' | 'spell'`), whereas `abilityActivateFlash` fires for
 * passive activation/re-activation too and the spell-cast VFX kinds
 * (`fireballBlast` etc.) are cosmetic presentation, not a semantic contract
 * (plan review finding — see
 * `docs/knowledge/adr/2026-08-23-combat-loot-audio-cues.md`). Loot pickups
 * have no equivalent
 * authoritative queue, so `pickupSparkle` is used, but ONLY as a single
 * generic "pickup happened" signal — never to infer WHICH item was picked up
 * from its cosmetic tint, since at least two producers
 * (`bossChestPickupSystem.ts`, `harvestSystem.ts`) already pass ad hoc colors
 * outside the small gold/gem/item palette `vfx-events.ts` defines, which
 * would make color-based type inference silently wrong for those callers
 * (plan review finding).
 *
 * Mirrors `reward-audio-cues.ts`'s shape (pure decision layer, consumed by an
 * engine-layer synth glue module) rather than inventing a new pattern.
 */
import type { AbilityActivationEvent } from './ability-activation-events.js';
import type { CombatEvent } from './combat-events.js';
import type { VfxEvent } from './vfx-events.js';

export type CombatAudioCueKind =
  | 'weaponHit'
  | 'weaponCrit'
  | 'weaponMiss'
  | 'damageTaken'
  | 'blocked'
  | 'dodge'
  | 'enemyDeath'
  | 'spellCast'
  | 'spellImpact'
  | 'abilityActivate'
  | 'pickup';

export interface CombatAudioCue {
  readonly kind: CombatAudioCueKind;
  /** 0..1 intensity for this specific cue instance. */
  readonly intensity: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Damage amount (feet-agnostic raw HP) that maps to full (1.0) intensity.
 * Chosen so common early-game hits (5-20 dmg) still read as a solid mid
 * intensity rather than maxing out every cue, while a big crit/AoE hit
 * clearly reads louder. A hit/damage cue is NEVER silent — floors at 0.3,
 * mirroring `reward-audio-cues.ts`'s "never fully silent" reveal cue.
 */
const FULL_INTENSITY_DAMAGE = 40;
const MIN_DAMAGE_CUE_INTENSITY = 0.3;

function intensityForDamage(amount: number): number {
  return clamp01(
    MIN_DAMAGE_CUE_INTENSITY + (1 - MIN_DAMAGE_CUE_INTENSITY) * (amount / FULL_INTENSITY_DAMAGE),
  );
}

/**
 * Decide the audio cue (if any) for a `CombatEvent`. Returns `null` for event
 * types/target combinations with no audio signal in scope (e.g. an enemy
 * dodging, which never happens; a `corpseExplode`, already covered visually
 * by gore VFX and not one of the issue's five requested categories).
 *
 * Non-player hits are classified from the event's own authoritative source
 * metadata, never from `targetType` alone: `fromActiveAbility` (set by
 * `apply-damage.ts` for player active/spell damage — see
 * `progressionEffects.ts`) means the impact came from a spell/active ability,
 * so it gets the distinct `spellImpact` cue instead of a weapon cue. Without
 * that split, spell damage would play weapon SFX on top of the activation's
 * own `spellCast` cue (code review finding).
 */
export function cueForCombatEvent(event: CombatEvent): CombatAudioCue | null {
  switch (event.type) {
    case 'hit':
      if (event.targetType === 'player') {
        return { kind: 'damageTaken', intensity: intensityForDamage(event.amount) };
      }
      if (event.fromActiveAbility === true) {
        return { kind: 'spellImpact', intensity: intensityForDamage(event.amount) };
      }
      return {
        kind: event.isCrit ? 'weaponCrit' : 'weaponHit',
        intensity: intensityForDamage(event.amount),
      };
    case 'death':
      return event.targetType === 'enemy'
        ? { kind: 'enemyDeath', intensity: intensityForDamage(event.overkill ?? event.amount) }
        : null;
    case 'blocked':
      return event.targetType === 'player' ? { kind: 'blocked', intensity: 0.5 } : null;
    case 'dodge':
      return event.targetType === 'player' ? { kind: 'dodge', intensity: 0.4 } : null;
    case 'miss':
      return event.targetType === 'enemy' ? { kind: 'weaponMiss', intensity: 0.3 } : null;
    case 'corpseExplode':
      return null;
    default:
      return null;
  }
}

/**
 * Decide the audio cue (if any) for a `VfxEvent`. The ONLY kind in scope is
 * `pickupSparkle` (loot pickups); every other kind (level-ups, spawner
 * telemetry, spell/ability VFX, weapon-swing arcs, player-trail dust, etc.)
 * is intentionally out of scope for THIS queue — spells/abilities are sourced
 * from the authoritative `world.abilityActivations` instead (see
 * {@link cueForAbilityActivation}), and weapon audio is sourced from
 * `world.combatEvents` (see {@link cueForCombatEvent}), both of which already
 * fire once per real weapon attack (hit OR miss) with no separate "swing"
 * signal needed. Deliberately a SINGLE generic cue regardless of the
 * sparkle's tint — see the module doc comment for why color-based pickup-type
 * inference was rejected.
 */
export function cueForVfxEvent(event: VfxEvent): CombatAudioCue | null {
  return event.kind === 'pickupSparkle' ? { kind: 'pickup', intensity: 0.5 } : null;
}

/**
 * Decide the audio cue for a player active/spell ability firing. Every
 * `AbilityActivationEvent` gets a cue (unlike the queue-drain mappers above,
 * which return `null` for out-of-scope kinds) — this queue is 100%
 * "ability/spell actually fired", so every entry is in scope by construction.
 */
export function cueForAbilityActivation(event: AbilityActivationEvent): CombatAudioCue {
  return { kind: event.kind === 'spell' ? 'spellCast' : 'abilityActivate', intensity: 0.6 };
}
