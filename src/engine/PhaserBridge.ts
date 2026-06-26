import { hasComponent, query } from 'bitecs';
import type Phaser from 'phaser';
import {
  AoeOnImpact,
  AreaDamage,
  DeathTimer,
  Enemy,
  EnemyProjectile,
  LineDamage,
  MeleeSwing,
  Npc,
  Player,
  Position,
  Projectile,
  Returning,
  Rotation,
  SpawnAnim,
  Sprite,
  Team,
  Trap,
  XpGem,
} from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getSprite } from './sprites/index.js';
import { createCombatVfx } from './CombatVfx.js';
import { createGoreVfx } from './GoreVfx.js';
import { createEffectsVfx } from './EffectsVfx.js';
import { computeCorpseDecay, type CorpseDecay } from './corpse-decay.js';
import { createLogger } from '../shared/logger.js';
import { TeamId, MeleeSpriteId } from '../shared/constants.js';
import { DEFAULT_HANDHELD_SPRITE_ANCHOR } from '../shared/sprite-anchor.js';
import { computeSpawnPopScale, spawnAnimProgress } from '../shared/spawn-anim.js';

// --- Texture keys ---
const TEX_PLAYER = '__cw_player';
const TEX_ENEMY = '__cw_enemy';
const TEX_NPC = '__cw_npc';
const TEX_ENEMY_RAT = '__cw_enemy_rat';
const TEX_ENEMY_SLIME = '__cw_enemy_slime';
const TEX_ENEMY_BOSS = '__cw_enemy_boss';
const TEX_GEM = '__cw_gem';
const TEX_BULLET = '__cw_bullet';
const TEX_ENEMY_BULLET = '__cw_enemy_bullet';
const TEX_AOE_PROJ = '__cw_aoe_proj';
const TEX_ENEMY_AOE_PROJ = '__cw_enemy_aoe_proj';
const TEX_RETURNING = '__cw_returning';
const TEX_MELEE = '__cw_melee';
const TEX_TRAP_ARMED = '__cw_trap_armed';
const TEX_TRAP_ARMING = '__cw_trap_arming';
const TEX_EXPLOSION = '__cw_explosion';
const TEX_ENEMY_EXPLOSION = '__cw_enemy_explosion';
const TEX_DEAD_SKULL = '__cw_dead_skull';
const TEX_WELCOME_SIGN = '__cw_welcome_sign';
const SPRITE_TEX_WELCOME_SIGN = 3;
const DEAD_SKULL_Y_OFFSET = 18;
const logger = createLogger('engine:phaser-bridge');

