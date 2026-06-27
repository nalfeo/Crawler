/**
 * Combat VFX renderer — consumes CombatEvent[] from the world and spawns
 * floating damage numbers / "BLOCKED" indicators in Phaser.
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from '../core/world.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';

const VFX_DURATION_MS = 600;
const VFX_RISE_PX = 24;
const FONT_SIZE = '12px';
const CRIT_FONT_SIZE = '16px';
const FONT_FAMILY = 'monospace';

interface FloatingText {
  obj: Phaser.GameObjects.Text;
  startMs: number;
  startY: number;
}

/** Resolved presentation for a floating combat indicator. */
export interface FloaterStyle {
  label: string;
  color: string;
  fontSize: string;
}

/**
 * Pure mapping from a combat event to its floating-text presentation.
 *
 * Numeric damage is rounded to a whole number for display: the underlying
 * amounts come from f32-backed ECS stores (health / damage), so an integer
 * value such as 8 round-trips to `8.00000011920929`. Rounding is display-only —
 * the precise amount is preserved in the event and in the health stores.
 */
export function combatFloaterStyle(event: CombatEvent): FloaterStyle {
  if (event.type === 'miss') {
    return { label: 'MISS', color: '#a0a0a0', fontSize: FONT_SIZE };
  }
  if (event.type === 'dodge') {
    return { label: 'DODGE', color: '#44ddff', fontSize: FONT_SIZE };
  }
  if (event.type === 'blocked') {
    return { label: 'BLOCKED', color: '#888888', fontSize: FONT_SIZE };
  }

  const amount = Math.round(event.amount);
  if (event.targetType === 'player') {
    return { label: `-${amount}`, color: '#ff4444', fontSize: FONT_SIZE };
  }
  if (event.isCrit) {
    // Critical hit on an enemy — emphasized: brighter, larger, trailing "!".
    return { label: `-${amount}!`, color: '#ff8800', fontSize: CRIT_FONT_SIZE };
  }
  return { label: `-${amount}`, color: '#ffdd44', fontSize: FONT_SIZE };
}

export function createCombatVfx(scene: Phaser.Scene): {
  update(world: GameWorld, renderElapsedMs: number): void;
  destroy(): void;
} {
  const floaters: FloatingText[] = [];

  function spawnFloater(event: CombatEvent, renderElapsedMs: number): void {
    const { label, color, fontSize } = combatFloaterStyle(event);

    const text = scene.add.text(event.x, event.y - 8, label, {
      fontFamily: FONT_FAMILY,
      fontSize,
      color,
      stroke: '#000000',
      strokeThickness: 2,
    });
    text.setOrigin(0.5, 1);
    // World-space VFX: depth must stay below UI_DEPTH_CUTOFF (see render-depths.ts).
    text.setDepth(WORLD_VFX_DEPTH.combatText);
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(text);

    floaters.push({ obj: text, startMs: renderElapsedMs, startY: event.y - 8 });
  }

  return {
    update(world: GameWorld, renderElapsedMs: number): void {
      // Spawn VFX for new events
      for (const event of world.combatEvents) {
        // `corpseExplode` is consumed by the shatter VFX, not shown as a damage
        // number — a corpse takes 0 actual damage, so a floater would mislead.
        if (event.type === 'corpseExplode') continue;
        spawnFloater(event, renderElapsedMs);
      }
      // Drain the queue — we are the sole consumer
      world.combatEvents.length = 0;

      // Animate and clean up existing floaters
      for (let i = floaters.length - 1; i >= 0; i--) {
        const f = floaters[i]!;
        const age = renderElapsedMs - f.startMs;
        const progress = Math.min(1, age / VFX_DURATION_MS);

        if (progress >= 1) {
          f.obj.destroy();
          floaters.splice(i, 1);
          continue;
        }

        // Rise and fade
        f.obj.setY(f.startY - VFX_RISE_PX * progress);
        f.obj.setAlpha(1 - progress * progress);
      }
    },

    destroy(): void {
      for (const f of floaters) {
        f.obj.destroy();
      }
      floaters.length = 0;
    },
  };
}
