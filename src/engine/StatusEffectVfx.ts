/**
 * Status-effect VFX renderer — the persistent "this enemy is under a status
 * effect" indicator.
 *
 * Draws a pulsing ground-plane aura beneath every affected enemy so a curse /
 * slow / regen reads instantly, instead of relying on the very subtle multiply
 * tint that was the only cue before (issue #3690).
 *
 * Cost/lifecycle note: every aura is drawn into ONE shared `Graphics` object
 * that is cleared and redrawn each rendered frame, rather than one Graphics per
 * entity. That keeps the display list flat at 100+ affected enemies and — more
 * importantly — makes EID recycling a non-issue: there is no per-entity cached
 * object that could survive its entity and re-attach to a recycled EID.
 *
 * The renderer is a pure consumer of the target list `PhaserBridge` builds from
 * the same live-enemy/FOV gate the sprite and health bar use, so it can never
 * reveal an enemy hidden by fog, nor paint a corpse. The pulse phase is derived
 * from the render clock only and never feeds simulation state.
 */
import type Phaser from 'phaser';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';

/** One enemy's resolved aura, in render pixels. */
export interface StatusAuraTarget {
  readonly x: number;
  readonly y: number;
  /** Horizontal radius of the ground ellipse in px. */
  readonly radiusPx: number;
  readonly color: number;
}

/** Full pulse cycle. Slow enough to read as a breath, not a strobe. */
const PULSE_PERIOD_MS = 900;
/** Ground ellipses are squashed vertically to sit flat on the floor plane. */
const VERTICAL_SQUASH = 0.42;
const MIN_RADIUS_PX = 6;
const GLOW_ALPHA_MIN = 0.16;
const GLOW_ALPHA_MAX = 0.34;
const RING_ALPHA = 0.85;
const RING_WIDTH_PX = 2;

export function createStatusEffectVfx(scene: Phaser.Scene): {
  update(targets: readonly StatusAuraTarget[], renderElapsedMs: number): void;
  destroy(): void;
} {
  const enabled = typeof scene.add?.graphics === 'function';
  let gfx: Phaser.GameObjects.Graphics | undefined;

  function ensureGraphics(): Phaser.GameObjects.Graphics | undefined {
    if (!enabled) return undefined;
    if (gfx === undefined) {
      gfx = scene.add.graphics();
      gfx.name = 'statusEffectAura';
      gfx.setDepth(WORLD_VFX_DEPTH.statusAura);
      if (typeof gfx.setBlendMode === 'function') gfx.setBlendMode('ADD');
      (scene.cameras?.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(gfx);
    }
    return gfx;
  }

  function update(targets: readonly StatusAuraTarget[], renderElapsedMs: number): void {
    if (!enabled) return;
    if (targets.length === 0) {
      gfx?.clear();
      gfx?.setVisible(false);
      return;
    }
    const graphics = ensureGraphics();
    if (graphics === undefined) return;
    graphics.setVisible(true);
    graphics.clear();

    // One shared phase for every aura: statuses applied by the same burst then
    // pulse in sync, which reads as one effect rather than visual noise.
    const phase = (renderElapsedMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const glowAlpha = GLOW_ALPHA_MIN + (GLOW_ALPHA_MAX - GLOW_ALPHA_MIN) * wave;

    for (const target of targets) {
      const radius = Math.max(MIN_RADIUS_PX, target.radiusPx);
      const ringRadius = radius * (0.86 + 0.14 * wave);
      graphics.fillStyle(target.color, glowAlpha);
      graphics.fillEllipse(target.x, target.y, radius * 2, radius * 2 * VERTICAL_SQUASH);
      graphics.lineStyle(RING_WIDTH_PX, target.color, RING_ALPHA);
      graphics.strokeEllipse(target.x, target.y, ringRadius * 2, ringRadius * 2 * VERTICAL_SQUASH);
    }
  }

  function destroy(): void {
    gfx?.destroy();
    gfx = undefined;
  }

  return { update, destroy };
}
