/**
 * Node-side shard I/O for the generated sprite manifest.
 *
 * The manifest source of truth is a directory of per-asset shards:
 *
 *     public/assets/generated/entries/<manifestKey>.json
 *
 * one self-contained `ManifestEntry` per file. Keys that contain `/`
 * (stable runtime keys like `equipment/weapon/bone-saw`) map to nested
 * subdirectories, so the POSIX path under `entries/` (minus `.json`) is
 * exactly the manifest key.
 *
 * The aggregate `public/assets/generated/manifest.json` is NOT committed — it
 * is a build artifact composed from these shards (see the Vite plugin and
 * `build-manifest.ts`). Sharding is what lets two check-ins touching
 * different assets never touch the same file.
 *
 * This module is Node-only (`fs`); the pure derivation lives in
 * `src/shared/generated-catalog.ts`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  GENERATED_MANIFEST_VERSION,
  type GeneratedManifest,
  type ManifestEntry,
} from '../../src/shared/generated-assets.js';

/** Subdirectory (under the generated dir) that holds per-asset shards. */
export const SHARDS_SUBDIR = 'entries';

/** Absolute path to the shards directory for a given generated dir. */
export function shardsDir(generatedDir: string): string {
  return path.join(generatedDir, SHARDS_SUBDIR);
}

/**
 * Validate a manifest key is safe to map onto the filesystem. Keys become
 * paths under `entries/`, so a key with `..`, an absolute segment, a backslash,
 * or an empty segment could escape the shards dir or collide cross-platform.
 * Every shard reader/writer routes through `shardPathForKey`, so validating
 * here is the single trust boundary.
 */
export function assertSafeManifestKey(manifestKey: string): void {
  if (manifestKey.length === 0) {
    throw new Error('manifest key must not be empty');
  }
  if (manifestKey.includes('\\')) {
    throw new Error(`manifest key must use POSIX '/' separators, not '\\': "${manifestKey}"`);
  }
  if (path.posix.isAbsolute(manifestKey) || /^[A-Za-z]:/.test(manifestKey)) {
    throw new Error(`manifest key must be relative: "${manifestKey}"`);
  }
  for (const segment of manifestKey.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`manifest key has an unsafe path segment: "${manifestKey}"`);
    }
  }
}

/** Absolute path to the shard file for a manifest key. */
export function shardPathForKey(generatedDir: string, manifestKey: string): string {
  assertSafeManifestKey(manifestKey);
  const segments = manifestKey.split('/');
  return `${path.join(shardsDir(generatedDir), ...segments)}.json`;
}

/**
 * Recover the manifest key from a shard path relative to the shards dir.
 * `equipment/weapon/bone-saw.json` -> `equipment/weapon/bone-saw`.
 */
export function keyFromShardRelPath(relPath: string): string {
  const posix = relPath.replace(/\\/g, '/');
  return posix.replace(/\.json$/i, '');
}

/** List every shard file path (relative to the shards dir, POSIX-separated). */
export function listShardRelPaths(generatedDir: string): string[] {
  const dir = shardsDir(generatedDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(path.join(abs, dirent.name), childRel);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Read every shard into a `{ key: entry }` map. */
export function readAllShards(generatedDir: string): Record<string, ManifestEntry> {
  const dir = shardsDir(generatedDir);
  const entries: Record<string, ManifestEntry> = {};
  for (const rel of listShardRelPaths(generatedDir)) {
    const key = keyFromShardRelPath(rel);
    const raw = readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
    entries[key] = JSON.parse(raw) as ManifestEntry;
  }
  return entries;
}

/** Read one shard, or `undefined` when it does not exist. */
export function readShard(generatedDir: string, manifestKey: string): ManifestEntry | undefined {
  const file = shardPathForKey(generatedDir, manifestKey);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as ManifestEntry;
}

/**
 * Write one shard (pretty JSON + trailing newline). Callers that need
 * Prettier-identical formatting should pass the returned path to
 * `formatJsonFiles`/`formatJsonFilesSync`.
 */
export function writeShard(
  generatedDir: string,
  manifestKey: string,
  entry: ManifestEntry,
): string {
  const file = shardPathForKey(generatedDir, manifestKey);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return file;
}

/** Delete one shard (and prune now-empty parent dirs up to the shards root). */
export function deleteShard(generatedDir: string, manifestKey: string): boolean {
  const file = shardPathForKey(generatedDir, manifestKey);
  if (!existsSync(file)) return false;
  rmSync(file);
  // Prune empty ancestor directories, stopping at the shards root.
  const root = shardsDir(generatedDir);
  let dir = path.dirname(file);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    if (readdirSync(dir).length > 0) break;
    rmSync(dir, { recursive: true });
    dir = path.dirname(dir);
  }
  return true;
}

/** Compose a sorted aggregate manifest object from a `{ key: entry }` map. */
export function composeManifest(entries: Record<string, ManifestEntry>): GeneratedManifest {
  const sortedKeys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  const sorted: Record<string, ManifestEntry> = {};
  for (const key of sortedKeys) {
    sorted[key] = entries[key]!;
  }
  return { version: GENERATED_MANIFEST_VERSION, entries: sorted } as GeneratedManifest;
}

/** Compose the aggregate manifest object directly from on-disk shards. */
export function composeManifestFromShards(generatedDir: string): GeneratedManifest {
  return composeManifest(readAllShards(generatedDir));
}

/**
 * Load the aggregate manifest for a standalone Node consumer, tolerant of a
 * fresh checkout where the aggregate `manifest.json` is absent (it is a
 * gitignored build artifact). The shards are the source of truth, so this
 * ALWAYS composes from them when the shards dir exists — avoiding both the
 * "aggregate missing" and the "stale aggregate on disk" failure modes. It falls
 * back to reading a committed `manifest.json` only in a legacy tree with no
 * shards, and returns an empty manifest when neither exists.
 *
 * `generatedDir` is the directory that contains `entries/` and (optionally)
 * `manifest.json` — i.e. `public/assets/generated`.
 */
export function loadGeneratedManifest(generatedDir: string): GeneratedManifest {
  if (existsSync(shardsDir(generatedDir))) {
    return composeManifestFromShards(generatedDir);
  }
  const aggregate = path.join(generatedDir, 'manifest.json');
  if (existsSync(aggregate)) {
    return JSON.parse(readFileSync(aggregate, 'utf8')) as GeneratedManifest;
  }
  return { version: GENERATED_MANIFEST_VERSION, entries: {} } as GeneratedManifest;
}

/** Serialize an aggregate manifest to the canonical on-disk string. */
export function serializeManifest(manifest: GeneratedManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
