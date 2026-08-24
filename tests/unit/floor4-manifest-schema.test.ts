import { describe, expect, it } from 'vitest';
import { floor4Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor4 = typeof floor4Manifest & {
  floor4: NonNullable<typeof floor4Manifest.floor4>;
};

function cloneFloor4Manifest(): ManifestWithFloor4 {
  return structuredClone(floor4Manifest) as ManifestWithFloor4;
}

describe('floor4 manifest schema cross-field geometry rules', () => {
  it('accepts the authored floor4 manifest geometry', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor4Manifest()).success).toBe(true);
  });

  it('rejects a tunnel wider than the Green Room height', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.tunnel.widthTiles = bad.floor4.greenRoom.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects pillars that would meet in the middle of the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.pillarInsetTiles = 19;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a Green Room taller than the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.heightTiles = bad.floor4.arena.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects tunnel geometry whose mouth collides with the east feed gate', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.heightTiles = 40;
    bad.floor4.tunnel.widthTiles = 20;
    bad.floor4.greenRoom.heightTiles = 20;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
