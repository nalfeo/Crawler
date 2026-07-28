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

/** Absolute path to the shard file for a manifest key. */
export function shardPathForKey(generatedDir: string, manifestKey: string): string {
  const segments = manifestKey.split('/');
  return `${path.join(shardsDir(generatedDir), ...segments)}.json`;
}

/**
 * Recover the manifest key from a shard path relative to the shards dir.
 * `equipment/weapon/bone-saw.json` -> `equipment/weapon/bone-saw`.
 */
export function keyFromShardRelPath(relPath: string): string {
  const posix = relPath.split(path.sep).join('/');
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
  while (dir !== root && dir.startsWith(root)) {
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

/** Serialize an aggregate manifest to the canonical on-disk string. */
export function serializeManifest(manifest: GeneratedManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