function generateTextures(scene: Phaser.Scene): void {
  // Skip texture generation when running in test mocks without a texture manager
  if (!scene.textures || !scene.add.graphics) {
    logger.debug('Skipping procedural texture generation; texture manager unavailable');
    return;
  }
  if (scene.textures.exists(TEX_PLAYER)) return;

  const g = scene.add.graphics();

  // Player — green diamond
  g.clear();
  g.fillStyle(0x00ff66, 1);
  g.fillTriangle(12, 0, 0, 12, 12, 24);
  g.fillTriangle(12, 0, 24, 12, 12, 24);
  g.lineStyle(2, 0x88ffaa, 0.6);
  g.strokeCircle(12, 12, 13);
  g.generateTexture(TEX_PLAYER, 26, 26);

  // Enemy — red circle with dark core
  g.clear();
  g.fillStyle(0xff2222, 1);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0x880000, 0.5);
  g.fillCircle(10, 10, 5);
  g.generateTexture(TEX_ENEMY, 22, 22);

  // NPC (placeholder) — simple stick-figure silhouette.
  g.clear();
  g.lineStyle(2, 0xf1f5f9, 1);
  g.strokeCircle(8, 5, 3);
  g.beginPath();
  g.moveTo(8, 8);
  g.lineTo(8, 15);
  g.moveTo(3, 11);
  g.lineTo(13, 11);
  g.moveTo(8, 15);
  g.lineTo(4, 20);
  g.moveTo(8, 15);
  g.lineTo(12, 20);
  g.strokePath();
  g.generateTexture(TEX_NPC, 16, 22);

  // Rat — gray body with darker head/tail hint
  g.clear();
  g.fillStyle(0x8f959e, 1);
  g.fillEllipse(11, 12, 18, 12);
  g.fillStyle(0xb7bcc4, 1);
  g.fillCircle(6, 9, 4);
  g.lineStyle(2, 0x6f7782, 1);
  g.beginPath();
  g.moveTo(18, 13);
  g.lineTo(22, 15);
  g.strokePath();
  g.generateTexture(TEX_ENEMY_RAT, 24, 22);

  // Slime — green blob with glossy top and dark core
  g.clear();
  g.fillStyle(0x2cb34a, 1);
  g.fillCircle(11, 11, 10);
  g.fillStyle(0x5eea81, 0.85);
  g.fillCircle(8, 7, 4);
  g.fillStyle(0x157a2f, 0.5);
  g.fillCircle(11, 13, 5);
  g.generateTexture(TEX_ENEMY_SLIME, 22, 22);

  // Boss — rat/slime hybrid, large and unmistakable.
  g.clear();
  g.fillStyle(0x1d4ed8, 0.18);
  g.fillEllipse(22, 22, 40, 34);
  g.fillStyle(0x22c55e, 1);
  g.fillEllipse(24, 24, 24, 18);
  g.fillStyle(0x8f959e, 1);
  g.fillCircle(14, 16, 7);
  g.fillCircle(34, 16, 7);
  g.fillStyle(0x2cb34a, 0.9);
  g.fillEllipse(26, 28, 30, 24);
  g.fillStyle(0xb7bcc4, 1);
  g.fillTriangle(10, 13, 14, 5, 18, 14);
  g.fillTriangle(30, 14, 34, 5, 38, 13);
  g.fillStyle(0x157a2f, 0.75);
  g.fillCircle(24, 26, 7);
  g.fillStyle(0x0f4c1d, 0.75);
  g.fillTriangle(30, 28, 40, 34, 34, 37);
  g.lineStyle(3, 0x6f7782, 1);
  g.beginPath();
  g.moveTo(16, 35);
  g.lineTo(10, 39);
  g.moveTo(36, 34);
  g.lineTo(44, 39);
  g.strokePath();
  g.fillStyle(0xf8fafc, 1);
  g.fillCircle(20, 23, 2);
  g.fillCircle(29, 23, 2);
  g.fillStyle(0x0b1020, 1);
  g.fillCircle(20, 23, 1);
  g.fillCircle(29, 23, 1);
  g.generateTexture(TEX_ENEMY_BOSS, 44, 40);

  // XP gem — faceted cyan crystal with dark outline + sparkle
  g.clear();
  g.fillStyle(0x0b3038, 1);
  g.fillTriangle(7, 0, 0, 7, 7, 14);
  g.fillTriangle(7, 0, 14, 7, 7, 14);
  g.fillStyle(0x1f9fb8, 1);
  g.fillTriangle(7, 2, 2, 7, 7, 12);
  g.fillTriangle(7, 2, 12, 7, 7, 12);
  g.fillStyle(0x4fd6e8, 1);
  g.fillTriangle(7, 2, 2, 7, 7, 7);
  g.fillStyle(0x9af0ff, 1);
  g.fillRect(5, 3, 2, 2);
  g.generateTexture(TEX_GEM, 14, 14);

  // Player bullet — white elongated pill
  g.clear();
  g.fillStyle(0xffffff, 1);
  g.fillRoundedRect(0, 0, 4, 10, 2);
  g.generateTexture(TEX_BULLET, 4, 10);

  // Enemy bullet — orange pill
  g.clear();
  g.fillStyle(0xff8800, 1);
  g.fillRoundedRect(0, 0, 4, 10, 2);
  g.generateTexture(TEX_ENEMY_BULLET, 4, 10);

  // AoE projectile (fireball) — orange-red glow
  g.clear();
  g.fillStyle(0xff4400, 0.4);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0xff6600, 1);
  g.fillCircle(10, 10, 5);
  g.fillStyle(0xffcc00, 0.8);
  g.fillCircle(10, 10, 3);
  g.generateTexture(TEX_AOE_PROJ, 22, 22);

  // Enemy AoE projectile (acid ball) — green glow
  g.clear();
  g.fillStyle(0x10b981, 0.4);
  g.fillCircle(10, 10, 10);
  g.fillStyle(0x22c55e, 1);
  g.fillCircle(10, 10, 5);
  g.fillStyle(0xbbf7d0, 0.8);
  g.fillCircle(10, 10, 3);
  g.generateTexture(TEX_ENEMY_AOE_PROJ, 22, 22);

  // Returning weapon — cyan spinning square shape
  g.clear();
  g.fillStyle(0x44ddff, 1);
  g.fillTriangle(8, 0, 16, 8, 8, 16);
  g.fillTriangle(8, 0, 0, 8, 8, 16);
  g.generateTexture(TEX_RETURNING, 18, 18);

  // Melee AoE — semi-transparent white arc ring
  g.clear();
  g.fillStyle(0xffffaa, 0.25);
  g.fillCircle(32, 32, 32);
  g.lineStyle(2, 0xffffaa, 0.6);
  g.strokeCircle(32, 32, 32);
  g.generateTexture(TEX_MELEE, 66, 66);

  // Trap (arming) — dim red square with border
  g.clear();
  g.fillStyle(0xff0000, 0.25);
  g.fillRect(0, 0, 14, 14);
  g.lineStyle(2, 0xff0000, 0.6);
  g.strokeRect(1, 1, 12, 12);
  g.generateTexture(TEX_TRAP_ARMING, 14, 14);

  // Trap (armed) — bright red square
  g.clear();
  g.fillStyle(0xff0000, 0.5);
  g.fillRect(0, 0, 14, 14);
  g.lineStyle(2, 0xff4444, 1.0);
  g.strokeRect(1, 1, 12, 12);
  g.fillStyle(0xff6666, 0.8);
  g.fillCircle(7, 7, 3);
  g.generateTexture(TEX_TRAP_ARMED, 14, 14);

  // Explosion ring — orange-red filled circle
  g.clear();
  g.fillStyle(0xff4400, 0.3);
  g.fillCircle(32, 32, 32);
  g.lineStyle(3, 0xff6600, 0.7);
  g.strokeCircle(32, 32, 32);
  g.fillStyle(0xffaa00, 0.2);
  g.fillCircle(32, 32, 20);
  g.generateTexture(TEX_EXPLOSION, 66, 66);

  // Enemy acid explosion — green splash
  g.clear();
  g.fillStyle(0x22c55e, 0.32);
  g.fillCircle(32, 32, 32);
  g.lineStyle(3, 0x16a34a, 0.72);
  g.strokeCircle(32, 32, 32);
  g.fillStyle(0xbbf7d0, 0.24);
  g.fillCircle(32, 32, 20);
  g.generateTexture(TEX_ENEMY_EXPLOSION, 66, 66);

  // Dead marker — simple skull icon for corpse linger window
  g.clear();
  g.fillStyle(0xf8fafc, 0.95);
  g.fillCircle(8, 7, 5);
  g.fillRect(4, 9, 8, 5);
  g.fillRect(6, 14, 1, 2);
  g.fillRect(8, 14, 1, 2);
  g.fillRect(10, 14, 1, 2);
  g.fillStyle(0x0b1020, 1);
  g.fillCircle(6, 6, 1);
  g.fillCircle(10, 6, 1);
  g.fillRect(7, 9, 2, 1);
  g.generateTexture(TEX_DEAD_SKULL, 16, 16);

  // Welcome sign — wooden board with painted white arrow (pointing right)
  g.clear();
  g.fillStyle(0x8b5a2b, 1);
  g.fillRect(0, 0, 32, 16);
  g.lineStyle(2, 0x5c3a21, 1);
  g.strokeRect(1, 1, 30, 14);
  g.lineStyle(3, 0xffffff, 0.9);
  g.beginPath();
  g.moveTo(6, 8);
  g.lineTo(26, 8);
  g.moveTo(20, 3);
  g.lineTo(26, 8);
  g.lineTo(20, 13);
  g.strokePath();
  g.generateTexture(TEX_WELCOME_SIGN, 32, 16);

  g.destroy();
  logger.info('Generated procedural fallback textures');
}

