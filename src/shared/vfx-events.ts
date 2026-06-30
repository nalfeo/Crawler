/**
 * Generic, data-only VFX effect-request events.
 *
 * Core/game systems push these to `world.vfxEvents`; the engine-layer
 * `EffectsVfx` renderer is the sole consumer and drains the queue each frame.
 * These are data-only (no Phaser imports) so `src/core` stays portable under the
 * bridge pattern — exactly like `combat-events.ts`.
 *
 * Combat-derived juice (hit sparks, crit bursts, death pops, player-hurt flash)
 * is synthesised by `EffectsVfx` directly from `world.combatEvents`, so those
 * kinds do NOT need to be pushed here — they exist in the union purely so the
 * renderer can share one preset switch. Non-combat signals (pickups, level-ups)
 * have no combat event to ride on, so they ARE pushed here.
 */

export type VfxEffectKind =
  | 'pickupSparkle'
  | 'levelUpBurst'
  | 'spawnerPulse'
  | 'hitSpark'
  | 'critBurst'
  | 'deathPop'
  | 'playerHurt';

export interface VfxEvent {
  /** Which preset the renderer should spawn. */
  kind: VfxEffectKind;
  /** World-space position for the effect. */
  x: number;
  y: number;
  /** Optional tint hint (0xRRGGBB). Renderer falls back to a per-kind default. */
  color?: number;
  /** Optional intensity multiplier (scales particle count / size). Default 1. */
  intensity?: number;
}

/** Pickup categories that emit a collect sparkle. */
export type PickupKind = 'gem' | 'gold' | 'item';

/** Default sparkle tint per pickup kind. */
export const PICKUP_SPARKLE_COLORS: Record<PickupKind, number> = {
  gem: 0x44ddff,
  gold: 0xffd166,
  item: 0xffffff,
};

/**
 * Max retained VFX events. The renderer drains this queue every frame, but
 * headless / AI runs have no renderer, so growth is capped defensively (oldest
 * dropped). The data is cosmetic-only, so dropping events is harmless.
 */
export const VFX_EVENT_CAP = 512;

/** Push a VFX event, enforcing {@link VFX_EVENT_CAP} (drops oldest when full). */
export function pushVfxEvent(events: VfxEvent[], event: VfxEvent): void {
  events.push(event);
  if (events.length > VFX_EVENT_CAP) {
    events.splice(0, events.length - VFX_EVENT_CAP);
  }
}
