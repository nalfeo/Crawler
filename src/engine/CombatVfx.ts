/**
 * Combat VFX renderer — consumes CombatEvent[] from the world and spawns
 * floating damage numbers / "BLOCKED" indicators in Phaser.
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import type { GameWorld } from '../core/world.js';

const VFX_DURATION_MS = 600;
const VFX_RISE_PX = 24;
const FONT_SIZE = '12px';
const FONT_FAMILY = 'monospace';

interface FloatingText {
  obj: Phaser.GameObjects.Text;
  startMs: number;
  startY: number;
}

export function createCombatVfx(scene: Phaser.Scene): {
  update(world: GameWorld, renderElapsedMs: number): void;
  destroy(): void;
} {
  const floaters: FloatingText[] = [];

  function spawnFloater(event: CombatEvent, renderElapsedMs: number): void {
    if (event.type === 'surface-hit') {
      return;
    }

    let label: string;
    let color: string;

    if (event.type === 'blocked') {
      label = 'BLOCKED';
      color = '#888888';
    } else if (event.targetType === 'player') {
      label = `-${event.amount}`;
      color = '#ff4444';
    } else {
      label = `-${event.amount}`;
      color = '#ffdd44';
    }

    const text = scene.add.text(event.x, event.y - 8, label, {
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      color,
      stroke: '#000000',
      strokeThickness: 2,
    });
    text.setOrigin(0.5, 1);
    text.setDepth(1000);

    floaters.push({ obj: text, startMs: renderElapsedMs, startY: event.y - 8 });
  }

  return {
    update(world: GameWorld, renderElapsedMs: number): void {
      // Spawn VFX for new events
      for (const event of world.combatEvents) {
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
