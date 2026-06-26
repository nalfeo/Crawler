/**
 * Effects VFX renderer — the generic "juice" layer.
 *
 * Two input sources, one preset library:
 *   1. `world.vfxEvents` — drained here (sole consumer). Carries non-combat
 *      effect requests pushed by game/core systems (pickups, level-ups).
 *   2. `world.combatEvents` — READ but NOT drained (CombatVfx drains them). Used
 *      to synthesise combat juice (hit sparks, crit bursts, death pops, and the
 *      player-hurt screen flash) without any extra core plumbing.
 *
 * ORDER: must run AFTER GoreVfx and BEFORE CombatVfx in the bridge so it sees
 * combat events before CombatVfx clears the queue (mirrors GoreVfx).
 *
 * Effects are self-animating Phaser tweens that destroy their own GameObjects on
 * completion (the same pattern as `MainGameScene.triggerBossSpawnFx`), so this
 * module needs no per-frame particle integration loop. All spawned objects use a
 * depth from `WORLD_VFX_DEPTH` (below `UI_DEPTH_CUTOFF`) and are ignored by the
 * UI camera so they render in world space.
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import type { VfxEvent } from '../shared/vfx-events.js';
import type { GameWorld } from '../core/world.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import { ftToPx } from '../shared/units.js';

type Shape = Phaser.GameObjects.Shape;

// --- Tunables ---
const SPARK_LIFETIME_MS = 260;
const RING_LIFETIME_MS = 420;
const MOTE_LIFETIME_MS = 520;
const LEVEL_UP_LIFETIME_MS = 720;

const HIT_SPARK_COUNT = 4;
const CRIT_SPARK_COUNT = 7;
const DEATH_POP_SPARK_COUNT = 7;
const PICKUP_MOTE_COUNT = 4;
const LEVEL_UP_MOTE_COUNT = 9;

/** Minimum gap between player-hurt screen shakes so rapid hits don't strobe. */
const PLAYER_HURT_THROTTLE_MS = 120;

const COLOR_HIT_SPARK = 0xfff1a8;
const COLOR_CRIT_SPARK = 0xff8800;
const COLOR_LEVEL_UP = 0xffd166;
const COLOR_PLAYER_HURT = { r: 220, g: 40, b: 40 } as const;

