import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleMobMotion, selectMobSprites } from '../../src/labs/mob-motion-lab/model.js';

function manifestEntry(briefId: string, variantIndex: number, type: 'enemy' | 'item' | null) {
  return {
    briefId,
    spriteName: `${briefId}-var-${variantIndex}`,
    assetPath: `generated/${briefId}-var-${variantIndex}.png`,
    approvedAt: '2026-07-17T00:00:00.000Z',
    sourceRun: 'test-run',
    variantIndex,
    anchor: { x: 31, y: 60, source: 'manual' as const },
    anchors: {
      hold: { x: 31, y: 60, source: 'manual' as const },
      centerOfGravity: { x: 30, y: 35, source: 'manual' as const },
    },
    sensorScore: '7/7',
    judgeScore: '2',
    type,
    facingDirection: 'right' as const,
  };
}

describe('mob motion lab model', () => {
  it('selects approved mobile enemy variants and preserves their pivots', () => {
    const sprites = selectMobSprites({
      version: 1,
      entries: {
        'rat-var-3': manifestEntry('rat', 3, 'enemy'),
        'rat-var-1': manifestEntry('rat', 1, 'enemy'),
        'rat-nest-var-0': manifestEntry('rat-nest-v2', 0, 'enemy'),
        'sword-var-0': manifestEntry('sword', 0, 'item'),
        'legacy-rat-var-0': manifestEntry('legacy-rat', 0, null),
      },
    });

    expect(sprites.map((sprite) => sprite.textureKey)).toEqual(['rat-var-1', 'rat-var-3']);
    expect(sprites[0]).toMatchObject({
      assetPath: 'generated/rat-var-1.png',
      anchor: { x: 31, y: 60 },
      centerOfGravity: { x: 30, y: 35 },
    });
  });

  it('produces distinct deterministic transforms for movement, attack, and hit', () => {
    const movement = sampleMobMotion('movement', 140);
    const attack = sampleMobMotion('attack', 385);
    const hit = sampleMobMotion('hit', 100);

    expect(sampleMobMotion('attack', 385)).toEqual(attack);
    expect(
      new Set([JSON.stringify(movement), JSON.stringify(attack), JSON.stringify(hit)]).size,
    ).toBe(3);
    expect(movement.offsetY).toBeLessThan(0);
    expect(attack.offsetX).toBeGreaterThan(0);
    expect(hit.flash).toBeGreaterThan(0);
  });

  it('returns to a neutral hit pose outside the reaction window', () => {
    expect(sampleMobMotion('hit', 700)).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
      flash: 0,
    });
  });

  it('is discoverable through the lazy lab loader', () => {
    const source = readFileSync('src/lab-main.ts', 'utf8');
    expect(source).toContain("'mob-motion-lab': '/src/labs/mob-motion-lab/index.ts'");
  });
});
