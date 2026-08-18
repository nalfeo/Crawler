/**
 * Regression tests for the sprite-catalog lab's base-aware asset URL helpers.
 *
 * The lab previously assigned root-absolute `/assets/...` URLs to `img.src` /
 * `fetch`, which 404 on GitHub Pages (served under `base = /Crawler/dev/`) and
 * left generated + sheet sprite previews broken. These helpers resolve every
 * URL against the deployed Vite base so previews render in every environment.
 *
 * `basePath` is passed explicitly here (production callers omit it) so the
 * assertions are deterministic and independent of `import.meta.env.BASE_URL`.
 */

import { describe, expect, it } from 'vitest';
import {
  generatedSpritePreviewUrl,
  sheetImageUrl,
} from '../../src/labs/sprite-catalog-lab/asset-urls.js';

const PAGES_BASE = '/Crawler/dev/';
const PROD_BASE = '/Crawler/';
const LOCAL_BASE = '/';

describe('generatedSpritePreviewUrl', () => {
  it('applies the deploy base to a relative assetPath', () => {
    expect(
      generatedSpritePreviewUrl(
        {
          spriteId: 'sewer-grate-floor-tile-var-1',
          assetPath: 'generated/sewer-grate-floor-tile-var-1.png',
        },
        PAGES_BASE,
      ),
    ).toBe('/Crawler/dev/assets/generated/sewer-grate-floor-tile-var-1.png');
  });

  it('keeps root-absolute paths when the base is "/" (local dev)', () => {
    expect(
      generatedSpritePreviewUrl({ spriteId: 'x', assetPath: 'generated/x.png' }, LOCAL_BASE),
    ).toBe('/assets/generated/x.png');
  });

  it('falls back to generated/<spriteId>.png when assetPath is missing', () => {
    expect(generatedSpritePreviewUrl({ spriteId: 'rat-var-3' }, PAGES_BASE)).toBe(
      '/Crawler/dev/assets/generated/rat-var-3.png',
    );
  });

  it('falls back when assetPath is an empty string', () => {
    expect(generatedSpritePreviewUrl({ spriteId: 'x', assetPath: '' }, PAGES_BASE)).toBe(
      '/Crawler/dev/assets/generated/x.png',
    );
  });

  it('normalizes an assetPath with a leading slash (no double slash)', () => {
    expect(
      generatedSpritePreviewUrl({ spriteId: 'x', assetPath: '/generated/x.png' }, PAGES_BASE),
    ).toBe('/Crawler/dev/assets/generated/x.png');
  });

  it('does not double-prefix an already assets-rooted assetPath', () => {
    expect(
      generatedSpritePreviewUrl({ spriteId: 'x', assetPath: 'assets/generated/x.png' }, PAGES_BASE),
    ).toBe('/Crawler/dev/assets/generated/x.png');
    expect(
      generatedSpritePreviewUrl(
        { spriteId: 'x', assetPath: '/assets/generated/x.png' },
        PAGES_BASE,
      ),
    ).toBe('/Crawler/dev/assets/generated/x.png');
  });

  it('never emits a root-absolute /assets URL under a subpath base', () => {
    for (const base of [PAGES_BASE, PROD_BASE]) {
      const url = generatedSpritePreviewUrl({ spriteId: 'x', assetPath: 'generated/x.png' }, base);
      expect(url.startsWith(base)).toBe(true);
      expect(url.startsWith('/assets')).toBe(false);
    }
  });
});

describe('sheetImageUrl', () => {
  it('applies the deploy base to a root-absolute sheet path', () => {
    expect(sheetImageUrl('/assets/kenney/tiny-dungeon/spritesheet.png', PAGES_BASE)).toBe(
      '/Crawler/dev/assets/kenney/tiny-dungeon/spritesheet.png',
    );
  });

  it('keeps the sheet path root-absolute when the base is "/"', () => {
    expect(sheetImageUrl('/assets/generated/custom-pixel-sprites.png', LOCAL_BASE)).toBe(
      '/assets/generated/custom-pixel-sprites.png',
    );
  });

  it('never emits a root-absolute /assets URL under a subpath base', () => {
    const url = sheetImageUrl('/assets/kenney/tiny-town/spritesheet.png', PROD_BASE);
    expect(url).toBe('/Crawler/assets/kenney/tiny-town/spritesheet.png');
    expect(url.startsWith('/assets')).toBe(false);
  });
});
