/**
 * ECS Components — defined using bitecs 0.4.x API.
 *
 * bitecs 0.4 uses an observer-based data model:
 * - Components are plain objects used as keys/tags for the ECS
 * - Data is stored in typed arrays managed by createComponentStores()
 * - Use `addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }))` to add with data
 * - Use `setComponent(world.ecs, eid, Position, { x: 10 })` to update data
 * - Read data via the store: `world.stores.position.x[eid]`
 *
 * IMPORTANT: Stores are per-world. Call createGameWorld() in beforeEach for fresh state.
 */

// --- Component Tags ---
// These are the component identity objects used with addComponent/query/etc.
export const Position = {};
export const Velocity = {};
export const Rotation = {};
export const Health = {};
export const Damage = {};
export const Player = {};
export const Enemy = {};
export const EnemyBehavior = {};
/**
 * Marks an immobile enemy structure that periodically spawns other mobs.
 * Driven by `spawnerSystem`; configuration lives in the SPAWNER_ARCHETYPES
 * registry, indexed by `spawner.defIndex`.
 */
export const Spawner = {};
export const Flying = {};
export const Projectile = {};
/** Marks an entity as an enemy projectile. */
export const EnemyProjectile = {};
export const XpGem = {};
export const DroppedItem = {};
export const Inventory = {};
export const Sprite = {};
export const BroadcastScore = {};
export const Equipment = {};
export const BaseStats = {};
/**
 * Sole runtime stat snapshot: primary points (base 1 + allocated + equipment)
 * plus every derived secondary (armor, damage bonuses, maxHp, accuracy, crit,
 * dodge, cooldown reduction, etc). Recomputed each frame by `statSystem`
 * (core) from BaseStats + CoreStatPoints + equipment + active modifiers — see
 * `core/effective-stats.ts`. There is no separate computed `Stats` component.
 */
export const EffectiveStats = {};
/** Tag: entity has a skill set (player only in v1). */
export const SkillHolder = {};
/**
 * Persisted fail-closed damage-scaling metadata for a delayed damage-bearing
 * entity (projectile, area-damage/explosion, beam, melee swing, trap). Tagged
 * at spawn time (or propagated onto a later explosion/impact entity) so the
 * collision system that eventually calls `applyDamage` doesn't need to
 * re-resolve which weapon/spell created it. See `core/damage-meta.ts`.
 */
export const DamageMeta = {};

// --- Combat/Attack Components ---
/** Links an entity to its owner (e.g., weapon→player, projectile→player). */
export const Owner = {};
/** Assigns a team to prevent friendly fire. */
export const Team = {};
/** Marks an entity for automatic removal after expiry. */
export const Lifetime = {};
/** Area-of-effect damage centered on this entity's position. */
export const AreaDamage = {};
/** Projectile explodes into AoE on impact. */
export const AoeOnImpact = {};
/** Thrown weapon that returns to owner. */
export const Returning = {};
/** Projectile that can bounce off arena bounds before despawning. */
export const Bouncing = {};
/** Continuous beam/line damage from this entity's position. */
export const LineDamage = {};
/** Placed trap that arms and triggers on proximity. */
export const Trap = {};
/** Active melee swing — a blade line that sweeps through an arc. */
export const MeleeSwing = {};
/** Smooth knockback impulse — decays over time. */
export const Knockback = {};
/** Dropped gold entity that awards currency on pickup. */
export const Gold = {};
/** Door entity — tracks open/closed state and tile position. */
export const DoorState = {};
/** Marks a dying entity — delays removal so knockback/death animations can play. */
export const DeathTimer = {};
/** Marks an entity as an NPC — non-hostile and tracked in world.npcs sidecar. */
export const Npc = {};
/** Marks an entity as invincible — applyDamage skips it entirely. */
export const Invincible = {};
/**
 * Plays a spawn-in "pop out + wiggle" animation. Purely cosmetic: spawnAnimSystem
 * counts the timer down and strips the component when it expires, and the engine
 * uses the elapsed progress to drive the pop/wiggle render scale. It grants no
 * invulnerability — baby slimes survive their parent's killing swing via
 * swing-immunity (see markImmuneToActiveMeleeSwings). Effect data lives in the store.
 */
