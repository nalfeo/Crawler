/** Generation Lab — unified sandbox for testing all data-driven generation pipelines.
 *
 * This lab tests three major generation systems:
 * 1. Mob Generation — enemy/creature definitions with behavior tuning
 * 2. Tile Generation — floor tileset definitions with collision & biome variants
 * 3. Decoration Generation — non-interactive scene dressing & ambient objects
 *
 * Each pipeline follows the same pattern: TypeScript defs + JSON data + getter functions.
 */

import { describe, it, expect } from 'vitest';

// --- Mob Pipeline ---
import { getMobDef, MOB_DEFS } from '../../../src/shared/mobDefs.js';

// --- Tile Pipeline ---
import { getTileDef, getTilesByBiome, TILE_DEFS } from '../../../src/shared/tileDefs.js';

// --- Decoration Pipeline ---
import {
  getDecorationDef,
  getDecorationsByBiome,
  DECORATION_DEFS,
} from '../../../src/shared/decorationDefs.js';

describe('Generation Lab: Mob Pipeline', () => {
  it('should load all mob definitions', () => {
    expect(MOB_DEFS.size).toBeGreaterThan(0);
    expect(MOB_DEFS.has('zombie')).toBe(true);
    expect(MOB_DEFS.has('directors-proxy')).toBe(true);
  });

  it('should lookup mobs by id', () => {
    const zombie = getMobDef('zombie');
    expect(zombie?.name).toBe('Zombie');
    expect(zombie?.baseHp).toBe(20);
    expect(zombie?.aiPattern).toBe('chase');
  });

  it('should scale stats by rarity', () => {
    const common = getMobDef('zombie')!;
    const rare = getMobDef('reaver')!;
    const elite = getMobDef('goliath')!;
    const boss = getMobDef('directors-proxy')!;

    expect(rare.baseHp).toBeGreaterThan(common.baseHp);
    expect(elite.baseHp).toBeGreaterThan(rare.baseHp);
    expect(boss.baseHp).toBeGreaterThan(elite.baseHp);
  });

  it('should have valid ai patterns', () => {
    const validPatterns = ['chase', 'patrol', 'ranged', 'melee', 'mixed'];
    for (const def of MOB_DEFS.values()) {
      expect(validPatterns).toContain(def.aiPattern);
    }
  });

  it('should have valid size categories', () => {
    const validSizes = ['small', 'medium', 'large', 'boss'];
    for (const def of MOB_DEFS.values()) {
      expect(validSizes).toContain(def.sizeCategory);
    }
  });

  it('should validate stat ranges', () => {
    for (const def of MOB_DEFS.values()) {
      expect(def.baseHp).toBeGreaterThan(0);
      expect(def.baseSpeed).toBeGreaterThan(0);
      expect(def.baseDamage).toBeGreaterThan(0);
      expect(def.knockbackMult).toBeGreaterThanOrEqual(0);
      expect(def.knockbackMult).toBeLessThanOrEqual(2.0);
      expect(def.goreFactor).toBeGreaterThanOrEqual(0);
      expect(def.goreFactor).toBeLessThanOrEqual(1.0);
      expect(def.xpMultiplier).toBeGreaterThan(0);
    }
  });

  it('should have non-empty loot table references', () => {
    for (const def of MOB_DEFS.values()) {
      expect(def.lootTableId.length).toBeGreaterThan(0);
    }
  });

  it('should have valid sprite references', () => {
    for (const def of MOB_DEFS.values()) {
      expect(def.spriteId).toMatch(/^mob-/);
    }
  });
});

describe('Generation Lab: Tile Pipeline', () => {
  it('should load all tile definitions', () => {
    expect(TILE_DEFS.size).toBeGreaterThan(0);
    expect(TILE_DEFS.has('stone-floor')).toBe(true);
    expect(TILE_DEFS.has('rift')).toBe(true);
  });

  it('should lookup tiles by id', () => {
    const floor = getTileDef('stone-floor');
    expect(floor?.name).toBe('Stone Floor');
    expect(floor?.passability).toBe('walkable');
    expect(floor?.biomeTag).toBe('dungeon');
  });

  it('should filter tiles by biome', () => {
    const dungeon = getTilesByBiome('dungeon');
    const organic = getTilesByBiome('organic');
    const tech = getTilesByBiome('tech');
    const void_ = getTilesByBiome('void');

    expect(dungeon.length).toBeGreaterThan(0);
    expect(organic.length).toBeGreaterThan(0);
    expect(tech.length).toBeGreaterThan(0);
    expect(void_.length).toBeGreaterThan(0);
  });

  it('should have valid collider types', () => {
    const validColliders = ['none', 'solid', 'hazard'];
    for (const def of TILE_DEFS.values()) {
      expect(validColliders).toContain(def.collider);
    }
  });

  it('should have valid passability types', () => {
    const validPassability = ['walkable', 'blocked', 'deadly'];
    for (const def of TILE_DEFS.values()) {
      expect(validPassability).toContain(def.passability);
    }
  });

  it('should validate passability matches collider', () => {
    for (const def of TILE_DEFS.values()) {
      if (def.collider === 'solid') {
        expect(def.passability).toBe('blocked');
      } else if (def.collider === 'hazard') {
        expect(def.passability).toBe('deadly');
      }
    }
  });

  it('should validate hazard damage', () => {
    for (const def of TILE_DEFS.values()) {
      if (def.collider === 'hazard') {
        expect(def.damagePerSecond).toBeGreaterThan(0);
      } else {
        expect(def.damagePerSecond).toBe(0);
      }
    }
  });

  it('should have valid sprite references', () => {
    for (const def of TILE_DEFS.values()) {
      expect(def.spriteId).toMatch(/^tile-/);
    }
  });

  it('should scale hazard damage by danger', () => {
    const blood = getTileDef('blood-pool')!;
    const barrier = getTileDef('energy-barrier')!;
    const rift = getTileDef('rift')!;

    expect(blood.damagePerSecond).toBeLessThan(barrier.damagePerSecond);
    expect(barrier.damagePerSecond).toBeLessThan(rift.damagePerSecond);
  });
});

