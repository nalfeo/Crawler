import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('MainGameScene NPC interaction priority', () => {
  it('chooses the nearest nearby NPC when several are in range', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('let nearNpcDistanceSq = Number.POSITIVE_INFINITY;');
    expect(source).toContain('const distanceSq = dx * dx + dy * dy;');
    expect(source).toContain('if (distanceSq < nearNpcDistanceSq) {');
    expect(source).toContain('nearNpcDistanceSq = distanceSq;');
  });
});
