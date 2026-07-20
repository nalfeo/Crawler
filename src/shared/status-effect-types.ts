/**
 * Status-effect / stat-modifier framework — pure spec types.
 *
 * Lives in the leaf `shared` layer so data-driven definition tables (e.g.
 * `equipmentDefs.ts`) can describe the effects they grant without importing
 * `src/core`. All runtime behaviour (applying, expiring, effective-value math)
 * lives in `src/core/status-effects.ts`; these types stay pure data so they are
 * portable and trivially testable.
 *
 * See ADR `docs/knowledge/adr/` (status-effect framework) for the design and the
 * two application MODES (read-site fold-in vs per-tick apply).
 */

/**
 * Which stat a modifier targets. `speed` and `attackSpeed` are folded in at
 * read-sites (movement / weapon-cooldown respectively); `hpRegen` is applied
 * per-tick by the system as a heal-over-time. Extensible to `defense` / `dot`
 * etc. without touching the framework.
 *
 * `attackSpeed` is a multiplicative attack-rate factor (1 = unchanged, 0.75 =
 * attacks 25% slower). `getEffectiveCooldownMs` (weaponSystem) divides the base
 * cooldown by this product so a slow debuff lengthens the cooldown.
 */
export type StatusEffectStat = 'speed' | 'hpRegen' | 'attackSpeed';

/**
 * How a modifier composes with the base value.
 * - `add`: contributes to an additive sum applied before multipliers.
 * - `multiply`: contributes a factor to a product-of-factors (0.8 = 80%).
 */
export type StatusEffectOp = 'add' | 'multiply';

/** Where an effect came from — used (with `sourceId`) for stack identity. */
export type StatusEffectSourceType = 'skill' | 'trap' | 'aura' | 'equipment' | 'ability' | 'debug';

/**
 * How a newly-applied effect interacts with an existing effect of the same
 * stack identity (`sourceType:sourceId:stat:op`).
 * - `replace`: overwrite the existing effect (idempotent re-apply).
 * - `refresh`: keep it, extend to the larger remaining lifetime.
 * - `stack`: append; when over `maxStacks`, drop the oldest matching effect.
 */
export type StackRule =
  | { readonly mode: 'replace' }
  | { readonly mode: 'refresh' }
  | { readonly mode: 'stack'; readonly maxStacks: number };

/**
 * Declarative description of a single modifier. Plain data: no world reference,
 * no timing state (that lives on {@link StatusEffect.remainingMs}).
 */
export interface StatusEffectSpec {
  readonly stat: StatusEffectStat;
  readonly op: StatusEffectOp;
  /** `add`: delta added to the sum. `multiply`: factor in the product (>= 0). */
  readonly value: number;
  /** Lifetime in ms; `null` = persistent (while-equipped / aura, never ticks down). */
  readonly durationMs: number | null;
  readonly sourceType: StatusEffectSourceType;
  /**
   * Runtime source identity. For equipment this is an instance-scoped key
   * (`equipment:<instanceId>`) so duplicate-capable items track independently.
   */
  readonly sourceId: string;
  readonly stackRule: StackRule;
}

/** Inclusive clamp bounds for an effective value. */
export interface StatusEffectClamps {
  readonly min: number;
  readonly max: number;
}

/**
 * A live effect: a spec plus its remaining lifetime. `remainingMs` is
 * `Infinity` for persistent effects (`durationMs === null`).
 */
export interface StatusEffect extends StatusEffectSpec {
  remainingMs: number;
}
