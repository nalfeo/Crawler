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
const COLOR_SPAWNER_PULSE = 0x9be15d;
const COLOR_PLAYER_HURT = { r: 220, g: 40, b: 40 } as const;
const COLOR_FIREBALL_CORE = 0xffe066;
const COLOR_FIREBALL_RING = 0xff5522;
const COLOR_PULSE_SHIELD_INNER = 0xe0f7ff;
const COLOR_PULSE_SHIELD_RING = 0x38bdf8;
const COLOR_HEAL_GLOW = 0x86efac;
const COLOR_ABILITY_UNLOCK = 0xc084fc;
const COLOR_ARCANE_BOLT = 0xc084fc;
const COLOR_FROST_NOVA = 0x93c5fd;
const COLOR_BUFF_AURA = 0xfef3c7;
const COLOR_CURSE_BURST = 0xa855f7;
const COLOR_LIFE_DRAIN = 0xf472b6;

/** Duration a spell blast/wave ring animates for (feels weightier than a hit spark). */
const SPELL_CAST_LIFETIME_MS = 520;

/**
 * Sparks per unit of fireball blast intensity (bestHits + 1, clamped 1..4 in the
 * caller). Kept modest so a giant cluster hit doesn't erase the arena visually.
 */
const FIREBALL_SPARKS_PER_INTENSITY = 6;

/** Pixel-radius of the fireball blast's inner core; the outer ring is scaled up from this. */
const FIREBALL_CORE_PX = 10;

/** Base pixel-radius of the pulse-shield's inner ring. The outer ring scales up from this. */
const PULSE_SHIELD_INNER_PX = 12;

