/**
 * Combat events emitted by the damage system for rendering-side VFX.
 * These are data-only — no Phaser imports. Consumed by the engine layer.
 */

export interface CombatEvent {
  type: 'hit' | 'blocked';
  /** Position where the VFX should appear (target position). */
  x: number;
  y: number;
  /** Damage dealt (0 for blocked). */
  amount: number;
  /** What was hit. */
  targetType: 'enemy' | 'player';
  /** World elapsed time when emitted. */
  timestamp: number;
  /** Target entity ID (may be invalid next frame — validate before use). */
  targetEid?: number;
}
