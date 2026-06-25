/**
 * corpse-decay — pure visual decay curves for dead-enemy corpses.
 *
 * Drives the death-linger presentation in {@link ./PhaserBridge}:
 *
 * - The **skull marker** is a short "soul leaving" beat — it fades out and
 *   floats upward within roughly a second of death, independent of how long the
 *   corpse lingers.
 * - The **corpse sprite** is the slow beat — it drains toward grey (via a
 *   multiply tint) and fades to nothing across the whole linger window before
 *   the entity is removed.
 *
 * Kept Phaser-free so the curves can be unit-tested in isolation. The renderer
 * owns the actual `setTint`/`setAlpha`/`setPosition` calls; this module only
 * decides the numbers.
 *
 * Why a multiply tint instead of a true greyscale shader? Phaser 4's per-object
 * `Filters` (the only real desaturation path) render each object to its own
 * framebuffer and are WebGL-only. A bullet-heaven can have dozens of corpses
 * lingering at once, so a per-corpse filter pass is too costly. A vertex-tint is
 * free, works on both the WebGL and Canvas renderers, and combined with the
 * fade-out reads as the body draining of colour.
 */

/** Skull marker alpha at the instant of death (it fades from here to 0). */
export const SKULL_BASE_ALPHA = 0.95;

/**
 * How long the skull marker takes to fade out and float away after death, in
 * milliseconds. Deliberately much shorter than the corpse linger so the skull
 * is a brief flourish rather than a persistent tombstone. Capped to the linger
 * duration so it always completes before the corpse is removed.
 */
export const SKULL_FADE_MS = 900;

/** How far (px) the skull drifts upward over its fade. */
export const SKULL_RISE_PX = 16;

/**
 * Fraction of the linger over which the corpse fully desaturates. At
 * `0.5` the corpse reaches full grey once half of the linger has elapsed,
 * leaving the back half to simply fade out.
 */
export const GREY_RAMP_FRACTION = 0.5;

/**
 * Remaining-life fraction at/above which the corpse is fully opaque. Below it
 * the corpse fades out, reaching alpha 0 exactly as the timer expires. At `0.5`
 * the corpse holds full opacity for the first half of the linger, then fades
 * over the second half.
 */
export const FADE_OUT_FRACTION = 0.5;

/** Neutral grey the corpse multiply-tint lerps toward (0xRRGGBB). */
export const CORPSE_GREY = 0x9a9aa0;

/** A sprite with no tint (Phaser's identity multiply colour). */
const NO_TINT = 0xffffff;

export interface CorpseDecay {
  /** Alpha for the floating skull marker (1 = opaque, 0 = gone). */
  skullAlpha: number;
  /** Upward offset (px) for the skull marker as it floats away. */
  skullRisePx: number;
  /** Alpha for the corpse sprite (1 = opaque, 0 = gone). */
  corpseAlpha: number;
  /** Desaturation amount: 0 = full colour, 1 = fully drained to grey. */
  desaturation: number;
  /** Packed 0xRRGGBB multiply tint to apply to the corpse sprite. */
  tint: number;
}

function clamp01(value: number): number {
  if (value < 0 || Number.isNaN(value)) return 0;
  if (value > 1) return 1;
  return value;
}

function lerpChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

/**
 * Lerp a sprite multiply-tint from {@link NO_TINT} (full colour) toward
 * {@link CORPSE_GREY} by `desaturation` (0..1).
 */
export function corpseTint(desaturation: number): number {
  const t = clamp01(desaturation);
  if (t <= 0) return NO_TINT;
  const r = lerpChannel((NO_TINT >> 16) & 0xff, (CORPSE_GREY >> 16) & 0xff, t);
  const g = lerpChannel((NO_TINT >> 8) & 0xff, (CORPSE_GREY >> 8) & 0xff, t);
  const b = lerpChannel(NO_TINT & 0xff, CORPSE_GREY & 0xff, t);
  return (r << 16) | (g << 8) | b;
}

/**
 * Compute the per-frame corpse + skull decay state for a dying enemy.
 *
 * @param remainingMs Death-timer remaining for the entity (counts down to 0).
 * @param totalMs     Linger duration the entity started its death timer with.
 *                    Values `<= 0` are treated as a fully-elapsed corpse.
 */
export function computeCorpseDecay(remainingMs: number, totalMs: number): CorpseDecay {
  const hasLinger = totalMs > 0;
  // life: 1 at the moment of death, 0 the instant before removal.
  const life = clamp01(hasLinger ? remainingMs / totalMs : 0);
  const elapsedMs = hasLinger ? Math.max(0, totalMs - remainingMs) : SKULL_FADE_MS;

  // Skull: short fade + float, anchored to absolute elapsed time, but never
  // outlasting the corpse on unusually short lingers.
  const skullFadeMs = hasLinger ? Math.min(SKULL_FADE_MS, totalMs) : SKULL_FADE_MS;
  const skullProgress = clamp01(elapsedMs / skullFadeMs);

  // Corpse: desaturate over the front portion, fade over the back portion.
  const corpseElapsed = 1 - life;
  const desaturation = clamp01(corpseElapsed / GREY_RAMP_FRACTION);

  return {
    skullAlpha: SKULL_BASE_ALPHA * (1 - skullProgress),
    skullRisePx: SKULL_RISE_PX * skullProgress,
    corpseAlpha: clamp01(life / FADE_OUT_FRACTION),
    desaturation,
    tint: corpseTint(desaturation),
  };
}