/** Base pixel-radius of the heal glow's inner ring. */
const HEAL_GLOW_INNER_PX = 8;

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

  function spawnerPulse(x: number, y: number, color: number, intensity: number): void {
    const depth = WORLD_VFX_DEPTH.spawnerPulse;
    const clampedIntensity = Math.max(0.8, Math.min(2.2, intensity));
    spawnRing(x, y, color, 7, 1.8 * clampedIntensity, depth, RING_LIFETIME_MS, 0.45);
    spawnRing(x, y, 0xffffff, 5, 1.3 * clampedIntensity, depth, SPARK_LIFETIME_MS, 0.5);
    const sparks = Math.round(5 * clampedIntensity);
    for (let i = 0; i < sparks; i++) {
      spawnSpark(x, y, color, depth, 82);
    }
  }

  /**
   * Spawner arena start — the "battle begins!" burst. A dramatic radial ring
   * scaled to the actual arena radius plus a brief camera shake so the player
   * feels the trap snap shut. Larger + longer than a normal spawner pulse.
   */
  function spawnerArenaStart(
    x: number,
    y: number,
    color: number,
    intensity: number,
    radiusFt: number,
  ): void {
    const depth = WORLD_VFX_DEPTH.spawnerArenaBurst;
    const clampedIntensity = Math.max(1.0, Math.min(2.5, intensity));
    const targetPx = ftToPx(Math.max(1, radiusFt));
    // Outer ring blows out to the true arena radius so the reach reads truthfully.
    const outerScale = Math.max(1.5, (targetPx / 10) * 2);
    spawnRing(x, y, color, 10, outerScale, depth, RING_LIFETIME_MS * 1.4, 0.55);
    spawnRing(x, y, 0xffffff, 6, 1.6 * clampedIntensity, depth, SPARK_LIFETIME_MS, 0.6);
    const sparks = Math.round(9 * clampedIntensity);
    for (let i = 0; i < sparks; i++) {
      spawnSpark(x, y, color, depth, 110);
    }
    const cam = scene.cameras?.main as Phaser.Cameras.Scene2D.Camera | undefined;
    if (typeof cam?.shake === 'function') {
      cam.shake(180, 0.008 * clampedIntensity);
    }
  }

  /**
   * Spawner arena end — a shrinking, brightening flash signalling the arena
   * has cleared. Complement to `spawnerArenaStart`: no shake, quick pulse.
   */
  function spawnerArenaEnd(
    x: number,
    y: number,
    color: number,
    intensity: number,
    radiusFt: number,
  ): void {
    const depth = WORLD_VFX_DEPTH.spawnerArenaBurst;
    const clampedIntensity = Math.max(0.8, Math.min(1.8, intensity));
    const targetPx = ftToPx(Math.max(1, radiusFt));
    spawnRing(x, y, 0xffffff, Math.max(8, targetPx * 0.4), 0.6, depth, RING_LIFETIME_MS, 0.7);
    spawnRing(x, y, color, 6, 2.0 * clampedIntensity, depth, SPARK_LIFETIME_MS, 0.45);
    for (let i = 0; i < 5; i++) {
      spawnSpark(x, y, color, depth, 80);
    }
  }

  /**
   * Spawner arena fence — a persistent shimmering ring at the arena boundary.
   * Rendered as a wide, low-alpha annular pulse that expands to the radius
   * and fades quickly; the game system re-emits every ~400ms so the effect
   * reads as continuous shimmer without any per-eid renderer state.
   */
  function spawnerArenaFence(x: number, y: number, color: number, radiusFt: number): void {
    const depth = WORLD_VFX_DEPTH.spawnerArenaFence;
    const targetPx = ftToPx(Math.max(1, radiusFt));
    const outerScale = Math.max(1.2, (targetPx / 10) * 2);
    spawnRing(x, y, color, 10, outerScale, depth, RING_LIFETIME_MS * 1.1, 0.28);
    spawnRing(x, y, 0xffffff, 6, outerScale * 0.6, depth, RING_LIFETIME_MS * 0.9, 0.18);
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

  /**
   * Fireball blast: bright yellow core flashes and an orange outer ring expands
   * to the ACTUAL blast reach (`radiusFt`), so a solo hit still reads as the
   * full explosion the gameplay implies. `intensity` (cluster hit count) only
   * scales the spark count so bigger clusters feel weightier without inflating
   * the ring past the real damage radius. Both args have safe fallbacks so a
   * missing radius still produces a visible explosion.
   */
  function fireballBlast(x: number, y: number, radiusFt: number, intensity: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    const clampedIntensity = Math.max(1, Math.min(intensity, 4));
    const radiusPx = Math.max(24, ftToPx(Math.max(1, radiusFt)));
    const outerScale = Math.max(2.0, radiusPx / FIREBALL_CORE_PX);
    spawnRing(
      x,
      y,
      COLOR_FIREBALL_CORE,
      FIREBALL_CORE_PX,
      outerScale * 0.55,
      depth,
      SPARK_LIFETIME_MS,
      0.85,
    );
    spawnRing(
      x,
      y,
      COLOR_FIREBALL_RING,
      FIREBALL_CORE_PX + 2,
      outerScale,
      depth,
      SPELL_CAST_LIFETIME_MS,
      0.55,
    );
    const sparks = Math.round(FIREBALL_SPARKS_PER_INTENSITY * clampedIntensity);
    for (let i = 0; i < sparks; i += 1) {
      spawnSpark(x, y, COLOR_FIREBALL_RING, depth, 110);
    }
  }

  /**
   * Pulse-shield wave: expanding cyan ring centred on the caster, scaled to the
   * actual knockback reach (`radiusFt`, 16 ft on Floor 1) so the wave matches
   * gameplay. Falls back to a modest wave if no radius is supplied.
   */
  function pulseShieldWave(x: number, y: number, radiusFt: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    const radiusPx = Math.max(24, ftToPx(Math.max(1, radiusFt)));
    const scale = Math.max(1.5, radiusPx / PULSE_SHIELD_INNER_PX);
    spawnRing(
      x,
      y,
      COLOR_PULSE_SHIELD_INNER,
      PULSE_SHIELD_INNER_PX,
      scale * 0.7,
      depth,
      SPARK_LIFETIME_MS,
      0.7,
    );
    spawnRing(
      x,
      y,
      COLOR_PULSE_SHIELD_RING,
      PULSE_SHIELD_INNER_PX,
      scale,
      depth,
      SPELL_CAST_LIFETIME_MS,
      0.45,
    );
  }

  /**
   * Heal glow: a soft expanding green ring plus rising motes around the caster.
   * Read from a distance so an off-screen heal auto-cast is still perceptible
   * on the periphery.
   */
  function healGlow(x: number, y: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    spawnRing(x, y, 0xffffff, HEAL_GLOW_INNER_PX, 1.6, depth, SPARK_LIFETIME_MS, 0.6);
    spawnRing(
      x,
      y,
      COLOR_HEAL_GLOW,
      HEAL_GLOW_INNER_PX + 2,
      2.8,
      depth,
      SPELL_CAST_LIFETIME_MS,
      0.45,
    );
    for (let i = 0; i < 6; i += 1) {
      spawnRisingMote(x, y, COLOR_HEAL_GLOW, depth);
    }
  }

  function abilityActivateFlash(x: number, y: number): void {
    const depth = WORLD_VFX_DEPTH.levelUpBurst;
    spawnRing(x, y, 0xffffff, 6, 1.6, depth, SPARK_LIFETIME_MS, 0.6);
    spawnRing(x, y, COLOR_ABILITY_UNLOCK, 8, 2.8, depth, SPELL_CAST_LIFETIME_MS, 0.45);
    for (let i = 0; i < 5; i += 1) {
      spawnRisingMote(x, y, COLOR_ABILITY_UNLOCK, depth);
    }
  }

  function arcaneBoltImpact(x: number, y: number, color: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    spawnRing(x, y, 0xffffff, 5, 1.5, depth, SPARK_LIFETIME_MS, 0.7);
    spawnRing(x, y, color, 7, 2.4, depth, SPELL_CAST_LIFETIME_MS * 0.7, 0.5);
    for (let i = 0; i < 5; i += 1) {
      spawnSpark(x, y, color, depth, 80);
    }
  }

  function frostNovaBurst(x: number, y: number, radiusFt: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    const radiusPx = Math.max(24, ftToPx(Math.max(1, radiusFt)));
    const scale = Math.max(1.8, radiusPx / PULSE_SHIELD_INNER_PX);
    spawnRing(x, y, 0xffffff, 8, scale * 0.55, depth, SPARK_LIFETIME_MS, 0.7);
    spawnRing(x, y, COLOR_FROST_NOVA, 12, scale, depth, SPELL_CAST_LIFETIME_MS, 0.45);
    for (let i = 0; i < 8; i += 1) {
      spawnRisingMote(x, y, COLOR_FROST_NOVA, depth);
    }
  }

  function buffAura(x: number, y: number, color: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    spawnRing(x, y, 0xffffff, 7, 1.4, depth, SPARK_LIFETIME_MS, 0.65);
    spawnRing(x, y, color, 10, 2.1, depth, SPELL_CAST_LIFETIME_MS, 0.4);
    for (let i = 0; i < 5; i += 1) {
      spawnRisingMote(x, y, color, depth);
    }
  }

  function curseBurst(x: number, y: number, radiusFt: number, color: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    const radiusPx = Math.max(24, ftToPx(Math.max(1, radiusFt)));
    const scale = Math.max(1.6, radiusPx / PULSE_SHIELD_INNER_PX);
    spawnRing(x, y, color, 10, scale, depth, SPELL_CAST_LIFETIME_MS, 0.38);
    for (let i = 0; i < 6; i += 1) {
      spawnSpark(x, y, color, depth, 70);
    }
  }

  function lifeDrainBurst(x: number, y: number, color: number): void {
    const depth = WORLD_VFX_DEPTH.spellCast;
    spawnRing(x, y, color, 8, 2.0, depth, SPELL_CAST_LIFETIME_MS, 0.5);
    for (let i = 0; i < 6; i += 1) {
      spawnRisingMote(x, y, color, depth);
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
      case 'spawnerPulse':
        spawnerPulse(x, y, event.color ?? COLOR_SPAWNER_PULSE, event.intensity ?? 1);
        break;
      case 'spawnerArenaStart':
        spawnerArenaStart(
          x,
          y,
          event.color ?? COLOR_SPAWNER_PULSE,
          event.intensity ?? 1.5,
          event.radiusFt ?? 6,
        );
        break;
      case 'spawnerArenaEnd':
        spawnerArenaEnd(
          x,
          y,
          event.color ?? COLOR_SPAWNER_PULSE,
          event.intensity ?? 1.2,
          event.radiusFt ?? 6,
        );
        break;
      case 'spawnerArenaFence':
        spawnerArenaFence(x, y, event.color ?? COLOR_SPAWNER_PULSE, event.radiusFt ?? 6);
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
      case 'fireballBlast':
        fireballBlast(x, y, event.radiusFt ?? 12, event.intensity ?? 1);
        break;
      case 'pulseShieldWave':
        pulseShieldWave(x, y, event.radiusFt ?? 16);
        break;
      case 'healGlow':
        healGlow(x, y);
        break;
      case 'abilityActivateFlash':
        abilityActivateFlash(x, y);
        break;
      case 'arcaneBoltImpact':
        arcaneBoltImpact(x, y, event.color ?? COLOR_ARCANE_BOLT);
        break;
      case 'frostNovaBurst':
        frostNovaBurst(x, y, event.radiusFt ?? 12);
        break;
      case 'buffAura':
        buffAura(x, y, event.color ?? COLOR_BUFF_AURA);
        break;
      case 'curseBurst':
        curseBurst(x, y, event.radiusFt ?? 16, event.color ?? COLOR_CURSE_BURST);
        break;
      case 'lifeDrainBurst':
        lifeDrainBurst(x, y, event.color ?? COLOR_LIFE_DRAIN);
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
