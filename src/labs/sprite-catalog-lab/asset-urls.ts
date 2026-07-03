import { resolvePublicAssetUrl } from '../../engine/generatedAssets/index.js';

/**
 * Base-aware asset URL helpers for the sprite-catalog lab.
 *
 * Catalog paths are stored root-absolute (`/assets/...`) and generated
 * `assetPath` values are stored relative (`generated/foo.png`). Feeding those
 * straight into `img.src` / `fetch` works in local dev (Vite `base = /`) but
 * 404s on GitHub Pages where the app is served under `/Crawler/dev/`. Resolving
 * every URL through {@link resolvePublicAssetUrl} applies the deployed base so
 * previews render regardless of the deploy environment.
 *
 * `basePath` is only for tests — production callers omit it so the runtime base
 * (`import.meta.env.BASE_URL`) is used.
 */

interface GeneratedSpriteLike {
  readonly assetPath?: string;
  readonly spriteId: string;
}

/**
 * Resolve the preview URL for an individually generated sprite PNG.
 *
 * Normalizes the stored `assetPath` (or the `generated/<spriteId>.png`
 * fallback) to an `assets/`-rooted path before applying the base, so it stays
 * correct whether the manifest stored `generated/x.png`, `/generated/x.png`,
 * `assets/generated/x.png`, or `/assets/generated/x.png`.
 */
export function generatedSpritePreviewUrl(sprite: GeneratedSpriteLike, basePath?: string): string {
  const raw =
    sprite.assetPath && sprite.assetPath.length > 0
      ? sprite.assetPath
      : `generated/${sprite.spriteId}.png`;
  const withoutLeadingSlash = raw.startsWith('/') ? raw.slice(1) : raw;
  const assetRelative = withoutLeadingSlash.startsWith('assets/')
    ? withoutLeadingSlash
    : `assets/${withoutLeadingSlash}`;
  return resolvePublicAssetUrl(assetRelative, basePath);
}

/**
 * Resolve the URL for a sprite-sheet image referenced by a catalog entry's
 * root-absolute `path` (e.g. `/assets/kenney/tiny-dungeon/spritesheet.png`).
 */
export function sheetImageUrl(path: string, basePath?: string): string {
  return resolvePublicAssetUrl(path, basePath);
}
