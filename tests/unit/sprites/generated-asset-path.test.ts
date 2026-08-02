import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  GENERATED_ASSET_PREFIX,
  assertResolvedUnderGenerated,
  isSafeGeneratedAssetPath,
  resolveGeneratedAssetPath,
} from '../../../scripts/sprites/generated-asset-path.js';

describe('isSafeGeneratedAssetPath', () => {
  it('accepts in-tree generated/*.png paths (incl. nested)', () => {
    expect(isSafeGeneratedAssetPath('generated/iron-sword-v1-var-0.png')).toBe(true);
    expect(isSafeGeneratedAssetPath('generated/sub/dir/lamp.PNG')).toBe(true);
    expect(GENERATED_ASSET_PREFIX).toBe('generated/');
  });

  it('rejects traversal segments (the core "our art only" guard)', () => {
    expect(isSafeGeneratedAssetPath('generated/../kenney/roguelike/spritesheet.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated/../../etc/passwd.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated/./lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated//lamp.png')).toBe(false);
  });

  it('rejects absolute paths, Windows separators, and NUL bytes', () => {
    expect(isSafeGeneratedAssetPath('/generated/lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('C:/generated/lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated\\lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated\\..\\kenney\\x.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated/lamp.png\0.js')).toBe(false);
  });

  it('rejects paths outside generated/ and non-PNG files', () => {
    expect(isSafeGeneratedAssetPath('kenney/roguelike/lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('generated/lamp.json')).toBe(false);
    expect(isSafeGeneratedAssetPath('generatedX/lamp.png')).toBe(false);
    expect(isSafeGeneratedAssetPath('')).toBe(false);
  });
});

describe('assertResolvedUnderGenerated', () => {
  const publicAssetsRoot = path.resolve('/repo', 'public', 'assets');

  it('passes for a path resolved inside the generated tree', () => {
    const inside = path.resolve(publicAssetsRoot, 'generated', 'lamp.png');
    expect(() => assertResolvedUnderGenerated(inside, publicAssetsRoot, 'ctx')).not.toThrow();
  });

  it('throws for a path that escapes the generated tree', () => {
    const escape = path.resolve(publicAssetsRoot, 'kenney', 'roguelike', 'x.png');
    expect(() => assertResolvedUnderGenerated(escape, publicAssetsRoot, 'ctx')).toThrow(
      /escapes the generated asset tree/,
    );
  });

  it('throws when the resolved path is the generated root itself', () => {
    const root = path.resolve(publicAssetsRoot, 'generated');
    expect(() => assertResolvedUnderGenerated(root, publicAssetsRoot, 'ctx')).toThrow();
  });
});

describe('resolveGeneratedAssetPath', () => {
  const publicAssetsRoot = path.resolve('/repo', 'public', 'assets');

  it('returns an absolute in-tree path for safe generated assets', () => {
    expect(
      resolveGeneratedAssetPath('generated/items/lamp.png', publicAssetsRoot, 'ctx'),
    ).toBe(path.resolve(publicAssetsRoot, 'generated', 'items', 'lamp.png'));
  });

  it('throws before any caller can use a traversal path', () => {
    expect(() =>
      resolveGeneratedAssetPath('generated/../../etc/passwd.png', publicAssetsRoot, 'ctx'),
    ).toThrow(/not a safe generated\/\*\.png path/);
  });
});
