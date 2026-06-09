import { WeaponType } from '../shared/constants.js';
import type { CombatEvent } from '../shared/combat-events.js';

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
const LIVING_COLORS = [0xcc0000, 0xaa0000, 0x880000, 0x660000, 0x990000];
const UNDEAD_COLORS = [0x6b8f23, 0x4f6f1a, 0x7f9f2a, 0x2f4f2f];
const MECHANICAL_COLORS = [0xa7b3c2, 0x7b8794, 0xcfd8dc, 0x6bc4ff];
const WALL_DUST_COLORS = [0x8b7d6b, 0x6f6457, 0x9c907f];
const WALL_SPARK_COLORS = [0xffaa33, 0xffdd66, 0x66ccff];

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

    let colors = LIVING_COLORS;
    if (event.targetMaterial === 'undead') {
      colors = UNDEAD_COLORS;
    } else if (event.targetMaterial === 'mechanical') {
      colors = MECHANICAL_COLORS;
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
    let colors: readonly number[] = WALL_DUST_COLORS;
    if (event.weaponType === WeaponType.MAGIC || event.weaponType === WeaponType.BEAM) {
      count = 8;
      spread = Math.PI * 1.4;
      colors = WALL_SPARK_COLORS;
    } else if (event.weaponType === WeaponType.RANGED || event.weaponType === 'enemy-projectile') {
      count = 6;
      colors = [...WALL_DUST_COLORS, ...WALL_SPARK_COLORS];
    } else if (event.weaponType === WeaponType.THROWN || event.weaponType === WeaponType.MELEE) {
      count = 5;
      spread = Math.PI * 0.8;
      colors = WALL_DUST_COLORS;
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
