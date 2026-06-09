import type { CombatEvent } from '../shared/combat-events.js';
import { GORE_PALETTES } from './GorePalettes.js';

interface SpawnParticles {
  (
    x: number,
    y: number,
    count: number,
    dirX: number,
    dirY: number,
    spread: number,
    renderElapsedMs: number,
    colors: readonly number[],
  ): void;
}

const DEATH_BASE_PARTICLES = 16;
export function createDeathEffectsSystem(
  spawnParticles: SpawnParticles,
): {
  handle(event: CombatEvent, renderElapsedMs: number): void;
} {
  return {
    handle(event: CombatEvent, renderElapsedMs: number): void {
      if (event.type !== 'death') return;

      const overkill = event.overkill ?? 0;
      const overkillMult = 1 + Math.min(overkill / 20, 3);
      const count = Math.round(DEATH_BASE_PARTICLES * overkillMult);

      let colors: readonly number[] = GORE_PALETTES.living;
      if (event.targetMaterial === 'undead') {
        colors = GORE_PALETTES.undead;
      } else if (event.targetMaterial === 'mechanical') {
        colors = GORE_PALETTES.mechanical;
      }

      let dirX = event.knockbackDirX ?? 0;
      let dirY = event.knockbackDirY ?? 0;
      let hasDir = Math.abs(dirX) + Math.abs(dirY) > 0.01;

      if (
        !hasDir &&
        event.sourceX !== undefined &&
        event.sourceY !== undefined &&
        (Math.abs(event.x - event.sourceX) > 0.01 || Math.abs(event.y - event.sourceY) > 0.01)
      ) {
        const dx = event.x - event.sourceX;
        const dy = event.y - event.sourceY;
        const dist = Math.hypot(dx, dy);
        dirX = dx / dist;
        dirY = dy / dist;
        hasDir = true;
      }

      spawnParticles(
        event.x,
        event.y,
        count,
        hasDir ? dirX : 0,
        hasDir ? dirY : -1,
        hasDir ? Math.PI * 1.2 : Math.PI * 2,
        renderElapsedMs,
        colors,
      );
    },
  };
}
