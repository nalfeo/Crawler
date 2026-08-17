import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { startCanvasServer } from './lib/canvas-harness.mjs';
import { readSnapshot, resolveSnapshotPath, writeSnapshot } from './lib/manifest-snapshot.mjs';
import { renderHtml } from './renderer.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
// The aggregate `manifest.json` is a build artifact and is NOT committed. The
// source of truth is a directory of per-asset shards; this `.mjs` cannot import
// the TypeScript shard helpers (scripts/sprites/generated-shards.ts) or the
// derivation composer (src/shared/generated-catalog.ts), so the small subset it
// needs is reimplemented inline below and MUST stay byte-compatible with them.
const SHARDS_DIR = path.join(GENERATED_DIR, 'entries');
const CATALOG_PATH = path.join(REPO_ROOT, 'src', 'shared', 'data', 'sprite-catalog.json');
const GENERATED_MANIFEST_VERSION = 1;
const GENERATED_ID_PREFIX = 'generated:';
const GENERATED_SHEET_KEY = 'generated-manifest';
const BASE_GENERATED_TAGS = ['generated', 'pipeline-approved'];
const ANNOTATIONS_PATH = path.join(
  REPO_ROOT,
  'public',
  'assets',
  'generated',
  'sprite-editor-annotations.json',
);
const ASSETS_ROOT = path.join(REPO_ROOT, 'public', 'assets');
// Durable queue-commit: `.mjs` cannot import TypeScript, so edits are persisted
// to the remote assets/queue branch by spawning the tsx CLI (the same
// `node <tsx-cli> <file.ts>` shape the sidecar launcher uses).
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const QUEUE_COMMIT_CLI = path.join(REPO_ROOT, 'scripts', 'sprites', 'queue-commit-cli.ts');
/**
 * Catastrophic wall-clock backstop for the queue-commit CLI spawn. The CLI's own
 * git subprocesses are already forced non-interactive with per-call deadlines, so
 * this only fires if the whole tsx process wedges — it must never leave the
 * editor save hanging indefinitely.
 */
const QUEUE_COMMIT_TIMEOUT_MS = 5 * 60_000;
const MAX_WRITE_BYTES = 6 * 1024 * 1024;
const MAX_RESULTS = 500;
const OPENCV_VENDOR_BASE = 'https://docs.opencv.org/4.13.0';
// The pinned 4.13.0 distribution embeds its WASM payload in opencv.js.
const OPENCV_VENDOR_HASHES = new Map([
  ['opencv.js', '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0'],
]);
const openCvVendorCache = new Map();

let sessionRef = null;
const instances = new Map();
const pendingStartups = new Map();

/** Durable, cross-process snapshot of the composed manifest for THIS worktree. */
const SNAPSHOT_PATH = resolveSnapshotPath(REPO_ROOT);
/**
 * How long a computed shard fingerprint is trusted before the 642-file walk is
 * repeated. The walk costs ~50 ms and previously ran on EVERY request — including
 * every `/img/sprite` byte fetch — so a single sprite switch paid it twice.
 *
 * This is a freshness/latency trade, and it is safe in both directions:
 *   - Our own writes (save/revert/reload) bust the cache EXPLICITLY, so an edit
 *     made through the editor is never served stale regardless of this window.
 *   - Only an EXTERNAL edit (git checkout, another worktree's pipeline) can be
 *     briefly missed, and only for this window.
 */
const FINGERPRINT_TTL_MS = 2_000;
let lastFingerprint = '';
let lastFingerprintAtMs = -Infinity;

let cache = {
  manifestFingerprint: '',
  catalogMtimeMs: -1,
  annotationsMtimeMs: -1,
  manifest: null,
  catalog: null,
  annotations: null,
  summaries: [],
  summaryByKey: new Map(),
  allTags: [],
};

