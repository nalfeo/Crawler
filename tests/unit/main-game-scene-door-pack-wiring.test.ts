import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MainGameScene doorSet wiring', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('resolves door orientation + pack variant through shared terrain-pack helpers', () => {
    expect(source).toContain('resolveDoorOrientationFromFlanks(horizontalDoorway)');
    expect(source).toContain('resolveDoorPoolVariant(activeDoorSet, { isOpen, orientation })');
  });

  it('passes the resolved pack door texture key into resolveDoorRenderMode', () => {
    expect(source).toContain('packDoorTextureKey');
    expect(source).toContain('resolveDoorRenderMode(isOpen, {');
  });

  it('threads floor manifest terrainPackId into terrain bake and door overlay paths', () => {
    expect(source).toContain('getFloorManifest(this.options.floorId)?.terrainPackId');
    expect(source).toContain('buildTerrainLayer(this, floorMap, {');
  });
});
