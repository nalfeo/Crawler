import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { startCanvasServer } from './lib/canvas-harness.mjs';
import { renderHtml } from './renderer.mjs';

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, '..', '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'public', 'assets', 'generated', 'manifest.json');
const CATALOG_PATH = path.join(REPO_ROOT, 'src', 'shared', 'data', 'sprite-catalog.json');
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

let cache = {
  manifestMtimeMs: -1,
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

function computeSummary(entryKey, manifestEntry, catalogEntry, note) {
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

function loadData() {
  const manifestMtimeMs = statSync(MANIFEST_PATH).mtimeMs;
  const catalogMtimeMs = statSync(CATALOG_PATH).mtimeMs;
  const annotationsMtimeMs = existsSync(ANNOTATIONS_PATH) ? statSync(ANNOTATIONS_PATH).mtimeMs : -1;
  if (
    cache.manifest &&
    cache.catalog &&
    cache.annotations &&
    cache.manifestMtimeMs === manifestMtimeMs &&
    cache.catalogMtimeMs === catalogMtimeMs &&
    cache.annotationsMtimeMs === annotationsMtimeMs
  ) {
    return cache;
  }

  const manifest = readJsonFile(MANIFEST_PATH);
  const catalog = readJsonFile(CATALOG_PATH);
  const annotations = readAnnotations();
  const catalogIndex = indexCatalogSprites(catalog);
  const summaries = Object.entries(manifest.entries ?? {})
    .map(([key, entry]) => {
      const catalogEntry = getCatalogMatch(key, entry, catalogIndex);
      const note = annotations.sprites?.[key] ?? {};
      return computeSummary(key, entry, catalogEntry, note);
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
    manifestMtimeMs,
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
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
  if (result.code === 0) {
    try {
      const lastLine = result.stdout.trim().split('\n').pop() || '{}';
      return { status: 'ok', ...JSON.parse(lastLine) };
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

    // Metadata edits and PNG saves both mutate the manifest; PNG writes refresh contentHash.
    if (hasMetadata || wrotePng) {
      writeJsonFile(MANIFEST_PATH, data.manifest);
    }
    if (hasMetadata) {
      writeJsonFile(CATALOG_PATH, data.catalog);
    }
    if (hasAnnotation) writeJsonFile(ANNOTATIONS_PATH, data.annotations);
    cache.manifest = null;
    cache.catalog = null;
    cache.annotations = null;
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
    cache.manifest = null;
    cache.catalog = null;
    cache.annotations = null;
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
    const manifestHead = JSON.parse(
      await execGit(['show', `HEAD:${repoPosixPath(MANIFEST_PATH)}`]),
    );
    const catalogHead = JSON.parse(await execGit(['show', `HEAD:${repoPosixPath(CATALOG_PATH)}`]));
    const pngHead = await execGit(['show', `HEAD:${repoPosixPath(assetDiskPath)}`], 'buffer');

    const headEntry = manifestHead?.entries?.[key];
    if (!headEntry) throw new CanvasError('not_in_head', `Sprite "${key}" not found at HEAD.`);
    data.manifest.entries[key] = headEntry;

    const summary = data.summaryByKey.get(key);
    const catalogId = summary?.catalogId ?? null;
    const headCatalogEntry = catalogHead.find((item) => {
      if (!item || item.kind !== 'sprite') return false;
      if (catalogId && item.id === catalogId) return true;
      return typeof item.assetPath === 'string' && item.assetPath === headEntry.assetPath;
    });
    if (headCatalogEntry) {
      const idx = data.catalog.findIndex((item) => item?.id === headCatalogEntry.id);
      if (idx >= 0) data.catalog[idx] = headCatalogEntry;
    }

    writeFileSync(assetDiskPath, pngHead);
    writeJsonFile(MANIFEST_PATH, data.manifest);
    writeJsonFile(CATALOG_PATH, data.catalog);
    const fresh = loadData().summaryByKey.get(key);
    return { ok: true, sprite: fresh ?? null };
  } finally {
    cache.manifest = null;
    cache.catalog = null;
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
      try {
        return {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
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
        cache.manifest = null;
        cache.catalog = null;
        cache.annotations = null;
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
