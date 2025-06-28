/**
 * Gore VFX renderer — spawns blood splatter particles on hit and death events,
 * and leaves persistent blood pools on the ground after kills.
 *
 * IMPORTANT: Must run BEFORE CombatVfx.update() since CombatVfx drains the
 * combatEvents queue. GoreVfx reads events without draining them.
 *
 * Hit gore: small directional splatter, probability controlled by weaponGoreFactor.
 * Death gore: large particle burst, intensity scaled by overkill damage.
 * Blood pools: persistent irregular puddles on the ground that spread across
 * most of their ~30-second lifetime. Each pool is a Phaser `Graphics` with
 * several overlapping sub-lobes so the outline reads as an organic blob rather
 * than a smooth ellipse (see `spawnBloodPool` and `redrawBloodPool`).
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import { ftToPx } from '../shared/units.js';
import type { GameWorld } from '../core/world.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import { DEFAULT_BLOOD_COLOR } from '../shared/constants.js';
import {
  evaluateBloodPoolVerticalScale,
  getBloodPoolLifetimeProgress,
  evaluateBloodPoolLobeScale,
  getBloodPoolRenderColor,
} from '../shared/blood-surfaces.js';

const PARTICLE_LIFETIME_MS = 500;
const HIT_BASE_PARTICLES = 4;
const DEATH_BASE_PARTICLES = 16;
const PARTICLE_SPEED = 120;
const PARTICLE_SIZE_MIN = 2;
const PARTICLE_SIZE_MAX = 6;

/** Fallback red blood palette when no bloodColor is supplied. */
const DEFAULT_BLOOD_COLORS = [DEFAULT_BLOOD_COLOR, 0xaa0000, 0x880000, 0x660000, 0x990000];

interface GoreParticle {
  obj: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  startMs: number;
}

