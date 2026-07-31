/**
 * Engine-side glue for the generated sprite manifest.
 *
 * Two responsibilities:
 *   1. Fetch + parse `public/assets/generated/manifest.json` at boot.
 *   2. Queue each entry's PNG onto a Phaser loader so the entry's
 *      `textureKey` (unique per variant — the manifest entry key) is loadable
 *      in subsequent scenes. Every approved variant of a brief is queued.
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
  emptyGeneratedSpriteRegistry,
  GENERATED_MANIFEST_VERSION,
  loadGeneratedManifest,
  parseGeneratedManifest,
  type GeneratedSpriteEntry,
  type GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';
import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from '../../shared/data/floor2-basic-leather-bases.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../shared/data/floor2-equipment-art.js';
import { isPlaceholderEntry } from '../../shared/item-sprites.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('engine:generated-assets');
type ImportMetaWithEnv = ImportMeta & { env?: { BASE_URL?: string } };
const ENV_BASE_PATH = (import.meta as ImportMetaWithEnv).env?.BASE_URL;
const BROWSER_BASE_PATH =
  typeof document === 'undefined' ? undefined : new URL('.', document.baseURI).pathname;

/**
 * Resolve a public asset path against the app base path so GitHub Pages builds
 * under `/Crawler/` fetch generated sprite assets from the deployed subpath.
 */
export function resolvePublicAssetUrl(path: string, basePath?: string): string {
  const base = normalizeBase(basePath ?? ENV_BASE_PATH ?? BROWSER_BASE_PATH ?? '/');
  return `${base}${stripLeadingSlash(path)}`;
}

/** Default browser-relative URL for the manifest. */
export const DEFAULT_MANIFEST_URL = resolvePublicAssetUrl('assets/generated/manifest.json');
const DEFAULT_ASSETS_BASE_URL = resolvePublicAssetUrl('assets');

/** Minimum subset of `Phaser.Loader.LoaderPlugin` we need at preload. */
export interface LoaderLike {
  image(key: string, url: string): unknown;
  /**
   * Optional — only required for entries carrying an `animation` descriptor
   * (multi-frame spritesheets). Kept optional/guarded (like other Phaser
   * methods in this codebase) so fake loaders in tests that only implement
   * `image()` keep working unchanged.
   */
  spritesheet?(
    key: string,
    url: string,
    frameConfig: { frameWidth: number; frameHeight: number },
  ): unknown;
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
    const manifest = parseGeneratedManifest(raw);
    const registry = loadGeneratedManifest(manifest);
    logger.info('Loaded generated sprite manifest', {
      url,
      count: registry.size,
      version: GENERATED_MANIFEST_VERSION,
    });
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
   * Base URL to resolve `assetPath` against. Defaults to the app-base-aware
   * `/assets/` URL so
   * `assetPath: "generated/iron-sword.png"` becomes
   * `"/assets/generated/iron-sword.png"`. Tests can override.
   */
  readonly assetsBaseUrl?: string;
}

const BASIC_LEATHER_STABLE_ID_SET = new Set<string>(FLOOR2_BASIC_LEATHER_STABLE_IDS);

function conceptVersion(briefId: string, concept: string): number | null {
  if (briefId === concept) return 0;
  const prefix = `${concept}-v`;
  if (!briefId.startsWith(prefix)) return null;
  const digits = briefId.slice(prefix.length);
  if (digits.length === 0 || !/^\d+$/.test(digits)) return null;
  return Number(digits);
}

function resolveBasicLeatherAliasEntry(
  registry: GeneratedSpriteRegistry,
  stableId: string,
): GeneratedSpriteEntry | null {
  const slug = stableId.slice(stableId.indexOf('.') + 1);
  const concept = `classic-fantasy-basic-leather-${slug}`;
  return (
    registry
      .entries()
      .filter(
        (entry) => conceptVersion(entry.briefId, concept) !== null && !isPlaceholderEntry(entry),
      )
      .sort((a, b) => {
        const versionDiff =
          conceptVersion(a.briefId, concept)! - conceptVersion(b.briefId, concept)!;
        if (versionDiff !== 0) return versionDiff;
        if (a.variantIndex !== b.variantIndex) return a.variantIndex - b.variantIndex;
        return a.textureKey.localeCompare(b.textureKey);
      })[0] ?? null
  );
}

/**
 * Queue each generated sprite entry as a Phaser image (or spritesheet, for
 * entries carrying an `animation` descriptor) load. Returns the list of
 * queued entries — including which load path each took (`kind`) — so
 * callers (and tests) can introspect. Skips entries whose `textureKey`
 * would collide with one already queued earlier in the same call.
 */
export function preloadGeneratedSprites(
  loader: LoaderLike,
  registry: GeneratedSpriteRegistry,
  options: PreloadOptions = {},
): ReadonlyArray<{ textureKey: string; url: string; kind: 'image' | 'spritesheet' }> {
  const base = normalizeBase(options.assetsBaseUrl ?? DEFAULT_ASSETS_BASE_URL);
  const queued: { textureKey: string; url: string; kind: 'image' | 'spritesheet' }[] = [];
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
    if (entry.animation !== undefined && typeof loader.spritesheet === 'function') {
      loader.spritesheet(entry.textureKey, url, {
        frameWidth: entry.animation.frameWidth,
        frameHeight: entry.animation.frameHeight,
      });
      queued.push({ textureKey: entry.textureKey, url, kind: 'spritesheet' });
    } else {
      loader.image(entry.textureKey, url);
      queued.push({ textureKey: entry.textureKey, url, kind: 'image' });
    }
    seen.add(entry.textureKey);
  }
  for (const definition of FLOOR2_EQUIPMENT_ART_DEFINITIONS) {
    if (!BASIC_LEATHER_STABLE_ID_SET.has(definition.stableId)) continue;
    const entry = resolveBasicLeatherAliasEntry(registry, definition.stableId);
    if (entry === null || seen.has(definition.runtimeKey)) continue;
    const url = `${base}${stripLeadingSlash(entry.assetPath)}`;
    loader.image(definition.runtimeKey, url);
    queued.push({ textureKey: definition.runtimeKey, url, kind: 'image' });
    seen.add(definition.runtimeKey);
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
