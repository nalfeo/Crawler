/**
 * RewardOpeningVfx — self-animating particle/VFX layer for the reward-opening
 * sequence (RewardOpeningUI.ts).
 *
 * Creates Phaser tweens that destroy their own GameObjects on completion,
 * following the same pattern as MobAbilityVfx.ts and EffectsVfx.ts.
 * All objects are placed just above the overlay container (depth 6000) at
 * VFX_DEPTH and pinned to screen with setScrollFactor(0).
 *
 * Effects scale with the excitement bucket:
 *   modest    — single ring + few sparks (no motes, no beams)
 *   notable   — rings + sparks + rising motes (no beams)
 *   exciting  — rings + sparks + motes + 6 laser beams
 *   legendary — full spectacle — extra rings, heavy sparks, confetti, 10 beams
 *
 * reducedMotion: every public function is a no-op when `true` so the caller
 * never needs to guard calls.
 */
import type Phaser from 'phaser';
import type { RewardExcitementBucket } from '../shared/reward-presentation.js';

/** Depth for VFX particles — just above the reward overlay container (depth 6000). */
const VFX_DEPTH = 6005;

/** Bucket-mapped particle colours. */
const BUCKET_COLORS: Readonly<Record<RewardExcitementBucket, readonly number[]>> = {
  modest: [0x8fa0c2, 0xd6d9f1],
  notable: [0x4caf50, 0xa5d6a7, 0xffffff],
  exciting: [0x2196f3, 0x64b5f6, 0x00e5ff, 0xffffff],
  legendary: [0xffc107, 0xff9800, 0xffd54f, 0xffffff, 0xffe082],
};

/** Sparks emitted per item reveal at each tier. */
const REVEAL_SPARK_COUNT: Readonly<Record<RewardExcitementBucket, number>> = {
  modest: 4,
  notable: 7,
  exciting: 11,
  legendary: 16,
};

/** Rising motes emitted on reveal (0 = none). */
const REVEAL_MOTE_COUNT: Readonly<Record<RewardExcitementBucket, number>> = {
  modest: 0,
  notable: 3,
  exciting: 5,
  legendary: 8,
};

/** Laser beams on summary burst (0 = none). */
const BEAM_COUNT: Readonly<Record<RewardExcitementBucket, number>> = {
  modest: 0,
  notable: 0,
  exciting: 6,
  legendary: 10,
};

/** End-scale for the primary summary ring at each tier. */
const SUMMARY_RING_SCALE: Readonly<Record<RewardExcitementBucket, number>> = {
  modest: 3.0,
  notable: 4.5,
  exciting: 6.5,
  legendary: 9.0,
};

export interface RewardOpeningVfx {
  /**
   * Spawn the anticipation opening effect: animated chest + smoke motes +
   * pulsing ring. No-op when `reducedMotion` is true.
   */
  onAnticipationStart(
    cx: number,
    cy: number,
    bucket: RewardExcitementBucket,
    reducedMotion: boolean,
  ): void;
  /**
   * Spark burst for each item as it is revealed. No-op when `reducedMotion`
   * is true or when the item position is off-screen.
   */
  onItemRevealed(
    x: number,
    y: number,
    color: number,
    bucket: RewardExcitementBucket,
    reducedMotion: boolean,
  ): void;
  /**
   * Grand celebratory burst when the summary phase is entered. Scales from a
   * single ring (modest) up to rings + laser beams + confetti (legendary).
   * No-op when `reducedMotion` is true.
   */
  onSummaryBurst(
    cx: number,
    cy: number,
    bucket: RewardExcitementBucket,
    reducedMotion: boolean,
  ): void;
  /** Kill and destroy any still-animating VFX objects immediately. */
  destroy(): void;
}

