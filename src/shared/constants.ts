/**
 * Game-wide constants.
 *
 * Tunable values are loaded from src/shared/data/tuning.json so labs can
 * save tweaked values back to disk without editing source. Non-tunable
 * structural constants (enums, game dimensions) remain hardcoded.
 */
import tuning from './data/tuning.json';

export const GAME = {
  /** Render canvas width in pixels (rendering layer only). */
  WIDTH: 1280,
  /** Render canvas height in pixels (rendering layer only). */
  HEIGHT: 720,
  TARGET_FPS: 60,
  DELTA_MS: 1000 / 60,
} as const;

/**
 * Camera tuning. The world camera renders at {@link CAMERA.BASE_ZOOM} during
 * normal play. Entering a safe room is a "delight" moment: the camera eases in
 * to {@link CAMERA.SAFE_ROOM_ZOOM_MULTIPLIER}× closer and eases back out on
 * leaving.
 */
export const CAMERA = {
  BASE_ZOOM: 2.0,
  SAFE_ROOM_ZOOM_MULTIPLIER: 1.25,
  /** Duration (ms) of the smooth zoom tween when entering/leaving a safe room. */
  SAFE_ROOM_ZOOM_DURATION_MS: 400,
} as const;

/** Target world-camera zoom given whether the player is inside a safe room. */
export function safeRoomCameraZoom(inSafeRoom: boolean): number {
  return inSafeRoom ? CAMERA.BASE_ZOOM * CAMERA.SAFE_ROOM_ZOOM_MULTIPLIER : CAMERA.BASE_ZOOM;
}

/**
 * Default arena bounds in FEET, used by core systems as a fallback play area
 * when no floor map is loaded. Mirrors the render canvas (1280×720 px) at
 * PIXELS_PER_FOOT = 8 → 160×90 ft.
 */
export const ARENA = {
  WIDTH_FT: 160,
  HEIGHT_FT: 90,
} as const;

export const PLAYER_SPEED: number = tuning.player.speed;

/** Fallback blood colour (red) used when an entity/event carries no explicit bloodColor. */
export const DEFAULT_BLOOD_COLOR = 0xcc0000;

/** Runtime presentation window for a dead enemy before its corpse entity is reaped. */
export const CORPSE = {
  LINGER_MS: 3_000,
} as const;

export const WeaponType = {
  MELEE: 0,
  RANGED: 1,
  MAGIC: 3,
  THROWN: 4,
  BEAM: 5,
  TRAP: 6,
} as const;
export type WeaponTypeValue = (typeof WeaponType)[keyof typeof WeaponType];

export const MeleeStyle = {
  SLASH: 0,
  STAB: 1,
} as const;
export type MeleeStyleValue = (typeof MeleeStyle)[keyof typeof MeleeStyle];

/** Sprite hint IDs stored in the meleeSwing.spriteId ECS field and read by PhaserBridge. */
export const MeleeSpriteId = {
  SWORD: 1,
  BAT: 2,
} as const;

export const TeamId = {
  PLAYER: 0,
  ENEMY: 1,
  NEUTRAL: 2,
} as const;
export type TeamIdValue = (typeof TeamId)[keyof typeof TeamId];

export const WEAPON = {
  PROJECTILE_SPEED: tuning.weapon.projectileSpeed,
  FIRE_RATE_MS: tuning.weapon.fireRateMs,
  BASE_DAMAGE: tuning.weapon.baseDamage,
  MELEE_RANGE: tuning.weapon.meleeRange,
  MELEE_DURATION_MS: tuning.weapon.meleeDurationMs,
  BEAM_LENGTH: tuning.weapon.beamLength,
  BEAM_DURATION_MS: tuning.weapon.beamDurationMs,
  BEAM_TICK_MS: tuning.weapon.beamTickMs,
  TRAP_ARM_MS: tuning.weapon.trapArmMs,
  TRAP_TRIGGER_RADIUS: tuning.weapon.trapTriggerRadius,
  TRAP_EXPLOSION_RADIUS: tuning.weapon.trapExplosionRadius,
  THROWN_RETURN_SPEED: tuning.weapon.thrownReturnSpeed,
  THROWN_MAX_RANGE: tuning.weapon.thrownMaxRange,
  AOE_RADIUS: tuning.weapon.aoeRadius,
} as const;

