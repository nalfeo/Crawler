/**
 * Data-only floating-text events (non-combat "juice" numbers).
 *
 * Game/core systems push these to `world.floaterEvents`; the engine-layer
 * `CombatVfx` renderer — which already owns floating text — is the sole
 * consumer and drains the queue every rendered frame. Data-only (no Phaser
 * imports) so `src/core` stays portable under the bridge pattern, exactly like
 * `combat-events.ts` and `vfx-events.ts`.
 *
 * Damage numbers still ride on `combatEvents`; this queue exists for signals
 * with no combat event to ride on, such as a skill gaining a level.
 */

export type FloaterEventKind = 'skillLevelUp';

export interface FloaterEvent {
  /** Which presentation preset the renderer should use. */
  kind: FloaterEventKind;
  /** World-space position in FEET (same units as combat events). */
  x: number;
  y: number;
  /** Text to display, authored by the emitting system (e.g. `+1 Swordsmanship`). */
  label: string;
}

/**
 * Max retained floater events. Headless / AI runs have no renderer and never
 * drain the queue, so growth is capped defensively (oldest dropped). The data
 * is cosmetic-only, so dropping events is harmless.
 */
export const FLOATER_EVENT_CAP = 128;

/** Push a floater event, enforcing {@link FLOATER_EVENT_CAP} (drops oldest when full). */
export function pushFloaterEvent(events: FloaterEvent[], event: FloaterEvent): void {
  events.push(event);
  if (events.length > FLOATER_EVENT_CAP) {
    events.splice(0, events.length - FLOATER_EVENT_CAP);
  }
}
