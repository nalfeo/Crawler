import { describe, expect, it } from 'vitest';
import { floor5Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor5 = typeof floor5Manifest & {
  floor5: NonNullable<typeof floor5Manifest.floor5>;
};

function cloneFloor5Manifest(): ManifestWithFloor5 {
  return structuredClone(floor5Manifest) as ManifestWithFloor5;
}

describe('floor5 manifest Ratings Ram rules', () => {
  it('accepts the authored outer-wall exchange', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor5Manifest()).success).toBe(true);
  });

  it('rejects ram strike damage that exceeds outer-wall health', () => {
    const bad = cloneFloor5Manifest();
    bad.floor5.ram.strike.damage = bad.floor5.outerWall.health + 1;

    const result = floorManifestDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['floor5', 'ram', 'strike', 'damage'],
          }),
        ]),
      );
    }
  });
});