function log(message, level = 'info') {
  try {
    sessionRef?.log?.(`[sprite-editor] ${message}`, { level });
  } catch {
    // logging must never crash the extension
  }
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Inline per-asset shard I/O + generated-catalog derivation.
//
// These mirror scripts/sprites/generated-shards.ts and
// src/shared/generated-catalog.ts. A `.mjs` extension cannot import those TS
// modules, so the minimal subset is duplicated here. Keep them in sync:
//   - shard path: entries/<key>.json, with `/` in the key mapping to subdirs
//   - serialization: JSON.stringify(entry, null, 2) + trailing newline
//   - manifest: { version: 1, entries: { <key>: entry } }, keys sorted
//   - derivation rules (id/label/spriteId from map key; tags = type-first;
//     placeholder excluded) match the composer exactly.
// ---------------------------------------------------------------------------

function shardPathForKey(key) {
  return `${path.join(SHARDS_DIR, ...key.split('/'))}.json`;
}

function listShardKeys() {
  if (!existsSync(SHARDS_DIR)) return [];
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

function composeManifestFromShards() {
  const entries = {};
  for (const key of listShardKeys()) {
    entries[key] = readJsonFile(shardPathForKey(key));
  }
  return { version: GENERATED_MANIFEST_VERSION, entries };
}

function writeShard(key, entry) {
  const file = shardPathForKey(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonFile(file, entry);
}

// Cheap change-detector for the shard set: file count + newest mtime. Catches
// add/remove (count changes) and content edits (mtime bumps). Our own writes
// bust the cache explicitly, so external edits are the only case this guards.
function shardsFingerprint() {
  if (!existsSync(SHARDS_DIR)) return '0:-1';
  let count = 0;
  let maxMtime = -1;
  const walk = (abs) => {
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, dirent.name);
      if (dirent.isDirectory()) {
        walk(child);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
        count += 1;
        const m = statSync(child).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      }
    }
  };
  walk(SHARDS_DIR);
  return `${count}:${maxMtime}`;
}

function isPlaceholderManifestEntry(entry) {
  if (entry?.placeholder === true) return true;
  return typeof entry?.assetPath === 'string' && entry.assetPath.includes('-placeholder');
}

function deriveGeneratedTags(entry) {
  const override = entry?.catalog?.tags;
  if (Array.isArray(override) && override.length > 0) return [...override];
  return entry?.type ? [entry.type, ...BASE_GENERATED_TAGS] : [...BASE_GENERATED_TAGS];
}

// Derive the read-time `generated:` catalog rows from the composed manifest.
// The committed catalog no longer stores these; they exist only for display /
// matching inside the editor.
function deriveGeneratedCatalogRows(manifest) {
  const rows = [];
  for (const [key, entry] of Object.entries(manifest.entries ?? {})) {
    if (isPlaceholderManifestEntry(entry)) continue;
    rows.push({
      id: `${GENERATED_ID_PREFIX}${key}`,
      kind: 'sprite',
      label: key,
      description: entry?.catalog?.description ?? `Generated sprite from brief: ${entry.briefId}.`,
      tags: deriveGeneratedTags(entry),
      spriteId: key,
      sheetKey: GENERATED_SHEET_KEY,
      assetPath: entry.assetPath,
      frame: 0,
      col: 0,
      row: 0,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

// The full catalog view = committed non-generated rows + derived generated rows.
function composeFullCatalog(committed, manifest) {
  const base = Array.isArray(committed)
    ? committed.filter(
        (entry) => typeof entry?.id === 'string' && !entry.id.startsWith(GENERATED_ID_PREFIX),
      )
    : [];
  return [...base, ...deriveGeneratedCatalogRows(manifest)];
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeFacing(value) {
  return value === 'left' ? 'left' : 'right';
}

function clampInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function indexCatalogSprites(catalog) {
  const byAssetPath = new Map();
  const bySpriteId = new Map();
  for (const entry of catalog) {
    if (!entry || entry.kind !== 'sprite') continue;
    if (typeof entry.assetPath === 'string' && entry.assetPath.length > 0) {
      byAssetPath.set(entry.assetPath, entry);
    }
    if (typeof entry.spriteId === 'string' && entry.spriteId.length > 0) {
      bySpriteId.set(entry.spriteId, entry);
    }
  }
  return { byAssetPath, bySpriteId };
}

function getCatalogMatch(entryKey, manifestEntry, catalogIndex) {
  const byAsset = catalogIndex.byAssetPath.get(manifestEntry.assetPath);
  if (byAsset) return byAsset;
  const bySprite = catalogIndex.bySpriteId.get(entryKey);
  if (bySprite) return bySprite;
  const bySpriteName = catalogIndex.bySpriteId.get(manifestEntry.spriteName);
  return bySpriteName ?? null;
}

function deriveVariantGroup(entryKey, manifestEntry) {
  if (typeof manifestEntry?.briefId === 'string' && manifestEntry.briefId.length > 0) {
    return manifestEntry.briefId;
  }
  const source = String(manifestEntry?.spriteName ?? entryKey);
  return source
    .replace(/-var-\d+$/u, '')
    .replace(/-placeholder$/u, '')
    .trim();
}

function readAnnotations() {
  if (!existsSync(ANNOTATIONS_PATH)) {
    return { version: 1, sprites: {} };
  }
  try {
    const parsed = readJsonFile(ANNOTATIONS_PATH);
    if (!parsed || typeof parsed !== 'object') return { version: 1, sprites: {} };
    const sprites = parsed.sprites && typeof parsed.sprites === 'object' ? parsed.sprites : {};
    return { version: 1, sprites };
  } catch {
    return { version: 1, sprites: {} };
  }
}

function computeSummary(entryKey, manifestEntry, catalogEntry, note, manifestFingerprint) {
  const hold = manifestEntry?.anchors?.hold ?? manifestEntry?.anchor ?? null;
  const pivot = manifestEntry?.anchors?.centerOfGravity ?? hold ?? null;
  const tags = Array.isArray(catalogEntry?.tags)
    ? catalogEntry.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const favorite = note?.favorite === true;
  const disliked = note?.disliked === true && !favorite;
  const comment = typeof note?.comment === 'string' ? note.comment : '';
  return {
    key: entryKey,
    // Cache key for `/img/sprite`. `contentHash` makes repeat visits cache hits.
    // Legacy entries fall back to the manifest fingerprint, which correctly
    // invalidates on any shard write but also invalidates all legacy entries
    // together rather than independently.
    imageVersion:
      typeof manifestEntry?.contentHash === 'string' && manifestEntry.contentHash.length > 0
        ? manifestEntry.contentHash
        : `fp-${manifestFingerprint}`,
    variantGroup: deriveVariantGroup(entryKey, manifestEntry),
    label: manifestEntry.spriteName ?? entryKey,
    briefId: manifestEntry.briefId ?? null,
    variantIndex:
      typeof manifestEntry.variantIndex === 'number' ? manifestEntry.variantIndex : null,
    assetPath: manifestEntry.assetPath,
    sourceRun: manifestEntry.sourceRun ?? null,
    placeholder:
      manifestEntry.sourceRun === 'placeholder' ||
      (typeof manifestEntry.assetPath === 'string' &&
        manifestEntry.assetPath.toLowerCase().includes('placeholder')),
    facingDirection: normalizeFacing(manifestEntry.facingDirection),
    holdX: hold?.x ?? 0,
    holdY: hold?.y ?? 0,
    pivotX: pivot?.x ?? hold?.x ?? 0,
    pivotY: pivot?.y ?? hold?.y ?? 0,
    catalogId: catalogEntry?.id ?? null,
    frame: typeof catalogEntry?.frame === 'number' ? catalogEntry.frame : null,
    col: typeof catalogEntry?.col === 'number' ? catalogEntry.col : null,
    row: typeof catalogEntry?.row === 'number' ? catalogEntry.row : null,
    tags,
    favorite,
    disliked,
    comment,
    variantCount: 1,
    variantPosition: 1,
    prevVariantKey: null,
    nextVariantKey: null,
  };
}

/**
 * Throttled wrapper over `shardsFingerprint()`. The underlying walk stats 642
 * files (~50 ms); within `FINGERPRINT_TTL_MS` the previous result is reused so a
 * burst of requests (JSON + image for one sprite switch) pays it at most once.
 *
 * `force` recomputes unconditionally — used after our own writes so a save is
 * never observed through a stale fingerprint.
 */
function currentFingerprint(force = false) {
  const now = Date.now();
  if (!force && lastFingerprint && now - lastFingerprintAtMs < FINGERPRINT_TTL_MS) {
    return lastFingerprint;
  }
  lastFingerprint = shardsFingerprint();
  lastFingerprintAtMs = now;
  return lastFingerprint;
}

/** Invalidate every cache layer after a write this process performed. */
function invalidateCaches() {
  cache.manifest = null;
  cache.catalog = null;
  cache.annotations = null;
  lastFingerprint = '';
  lastFingerprintAtMs = -Infinity;
}

/**
 * Compose the manifest, preferring the durable snapshot.
 *
 * The snapshot is only used when its recorded fingerprint matches the live one,
 * so a stale or externally-modified shard set always falls through to a real
 * compose. On a miss we compose from shards and refresh the snapshot so the NEXT
 * cold process (new session, app restart, extensions_reload) starts warm.
 */
function composeManifestCached(fingerprint) {
  const snapshot = readSnapshot(SNAPSHOT_PATH, fingerprint);
  if (snapshot) return snapshot.manifest;
  const manifest = composeManifestFromShards();
  writeSnapshot(SNAPSHOT_PATH, fingerprint, manifest);
  return manifest;
}

function readCatalogWithMtime() {
  try {
    return { catalog: readJsonFile(CATALOG_PATH), mtimeMs: statSync(CATALOG_PATH).mtimeMs };
  } catch {
    return { catalog: [], mtimeMs: -1 };
  }
}

function loadData() {
  const manifestFingerprint = currentFingerprint();
  const { catalog: rawCatalog, mtimeMs: catalogMtimeMs } = readCatalogWithMtime();
  const annotationsMtimeMs = existsSync(ANNOTATIONS_PATH) ? statSync(ANNOTATIONS_PATH).mtimeMs : -1;
  if (
    cache.manifest &&
    cache.catalog &&
    cache.annotations &&
    cache.manifestFingerprint === manifestFingerprint &&
    cache.catalogMtimeMs === catalogMtimeMs &&
    cache.annotationsMtimeMs === annotationsMtimeMs
  ) {
    return cache;
  }

  const manifest = composeManifestCached(manifestFingerprint);
  // The committed catalog no longer stores generated rows; derive them from the
  // manifest so the editor still has a full catalog view for matching/summaries.
  const catalog = composeFullCatalog(rawCatalog, manifest);
  const annotations = readAnnotations();
  const catalogIndex = indexCatalogSprites(catalog);
  const summaries = Object.entries(manifest.entries ?? {})
    .map(([key, entry]) => {
      const catalogEntry = getCatalogMatch(key, entry, catalogIndex);
      const note = annotations.sprites?.[key] ?? {};
      return computeSummary(key, entry, catalogEntry, note, manifestFingerprint);
    })
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  const variantGroups = new Map();
  for (const summary of summaries) {
    const group = summary.variantGroup ?? summary.key;
    if (!variantGroups.has(group)) variantGroups.set(group, []);
    variantGroups.get(group).push(summary);
  }
  for (const rows of variantGroups.values()) {
    rows.sort((lhs, rhs) => {
      const lIdx =
        typeof lhs.variantIndex === 'number' ? lhs.variantIndex : Number.MAX_SAFE_INTEGER;
      const rIdx =
        typeof rhs.variantIndex === 'number' ? rhs.variantIndex : Number.MAX_SAFE_INTEGER;
      if (lIdx !== rIdx) return lIdx - rIdx;
      return lhs.key.localeCompare(rhs.key);
    });
    const count = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      row.variantCount = count;
      row.variantPosition = i + 1;
      row.prevVariantKey = count > 1 ? rows[(i - 1 + count) % count].key : null;
      row.nextVariantKey = count > 1 ? rows[(i + 1) % count].key : null;
    }
  }
  const allTags = Array.from(
    new Set(summaries.flatMap((summary) => summary.tags.map((tag) => tag.toLowerCase()))),
  ).sort((a, b) => a.localeCompare(b));
  const summaryByKey = new Map(summaries.map((summary) => [summary.key, summary]));
  cache = {
    manifestFingerprint,
    catalogMtimeMs,
    annotationsMtimeMs,
    manifest,
    catalog,
    annotations,
    summaries,
    summaryByKey,
    allTags,
  };
  return cache;
}

function resolveAssetDiskPath(assetPath) {
  if (typeof assetPath !== 'string' || assetPath.trim() === '') return null;
  const normalized = assetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(ASSETS_ROOT, normalized);
  const rel = path.relative(ASSETS_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function repoPosixPath(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  return rel.split(path.sep).join('/');
}

function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl.trim());
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_WRITE_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

function execGit(args, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, encoding },
      (error, stdout, stderr) => {
        if (error) {
          const toText = (value) => {
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return typeof value === 'string' ? value : '';
          };
          const msg = toText(stderr) || toText(stdout) || String(error);
          reject(new Error(msg.trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Durably persist an edited asset onto the remote `assets/queue` branch by
 * spawning the tsx queue-commit CLI. Never throws: a durability failure must
 * NOT lose the local edit that already succeeded on disk, so failures are
 * returned as a status object the caller surfaces (and logs) instead. Exit 20
 * from the CLI means the push was skipped on CI.
 */
async function queueCommitEditedAsset(assetPath, key) {
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        TSX_CLI,
        QUEUE_COMMIT_CLI,
        '--repo-root',
        REPO_ROOT,
        '--asset',
        assetPath,
        '--manifest-key',
        key,
        '--message',
        `chore(assets): edit ${key}`,
      ],
      {
        cwd: REPO_ROOT,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        // Belt-and-suspenders: force git fully non-interactive so a missing
        // credential fails fast instead of blocking on a prompt (the CLI's
        // runtime also injects this), pin the locale so git's rejection
        // porcelain stays English, plus a catastrophic timeout backstop.
        // GIT_ASKPASS is forced empty (not defaulted) so an inherited GUI
        // helper can't be invoked despite GIT_TERMINAL_PROMPT=0.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          GCM_INTERACTIVE: 'never',
          LC_ALL: 'C',
          LANG: 'C',
        },
        timeout: QUEUE_COMMIT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        // A timeout kill reports error.killed with a null code; normalize to a
        // non-zero exit so it surfaces as a durability failure (never a silent
        // success) that the caller logs without losing the on-disk edit.
        const killed = Boolean(error && error.killed === true);
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        const timeoutNote = killed
          ? `queue-commit timed out after ${QUEUE_COMMIT_TIMEOUT_MS}ms\n`
          : '';
        resolve({
          code: killed ? code || 1 : code,
          stdout: String(stdout ?? ''),
          stderr: timeoutNote + String(stderr ?? ''),
        });
      },
    );
  });
  if (result.code === 0) {
    try {
      const lastLine = result.stdout.trim().split('\n').pop() || '{}';
      return { ...JSON.parse(lastLine), status: 'ok' };
    } catch {
      return { status: 'ok' };
    }
  }
  if (result.code === 20) return { status: 'skipped', reason: 'ci' };
  const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  console.warn(`[sprite-editor] queue-commit failed for ${key}: ${detail}`);
  return { status: 'failed', error: detail };
}

function applyMetadataUpdate(payload, data, key) {
  const entry = data.manifest.entries?.[key];
  if (!entry) {
    throw new CanvasError('not_found', `Manifest entry "${key}" not found.`);
  }
  const summary = data.summaryByKey.get(key);
  const currentHoldX = clampInt(summary?.holdX, entry?.anchors?.hold?.x ?? entry?.anchor?.x ?? 0);
  const currentHoldY = clampInt(summary?.holdY, entry?.anchors?.hold?.y ?? entry?.anchor?.y ?? 0);
  const currentPivotX = clampInt(
    summary?.pivotX,
    entry?.anchors?.centerOfGravity?.x ?? currentHoldX,
  );
  const currentPivotY = clampInt(
    summary?.pivotY,
    entry?.anchors?.centerOfGravity?.y ?? currentHoldY,
  );
  const holdX = clampInt(payload?.metadata?.holdX, currentHoldX);
  const holdY = clampInt(payload?.metadata?.holdY, currentHoldY);
  const pivotX = clampInt(payload?.metadata?.pivotX, currentPivotX);
  const pivotY = clampInt(payload?.metadata?.pivotY, currentPivotY);
  const anchorChanged =
    holdX !== currentHoldX ||
    holdY !== currentHoldY ||
    pivotX !== currentPivotX ||
    pivotY !== currentPivotY;
  if (anchorChanged) {
    entry.anchor = { x: holdX, y: holdY, source: 'manual' };
    entry.anchors = {
      ...(entry.anchors ?? {}),
      hold: { x: holdX, y: holdY, source: 'manual' },
      centerOfGravity: { x: pivotX, y: pivotY, source: 'manual' },
    };
    entry.effectiveAnchorSource = 'manual';
  }
  const hasFacingDirection =
    payload?.metadata?.facingDirection === 'left' || payload?.metadata?.facingDirection === 'right';
  const facingDirection = normalizeFacing(payload?.metadata?.facingDirection);
  if (hasFacingDirection && facingDirection !== summary?.facingDirection) {
    entry.facingDirection = facingDirection;
  }

  const catalogId =
    typeof payload?.metadata?.catalogId === 'string'
      ? payload.metadata.catalogId
      : summary?.catalogId;
  const catalogEntry = data.catalog.find((item) => {
    if (!item || item.kind !== 'sprite') return false;
    if (catalogId && item.id === catalogId) return true;
    return typeof item.assetPath === 'string' && item.assetPath === entry.assetPath;
  });
  if (catalogEntry) {
    const frame = clampInt(payload?.metadata?.frame, summary?.frame ?? catalogEntry.frame ?? 0);
    const col = clampInt(payload?.metadata?.col, summary?.col ?? catalogEntry.col ?? 0);
    const row = clampInt(payload?.metadata?.row, summary?.row ?? catalogEntry.row ?? 0);
    if (frame !== summary?.frame) catalogEntry.frame = frame;
    if (col !== summary?.col) catalogEntry.col = col;
    if (row !== summary?.row) catalogEntry.row = row;
  }
}

function applyAnnotationUpdate(payload, data, key) {
  if (!data.annotations?.sprites || typeof data.annotations.sprites !== 'object') {
    data.annotations = { version: 1, sprites: {} };
  }
  const favorite = payload?.annotation?.favorite === true;
  const disliked = payload?.annotation?.disliked === true && !favorite;
  const rawComment =
    typeof payload?.annotation?.comment === 'string' ? payload.annotation.comment : '';
  const comment = rawComment.trim().slice(0, 1000);
  data.annotations.sprites[key] = { favorite, disliked, comment };
}

async function saveSprite(payload) {
  const key = typeof payload?.key === 'string' ? payload.key : '';
  if (!key) throw new CanvasError('invalid_input', 'A sprite key is required.');
  const data = loadData();
  const entry = data.manifest.entries?.[key];
  if (!entry) throw new CanvasError('not_found', `Unknown sprite key "${key}".`);
  const hasMetadata =
    payload?.metadata !== null &&
    typeof payload?.metadata === 'object' &&
    !Array.isArray(payload.metadata);
  const hasAnnotation =
    payload?.annotation !== null &&
    typeof payload?.annotation === 'object' &&
    !Array.isArray(payload.annotation);
  let wrotePng = false;
  try {
    if (hasMetadata) applyMetadataUpdate(payload, data, key);
    if (hasAnnotation) applyAnnotationUpdate(payload, data, key);

    if (typeof payload?.pngDataUrl === 'string' && payload.pngDataUrl.length > 0) {
      const bytes = decodePngDataUrl(payload.pngDataUrl);
      if (!bytes) throw new CanvasError('invalid_png', 'Invalid PNG payload.');
      const pngPath = resolveAssetDiskPath(entry.assetPath);
      if (!pngPath) throw new CanvasError('invalid_path', 'Refusing to write outside assets root.');
      writeFileSync(pngPath, bytes);
      entry.contentHash = sha256Hex(bytes);
      wrotePng = true;
    }

    // Metadata edits and PNG saves both mutate the manifest entry; PNG writes
    // refresh contentHash. Persist to the per-asset shard (the aggregate
    // manifest.json is a build artifact and is no longer written here).
    if (hasMetadata || wrotePng) {
      writeShard(key, data.manifest.entries[key]);
    }
    // No catalog write: the committed catalog no longer stores generated rows;
    // they are derived from the manifest at read time. Frame/col/row edits for
    // generated sprites are inherently virtual (always 0) and never persisted.
    if (hasAnnotation) writeJsonFile(ANNOTATIONS_PATH, data.annotations);
    invalidateCaches();
    // Persist manifest/catalog/PNG edits to the durable assets/queue branch so
    // anchor/metadata edits survive across sessions/worktrees/processes.
    // Annotation-only saves (favorite/comment) are local curation and are NOT
    // queued (the art surface did not change). Best-effort — never throws.
    let queue = null;
    if (hasMetadata || wrotePng) {
      queue = await queueCommitEditedAsset(entry.assetPath, key);
    }
    const fresh = loadData().summaryByKey.get(key);
    return { ok: true, sprite: fresh ?? null, queue };
  } finally {
    invalidateCaches();
  }
}

async function revertSprite(payload) {
  const key = typeof payload?.key === 'string' ? payload.key : '';
  if (!key) throw new CanvasError('invalid_input', 'A sprite key is required.');

  const data = loadData();
  const currentEntry = data.manifest.entries?.[key];
  if (!currentEntry) throw new CanvasError('not_found', `Unknown sprite key "${key}".`);
  const assetDiskPath = resolveAssetDiskPath(currentEntry.assetPath);
  if (!assetDiskPath) throw new CanvasError('invalid_path', 'Invalid asset path.');

  try {
    // Source of truth at HEAD is the per-asset shard, not the aggregate.
    let headEntry;
    try {
      headEntry = JSON.parse(
        await execGit(['show', `HEAD:${repoPosixPath(shardPathForKey(key))}`]),
      );
    } catch {
      throw new CanvasError('not_in_head', `Sprite "${key}" not found at HEAD.`);
    }
    const pngHead = await execGit(['show', `HEAD:${repoPosixPath(assetDiskPath)}`], 'buffer');

    if (!headEntry) throw new CanvasError('not_in_head', `Sprite "${key}" not found at HEAD.`);
    data.manifest.entries[key] = headEntry;
    // No committed-catalog revert: generated catalog rows are derived from the
    // manifest, so restoring the shard restores the derived row too.

    writeFileSync(assetDiskPath, pngHead);
    writeShard(key, headEntry);
    // A save queues the edit onto the durable assets/queue branch. Reverting
    // only on disk would leave that queued edit live on the branch, so the
    // hourly reconciler (assets/queue → main) would resurface it and silently
    // undo the revert. Push the reverted state onto the queue too. Best-effort:
    // queueCommitEditedAsset never throws (returns a {status} the UI surfaces).
    const queue = await queueCommitEditedAsset(data.manifest.entries[key].assetPath, key);
    const fresh = loadData().summaryByKey.get(key);
    return { ok: true, sprite: fresh ?? null, queue };
  } finally {
    invalidateCaches();
  }
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > MAX_WRITE_BYTES * 2) {
        tooBig = true;
        data = '';
      }
    });
    req.on('end', () => {
      if (tooBig) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function matchesFilters(summary, filters) {
  const search = (filters.search ?? '').toLowerCase();
  if (search.length > 0) {
    const haystack =
      `${summary.key} ${summary.label} ${summary.briefId ?? ''} ${summary.assetPath} ${
        summary.comment ?? ''
      } ${summary.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  if (filters.placeholderMode === 'only' && !summary.placeholder) return false;
  if (filters.placeholderMode === 'exclude' && summary.placeholder) return false;
  if (filters.favoriteMode === 'only' && !summary.favorite) return false;

  if (filters.tagSet.size > 0) {
    const tags = new Set(summary.tags.map((tag) => tag.toLowerCase()));
    for (const tag of filters.tagSet) {
      if (!tags.has(tag)) return false;
    }
  }
  return true;
}

function collapseByVariantGroup(rows) {
  const byGroup = new Map();
  for (const row of rows) {
    const existing = byGroup.get(row.variantGroup);
    if (!existing) {
      byGroup.set(row.variantGroup, row);
      continue;
    }
    if (!existing.favorite && row.favorite) {
      byGroup.set(row.variantGroup, row);
      continue;
    }
    const lhs =
      typeof existing.variantIndex === 'number' ? existing.variantIndex : Number.MAX_SAFE_INTEGER;
    const rhs = typeof row.variantIndex === 'number' ? row.variantIndex : Number.MAX_SAFE_INTEGER;
    if (rhs < lhs) {
      byGroup.set(row.variantGroup, row);
    }
  }
  return [...byGroup.values()];
}

function parseListFilters(url, input = null) {
  const fromUrl = {
    search: url?.searchParams?.get('q') ?? '',
    collapseVariants:
      (url?.searchParams?.get('collapse') ?? '').toLowerCase() === 'true' ||
      (url?.searchParams?.get('collapse') ?? '') === '1',
    placeholderMode: (url?.searchParams?.get('placeholders') ?? 'all').toLowerCase(),
    favoriteMode: (url?.searchParams?.get('favorites') ?? 'all').toLowerCase(),
    tags: (url?.searchParams?.get('tags') ?? '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
    limit: Number(url?.searchParams?.get('limit') ?? 250),
    offset: Number(url?.searchParams?.get('offset') ?? 0),
  };
  const merged = input
    ? {
        ...fromUrl,
        ...input,
        tags: Array.isArray(input.tags) ? input.tags : fromUrl.tags,
      }
    : fromUrl;
  const placeholderMode =
    merged.placeholderMode === 'only' || merged.placeholderMode === 'exclude'
      ? merged.placeholderMode
      : 'all';
  const favoriteMode = merged.favoriteMode === 'only' ? 'only' : 'all';
  const tags = Array.isArray(merged.tags)
    ? merged.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    search: typeof merged.search === 'string' ? merged.search.trim() : '',
    collapseVariants: merged.collapseVariants === true,
    placeholderMode,
    favoriteMode,
    tagSet: new Set(tags),
    tags,
    limit: Math.max(1, Math.min(MAX_RESULTS, Number(merged.limit ?? 250))),
    offset: Math.max(0, Number(merged.offset ?? 0)),
  };
}

async function fetchOpenCvVendorAsset(fileName) {
  const expectedHash = OPENCV_VENDOR_HASHES.get(fileName);
  if (!expectedHash) {
    return { status: 404, body: 'unknown vendor asset' };
  }
  const cached = openCvVendorCache.get(fileName);
  if (cached) return cached;
  const url = `${OPENCV_VENDOR_BASE}/${fileName}`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 10_000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: abortController.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { status: 504, body: `timed out fetching ${fileName}` };
    }
    return { status: 502, body: `failed to fetch ${fileName}` };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    return {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
      },
      body: body || `failed to fetch ${fileName}`,
    };
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  const actualHash = sha256Hex(body);
  if (actualHash !== expectedHash) {
    log(`Rejected ${fileName}: expected SHA-256 ${expectedHash}, received ${actualHash}`, 'error');
    return { status: 502, body: 'vendor asset integrity check failed' };
  }
  const verified = {
    status: 200,
    headers: {
      'Cache-Control': 'private, max-age=86400',
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    },
    body,
  };
  openCvVendorCache.set(fileName, verified);
  return verified;
}

function listSprites(filters) {
  const data = loadData();
  const filtered = data.summaries.filter((summary) => matchesFilters(summary, filters));
  const collapsed = filters.collapseVariants ? collapseByVariantGroup(filtered) : filtered;
  return {
    total: collapsed.length,
    offset: filters.offset,
    limit: filters.limit,
    availableTags: data.allTags,
    sprites: collapsed.slice(filters.offset, filters.offset + filters.limit),
  };
}

const jsonRoutes = [
  {
    method: 'GET',
    path: '/api/list',
    handler: ({ url }) => {
      const filters = parseListFilters(url);
      return { json: listSprites(filters) };
    },
  },
  {
    method: 'GET',
    path: '/api/sprite',
    handler: ({ url }) => {
      const key = url.searchParams.get('key') ?? '';
      const summary = loadData().summaryByKey.get(key);
      if (!summary) return { status: 404, json: { error: 'sprite not found' } };
      return { json: { sprite: summary } };
    },
  },
  {
    method: 'POST',
    path: '/api/save',
    handler: async ({ req }) => {
      const body = await readJsonBody(req);
      try {
        const result = await saveSprite(body);
        return { json: result };
      } catch (error) {
        if (error instanceof CanvasError) {
          return { status: 400, json: { ok: false, code: error.code, error: error.message } };
        }
        return { status: 500, json: { ok: false, error: error?.message ?? String(error) } };
      }
    },
  },
  {
    method: 'POST',
    path: '/api/revert',
    handler: async ({ req }) => {
      const body = await readJsonBody(req);
      try {
        const result = await revertSprite(body);
        return { json: result };
      } catch (error) {
        if (error instanceof CanvasError) {
          return { status: 400, json: { ok: false, code: error.code, error: error.message } };
        }
        return { status: 500, json: { ok: false, error: error?.message ?? String(error) } };
      }
    },
  },
];

const binaryRoutes = [
  {
    method: 'GET',
    path: /^\/vendor\/opencv\.js$/u,
    handler: async ({ url }) => {
      const fileName = path.posix.basename(url.pathname);
      return fetchOpenCvVendorAsset(fileName);
    },
  },
  {
    method: 'GET',
    path: '/img/sprite',
    handler: ({ url }) => {
      const key = url.searchParams.get('key') ?? '';
      const summary = loadData().summaryByKey.get(key);
      if (!summary) return { status: 404, body: 'sprite not found' };
      const pngPath = resolveAssetDiskPath(summary.assetPath);
      if (!pngPath) return { status: 400, body: 'invalid asset path' };
      // A request that pins the CURRENT `imageVersion` is immutable by
      // construction: any byte change mints a new version and therefore a new
      // URL. Those may be cached hard. Anything else (no version, or a stale
      // one) must revalidate, so a client holding an old version can never be
      // served it from its own cache.
      const requestedVersion = url.searchParams.get('v');
      const immutable = requestedVersion === summary.imageVersion;
      try {
        return {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-store',
          },
          body: readFileSync(pngPath),
        };
      } catch (error) {
        log(`failed to read image for ${key}: ${error?.message ?? error}`, 'warn');
        return { status: 404, body: 'image not found' };
      }
    },
  },
];

function buildState() {
  const { summaries } = loadData();
  return {
    ok: true,
    total: summaries.length,
    placeholders: summaries.filter((entry) => entry.placeholder).length,
    favorites: summaries.filter((entry) => entry.favorite).length,
    repoRoot: REPO_ROOT,
  };
}

async function ensureServer(ctx) {
  const existing = instances.get(ctx.instanceId);
  if (existing) return existing;

  const inflight = pendingStartups.get(ctx.instanceId);
  if (inflight) return inflight;

  const startup = startServerForInstance(ctx);
  pendingStartups.set(ctx.instanceId, startup);
  try {
    return await startup;
  } finally {
    pendingStartups.delete(ctx.instanceId);
  }
}

async function startServerForInstance(ctx) {
  const server = await startCanvasServer({
    instanceId: ctx.instanceId,
    renderHtml,
    buildState,
    jsonRoutes,
    binaryRoutes,
    log,
  });
  const entry = { url: server.url, close: server.close };
  instances.set(ctx.instanceId, entry);
  log(`serving instance ${ctx.instanceId} at ${server.url}`);
  return entry;
}

const canvas = createCanvas({
  id: 'sprite-editor',
  displayName: 'Sprite Editor',
  description:
    'Edit checked-in game sprites locally: browse/filter/search, annotate favorites/comments, tweak metadata, paint/erase pixels, and revert to HEAD.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  actions: [
    {
      name: 'list_sprites',
      description: 'List checked-in sprite entries with filters and optional variant collapse.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          search: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          collapseVariants: { type: 'boolean' },
          placeholderMode: { enum: ['all', 'only', 'exclude'] },
          favoriteMode: { enum: ['all', 'only'] },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
      handler: async (ctx) => {
        if (!instances.get(ctx.instanceId)) {
          throw new CanvasError('not_open', 'Canvas instance is not open.');
        }
        const filters = parseListFilters(null, ctx.input ?? {});
        return listSprites(filters);
      },
    },
    {
      name: 'reload',
      description: 'Re-read manifest, catalog, and sprite-editor annotations from disk.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (ctx) => {
        if (!instances.get(ctx.instanceId)) {
          throw new CanvasError('not_open', 'Canvas instance is not open.');
        }
        invalidateCaches();
        const state = buildState();
        return {
          ok: true,
          total: state.total,
          placeholders: state.placeholders,
          favorites: state.favorites,
        };
      },
    },
  ],
  open: async (ctx) => {
    const entry = await ensureServer(ctx);
    return { title: 'Sprite Editor', url: entry.url };
  },
  onClose: async (ctx) => {
    const entry = instances.get(ctx.instanceId);
    if (!entry) return;
    instances.delete(ctx.instanceId);
    try {
      await entry.close();
    } catch (error) {
      log(`error closing instance ${ctx.instanceId}: ${error?.message ?? error}`, 'warn');
    }
  },
});

sessionRef = await joinSession({ canvases: [canvas] });
log('sprite-editor canvas provider registered');

// PROACTIVE HYDRATION.
//
// Everything above makes a warm process fast, but the FIRST open of a cold
// process still had to compose 642 shards (~730 ms) on the request path. Warm
// the caches here instead, right after registration: the extension host has
// already started us, but the user has typically not opened the canvas yet, so
// this work overlaps with their think-time rather than their click.
//
// Deferred to a macrotask so registration is never blocked, and fully
// best-effort — a failed hydration only means the first request composes
// normally, exactly as before.
setTimeout(() => {
  const startedAtMs = Date.now();
  try {
    const { summaries } = loadData();
    log(`hydrated ${summaries.length} sprite entries in ${Date.now() - startedAtMs}ms`);
  } catch (error) {
    log(`cache hydration skipped: ${error?.message ?? error}`, 'warn');
  }
}, 0).unref?.();
