/**
 * The shipped generated-sprite registry, loaded for Node headless / sweep runs.
 *
 * The real game always installs a registry (`MainGameScene` hands the preloaded
 * one to `createGameWorld`) and it is **simulation-visible**: `enemyTelegraph`
 * resolves per-entity weapon anchors through `world.generatedSpriteRegistry`.
 * `runHeadless` defaulting it to `null` therefore simulated projectile origins
 * the real game never uses; an omitted config now loads the same shipped art.
 *
 * The committed source of truth is the per-asset shard tree. The aggregate
 * `manifest.json` the browser fetches is a gitignored build artifact
 * (`tools/vite-plugin-generated-manifest.ts`) — absent on a fresh checkout and
 * stale otherwise — so it is never read here.
 *
 * Two constraints shape the implementation:
 *  - `src/game/ai/index.ts` re-exports `runHeadless`, so this module reaches the
 *    browser graph. It must not statically import a Node builtin, nor import
 *    `scripts/sprites/**` (which does) — hence the guarded dynamic `node:fs`.
 *  - Headless/perf CLIs run from an esbuild bundle emitted into `files/`
 *    (`scripts/agent/perf/prebundle-cli.mjs`), so `import.meta.url` points at
 *    the bundle, not at this source file. The shard tree is resolved from
 *    `process.cwd()`, which those launchers pin to the repo root.
 */
import {
  GENERATED_MANIFEST_VERSION,
  buildGeneratedSpriteRegistry,
  type GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';

/** Repo-root-relative shard tree. Node accepts `/` separators on every OS. */
const SHIPPED_ENTRIES_REPO_PATH = 'public/assets/generated/entries';

interface ShardDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeFileSystem {
  existsSync(target: string): boolean;
  readdirSync(target: string, options: { withFileTypes: true }): ShardDirent[];
  readFileSync(target: string, encoding: 'utf8'): string;
}

/** Non-literal so bundlers cannot pull `node:fs` into the browser graph. */
const NODE_FS_SPECIFIER = 'node:fs';

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

function shippedEntriesDir(): string {
  const root = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}/${SHIPPED_ENTRIES_REPO_PATH}`;
}

function collectShards(
  fs: NodeFileSystem,
  dir: string,
  prefix: string,
  out: Map<string, string>,
): void {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      collectShards(fs, `${dir}/${dirent.name}`, key, out);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
      out.set(key.replace(/\.json$/i, ''), `${dir}/${dirent.name}`);
    }
  }
}

function readShippedManifestEntries(fs: NodeFileSystem, dir: string): Record<string, unknown> {
  const shardPaths = new Map<string, string>();
  collectShards(fs, dir, '', shardPaths);
  if (shardPaths.size === 0) {
    throw new Error(
      `Shipped generated-sprite shards are empty at ${dir}. Headless runs must simulate ` +
        'the same art the real game installs; refusing to use an empty registry.',
    );
  }
  // Same key order `composeManifest` produces, so the flattened registry order
  // matches the aggregate manifest the browser builds from these shards.
  const entries: Record<string, unknown> = {};
  for (const key of [...shardPaths.keys()].sort((a, b) => a.localeCompare(b))) {
    const file = shardPaths.get(key)!;
    try {
      entries[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (cause) {
      throw new Error(`Malformed shipped generated-sprite shard "${file}".`, { cause });
    }
  }
  return entries;
}

async function importNodeFs(): Promise<NodeFileSystem> {
  const loaded = await import(/* @vite-ignore */ NODE_FS_SPECIFIER);
  return loaded as NodeFileSystem;
}

async function loadUncached(): Promise<GeneratedSpriteRegistry | null> {
  // Browser/lab: the Phaser preloader owns registry installation and there is
  // no filesystem, so callers keep the null-registry fallback.
  if (!isNodeRuntime()) return null;

  const fs = await importNodeFs();
  const dir = shippedEntriesDir();
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Shipped generated-sprite shards not found at ${dir}. Run headless/sweep entry ` +
        'points from the repo root; refusing to use an empty registry.',
    );
  }
  // Throws (ZodError) on a schema-invalid shard — loud by design.
  return buildGeneratedSpriteRegistry({
    version: GENERATED_MANIFEST_VERSION,
    entries: readShippedManifestEntries(fs, dir),
  });
}

let cached: Promise<GeneratedSpriteRegistry | null> | undefined;

/**
 * Load (once) the registry built from the committed shard tree. Cached because
 * a sweep calls `runHeadless` hundreds of times over ~600 shard files; the
 * registry is immutable and pure-derived, so sharing it cannot leak run state.
 *
 * Returns `null` only outside Node. Inside Node it returns a non-empty registry
 * or throws.
 */
export function loadShippedGeneratedSpriteRegistry(): Promise<GeneratedSpriteRegistry | null> {
  cached ??= loadUncached().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