export const SpawnAnim = {};
/** Physical weight of an entity (lbs). Used for knockback, strength interactions, etc. */
export const Weight = {};
/**
 * Marks an entity as immovable by knockback. `knockbackSystem` short-circuits
 * targets carrying this tag: it removes the Knockback component immediately
 * without applying any displacement. Independent of the numeric
 * `IMMOVABLE_THRESHOLD` (see `physics-defs.ts`) — an entity may qualify for
 * short-circuit via *either* rule.
 *
 * Use `Immovable` for entities whose immobility is a design invariant
 * (statues, bosses that must stay in an arena, quest NPCs) even if their
 * weight happens to be below the threshold. See ADR 0044.
 */
export const Immovable = {};
/**
 * Physical body of an entity. Read by collisionSystem (broad + narrow phase),
 * knockbackSystem (footprint passability), and every radius query
 * (areaDamageSystem, beamSystem, meleeSwingSystem, trapSystem, etc.).
 * Independent of Sprite, which is render-only. See ADR 0044 and
 * `src/core/physics-defs.ts` for the canonical per-entity-class values.
 */
export const Size = {};
/**
 * Blood/ichor colour for this entity (0xRRGGBB stored as r, g, b channels).
 * Used by GoreVfx to tint hit splatter and death pools. Defaults to red (0xcc0000).
 */
export const BloodColor = {};
/** Static scene-dressing prop (barrel, torch, junk pile, etc.). */
export const Prop = {};
/** Secondary light source attached to a Prop entity (e.g. wall sconce). */
export const PropLight = {};
/**
 * Marks an entity as a harvestable resource node (mushroom, flower, lichen, etc.).
 * The player must stand within HARVEST_RANGE_FT for durationMs to collect the item.
 * Driven by `harvestSystem`; configuration lives in HARVESTABLE_DEFS, indexed by
 * `harvestable.defIndex`.
 */
export const Harvestable = {};

/**
 * Floor 2 tag: marks a mob as belonging to a specific family (`familyId` is
 * a `ui8` index into `world.floorExtendedState?.familyState?.presentFamilies`). `isBoss=1` marks
 * the single boss per family. Introduced by Floor 2 Slice 1 (ADR 0040 · D1).
 */
export const FamilyMembership = {};

/**
 * Floor 3 tag: marks an allied auto-battler companion.
 *
 * `speciesToken` is an opaque numeric key for the species line (string species
 * ids live in higher-level data registries), `form` is 0/1/2 (baby/adolescent/adult),
 * `level`/`xp` track floor-scoped creature progression, `ownerTeam` mirrors the
 * owning handler/wrangler team id, and `knockedOut` is the in-engagement KO flag.
 */
export const Companion = {};

/**
 * Floor 3 party slot metadata on the player entity.
 *
 * `slot` is the ordered party index (0-based) and `locked` latches once the
 * party reaches its floor cap so recruiting can be gated without mutating
 * existing slots.
 */
export const PartySlot = {};

/**
 * Marks an entity as a physical boss chest world-object. Proximity-opened by
 * `bossChestPickupSystem` when the player walks within BOSS_CHEST_RANGE_FT.
 * The chest's lifecycle record is keyed by `chestId` in `world.bossChests`
 * and the reverse EID lookup lives in `world.bossChestEids`.
 */
export const BossChestEntity = {};

// --- Component Stores ---
// Typed array stores for component data. Accessed directly: world.stores.<name>.<field>[eid]
export const DEFAULT_MAX_ENTITIES = 10_000;