interface EntityVisual {
  obj: Phaser.GameObjects.Image;
  type: string;
  /** Base scale to restore in the default per-frame branch. */
  baseScale: number;
  /**
   * Death-timer duration captured the first frame this corpse is seen dead.
   * Used to normalise the corpse fade/desaturation curve. Undefined while alive.
   */
  deathTotalMs?: number;
}

function getEntityType(world: GameWorld, eid: number): string {
  if (hasComponent(world.ecs, eid, Player)) return 'player';
  if (hasComponent(world.ecs, eid, Npc)) return 'npc';
  if (hasComponent(world.ecs, eid, Enemy)) return 'enemy';
  if (hasComponent(world.ecs, eid, XpGem)) return 'gem';
  if (hasComponent(world.ecs, eid, LineDamage)) return 'beam';
  if (hasComponent(world.ecs, eid, MeleeSwing)) return 'melee_swing';
  if (hasComponent(world.ecs, eid, Trap)) return 'trap';
  if (hasComponent(world.ecs, eid, AreaDamage)) {
    if (hasComponent(world.ecs, eid, Team) && world.stores.team.id[eid] === TeamId.ENEMY) {
      return 'enemy_aoe';
    }
    return 'aoe';
  }
  if (hasComponent(world.ecs, eid, Returning)) return 'returning';
  if (hasComponent(world.ecs, eid, AoeOnImpact)) {
    if (hasComponent(world.ecs, eid, EnemyProjectile)) {
      return 'enemy_aoe_proj';
    }
    return 'aoe_proj';
  }
  if (hasComponent(world.ecs, eid, EnemyProjectile)) return 'enemy_proj';
  if (hasComponent(world.ecs, eid, Projectile)) return 'proj';
  if (
    hasComponent(world.ecs, eid, Sprite) &&
    world.stores.sprite.textureId[eid] === SPRITE_TEX_WELCOME_SIGN
  )
    return 'welcome_sign';
  return 'default';
}

/**
 * Mapping from entity type to a logical sprite ID in the registry.
 * Types that omit a mapping always render with the procedural
 * __cw_* texture. Types whose mapping resolves but whose sheet
 * failed to load also fall back to the procedural texture, so the
 * renderer is robust to missing sprite packs.
 */
const ENTITY_KENNEY_SPRITE: Readonly<Record<string, string>> = {
  player: 'player',
  enemy: 'enemy.orc',
  enemy_rat: 'enemy.rat',
  enemy_slime: 'enemy.slime',
  enemy_boss: 'enemy.boss',
  npc: 'npc.guide',
  gem: 'item.gem',
  proj: 'weapon.arrow',
  enemy_proj: 'effect.enemy_proj',
  aoe_proj: 'effect.aoe',
  enemy_aoe_proj: 'effect.enemy_aoe',
  returning: 'weapon.returning',
  melee: 'effect.melee',
  trap_arming: 'effect.trap_arming',
  trap_armed: 'effect.trap_armed',
  explosion: 'effect.explosion',
  enemy_explosion: 'effect.enemy_explosion',
  dead_skull: 'effect.dead',
};

