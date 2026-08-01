/**
 * Index builder for the asset-search extension.
 *
 * Reads all non-placeholder shards from `public/assets/generated/entries/`
 * AND all brief YAML files from `briefs/`. Returns a flat array of documents
 * suitable for MiniSearch indexing.
 *
 * Documents have a `status` field:
 *   "approved"   — an approved generated sprite with a real asset path
 *   "brief-only" — a brief that has no approved variants yet
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

/** Max description chars stored in the index per brief (briefs can be very long). */
const MAX_BRIEF_DESC_CHARS = 800;

/**
 * Build the full corpus: approved shards + brief-only briefs (those with no
 * approved variant yet).
 */
export function buildCorpus() {
  const shardDocs = buildShardCorpus();
  // Build set of brief IDs that are already covered by at least one approved shard.
  const approvedBriefIds = new Set(shardDocs.map((d) => d.briefId).filter(Boolean));
  const briefDocs = buildBriefCorpus(approvedBriefIds);
  return [...shardDocs, ...briefDocs];
}

// ---------------------------------------------------------------------------
// Shard corpus
// ---------------------------------------------------------------------------

function buildShardCorpus() {
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
    docs.push(toShardDocument(key, entry));
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

function toShardDocument(key, entry) {
  return {
    id: `generated:${key}`,
    label: entry.spriteName ?? key,
    tags: deriveTags(entry),
    type: entry.type ?? '',
    description:
      entry.catalog?.description ?? `Generated sprite from brief: ${entry.briefId ?? key}.`,
    assetPath: entry.assetPath ?? '',
    briefId: entry.briefId ?? '',
    status: 'approved',
  };
}

// ---------------------------------------------------------------------------
// Brief corpus
// ---------------------------------------------------------------------------

function buildBriefCorpus(approvedBriefIds) {
  if (!existsSync(BRIEFS_DIR)) return [];
  const files = listBriefFiles();
  const docs = [];
  for (const filePath of files) {
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

    // Skip briefs already covered by an approved shard variant.
    if (approvedBriefIds.has(name)) continue;

    const type = typeof parsed.type === 'string' ? parsed.type.trim() : '';
    // `description` may be a multi-line string; `prompt` is the same or an
    // expanded form. Use whichever is available, capped for index size.
    const rawDesc =
      typeof parsed.description === 'string'
        ? parsed.description
        : typeof parsed.prompt === 'string'
          ? parsed.prompt
          : '';
    const description = rawDesc.slice(0, MAX_BRIEF_DESC_CHARS);

    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string') : [];
    const effectiveTags = tags.length > 0 ? tags : [type, 'brief'].filter(Boolean);

    docs.push({
      id: `brief:${name}`,
      label: name,
      tags: effectiveTags,
      type,
      description,
      assetPath: '',
      briefId: name,
      status: 'brief-only',
    });
  }
  return docs;
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
