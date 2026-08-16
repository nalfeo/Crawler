/**
 * Generic, data-only VFX effect-request events.
 *
 * Core/game systems push these to `world.vfxEvents`; the engine-layer
 * `EffectsVfx` renderer is the sole consumer and drains the queue each frame.
 * These are data-only (no Phaser imports) so `src/core` stays portable under the
 * bridge pattern — exactly like `combat-events.ts`.
 *
 * Combat-derived juice (hit sparks, crit bursts, death pops, player-hurt pulse)
 * is synthesised by `EffectsVfx` directly from `world.combatEvents`, so those
 * kinds do NOT need to be pushed here — they exist in the union purely so the
 * renderer can share one preset switch. Non-combat signals (pickups, level-ups,
 * spell casts) have no combat event to ride on, so they ARE pushed here.
 *
 * Spell-cast kinds (`fireballBlast`, `pulseShieldWave`, `healGlow`) are pushed
 * by `progressionEffects.ts` when an ability actually fires. Damage numbers
 * still ride on the combat-event pipeline; these events add the *cast* visual
 * (explosion, shockwave, restorative glow) so the player sees the spell trigger
 * even when it misses or on a lone target.
 */

export type VfxEffectKind =
  | 'pickupSparkle'
  | 'levelUpBurst'
  | 'spawnerPulse'
  | 'spawnerArenaStart'
  | 'spawnerArenaEnd'
  | 'spawnerArenaFence'
  | 'hitSpark'
  | 'critBurst'
  | 'deathPop'
  | 'playerHurt'
  | 'fireballBlast'
  | 'pulseShieldWave'
  | 'healGlow'
  // Passive became active this tick (including re-activation after prerequisite
  // changes), not a one-time unlock-only signal.
  | 'abilityActivateFlash'
  | 'weaponSwingArc'
  | 'weaponSwingImpact'
  | 'weaponSwingVolley'
  | 'weaponSwingSpin'
  | 'arcaneBoltImpact'
  | 'frostNovaBurst'
  | 'buffAura'
  | 'curseBurst'
  | 'lifeDrainBurst';

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
  /**
   * Optional world-space effect radius in FEET. Used by presets whose visual
   * size is tied to a gameplay range (e.g. a spell blast's actual reach), so
   * the ring visually matches the area of effect regardless of tile size.
   * Kept separate from `intensity` to avoid overloading a unitless multiplier
   * with feet — pass whichever you need, or both.
   */
  radiusFt?: number;
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
