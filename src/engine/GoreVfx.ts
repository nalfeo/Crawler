/**
 * Gore VFX renderer — orchestrates split collision-effects and death-effects VFX.
 *
 * IMPORTANT: Must run BEFORE CombatVfx.update() since CombatVfx drains the
 * combatEvents queue. GoreVfx reads events without draining them.
 *
 */
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { createCollisionEffectsSystem } from './CollisionEffectsVfx.js';
import { createDeathEffectsSystem } from './DeathEffectsVfx.js';

const PARTICLE_LIFETIME_MS = 500;
const PARTICLE_SPEED = 120;
const PARTICLE_SIZE_MIN = 2;
const PARTICLE_SIZE_MAX = 6;

interface GoreParticle {
  obj: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  startMs: number;
}

export interface GoreVfxConfig {
  /** Global intensity multiplier (0 = disabled, 1 = normal, 2 = extra). */
  intensity: number;
  /** Whether hit-gore is enabled (vs death-only). */
  hitGoreEnabled: boolean;
}

const DEFAULT_CONFIG: GoreVfxConfig = {
  intensity: 1.0,
  hitGoreEnabled: true,
};

export function createGoreVfx(
  scene: Phaser.Scene,
  config: Partial<GoreVfxConfig> = {},
): {
  update(world: GameWorld, renderElapsedMs: number, deltaMs: number): void;
  destroy(): void;
  config: GoreVfxConfig;
} {
  const cfg: GoreVfxConfig = { ...DEFAULT_CONFIG, ...config };
  const particles: GoreParticle[] = [];

  /** Simple seeded-ish random for VFX (doesn't need to be deterministic). */
  let vfxSeed = 1;
  function vfxRandom(): number {
    vfxSeed = (vfxSeed * 16807 + 0) % 2147483647;
    return vfxSeed / 2147483647;
  }

  function spawnParticles(
    x: number,
    y: number,
    count: number,
    dirX: number,
    dirY: number,
    spread: number,
    renderElapsedMs: number,
    colors: readonly number[],
  ): void {
    const scaledCount = Math.round(count * cfg.intensity);
    if (scaledCount <= 0) return;
    for (let i = 0; i < scaledCount; i++) {
      const angle = Math.atan2(dirY, dirX) + (vfxRandom() - 0.5) * spread;
      const speed = PARTICLE_SPEED * (0.5 + vfxRandom() * 0.8);
      const size = PARTICLE_SIZE_MIN + vfxRandom() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN);
      const color = colors[Math.floor(vfxRandom() * colors.length)]!;

      const rect = scene.add.rectangle(x, y, size, size, color);
      rect.setDepth(999);
      rect.setAlpha(0.9);

      particles.push({
        obj: rect,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        startMs: renderElapsedMs,
      });
    }
  }

  const collisionEffects = createCollisionEffectsSystem(spawnParticles, vfxRandom, cfg);
  const deathEffects = createDeathEffectsSystem(spawnParticles);

  return {
    config: cfg,

    update(world: GameWorld, renderElapsedMs: number, deltaMs: number): void {
      // Process events (do NOT drain — CombatVfx does that)
      for (const event of world.combatEvents) {
        collisionEffects.handle(event, renderElapsedMs);
        deathEffects.handle(event, renderElapsedMs);
      }

      // Animate and clean up particles
      const dtSec = deltaMs / 1000;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        const age = renderElapsedMs - p.startMs;
        const progress = Math.min(1, age / PARTICLE_LIFETIME_MS);

        if (progress >= 1) {
          p.obj.destroy();
          particles.splice(i, 1);
          continue;
        }

        // Move with deceleration
        const decel = 1 - progress * 0.7;
        p.obj.setX(p.obj.x + p.vx * dtSec * decel);
        p.obj.setY(p.obj.y + p.vy * dtSec * decel);

        // Gravity
        p.vy += 60 * dtSec;

        // Fade and shrink
        p.obj.setAlpha((1 - progress) * 0.9);
        p.obj.setScale(1 - progress * 0.5);
      }
    },

    destroy(): void {
      for (const p of particles) {
        p.obj.destroy();
      }
      particles.length = 0;
    },
  };
}
