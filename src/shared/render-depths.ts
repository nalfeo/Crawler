/**
 * Render depth constants shared between the Phaser scene and world-space VFX.
 *
 * `MainGameScene.refreshCameraMasks()` partitions every display object onto either
 * the world camera or the screen-space UI camera using a single depth threshold:
 * objects with `depth >= UI_DEPTH_CUTOFF` are treated as UI (pinned to the screen,
 * ignored by the world camera); everything below renders in world space and
 * scrolls/zooms with the world camera.
 *
 * Any world-space VFX (gore splatter, floating combat text, AI debug path overlay)
 * MUST therefore use a depth strictly below `UI_DEPTH_CUTOFF`, or it gets pinned to
 * the screen and renders at the wrong world position. `WORLD_VFX_DEPTH` centralises
 * those values so the dependency is explicit and lives in one place that both
 * `src/engine` and `src/labs` can legally import.
 */

/**
 * Depth at/above which a display object is treated as screen-space UI by
 * `MainGameScene.refreshCameraMasks()`. Keep world-space content strictly below.
 */
export const UI_DEPTH_CUTOFF = 900;

/**
 * Default depth for living entities (player, enemies, NPCs, projectiles).
 * Phaser's built-in default already sits at `0`, but the corpse-depth logic
 * in `PhaserBridge` needs a symbolic constant to restore when a formerly-
 * dead EID is recycled for a living entity — hardcoding `0` there would
 * silently regress if the entity plane ever moves.
 */
export const ENTITY_DEPTH = 0;

/**
 * Depth of the dynamic darkness/light overlay. It must sit ABOVE every
 * world-space gameplay object — terrain, props, entities (mobs/NPCs/player) and
 * VFX/objective markers — so the torch falloff dims sprites in shadow, not just
 * the floor. It stays below boss-spawn telegraph FX (879–881) and the
 * `UI_DEPTH_CUTOFF`, so the HUD and key telegraphs read through the dark.
 */
export const LIGHTING_OVERLAY_DEPTH = 800;

/**
 * Depth buckets for static scene-dressing props. All values are below
 * entity/VFX layers so props always render beneath game entities.
 *
 * - `back`  — floor decorations painted behind everything (e.g. moss patches).
 * - `mid`   — mid-layer props at ground level (barrels, rubble).
 * - `front` — props that overlap ground entities slightly (chains, sconces).
 */
export const PROP_DEPTH = {
  back: 2,
  mid: 3,
  front: 4,
} as const;

/**
 * Terrain (baked floor + wall tiles) renders at this depth — the floor of the
 * world-space stack. Set-piece "background" props (rugs, wall banners, sconces)
 * must sit ABOVE this and BELOW {@link ENTITY_DEPTH} so they dress the terrain
 * without covering the mobs/NPCs standing on it. Mirrors the RenderTexture depth
 * used by `MainGameScene`'s baked terrain layer.
 */
export const TERRAIN_DEPTH = -20;

/**
 * Map a set-piece prop's authored `z` (the `PROP_KIND_Z` ladder: floor=0,
 * wall=10, door=12, fixture=20, furniture=30, decoration=40, actor=50) to a
 * Phaser render depth that deliberately STRADDLES the entity plane so layered
 * scene dressing reads correctly against the mobs/NPCs standing in the room:
 *
 * - `z < 20` → a NEGATIVE "background" band in `(TERRAIN_DEPTH, ENTITY_DEPTH)`,
 *   i.e. above the baked terrain but below entities. This covers the structural/
 *   backdrop kinds — floor (`z=0`), wall (`z=10`) and door (`z=12`): a rug
 *   (`z=0`) lies on the floor under everyone; a wall banner (`z=6`) hangs on the
 *   wall behind the NPC; a bookcase (`z=9`) sits behind the broker who stands in
 *   front of it. The `< 20` cutoff (not `<= 10`) deliberately keeps a door-kind
 *   prop (`z=12`) in this band instead of leaking above the entity plane.
 * - `z >= 20` → a small POSITIVE "foreground" band (≥2), so a welcome desk
 *   (`z=30`) or clutter (`z=40`) reads as being in front of the NPC, occluding
 *   their lower half like real furniture.
 *
 * The function is monotonic non-decreasing across the whole ladder and stays
 * strictly between `TERRAIN_DEPTH` and the low world-VFX foreground band, so
 * per-layer epsilon offsets (added by the stamping pass) never cross a band
 * boundary. Deterministic and pure.
 */
