/**
 * Mob-ability VFX renderer — the procedural presentation layer for Queen Mab's
 * Verdigris Glamour (and future generic mob abilities).
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
 * cast-start cue, locked hostile-red telegraphs (circle or lane), countdown
 * anticipation fill, motion/impact/re-catch bursts for active lane projectiles,
 * a persistent Tarnished indicator, and cleanup poofs. The announcement itself
 * is rendered by `HudAnnouncementBanner`.
 */
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  BAMBOO_FED_BERSERK_ABILITY_ID,
  getMobAbilityActiveAura,
  getStatusEffects,
} from '../core/index.js';
import type { MobAbilityCue, MobAbilityLaneGeometry } from '../core/mob-abilities/types.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import { ftToPx } from '../shared/units.js';

/** Prefix of every `sourceId` produced by `mobAbilitySourceId()` in core. */
const MOB_ABILITY_SOURCE_PREFIX = 'mob-ability:';

// Ground-plane depths: below living entities (0) but above terrain/trails so the
// danger circle reads as painted on the floor beneath the fight.
const TELEGRAPH_DEPTH = -14;
const TARNISH_DEPTH = -13;
const BURST_DEPTH = WORLD_VFX_DEPTH.spellCast;

const COLOR_HOSTILE_RED = 0xef4444;
const COLOR_CROWN_RUNE = 0xffd166;
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
const COLOR_SAW_ORANGE = 0xff8c42;
const COLOR_SAW_SMOKE = 0x6b7280;
const COLOR_SAW_STEAM = 0xd1d5db;

