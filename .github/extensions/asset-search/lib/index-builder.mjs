/**
 * Index builder for the asset-search extension.
 *
 * Reads all non-placeholder shards from `public/assets/generated/entries/`
 * and enriches each document with text from the corresponding brief in
 * `briefs/` (looked up by `entry.briefId`). Brief text is included as a
 * lower-weight `briefText` field so tags remain the authoritative signal.
 *
 * Cannot import TypeScript modules — all I/O is reimplemented inline.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
const SHARDS_DIR = path.join(GENERATED_DIR, 'entries');
const BRIEFS_DIR = path.join(REPO_ROOT, 'briefs');
const BASE_GENERATED_TAGS = ['generated', 'pipeline-approved'];

/** Max chars of brief description to store per shard (briefs can be very long). */
const MAX_BRIEF_TEXT_CHARS = 800;

/**
 * Build the full corpus: approved shards, each enriched with its brief text.
 */
export function buildCorpus() {
  const briefMap = buildBriefMap();
  return buildShardCorpus(briefMap);
}

// ---------------------------------------------------------------------------
// Shard corpus
// ---------------------------------------------------------------------------

function buildShardCorpus(briefMap) {
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
    docs.push(toShardDocument(key, entry, briefMap));
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
  // Mirror src/shared/generated-catalog.ts:isPlaceholderManifestEntry exactly.
  // An explicit boolean `placeholder` field is authoritative — `false` forces
  // "not a placeholder" even when the asset path looks placeholder-like.
  if (typeof entry?.placeholder === 'boolean') return entry.placeholder;
  return typeof entry?.assetPath === 'string' && entry.assetPath.includes('-placeholder');
}

function deriveTags(entry) {
  const override = entry?.catalog?.tags;
  if (Array.isArray(override) && override.length > 0) return override;
  return entry?.type ? [entry.type, ...BASE_GENERATED_TAGS] : [...BASE_GENERATED_TAGS];
}

function toShardDocument(key, entry, briefMap) {
  const briefId = entry.briefId ?? '';
  // Brief text enriches search signal for the asset without replacing tags.
  const briefText = briefId ? resolveBriefText(briefMap.get(briefId), key, entry) : '';
  return {
    id: `generated:${key}`,
    // Use the shard key as the canonical label — spriteName is not trusted because
    // legacy shards can share a brief-wide spriteName across multiple variants.
    // (mirrors src/shared/generated-catalog.ts:97-100)
    label: key,
    tags: deriveTags(entry),
    type: entry.type ?? '',
    description: entry.catalog?.description ?? `Generated sprite from brief: ${briefId || key}.`,
    briefText,
    assetPath: entry.assetPath ?? '',
    briefId,
  };
}

function resolveBriefText(brief, key, entry) {
  if (!brief) return '';
  const candidates = [entry?.spriteName, key, key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .map((v) => v.trim());
  for (const candidate of candidates) {
    const itemText = brief.itemTextById.get(candidate);
    if (itemText) return itemText;
  }
  return brief.topLevelText;
}

// ---------------------------------------------------------------------------
// Brief map (id → description text, for shard enrichment)
// ---------------------------------------------------------------------------

/**
 * Build a map from brief name → capped description text.
 * Used to enrich shard documents without indexing un-generated briefs.
 */
function buildBriefMap() {
  if (!existsSync(BRIEFS_DIR)) return new Map();
  const map = new Map();
  for (const filePath of listBriefFiles()) {
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : null;
    if (!name) continue;
    // `description` is the human-readable intent; fall back to `prompt` for
    // minimal briefs that only define a `prompt` key.
    const rawText =
      typeof parsed.description === 'string'
        ? parsed.description
        : typeof parsed.prompt === 'string'
          ? parsed.prompt
          : '';
    const itemTextById = new Map();
    if (Array.isArray(parsed.iconBatch)) {
      for (const icon of parsed.iconBatch) {
        if (!icon || typeof icon !== 'object' || Array.isArray(icon)) continue;
        const id = typeof icon.id === 'string' ? icon.id.trim() : '';
        if (!id) continue;
        const itemRawText =
          typeof icon.description === 'string'
            ? icon.description
            : typeof icon.prompt === 'string'
              ? icon.prompt
              : '';
        if (!itemRawText) continue;
        itemTextById.set(id, itemRawText.slice(0, MAX_BRIEF_TEXT_CHARS));
      }
    }
    const topLevelText = rawText ? rawText.slice(0, MAX_BRIEF_TEXT_CHARS) : '';
    if (topLevelText || itemTextById.size > 0) {
      map.set(name, { topLevelText, itemTextById });
    }
  }
  return map;
}

function listBriefFiles() {
  const files = [];
  const walk = (abs) => {
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, dirent.name);
      if (dirent.isDirectory()) {
        walk(child);
      } else if (dirent.isFile() && /\.(yaml|yml)$/i.test(dirent.name)) {
        files.push(child);
      }
    }
  };
  walk(BRIEFS_DIR);
  return files;
}
