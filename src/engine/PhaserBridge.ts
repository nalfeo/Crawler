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
  Player,
  Position,
  Projectile,
  Returning,
  Sprite,
  Trap,
  XpGem,
} from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { getSprite } from './sprites/index.js';
import { createCombatVfx } from './CombatVfx.js';
import { createLogger } from '../shared/logger.js';

// --- Texture keys ---
const TEX_PLAYER = '__cw_player';
const TEX_ENEMY = '__cw_enemy';
const TEX_GEM = '__cw_gem';
const TEX_BULLET = '__cw_bullet';
const TEX_ENEMY_BULLET = '__cw_enemy_bullet';
const TEX_AOE_PROJ = '__cw_aoe_proj';
const TEX_RETURNING = '__cw_returning';
const TEX_MELEE = '__cw_melee';
const TEX_TRAP_ARMED = '__cw_trap_armed';
const TEX_TRAP_ARMING = '__cw_trap_arming';
const TEX_EXPLOSION = '__cw_explosion';
const TEX_DEAD_SKULL = '__cw_dead_skull';
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

  // XP gem — yellow diamond
  g.clear();
  g.fillStyle(0xffee00, 1);
  g.fillTriangle(5, 0, 0, 5, 5, 10);
  g.fillTriangle(5, 0, 10, 5, 5, 10);
  g.generateTexture(TEX_GEM, 12, 12);

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

  g.destroy();
  logger.info('Generated procedural fallback textures');
}

interface EntityVisual {
  obj: Phaser.GameObjects.Image;
  type: string;
  /** Base scale to restore in the default per-frame branch. */
  baseScale: number;
}