const BURST_LIFETIME_MS = 560;
const CAST_START_LIFETIME_MS = 320;
const CLEANUP_LIFETIME_MS = 300;
const CROWN_RUNE_COUNT = 8;
const BURST_SPARK_COUNT = 18;
<<<<<<< HEAD
const SAW_TRAIL_LIFETIME_MS = 180;
=======
const UNDERCITY_BURST_SPARK_COUNT = 24;
>>>>>>> origin/main

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
  const lastGeom = new Map<number, { x: number; y: number; r: number }>();
  const lastCuePhase = new Map<number, 'telegraph' | 'outbound' | 'hold' | 'return'>();
  const castStartSeen = new Set<number>();
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
    cue: MobAbilityCue & { geometry: MobAbilityLaneGeometry },
  ): void {
    const { geometry, telegraphProgress } = cue;
    const ox = ftToPx(geometry.originX);
    const oy = ftToPx(geometry.originY);
    const ex = ftToPx(geometry.endpointX);
    const ey = ftToPx(geometry.endpointY);
    const widthPx = ftToPx(geometry.widthFt);
    const dx = ex - ox;
    const dy = ey - oy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const half = widthPx * 0.5;
    const urgency = 0.75 + 0.25 * Math.sin(telegraphProgress * Math.PI * 2);
    gfx.clear();
    gfx.lineStyle(Math.max(2, widthPx), COLOR_HOSTILE_RED, 0.16 + 0.16 * telegraphProgress);
    gfx.beginPath();
    gfx.moveTo(ox, oy);
    gfx.lineTo(ex, ey);
    gfx.strokePath();
    gfx.lineStyle(2 + telegraphProgress * 2, COLOR_HOSTILE_RED, 0.95);
    gfx.beginPath();
    gfx.moveTo(ox + nx * half, oy + ny * half);
    gfx.lineTo(ex + nx * half, ey + ny * half);
    gfx.moveTo(ox - nx * half, oy - ny * half);
    gfx.lineTo(ex - nx * half, ey - ny * half);
    gfx.strokePath();
    gfx.lineStyle(2, COLOR_CROWN_RUNE, 0.65 + 0.2 * urgency);
    gfx.beginPath();
    gfx.moveTo(ox, oy);
    gfx.lineTo(ex, ey);
    gfx.strokePath();
    const arrow = Math.min(14, len * 0.18);
    const arrowWidth = Math.max(5, half * 0.6);
    gfx.fillStyle(COLOR_CROWN_RUNE, 0.55 + 0.3 * telegraphProgress);
    gfx.fillTriangle(
      ex,
      ey,
      ex - (dx / len) * arrow + nx * arrowWidth,
      ey - (dy / len) * arrow + ny * arrowWidth,
      ex - (dx / len) * arrow - nx * arrowWidth,
      ey - (dy / len) * arrow - ny * arrowWidth,
    );
    gfx.fillTriangle(
      ox,
      oy,
      ox + (dx / len) * arrow + nx * arrowWidth,
      oy + (dy / len) * arrow + ny * arrowWidth,
      ox + (dx / len) * arrow - nx * arrowWidth,
      oy + (dy / len) * arrow - ny * arrowWidth,
    );
  }

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

  function makeDeterministicRand(seedBase: number): () => number {
    let seed = seedBase & 0x7fffffff;
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 2147483647;
    };
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

  function hasMobAbilityDebuff(world: GameWorld, eid: number): boolean {
    for (const e of getStatusEffects(world, eid)) {
      if (e.sourceId.startsWith(MOB_ABILITY_SOURCE_PREFIX)) return true;
    }
    return false;
  }

  function update(world: GameWorld): void {
    const runtime = world.mobAbilities;

    // ── Telegraphs + active lane projectiles ───────────────────────────────
    const liveCasters = new Set<number>();
    for (const cue of runtime.cues) {
<<<<<<< HEAD
      liveCasters.add(cue.casterEid);
      if (!castStartSeen.has(cue.casterEid)) {
        castStartSeen.add(cue.casterEid);
        if (cue.geometry.kind === 'circle') {
          const cx = ftToPx(cue.geometry.x);
          const cy = ftToPx(cue.geometry.y);
          const radiusPx = ftToPx(cue.geometry.radiusFt);
          spawnCastStart(cx, cy, radiusPx);
        } else {
          spawnCastStart(ftToPx(cue.geometry.originX), ftToPx(cue.geometry.originY), ftToPx(2));
=======
      const circles = cue.geometry.kind === 'circle' ? [cue.geometry] : cue.geometry.circles;
      if (circles.length === 0) continue;
      liveCasters.add(cue.casterEid);
      const first = circles[0]!;
      const firstCx = ftToPx(first.x);
      const firstCy = ftToPx(first.y);
      const firstRadiusPx = ftToPx(first.radiusFt);
      lastGeom.set(cue.casterEid, { x: firstCx, y: firstCy, r: firstRadiusPx });
      if (!castStartSeen.has(cue.casterEid)) {
        castStartSeen.add(cue.casterEid);
        for (const circle of circles) {
          spawnCastStart(ftToPx(circle.x), ftToPx(circle.y), ftToPx(circle.radiusFt));
>>>>>>> origin/main
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
<<<<<<< HEAD
      const previousPhase = lastCuePhase.get(cue.casterEid);
      lastCuePhase.set(cue.casterEid, cue.phase);
      if (cue.geometry.kind === 'circle') {
        const cx = ftToPx(cue.geometry.x);
        const cy = ftToPx(cue.geometry.y);
        const radiusPx = ftToPx(cue.geometry.radiusFt);
        lastGeom.set(cue.casterEid, { x: cx, y: cy, r: radiusPx });
        drawTelegraph(gfx, cx, cy, radiusPx, cue.telegraphProgress, cue.dangerColor);
      } else {
        drawLaneTelegraph(gfx, cue as MobAbilityCue & { geometry: MobAbilityLaneGeometry });
        let saw = sawGfx.get(cue.casterEid);
        if (cue.phase === 'telegraph') {
          saw?.clear();
        } else if (cue.projectileX !== undefined && cue.projectileY !== undefined) {
          if (saw === undefined) {
            saw = scene.add.graphics();
            saw.setDepth(BURST_DEPTH);
            saw.setBlendMode('ADD');
            ignoreUi(saw);
            sawGfx.set(cue.casterEid, saw);
          }
          drawSaw(saw, cue.projectileX, cue.projectileY, cue.phase);
          if (previousPhase !== cue.phase) {
            const px = ftToPx(cue.projectileX);
            const py = ftToPx(cue.projectileY);
            if (cue.phase === 'outbound') {
              spawnSawFlair(px, py, ftToPx(1.2), COLOR_SAW_STEAM, COLOR_SAW_ORANGE);
            } else if (cue.phase === 'hold') {
              spawnSawFlair(px, py, ftToPx(1.5), COLOR_SAW_SMOKE, COLOR_HOSTILE_RED);
            } else if (cue.phase === 'return') {
              spawnSawFlair(px, py, ftToPx(1.2), COLOR_SAW_STEAM, COLOR_CROWN_RUNE);
            }
          }
        }
=======
      gfx.clear();
      for (const circle of circles) {
        drawTelegraph(
          gfx,
          ftToPx(circle.x),
          ftToPx(circle.y),
          ftToPx(circle.radiusFt),
          cue.telegraphProgress,
          cue.dangerColor,
        );
>>>>>>> origin/main
      }
    }

    // ── Resolution bursts (drain the durable pending-burst queue) ─────────
    // The core runtime pushes committed geometry here when a cast resolves, so
    // bursts survive even if the caster is cleared (killed/despawned) later in
    // the same simulation step before PhaserBridge.sync runs.
    while (runtime.pendingBursts.length > 0) {
<<<<<<< HEAD
      const event = runtime.pendingBursts.shift()!;
      if (event.kind === 'resolution' && event.geometry.kind === 'circle') {
        const cx = ftToPx(event.geometry.x);
        const cy = ftToPx(event.geometry.y);
        const r = ftToPx(event.geometry.radiusFt);
        spawnBurst(cx, cy, r);
      } else if (event.kind === 'recatch') {
        const x = ftToPx(event.x);
        const y = ftToPx(event.y);
        spawnBurst(x, y, ftToPx(2.4));
        spawnSawFlair(x, y, ftToPx(1.6), COLOR_SAW_SMOKE, COLOR_SAW_ORANGE);
=======
      const burst = runtime.pendingBursts.shift()!;
      const spawn =
        burst.abilityId === UNDERCITY_MOB_CALL_ABILITY_ID ? spawnUndercityBurst : spawnBurst;
      const geom = burst.geometry;
      if (geom.kind === 'circle') {
        const cx = ftToPx(geom.x);
        const cy = ftToPx(geom.y);
        const r = ftToPx(geom.radiusFt);
        spawn(cx, cy, r);
      } else {
        for (const circle of geom.circles) {
          spawn(ftToPx(circle.x), ftToPx(circle.y), ftToPx(circle.radiusFt));
        }
>>>>>>> origin/main
      }
    }

    // ── Retire telegraph graphics whose cue has ended ──────────────────────
    for (const [eid, gfx] of telegraphGfx) {
      if (!liveCasters.has(eid)) {
        gfx.destroy();
        telegraphGfx.delete(eid);
        sawGfx.get(eid)?.destroy();
        sawGfx.delete(eid);
        castStartSeen.delete(eid);
        lastCuePhase.delete(eid);
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
    berserkAuraLastPos.clear();
    berserkAuraLastPulseFrame.clear();
    tarnishLastPos.clear();
    berserkAuraSeen.clear();
    lastGeom.clear();
    lastCuePhase.clear();
    castStartSeen.clear();
  }

  return { update, destroy };
}