/**
 * Per-Kenney-sprite render scale, applied when the bridge picks a
 * Kenney sprite for an entity type. 16x16 source pixels are scaled up
 * so the sprite reads at roughly the same on-screen size as the
 * procedural texture it replaces.
 */
const KENNEY_SCALE: Readonly<Record<string, number>> = {
  player: 1.6, // procedural player texture is 26x26
  enemy: 1.4, // procedural enemy texture is 22x22
  enemy_rat: 1.4,
  enemy_slime: 1.4,
  enemy_boss: 2.5, // boss is larger
  npc: 1.4,
  gem: 1.0,
  proj: 1.0,
  enemy_proj: 1.0,
  aoe_proj: 1.4,
  enemy_aoe_proj: 1.4,
  returning: 1.2,
  melee: 4.0,
  trap_arming: 1.0,
  trap_armed: 1.0,
  explosion: 4.0,
  enemy_explosion: 4.0,
  dead_skull: 1.0,
};

/**
 * Logical sprite width (px) of a full-grown slime. Baby slimes spawned by a
 * split carry a smaller `Sprite.width`, and we render them proportionally
 * smaller than this reference. Keep in sync with the `slime` archetype
 * `spriteWidth` in `src/shared/data/enemies.floor1.json`.
 */
const SLIME_FULL_SPRITE_WIDTH = 24;

interface ResolvedTexture {
  key: string;
  /** Frame index when `key` references a spritesheet. */
  frame?: number;
  /** Base render scale for this texture. */
  scale: number;
  /** True when the engine fell back to a procedural __cw_* texture. */
  fallback: boolean;
}

/**
 * Resolve the texture (and frame) to use for the given entity type.
 * Prefers a Kenney sprite when both the registry mapping and the
 * loaded texture exist; otherwise falls back to the procedural
 * `__cw_*` texture.
 */
function resolveTexture(scene: Phaser.Scene, type: string): ResolvedTexture {
  const spriteId = ENTITY_KENNEY_SPRITE[type];
  if (spriteId !== undefined) {
    const sprite = getSprite(spriteId);
    if (sprite !== undefined && scene.textures?.exists(sprite.sheetKey)) {
      return {
        key: sprite.sheetKey,
        frame: sprite.frame,
        scale: KENNEY_SCALE[type] ?? 1,
        fallback: false,
      };
    }
  }
  return { key: getProceduralTextureForType(type), scale: 1, fallback: true };
}

function getProceduralTextureForType(type: string): string {
  switch (type) {
    case 'player':
      return TEX_PLAYER;
    case 'enemy':
      return TEX_ENEMY;
    case 'npc':
      return TEX_NPC;
    case 'enemy_boss':
      return TEX_ENEMY_BOSS;
    case 'enemy_rat':
      return TEX_ENEMY_RAT;
    case 'enemy_slime':
      return TEX_ENEMY_SLIME;
    case 'gem':
      return TEX_GEM;
    case 'proj':
      return TEX_BULLET;
    case 'enemy_proj':
      return TEX_ENEMY_BULLET;
    case 'aoe_proj':
      return TEX_AOE_PROJ;
    case 'welcome_sign':
      return TEX_WELCOME_SIGN;
    case 'enemy_aoe_proj':
      return TEX_ENEMY_AOE_PROJ;
    case 'returning':
      return TEX_RETURNING;
    case 'aoe':
      return TEX_MELEE;
    case 'enemy_aoe':
      return TEX_ENEMY_EXPLOSION;
    case 'trap':
    case 'trap_arming':
      return TEX_TRAP_ARMING;
    case 'trap_armed':
      return TEX_TRAP_ARMED;
    case 'explosion':
      return TEX_EXPLOSION;
    case 'enemy_explosion':
      return TEX_ENEMY_EXPLOSION;
    case 'melee':
      return TEX_MELEE;
    case 'dead_skull':
      return TEX_DEAD_SKULL;
    default:
      return TEX_BULLET;
  }
}

/**
 * Apply the live render scale for an enemy image: baby slimes render
 * proportionally smaller than a full slime, and any enemy mid-spawn plays the
 * "pop out + wiggle" animation (smaller → overshoot → settle) on top of that.
 */
function applyEnemyScale(
  img: Phaser.GameObjects.Image,
  world: GameWorld,
  eid: number,
  baseScale: number,
): void {
  let scaleX = baseScale;
  let scaleY = baseScale;

  // Baby slimes carry a shrunken Sprite.width; render them at the matching
  // fraction of a full slime. Scoped to the 'slime-mini' archetype so full
  // slimes, rats, and slime-textured bosses are untouched.
  if (world.floor1?.enemyArchetypes.get(eid) === 'slime-mini') {
    const width = world.stores.sprite.width[eid] ?? SLIME_FULL_SPRITE_WIDTH;
    const sizeMul = Math.max(0.2, Math.min(1, width / SLIME_FULL_SPRITE_WIDTH));
    scaleX *= sizeMul;
    scaleY *= sizeMul;
  }

  // Spawn-in pop + jelly wiggle while the SpawnAnim timer is running.
  if (hasComponent(world.ecs, eid, SpawnAnim)) {
    const progress = spawnAnimProgress(
      world.stores.spawnAnim.remainingMs[eid] ?? 0,
      world.stores.spawnAnim.totalMs[eid] ?? 0,
    );
    const pop = computeSpawnPopScale(progress);
    scaleX *= pop.x;
    scaleY *= pop.y;
  }

  img.setScale(scaleX, scaleY);
}

