/**
 * Combat events emitted by the damage system for rendering-side VFX.
 * These are data-only — no Phaser imports. Consumed by the engine layer.
 */

export interface CombatEvent {
  /**
   * `corpseExplode` is emitted when a dead enemy is struck (by a weapon or a
   * player footstep) during its death-linger window: instead of soaking the
   * hit it bursts into sprite shards. The event drives the shatter VFX, but the
   * burst is also a real gameplay state change — the core damage path expires
   * the corpse's DeathTimer so it is reaped early, removing the body from the
   * world ahead of schedule (relevant to any system that consumes corpses).
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
  /**
   * Optional Floor 2 family index snapshot captured at death-event emission.
   * Makes objective processing robust even if membership components are removed
   * before the objective tick consumes the event.
   */
  familyIndex?: number;
  /** Optional Floor 2 boss marker snapshot captured at death-event emission. */
  isBoss?: 0 | 1;
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
  /**
   * How a successful hit reached its target. Renderers use this to distinguish
   * authoritative contact strikes from projectile impacts without inferring
   * from proximity or cooldown state.
   */
  delivery?: 'contact' | 'projectile';
  /**
   * Attacker entity id — the mob (or projectile owner) whose action caused this
   * event. Optional and best-effort; consumers must validate before use because
   * the entity may not exist next frame. Consumed by Floor 2 Slice 3's
   * ally-defend logic to identify who a friendly-band mob should retaliate
   * against.
   */
  sourceEid?: number;
  /**
   * Render-generation of `sourceEid` at event creation time.
   * Renderers compare this against `world.entityRenderGeneration[sourceEid]`
   * and skip the reaction if the EID was recycled between event creation and
   * the next render frame.
   */
  sourceRenderGeneration?: number;
  /**
   * Render-generation of `targetEid` at event creation time.
   * Renderers compare this against `world.entityRenderGeneration[targetEid]`
   * and skip the reaction if the EID was recycled between event creation and
   * the next render frame.
   */
  targetRenderGeneration?: number;
  /** Blood/ichor colour of the dying entity (0xRRGGBB). Defaults to red when absent. */
  bloodColor?: number;
  /** True when this hit critically struck (player-sourced damage only). */
  isCrit?: boolean;
  /**
   * True when this damage was dealt by a player active ability (spell, etc.)
   * rather than by a weapon or passive effect. Used for in-run source
   * attribution — lets harnesses separate ability DPS from weapon/passive DPS
   * without running a second RNG-divergent encounter.
   */
  fromActiveAbility?: boolean;
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
