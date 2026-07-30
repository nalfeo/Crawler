/**
 * Mob-ability VFX renderer — procedural presentation for currently implemented
 * boss abilities (Queen Mab Verdigris Glamour, Big Panda Wei Berserk,
 * Big Mama Bufo Tongue Repossession, Sovereign Cap Spore Bloom,
 * King Skritt Roman-Candle Coronation, and Don Paco's THE BIG GOB).
 *
 * Reads from committed public state:
 *   - `world.mobAbilities.cues` — the telegraph cue rebuilt each tick by the
 *     core executor (position/geometry locked at telegraph start, never tracked
 *     after). This renderer only ever reads that committed geometry, so the
 *     drawn danger footprint can never disagree with the resolution hitbox.
 *   - `world.mobAbilities.pendingBursts` — a presentation-event queue drained
 *     by this renderer via `shift()`. This is the single intentional write-back
 *     into `world`: the runtime enqueues committed geometry here at resolution
 *     and the renderer consumes (empties) the queue each tick so each burst
 *     fires exactly once per cast.
 *   - `world.statusEffectsByEntity` — Tarnished indicator for any entity
 *     carrying a `mob-ability:`-sourced effect.
 *
 * Every required visual state is procedural (no generated art, no textures):
 * cast-start cue, locked hostile-red telegraph circle with the exact 12ft
 * footprint, a countdown/anticipation fill, a resolution burst with gratuitous
 * particles, a persistent Tarnished indicator, and a cleanup/expiry poof. The
 * announcement itself is rendered by `HudAnnouncementBanner`.
 */
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  BAMBOO_FED_BERSERK_ABILITY_ID,
  ROMAN_CANDLE_CORONATION_ABILITY_ID,
  DON_PACO_BIG_GOB_ABILITY_ID,
  SOVEREIGN_SPORE_BLOOM_ABILITY_ID,
  circlesForMobAbilityGeometry,
  getMobAbilityActiveAura,
  getStatusEffects,
} from '../core/index.js';
import type { MobAbilityCuePhase } from '../core/mob-abilities/types.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import { ftToPx } from '../shared/units.js';

/** Prefix of every `sourceId` produced by `mobAbilitySourceId()` in core. */
const MOB_ABILITY_SOURCE_PREFIX = 'mob-ability:';

// Ground-plane depths: below living entities (0) but above terrain/trails so the
// danger circle reads as painted on the floor beneath the fight.
const TELEGRAPH_DEPTH = -14;
const TARNISH_DEPTH = -13;
const SLICK_DEPTH = -12;
const PROJECTILE_DEPTH = -11;
const BURST_DEPTH = WORLD_VFX_DEPTH.spellCast;

const COLOR_HOSTILE_RED = 0xef4444;
const COLOR_CROWN_RUNE = 0xffd166;
const COLOR_MOLTEN_ORANGE = 0xff8c00;
const COLOR_EMBER_GOLD = 0xffcc44;
const COLOR_CHAR_SMOKE = 0x888888;
const COLOR_VERDIGRIS = 0x3fbf7f;
const COLOR_BRONZE = 0xb08d57;
const COLOR_SEWER_GREEN = 0x22c55e;
const COLOR_SICKLY_MIST = 0x65a30d;
const COLOR_TARNISH_RING = 0x5fb89a;
const UNDERCITY_MOB_CALL_ABILITY_ID = 'plague-boss-squick-undercity-mob-call';
const COLOR_BERSERK_GREEN = 0x59c36a;
const COLOR_BERSERK_GOLD = 0xf4c542;
const COLOR_BERSERK_RED = 0xff4d4d;
const COLOR_BERSERK_DUST = 0xc98b56;
const COLOR_BERSERK_ENVELOPE = 0xff6b6b;
const COLOR_BERSERK_LEAF = 0x8bd17c;
const COLOR_TONGUE_FLESH = 0xff8c82;
const COLOR_TONGUE_MUCUS = 0xb7f171;
const COLOR_TONGUE_SWAMP = 0x6ea54d;
const COLOR_TONGUE_DUST = 0xb98a5c;
const COLOR_SPORE_RIM = 0xc4f36b;
const COLOR_SPORE_FOG = 0x5b7f44;
const COLOR_SPORE_PUFF = 0xe8ffb5;
const COLOR_GOB_TRAIL = 0x7cff4f;
const COLOR_GOB_SLIME = 0x39d353;
const COLOR_GOB_STEAM = 0xb7ff80;
const COLOR_SAW_ORANGE = 0xff8c42;
const COLOR_SAW_SMOKE = 0x6b7280;
const COLOR_SAW_STEAM = 0xd1d5db;

const BURST_LIFETIME_MS = 560;
const CAST_START_LIFETIME_MS = 320;
const CLEANUP_LIFETIME_MS = 300;
const CROWN_RUNE_COUNT = 8;
const BURST_SPARK_COUNT = 18;
const SAW_TRAIL_LIFETIME_MS = 180;
const UNDERCITY_BURST_SPARK_COUNT = 24;
const CORONATION_BURST_SPARK_COUNT = 28;
const TONGUE_REPOSSESSION_ABILITY_ID = 'big-mama-bufo-tongue-repossession';

