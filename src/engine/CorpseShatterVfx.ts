/**
 * Corpse Shatter VFX — the dramatic payoff for hitting a corpse.
 *
 * When the core damage path emits a `corpseExplode` event, the bridge resolves
 * the corpse's on-screen texture and calls {@link explode}. We cut that texture
 * frame into a grid of shards (each is the full sprite cropped to one cell, with
 * its origin pinned to the cell centre so it tumbles in place) and spray them
 * outward along the blow direction with gravity, spin and a fade-out. A few
 * blood-coloured specks ride along for extra pop.
 *
 * All of the numeric behaviour lives in the Phaser-free {@link ./corpse-shatter}
 * module so it can be unit-tested; this file only owns the Phaser objects and
 * the per-frame loop.
 */
import type Phaser from 'phaser';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import {
  DEFAULT_LAUNCH_PARAMS,
  SHATTER_COLS,
  SHATTER_ROWS,
  buildShatterSpecs,
  integratePieceVelocity,
  pieceProgress,
  rollPieceLaunch,
  scaleLaunchParams,
  shatterAlpha,
  shatterScale,
} from './corpse-shatter.js';

/** Hard cap on simultaneously live shards so dense fights cannot blow up. */
const MAX_SHARDS = 300;
/** Number of blood specks flung alongside the shards. */
const SPECK_COUNT = 8;
const SPECK_SPEED = 150;
const SPECK_LIFETIME_MS = 380;
const SPECK_SIZE_MIN = 2;
const SPECK_SIZE_MAX = 4;
/** Gravity (px/s^2) applied to blood specks. */
const SPECK_GRAVITY = 90;
/** A sprite with no multiply tint (Phaser identity colour). */
const NO_TINT = 0xffffff;

export interface CorpseExplodeOptions {
  /** Corpse centre in world space. */
  x: number;
  y: number;
  /** Texture + frame of the corpse sprite to cut up. */
  textureKey: string;
  frame?: string | number;
  /** Render scale the corpse was drawn at (shards match its on-screen size). */
  scale: number;
  /** Multiply tint currently on the corpse (e.g. the decay grey). */
  tint?: number;
  /** Blood/ichor colour for the accompanying specks. */
  bloodColor: number;
  /** Impact direction (roughly unit length) — shards spray this way. */
  dirX: number;
  dirY: number;
  /** Impact strength (the hit's damage) — scales spray force. */
  amount: number;
}

export interface CorpseShatterVfxConfig {
  /** Global multiplier: 0 disables, 1 normal. Scales spray force + specks. */
  intensity: number;
}

const DEFAULT_CONFIG: CorpseShatterVfxConfig = { intensity: 1 };

interface Shard {
  obj: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotVel: number;
  bornMs: number;
  lifetimeMs: number;
  baseScale: number;
}

interface Speck {
  obj: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  bornMs: number;
}