export const ENEMY_PROJECTILE = {
  SPEED: tuning.enemyProjectile.speed,
  FIRE_COOLDOWN_MS: tuning.enemyProjectile.fireCooldownMs,
  DAMAGE: tuning.enemyProjectile.damage,
  ACCURACY: tuning.enemyProjectile.accuracy,
  /**
   * Default telegraph delay (ms) before a hostile projectile fires, used when
   * neither a per-mob override (`EnemyBehavior.telegraphMs`) nor a world-level
   * override (`world.enemyTelegraphMs`, e.g. the headless `--enemy-telegraph-ms`
   * flag) is set. See `getEffectiveTelegraphMs()` in core/systems/enemyTelegraph.ts.
   */
  TELEGRAPH_MS: tuning.enemyProjectile.telegraphMs,
} as const;

export const FLOOR = {
  MIN_DURATION_S: tuning.floor.minDurationS,
  MAX_DURATION_S: tuning.floor.maxDurationS,
  BOSS_TRIGGER_WARNING_S: tuning.floor.bossWarningS,
} as const;

/**
 * Interaction radius (ft) for the Floor 2 exit-staircase marker, shared by the
 * engine (marker render + proximity check) and the game layer. Floor 2 is not
 * yet fully data-driven, so — unlike Floor 1, which threads
 * `objectives.markerRadiusFt` through `world.floorScenario.objective` — this constant
 * is the engine/game source until the objective-plumbing follow-up lands. It is
 * kept in lockstep with `floor2.manifest.json` `objectives.markerRadiusFt` (8.0)
 * by a unit test (see tests/unit/floor2-scenario-initialization.test.ts) so the
 * two values cannot silently drift apart.
 */
export const FLOOR2_STAIR_MARKER_RADIUS_FT = 8.0;

/** Floor 1 Spell Broker price, in gold. */
export const FLOOR1_SPELL_BROKER_COST: number = tuning.shopPricing.floor1.spellBrokerCost;

/**
 * Price escalation applied to each additional spell on the broker's rack: the
 * n-th cheapest offer costs `spellBrokerCost * multiplier^n`.
 *
 * The broker is Floor 1's deep-pocket sink. One spell is the headline purchase
 * every run aims at; a *second* one is deliberately priced as a luxury so it
 * only lands in a run that both skipped a cheaper purchase and farmed well.
 */
export const FLOOR1_SPELL_BROKER_REPEAT_COST_MULTIPLIER: number =
  tuning.shopPricing.floor1.spellBrokerRepeatCostMultiplier;

/** Maximum spells one run may buy from the Floor 1 broker. */
export const FLOOR1_SPELL_BROKER_MAX_PURCHASES: number =
  tuning.shopPricing.floor1.spellBrokerMaxPurchases;

/** Floor 1 merchant's charm price, in gold. */
export const FLOOR1_MERCHANTS_CHARM_COST: number = tuning.shopPricing.floor1.merchantsCharm;

/**
 * Floor 1 post-quest merchant weapon prices, keyed by item id. Items missing
 * from the table fall back to {@link FLOOR1_POST_QUEST_WEAPON_DEFAULT_COST}.
 */
export const FLOOR1_POST_QUEST_WEAPON_COSTS: Readonly<Record<string, number>> =
  tuning.shopPricing.floor1.postQuestWeaponCosts;

/** Fallback price for a post-quest merchant weapon with no explicit entry. */
export const FLOOR1_POST_QUEST_WEAPON_DEFAULT_COST: number =
  tuning.shopPricing.floor1.postQuestWeaponDefaultCost;

export const SAFE_ROOM = {
  MIN_DURATION_S: tuning.safeRoom.minDurationS,
  OPTIMAL_DURATION_S: tuning.safeRoom.optimalDurationS,
  IMPATIENCE_THRESHOLD_S: tuning.safeRoom.impatienceThresholdS,
} as const;

export const XP = {
  BASE_PER_LEVEL: tuning.xp.basePerLevel,
  SCALING_FACTOR: tuning.xp.scalingFactor,
} as const;
