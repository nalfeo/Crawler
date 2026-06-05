/**
 * Gore VFX renderer — spawns blood splatter particles on hit and death events.
 *
 * IMPORTANT: Must run BEFORE CombatVfx.update() since CombatVfx drains the
 * combatEvents queue. GoreVfx reads events without draining them.
 *
 * Hit gore: small directional splatter, probability controlled by weaponGoreFactor.
 * Death gore: large particle burst, intensity scaled by overkill damage.
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from '../core/world.js';

const PARTICLE_LIFETIME_MS = 400;
const HIT_BASE_PARTICLES = 3;
const DEATH_BASE_PARTICLES = 12;
const PARTICLE_SPEED = 80;
const PARTICLE_SIZE_MIN = 2;
const PARTICLE_SIZE_MAX = 5;
const BLOOD_COLORS = [0xcc0000, 0xaa0000, 0x880000, 0x660000, 0x990000];

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
  ): void {
    const scaledCount = Math.max(1, Math.round(count * cfg.intensity));
    for (let i = 0; i < scaledCount; i++) {
      const angle = Math.atan2(dirY, dirX) + (vfxRandom() - 0.5) * spread;
      const speed = PARTICLE_SPEED * (0.5 + vfxRandom() * 0.8);
      const size =
        PARTICLE_SIZE_MIN + vfxRandom() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN);
      const color = BLOOD_COLORS[Math.floor(vfxRandom() * BLOOD_COLORS.length)]!;

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

  function handleHitEvent(event: CombatEvent, renderElapsedMs: number): void {
    if (!cfg.hitGoreEnabled) return;
    if (event.targetType !== 'enemy') return;

    const goreFactor = event.weaponGoreFactor ?? 0.5;
    if (vfxRandom() > goreFactor) return;

    const count = Math.round(HIT_BASE_PARTICLES * goreFactor * (event.amount / 10));
    const particleCount = Math.max(1, Math.min(count, 8));

    // Spray in a random direction (no source info on hit events)
    const angle = vfxRandom() * Math.PI * 2;
    spawnParticles(
      event.x,
      event.y,
      particleCount,
      Math.cos(angle),
      Math.sin(angle),
      Math.PI * 0.6,
      renderElapsedMs,
    );
  }

  function handleDeathEvent(event: CombatEvent, renderElapsedMs: number): void {
    const overkill = event.overkill ?? 0;
    const overkillMult = 1 + Math.min(overkill / 20, 3);
    const count = Math.round(DEATH_BASE_PARTICLES * overkillMult);

    const dirX = event.knockbackDirX ?? 0;
    const dirY = event.knockbackDirY ?? 0;
    const hasDir = Math.abs(dirX) + Math.abs(dirY) > 0.01;

    spawnParticles(
      event.x,
      event.y,
      count,
      hasDir ? dirX : 0,
      hasDir ? dirY : -1,
      hasDir ? Math.PI * 0.8 : Math.PI * 2,
      renderElapsedMs,
    );
  }

  return {
    config: cfg,

    update(world: GameWorld, renderElapsedMs: number, deltaMs: number): void {
      // Process events (do NOT drain — CombatVfx does that)
      for (const event of world.combatEvents) {
        if (event.type === 'hit') {
          handleHitEvent(event, renderElapsedMs);
        } else if (event.type === 'death') {
          handleDeathEvent(event, renderElapsedMs);
        }
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
