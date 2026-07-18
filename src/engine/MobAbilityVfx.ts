/**
 * Mob-ability VFX renderer — the procedural presentation layer for Queen Mab's
 * Verdigris Glamour (and future generic mob abilities).
 *
 * It is a PURE CONSUMER of committed public state:
 *   - `world.mobAbilities.cues` — the telegraph cue rebuilt each tick by the
 *     core executor (position/geometry locked at telegraph start, never tracked
 *     after). This renderer only ever reads that committed geometry, so the
 *     drawn danger footprint can never disagree with the resolution hitbox.
 *   - `world.mobAbilities.byEntity[*].resolvedCasts` — used only to detect the
 *     resolution frame so the burst fires once per cast.
 *   - `world.statusEffectsByEntity` — Tarnished indicator for any entity carrying
 *     a `mob-ability:`-sourced effect.
 *
 * Every required visual state is procedural (no generated art, no textures):
 * cast-start cue, locked hostile-red telegraph circle with the exact 12ft
 * footprint, a countdown/anticipation fill, a resolution burst with gratuitous
 * particles, a persistent Tarnished indicator, and a cleanup/expiry poof. The
 * announcement itself is rendered by `HudAnnouncementBanner`.
 *
 * No simulation ownership: this module never writes back into `world`.
 */
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { getStatusEffects } from '../core/index.js';
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
const COLOR_TARNISH_RING = 0x5fb89a;

const BURST_LIFETIME_MS = 560;
const CAST_START_LIFETIME_MS = 320;
const CLEANUP_LIFETIME_MS = 300;
const CROWN_RUNE_COUNT = 8;
const BURST_SPARK_COUNT = 18;

export function createMobAbilityVfx(scene: Phaser.Scene): {
  update(world: GameWorld): void;
  destroy(): void;
} {
  const enabled =
    typeof scene.add?.graphics === 'function' &&
    typeof scene.add?.circle === 'function' &&
    typeof scene.tweens?.add === 'function';

  const telegraphGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const tarnishGfx = new Map<number, Phaser.GameObjects.Graphics>();
  const tarnishLastPos = new Map<number, { x: number; y: number }>();
  const lastGeom = new Map<number, { x: number; y: number; r: number }>();
  const castStartSeen = new Set<number>();
  /** Transient circles created by spawnRing/spawnBurst/spawnCastStart. Cleaned up in destroy(). */
  const transientCircles = new Set<Phaser.GameObjects.Arc>();
  /** Tweens driving transient circles, keyed by their target circle. */
  const transientTweens = new Map<Phaser.GameObjects.Arc, Phaser.Tweens.Tween>();

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
    // Render-only RNG (never touches the simulation).
    let seed = (Math.floor(x) * 73856093) ^ (Math.floor(y) * 19349663) ^ 0x9e3779b9;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed & 0x7fffffff) / 2147483647;
    };
    for (let i = 0; i < BURST_SPARK_COUNT; i += 1) {
      const angle = (i / BURST_SPARK_COUNT) * Math.PI * 2 + rand() * 0.3;
      const dist = radiusPx * (0.6 + rand() * 0.8);
      const spark = scene.add.circle(
        x,
        y,
        2 + rand() * 2,
        i % 2 === 0 ? COLOR_VERDIGRIS : COLOR_BRONZE,
      );
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
  ): void {
    gfx.clear();
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

  function hasMobAbilityDebuff(world: GameWorld, eid: number): boolean {
    for (const e of getStatusEffects(world, eid)) {
      if (e.sourceId.startsWith(MOB_ABILITY_SOURCE_PREFIX)) return true;
    }
    return false;
  }

  function update(world: GameWorld): void {
    const runtime = world.mobAbilities;

    // ── Telegraph circles ──────────────────────────────────────────────────
    const liveCasters = new Set<number>();
    for (const cue of runtime.cues) {
      if (cue.geometry.kind !== 'circle') continue;
      liveCasters.add(cue.casterEid);
      const cx = ftToPx(cue.geometry.x);
      const cy = ftToPx(cue.geometry.y);
      const radiusPx = ftToPx(cue.geometry.radiusFt);
      lastGeom.set(cue.casterEid, { x: cx, y: cy, r: radiusPx });
      if (!castStartSeen.has(cue.casterEid)) {
        castStartSeen.add(cue.casterEid);
        spawnCastStart(cx, cy, radiusPx);
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
      drawTelegraph(gfx, cx, cy, radiusPx, cue.telegraphProgress);
    }

    // ── Resolution bursts (drain the durable pending-burst queue) ─────────
    // The core runtime pushes committed geometry here when a cast resolves, so
    // bursts survive even if the caster is cleared (killed/despawned) later in
    // the same simulation step before PhaserBridge.sync runs.
    while (runtime.pendingBursts.length > 0) {
      const geom = runtime.pendingBursts.shift()!;
      if (geom.kind === 'circle') {
        const cx = ftToPx(geom.x);
        const cy = ftToPx(geom.y);
        const r = ftToPx(geom.radiusFt);
        spawnBurst(cx, cy, r);
      }
    }

    // ── Retire telegraph graphics whose cue has ended ──────────────────────
    for (const [eid, gfx] of telegraphGfx) {
      if (!liveCasters.has(eid)) {
        gfx.destroy();
        telegraphGfx.delete(eid);
        castStartSeen.delete(eid);
      }
    }
    // Drop stale geometry bookkeeping for gone casters.
    for (const eid of [...lastGeom.keys()]) {
      if (!runtime.byEntity.has(eid)) {
        lastGeom.delete(eid);
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
    for (const gfx of tarnishGfx.values()) gfx.destroy();
    tarnishGfx.clear();
    tarnishLastPos.clear();
    lastGeom.clear();
    castStartSeen.clear();
  }

  return { update, destroy };
}