/** Creates fresh typed-array stores for all components. */
export function createComponentStores(maxEntities = DEFAULT_MAX_ENTITIES) {
  return {
    position: { x: new Float32Array(maxEntities), y: new Float32Array(maxEntities) },
    velocity: { x: new Float32Array(maxEntities), y: new Float32Array(maxEntities) },
    rotation: { angle: new Float32Array(maxEntities) },
    health: { current: new Float32Array(maxEntities), max: new Float32Array(maxEntities) },
    damage: {
      amount: new Float32Array(maxEntities),
      cooldownMs: new Float32Array(maxEntities),
      lastFireMs: new Float32Array(maxEntities),
    },
    xpGem: { value: new Float32Array(maxEntities) },
    projectile: {
      pierce: new Uint8Array(maxEntities),
      hitCount: new Uint8Array(maxEntities),
      maxRange: new Float32Array(maxEntities),
      originX: new Float32Array(maxEntities),
      originY: new Float32Array(maxEntities),
    },
    sprite: {
      textureId: new Uint16Array(maxEntities),
      width: new Float32Array(maxEntities),
      height: new Float32Array(maxEntities),
      /**
       * Spawn-time roll in [0, 1). The renderer uses this to pick a stable
       * generated-art variant for this entity without consuming runtime RNG.
       */
      variantRoll: new Float32Array(maxEntities),
      /**
       * Render-only per-entity size multiplier. 0 means "unset" and should be
       * treated as 1 by consumers.
       */
      sizeScale: new Float32Array(maxEntities),
    },
    enemyBehavior: {
      type: new Uint8Array(maxEntities),
      speed: new Float32Array(maxEntities),
      aggroRange: new Float32Array(maxEntities),
      /** Elapsed-ms timestamp when this enemy is allowed to begin chasing. */
      aggroEnableAtMs: new Float32Array(maxEntities),
      attackRange: new Float32Array(maxEntities),
      fireCooldownMs: new Float32Array(maxEntities),
      lastFireMs: new Float32Array(maxEntities),
      persona: new Uint8Array(maxEntities),
      traversalMode: new Uint8Array(maxEntities),
      flankDistance: new Float32Array(maxEntities),
      pathRefreshFrames: new Uint16Array(maxEntities),
      /** Set to 1 when this enemy has been permanently aggroed (e.g. hit by player). */
      aggroedPermanently: new Uint8Array(maxEntities),
      /** Frames since velocity was zero (used to detect stuck enemies). */
      stuckFrames: new Uint16Array(maxEntities),
      /**
       * Per-mob override (ms) for the projectile telegraph delay. `-1`
       * (TELEGRAPH_MS_UNSET, see core/systems/enemyTelegraph.ts) means "no
       * override — use the configured/world default". An explicit `0` is a
       * legitimate override forcing legacy (no-telegraph) behavior for this
       * one mob and is intentionally NOT the sentinel value, since it must be
       * distinguishable from "unset". `.fill(-1)` below is the array-creation
       * default; because `clearEntityStores()` zeroes every typed-array slot
       * on EVERY `createEntity()` call (not just recycled EIDs), the real
       * sentinel guarantee comes from `spawnBehaviorEnemy` explicitly writing
       * this field at every spawn — see src/core/spawners/combatants.ts.
       */
      telegraphMs: new Float32Array(maxEntities).fill(-1),
      /** 1 while this enemy is telegraphing (aim locked, waiting to fire). */
      telegraphActive: new Uint8Array(maxEntities),
      /** world.elapsedMs when the active telegraph began. */
      telegraphStartMs: new Float32Array(maxEntities),
      /** Resolved effective delay (ms) for the active telegraph, captured once at telegraph start. */
      telegraphDelayMs: new Float32Array(maxEntities),
      /** Locked aim unit vector (x), immutable for the whole telegraph window. */
      telegraphDirX: new Float32Array(maxEntities),
      /** Locked aim unit vector (y), immutable for the whole telegraph window. */
      telegraphDirY: new Float32Array(maxEntities),
      /** Locked firing origin (x), captured once at telegraph start; the real fire spawns from here, not live position. */
      telegraphOriginX: new Float32Array(maxEntities),
      /** Locked firing origin (y), captured once at telegraph start; the real fire spawns from here, not live position. */
      telegraphOriginY: new Float32Array(maxEntities),
      /**
       * Render-frame sticky: set to 1 whenever `telegraphActive` transitions
       * to 1 within any simulation step in a batch; cleared by
       * `PhaserBridge.sync()` at the end of each rendered frame. Ensures a
       * telegraph that starts AND completes entirely within a multi-step
       * catch-up batch (e.g. AI-runner lab 16× playback) still renders its
       * cue for at least one frame instead of being silently skipped because
       * `telegraphActive` returned to 0 before the next sync. Default (0) is
       * correct — `clearEntityStores()` zeroes this on every `createEntity()`.
       */
      telegraphWasActiveThisFrame: new Uint8Array(maxEntities),
    },
    spawner: {
      /** Index into the SPAWNER_ARCHETYPES registry (src/game/spawners). */
      defIndex: new Uint16Array(maxEntities),
      /** Spawn mode: 0 = passive, 1 = defensive (enraged after taking damage). */
      mode: new Uint8Array(maxEntities),
      /** Elapsed-ms threshold after which the next spawn pulse is allowed. */
      nextSpawnMs: new Float32Array(maxEntities),
      /** Total children spawned over this spawner's lifetime. */
      spawnedTotal: new Uint16Array(maxEntities),
      /** Set to 1 once the on-death finale wave has been emitted. */
      deathResolved: new Uint8Array(maxEntities),
      /**
       * Battle-arena radius in feet. Minimum 4 ft, defaulted to the archetype's
       * `arenaRadiusFt` at spawn time. Drives the trigger predicate and the
       * fence/sealed-room geometry (see `spawnerArenaSystem`).
       */
      arenaRadiusFt: new Float32Array(maxEntities),
      /**
       * Cached arena topology decision:
       * `0` = sealed-room (lock cached doors on trigger),
       * `1` = open-fence (materialise a circular tile-blocking ring),
       * `255` = unresolved (system decides on first tick when floorMap present).
       */
      arenaKind: new Uint8Array(maxEntities),
      /**
       * Arena lifecycle state:
       * `0` = idle (waiting for trigger),
       * `1` = locked (battle in progress),
       * `2` = resolved (spawner dead + banked XP granted, terminal).
       */
      arenaState: new Uint8Array(maxEntities),
      /**
       * XP banked from up to `SPAWNER_MAX_BANKED_CHILDREN` intercepted child
       * deaths. Awarded as a single XP gem at the arena-end tick — see
       * requirement 5 (spawner drops what the pool would have dropped, capped).
       */
      bankedXp: new Float32Array(maxEntities),
      /**
       * How many spawner-owned child kills have been intercepted so far, capped
       * at `SPAWNER_MAX_BANKED_CHILDREN` (10). Determines when the intercept
       * counter saturates so late-fight kites can't inflate the reward.
       */
      bankedChildren: new Uint16Array(maxEntities),
    },
    broadcastScore: { current: new Float32Array(maxEntities) },
    droppedItem: { itemIndex: new Uint16Array(maxEntities) },
    owner: {
      eid: new Uint16Array(maxEntities),
    },
    team: {
      id: new Uint8Array(maxEntities),
    },
    lifetime: {
      expiresAtMs: new Float32Array(maxEntities),
    },
    areaDamage: {
      radius: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      hitOnce: new Uint8Array(maxEntities),
      arcCenterRad: new Float32Array(maxEntities),
      arcHalfRad: new Float32Array(maxEntities),
    },
    aoeOnImpact: {
      radius: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
    },
    returning: {
      returnSpeed: new Float32Array(maxEntities),
      isReturning: new Uint8Array(maxEntities),
      maxRange: new Float32Array(maxEntities),
      originX: new Float32Array(maxEntities),
      originY: new Float32Array(maxEntities),
    },
    bouncing: {
      remainingBounces: new Uint8Array(maxEntities),
    },
    lineDamage: {
      dirX: new Float32Array(maxEntities),
      dirY: new Float32Array(maxEntities),
      length: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      tickMs: new Float32Array(maxEntities),
      lastTickMs: new Float32Array(maxEntities),
    },
    trap: {
      triggerRadius: new Float32Array(maxEntities),
      explosionRadius: new Float32Array(maxEntities),
      explosionDamage: new Float32Array(maxEntities),
      armAtMs: new Float32Array(maxEntities),
    },
    meleeSwing: {
      bladeLength: new Float32Array(maxEntities),
      arcCenterRad: new Float32Array(maxEntities),
      arcHalfRad: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      spawnAtMs: new Float32Array(maxEntities),
      durationMs: new Float32Array(maxEntities),
      style: new Uint8Array(maxEntities),
      headRadius: new Float32Array(maxEntities),
      shaftDamageMult: new Float32Array(maxEntities),
      knockback: new Float32Array(maxEntities),
      /** Sprite ID hint: see MELEE_SPRITE_ID in weaponSystem.ts. 0|1=sword, 2=bat. */
      spriteId: new Uint8Array(maxEntities),
    },
    knockback: {
      dirX: new Float32Array(maxEntities),
      dirY: new Float32Array(maxEntities),
      remaining: new Float32Array(maxEntities),
      speed: new Float32Array(maxEntities),
    },
    gold: {
      value: new Float32Array(maxEntities),
    },
    doorState: {
      tileX: new Uint16Array(maxEntities),
      tileY: new Uint16Array(maxEntities),
      // Intended-open LATCH: written only by lock/unlock and floor/encounter
      // authorities (doorSystem's lock evaluator, floor objective / boss
      // transitions, spawner arenas) — never by the safe-room seal / reconcile.
      // 0 = should be closed, 1 = should be open.
      logicalOpen: new Uint8Array(maxEntities),
      // Physical/tile truth, DERIVED every frame by doorSystem's reconcile pass:
      // effectiveOpen = logicalOpen && !isLocked && !isForcedClosed. This is what
      // drives the tile flags — a transient safe-room seal closes the TILE via
      // effectiveOpen while leaving the logicalOpen latch intact.
      effectiveOpen: new Uint8Array(maxEntities),
      isLocked: new Uint8Array(maxEntities), // 0 = unlocked, 1 = locked
      wasUnlocked: new Uint8Array(maxEntities), // 0 = never unlocked, 1 = unlocked at least once
    },
    deathTimer: {
      remainingMs: new Float32Array(maxEntities),
    },
    spawnAnim: {
      /** Milliseconds left in the cosmetic spawn-in animation. */
      remainingMs: new Float32Array(maxEntities),
      /** Total duration captured at spawn, for normalised animation progress. */
      totalMs: new Float32Array(maxEntities),
    },
    npc: {
      /** Index into the NPC registry; used to look up NpcDef. Stored as a compact uint16. */
      defIdIndex: new Uint16Array(maxEntities),
    },
    weight: {
      value: new Float32Array(maxEntities),
    },
    size: {
      /** Bounding radius in feet (canonical spatial unit — ADR 0007/0023). */
      radius: new Float32Array(maxEntities),
      /** Optional box override half-width in ft. 0 ⇒ use `radius`. */
      halfWidth: new Float32Array(maxEntities),
      /** Optional box override half-height in ft. 0 ⇒ use `radius`. */
      halfHeight: new Float32Array(maxEntities),
      /** 0 = circle (default), 1 = axis-aligned box using halfWidth/halfHeight. */
      shape: new Uint8Array(maxEntities),
    },
    bloodColor: {
      /** Red channel 0–255. */
      r: new Uint8Array(maxEntities),
      /** Green channel 0–255. */
      g: new Uint8Array(maxEntities),
      /** Blue channel 0–255. */
      b: new Uint8Array(maxEntities),
    },
    harvestable: {
      /** Index into HARVESTABLE_DEFS registry. */
      defIndex: new Uint16Array(maxEntities),
      /** Total harvest duration in milliseconds (mirrors def.durationMs for hot-path access). */
      durationMs: new Float32Array(maxEntities),
      /** Current harvest progress in milliseconds (0 = not started). */
      progressMs: new Float32Array(maxEntities),
      /** EID of the entity currently harvesting this node; 0 = no active harvester. */
      harvesterEid: new Uint16Array(maxEntities),
    },
    baseStats: {
      strength: new Float32Array(maxEntities),
      dexterity: new Float32Array(maxEntities),
      constitution: new Float32Array(maxEntities),
      intelligence: new Float32Array(maxEntities),
      wisdom: new Float32Array(maxEntities),
      charisma: new Float32Array(maxEntities),
      luck: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      damageBonus: new Float32Array(maxEntities),
      damagePercent: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      critChance: new Float32Array(maxEntities),
      critMultiplier: new Float32Array(maxEntities),
      dodgeChance: new Float32Array(maxEntities),
      hpRegen: new Float32Array(maxEntities),
      xpBonus: new Float32Array(maxEntities),
      cooldownReduction: new Float32Array(maxEntities),
      maxHp: new Float32Array(maxEntities),
      accuracy: new Float32Array(maxEntities),
      pickupRange: new Float32Array(maxEntities),
      projectileSpeed: new Float32Array(maxEntities),
      projectileCount: new Float32Array(maxEntities),
    },
    effectiveStats: {
      strength: new Float32Array(maxEntities),
      dexterity: new Float32Array(maxEntities),
      constitution: new Float32Array(maxEntities),
      intelligence: new Float32Array(maxEntities),
      wisdom: new Float32Array(maxEntities),
      charisma: new Float32Array(maxEntities),
      luck: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      damageBonus: new Float32Array(maxEntities),
      damagePercent: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      critChance: new Float32Array(maxEntities),
      critMultiplier: new Float32Array(maxEntities),
      dodgeChance: new Float32Array(maxEntities),
      hpRegen: new Float32Array(maxEntities),
      xpBonus: new Float32Array(maxEntities),
      cooldownReduction: new Float32Array(maxEntities),
      maxHp: new Float32Array(maxEntities),
      accuracy: new Float32Array(maxEntities),
      pickupRange: new Float32Array(maxEntities),
      projectileSpeed: new Float32Array(maxEntities),
      projectileCount: new Float32Array(maxEntities),
    },
    /**
     * Fail-closed damage-scaling metadata for delayed damage-bearing entities.
     * Numeric zero decodes to the fail-closed default in every field: origin=
     * environment, affinity=unscaled, scaleWithPrimary=false, canCrit=false.
     * See `core/damage-meta.ts` for the encode/decode helpers.
     */
    damageMeta: {
      origin: new Uint8Array(maxEntities),
      affinity: new Uint8Array(maxEntities),
      scaleWithPrimary: new Uint8Array(maxEntities),
      canCrit: new Uint8Array(maxEntities),
    },
    /**
     * How many level-up points the player has allocated to each PRIMARY_STAT.
     * `statSystem` reads these and derives EffectiveStats via CORE_STAT_TO_SECONDARY.
     */
    coreStatPoints: {
      strength: new Float32Array(maxEntities),
      dexterity: new Float32Array(maxEntities),
      constitution: new Float32Array(maxEntities),
      intelligence: new Float32Array(maxEntities),
      wisdom: new Float32Array(maxEntities),
      charisma: new Float32Array(maxEntities),
      luck: new Float32Array(maxEntities),
    },
    prop: {
      /** Index into DECORATION_DEF_INDEX for the originating DecorationDef. */
      defIdIndex: new Uint16Array(maxEntities),
      /** 1 if the prop can be destroyed on contact; 0 otherwise. */
      isDestructible: new Uint8Array(maxEntities),
      /** 1 once the prop has been destroyed; 0 while intact. */
      isDestroyed: new Uint8Array(maxEntities),
    },
    propLight: {
      /** Emission radius in render pixels. */
      radiusPx: new Float32Array(maxEntities),
      /** Light intensity 0–1. */
      intensity: new Float32Array(maxEntities),
      /** Red channel 0–255. */
      colorR: new Uint8Array(maxEntities),
      /** Green channel 0–255. */
      colorG: new Uint8Array(maxEntities),
      /** Blue channel 0–255. */
      colorB: new Uint8Array(maxEntities),
    },
    familyMembership: {
      /** Index into `world.floorExtendedState?.familyState?.presentFamilies` (see faction-relations). */
      familyId: new Uint8Array(maxEntities),
      /** 1 for the family boss, 0 for regular members. */
      isBoss: new Uint8Array(maxEntities),
    },
    companion: {
      /** Opaque numeric species key (string species ids stay in higher-level registries). */
      speciesToken: new Uint16Array(maxEntities),
      /** Form tier: 0 baby, 1 adolescent, 2 adult. */
      form: new Uint8Array(maxEntities),
      level: new Uint8Array(maxEntities),
      xp: new Float32Array(maxEntities),
      ownerTeam: new Uint16Array(maxEntities),
      /** 1 when this companion is KO'd for the active engagement. */
      knockedOut: new Uint8Array(maxEntities),
    },
    partySlot: {
      /** Ordered 0-based slot index in the player's floor-scoped party. */
      slot: new Uint8Array(maxEntities),
      /** 1 once party recruitment has locked; 0 while still recruitable. */
      locked: new Uint8Array(maxEntities),
    },
  };
}

export type ComponentStores = ReturnType<typeof createComponentStores>;