export function createPhaserBridge(scene: Phaser.Scene): {
  sync(world: GameWorld, renderElapsedMs?: number, interpAlpha?: number): void;
  destroy(): void;
} {
  generateTextures(scene);

  const visuals = new Map<number, EntityVisual>();
  const deathMarkers = new Map<number, Phaser.GameObjects.Image>();
  const beamGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  const arcGraphics = new Map<number, Phaser.GameObjects.Graphics>();
  /** Tracks spawn time for arc entities so we can animate the sweep. */
  const arcSpawnMs = new Map<number, number>();
  const combatVfx = createCombatVfx(scene);
  const goreVfx =
    typeof scene.add.rectangle === 'function'
      ? createGoreVfx(scene, { intensity: 1.25, hitGoreEnabled: true })
      : null;
  const effectsVfx = createEffectsVfx(scene);
  const missingSpriteWarnings = new Set<string>();
  const missingTypeWarnings = new Set<string>();
  let lastRenderMs: number | null = null;

  function logFallback(type: string): void {
    const spriteId = ENTITY_KENNEY_SPRITE[type];
    if (spriteId !== undefined) {
      const warningKey = `${type}:${spriteId}`;
      if (missingSpriteWarnings.has(warningKey)) {
        return;
      }
      missingSpriteWarnings.add(warningKey);
      const sprite = getSprite(spriteId);
      logger.warn('Falling back to procedural texture; sprite sheet unavailable', {
        type,
        spriteId,
        sheetKey: sprite?.sheetKey,
      });
    } else {
      if (missingTypeWarnings.has(type)) {
        return;
      }
      missingTypeWarnings.add(type);
      logger.debug('Using procedural texture for entity type without sprite mapping', { type });
    }
  }

  return {
    sync(world: GameWorld, renderElapsedMs = world.elapsedMs, interpAlpha = 0): void {
      const entities = query(world.ecs, [Sprite, Position]);
      const activeEntities = new Set<number>();
      const { position, velocity, lineDamage, trap, areaDamage, lifetime, meleeSwing } =
        world.stores;

      for (const eid of entities) {
        activeEntities.add(eid);

        const entityType = getEntityType(world, eid);
        let isBoss = false;
        if (entityType === 'enemy' && world.floor1 != null) {
          for (const battle of world.floor1.objective.bossBattles.values()) {
            if (battle.bossEid === eid) {
              isBoss = true;
              break;
            }
          }
        }
        const visualType =
          entityType === 'enemy'
            ? isBoss
              ? 'enemy_boss'
              : world.stores.sprite.textureId[eid] === 1
                ? 'enemy_rat'
                : world.stores.sprite.textureId[eid] === 2
                  ? 'enemy_slime'
                  : 'enemy'
            : entityType;
        const x = (position.x[eid] ?? 0) + (velocity.x[eid] ?? 0) * interpAlpha;
        const y = (position.y[eid] ?? 0) + (velocity.y[eid] ?? 0) * interpAlpha;

        // --- Beam rendering (uses Graphics, not Image) ---
        if (entityType === 'beam') {
          let bg = beamGraphics.get(eid);
          if (!bg) {
            bg = scene.add.graphics();
            beamGraphics.set(eid, bg);
          }
          bg.clear();

          const dirX = lineDamage.dirX[eid] ?? 1;
          const dirY = lineDamage.dirY[eid] ?? 0;
          const length = lineDamage.length[eid] ?? 0;

          // Lifetime fade
          const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
          const remaining = Math.max(0, expiresAt - renderElapsedMs);
          const alpha = Math.min(1, remaining / 200);

          // Core beam line
          bg.lineStyle(4, 0x00ffff, alpha * 0.9);
          bg.beginPath();
          bg.moveTo(x, y);
          bg.lineTo(x + dirX * length, y + dirY * length);
          bg.strokePath();

          // Glow line (wider, more transparent)
          bg.lineStyle(10, 0x00aaff, alpha * 0.25);
          bg.beginPath();
          bg.moveTo(x, y);
          bg.lineTo(x + dirX * length, y + dirY * length);
          bg.strokePath();

          // Hide the image for beam entities
          const existing = visuals.get(eid);
          if (existing) {
            existing.obj.setVisible(false);
          }
          continue;
        }

        // --- Melee swing rendering (Graphics arc + weapon sprite at tip) ---
        if (entityType === 'melee_swing') {
          let ag = arcGraphics.get(eid);
          if (!ag) {
            ag = scene.add.graphics();
            arcGraphics.set(eid, ag);
            arcSpawnMs.set(eid, renderElapsedMs);
          }
          ag.clear();

          const bladeLen = meleeSwing.bladeLength[eid] ?? 0;
          const arcCenter = meleeSwing.arcCenterRad[eid] ?? 0;
          const arcHalf = meleeSwing.arcHalfRad[eid] ?? 0;
          const style = meleeSwing.style[eid] ?? 0;
          const headRadius = meleeSwing.headRadius[eid] ?? 0;
          const spawnTime = arcSpawnMs.get(eid) ?? renderElapsedMs;
          const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
          const totalDuration = Math.max(1, expiresAt - spawnTime);
          const elapsed = renderElapsedMs - spawnTime;
          const progress = Math.min(1, Math.max(0, elapsed / totalDuration));

          // Lifetime fade
          const remaining = Math.max(0, expiresAt - renderElapsedMs);
          const alpha = Math.min(1, remaining / 50);

          let tipX: number;
          let tipY: number;
          let tipAngle: number;

          if (style === 1) {
            // Stab: extend forward then retract
            const reach =
              progress <= 0.5 ? (progress / 0.5) * bladeLen : ((1 - progress) / 0.5) * bladeLen;
            tipX = x + Math.cos(arcCenter) * reach;
            tipY = y + Math.sin(arcCenter) * reach;
            tipAngle = arcCenter;

            // Shaft line (faint trail)
            ag.lineStyle(headRadius > 0 ? 1 : 2, 0xdddddd, alpha * 0.4);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();
          } else {
            // Slash: sweep through arc
            const startAngle = arcCenter + arcHalf;
            const endAngle = arcCenter - arcHalf;
            const currentAngle = startAngle + (endAngle - startAngle) * progress;
            tipX = x + Math.cos(currentAngle) * bladeLen;
            tipY = y + Math.sin(currentAngle) * bladeLen;
            tipAngle = currentAngle;

            // Faint trail arc showing the swept area
            if (progress > 0.05) {
              ag.lineStyle(2, 0xffffaa, 0.12 * alpha);
              ag.beginPath();
              ag.arc(x, y, bladeLen, startAngle, currentAngle, startAngle > endAngle);
              ag.strokePath();
            }

            // Shaft line (faint)
            ag.lineStyle(headRadius > 0 ? 1 : 2, 0xcccccc, alpha * 0.3);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();
          }

          // --- Weapon sprite pivoting from the player center ---
          // The hold anchor (DEFAULT_HANDHELD_SPRITE_ANCHOR) marks the grip on a
          // 16×16 frame (x=8, y=14 — near the handle end). We pin that anchor to
          // the player center so the weapon always appears to be held at the body.
          //
          // Derivation: with rotation = tipAngle + π/2 the local-up direction
          // (0,−1) maps to screen direction (cos tipAngle, sin tipAngle), so the
          // tip of the sprite is at origin + holdAnchor.y × scale × (cos, sin).
          // Setting holdAnchor.y × scale = bladeLen makes the sprite tip land
          // exactly at tipX/tipY while the grip stays at the player center.
          const WEAPON_SPRITE_FRAME_HEIGHT = 16;
          const holdY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y; // 14 px from top
          // Minimum scale ensuring the sprite remains visually readable for
          // very short weapons where the computed scale would be near-zero.
          const MIN_WEAPON_SPRITE_SCALE = 1.8;
          const weaponScale = bladeLen > holdY ? bladeLen / holdY : MIN_WEAPON_SPRITE_SCALE;
          const handX = x;
          const handY = y;

          const swingSprite = meleeSwing.spriteId[eid] ?? 0;
          const weaponSpriteKey = swingSprite === MeleeSpriteId.BAT ? 'weapon.bat' : 'weapon.sword';
          const weaponSpriteDef = getSprite(weaponSpriteKey);

          let visual = visuals.get(eid);
          if (!visual && weaponSpriteDef) {
            const img = scene.add.image(
              handX,
              handY,
              weaponSpriteDef.sheetKey,
              weaponSpriteDef.frame,
            );
            // Origin at hold anchor so the sprite pivots from the player's hand
            img.setOrigin(0.5, holdY / WEAPON_SPRITE_FRAME_HEIGHT);
            img.setScale(weaponScale);
            visuals.set(eid, { obj: img, type: entityType, baseScale: weaponScale });
            visual = visuals.get(eid);
          }

          if (visual) {
            visual.obj.setVisible(alpha > 0.05);
            visual.obj.setAlpha(alpha);
            // Recompute origin/scale each frame in case the sprite was reused
            visual.obj.setOrigin(0.5, holdY / WEAPON_SPRITE_FRAME_HEIGHT);
            visual.obj.setScale(weaponScale);
            visual.obj.setPosition(handX, handY);
            // +π/2 aligns local-up (blade tip) with tipAngle (away from player)
            visual.obj.setRotation(tipAngle + Math.PI / 2);
          }
          continue;
        }
        let visual = visuals.get(eid);

        if (!visual || visual.type !== visualType) {
          if (visual) {
            visual.obj.destroy();
          }
          const resolved = resolveTexture(scene, visualType);
          const img =
            resolved.frame !== undefined
              ? scene.add.image(x, y, resolved.key, resolved.frame)
              : scene.add.image(x, y, resolved.key);
          if (resolved.scale !== 1) {
            img.setScale(resolved.scale);
          }
          if (resolved.fallback) {
            logFallback(visualType);
          }
          visual = { obj: img, type: visualType, baseScale: resolved.scale };
          visuals.set(eid, visual);
        }

        const img = visual.obj;
        let isVisible = true;
        if (entityType === 'enemy' && world.floorMap) {
          const tile = world.floorMap.pixelToTile(x, y);
          isVisible = world.floorMap.isVisible(tile.x, tile.y);
          if (!isVisible && world.debugFlags.showAllRooms) {
            // Debug: show enemies in closed rooms dimly — does NOT affect game FOV
            img.setVisible(true);
            img.setAlpha(0.3);
          } else {
            img.setAlpha(1);
            img.setVisible(isVisible);
          }
        } else {
          img.setAlpha(1);
          img.setVisible(isVisible);
        }
        img.setPosition(x, y);

        const isDeadEnemy = entityType === 'enemy' && hasComponent(world.ecs, eid, DeathTimer);
        // Decay state for a dead enemy's corpse, applied AFTER the per-type
        // switch below (whose default branch resets alpha/scale for the living).
        let corpseDecay: CorpseDecay | undefined;
        let deathMarker = deathMarkers.get(eid);
        if (isDeadEnemy) {
          const remainingMs = world.stores.deathTimer.remainingMs[eid] ?? 0;
          // Capture the linger duration on the first dead frame so the fade is
          // normalised regardless of the configured deathLingerMs.
          if (visual.deathTotalMs === undefined) {
            visual.deathTotalMs = Math.max(remainingMs, 1);
          }
          corpseDecay = computeCorpseDecay(remainingMs, visual.deathTotalMs);

          if (!deathMarker) {
            const tex = resolveTexture(scene, 'dead_skull');
            deathMarker = scene.add.image(x, y - DEAD_SKULL_Y_OFFSET, tex.key, tex.frame);
            deathMarkers.set(eid, deathMarker);
          }
          // Skull is a brief "soul leaving" beat: it floats up and fades out
          // within ~1s, well before the corpse finishes decaying.
          deathMarker.setVisible(isVisible && corpseDecay.skullAlpha > 0.01);
          deathMarker.setPosition(x, y - DEAD_SKULL_Y_OFFSET - corpseDecay.skullRisePx);
          deathMarker.setAlpha(corpseDecay.skullAlpha);
        } else if (deathMarker) {
          deathMarker.setVisible(false);
        }

        // Per-type updates
        switch (entityType) {
          case 'proj':
          case 'enemy_proj': {
            const vx = velocity.x[eid] ?? 0;
            const vy = velocity.y[eid] ?? 0;
            if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
              img.setRotation(Math.atan2(vy, vx) + Math.PI / 2);
            }
            break;
          }

          case 'aoe_proj':
          case 'enemy_aoe_proj': {
            // Fireball/acid ball: gentle pulsing glow
            const pulse = 0.9 + 0.2 * Math.sin(renderElapsedMs * 0.01);
            img.setScale(pulse);
            const vx = velocity.x[eid] ?? 0;
            const vy = velocity.y[eid] ?? 0;
            if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
              img.setRotation(Math.atan2(vy, vx) + Math.PI / 2);
            }
            break;
          }

          case 'returning': {
            // Spinning rotation
            img.setRotation(renderElapsedMs * 0.015);
            break;
          }

          case 'aoe':
          case 'enemy_aoe': {
            const radius = areaDamage.radius[eid] ?? 32;
            const arcHalf = areaDamage.arcHalfRad[eid] ?? 0;
            const arcCenter = areaDamage.arcCenterRad[eid] ?? 0;
            const isArc = arcHalf > 0 && arcHalf < Math.PI;

            // Fade out based on lifetime
            const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
            const remaining = Math.max(0, expiresAt - renderElapsedMs);
            const alpha = Math.min(1, remaining / 100);

            if (isArc) {
              // Render as an animated sweeping blade line
              img.setVisible(false);
              let ag = arcGraphics.get(eid);
              if (!ag) {
                ag = scene.add.graphics();
                arcGraphics.set(eid, ag);
                arcSpawnMs.set(eid, renderElapsedMs);
              }
              ag.clear();

              // Calculate sweep progress (0→1 over the swing duration)
              const spawnTime = arcSpawnMs.get(eid) ?? renderElapsedMs;
              const expiresAt = lifetime.expiresAtMs[eid] ?? 0;
              const totalDuration = Math.max(1, expiresAt - spawnTime);
              const elapsed = renderElapsedMs - spawnTime;
              const progress = Math.min(1, Math.max(0, elapsed / totalDuration));

              // Sweep from start angle to end angle (right-to-left)
              const startAngle = arcCenter + arcHalf;
              const endAngle = arcCenter - arcHalf;
              const currentAngle = startAngle + (endAngle - startAngle) * progress;

              const tipX = x + Math.cos(currentAngle) * radius;
              const tipY = y + Math.sin(currentAngle) * radius;

              // Blade line
              ag.lineStyle(3, 0xcccccc, alpha);
              ag.beginPath();
              ag.moveTo(x, y);
              ag.lineTo(tipX, tipY);
              ag.strokePath();

              // Bright tip
              ag.fillStyle(0xffffff, alpha);
              ag.fillCircle(tipX, tipY, 3);

              // Faint trail arc showing the swept area
              if (progress > 0.05) {
                const sweptStart = startAngle;
                const sweptEnd = currentAngle;
                ag.lineStyle(1, 0xffffaa, 0.15 * alpha);
                ag.beginPath();
                ag.arc(x, y, radius, sweptStart, sweptEnd, startAngle > endAngle);
                ag.strokePath();
              }
            } else {
              // Full circle AoE — use image
              const currentTex = resolveTexture(
                scene,
                entityType === 'enemy_aoe' ? 'melee' : 'aoe_proj',
              );
              let scale = (radius * 2) / (currentTex.scale > 1 ? 16 : 66);
              img.setScale(scale);
              img.setAlpha(alpha);

              // Use explosion texture for trap-spawned AoEs (short duration)
              const explosionType = entityType === 'enemy_aoe' ? 'enemy_explosion' : 'explosion';
              const explosionTex = resolveTexture(scene, explosionType);
              if (remaining <= 100 && img.texture.key !== explosionTex.key) {
                img.setTexture(explosionTex.key, explosionTex.frame);
                // Recalculate scale based on new texture
                scale = (radius * 2) / (explosionTex.scale > 1 ? 16 : 66);
                img.setScale(scale);
              }

              // Clean up any stale arc graphics
              const staleAg = arcGraphics.get(eid);
              if (staleAg) {
                staleAg.destroy();
                arcGraphics.delete(eid);
                arcSpawnMs.delete(eid);
              }
            }
            break;
          }

          case 'trap': {
            // Switch texture based on arm state
            const armAt = trap.armAtMs[eid] ?? 0;
            const isArmed = renderElapsedMs >= armAt;
            const tex = resolveTexture(scene, isArmed ? 'trap_armed' : 'trap_arming');
            img.setTexture(tex.key, tex.frame);

            // Pulse when armed
            if (isArmed) {
              const pulse = 0.8 + 0.3 * Math.sin(renderElapsedMs * 0.008);
              img.setAlpha(pulse);
            } else {
              // Arming blink
              const blink = Math.sin(renderElapsedMs * 0.02) > 0 ? 0.7 : 0.3;
              img.setAlpha(blink);
            }
            break;
          }

          case 'welcome_sign': {
            if (hasComponent(world.ecs, eid, Rotation)) {
              img.setRotation(world.stores.rotation.angle[eid] ?? 0);
            }
            break;
          }

          default:
            img.setAlpha(1);
            img.setRotation(0);
            if (entityType === 'enemy') {
              applyEnemyScale(img, world, eid, visual.baseScale);
            } else {
              img.setScale(visual.baseScale);
            }
            break;
        }

        // Corpse styling wins over the per-type switch: a dead enemy drains
        // toward grey (multiply tint) and fades out across its linger window.
        if (corpseDecay) {
          if (typeof img.setTint === 'function') {
            img.setTint(corpseDecay.tint);
          }
          img.setAlpha(corpseDecay.corpseAlpha);
        } else if (visual.deathTotalMs !== undefined) {
          // This visual previously backed a corpse but its EID has been
          // recycled for a living entity (bitecs reuses freed EIDs). Clear the
          // leftover grey multiply-tint and stale linger duration so the reused
          // sprite renders normally and recalibrates cleanly on its next death.
          if (typeof img.clearTint === 'function') {
            img.clearTint();
          }
          visual.deathTotalMs = undefined;
        }
      }

      // Clean up removed entities
      for (const [eid, visual] of visuals) {
        if (activeEntities.has(eid)) {
          continue;
        }
        visual.obj.destroy();
        visuals.delete(eid);
      }

      for (const [eid, marker] of deathMarkers) {
        if (activeEntities.has(eid)) {
          continue;
        }
        marker.destroy();
        deathMarkers.delete(eid);
      }

      for (const [eid, bg] of beamGraphics) {
        if (activeEntities.has(eid)) {
          continue;
        }
        bg.destroy();
        beamGraphics.delete(eid);
      }

      for (const [eid, ag] of arcGraphics) {
        if (activeEntities.has(eid)) {
          continue;
        }
        ag.destroy();
        arcGraphics.delete(eid);
        arcSpawnMs.delete(eid);
      }

      const deltaMs =
        lastRenderMs === null ? 16 : Math.max(1, Math.min(50, renderElapsedMs - lastRenderMs));
      lastRenderMs = renderElapsedMs;
      if (goreVfx) {
        goreVfx.update(world, renderElapsedMs, deltaMs, interpAlpha);
      }
      // Juice effects (hit sparks, crit bursts, death pops, pickups, level-up).
      // Reads combatEvents BEFORE CombatVfx drains them; drains world.vfxEvents.
      effectsVfx.update(world, renderElapsedMs);
      // Process combat VFX (floating damage numbers)
      combatVfx.update(world, renderElapsedMs);
    },

    destroy(): void {
      for (const visual of visuals.values()) {
        visual.obj.destroy();
      }
      visuals.clear();

      for (const marker of deathMarkers.values()) {
        marker.destroy();
      }
      deathMarkers.clear();

      for (const bg of beamGraphics.values()) {
        bg.destroy();
      }
      beamGraphics.clear();

      for (const ag of arcGraphics.values()) {
        ag.destroy();
      }
      arcGraphics.clear();
      arcSpawnMs.clear();
      goreVfx?.destroy();
      effectsVfx.destroy();
      combatVfx.destroy();
    },
  };
}