export function setPieceZToDepth(z: number): number {
  if (z < 20) {
    // Background band: structural/backdrop kinds render BEHIND entities —
    // floor (z0), wall (z10) and door (z12). z 0..19 → -19..-3.8 (above
    // terrain -20, below entities 0). The `< 20` cutoff keeps a door-kind prop
    // (z12) in this band instead of leaking above the entity plane.
    return -19 + z * 0.8;
  }
  // Foreground band: fixture 20→2, furniture 30→3, decoration 40→4, actor 50→5
  // (in front of entities, below gore=10).
  return 2 + (z - 20) * 0.1;
}

/**
 * Depths for world-space VFX layers. All values are well below `UI_DEPTH_CUTOFF`
 * so `refreshCameraMasks()` keeps them on the world camera. Relative ordering
 * controls which VFX draws on top (gore < combat text < debug path).
 *
 * Ground-plane VFX (bloodPool, corpse, bloodyFootprint, playerTrail) live in
 * NEGATIVE depths so
 * they render BELOW the default Phaser display depth (0) that living entities
 * inherit. This keeps the player from being buried under blood or corpses.
 * Relative ordering between them (pool < corpse < footprint < trail) is preserved
 * so a corpse still lies on top of the pool it bled into, bloody prints sit on
 * the floor above pooled blood, and walking dust never hides either.
 */
export const WORLD_VFX_DEPTH = {
  /** Persistent blood/ichor pools left on the ground after an enemy dies.
   * Sits below every entity so the player/enemies always draw ON TOP of a
   * pool they stand in, and below `corpse` so a corpse still reads as
   * lying inside the pool it bled into. */
  bloodPool: -18,
  /** A dead enemy's decaying sprite. Sits above the blood pool so the corpse
   * reads as lying IN the pool, and below the default entity depth (0) so
   * the living player never renders under a corpse. */
  corpse: -17,
  /** Persistent bloody footprints/smears tracked by the simulation. */
  bloodyFootprint: -16,
  /** Small dust puffs kicked up behind the player as they move. Sits above
   * the blood pool + corpse + footprints but still below entities so the puff is a
   * ground-plane effect, not something floating in front of the player. */
  playerTrail: -15,
  /** Floor-exit objective marker ring. */
  staircaseMarkerRing: -14,
  /** Generated-art decal stamped above the floor-exit objective marker ring. */
  staircaseMarkerSprite: -13,
  /** Blood/gore splatter particles. */
  gore: 10,
  /** Enemy death "pop" ring + scatter (EffectsVfx). */
  deathPop: 11,
  /** Weapon impact spark / crit burst (EffectsVfx). */
  hitSpark: 12,
  /** Spawner pulse burst when a nest/pool emits children (EffectsVfx). */
  spawnerPulse: 14,
  /**
   * Spawner battle-arena start/end burst — brighter than the trickle pulse
   * so the arena trigger reads immediately (EffectsVfx).
   */
  spawnerArenaBurst: 16,
  /**
   * Persistent fence ring during an open-fence spawner-arena battle. Sits
   * just below the arena burst so a start pulse reads above the ring.
   */
  spawnerArenaFence: 13,
  /** Pickup collect sparkle — gem / gold / item (EffectsVfx). */
  pickupSparkle: 15,
  /** Spell cast VFX (fireball blast, pulse-shield wave, heal glow). Sits above
   * hit sparks so a big blast reads clearly over the individual damage sparks
   * it triggers on the enemies it hits. */
  spellCast: 17,
  /** Level-up celebratory burst (EffectsVfx). */
  levelUpBurst: 18,
  /** Floating damage numbers / MISS / BLOCKED text. */
  combatText: 20,
  /** AI debug flow-field heatmap (labs only); sits beneath the path overlay. */
  debugFlowField: 45,
  /** AI debug path overlay (labs only). */
  debugPath: 50,
} as const;
