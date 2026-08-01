/**
 * Index builder for the asset-search extension.
 *
 * Reads all non-placeholder shards from `public/assets/generated/entries/`
 * and returns a flat array of documents suitable for MiniSearch indexing.
 *
 * Cannot import TypeScript modules — all shard I/O is reimplemented inline,
 * kept byte-compatible with scripts/sprites/generated-shards.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
const SHARDS_DIR = path.join(GENERATED_DIR, 'entries');
const BASE_GENERATED_TAGS = ['generated', 'pipeline-approved'];

/** One document in the MiniSearch index. */
export function buildCorpus() {
  if (!existsSync(SHARDS_DIR)) return [];
  const keys = listShardKeys();
  const docs = [];
  for (const key of keys) {
    const shardPath = shardPathForKey(key);
    let entry;
    try {
      entry = JSON.parse(readFileSync(shardPath, 'utf8'));
    } catch {
      continue;
    }
    if (isPlaceholder(entry)) continue;
    docs.push(toDocument(key, entry));
  }
  return docs;
}

function shardPathForKey(key) {
  return `${path.join(SHARDS_DIR, ...key.split('/'))}.json`;
}

function listShardKeys() {
  const keys = [];
  const walk = (abs, rel) => {
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(path.join(abs, dirent.name), childRel);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
        keys.push(childRel.replace(/\.json$/iu, ''));
      }
    }
  };
  walk(SHARDS_DIR, '');
  keys.sort((a, b) => a.localeCompare(b));
  return keys;
}

function isPlaceholder(entry) {
  if (entry?.placeholder === true) return true;
  return typeof entry?.assetPath === 'string' && entry.assetPath.includes('-placeholder');
}

function deriveTags(entry) {
  const override = entry?.catalog?.tags;
  if (Array.isArray(override) && override.length > 0) return override;
  return entry?.type ? [entry.type, ...BASE_GENERATED_TAGS] : [...BASE_GENERATED_TAGS];
}

function toDocument(key, entry) {
  return {
    id: `generated:${key}`,
    label: entry.spriteName ?? key,
    tags: deriveTags(entry),
    type: entry.type ?? '',
    description:
      entry.catalog?.description ?? `Generated sprite from brief: ${entry.briefId ?? key}.`,
    assetPath: entry.assetPath ?? '',
    briefId: entry.briefId ?? '',
  };
}
