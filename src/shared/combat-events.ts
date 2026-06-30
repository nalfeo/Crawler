/**
 * Combat events emitted by the damage system for rendering-side VFX.
 * These are data-only — no Phaser imports. Consumed by the engine layer.
 */

export interface CombatEvent {
  /**
   * `corpseExplode` is a render-only flourish: a dead enemy struck during its
   * death-linger window bursts into sprite shards instead of absorbing the hit.
   * The core damage path emits it and immediately expires the corpse.
   */
  type: 'hit' | 'blocked' | 'death' | 'miss' | 'dodge' | 'corpseExplode';
  /** Position where the VFX should appear (target position). */
  x: number;
  y: number;
  /** Damage dealt (0 for blocked/dodge). */
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
  /** Blood/ichor colour of the dying entity (0xRRGGBB). Defaults to red when absent. */
  bloodColor?: number;
  /** True when this hit critically struck (player-sourced damage only). */
  isCrit?: boolean;
  /**
   * Sprite variant id of the entity (mirrors the `Sprite.textureId` store) so
   * the renderer can resolve which corpse texture to cut up for a
   * `corpseExplode` event. 1 = rat, 2 = slime, otherwise the generic enemy.
   */
  spriteTextureId?: number;
  /** Stable spawned mob identity used to resolve generated-art families. */
  spriteAppearanceKey?: string;
  /** Spawn-time roll in [0, 1) used to pick a stable generated-art variant. */
  spriteVariantRoll?: number;
  /** Render-only size multiplier chosen at spawn time. */
  spriteSizeScale?: number;
  /** Sprite width in feet, for size-class-specific fallback scaling. */
  spriteWidth?: number;
}