export function createCorpseShatterVfx(
  scene: Phaser.Scene,
  config: Partial<CorpseShatterVfxConfig> = {},
): {
  explode(options: CorpseExplodeOptions): void;
  update(renderElapsedMs: number, deltaMs: number): void;
  destroy(): void;
  config: CorpseShatterVfxConfig;
} {
  const cfg: CorpseShatterVfxConfig = { ...DEFAULT_CONFIG, ...config };
  const shards: Shard[] = [];
  const specks: Speck[] = [];
  let lastRenderMs = 0;

  // Lightweight non-deterministic RNG — VFX only, never game state.
  let rngState = 0x9e3779b9;
  function rng(): number {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  }

  function ignoreOnUiCamera(obj: Phaser.GameObjects.GameObject): void {
    (scene.cameras?.getCamera?.('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(obj);
  }

  function frameSize(textureKey: string, frame?: string | number): { w: number; h: number } {
    const tex = scene.textures?.get?.(textureKey);
    const fr = tex?.get?.(frame as string | number | undefined);
    const w = fr?.width ?? fr?.realWidth ?? 16;
    const h = fr?.height ?? fr?.realHeight ?? 16;
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function spawnSpecks(
    x: number,
    y: number,
    color: number,
    dirX: number,
    dirY: number,
    count: number,
    renderElapsedMs: number,
  ): void {
    if (typeof scene.add.rectangle !== 'function') return;
    const hasDir = Math.abs(dirX) + Math.abs(dirY) > 0.01;
    for (let i = 0; i < count; i++) {
      const angle = hasDir ? Math.atan2(dirY, dirX) + (rng() - 0.5) * Math.PI : rng() * Math.PI * 2;
      const speed = SPECK_SPEED * (0.4 + rng() * 0.9);
      const size = SPECK_SIZE_MIN + rng() * (SPECK_SIZE_MAX - SPECK_SIZE_MIN);
      const rect = scene.add.rectangle(x, y, size, size, color);
      rect.setDepth(WORLD_VFX_DEPTH.gore);
      rect.setAlpha(0.9);
      ignoreOnUiCamera(rect);
      specks.push({
        obj: rect,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        bornMs: renderElapsedMs,
      });
    }
  }

  function explode(options: CorpseExplodeOptions): void {
    if (cfg.intensity <= 0) return;
    if (typeof scene.add.image !== 'function') return;

    const { x, y, textureKey, frame, scale, tint, bloodColor, dirX, dirY, amount } = options;
    const { w: frameW, h: frameH } = frameSize(textureKey, frame);
    const specs = buildShatterSpecs(frameW, frameH, SHATTER_COLS, SHATTER_ROWS);
    const params = scaleLaunchParams(
      { ...DEFAULT_LAUNCH_PARAMS, baseSpeed: DEFAULT_LAUNCH_PARAMS.baseSpeed * cfg.intensity },
      amount,
      dirX,
      dirY,
    );
    const renderElapsedMs = lastRenderMs;

    for (const spec of specs) {
      const launch = rollPieceLaunch(spec, params, rng);
      const img = scene.add.image(0, 0, textureKey, frame);
      img.setOrigin(spec.originX, spec.originY);
      if (typeof img.setCrop === 'function') {
        img.setCrop(spec.cropX, spec.cropY, spec.cropW, spec.cropH);
      }
      img.setScale(scale);
      if (tint !== undefined && tint !== NO_TINT && typeof img.setTint === 'function') {
        img.setTint(tint);
      }
      img.setDepth(WORLD_VFX_DEPTH.deathPop);
      ignoreOnUiCamera(img);

      const startX = x + spec.offsetX * scale;
      const startY = y + spec.offsetY * scale;
      img.setPosition(startX, startY);

      if (shards.length >= MAX_SHARDS) {
        shards.shift()?.obj.destroy();
      }
      shards.push({
        obj: img,
        x: startX,
        y: startY,
        vx: launch.vx,
        vy: launch.vy,
        rot: 0,
        rotVel: launch.rotVel,
        bornMs: renderElapsedMs,
        lifetimeMs: launch.lifetimeMs,
        baseScale: scale,
      });
    }

    spawnSpecks(
      x,
      y,
      bloodColor,
      dirX,
      dirY,
      Math.round(SPECK_COUNT * cfg.intensity),
      renderElapsedMs,
    );
  }

  function update(renderElapsedMs: number, deltaMs: number): void {
    lastRenderMs = renderElapsedMs;
    const dtSec = Math.max(0, deltaMs) / 1000;

    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i]!;
      const progress = pieceProgress(renderElapsedMs - s.bornMs, s.lifetimeMs);
      if (progress >= 1) {
        s.obj.destroy();
        shards.splice(i, 1);
        continue;
      }

      const v = integratePieceVelocity(s.vx, s.vy, dtSec);
      s.vx = v.vx;
      s.vy = v.vy;
      s.x += s.vx * dtSec;
      s.y += s.vy * dtSec;
      s.rot += s.rotVel * dtSec;

      s.obj.setPosition(s.x, s.y);
      s.obj.setRotation(s.rot);
      s.obj.setAlpha(shatterAlpha(progress));
      s.obj.setScale(s.baseScale * shatterScale(progress));
    }

    for (let i = specks.length - 1; i >= 0; i--) {
      const p = specks[i]!;
      const progress = pieceProgress(renderElapsedMs - p.bornMs, SPECK_LIFETIME_MS);
      if (progress >= 1) {
        p.obj.destroy();
        specks.splice(i, 1);
        continue;
      }
      const decel = 1 - progress * 0.7;
      p.obj.setPosition(p.obj.x + p.vx * dtSec * decel, p.obj.y + p.vy * dtSec * decel);
      p.vy += SPECK_GRAVITY * dtSec;
      p.obj.setAlpha((1 - progress) * 0.9);
    }
  }

  function destroy(): void {
    for (const s of shards) s.obj.destroy();
    shards.length = 0;
    for (const p of specks) p.obj.destroy();
    specks.length = 0;
  }

  return { config: cfg, explode, update, destroy };
}
