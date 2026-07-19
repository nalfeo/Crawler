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

const PARTICLE_LIFETIME_MS = 500;
const HIT_BASE_PARTICLES = 4;
const DEATH_BASE_PARTICLES = 16;
const PARTICLE_SPEED = 120;
const PARTICLE_SIZE_MIN = 2;
const PARTICLE_SIZE_MAX = 6;

/** Fallback red blood palette when no bloodColor is supplied. */
const DEFAULT_BLOOD_COLORS = [DEFAULT_BLOOD_COLOR, 0xaa0000, 0x880000, 0x660000, 0x990000];

const BLOOD_POOL_LIFETIME_MS = 30_000;
const BLOOD_POOL_BASE_RADIUS = 8;
const BLOOD_POOL_MAX_EXTRA_RADIUS = 18;
/** Pool starts at this fraction of its final size and expands to 1.0. */
const BLOOD_POOL_INITIAL_SCALE = 0.25;
/**
 * Fraction of pool lifetime spent expanding to full size. A slow spread makes
 * a fresh kill read as an ongoing wound: the pool keeps growing across most
 * of its 30 s life instead of snapping to full width in the first frame.
 */
const BLOOD_POOL_EXPAND_PHASE = 0.7;
/** Vertical scale reached as the pool finishes spreading and fading. */
const BLOOD_POOL_FINAL_VERTICAL_SCALE = 0.5;
/** Maximum simultaneous blood pools before oldest is evicted. */
const MAX_BLOOD_POOLS = 150;
/** Number of overlapping sub-lobes drawn per pool for irregular spread. */
const BLOOD_POOL_LOBE_COUNT = 5;

interface GoreParticle {
  obj: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  startMs: number;
}

interface BloodPoolLobe {
  /** Offset from the pool centre (px). */
  offsetX: number;
  offsetY: number;
  /** Final half-width of this lobe (px). */
  targetRx: number;
  /** Final half-height of this lobe (px). */
  targetRy: number;
  /** Per-lobe fraction of the pool's expand phase that this lobe reaches full size at.
   * A value near 0 means the lobe pops in early; near 1 means it keeps spreading for
   * almost the entire expand phase. Values are staggered so the outline visibly
   * grows over time rather than all lobes pulsing in lockstep. */
  growAt: number;
  /** Scale this lobe starts at (0-1). The "core" lobe starts at
   * `BLOOD_POOL_INITIAL_SCALE` so the pool has a visible anchor from the
   * first frame; outer lobes start at 0 and unfurl outward, so the pool
   * reads as spreading from a tight core rather than materialising already
   * spread. */
  initialScale: number;
}

interface BloodPool {
  obj: Phaser.GameObjects.Graphics;
  color: number;
  lobes: BloodPoolLobe[];
  startMs: number;
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
/** Index into COLOR_VARIANT_SCALES used for blood pool fill — the slightly-darker variant. */
const POOL_COLOR_VARIANT_INDEX = 1; // 0.83× — dark, dried-blood look

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
  const pools: BloodPool[] = [];

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

  /** Redraw a pool at the given progress (0-1 over its full lifetime) and
   * alpha. Cheap — a few filled ellipses per pool. Called from
   * `spawnBloodPool` (initial draw) and every frame from the animation loop
   * once its progress or alpha changes meaningfully.
   */
  function redrawBloodPool(pool: BloodPool, progress: number, alpha: number): void {
    pool.obj.clear();
    pool.obj.fillStyle(pool.color, 1);
    const expandProgress = Math.min(1, progress / BLOOD_POOL_EXPAND_PHASE);
    for (const lobe of pool.lobes) {
      // Each lobe uses its own `growAt` (fraction of the pool's expand phase)
      // as its personal timeline: earlier lobes hit full size while
      // expandProgress is still low, outer lobes take longer to unfurl. This
      // is what makes the pool "keep spreading" — the outline grows as
      // successive lobes reach their targets.
      const lobeProgress = Math.min(1, expandProgress / Math.max(lobe.growAt, 0.001));
      // Cubic ease-out so lobes settle into their final shape rather than
      // snapping to it — reads like blood soaking outward, not popping in.
      const eased = lobe.initialScale + (1 - lobe.initialScale) * (1 - (1 - lobeProgress) ** 3);
      pool.obj.fillEllipse(
        lobe.offsetX,
        lobe.offsetY,
        lobe.targetRx * 2 * eased,
        lobe.targetRy * 2 * eased,
      );
    }
    pool.obj.setAlpha(alpha);
    pool.obj.setScale(1, 1 - (1 - BLOOD_POOL_FINAL_VERTICAL_SCALE) * progress);
    pool.lastProgress = progress;
    pool.lastAlpha = alpha;
  }

