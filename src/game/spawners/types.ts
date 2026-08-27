/**
 * Data model for the generic Spawner mob-type.
 *
 * A {@link SpawnerArchetype} fully describes one kind of spawner (e.g. a Rats
 * Nest or a Slime Pool): the structure's own stats plus what it spawns in each
 * of its three behaviour modes — passive, defensive (enraged after the player
 * damages it), and an on-death finale wave.
 *
 * Everything here is plain, serialisable data so spawners are authored the same
 * way as loot tables and NPC defs. The `spawnerSystem` reads these defs; nothing
 * here imports rendering or ECS internals.
 */

/** A single spawnable mob blueprint used to populate a spawner's pools. */
export interface MobTemplate {
  /** Stable identifier, e.g. 'rat', 'rat-brute', 'rat-king'. */
  readonly id: string;
  /** Display name for labs/HUD/debug. */
  readonly name: string;
  /** AI behaviour type — one of AI_TYPE.* (CHASE, SWARM, RANGED, LEAPER, GUARDIAN, SUPPORT). */
  readonly aiType: number;
  /** Starting/max hit points. */
  readonly hp: number;
  /** Movement speed (feet per fixed step). */
  readonly speed: number;
  /** Aggro/detection range in feet. */
  readonly aggroRange: number;
  /** Attack range in feet (0 for pure contact attackers). */
  readonly attackRange: number;
  /** Contact damage dealt to the player on touch. */
  readonly contactDamage: number;
  /** Physical weight in lbs (knockback/strength interactions). */
  readonly weight: number;
  /** Blood/ichor colour as packed 0xRRGGBB. */
  readonly bloodColor: number;
  /** Sprite texture id. */
  readonly textureId: number;
  /** Sprite width in feet. */
  readonly spriteWidth: number;
  /** Sprite height in feet. */
  readonly spriteHeight: number;
  /** Optional traversal mode (TRAVERSAL_MODE.*). Defaults to ground. */
  readonly traversalMode?: number;
  /** Optional path persona (PATH_PERSONA.*). */
  readonly persona?: number;
  /** When true, the mob is a flyer. */
  readonly isFlying?: boolean;
}

/** A weighted entry in a spawn pool — higher weight = more likely to be picked. */
export interface SpawnPoolEntry {
  readonly weight: number;
  readonly mob: MobTemplate;
}

/**
 * A timed spawn behaviour. Used for both passive and defensive modes; the
 * defensive variant simply uses a shorter interval, a bigger cap, and/or a
 * harder pool.
 */
export interface SpawnMode {
  /** Milliseconds between spawn pulses. */
  readonly intervalMs: number;
  /** Maximum concurrent living children this spawner sustains in this mode. */
  readonly maxAlive: number;
  /** How many mobs to attempt to spawn per pulse (clamped by maxAlive). */
  readonly perPulse: number;
  /** Weighted pool of mobs this mode can spawn. */
  readonly pool: readonly SpawnPoolEntry[];
}

/** One group of the on-death finale: spawn `count` mobs picked from `pool`. */
export interface DeathSpawnGroup {
  readonly count: number;
  readonly pool: readonly SpawnPoolEntry[];
}

/** A complete spawner definition. */
export interface SpawnerArchetype {
  /** Stable identifier, e.g. 'rats-nest'. */
  readonly id: string;
  /** Display name, e.g. 'Rats Nest'. */
  readonly name: string;
  /** The spawner structure's own hit points. */
  readonly hp: number;
  /** Physical weight in lbs. */
  readonly weight: number;
  /** Blood/ichor colour as packed 0xRRGGBB. */
  readonly bloodColor: number;
  /** Sprite texture id for the structure. */
  readonly textureId: number;
  /** Structure sprite width in feet. */
  readonly spriteWidth: number;
  /** Structure sprite height in feet. */
  readonly spriteHeight: number;
  /** Contact damage the structure deals to the player on touch. */
  readonly contactDamage: number;
  /**
   * Arena radius in feet. The spawner's battle zone is the closed disc of this
   * radius centered on the spawner: entering it triggers the arena
   * (sealed-room lock or open-fence). Minimum 4 ft (spec `Requirements§1`);
   * default 6 ft per registry policy.
   */
  readonly arenaRadiusFt: number;
  /** Slow trickle behaviour before the player engages. */
  readonly passive: SpawnMode;
  /** Enraged behaviour, latched once the player damages the structure. */
  readonly defensive: SpawnMode;
  /** Finale wave(s) emitted when the structure is destroyed. */
  readonly onDeath: readonly DeathSpawnGroup[];
}
