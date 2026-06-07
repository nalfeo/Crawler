/**
 * Combat events emitted by the damage system for rendering-side VFX.
 * These are data-only — no Phaser imports. Consumed by the engine layer.
 */

export interface CombatEvent {
  type: 'hit' | 'blocked' | 'death';
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
  /** Excess damage beyond 0 HP (death events only). */
  overkill?: number;
  /** Direction of the killing blow — for directional gore (death events only). */
  knockbackDirX?: number;
  knockbackDirY?: number;
  /** Weapon gore factor 0..1 from the weapon that dealt the blow (hit events). */
  weaponGoreFactor?: number;
  /** Source position of the damage (attacker/projectile). Used for directional gore on hits. */
  sourceX?: number;
  sourceY?: number;
}