export function createMobAbilityVfx(scene: Phaser.Scene): {
  update(world: GameWorld): void;
  destroy(): void;
} {
  const enabled =
    typeof scene.add?.graphics === 'function' &&
    typeof scene.add?.circle === 'function' &&
    typeof scene.tweens?.add === 'function';
  const canAddRectangle = typeof scene.add?.rectangle === 'function';
  const canAddEllipse = typeof scene.add?.ellipse === 'function';

  const telegraphGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const sawGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const tarnishGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const tarnishLastPos = new Map<number, { x: number; y: number }>();
  const berserkAuraGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const berserkAuraSeen = new Set<number>();
  const berserkAuraLastPos = new Map<number, { x: number; y: number }>();
  const berserkAuraLastPulseFrame = new Map<number, number>();
  const cloudZoneGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const lastGeom = new Map<number, { x: number; y: number; r: number }>();
  const coronationProjectileLastPos = new Map<number, { x: number; y: number }>();
  const lastCuePhase = new Map<number, MobAbilityCuePhase>();
  /** Last pixel position at which continuous saw-trail particles were emitted, per caster EID. */
  const lastSawTrailPos = new Map<number, { x: number; y: number }>();
  const castStartSeen = new Set<number>();
  let projectileGfx: Phaser.GameObjects.Graphics | undefined;
  let slickGfx: Phaser.GameObjects.Graphics | undefined;
  const slickLastGeom = new Map<string, { x: number; y: number; r: number }>();
  /**
   * Transient circles created by spawnRing/spawnBurst/spawnCastStart.
   * Each entry is removed by its `onComplete` callback when the tween finishes
   * naturally — so under normal gameplay the sets stay small. destroy() kills any
   * in-flight tweens and destroys their circles for scene-reset / shutdown safety.
   */
  const transientCircles = new Set<Phaser.GameObjects.Shape>();
  /** Tweens driving transient circles. Each entry is also removed on `onComplete`. */
  const transientTweens = new Map<Phaser.GameObjects.Shape, Phaser.Tweens.Tween>();

  function ignoreUi(obj: Phaser.GameObjects.GameObject & { setDepth(d: number): unknown }): void {
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(obj);
  }

  /** A short-lived expanding ring that destroys itself on completion. */
  function spawnRing(
    x: number,
    y: number,
    fromR: number,
    toR: number,
    color: number,
    lifetimeMs: number,
    depth: number,
  ): void {
    if (!enabled) return;
    const ring = scene.add.circle(x, y, fromR);
    ring.setStrokeStyle(3, color, 1);
    ring.setFillStyle(color, 0.12);
    ring.setDepth(depth);
    ring.setBlendMode('ADD');
    ignoreUi(ring);
    transientCircles.add(ring);
    const tween = scene.tweens.add({
      targets: ring,
      radius: toR,
      alpha: { from: 1, to: 0 },
      duration: lifetimeMs,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        transientCircles.delete(ring);
        transientTweens.delete(ring);
        ring.destroy();
      },
    });
    transientTweens.set(ring, tween);
  }

  /** Render-only spark spray for burst effects. */
  function spawnSparkBurst(
    x: number,
    y: number,
    radiusPx: number,
    colors: readonly [number, number],
    count: number,
  ): void {
    if (!enabled) return;
    // Render-only RNG (never touches the simulation).
    let seed = (Math.floor(x) * 73856093) ^ (Math.floor(y) * 19349663) ^ 0x9e3779b9;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 2147483647;
    };
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + rand() * 0.3;
      const dist = radiusPx * (0.6 + rand() * 0.8);
      const spark = scene.add.circle(x, y, 2 + rand() * 2, i % 2 === 0 ? colors[0] : colors[1]);
      spark.setDepth(BURST_DEPTH);
      spark.setBlendMode('ADD');
      ignoreUi(spark);
      transientCircles.add(spark);
      const tween = scene.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: { from: 1, to: 0 },
        scale: { from: 1, to: 0.2 },
        duration: BURST_LIFETIME_MS * (0.7 + rand() * 0.4),
        ease: 'Quad.easeOut',
        onComplete: () => {
          transientCircles.delete(spark);
          transientTweens.delete(spark);
          spark.destroy();
        },
      });
      transientTweens.set(spark, tween);
    }
  }

  /** Gratuitous verdigris/bronze sparks flying outward from the detonation. */
  function spawnBurst(x: number, y: number, radiusPx: number): void {
    if (!enabled) return;
    spawnRing(
      x,
      y,
      radiusPx * 0.4,
      radiusPx * 1.25,
      COLOR_VERDIGRIS,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnRing(x, y, radiusPx * 0.2, radiusPx, COLOR_BRONZE, BURST_LIFETIME_MS, BURST_DEPTH);
    spawnSparkBurst(x, y, radiusPx, [COLOR_VERDIGRIS, COLOR_BRONZE] as const, BURST_SPARK_COUNT);
  }

  /** Squick-specific sewer-green burst for UNDERCITY MOB CALL resolutions. */
  function spawnUndercityBurst(x: number, y: number, radiusPx: number): void {
    if (!enabled) return;
    spawnRing(
      x,
      y,
      radiusPx * 0.55,
      radiusPx * 1.35,
      COLOR_SEWER_GREEN,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnRing(
      x,
      y,
      radiusPx * 0.25,
      radiusPx * 1.05,
      COLOR_SICKLY_MIST,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnRing(x, y, radiusPx * 0.05, radiusPx * 0.45, COLOR_BRONZE, BURST_LIFETIME_MS, BURST_DEPTH);
    spawnSparkBurst(
      x,
      y,
      radiusPx,
      [COLOR_SEWER_GREEN, COLOR_SICKLY_MIST] as const,
      UNDERCITY_BURST_SPARK_COUNT,
    );
  }

  function spawnBigGobBurst(x: number, y: number, radiusPx: number): void {
    if (!enabled) return;
    spawnRing(
      x,
      y,
      radiusPx * 0.35,
      radiusPx * 1.45,
      COLOR_GOB_TRAIL,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnRing(
      x,
      y,
      radiusPx * 0.15,
      radiusPx * 1.1,
      COLOR_GOB_STEAM,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnSparkBurst(x, y, radiusPx * 1.1, [COLOR_GOB_TRAIL, COLOR_GOB_STEAM] as const, 26);
  }

  /** Sovereign Cap–specific fungal puff burst for SPORE BLOOM resolutions. */
  function spawnSporeBurst(x: number, y: number, radiusPx: number): void {
    if (!enabled) return;
    spawnRing(
      x,
      y,
      radiusPx * 0.5,
      radiusPx * 1.3,
      COLOR_SPORE_RIM,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnRing(
      x,
      y,
      radiusPx * 0.2,
      radiusPx * 0.9,
      COLOR_SPORE_FOG,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    spawnSparkBurst(
      x,
      y,
      radiusPx,
      [COLOR_SPORE_PUFF, COLOR_SPORE_RIM] as const,
      BURST_SPARK_COUNT,
    );
  }

  /** A quick pulse when a telegraph first locks (cast-start cue). */
  function spawnCastStart(x: number, y: number, radiusPx: number): void {
    spawnRing(
      x,
      y,
      radiusPx * 1.3,
      radiusPx,
      COLOR_HOSTILE_RED,
      CAST_START_LIFETIME_MS,
      BURST_DEPTH,
    );
  }

  /** Redraw one locked telegraph circle: footprint, anticipation fill, runes. */
  function drawTelegraph(
    gfx: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    radiusPx: number,
    progress: number,
    dangerColor: 'ability-theme' | 'hostile-red',
  ): void {
    if (dangerColor === 'ability-theme') {
      const pulse = 0.75 + 0.25 * Math.sin(progress * Math.PI * 2);
      gfx.lineStyle(2 + 2 * progress, COLOR_BERSERK_RED, 0.65 + 0.25 * pulse);
      gfx.strokeCircle(cx, cy, radiusPx);
      gfx.lineStyle(2, COLOR_BERSERK_GOLD, 0.8);
      gfx.strokeCircle(cx, cy, radiusPx * (0.4 + 0.5 * progress));
      gfx.fillStyle(COLOR_BERSERK_GREEN, 0.12 + 0.18 * progress);
      gfx.fillCircle(cx, cy, radiusPx * (0.25 + 0.55 * progress));
      return;
    }
    // Committed footprint outline (hostile red), urgency-pulsing thickness.
    const thickness = 2 + 2 * progress;
    gfx.lineStyle(thickness, COLOR_HOSTILE_RED, 0.9);
    gfx.strokeCircle(cx, cy, radiusPx);
    // Interior anticipation fill growing toward detonation.
    gfx.fillStyle(COLOR_HOSTILE_RED, 0.1 + 0.25 * progress);
    gfx.fillCircle(cx, cy, radiusPx * progress);
    // Crown-point runes around the rim (procedural spokes).
    gfx.lineStyle(2, COLOR_CROWN_RUNE, 0.5 + 0.5 * progress);
    for (let i = 0; i < CROWN_RUNE_COUNT; i += 1) {
      const a = (i / CROWN_RUNE_COUNT) * Math.PI * 2;
      const ix = cx + Math.cos(a) * radiusPx;
      const iy = cy + Math.sin(a) * radiusPx;
      const ox = cx + Math.cos(a) * (radiusPx + 6);
      const oy = cy + Math.sin(a) * (radiusPx + 6);
      gfx.lineBetween(ix, iy, ox, oy);
    }
  }

  function drawLaneTelegraph(
    gfx: Phaser.GameObjects.Graphics,
    originX: number,
    originY: number,
    endX: number,
    endY: number,
    widthPx: number,
    progress: number,
    dangerColor: 'ability-theme' | 'hostile-red',
  ): void {
    const dx = endX - originX;
    const dy = endY - originY;
    const len = Math.hypot(dx, dy);
    if (len <= Number.EPSILON) return;
    const nx = -dy / len;
    const ny = dx / len;
    const halfW = widthPx * 0.5;
    const left0x = originX + nx * halfW;
    const left0y = originY + ny * halfW;
    const right0x = originX - nx * halfW;
    const right0y = originY - ny * halfW;
    const left1x = endX + nx * halfW;
    const left1y = endY + ny * halfW;
    const right1x = endX - nx * halfW;
    const right1y = endY - ny * halfW;
    const fillColor = dangerColor === 'ability-theme' ? COLOR_BERSERK_GREEN : COLOR_HOSTILE_RED;
    const railColor = dangerColor === 'ability-theme' ? COLOR_BERSERK_RED : COLOR_HOSTILE_RED;
    gfx.fillStyle(fillColor, 0.12 + 0.28 * progress);
    gfx.beginPath();
    gfx.moveTo(left0x, left0y);
    gfx.lineTo(left1x, left1y);
    gfx.lineTo(right1x, right1y);
    gfx.lineTo(right0x, right0y);
    gfx.closePath();
    gfx.fillPath();
    gfx.lineStyle(2 + 2 * progress, railColor, 0.92);
    gfx.lineBetween(left0x, left0y, left1x, left1y);
    gfx.lineBetween(right0x, right0y, right1x, right1y);
    gfx.lineStyle(2, COLOR_CROWN_RUNE, 0.45 + 0.4 * progress);
    gfx.lineBetween(originX, originY, endX, endY);
  }

  function drawProjectileFanTelegraph(
    gfx: Phaser.GameObjects.Graphics,
    cue: GameWorld['mobAbilities']['cues'][number],
  ): void {
    if (cue.geometry.kind !== 'projectile-fan') return;
    const originX = ftToPx(cue.geometry.originX);
    const originY = ftToPx(cue.geometry.originY);
    gfx.lineStyle(2 + cue.telegraphProgress * 2, COLOR_HOSTILE_RED, 0.9);
    for (const path of cue.geometry.paths) {
      gfx.lineBetween(originX, originY, ftToPx(path.endX), ftToPx(path.endY));
      gfx.strokeCircle(ftToPx(path.endX), ftToPx(path.endY), ftToPx(path.impactRadiusFt));
      gfx.fillStyle(COLOR_HOSTILE_RED, 0.06 + cue.telegraphProgress * 0.12);
      gfx.fillCircle(
        ftToPx(path.endX),
        ftToPx(path.endY),
        ftToPx(path.impactRadiusFt) * cue.telegraphProgress,
      );
    }
    const halfAngleRad = (cue.geometry.coneAngleDeg * Math.PI) / 360;
    const leftRad = cue.geometry.facingRad - halfAngleRad;
    const rightRad = cue.geometry.facingRad + halfAngleRad;
    gfx.lineBetween(
      originX,
      originY,
      originX + Math.cos(leftRad) * ftToPx(cue.geometry.rangeFt),
      originY + Math.sin(leftRad) * ftToPx(cue.geometry.rangeFt),
    );
    gfx.lineBetween(
      originX,
      originY,
      originX + Math.cos(rightRad) * ftToPx(cue.geometry.rangeFt),
      originY + Math.sin(rightRad) * ftToPx(cue.geometry.rangeFt),
    );
    const arcSteps = Math.max(8, cue.geometry.paths.length * 3);
    for (let i = 0; i < arcSteps; i += 1) {
      const a0 = leftRad + ((rightRad - leftRad) * i) / arcSteps;
      const a1 = leftRad + ((rightRad - leftRad) * (i + 1)) / arcSteps;
      gfx.lineBetween(
        originX + Math.cos(a0) * ftToPx(cue.geometry.rangeFt),
        originY + Math.sin(a0) * ftToPx(cue.geometry.rangeFt),
        originX + Math.cos(a1) * ftToPx(cue.geometry.rangeFt),
        originY + Math.sin(a1) * ftToPx(cue.geometry.rangeFt),
      );
    }
    gfx.fillStyle(COLOR_GOB_TRAIL, 0.18 + cue.telegraphProgress * 0.12);
    gfx.fillCircle(originX, originY, ftToPx(1.1 + cue.telegraphProgress * 0.4));
    for (let i = 0; i < 3; i += 1) {
      const a = cue.geometry.facingRad + (i - 1) * 0.35;
      gfx.fillStyle(COLOR_GOB_STEAM, 0.4 + cue.telegraphProgress * 0.2);
      gfx.fillCircle(
        originX + Math.cos(a) * ftToPx(1.2 + cue.telegraphProgress * 0.4),
        originY + Math.sin(a) * ftToPx(1.2 + cue.telegraphProgress * 0.4),
        2 + cue.telegraphProgress * 2,
      );
    }
  }

  /** Redraw the persistent Tarnished indicator under a debuffed entity. */
  function drawTarnish(gfx: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
    gfx.clear();
    gfx.lineStyle(2, COLOR_TARNISH_RING, 0.85);
    gfx.strokeCircle(cx, cy, ftToPx(1.4));
    // Corroded flecks around the ring.
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      gfx.fillStyle(COLOR_BRONZE, 0.8);
      gfx.fillCircle(cx + Math.cos(a) * ftToPx(1.4), cy + Math.sin(a) * ftToPx(1.4), 2);
    }
  }

  function drawBerserkAura(
    gfx: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    radiusPx: number,
  ): void {
    gfx.clear();
    gfx.lineStyle(3, COLOR_BERSERK_RED, 0.8);
    gfx.strokeCircle(cx, cy, radiusPx);
    gfx.lineStyle(2, COLOR_BERSERK_GOLD, 0.85);
    gfx.strokeCircle(cx, cy, radiusPx * 0.7);
    gfx.fillStyle(COLOR_BERSERK_GREEN, 0.16);
    gfx.fillCircle(cx, cy, radiusPx * 0.5);
  }

  function drawSporeCloudCircle(
    gfx: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    radiusPx: number,
    lifeProgress: number,
  ): void {
    const alpha = 0.22 + 0.08 * Math.sin(lifeProgress * Math.PI * 4);
    gfx.lineStyle(3, COLOR_SPORE_RIM, 0.75 + 0.15 * Math.sin(lifeProgress * Math.PI * 6));
    gfx.strokeCircle(cx, cy, radiusPx);
    gfx.lineStyle(2, COLOR_SPORE_FOG, 0.45);
    gfx.strokeCircle(cx, cy, radiusPx * 0.8);
    gfx.fillStyle(COLOR_SPORE_FOG, alpha);
    gfx.fillCircle(cx, cy, radiusPx * 0.92);
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2 + lifeProgress * Math.PI * 2;
      gfx.fillStyle(COLOR_SPORE_PUFF, 0.28);
      gfx.fillCircle(cx + Math.cos(a) * radiusPx * 0.52, cy + Math.sin(a) * radiusPx * 0.52, 2.5);
    }
  }

  function makeDeterministicRand(seedBase: number): () => number {
    let seed = seedBase & 0x7fffffff;
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 2147483647;
    };
  }

  /** Render the travelling saw blade at its current lane position. */
  function drawSaw(
    gfx: Phaser.GameObjects.Graphics,
    projectileX: number,
    projectileY: number,
    phase: 'outbound' | 'hold' | 'return',
  ): void {
    const px = ftToPx(projectileX);
    const py = ftToPx(projectileY);
    const radius = ftToPx(1.2);
    gfx.clear();
    gfx.fillStyle(COLOR_BRONZE, 0.95);
    gfx.fillCircle(px, py, radius);
    gfx.lineStyle(2, COLOR_SAW_ORANGE, phase === 'hold' ? 1 : 0.85);
    gfx.strokeCircle(px, py, radius + 2);
    gfx.lineStyle(2, COLOR_HOSTILE_RED, 0.8);
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      gfx.beginPath();
      gfx.moveTo(px, py);
      gfx.lineTo(px + Math.cos(a) * (radius + 3), py + Math.sin(a) * (radius + 3));
      gfx.strokePath();
    }
  }

  /** One-shot ring + smoke puff emitted when the saw changes phase. */
  function spawnSawFlair(
    x: number,
    y: number,
    radiusPx: number,
    smokeColor: number,
    sparkColor: number,
  ): void {
    if (!enabled) return;
    spawnRing(x, y, radiusPx * 0.4, radiusPx * 1.1, sparkColor, SAW_TRAIL_LIFETIME_MS, BURST_DEPTH);
    const smoke = scene.add.circle(x, y, radiusPx * 0.32, smokeColor, 0.24);
    smoke.setDepth(BURST_DEPTH);
    smoke.setBlendMode('ADD');
    ignoreUi(smoke);
    transientCircles.add(smoke);
    const tween = scene.tweens.add({
      targets: smoke,
      alpha: { from: 0.24, to: 0 },
      scale: { from: 1, to: 1.8 },
      duration: SAW_TRAIL_LIFETIME_MS,
      ease: 'Quad.easeOut',
      onComplete: () => {
        transientCircles.delete(smoke);
        transientTweens.delete(smoke);
        smoke.destroy();
      },
    });
    transientTweens.set(smoke, tween);
  }

  /**
   * Emit a small burst of continuous trail particles as the saw travels.
   * Called every tick during outbound/return; uses a deterministic LCG seeded
   * by position so that headless / visual runs produce identical emission
   * patterns.
   */
  function spawnSawTrailParticle(x: number, y: number, seed: number): void {
    if (!enabled) return;
    const rand = makeDeterministicRand(seed);
    const spark = scene.add.circle(x, y, 2 + rand() * 2, COLOR_SAW_ORANGE, 0.7 + rand() * 0.25);
    spark.setDepth(BURST_DEPTH);
    spark.setBlendMode('ADD');
    ignoreUi(spark);
    transientCircles.add(spark);
    const angle = rand() * Math.PI * 2;
    const dist = 4 + rand() * 8;
    const sparkTween = scene.tweens.add({
      targets: spark,
      x: x + Math.cos(angle) * dist,
      y: y + Math.sin(angle) * dist,
      alpha: { from: 0.9, to: 0 },
      scale: { from: 1, to: 0.3 },
      duration: 80 + rand() * 60,
      ease: 'Quad.easeOut',
      onComplete: () => {
        transientCircles.delete(spark);
        transientTweens.delete(spark);
        spark.destroy();
      },
    });
    transientTweens.set(spark, sparkTween);
    if (rand() < 0.35) {
      const frag = canAddRectangle
        ? scene.add.rectangle(x, y, 2 + rand() * 2, 4 + rand() * 3, COLOR_BRONZE)
        : scene.add.circle(x, y, 1 + rand(), COLOR_BRONZE);
      frag.setAngle?.(rand() * 360);
      frag.setDepth(BURST_DEPTH);
      frag.setBlendMode('ADD');
      ignoreUi(frag);
      transientCircles.add(frag);
      const fragAngle = rand() * Math.PI * 2;
      const fragDist = 6 + rand() * 14;
      const fragTween = scene.tweens.add({
        targets: frag,
        x: x + Math.cos(fragAngle) * fragDist,
        y: y + Math.sin(fragAngle) * fragDist,
        alpha: { from: 0.8, to: 0 },
        scale: { from: 1, to: 0.2 },
        duration: 140 + rand() * 100,
        ease: 'Sine.easeOut',
        onComplete: () => {
          transientCircles.delete(frag);
          transientTweens.delete(frag);
          frag.destroy();
        },
      });
      transientTweens.set(frag, fragTween);
    }
  }

  /** Draw + emit the kill-saw visuals for one lane cue in an active phase. */
  function updateSawVisuals(cue: {
    casterEid: number;
    phase: MobAbilityCuePhase;
    projectileX?: number;
    projectileY?: number;
  }): void {
    let saw = sawGfx.get(cue.casterEid);
    const previousPhase = lastCuePhase.get(cue.casterEid);
    lastCuePhase.set(cue.casterEid, cue.phase);
    if (cue.phase === 'telegraph') {
      saw?.clear();
      lastSawTrailPos.delete(cue.casterEid);
      return;
    }
    if (cue.projectileX === undefined || cue.projectileY === undefined) return;
    if (!enabled) return;
    if (saw === undefined) {
      saw = scene.add.graphics();
      saw.setDepth(BURST_DEPTH);
      saw.setBlendMode('ADD');
      ignoreUi(saw);
      sawGfx.set(cue.casterEid, saw);
    }
    drawSaw(saw, cue.projectileX, cue.projectileY, cue.phase);
    const px = ftToPx(cue.projectileX);
    const py = ftToPx(cue.projectileY);
    if (previousPhase !== cue.phase) {
      if (cue.phase === 'outbound') {
        spawnSawFlair(px, py, ftToPx(1.2), COLOR_SAW_STEAM, COLOR_SAW_ORANGE);
      } else if (cue.phase === 'hold') {
        spawnSawFlair(px, py, ftToPx(1.5), COLOR_SAW_SMOKE, COLOR_HOSTILE_RED);
      } else {
        spawnSawFlair(px, py, ftToPx(1.2), COLOR_SAW_STEAM, COLOR_CROWN_RUNE);
      }
    }
    if (cue.phase === 'outbound' || cue.phase === 'return') {
      const prior = lastSawTrailPos.get(cue.casterEid);
      const trailStepPx = ftToPx(0.5);
      if (prior === undefined || (px - prior.x) ** 2 + (py - prior.y) ** 2 >= trailStepPx ** 2) {
        const seed = (cue.casterEid * 7919 + Math.round(px) * 31 + Math.round(py)) | 0;
        spawnSawTrailParticle(px, py, seed);
        lastSawTrailPos.set(cue.casterEid, { x: px, y: py });
      }
    } else {
      lastSawTrailPos.delete(cue.casterEid);
    }
  }

  function spawnBerserkFlair(x: number, y: number, radiusPx: number, seedBase: number): void {
    if (!enabled) return;
    const rand = makeDeterministicRand(seedBase);
    for (let i = 0; i < 4; i += 1) {
      const angle = rand() * Math.PI * 2;
      const dist = radiusPx * (0.3 + rand() * 1.1);
      const particle = canAddRectangle
        ? scene.add.rectangle(x, y, 2 + rand() * 2, 7 + rand() * 6, COLOR_BERSERK_GREEN)
        : scene.add.circle(x, y, 2 + rand() * 0.8, COLOR_BERSERK_GREEN);
      particle.setAngle?.((angle * 180) / Math.PI);
      particle.setDepth(BURST_DEPTH);
      particle.setBlendMode('ADD');
      ignoreUi(particle);
      transientCircles.add(particle);
      const tween = scene.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: { from: 0.95, to: 0 },
        scale: { from: 1, to: 0.1 },
        duration: 200 + rand() * 260,
        ease: 'Quad.easeOut',
        onComplete: () => {
          transientCircles.delete(particle);
          transientTweens.delete(particle);
          particle.destroy();
        },
      });
      transientTweens.set(particle, tween);
    }
    for (let i = 0; i < 3; i += 1) {
      const angle = rand() * Math.PI * 2;
      const dist = radiusPx * (0.25 + rand() * 0.9);
      const particle = canAddEllipse
        ? scene.add.ellipse(x, y, 4 + rand() * 3, 2 + rand() * 2, COLOR_BERSERK_LEAF)
        : scene.add.circle(x, y, 1.5 + rand() * 1.2, COLOR_BERSERK_LEAF);
      particle.setAngle?.((angle * 180) / Math.PI);
      particle.setDepth(BURST_DEPTH);
      particle.setBlendMode('ADD');
      ignoreUi(particle);
      transientCircles.add(particle);
      const tween = scene.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: { from: 0.9, to: 0 },
        scale: { from: 1, to: 0.2 },
        duration: 180 + rand() * 220,
        ease: 'Quad.easeOut',
        onComplete: () => {
          transientCircles.delete(particle);
          transientTweens.delete(particle);
          particle.destroy();
        },
      });
      transientTweens.set(particle, tween);
    }
    for (let i = 0; i < 3; i += 1) {
      const angle = rand() * Math.PI * 2;
      const dist = radiusPx * (0.2 + rand() * 0.8);
      const particle = canAddRectangle
        ? scene.add.rectangle(
            x,
            y,
            3 + rand() * 2,
            3 + rand() * 2,
            i % 2 === 0 ? COLOR_BERSERK_ENVELOPE : COLOR_BERSERK_GOLD,
          )
        : scene.add.circle(
            x,
            y,
            1.8 + rand() * 0.7,
            i % 2 === 0 ? COLOR_BERSERK_ENVELOPE : COLOR_BERSERK_GOLD,
          );
      particle.setAngle?.(rand() * 360);
      particle.setDepth(BURST_DEPTH);
      particle.setBlendMode('ADD');
      ignoreUi(particle);
      transientCircles.add(particle);
      const tween = scene.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: { from: 0.95, to: 0 },
        scale: { from: 1, to: 0.1 },
        duration: 200 + rand() * 260,
        ease: 'Quad.easeOut',
        onComplete: () => {
          transientCircles.delete(particle);
          transientTweens.delete(particle);
          particle.destroy();
        },
      });
      transientTweens.set(particle, tween);
    }
    for (let i = 0; i < 2; i += 1) {
      const angle = rand() * Math.PI * 2;
      const dist = radiusPx * (0.4 + rand() * 0.45);
      const afterimage = scene.add.circle(x, y, radiusPx * 0.18, COLOR_BERSERK_RED, 0.25);
      afterimage.setDepth(BURST_DEPTH);
      afterimage.setBlendMode('ADD');
      ignoreUi(afterimage);
      transientCircles.add(afterimage);
      const tween = scene.tweens.add({
        targets: afterimage,
        x: x - Math.cos(angle) * dist,
        y: y - Math.sin(angle) * dist,
        alpha: { from: 0.25, to: 0 },
        scale: { from: 1, to: 0.65 },
        duration: 150 + rand() * 100,
        ease: 'Sine.easeOut',
        onComplete: () => {
          transientCircles.delete(afterimage);
          transientTweens.delete(afterimage);
          afterimage.destroy();
        },
      });
      transientTweens.set(afterimage, tween);
    }
  }

  function spawnBerserkFootstepDust(
    x: number,
    y: number,
    radiusPx: number,
    seedBase: number,
  ): void {
    if (!enabled) return;
    const rand = makeDeterministicRand(seedBase);
    for (let i = 0; i < 4; i += 1) {
      const angle = rand() * Math.PI * 2;
      const dist = radiusPx * (0.12 + rand() * 0.22);
      const dust = scene.add.circle(x, y, 1 + rand() * 1.6, COLOR_BERSERK_DUST);
      dust.setDepth(BURST_DEPTH);
      dust.setBlendMode('ADD');
      ignoreUi(dust);
      transientCircles.add(dust);
      const tween = scene.tweens.add({
        targets: dust,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: { from: 0.45, to: 0 },
        scale: { from: 1, to: 0.4 },
        duration: 120 + rand() * 120,
        ease: 'Sine.easeOut',
        onComplete: () => {
          transientCircles.delete(dust);
          transientTweens.delete(dust);
          dust.destroy();
        },
      });
      transientTweens.set(dust, tween);
    }
  }

  function trackTransientShape(shape: Phaser.GameObjects.Shape): void {
    transientCircles.add(shape);
  }

  function spawnTongueRepossessionBurst(geom: {
    originX: number;
    originY: number;
    endX: number;
    endY: number;
    dirX: number;
    dirY: number;
    widthFt: number;
  }): void {
    if (!enabled) return;
    const originX = ftToPx(geom.originX);
    const originY = ftToPx(geom.originY);
    const endX = ftToPx(geom.endX);
    const endY = ftToPx(geom.endY);
    const widthPx = ftToPx(geom.widthFt);
    const dx = endX - originX;
    const dy = endY - originY;
    const lengthPx = Math.hypot(dx, dy);
    if (lengthPx <= Number.EPSILON) return;

    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const centerX = originX + dx * 0.5;
    const centerY = originY + dy * 0.5;
    spawnRing(
      originX,
      originY,
      widthPx * 0.25,
      widthPx * 0.95,
      COLOR_HOSTILE_RED,
      220,
      BURST_DEPTH,
    );
    spawnRing(
      endX,
      endY,
      widthPx * 0.35,
      widthPx * 2.2,
      COLOR_HOSTILE_RED,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );

    if (canAddRectangle) {
      const tongue = scene.add.rectangle(
        centerX,
        centerY,
        lengthPx,
        widthPx * 0.82,
        COLOR_TONGUE_FLESH,
      );
      tongue.setAngle?.(angleDeg);
      tongue.setDepth(BURST_DEPTH);
      tongue.setBlendMode('ADD');
      ignoreUi(tongue);
      trackTransientShape(tongue);
      const tween = scene.tweens.add({
        targets: tongue,
        x: originX + dx * 0.34,
        y: originY + dy * 0.34,
        scaleX: { from: 1, to: 0.28 },
        alpha: { from: 0.78, to: 0 },
        duration: BURST_LIFETIME_MS,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          transientCircles.delete(tongue);
          transientTweens.delete(tongue);
          tongue.destroy();
        },
      });
      transientTweens.set(tongue, tween);
    }

    if (canAddRectangle) {
      for (const offset of [0.28, 0.58]) {
        const strip = scene.add.rectangle(
          originX + dx * offset,
          originY + dy * offset,
          lengthPx * 0.22,
          Math.max(2, widthPx * 0.18),
          COLOR_TONGUE_MUCUS,
        );
        strip.setAngle?.(angleDeg);
        strip.setDepth(BURST_DEPTH);
        strip.setBlendMode('ADD');
        ignoreUi(strip);
        trackTransientShape(strip);
        const tween = scene.tweens.add({
          targets: strip,
          alpha: { from: 0.72, to: 0 },
          scaleX: { from: 1, to: 0.18 },
          duration: BURST_LIFETIME_MS * 0.8,
          ease: 'Quad.easeOut',
          onComplete: () => {
            transientCircles.delete(strip);
            transientTweens.delete(strip);
            strip.destroy();
          },
        });
        transientTweens.set(strip, tween);
      }
    }

    for (let i = 1; i <= 4; i += 1) {
      const t = i / 5;
      const dust = scene.add.circle(
        originX + dx * t,
        originY + dy * t,
        Math.max(2, widthPx * 0.16),
      );
      dust.setFillStyle(COLOR_TONGUE_DUST, 0.4);
      dust.setDepth(BURST_DEPTH);
      dust.setBlendMode('ADD');
      ignoreUi(dust);
      trackTransientShape(dust);
      const tween = scene.tweens.add({
        targets: dust,
        x: originX + dx * t - geom.dirY * widthPx * 0.3,
        y: originY + dy * t + geom.dirX * widthPx * 0.3,
        alpha: { from: 0.4, to: 0 },
        scale: { from: 1, to: 0.3 },
        duration: BURST_LIFETIME_MS * 0.55,
        ease: 'Sine.easeOut',
        onComplete: () => {
          transientCircles.delete(dust);
          transientTweens.delete(dust);
          dust.destroy();
        },
      });
      transientTweens.set(dust, tween);
    }

    if (canAddEllipse) {
      for (let i = 0; i < 4; i += 1) {
        const spread = (i - 1.5) * widthPx * 0.25;
        const spray = scene.add.ellipse(
          endX,
          endY,
          widthPx * 0.45,
          widthPx * 0.22,
          COLOR_TONGUE_SWAMP,
        );
        spray.setAngle?.(angleDeg + i * 9 - 13.5);
        spray.setDepth(BURST_DEPTH);
        spray.setBlendMode('ADD');
        ignoreUi(spray);
        trackTransientShape(spray);
        const tween = scene.tweens.add({
          targets: spray,
          x: endX + geom.dirX * widthPx * 0.9 - geom.dirY * spread,
          y: endY + geom.dirY * widthPx * 0.9 + geom.dirX * spread,
          alpha: { from: 0.72, to: 0 },
          scaleX: { from: 1, to: 1.8 },
          scaleY: { from: 1, to: 0.2 },
          duration: BURST_LIFETIME_MS * 0.7,
          ease: 'Quad.easeOut',
          onComplete: () => {
            transientCircles.delete(spray);
            transientTweens.delete(spray);
            spray.destroy();
          },
        });
        transientTweens.set(spray, tween);
      }
    }

    for (let i = 0; i < 3; i += 1) {
      const t = 0.72 + i * 0.12;
      const bubble = scene.add.circle(
        originX + dx * t,
        originY + dy * t,
        Math.max(2.2, widthPx * (0.17 - i * 0.02)),
        COLOR_TONGUE_MUCUS,
      );
      bubble.setDepth(BURST_DEPTH);
      bubble.setBlendMode('ADD');
      ignoreUi(bubble);
      trackTransientShape(bubble);
      const tween = scene.tweens.add({
        targets: bubble,
        x: originX + dx * Math.max(0.18, t - 0.38),
        y: originY + dy * Math.max(0.18, t - 0.38),
        alpha: { from: 0.9, to: 0 },
        scale: { from: 1, to: 0.15 },
        duration: BURST_LIFETIME_MS * 0.65,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          transientCircles.delete(bubble);
          transientTweens.delete(bubble);
          bubble.destroy();
        },
      });
      transientTweens.set(bubble, tween);
    }
  }

  function hasMobAbilityDebuff(world: GameWorld, eid: number): boolean {
    for (const e of getStatusEffects(world, eid)) {
      if (e.sourceId.startsWith(MOB_ABILITY_SOURCE_PREFIX)) return true;
    }
    return false;
  }

  /**
   * Draw twelve hostile-red radial spoke paths for the ROMAN-CANDLE CORONATION
   * telegraph. Each spoke runs from the caster centre to a tip at `spokeLengthPx`
   * in the direction determined by the spoke index and `offsetDeg`.
   * Urgency builds as `progress` approaches 1: lines thicken, alpha rises,
   * and a small arrowhead marks each tip.
   */
  function drawRadialTelegraph(
    gfx: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    count: number,
    spokeLengthPx: number,
    offsetDeg: number,
    progress: number,
  ): void {
    const thickness = 2 + 3 * progress;
    const alpha = 0.7 + 0.3 * progress;
    gfx.lineStyle(thickness, COLOR_HOSTILE_RED, alpha);
    for (let i = 0; i < count; i += 1) {
      const angleDeg = (i / count) * 360 + offsetDeg;
      const angleRad = (angleDeg * Math.PI) / 180;
      const tx = cx + Math.cos(angleRad) * spokeLengthPx;
      const ty = cy + Math.sin(angleRad) * spokeLengthPx;
      gfx.lineBetween(cx, cy, tx, ty);
      // Arrowhead at tip (two short lines converging to the spoke tip).
      const arrowLen = 6 + 4 * progress;
      const arrowAngle = Math.PI / 5;
      gfx.lineBetween(
        tx,
        ty,
        tx - arrowLen * Math.cos(angleRad - arrowAngle),
        ty - arrowLen * Math.sin(angleRad - arrowAngle),
      );
      gfx.lineBetween(
        tx,
        ty,
        tx - arrowLen * Math.cos(angleRad + arrowAngle),
        ty - arrowLen * Math.sin(angleRad + arrowAngle),
      );
    }
    // Crown halo at the caster centre — pulses outward as urgency builds.
    gfx.lineStyle(2, COLOR_CROWN_RUNE, 0.55 + 0.45 * progress);
    gfx.strokeCircle(cx, cy, 6 + 6 * progress);
    // Inner corona fill (very faint, just a glow hint).
    gfx.fillStyle(COLOR_HOSTILE_RED, 0.06 + 0.1 * progress);
    gfx.fillCircle(cx, cy, 5 + 5 * progress);
  }

  /**
   * Gratuitous coronation burst fired at ROMAN-CANDLE CORONATION resolution:
   * crown flame jets, ember halo, upward sparks, molten-orange trails, char
   * flakes, and a central coronation flash.
   */
  function spawnCoronationBurst(cx: number, cy: number, spokeLengthPx: number): void {
    if (!enabled) return;
    // Central coronation flash: expanding crown-gold ring.
    spawnRing(
      cx,
      cy,
      spokeLengthPx * 0.08,
      spokeLengthPx * 0.55,
      COLOR_CROWN_RUNE,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    // Inner molten-orange pulse.
    spawnRing(
      cx,
      cy,
      spokeLengthPx * 0.04,
      spokeLengthPx * 0.3,
      COLOR_MOLTEN_ORANGE,
      BURST_LIFETIME_MS,
      BURST_DEPTH,
    );
    // Hostile-red outer shockwave.
    spawnRing(
      cx,
      cy,
      spokeLengthPx * 0.12,
      spokeLengthPx * 0.75,
      COLOR_HOSTILE_RED,
      BURST_LIFETIME_MS * 0.8,
      BURST_DEPTH,
    );
    // Upward ember sparks from the centre.
    spawnSparkBurst(
      cx,
      cy,
      spokeLengthPx * 0.45,
      [COLOR_EMBER_GOLD, COLOR_MOLTEN_ORANGE] as const,
      CORONATION_BURST_SPARK_COUNT,
    );
    // Char flake haze (desaturated smoke ring).
    spawnRing(
      cx,
      cy,
      spokeLengthPx * 0.1,
      spokeLengthPx * 0.4,
      COLOR_CHAR_SMOKE,
      BURST_LIFETIME_MS * 1.1,
      BURST_DEPTH,
    );
  }

  function update(world: GameWorld): void {
    const runtime = world.mobAbilities;
    const liveCoronationProjectiles = new Set<number>();

    // ── Telegraph circles ──────────────────────────────────────────────────
    const liveCasters = new Set<number>();
    for (const cue of runtime.cues) {
      // ── Radial-projectile spokes (Roman Candle Coronation) ───────────────
      if (cue.geometry.kind === 'radial-projectiles') {
        liveCasters.add(cue.casterEid);
        const geom = cue.geometry;
        const casterCx = ftToPx(geom.casterX);
        const casterCy = ftToPx(geom.casterY);
        const spokeLengthPx = ftToPx(geom.spokeLengthFt);
        lastGeom.set(cue.casterEid, { x: casterCx, y: casterCy, r: spokeLengthPx });
        if (!castStartSeen.has(cue.casterEid)) {
          castStartSeen.add(cue.casterEid);
          spawnCastStart(casterCx, casterCy, spokeLengthPx * 0.25);
        }
        if (!enabled) continue;
        let gfx = telegraphGfx.get(cue.casterEid);
        if (gfx === undefined) {
          gfx = scene.add.graphics();
          gfx.setDepth(TELEGRAPH_DEPTH);
          gfx.setBlendMode('ADD');
          ignoreUi(gfx);
          telegraphGfx.set(cue.casterEid, gfx);
        }
        gfx.clear();
        drawRadialTelegraph(
          gfx,
          casterCx,
          casterCy,
          geom.count,
          spokeLengthPx,
          geom.offsetDeg,
          cue.telegraphProgress,
        );
        continue;
      }

      liveCasters.add(cue.casterEid);
      if (cue.geometry.kind === 'lane') {
        const midX = (cue.geometry.originX + cue.geometry.endX) * 0.5;
        const midY = (cue.geometry.originY + cue.geometry.endY) * 0.5;
        lastGeom.set(cue.casterEid, {
          x: ftToPx(midX),
          y: ftToPx(midY),
          r: ftToPx(cue.geometry.widthFt * 0.5),
        });
      } else {
        const circles = circlesForMobAbilityGeometry(cue.geometry);
        if (circles.length === 0) continue;
        const first = circles[0]!;
        const firstCx = ftToPx(first.x);
        const firstCy = ftToPx(first.y);
        const firstRadiusPx = ftToPx(first.radiusFt);
        lastGeom.set(cue.casterEid, { x: firstCx, y: firstCy, r: firstRadiusPx });
      }
      if (!castStartSeen.has(cue.casterEid)) {
        castStartSeen.add(cue.casterEid);
        if (cue.geometry.kind === 'lane') {
          const cx = ftToPx(cue.geometry.originX);
          const cy = ftToPx(cue.geometry.originY);
          spawnCastStart(cx, cy, ftToPx(cue.geometry.widthFt));
        } else {
          const circles = circlesForMobAbilityGeometry(cue.geometry);
          for (const circle of circles) {
            spawnCastStart(ftToPx(circle.x), ftToPx(circle.y), ftToPx(circle.radiusFt));
          }
        }
      }
      if (!enabled) continue;
      let gfx = telegraphGfx.get(cue.casterEid);
      if (gfx === undefined) {
        gfx = scene.add.graphics();
        gfx.setDepth(TELEGRAPH_DEPTH);
        gfx.setBlendMode('ADD');
        ignoreUi(gfx);
        telegraphGfx.set(cue.casterEid, gfx);
      }
      gfx.clear();
      const circles =
        cue.geometry.kind === 'lane' ? [] : circlesForMobAbilityGeometry(cue.geometry);
      if (cue.geometry.kind === 'lane') {
        drawLaneTelegraph(
          gfx,
          ftToPx(cue.geometry.originX),
          ftToPx(cue.geometry.originY),
          ftToPx(cue.geometry.endX),
          ftToPx(cue.geometry.endY),
          ftToPx(cue.geometry.widthFt),
          cue.telegraphProgress,
          cue.dangerColor,
        );
        updateSawVisuals(cue);
      } else if (cue.geometry.kind === 'projectile-fan') {
        drawProjectileFanTelegraph(gfx, cue);
      } else {
        for (const circle of circles) {
          drawTelegraph(
            gfx,
            ftToPx(circle.x),
            ftToPx(circle.y),
            ftToPx(circle.radiusFt),
            cue.telegraphProgress,
            cue.dangerColor,
          );
        }
      }
    }

    // ── In-flight Don Paco projectiles ──────────────────────────────────────
    if (runtime.activeProjectiles.length > 0) {
      if (projectileGfx === undefined && enabled) {
        projectileGfx = scene.add.graphics();
        projectileGfx.setDepth(PROJECTILE_DEPTH);
        projectileGfx.setBlendMode('ADD');
        ignoreUi(projectileGfx);
      }
      projectileGfx?.clear();
      for (const projectile of runtime.activeProjectiles) {
        if (projectileGfx === undefined) continue;
        const progress = Math.min(
          1,
          Math.max(0, projectile.elapsedMs / projectile.travelDurationMs),
        );
        const currentX =
          projectile.path.startX + (projectile.path.endX - projectile.path.startX) * progress;
        const currentY =
          projectile.path.startY + (projectile.path.endY - projectile.path.startY) * progress;
        projectileGfx.lineStyle(3, COLOR_GOB_TRAIL, 0.8);
        projectileGfx.lineBetween(
          ftToPx(projectile.path.startX),
          ftToPx(projectile.path.startY),
          ftToPx(currentX),
          ftToPx(currentY),
        );
        projectileGfx.fillStyle(COLOR_GOB_TRAIL, 0.95);
        projectileGfx.fillCircle(ftToPx(currentX), ftToPx(currentY), 4);
        projectileGfx.fillStyle(COLOR_GOB_STEAM, 0.35);
        projectileGfx.fillCircle(
          ftToPx(currentX - (projectile.path.endX - projectile.path.startX) * 0.04),
          ftToPx(currentY - (projectile.path.endY - projectile.path.startY) * 0.04),
          2.5,
        );
      }
    } else if (projectileGfx) {
      projectileGfx.destroy();
      projectileGfx = undefined;
    }

    // ── Persistent slick rims ────────────────────────────────────────────────
    if (runtime.activeZones.length > 0) {
      if (slickGfx === undefined && enabled) {
        slickGfx = scene.add.graphics();
        slickGfx.setDepth(SLICK_DEPTH);
        slickGfx.setBlendMode('ADD');
        ignoreUi(slickGfx);
      }
      slickGfx?.clear();
      const nextKeys = new Set<string>();
      for (const zone of runtime.activeZones) {
        const key = `${zone.sourceId}:${zone.circle.x}:${zone.circle.y}`;
        nextKeys.add(key);
        slickLastGeom.set(key, {
          x: ftToPx(zone.circle.x),
          y: ftToPx(zone.circle.y),
          r: ftToPx(zone.circle.radiusFt),
        });
        if (slickGfx === undefined) continue;
        const cx = ftToPx(zone.circle.x);
        const cy = ftToPx(zone.circle.y);
        const radiusPx = ftToPx(zone.circle.radiusFt);
        const bubbleAlpha = 0.35 + 0.15 * Math.sin((zone.remainingMs / 120) % (Math.PI * 2));
        slickGfx.lineStyle(3, COLOR_GOB_STEAM, 0.95);
        slickGfx.strokeCircle(cx, cy, radiusPx);
        slickGfx.lineStyle(2, COLOR_GOB_TRAIL, 0.75);
        slickGfx.strokeCircle(cx, cy, radiusPx * 0.82);
        slickGfx.fillStyle(COLOR_GOB_SLIME, 0.16);
        slickGfx.fillCircle(cx, cy, radiusPx * 0.92);
        for (let i = 0; i < 5; i += 1) {
          const a = (i / 5) * Math.PI * 2 + zone.remainingMs / 600;
          slickGfx.fillStyle(COLOR_GOB_STEAM, bubbleAlpha);
          slickGfx.fillCircle(
            cx + Math.cos(a) * radiusPx * 0.58,
            cy + Math.sin(a) * radiusPx * 0.58,
            2.5,
          );
        }
      }
      for (const [key, geom] of [...slickLastGeom.entries()]) {
        if (nextKeys.has(key)) continue;
        slickLastGeom.delete(key);
        spawnRing(
          geom.x,
          geom.y,
          geom.r,
          geom.r * 0.4,
          COLOR_GOB_STEAM,
          CLEANUP_LIFETIME_MS,
          BURST_DEPTH,
        );
      }
    } else {
      for (const geom of slickLastGeom.values()) {
        spawnRing(
          geom.x,
          geom.y,
          geom.r,
          geom.r * 0.4,
          COLOR_GOB_STEAM,
          CLEANUP_LIFETIME_MS,
          BURST_DEPTH,
        );
      }
      slickLastGeom.clear();
      slickGfx?.destroy();
      slickGfx = undefined;
    }

    // Track Roman Candle projectile positions from authoritative runtime ownership.
    for (const inst of runtime.byEntity.values()) {
      if (inst.definition.abilityId !== ROMAN_CANDLE_CORONATION_ABILITY_ID) continue;
      for (const [eid, generation] of inst.ownedEntityGenerations) {
        if ((world.entityRenderGeneration[eid] ?? -1) !== generation) continue;
        const x = world.stores.position.x[eid];
        const y = world.stores.position.y[eid];
        if (x === undefined || y === undefined) continue;
        liveCoronationProjectiles.add(eid);
        coronationProjectileLastPos.set(eid, { x: ftToPx(x), y: ftToPx(y) });
      }
    }
    // Emit cinders when tracked coronation projectiles actually despawn/collide.
    for (const [eid, lastPos] of [...coronationProjectileLastPos.entries()]) {
      if (liveCoronationProjectiles.has(eid)) continue;
      spawnRing(
        lastPos.x,
        lastPos.y,
        3,
        10,
        COLOR_MOLTEN_ORANGE,
        BURST_LIFETIME_MS * 0.55,
        BURST_DEPTH,
      );
      coronationProjectileLastPos.delete(eid);
    }

    // ── Resolution bursts (drain the durable pending-burst queue) ─────────
    // The core runtime pushes committed geometry here when a cast resolves, so
    // bursts survive even if the caster is cleared (killed/despawned) later in
    // the same simulation step before PhaserBridge.sync runs.
    while (runtime.pendingBursts.length > 0) {
      const burst = runtime.pendingBursts.shift()!;
      if (burst.kind === 'recatch') {
        // Kill-saw re-catch: the blade slams back into the caster's housing.
        const x = ftToPx(burst.x);
        const y = ftToPx(burst.y);
        spawnBurst(x, y, ftToPx(2.4));
        spawnSawFlair(x, y, ftToPx(1.6), COLOR_SAW_SMOKE, COLOR_SAW_ORANGE);
        continue;
      }
      const geom = burst.geometry;
      if (geom.kind === 'radial-projectiles') {
        // Coronation burst: spoke-tip cinders + central flash.
        spawnCoronationBurst(
          ftToPx(geom.casterX),
          ftToPx(geom.casterY),
          ftToPx(geom.spokeLengthFt),
        );
        continue;
      }
      const spawn =
        burst.abilityId === SOVEREIGN_SPORE_BLOOM_ABILITY_ID
          ? spawnSporeBurst
          : burst.abilityId === UNDERCITY_MOB_CALL_ABILITY_ID
            ? spawnUndercityBurst
            : burst.abilityId === DON_PACO_BIG_GOB_ABILITY_ID
              ? spawnBigGobBurst
              : spawnBurst;
      if (geom.kind === 'circle') {
        const cx = ftToPx(geom.x);
        const cy = ftToPx(geom.y);
        const r = ftToPx(geom.radiusFt);
        spawn(cx, cy, r);
      } else if (geom.kind === 'spawn-circles' || geom.kind === 'multi-circle') {
        for (const circle of geom.circles) {
          spawn(ftToPx(circle.x), ftToPx(circle.y), ftToPx(circle.radiusFt));
        }
      } else if (geom.kind === 'lane') {
        if (burst.abilityId === TONGUE_REPOSSESSION_ABILITY_ID) {
          spawnTongueRepossessionBurst(geom);
        } else {
          spawn(ftToPx(geom.endX), ftToPx(geom.endY), ftToPx(geom.widthFt * 1.8));
        }
      } else {
        for (const circle of circlesForMobAbilityGeometry(geom)) {
          spawn(ftToPx(circle.x), ftToPx(circle.y), ftToPx(circle.radiusFt));
        }
      }
    }

    // ── Runtime-owned persistent cloud zones (Sovereign Cap) ───────────────
    const liveZones = new Set<number>();
    for (const zone of runtime.ownedZones) {
      if (zone.abilityId !== SOVEREIGN_SPORE_BLOOM_ABILITY_ID) continue;
      liveZones.add(zone.id);
      if (!enabled) continue;
      let gfx = cloudZoneGfx.get(zone.id);
      if (gfx === undefined) {
        gfx = scene.add.graphics();
        gfx.setDepth(TELEGRAPH_DEPTH);
        gfx.setBlendMode('ADD');
        ignoreUi(gfx);
        cloudZoneGfx.set(zone.id, gfx);
      }
      gfx.clear();
      const lifeProgress = Math.min(1, Math.max(0, zone.elapsedMs / zone.durationMs));
      for (const circle of circlesForMobAbilityGeometry(zone.geometry)) {
        drawSporeCloudCircle(
          gfx,
          ftToPx(circle.x),
          ftToPx(circle.y),
          ftToPx(circle.radiusFt),
          lifeProgress,
        );
      }
    }
    for (const [zoneId, gfx] of cloudZoneGfx) {
      if (!liveZones.has(zoneId)) {
        gfx.destroy();
        cloudZoneGfx.delete(zoneId);
      }
    }

    // ── Retire telegraph graphics whose cue has ended ──────────────────────
    for (const [eid, gfx] of telegraphGfx) {
      if (!liveCasters.has(eid)) {
        gfx.destroy();
        telegraphGfx.delete(eid);
        sawGfx.get(eid)?.destroy();
        sawGfx.delete(eid);
        lastCuePhase.delete(eid);
        lastSawTrailPos.delete(eid);
        castStartSeen.delete(eid);
      }
    }
    // Drop stale geometry bookkeeping for gone casters.
    for (const eid of [...lastGeom.keys()]) {
      if (!runtime.byEntity.has(eid)) {
        lastGeom.delete(eid);
      }
    }

    // ── Active self-buff aura (Big Panda Wei) ──────────────────────────────
    const liveAuras = new Set<number>();
    for (const [eid, buff] of runtime.activeBuffsByEntity) {
      if (buff.abilityId !== BAMBOO_FED_BERSERK_ABILITY_ID) continue;
      const aura = getMobAbilityActiveAura(world, eid);
      if (aura === null || aura.kind !== 'circle') continue;
      liveAuras.add(eid);
      const cx = ftToPx(aura.x);
      const cy = ftToPx(aura.y);
      const radiusPx = ftToPx(aura.radiusFt);
      const lastPos = berserkAuraLastPos.get(eid);
      berserkAuraLastPos.set(eid, { x: cx, y: cy });
      if (!berserkAuraSeen.has(eid)) {
        berserkAuraSeen.add(eid);
        spawnRing(cx, cy, radiusPx * 0.5, radiusPx * 1.2, COLOR_BERSERK_RED, 420, BURST_DEPTH);
        spawnBerserkFlair(cx, cy, radiusPx, eid * 101 + world.frameCount * 13);
        scene.cameras.main?.shake?.(120, 0.0035);
      }
      if (lastPos && (Math.abs(lastPos.x - cx) > 0.25 || Math.abs(lastPos.y - cy) > 0.25)) {
        spawnRing(
          lastPos.x,
          lastPos.y,
          radiusPx * 0.45,
          radiusPx * 0.75,
          COLOR_BERSERK_RED,
          120,
          BURST_DEPTH,
        );
        spawnBerserkFootstepDust(
          lastPos.x,
          lastPos.y,
          radiusPx * 0.5,
          eid * 193 + world.frameCount * 29,
        );
      }
      if (!enabled) continue;
      let gfx = berserkAuraGfx.get(eid);
      if (gfx === undefined) {
        gfx = scene.add.graphics();
        gfx.name = 'berserkAura';
        gfx.setDepth(TARNISH_DEPTH);
        gfx.setBlendMode('ADD');
        ignoreUi(gfx);
        berserkAuraGfx.set(eid, gfx);
      }
      drawBerserkAura(gfx, cx, cy, radiusPx);
      const lastPulseFrame = berserkAuraLastPulseFrame.get(eid);
      if (world.frameCount % 12 === 0 && lastPulseFrame !== world.frameCount) {
        berserkAuraLastPulseFrame.set(eid, world.frameCount);
        spawnRing(cx, cy, radiusPx * 0.3, radiusPx * 0.9, COLOR_BERSERK_GOLD, 220, BURST_DEPTH);
        spawnBerserkFlair(cx, cy, radiusPx * 0.65, eid * 977 + world.frameCount);
      }
    }
    for (const [eid, gfx] of berserkAuraGfx) {
      if (!liveAuras.has(eid)) {
        gfx.destroy();
        berserkAuraGfx.delete(eid);
        berserkAuraSeen.delete(eid);
        berserkAuraLastPos.delete(eid);
        berserkAuraLastPulseFrame.delete(eid);
      }
    }

    // ── Tarnished indicators ───────────────────────────────────────────────
    const tarnished = new Set<number>();
    for (const eid of world.statusEffectsByEntity.keys()) {
      if (hasMobAbilityDebuff(world, eid)) tarnished.add(eid);
    }
    for (const eid of tarnished) {
      const cx = ftToPx(world.stores.position.x[eid] ?? 0);
      const cy = ftToPx(world.stores.position.y[eid] ?? 0);
      tarnishLastPos.set(eid, { x: cx, y: cy });
      if (!enabled) continue;
      let gfx = tarnishGfx.get(eid);
      if (gfx === undefined) {
        gfx = scene.add.graphics();
        gfx.setDepth(TARNISH_DEPTH);
        gfx.setBlendMode('ADD');
        ignoreUi(gfx);
        tarnishGfx.set(eid, gfx);
      }
      drawTarnish(gfx, cx, cy);
    }
    for (const [eid, gfx] of tarnishGfx) {
      if (!tarnished.has(eid)) {
        const last = tarnishLastPos.get(eid);
        const cx = last?.x ?? ftToPx(world.stores.position.x[eid] ?? 0);
        const cy = last?.y ?? ftToPx(world.stores.position.y[eid] ?? 0);
        gfx.destroy();
        tarnishGfx.delete(eid);
        tarnishLastPos.delete(eid);
        // Cleanup/expiry poof when the debuff falls off.
        spawnRing(
          cx,
          cy,
          ftToPx(1.4),
          ftToPx(0.4),
          COLOR_TARNISH_RING,
          CLEANUP_LIFETIME_MS,
          BURST_DEPTH,
        );
      }
    }
  }

  function destroy(): void {
    // Stop and destroy all transient tween targets (rings, sparks) before
    // they complete naturally so scene resets and shutdown fully release them.
    for (const [circle, tween] of transientTweens) {
      tween.stop();
      circle.destroy();
    }
    transientTweens.clear();
    transientCircles.clear();
    for (const gfx of telegraphGfx.values()) gfx.destroy();
    telegraphGfx.clear();
    for (const gfx of sawGfx.values()) gfx.destroy();
    sawGfx.clear();
    for (const gfx of tarnishGfx.values()) gfx.destroy();
    tarnishGfx.clear();
    for (const gfx of berserkAuraGfx.values()) gfx.destroy();
    berserkAuraGfx.clear();
    for (const gfx of cloudZoneGfx.values()) gfx.destroy();
    cloudZoneGfx.clear();
    projectileGfx?.destroy();
    projectileGfx = undefined;
    slickGfx?.destroy();
    slickGfx = undefined;
    berserkAuraLastPos.clear();
    berserkAuraLastPulseFrame.clear();
    tarnishLastPos.clear();
    berserkAuraSeen.clear();
    slickLastGeom.clear();
    lastGeom.clear();
    coronationProjectileLastPos.clear();
    lastCuePhase.clear();
    lastSawTrailPos.clear();
    castStartSeen.clear();
  }

  return { update, destroy };
}
