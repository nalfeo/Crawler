/**
 * asset-search extension — natural-language sprite asset search.
 *
 * Registers the `search_assets` tool that accepts a plain-English query and
 * returns matching sprite assets from the generated manifest. Uses MiniSearch
 * for BM25-weighted full-text search over tags, labels, descriptions, and types.
 *
 * Also writes per-query telemetry to `files/asset-search-telemetry.jsonl` so
 * empty-result queries can be turned into new asset briefs.
 *
 * Tool: search_assets
 *   Input:  { query: string, type?: string, maxResults?: number }
 *   Output: array of { id, label, description, tags, type, assetPath, status, score }
 */

import { existsSync, appendFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession } from '@github/copilot-sdk/extension';
import { buildCorpus } from './lib/index-builder.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
const SHARDS_DIR = path.join(GENERATED_DIR, 'entries');
const BRIEFS_DIR = path.join(REPO_ROOT, 'briefs');
const FILES_DIR = path.join(REPO_ROOT, 'files');
const TELEMETRY_PATH = path.join(FILES_DIR, 'asset-search-telemetry.jsonl');

/** Minimum score for a result to count as "found". */
const MIN_SCORE_THRESHOLD = 1.0;
const DEFAULT_MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// Index (rebuilt lazily when shards change)
// ---------------------------------------------------------------------------

let indexState = {
  fingerprint: '',
  /** @type {import('minisearch').default | null} */
  ms: null,
};

function shardsFingerprint() {
  let count = 0;
  let maxMtime = -1;

  const walkDir = (abs) => {
    if (!existsSync(abs)) return;
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, dirent.name);
      if (dirent.isDirectory()) {
        walkDir(child);
      } else if (dirent.isFile()) {
        count++;
        const m = statSync(child).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      }
    }
  };

  // Include both approved shards and brief files in the fingerprint so the
  // index is rebuilt whenever either changes.
  walkDir(SHARDS_DIR);
  walkDir(BRIEFS_DIR);

  return `${count}:${maxMtime}`;
}

async function getIndex() {
  const fp = shardsFingerprint();
  if (indexState.ms && indexState.fingerprint === fp) return indexState.ms;

  // Dynamic import so MiniSearch is loaded on first use.
  const { default: MiniSearch } = await import('minisearch');

  const ms = new MiniSearch({
    idField: 'id',
    fields: ['tags', 'label', 'description', 'type'],
    storeFields: ['id', 'label', 'tags', 'type', 'description', 'assetPath', 'status'],
    extractField: (doc, field) =>
      field === 'tags' ? doc.tags.join(' ') : String(doc[field] ?? ''),
    searchOptions: {
      boost: { tags: 3, label: 2, type: 1.5, description: 1 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'OR',
    },
  });

  const corpus = buildCorpus();
  ms.addAll(corpus);

  indexState = { fingerprint: fp, ms };
  return ms;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

function writeTelemetry(record) {
  try {
    mkdirSync(FILES_DIR, { recursive: true });
    appendFileSync(TELEMETRY_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Telemetry must never crash the tool
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleSearchAssets(params) {
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  if (!query) return { error: 'query is required' };

  const typeFilter =
    typeof params?.type === 'string' && params.type.trim().length > 0
      ? params.type.trim().toLowerCase()
      : null;
  const maxResults =
    typeof params?.maxResults === 'number' && params.maxResults > 0
      ? Math.min(params.maxResults, 200)
      : DEFAULT_MAX_RESULTS;

  const ms = await getIndex();
  let rawResults = ms.search(query);

  if (typeFilter) {
    rawResults = rawResults.filter((r) => String(r.type ?? '').toLowerCase() === typeFilter);
  }

  const topResults = rawResults.slice(0, maxResults).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    tags: r.tags,
    type: r.type,
    assetPath: r.assetPath,
    status: r.status,
    score: Math.round(r.score * 100) / 100,
  }));

  const found = topResults.length > 0 && (topResults[0]?.score ?? 0) >= MIN_SCORE_THRESHOLD;

  writeTelemetry({
    ts: new Date().toISOString(),
    query,
    type: typeFilter ?? undefined,
    resultCount: topResults.length,
    topScore: topResults[0]?.score ?? 0,
    found,
    topIds: topResults.slice(0, 3).map((r) => r.id),
  });

  return topResults;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function start() {
  const session = await joinSession();

  session.registerTool('search_assets', {
    description:
      'Search for sprite assets by natural language query. Returns matching sprites ranked by relevance. ' +
      'Results include both approved generated assets (status: "approved", with assetPath) and ' +
      'briefs that have been specified but not yet generated (status: "brief-only", no assetPath). ' +
      'Useful for finding props, mobs, tiles, and other game assets by describing what you need ' +
      '(e.g. "rusty workshop tools", "ornate altar stone"). ' +
      'Empty result queries are logged and drive new asset brief creation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural language description of the asset (e.g. "rusty iron anvil", "glowing crystal", "wooden crate").',
        },
        type: {
          type: 'string',
          description:
            'Optional SpriteType filter: prop, mob, weapon, tile, npc, icon, equipment, player, projectile, vfx. Applied after search.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results to return. Default 20, max 200.',
        },
      },
      required: ['query'],
    },
    handler: handleSearchAssets,
  });

  session.log('[asset-search] extension started');
}
