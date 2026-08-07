/**
 * Ability-activation announcement events — pushed when a *player* active/spell
 * ability actually fires, and drained by the engine-layer floating-text
 * renderer (`CombatVfx`) which shows the ability name rising above the player,
 * exactly like a damage number.
 *
 * Data-only (no Phaser imports) so `src/core` stays portable under the bridge
 * pattern — same shape as `combat-events.ts`, `vfx-events.ts` and
 * `announcement-events.ts`.
 *
 * These are cosmetic-only: game logic never reads them, and dropping them is
 * harmless. Determinism-safe: events carry `elapsedMs` (from `world.elapsedMs`)
 * so their trigger tick is inspectable in tests without wall-clock time.
 */

/** Category used by the renderer to pick a floater colour. */
export type AbilityActivationCategory = 'combat' | 'defense' | 'utility';

export interface AbilityActivationEvent {
  /** Catalog id of the ability that fired. */
  readonly abilityId: string;
  /** Display label to render, e.g. "Battle Focus". */
  readonly label: string;
  /** Whether the ability is a plain active or a spell (renderer emphasis). */
  readonly kind: 'active' | 'spell';
  /** Presentation category; renderer maps this to a colour. */
  readonly category: AbilityActivationCategory;
  /** Entity that activated the ability (always the player today). */
  readonly holderEid: number;
  /** World-space position in FEET at activation time. */
  readonly x: number;
  readonly y: number;
  /** Simulation timestamp at which the event was pushed (`world.elapsedMs`). */
  readonly elapsedMs: number;
}

/**
 * Hard cap on `world.abilityActivations`. The renderer drains every frame, but
 * headless / lab runs have no consumer, so growth is capped defensively
 * (oldest dropped).
 */
const ABILITY_ACTIVATION_EVENT_CAP = 32;

/** Push an activation event, enforcing {@link ABILITY_ACTIVATION_EVENT_CAP}. */
export function pushAbilityActivationEvent(
  events: AbilityActivationEvent[],
  event: AbilityActivationEvent,
): void {
  events.push(event);
  if (events.length > ABILITY_ACTIVATION_EVENT_CAP) {
    events.splice(0, events.length - ABILITY_ACTIVATION_EVENT_CAP);
  }
}