export function createRewardOpeningVfx(scene: Phaser.Scene): RewardOpeningVfx {
  // Capability guard: headless/mocked test scenes may not have Phaser shape
  // factories or the tween manager. When disabled we do nothing.
  const enabled =
    typeof scene.add?.circle === 'function' &&
    typeof scene.add?.rectangle === 'function' &&
    typeof scene.add?.graphics === 'function' &&
    typeof scene.tweens?.add === 'function';

  /** All live VFX game objects — destroyed wholesale in destroy(). */
  const active = new Set<Phaser.GameObjects.GameObject>();

  // Render-only LCG for positional variety — identical pattern to EffectsVfx.ts.
  // Never touches the simulation.
  let vfxSeed = 1;
  function rand(): number {
    vfxSeed = (vfxSeed * 16807) % 2147483647;
    return vfxSeed / 2147483647;
  }
  function spread(mag: number): number {
    return (rand() - 0.5) * 2 * mag;
  }
  function pickColor(colors: readonly number[]): number {
    return colors[Math.floor(rand() * colors.length)] ?? colors[0] ?? 0xffffff;
  }

  /** Register a newly-created shape: pin to screen, set depth, track it. */
  function prep(obj: Phaser.GameObjects.GameObject): void {
    (obj as unknown as { setScrollFactor(n: number): void }).setScrollFactor(0);
    (obj as unknown as { setDepth(n: number): void }).setDepth(VFX_DEPTH);
    active.add(obj);
  }
  /** Remove from tracking and destroy (called by each tween's onComplete). */
  function release(obj: Phaser.GameObjects.GameObject): void {
    active.delete(obj);
    obj.destroy();
  }

  // --- Primitives -------------------------------------------------------

  /** Short-lived expanding + fading ring (filled circle that scales up). */
  function spawnRing(
    x: number,
    y: number,
    color: number,
    radius: number,
    endScale: number,
    durationMs: number,
    alpha = 0.55,
  ): void {
    if (!enabled) return;
    const ring = scene.add.circle(x, y, radius, color, alpha);
    (ring as unknown as { setBlendMode(m: string): void }).setBlendMode('ADD');
    prep(ring);
    scene.tweens.add({
      targets: ring,
      scale: { from: 0.4, to: endScale },
      alpha: { from: alpha, to: 0 },
      duration: durationMs,
      ease: 'Cubic.easeOut',
      onComplete: () => release(ring),
    });
  }

  /** Flying square spark that moves outward and fades away. */
  function spawnSpark(
    x: number,
    y: number,
    color: number,
    speed: number,
    lifetimeMs: number,
  ): void {
    if (!enabled) return;
    const size = 2 + rand() * 3;
    const spark = scene.add.rectangle(x, y, size, size, color);
    (spark as unknown as { setBlendMode(m: string): void }).setBlendMode('ADD');
    prep(spark);
    const angle = rand() * Math.PI * 2;
    const dist = speed * (0.6 + rand() * 0.8);
    scene.tweens.add({
      targets: spark,
      x: x + Math.cos(angle) * dist,
      y: y + Math.sin(angle) * dist,
      alpha: { from: 1, to: 0 },
      scale: { from: 1, to: 0.15 },
      duration: lifetimeMs * (0.7 + rand() * 0.6),
      ease: 'Quad.easeOut',
      onComplete: () => release(spark),
    });
  }

  /** Upward-drifting smoke / confetti mote. */
  function spawnMote(x: number, y: number, color: number, lifetimeMs: number): void {
    if (!enabled) return;
    const size = 2 + rand() * 3;
    const mote = scene.add.rectangle(x + spread(24), y + spread(12), size, size, color);
    (mote as unknown as { setBlendMode(m: string): void }).setBlendMode('ADD');
    prep(mote);
    scene.tweens.add({
      targets: mote,
      y: mote.y - (22 + rand() * 30),
      x: mote.x + spread(14),
      alpha: { from: 0.9, to: 0 },
      duration: lifetimeMs * (0.8 + rand() * 0.5),
      ease: 'Sine.easeOut',
      onComplete: () => release(mote),
    });
  }

  /**
   * Thin laser beam line extending outward from the centre point, fading
   * over ~600 ms. Uses ADD blend for a bright, glowing appearance.
   */
  function spawnBeam(cx: number, cy: number, angle: number, color: number, length: number): void {
    if (!enabled) return;
    const beam = scene.add.graphics();
    beam.setScrollFactor(0);
    beam.setDepth(VFX_DEPTH);
    (beam as unknown as { setBlendMode(m: string): void }).setBlendMode('ADD');
    beam.lineStyle(2, color, 0.9);
    beam.beginPath();
    beam.moveTo(cx, cy);
    beam.lineTo(cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
    beam.strokePath();
    active.add(beam);
    scene.tweens.add({
      targets: beam,
      alpha: { from: 0.9, to: 0 },
      duration: 600,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        active.delete(beam);
        beam.destroy();
      },
    });
  }

  // --- Composite: chest opening -----------------------------------------

  /**
   * Animated "chest" box placed at the given centre. The lid bobs twice then
   * flies upward as anticipation ends, with glowing motes escaping from the
   * opening crack. Total lifetime ~920 ms so it fades before revealing begins.
   */
  function spawnChest(cx: number, cy: number, bucket: RewardExcitementBucket): void {
    if (!enabled) return;
    const colors = BUCKET_COLORS[bucket];
    const glowColor = colors[0] ?? 0x8fa0c2;

    // Chest body — warm dark-brown rectangle
    const bodyY = cy + 24;
    const body = scene.add.rectangle(cx, bodyY, 54, 32, 0x5c3d1e);
    prep(body);
    scene.tweens.add({
      targets: body,
      alpha: { from: 1, to: 0 },
      duration: 180,
      delay: 740,
      onComplete: () => release(body),
    });

    // Chest lid — lighter rectangle that bobs then flings off
    const lidY = cy + 4;
    const lid = scene.add.rectangle(cx, lidY, 58, 20, 0x7a5228);
    prep(lid);
    // Two gentle bobs to tease the opening
    scene.tweens.add({
      targets: lid,
      y: lidY - 6,
      duration: 200,
      yoyo: true,
      repeat: 1,
      ease: 'Sine.easeInOut',
    });
    // Lid flies off with a slight rotation
    const spinDir = rand() > 0.5 ? 1 : -1;
    scene.tweens.add({
      targets: lid,
      y: lidY - 44,
      angle: spinDir * (18 + rand() * 22),
      alpha: { from: 1, to: 0 },
      duration: 260,
      delay: 740,
      ease: 'Back.easeIn',
      onComplete: () => release(lid),
    });

    // Glowing motes escaping through the lid crack while it bobs
    const moteCount = 2 + Math.round(REVEAL_MOTE_COUNT[bucket] / 3);
    for (let i = 0; i < moteCount; i++) {
      const mote = scene.add.circle(cx + spread(10), cy + 14, 2 + rand() * 3, glowColor, 0.85);
      (mote as unknown as { setBlendMode(m: string): void }).setBlendMode('ADD');
      prep(mote);
      scene.tweens.add({
        targets: mote,
        y: mote.y - (18 + rand() * 22),
        x: mote.x + spread(12),
        alpha: { from: 0.85, to: 0 },
        scale: { from: 1, to: 0.3 },
        duration: 480 + rand() * 280,
        delay: 60 + rand() * 380,
        ease: 'Sine.easeOut',
        onComplete: () => release(mote),
      });
    }
  }

  // --- Public API -------------------------------------------------------

  return {
    onAnticipationStart(cx, cy, bucket, reducedMotion) {
      if (reducedMotion || !enabled) return;
      const colors = BUCKET_COLORS[bucket];
      const glowColor = colors[0] ?? 0x8fa0c2;
      // Pulsing outer ring hints at contained energy
      spawnRing(cx, cy, glowColor, 16, 3.5, 820, 0.4);
      // Animated chest with escaping glow motes
      spawnChest(cx, cy, bucket);
      // Smoke rising from the base of the chest
      const smokeCount = 2 + Math.round(REVEAL_MOTE_COUNT[bucket] / 3);
      for (let i = 0; i < smokeCount; i++) {
        spawnMote(cx + spread(22), cy + 28, pickColor(colors), 680 + rand() * 380);
      }
    },

    onItemRevealed(x, y, color, bucket, reducedMotion) {
      if (reducedMotion || !enabled) return;
      const sparkCount = REVEAL_SPARK_COUNT[bucket];
      const colors = BUCKET_COLORS[bucket];
      // Item-colored burst ring from the item's position
      spawnRing(x, y, color, 10, 2.8, 420, 0.7);
      // Outward sparks
      for (let i = 0; i < sparkCount; i++) {
        spawnSpark(x, y, i % 2 === 0 ? color : pickColor(colors), 65, 380);
      }
      // Rising motes for notable+ tiers
      const moteCount = REVEAL_MOTE_COUNT[bucket];
      for (let j = 0; j < moteCount; j++) {
        spawnMote(x, y, pickColor(colors), 480 + rand() * 120);
      }
    },

    onSummaryBurst(cx, cy, bucket, reducedMotion) {
      if (reducedMotion || !enabled) return;
      const colors = BUCKET_COLORS[bucket];
      const endScale = SUMMARY_RING_SCALE[bucket];
      const beamCount = BEAM_COUNT[bucket];

      // Primary ring at every tier
      spawnRing(cx, cy, colors[0] ?? 0x8fa0c2, 8, endScale, 650, 0.6);

      // Additional rings for notable+
      if (bucket !== 'modest') {
        spawnRing(cx, cy, 0xffffff, 5, endScale * 0.7, 820, 0.35);
        spawnRing(cx, cy, colors[1] ?? colors[0] ?? 0x8fa0c2, 14, endScale * 1.2, 780, 0.45);
      }
      if (bucket === 'exciting' || bucket === 'legendary') {
        spawnRing(cx, cy, 0xffffff, 22, endScale * 1.6, 1000, 0.2);
      }
      if (bucket === 'legendary') {
        spawnRing(cx, cy, colors[3] ?? colors[0] ?? 0x8fa0c2, 30, endScale * 2.2, 1200, 0.14);
      }

      // Sparks
      const sparkCount = REVEAL_SPARK_COUNT[bucket] + 4;
      for (let i = 0; i < sparkCount; i++) {
        spawnSpark(cx + spread(8), cy + spread(8), pickColor(colors), 90, 500);
      }

      // Rising confetti motes for notable+
      const moteCount = Math.round(REVEAL_MOTE_COUNT[bucket] * 1.6);
      for (let j = 0; j < moteCount; j++) {
        spawnMote(cx + spread(50), cy + spread(30), pickColor(colors), 720 + rand() * 320);
      }

      // Laser beams for exciting/legendary
      for (let k = 0; k < beamCount; k++) {
        const angle = (k / beamCount) * Math.PI * 2 + rand() * 0.5;
        const length = 90 + rand() * 60;
        spawnBeam(cx, cy, angle, pickColor(colors), length);
      }
    },

    destroy() {
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