export function createEffectsVfx(scene: Phaser.Scene): {
  update(world: GameWorld, renderElapsedMs: number): void;
  destroy(): void;
} {
  // Capability guard: in headless/mocked test scenes the shape factory and tween
  // manager are absent. When disabled we still drain vfxEvents to keep the queue
  // bounded, but spawn nothing.
  const enabled =
    typeof scene.add?.circle === 'function' &&
    typeof scene.add?.rectangle === 'function' &&
    typeof scene.tweens?.add === 'function';

  const active = new Set<Shape>();
  // Seed the player-hurt throttle one full window in the past so the FIRST hurt
  // always fires. Kept finite (never ±Infinity) so a queue-sourced `playerHurt`
  // VfxEvent stamping this value can't poison the throttle and permanently
  // silence later player-hurt feedback.
  let lastPlayerHurtMs = -PLAYER_HURT_THROTTLE_MS;

  /** Non-deterministic RNG — render-only, never affects simulation. */
  let vfxSeed = 1;
  function rand(): number {
    vfxSeed = (vfxSeed * 16807) % 2147483647;
    return vfxSeed / 2147483647;
  }
  const spread = (mag: number): number => (rand() - 0.5) * 2 * mag;

  function register(obj: Shape, depth: number): Shape {
    obj.setDepth(depth);
    obj.setBlendMode('ADD');
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(obj);
    active.add(obj);
    return obj;
  }

  function release(obj: Shape): void {
    active.delete(obj);
    obj.destroy();
  }

  /** A small square that flies outward, shrinking and fading. */
  function spawnSpark(x: number, y: number, color: number, depth: number, speed: number): void {
    const size = 2 + rand() * 3;
    const rect = register(scene.add.rectangle(x, y, size, size, color), depth);
    const angle = rand() * Math.PI * 2;
    const dist = speed * (0.5 + rand());
    scene.tweens.add({
      targets: rect,
      x: x + Math.cos(angle) * dist,
      y: y + Math.sin(angle) * dist,
      alpha: { from: 1, to: 0 },
      scale: { from: 1, to: 0.2 },
      duration: SPARK_LIFETIME_MS * (0.7 + rand() * 0.6),
      ease: 'Quad.easeOut',
      onComplete: () => release(rect),
    });
  }

  /** An expanding, fading ring (filled circle scaled up). */
  function spawnRing(
    x: number,
    y: number,
    color: number,
    fromRadius: number,
    toScale: number,
    depth: number,
    durationMs: number,
    alpha = 0.5,
  ): void {
    const ring = register(scene.add.circle(x, y, fromRadius, color, alpha), depth);
    scene.tweens.add({
      targets: ring,
      scale: { from: 0.4, to: toScale },
      alpha: { from: alpha, to: 0 },
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onComplete: () => release(ring),
    });
  }

  /** A small square that drifts upward while fading — "collect"/celebrate feel. */
  function spawnRisingMote(x: number, y: number, color: number, depth: number): void {
    const size = 2 + rand() * 2;
    const mote = register(
      scene.add.rectangle(x + spread(6), y + spread(4), size, size, color),
      depth,
    );
    scene.tweens.add({
      targets: mote,
      y: mote.y - (14 + rand() * 16),
      x: mote.x + spread(8),
      alpha: { from: 1, to: 0 },
      duration: MOTE_LIFETIME_MS * (0.7 + rand() * 0.6),
      ease: 'Sine.easeOut',
      onComplete: () => release(mote),
    });
  }

  // --- Presets ---

  function pickupSparkle(x: number, y: number, color: number): void {
    spawnRing(x, y, color, 6, 2.0, WORLD_VFX_DEPTH.pickupSparkle, RING_LIFETIME_MS, 0.4);
    for (let i = 0; i < PICKUP_MOTE_COUNT; i++) {
      spawnRisingMote(x, y, color, WORLD_VFX_DEPTH.pickupSparkle);
    }
  }

  function levelUpBurst(x: number, y: number, color: number, intensity: number): void {
    const depth = WORLD_VFX_DEPTH.levelUpBurst;
    spawnRing(x, y, 0xffffff, 8, 3.0 * intensity, depth, LEVEL_UP_LIFETIME_MS, 0.7);
    spawnRing(x, y, color, 10, 5.0 * intensity, depth, LEVEL_UP_LIFETIME_MS, 0.35);
    const motes = Math.round(LEVEL_UP_MOTE_COUNT * intensity);
    for (let i = 0; i < motes; i++) {
      spawnRisingMote(x, y, color, depth);
    }
    for (let i = 0; i < 5; i++) {
      spawnSpark(x, y, color, depth, 70);
    }
  }

  function hitSpark(x: number, y: number, color: number, count: number, depth: number): void {
    spawnRing(x, y, color, 4, 1.4, depth, SPARK_LIFETIME_MS, 0.5);
    for (let i = 0; i < count; i++) {
      spawnSpark(x, y, color, depth, 60);
    }
  }

  function deathPop(x: number, y: number, color: number, intensity: number): void {
    const depth = WORLD_VFX_DEPTH.deathPop;
    spawnRing(x, y, color, 6, 2.2 * intensity, depth, RING_LIFETIME_MS, 0.55);
    spawnRing(x, y, 0xffffff, 4, 1.6 * intensity, depth, SPARK_LIFETIME_MS, 0.6);
    const sparks = Math.round(DEATH_POP_SPARK_COUNT * intensity);
    for (let i = 0; i < sparks; i++) {
      spawnSpark(x, y, color, depth, 90);
    }
  }

  function playerHurt(renderElapsedMs: number): void {
    if (renderElapsedMs - lastPlayerHurtMs < PLAYER_HURT_THROTTLE_MS) return;
    lastPlayerHurtMs = renderElapsedMs;
    const cam = scene.cameras?.main;
    if (typeof cam?.flash === 'function') {
      cam.flash(120, COLOR_PLAYER_HURT.r, COLOR_PLAYER_HURT.g, COLOR_PLAYER_HURT.b);
    }
    if (typeof cam?.shake === 'function') {
      cam.shake(110, 0.006);
    }
  }

  function handleVfxEvent(event: VfxEvent, renderElapsedMs: number): void {
    // World-feet → render px: effects spawn as world-space Phaser objects, so the
    // anchor is converted here while the helpers keep their px-space size/spread.
    const x = ftToPx(event.x);
    const y = ftToPx(event.y);
    switch (event.kind) {
      case 'pickupSparkle':
        pickupSparkle(x, y, event.color ?? 0xffffff);
        break;
      case 'levelUpBurst':
        levelUpBurst(x, y, event.color ?? COLOR_LEVEL_UP, event.intensity ?? 1);
        break;
      case 'hitSpark':
        hitSpark(x, y, event.color ?? COLOR_HIT_SPARK, HIT_SPARK_COUNT, WORLD_VFX_DEPTH.hitSpark);
        break;
      case 'critBurst':
        hitSpark(x, y, event.color ?? COLOR_CRIT_SPARK, CRIT_SPARK_COUNT, WORLD_VFX_DEPTH.hitSpark);
        break;
      case 'deathPop':
        deathPop(x, y, event.color ?? 0xcc0000, event.intensity ?? 1);
        break;
      case 'playerHurt':
        // Queue-sourced player-hurt shares the combat throttle; stamp it with the
        // real render clock so `lastPlayerHurtMs` stays finite (see init note).
        playerHurt(renderElapsedMs);
        break;
    }
  }

  function handleCombatEvent(event: CombatEvent, renderElapsedMs: number): void {
    if (event.type === 'hit') {
      if (event.targetType === 'player') {
        playerHurt(renderElapsedMs);
        return;
      }
      // World-feet → render px (world-space Phaser objects).
      const x = ftToPx(event.x);
      const y = ftToPx(event.y);
      hitSpark(x, y, COLOR_HIT_SPARK, HIT_SPARK_COUNT, WORLD_VFX_DEPTH.hitSpark);
      if (event.isCrit) {
        hitSpark(x, y, COLOR_CRIT_SPARK, CRIT_SPARK_COUNT, WORLD_VFX_DEPTH.hitSpark);
      }
    } else if (event.type === 'death' && event.targetType === 'enemy') {
      const overkill = event.overkill ?? 0;
      const intensity = 1 + Math.min(overkill / 20, 1.5);
      deathPop(ftToPx(event.x), ftToPx(event.y), event.bloodColor ?? 0xcc0000, intensity);
    }
  }

  return {
    update(world: GameWorld, renderElapsedMs: number): void {
      if (!enabled) {
        // No renderer surface — drop queued requests so they never accumulate.
        world.vfxEvents.length = 0;
        return;
      }

      // Combat-derived juice (read without draining — CombatVfx drains).
      for (const event of world.combatEvents) {
        handleCombatEvent(event, renderElapsedMs);
      }

      // Generic effect requests (drain — we are the sole consumer).
      for (const event of world.vfxEvents) {
        handleVfxEvent(event, renderElapsedMs);
      }
      world.vfxEvents.length = 0;
    },

    destroy(): void {
      if (enabled) {
        scene.tweens.killTweensOf([...active]);
      }
      for (const obj of active) {
        obj.destroy();
      }
      active.clear();
    },
  };
}