function getEntityType(world: GameWorld, eid: number): string {
  if (hasComponent(world.ecs, eid, Player)) return 'player';
  if (hasComponent(world.ecs, eid, Enemy)) return 'enemy';
  if (hasComponent(world.ecs, eid, XpGem)) return 'gem';
  if (hasComponent(world.ecs, eid, LineDamage)) return 'beam';
  if (hasComponent(world.ecs, eid, MeleeSwing)) return 'melee_swing';
  if (hasComponent(world.ecs, eid, Trap)) return 'trap';
  if (hasComponent(world.ecs, eid, AreaDamage)) return 'aoe';
  if (hasComponent(world.ecs, eid, Returning)) return 'returning';
  if (hasComponent(world.ecs, eid, AoeOnImpact)) return 'aoe_proj';
  if (hasComponent(world.ecs, eid, EnemyProjectile)) return 'enemy_proj';
  if (hasComponent(world.ecs, eid, Projectile)) return 'proj';
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
};

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
    case 'gem':
      return TEX_GEM;
    case 'proj':
      return TEX_BULLET;
    case 'enemy_proj':
      return TEX_ENEMY_BULLET;
    case 'aoe_proj':
      return TEX_AOE_PROJ;
    case 'returning':
      return TEX_RETURNING;
    case 'aoe':
      return TEX_MELEE;
    case 'trap':
      return TEX_TRAP_ARMING;
    default:
      return TEX_BULLET;
  }
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
  const missingSpriteWarnings = new Set<string>();
  const missingTypeWarnings = new Set<string>();

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

        // --- Melee swing rendering (uses Graphics, not Image) ---
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

          if (style === 1) {
            // Stab: extend forward then retract
            const reach =
              progress <= 0.5 ? (progress / 0.5) * bladeLen : ((1 - progress) / 0.5) * bladeLen;
            tipX = x + Math.cos(arcCenter) * reach;
            tipY = y + Math.sin(arcCenter) * reach;

            // Shaft line
            ag.lineStyle(headRadius > 0 ? 1 : 2, 0xdddddd, alpha);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();

            if (headRadius > 0) {
              // Fist/head — larger filled circle at the tip
              ag.fillStyle(0xccaa88, alpha);
              ag.fillCircle(tipX, tipY, headRadius);
              ag.lineStyle(2, 0xddccaa, alpha);
              ag.strokeCircle(tipX, tipY, headRadius);
            } else {
              // Sharp tip for knives
              ag.fillStyle(0xffffff, alpha);
              ag.fillCircle(tipX, tipY, 2);
            }
          } else {
            // Slash: sweep through arc
            const startAngle = arcCenter + arcHalf;
            const endAngle = arcCenter - arcHalf;
            const currentAngle = startAngle + (endAngle - startAngle) * progress;
            tipX = x + Math.cos(currentAngle) * bladeLen;
            tipY = y + Math.sin(currentAngle) * bladeLen;

            // Shaft line
            ag.lineStyle(headRadius > 0 ? 2 : 3, 0xcccccc, alpha);
            ag.beginPath();
            ag.moveTo(x, y);
            ag.lineTo(tipX, tipY);
            ag.strokePath();

            if (headRadius > 0) {
              // Hammer head — larger filled rectangle at the tip
              ag.fillStyle(0xaaaaaa, alpha);
              ag.fillCircle(tipX, tipY, headRadius);
              ag.lineStyle(2, 0xdddddd, alpha);
              ag.strokeCircle(tipX, tipY, headRadius);
            } else {
              // Bright tip for swords
              ag.fillStyle(0xffffff, alpha);
              ag.fillCircle(tipX, tipY, 3);
            }

            // Faint trail arc showing the swept area
            if (progress > 0.05) {
              ag.lineStyle(1, 0xffffaa, 0.15 * alpha);
              ag.beginPath();
              ag.arc(x, y, bladeLen, startAngle, currentAngle, startAngle > endAngle);
              ag.strokePath();
            }
          }

          // Hide the image for melee swing entities
          const existingSwing = visuals.get(eid);
          if (existingSwing) {
            existingSwing.obj.setVisible(false);
          }
          continue;
        }
        let visual = visuals.get(eid);

        if (!visual || visual.type !== entityType) {
          if (visual) {
            visual.obj.destroy();
          }
          const resolved = resolveTexture(scene, entityType);
          const img =
            resolved.frame !== undefined
              ? scene.add.image(x, y, resolved.key, resolved.frame)
              : scene.add.image(x, y, resolved.key);
          if (resolved.scale !== 1) {
            img.setScale(resolved.scale);
          }
          if (resolved.fallback) {
            logFallback(entityType);
          }
          visual = { obj: img, type: entityType, baseScale: resolved.scale };
          visuals.set(eid, visual);
        }

        const img = visual.obj;
        img.setVisible(true);
        img.setPosition(x, y);

        const isDeadEnemy = entityType === 'enemy' && hasComponent(world.ecs, eid, DeathTimer);
        let deathMarker = deathMarkers.get(eid);
        if (isDeadEnemy) {
          if (!deathMarker) {
            deathMarker = scene.add.image(x, y - DEAD_SKULL_Y_OFFSET, TEX_DEAD_SKULL);
            deathMarkers.set(eid, deathMarker);
          }
          deathMarker.setVisible(true);
          deathMarker.setPosition(x, y - DEAD_SKULL_Y_OFFSET);
          deathMarker.setAlpha(0.95);
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

          case 'aoe_proj': {
            // Fireball: gentle pulsing glow
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

          case 'aoe': {
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
              const scale = (radius * 2) / 66;
              img.setScale(scale);
              img.setAlpha(alpha);

              // Use explosion texture for trap-spawned AoEs (short duration)
              if (remaining <= 100 && img.texture.key !== TEX_EXPLOSION) {
                img.setTexture(TEX_EXPLOSION);
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
            img.setTexture(isArmed ? TEX_TRAP_ARMED : TEX_TRAP_ARMING);

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

          default:
            img.setAlpha(1);
            img.setScale(visual.baseScale);
            img.setRotation(0);
            break;
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
      combatVfx.destroy();
    },
  };
}