describe('Generation Lab: Decoration Pipeline', () => {
  it('should load all decoration definitions', () => {
    expect(DECORATION_DEFS.size).toBeGreaterThan(0);
    expect(DECORATION_DEFS.has('torch')).toBe(true);
    expect(DECORATION_DEFS.has('void-tendril')).toBe(true);
  });

  it('should lookup decorations by id', () => {
    const torch = getDecorationDef('torch');
    expect(torch?.name).toBe('Torch');
    expect(torch?.isAnimated).toBe(true);
    expect(torch?.biomeTag).toBe('dungeon');
  });

  it('should wire floor-1 prop defs to generated sprite assets', () => {
    expect(getDecorationDef('torch')?.spriteId).toBe('prop-torch-var-10');
    expect(getDecorationDef('junk-pile')?.spriteId).toBe('prop-junk-pile-var-0');
    expect(getDecorationDef('wall-sconce')?.spriteId).toBe('prop-wall-sconce-var-1');
  });

  it('should filter decorations by biome', () => {
    const dungeon = getDecorationsByBiome('dungeon');
    const organic = getDecorationsByBiome('organic');
    const tech = getDecorationsByBiome('tech');
    const void_ = getDecorationsByBiome('void');

    expect(dungeon.length).toBeGreaterThan(0);
    expect(organic.length).toBeGreaterThan(0);
    expect(tech.length).toBeGreaterThan(0);
    expect(void_.length).toBeGreaterThan(0);
  });

  it('should have valid depth layers', () => {
    const validLayers = ['back', 'mid', 'front'];
    for (const def of DECORATION_DEFS.values()) {
      expect(validLayers).toContain(def.depthLayer);
    }
  });

  it('should validate scale and rotation', () => {
    for (const def of DECORATION_DEFS.values()) {
      expect(def.scale).toBeGreaterThan(0);
      expect(def.scale).toBeLessThanOrEqual(2.0);
      expect(def.rotation === -1 || (def.rotation >= 0 && def.rotation <= 360)).toBe(true);
    }
  });

  it('should have valid animation frames', () => {
    for (const def of DECORATION_DEFS.values()) {
      expect(def.animationFrames).toBeGreaterThanOrEqual(1);
      if (def.isAnimated) {
        expect(def.animationFrames).toBeGreaterThan(1);
      } else {
        expect(def.animationFrames).toBe(1);
      }
    }
  });

  it('should validate density is reasonable', () => {
    for (const def of DECORATION_DEFS.values()) {
      expect(def.density).toBeGreaterThanOrEqual(0);
      expect(def.density).toBeLessThanOrEqual(1.0);
    }
  });

  it('should validate destructible decorations have loot', () => {
    for (const def of DECORATION_DEFS.values()) {
      if (def.isDestructible) {
        expect(def.lootTableId).toBeDefined();
        expect(def.lootTableId!.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have valid sprite references', () => {
    for (const def of DECORATION_DEFS.values()) {
      // Sprite IDs use either the legacy deco- prefix or the newer prop- prefix
      // for scene-dressing props (junk-pile, wall-sconce, etc.).
      expect(def.spriteId).toMatch(/^(deco|prop)-/);
    }
  });

  it('should distribute across depth layers', () => {
    const back = Array.from(DECORATION_DEFS.values()).filter((d) => d.depthLayer === 'back');
    const mid = Array.from(DECORATION_DEFS.values()).filter((d) => d.depthLayer === 'mid');
    const front = Array.from(DECORATION_DEFS.values()).filter((d) => d.depthLayer === 'front');

    expect(back.length).toBeGreaterThan(0);
    expect(mid.length).toBeGreaterThan(0);
    expect(front.length).toBeGreaterThan(0);
  });

  it('should calculate spawn counts correctly', () => {
    const FLOOR_AREA = 320 * 180;
    const torch = getDecorationDef('torch')!;
    const barrel = getDecorationDef('barrel')!;

    const torchCount = Math.floor((FLOOR_AREA / 1000) * torch.density);
    const barrelCount = Math.floor((FLOOR_AREA / 1000) * barrel.density);

    expect(torchCount).toBeGreaterThan(0);
    expect(barrelCount).toBeGreaterThan(0);
    expect(torchCount).toBeGreaterThan(barrelCount);
  });
});
