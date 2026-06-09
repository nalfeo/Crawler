import { WeaponType } from '../shared/constants.js';
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

interface RandomLike {
  (): number;
}

export interface CollisionEffectsConfig {
  hitGoreEnabled: boolean;
}

const HIT_BASE_PARTICLES = 4;
export function createCollisionEffectsSystem(
  spawnParticles: SpawnParticles,
  vfxRandom: RandomLike,
  config: CollisionEffectsConfig,
): {
  handle(event: CombatEvent, renderElapsedMs: number): void;
} {
  function getDirectionalVector(event: CombatEvent): { x: number; y: number } {
    if (
      event.sourceX !== undefined &&
      event.sourceY !== undefined &&
      (Math.abs(event.x - event.sourceX) > 0.01 || Math.abs(event.y - event.sourceY) > 0.01)
    ) {
      const dx = event.x - event.sourceX;
      const dy = event.y - event.sourceY;
      const dist = Math.hypot(dx, dy);
      return { x: dx / dist, y: dy / dist };
    }

    const angle = vfxRandom() * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }

  function handleHitEvent(event: CombatEvent, renderElapsedMs: number): void {
    if (!config.hitGoreEnabled) return;
    if (event.type !== 'hit' || event.targetType !== 'enemy') return;

    const goreFactor = event.weaponGoreFactor ?? 0.5;
    if (vfxRandom() > goreFactor) return;

    const count = Math.round(HIT_BASE_PARTICLES * goreFactor * (event.amount / 10));
    const particleCount = Math.max(1, Math.min(count, 8));
    const dir = getDirectionalVector(event);

    let colors: readonly number[] = GORE_PALETTES.living;
    if (event.targetMaterial === 'undead') {
      colors = GORE_PALETTES.undead;
    } else if (event.targetMaterial === 'mechanical') {
      colors = GORE_PALETTES.mechanical;
    }

    spawnParticles(
      event.x,
      event.y,
      particleCount,
      dir.x,
      dir.y,
      Math.PI * 1.0,
      renderElapsedMs,
      colors,
    );
  }

  function handleSurfaceEvent(event: CombatEvent, renderElapsedMs: number): void {
    if (event.type !== 'surface-hit' || event.surfaceType !== 'wall') return;
    const dir = getDirectionalVector(event);

    let count = 4;
    let spread = Math.PI * 0.9;
    let colors: readonly number[] = GORE_PALETTES.wallDust;
    if (event.weaponType === WeaponType.MAGIC || event.weaponType === WeaponType.BEAM) {
      count = 8;
      spread = Math.PI * 1.4;
      colors = GORE_PALETTES.wallSpark;
    } else if (event.weaponType === WeaponType.RANGED || event.weaponType === 'enemy-projectile') {
      count = 6;
      colors = [...GORE_PALETTES.wallDust, ...GORE_PALETTES.wallSpark];
    } else if (event.weaponType === WeaponType.THROWN || event.weaponType === WeaponType.MELEE) {
      count = 5;
      spread = Math.PI * 0.8;
      colors = GORE_PALETTES.wallDust;
    }

    spawnParticles(event.x, event.y, count, dir.x, dir.y, spread, renderElapsedMs, colors);
  }

  return {
    handle(event: CombatEvent, renderElapsedMs: number): void {
      handleHitEvent(event, renderElapsedMs);
      handleSurfaceEvent(event, renderElapsedMs);
    },
  };
}
