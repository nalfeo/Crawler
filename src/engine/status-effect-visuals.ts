/**
 * Status-effect presentation policy — pure, Phaser-free, deterministic.
 *
 * Maps the live status effects on ONE entity (`world.statusEffectsByEntity`)
 * onto the single visual treatment that entity should render: a multiply tint
 * for its sprite plus an aura colour for the ground ring drawn by
 * {@link ../StatusEffectVfx.js | StatusEffectVfx}.
 *
 * Lives in `src/engine/` because colour/priority choices are rendering policy,
 * not portable game data — `src/shared/status-effect-types.ts` keeps owning the
 * data types. No Phaser import, so this is unit-testable without a renderer.
 *
 * Polarity (buff vs debuff) is derived from `(stat, op, value)`, never from
 * `stat` alone: a `speed × 1.3` haste and a `speed × 0.4` curse share a stat and
 * must not share a visual.
 */

import type { StatusEffect, StatusEffectStat } from '../shared/status-effect-types.js';

/** Which treatment an entity renders. Debuffs sort before buffs (see PRIORITY). */
export type StatusVisualKind = 'slow' | 'weakened' | 'wither' | 'haste' | 'empowered' | 'regen';

export interface StatusVisual {
  readonly kind: StatusVisualKind;
  /** Multiply tint applied over the entity's identity tint. */
  readonly tint: number;
  /** Ground-ring colour for the persistent aura. */
  readonly auraColor: number;
}

/**
 * Icy blue for slows — the exact tint the speed-status treatment shipped with
 * before this module existed, so generalising the resolver did not restyle the
 * one status that already had a look.
 */
const SLOW_TINT = 0xaadfff;

const STATUS_VISUALS: Readonly<Record<StatusVisualKind, StatusVisual>> = {
  slow: { kind: 'slow', tint: SLOW_TINT, auraColor: 0x7dd3fc },
  weakened: { kind: 'weakened', tint: 0xd8c0ff, auraColor: 0xa855f7 },
  wither: { kind: 'wither', tint: 0xc6e59b, auraColor: 0x84cc16 },
  haste: { kind: 'haste', tint: 0xfff0b8, auraColor: 0xfacc15 },
  empowered: { kind: 'empowered', tint: 0xffc9c9, auraColor: 0xef4444 },
  regen: { kind: 'regen', tint: 0xc7f9cc, auraColor: 0x22c55e },
};

/**
 * Fixed resolution order when an entity carries several effects at once.
 * Debuffs win over buffs: a slowed-and-hasted enemy reads as the threat the
 * player's spell created, and the order is data (not iteration order) so the
 * chosen visual is deterministic regardless of application sequence.
 */
const PRIORITY: readonly StatusVisualKind[] = [
  'slow',
  'weakened',
  'wither',
  'haste',
  'empowered',
  'regen',
];

/**
 * Sign of an effect's influence on its stat: `-1` weakens, `+1` strengthens,
 * `0` is a no-op (`add 0` / `multiply 1`).
 */
function polarity(effect: StatusEffect): number {
  return effect.op === 'add' ? Math.sign(effect.value) : Math.sign(effect.value - 1);
}

const KIND_BY_STAT: Readonly<
  Record<
    StatusEffectStat,
    { readonly weaker: StatusVisualKind; readonly stronger: StatusVisualKind }
  >
> = {
  speed: { weaker: 'slow', stronger: 'haste' },
  attackSpeed: { weaker: 'weakened', stronger: 'empowered' },
  hpRegen: { weaker: 'wither', stronger: 'regen' },
};

function kindFor(effect: StatusEffect): StatusVisualKind | null {
  if (!(effect.remainingMs > 0)) return null;
  // `hpRegen` folds in as `(0 + Σ add) × Π multiply`, so a multiply-only
  // hpRegen effect changes nothing and must not paint a visual.
  if (effect.stat === 'hpRegen' && effect.op !== 'add') return null;
  const sign = polarity(effect);
  if (sign === 0) return null;
  const mapping = KIND_BY_STAT[effect.stat];
  return sign < 0 ? mapping.weaker : mapping.stronger;
}

/**
 * Resolve the single visual treatment for an entity's live effects, or `null`
 * when nothing should be drawn (no effects, all expired, or all no-ops).
 */
export function resolveStatusVisual(effects: readonly StatusEffect[]): StatusVisual | null {
  let bestIndex = -1;
  for (const effect of effects) {
    const kind = kindFor(effect);
    if (kind === null) continue;
    const index = PRIORITY.indexOf(kind);
    if (bestIndex === -1 || index < bestIndex) bestIndex = index;
  }
  if (bestIndex === -1) return null;
  return STATUS_VISUALS[PRIORITY[bestIndex]!];
}

/** True when the entity carries a live effect on its movement speed. */
export function hasActiveSpeedStatus(effects: readonly StatusEffect[]): boolean {
  return effects.some((effect) => effect.stat === 'speed' && effect.remainingMs > 0);
}
