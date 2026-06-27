/**
 * Pure resolver for the HUD boss health bar.
 *
 * Split out of HudBossBar so the active-boss selection, percentage, and colour
 * logic can be unit-tested without instantiating Phaser (mirrors the
 * minimap-view-state.ts pattern). No rendering imports live here.
 */
import { entityExists } from 'bitecs';
import type { GameWorld } from '../core/world.js';
import type { Floor1BossEncounterState } from '../shared/floor-types.js';

/** Fill colours keyed to the remaining-health band. */
export const BOSS_BAR_COLORS = {
  /** > 50% health. */
  high: 0x22c55e,
  /** 25%–50% health. */
  mid: 0xf59e0b,
  /** < 25% health. */
  low: 0xef4444,
} as const;

export interface BossHealthBarState {
  /** Display name shown next to the HP readout. */
  displayName: string;
  /** Current HP, clamped at 0 for display. */
  current: number;
  /** Maximum HP, at least 1. */
  max: number;
  /** Fraction of health remaining, in [0, 1]. */
  pct: number;
  /** Fill colour for the current health band. */
  fillColor: number;
}

/**
 * Pick the first started, still-alive boss battle (Map insertion order =
 * priority) and derive its health-bar display state. Returns `null` when no
 * boss bar should be shown — no objective, no started battle, or the boss
 * entity is already gone.
 */
export function resolveBossHealthBar(
  bossBattles: ReadonlyMap<string, Floor1BossEncounterState> | undefined,
  ecs: GameWorld['ecs'],
  health: GameWorld['stores']['health'],
): BossHealthBarState | null {
  if (!bossBattles) {
    return null;
  }

  for (const battle of bossBattles.values()) {
    if (!battle.started || battle.bossEid === null || !entityExists(ecs, battle.bossEid)) {
      continue;
    }

    const current = Math.max(0, health.current[battle.bossEid] ?? 0);
    const max = Math.max(1, health.max[battle.bossEid] ?? 1);
    const pct = Math.max(0, Math.min(1, current / max));
    const fillColor =
      pct > 0.5 ? BOSS_BAR_COLORS.high : pct >= 0.25 ? BOSS_BAR_COLORS.mid : BOSS_BAR_COLORS.low;

    return { displayName: battle.displayName || 'Boss', current, max, pct, fillColor };
  }

  return null;
}