interface RenderedBloodPool {
  id: number;
  obj: Phaser.GameObjects.Graphics;
  /** Cached last-frame progress (0-1 across lifetime) so we only redraw
   * when it changes meaningfully. */
  lastProgress: number;
  /** Cached last-frame alpha so we only redraw when it changes meaningfully. */
  lastAlpha: number;
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

/** Derive a palette of 5 darker variants from a base hex colour.
 * Scales: base (1.0), slightly darker (0.83), darker (0.67), darkest (0.50), medium (0.75).
 */
const COLOR_VARIANT_SCALES = [1.0, 0.83, 0.67, 0.5, 0.75] as const;

function makeColorVariants(base: number): number[] {
  const r = (base >> 16) & 0xff;
  const g = (base >> 8) & 0xff;
  const b = base & 0xff;
  return COLOR_VARIANT_SCALES.map((s) => {
    return (Math.round(r * s) << 16) | (Math.round(g * s) << 8) | Math.round(b * s);
  });
}

export function createGoreVfx(
  scene: Phaser.Scene,
  config: Partial<GoreVfxConfig> = {},
): {
  update(world: GameWorld, renderElapsedMs: number, deltaMs: number, interpAlpha?: number): void;
  destroy(): void;
  config: GoreVfxConfig;
} {
  const cfg: GoreVfxConfig = { ...DEFAULT_CONFIG, ...config };
  const particles: GoreParticle[] = [];
  const pools = new Map<number, RenderedBloodPool>();

  /** Simple seeded-ish random for VFX (doesn't need to be deterministic). */
  let vfxSeed = 1;
  function vfxRandom(): number {
    vfxSeed = (vfxSeed * 16807 + 0) % 2147483647;
    return vfxSeed / 2147483647;
  }

  function pickColor(palette: number[]): number {
    return palette[Math.floor(vfxRandom() * palette.length)]!;
  }

  function spawnParticles(
    x: number,
    y: number,
    count: number,
    dirX: number,
    dirY: number,
    spread: number,
    renderElapsedMs: number,
    colorPalette: number[],
  ): void {
    const scaledCount = Math.round(count * cfg.intensity);
    if (scaledCount <= 0) return;
    for (let i = 0; i < scaledCount; i++) {
      const angle = Math.atan2(dirY, dirX) + (vfxRandom() - 0.5) * spread;
      const speed = PARTICLE_SPEED * (0.5 + vfxRandom() * 0.8);
      const size = PARTICLE_SIZE_MIN + vfxRandom() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN);
      const color = pickColor(colorPalette);

      // x/y are world feet; scale to pixels for the rendering layer.
      const rect = scene.add.rectangle(ftToPx(x), ftToPx(y), size, size, color);
      // World-space VFX: depth must stay below UI_DEPTH_CUTOFF (see render-depths.ts).
      rect.setDepth(WORLD_VFX_DEPTH.gore);
      rect.setAlpha(0.9);
      (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(rect);

      particles.push({
        obj: rect,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        startMs: renderElapsedMs,
      });
    }
  }

  /** Redraw one authoritative pool from world state at the given progress/alpha. */
  function redrawBloodPool(
    pool: RenderedBloodPool,
    worldPool: GameWorld['bloodPools'][number],
    progress: number,
    alpha: number,
  ): void {
    pool.obj.clear();
    pool.obj.fillStyle(getBloodPoolRenderColor(worldPool.color), 1);
    for (const lobe of worldPool.lobes) {
      const eased = evaluateBloodPoolLobeScale(progress, lobe);
      pool.obj.fillEllipse(
        ftToPx(lobe.offsetXFt),
        ftToPx(lobe.offsetYFt),
        ftToPx(lobe.radiusXFt) * 2 * eased,
        ftToPx(lobe.radiusYFt) * 2 * eased,
      );
    }
    pool.obj.setAlpha(alpha);
    pool.obj.setScale(1, evaluateBloodPoolVerticalScale(progress));
    pool.lastProgress = progress;
    pool.lastAlpha = alpha;
  }

  /**
   * Resolve the spawn position for an event. The renderer draws entities at an
   * interpolated position (`position + velocity * interpAlpha`, see
   * PhaserBridge), so gore must use the same interpolation or it visibly lags
   * behind fast-moving mobs (e.g. leaping slimes). Falls back to the event's
   * recorded position when the target entity is gone.
   */
  function resolvePosition(
    world: GameWorld,
    event: CombatEvent,
    interpAlpha: number,
  ): { x: number; y: number } {
    const eid = event.targetEid;
    if (eid === undefined) return { x: event.x, y: event.y };
    const px = world.stores.position.x[eid];
    const py = world.stores.position.y[eid];
    if (!Number.isFinite(px) || !Number.isFinite(py)) return { x: event.x, y: event.y };
    const vx = world.stores.velocity.x[eid] ?? 0;
    const vy = world.stores.velocity.y[eid] ?? 0;
    return { x: px! + vx * interpAlpha, y: py! + vy * interpAlpha };
  }

  function handleHitEvent(
    world: GameWorld,
    event: CombatEvent,
    renderElapsedMs: number,
    interpAlpha: number,
  ): void {
    if (!cfg.hitGoreEnabled) return;
    if (event.targetType !== 'enemy') return;

    const goreFactor = event.weaponGoreFactor ?? 0.5;
    if (vfxRandom() > goreFactor) return;

    const count = Math.round(HIT_BASE_PARTICLES * goreFactor * (event.amount / 10));
    const particleCount = Math.max(1, Math.min(count, 8));

    // Compute direction: blood sprays AWAY from the source
    let dirX: number;
    let dirY: number;
    if (
      event.sourceX !== undefined &&
      event.sourceY !== undefined &&
      (Math.abs(event.x - event.sourceX) > 0.01 || Math.abs(event.y - event.sourceY) > 0.01)
    ) {
      // Direction from source to target (blood goes same way the force travels)
      const dx = event.x - event.sourceX;
      const dy = event.y - event.sourceY;
      const dist = Math.hypot(dx, dy);
      dirX = dx / dist;
      dirY = dy / dist;
    } else {
      // Fallback: random direction when no source info
      const angle = vfxRandom() * Math.PI * 2;
      dirX = Math.cos(angle);
      dirY = Math.sin(angle);
    }

    const { x: spawnX, y: spawnY } = resolvePosition(world, event, interpAlpha);
    const palette =
      event.bloodColor !== undefined ? makeColorVariants(event.bloodColor) : DEFAULT_BLOOD_COLORS;
    spawnParticles(
      spawnX,
      spawnY,
      particleCount,
      dirX,
      dirY,
      Math.PI * 1.0,
      renderElapsedMs,
      palette,
    );
  }

  function handleDeathEvent(
    world: GameWorld,
    event: CombatEvent,
    renderElapsedMs: number,
    interpAlpha: number,
  ): void {
    const overkill = event.overkill ?? 0;
    const overkillMult = 1 + Math.min(overkill / 20, 3);
    const count = Math.round(DEATH_BASE_PARTICLES * overkillMult);

    // Prefer explicit knockback direction, fall back to source→target direction
    let dirX = event.knockbackDirX ?? 0;
    let dirY = event.knockbackDirY ?? 0;
    let hasDir = Math.abs(dirX) + Math.abs(dirY) > 0.01;

    if (
      !hasDir &&
      event.sourceX !== undefined &&
      event.sourceY !== undefined &&
      (Math.abs(event.x - event.sourceX) > 0.01 || Math.abs(event.y - event.sourceY) > 0.01)
    ) {
      const dx = event.x - event.sourceX;
      const dy = event.y - event.sourceY;
      const dist = Math.hypot(dx, dy);
      dirX = dx / dist;
      dirY = dy / dist;
      hasDir = true;
    }

    const { x: spawnX, y: spawnY } = resolvePosition(world, event, interpAlpha);
    const palette =
      event.bloodColor !== undefined ? makeColorVariants(event.bloodColor) : DEFAULT_BLOOD_COLORS;
    spawnParticles(
      spawnX,
      spawnY,
      count,
      hasDir ? dirX : 0,
      hasDir ? dirY : -1,
      hasDir ? Math.PI * 1.2 : Math.PI * 2,
      renderElapsedMs,
      palette,
    );
  }

  return {
    config: cfg,

    update(world: GameWorld, renderElapsedMs: number, deltaMs: number, interpAlpha = 0): void {
      // Process events (do NOT drain — CombatVfx does that)
      for (const event of world.combatEvents) {
        if (event.type === 'hit') {
          handleHitEvent(world, event, renderElapsedMs, interpAlpha);
        } else if (event.type === 'death') {
          handleDeathEvent(world, event, renderElapsedMs, interpAlpha);
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

      if (cfg.intensity <= 0) {
        for (const pool of pools.values()) {
          pool.obj.destroy();
        }
        pools.clear();
      } else if (typeof scene.add.graphics === 'function') {
        const activePoolIds = new Set(world.bloodPools.map((pool) => pool.id));
        for (const [id, pool] of pools) {
          if (!activePoolIds.has(id)) {
            pool.obj.destroy();
            pools.delete(id);
          }
        }
        for (const worldPool of world.bloodPools) {
          let rendered = pools.get(worldPool.id);
          if (!rendered) {
            const graphics = scene.add.graphics({
              x: ftToPx(worldPool.x + worldPool.renderOffsetXFt),
              y: ftToPx(worldPool.y + worldPool.renderOffsetYFt),
            });
            graphics.setDepth(WORLD_VFX_DEPTH.bloodPool);
            graphics.name = `blood-pool:${worldPool.id}`;
            (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
              graphics,
            );
            rendered = { id: worldPool.id, obj: graphics, lastProgress: -1, lastAlpha: -1 };
            pools.set(worldPool.id, rendered);
          }
          const progress = getBloodPoolLifetimeProgress(worldPool, world.elapsedMs);
          const alpha = 0.55 * (1 - progress);
          if (
            Math.abs(progress - rendered.lastProgress) > 0.001 ||
            Math.abs(alpha - rendered.lastAlpha) > 0.001
          ) {
            redrawBloodPool(rendered, worldPool, progress, alpha);
          }
        }
      }
    },

    destroy(): void {
      for (const p of particles) {
        p.obj.destroy();
      }
      particles.length = 0;
      for (const pool of pools.values()) {
        pool.obj.destroy();
      }
      pools.clear();
    },
  };
}
