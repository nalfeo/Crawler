/**
 * Engine-side glue for the generated sprite manifest.
 *
 * Two responsibilities:
 *   1. Fetch + parse `public/assets/generated/manifest.json` at boot.
 *   2. Queue each entry's PNG onto a Phaser loader so the entry's
 *      `textureKey` (== manifest `spriteName`) is loadable in subsequent
 *      scenes.
 *
 * Both helpers are written to be cheap to unit-test: the fetcher and the
 * loader-like object are injected, so tests don't need to spin up a real
 * Phaser scene or a real fetch.
 *
 * Architectural notes
 * -------------------
 * - **Boot-time load.** Phaser scenes typically want all textures queued
 *   up front. The manifest is small today (single-digit entries); when
 *   it grows past ~100 we can switch to lazy per-floor loading. The
 *   decision lives here, not at the call site, so future migrations are
 *   localised.
 * - **Soft-fail on missing manifest.** Boot must succeed even when the
 *   manifest file doesn't exist yet (fresh checkout, brand-new project).
 *   Missing-file => empty registry, no warning spam.
 * - **Soft-fail on malformed manifest.** A parse failure logs once and
 *   yields an empty registry; the engine continues to boot with built-in
 *   Kenney sprites + procedural fallbacks.
 */
import {
  buildGeneratedSpriteRegistry,
  emptyGeneratedSpriteRegistry,
  type GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('engine:generated-assets');

/** Default browser-relative URL for the manifest. */
export const DEFAULT_MANIFEST_URL = '/assets/generated/manifest.json';

/** Minimum subset of `Phaser.Loader.LoaderPlugin` we need at preload. */
export interface LoaderLike {
  image(key: string, url: string): unknown;
}

export interface FetchManifestOptions {
  /** Override the default `'/assets/generated/manifest.json'` URL. */
  readonly url?: string;
  /** Injected fetcher for tests; defaults to global `fetch`. */
  readonly fetcher?: typeof fetch;
  /**
   * Treat a 404 as "no manifest yet" (empty registry, no warning). True
   * by default — fresh checkouts have no approved sprites.
   */
  readonly silentOn404?: boolean;
}

/**
 * Fetch and parse the manifest. Soft-fails on any error: returns an
 * empty registry and logs a warning (or stays silent on 404). Never
 * throws, so callers can safely await it inside `Scene#preload`.
 */
export async function fetchGeneratedSpriteRegistry(
  options: FetchManifestOptions = {},
): Promise<GeneratedSpriteRegistry> {
  const url = options.url ?? DEFAULT_MANIFEST_URL;
  const silentOn404 = options.silentOn404 ?? true;
  const doFetch = options.fetcher ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) {
    logger.warn('No fetch implementation available; skipping generated manifest load', { url });
    return emptyGeneratedSpriteRegistry();
  }

  let response: Response;
  try {
    response = await doFetch(url);
  } catch (err) {
    logger.warn('Failed to fetch generated sprite manifest; using empty registry', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyGeneratedSpriteRegistry();
  }

  if (response.status === 404) {
    if (silentOn404) {
      logger.debug('No generated sprite manifest at boot; using empty registry', { url });
    } else {
      logger.warn('Generated sprite manifest not found; using empty registry', { url });
    }
    return emptyGeneratedSpriteRegistry();
  }

  if (!response.ok) {
    logger.warn('Generated sprite manifest fetch returned non-OK status; using empty registry', {
      url,
      status: response.status,
    });
    return emptyGeneratedSpriteRegistry();
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    logger.warn('Generated sprite manifest is not parseable JSON; using empty registry', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyGeneratedSpriteRegistry();
  }

  try {
    const registry = buildGeneratedSpriteRegistry(raw);
    logger.info('Loaded generated sprite manifest', { url, count: registry.size });
    return registry;
  } catch (err) {
    logger.warn('Generated sprite manifest failed schema validation; using empty registry', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyGeneratedSpriteRegistry();
  }
}

export interface PreloadOptions {
  /**
   * Base URL to resolve `assetPath` against. Defaults to `/assets/` so
   * `assetPath: "generated/iron-sword.png"` becomes
   * `"/assets/generated/iron-sword.png"`. Tests can override.
   */
  readonly assetsBaseUrl?: string;
}

/**
 * Queue each generated sprite entry as a Phaser image load. Returns the
 * list of `{textureKey, url}` pairs that were queued so callers (and
 * tests) can introspect. Skips entries whose `textureKey` would collide
 * with one already queued earlier in the same call.
 */
export function preloadGeneratedSprites(
  loader: LoaderLike,
  registry: GeneratedSpriteRegistry,
  options: PreloadOptions = {},
): ReadonlyArray<{ textureKey: string; url: string }> {
  const base = normalizeBase(options.assetsBaseUrl ?? '/assets/');
  const queued: { textureKey: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const entry of registry.entries()) {
    if (seen.has(entry.textureKey)) {
      logger.warn('Duplicate generated sprite texture key; skipping later entry', {
        textureKey: entry.textureKey,
        briefId: entry.briefId,
      });
      continue;
    }
    const url = `${base}${stripLeadingSlash(entry.assetPath)}`;
    loader.image(entry.textureKey, url);
    queued.push({ textureKey: entry.textureKey, url });
    seen.add(entry.textureKey);
  }
  if (queued.length > 0) {
    logger.info('Queued generated sprite loads', { count: queued.length });
  }
  return queued;
}

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