  function spawnBloodPool(
    x: number,
    y: number,
    overkill: number,
    baseColor: number,
    renderElapsedMs: number,
  ): void {
    if (cfg.intensity <= 0) return;
    // Blood pools use `scene.add.graphics`, which GoreVfx's PhaserBridge
    // enablement gate does not require (it only checks `add.rectangle`). Guard
    // here so a partial Scene stub / headless scene that provides rectangles
    // but no graphics still gets hit/death particle gore without throwing.
    if (typeof scene.add.graphics !== 'function') return;
    const radius =
      BLOOD_POOL_BASE_RADIUS +
      Math.min(BLOOD_POOL_MAX_EXTRA_RADIUS, overkill * 0.5) * cfg.intensity;
    // Randomise size further so each pool looks distinct
    const sizeVariance = 0.6 + vfxRandom() * 0.9;
    // Slightly squash/stretch pool for organic variation
    const scaleX = (0.8 + vfxRandom() * 0.5) * sizeVariance;
    const scaleY = (0.6 + vfxRandom() * 0.4) * sizeVariance;
    const poolColor = makeColorVariants(baseColor)[POOL_COLOR_VARIANT_INDEX]!; // dark variant for pooled blood

    const baseRx = radius * scaleX;
    const baseRy = radius * scaleY;

    // Build sub-lobes. Each lobe is a smaller ellipse offset from the pool
    // centre; when they overlap and grow at different rates the outline reads
    // as an organic, irregular puddle rather than a smooth mathematical
    // ellipse. The first lobe stays close to the centre so pools always have
    // a well-defined core.
    const lobes: BloodPoolLobe[] = [];
    for (let i = 0; i < BLOOD_POOL_LOBE_COUNT; i++) {
      const isCore = i === 0;
      const lobeAngle = vfxRandom() * Math.PI * 2;
      const lobeRadius = isCore ? 0 : (0.25 + vfxRandom() * 0.55) * Math.min(baseRx, baseRy);
      const rxJitter = 0.55 + vfxRandom() * 0.5;
      const ryJitter = 0.55 + vfxRandom() * 0.5;
      lobes.push({
        offsetX: Math.cos(lobeAngle) * lobeRadius,
        offsetY: Math.sin(lobeAngle) * lobeRadius,
        targetRx: baseRx * (isCore ? 1.0 : rxJitter),
        targetRy: baseRy * (isCore ? 1.0 : ryJitter),
        // Stagger growth: the core lobe grows fastest (growAt low) so the
        // pool has an anchor early; outer lobes finish later so the pool
        // visibly continues to spread through most of the expand phase.
        growAt: isCore ? 0.35 : 0.55 + vfxRandom() * 0.45,
        // The core lobe is the anchor visible on the very first frame at
        // its `INITIAL_SCALE`. Outer lobes start at 0 and grow outward so
        // the pool doesn't materialise already-spread on frame 0.
        initialScale: isCore ? BLOOD_POOL_INITIAL_SCALE : 0,
      });
    }

    // x/y are world feet; scale to pixels for the rendering layer.
    const graphics = scene.add.graphics({
      x: ftToPx(x) + (vfxRandom() - 0.5) * 6,
      y: ftToPx(y) + (vfxRandom() - 0.5) * 4,
    });
    graphics.setDepth(WORLD_VFX_DEPTH.bloodPool);
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(graphics);

    // Evict oldest pool if cap is exceeded
    if (pools.length >= MAX_BLOOD_POOLS) {
      const evicted = pools.shift()!;
      evicted.obj.destroy();
    }

    const pool: BloodPool = {
      obj: graphics,
      color: poolColor,
      lobes,
      startMs: renderElapsedMs,
      lastProgress: -1,
      lastAlpha: -1,
    };
    // Draw the initial (small) pool so it appears immediately.
    redrawBloodPool(pool, 0, 0.55);
    pools.push(pool);
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

    // Leave a persistent blood pool on the ground
    spawnBloodPool(
      spawnX,
      spawnY,
      overkill,
      event.bloodColor !== undefined ? event.bloodColor : DEFAULT_BLOOD_COLOR,
      renderElapsedMs,
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

      // Animate blood pools: expand irregularly across `BLOOD_POOL_EXPAND_PHASE`
      // and fade slowly over the remainder of the lifetime.
      for (let i = pools.length - 1; i >= 0; i--) {
        const pool = pools[i]!;
        const age = renderElapsedMs - pool.startMs;
        const progress = Math.min(1, age / BLOOD_POOL_LIFETIME_MS);

        if (progress >= 1) {
          pool.obj.destroy();
          pools.splice(i, 1);
          continue;
        }

        // Gentle fade: start at 0.55 alpha, finish at 0
        const alpha = 0.55 * (1 - progress);

        // Only redraw if progress or alpha has drifted enough to matter. Over
        // the ~30 s lifetime a 16 ms frame advances progress by only ~0.0005
        // and alpha by ~0.0003, both under the 0.001 threshold, so neither
        // crosses it in a single frame. Progress is the faster driver and its
        // accumulation passes 0.001 after ~2 frames, so a pool redraws roughly
        // every other frame. The guard skips those redundant redraws and keeps
        // the door open for future optimisations (skip full lobe re-eval when
        // the eased scales haven't shifted).
        if (
          Math.abs(progress - pool.lastProgress) > 0.001 ||
          Math.abs(alpha - pool.lastAlpha) > 0.001
        ) {
          redrawBloodPool(pool, progress, alpha);
        }
      }
    },

    destroy(): void {
      for (const p of particles) {
        p.obj.destroy();
      }
      particles.length = 0;
      for (const pool of pools) {
        pool.obj.destroy();
      }
      pools.length = 0;
    },
  };
}
