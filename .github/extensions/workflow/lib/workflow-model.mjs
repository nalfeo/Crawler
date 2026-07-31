/**
 * workflow-model.mjs — the backlog/report domain logic for the sprite-generation
 * workflow canvas, ported faithfully (1:1) from the monolith's already-tested
 * pure modules so the canvas shows EXACTLY the same statuses and counts:
 *   - `src/shared/art-plan-status.ts`  (resolveIntegrationState / resolveArtPlanStatus / briefKey)
 *   - `src/devtools/art-plan-model.ts` (zod schemas + parse/build functions)
 *
 * The only NEW code is `loadBacklog()`, the node orchestrator that replaces the
 * monolith's Vite-specific data plumbing (`import.meta.glob` + `fetch('/assets/…')`)
 * with plain fs reads:
 *   - plans/briefs via `yaml-reader.mjs`,
 *   - the generated manifest at `public/assets/generated/manifest.json`,
 *   - asset existence by fs-checking `public/assets/<assetPath>` (the monolith
 *     HEAD-checks `/assets/<assetPath>` against the Vite dev server; on disk the
 *     same file backs that route).
 *
 * Pure + dependency-light (`yaml`, `zod` — both normal repo deps). Everything
 * except `loadBacklog`'s fs reads is side-effect-free and unit-testable.
 *
 * @module workflow/workflow-model
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepoRequire } from '../../shared/node-modules-resolver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at .github/extensions/workflow/lib/ — 4 levels up is the repo root.
const _repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const _require = createRepoRequire(_repoRoot, import.meta.url);
const { z } = _require('zod');
const { parse: parseYaml } = _require('yaml');

import { listArtPlans, listBriefs } from './yaml-reader.mjs';

// ===========================================================================
// Ported verbatim from `src/shared/art-plan-status.ts` (types erased).
// ===========================================================================

/**
 * @param {{ kind: 'sprite-registry'|'item-catalog', id: string } | undefined} target
 * @param {boolean} approvedAssetExists
 * @param {ReadonlySet<string>} spriteIds
 * @param {ReadonlySet<string>} itemIds
 * @returns {'integrated'|'missing'|'not-applicable'}
 */
export function resolveIntegrationState(target, approvedAssetExists, spriteIds, itemIds) {
  if (!target) return 'not-applicable';
  if (target.kind === 'sprite-registry') {
    return spriteIds.has(target.id) ? 'integrated' : 'missing';
  }
  return itemIds.has(target.id) && approvedAssetExists ? 'integrated' : 'missing';
}

/**
 * @param {{ briefAuthored: boolean, draftAuthored: boolean, approved: boolean,
 *   approvedAssetExists: boolean, integrationState: 'integrated'|'missing'|'not-applicable',
 *   placeholderInUse: boolean }} args
 * @returns {string} an ArtPlanStatus
 */
export function resolveArtPlanStatus(args) {
  if (args.approved && !args.approvedAssetExists) return 'approved-missing-file';
  if (args.approved && args.integrationState === 'integrated') return 'ready';
  if (args.approved && args.integrationState === 'not-applicable') return 'approved';
  if (args.approved) return 'approved-not-integrated';
  if (args.briefAuthored && args.placeholderInUse) return 'brief-ready-placeholder';
  if (args.briefAuthored) return 'brief-ready';
  if (args.draftAuthored && args.placeholderInUse) return 'draft-ready-placeholder';
  if (args.draftAuthored) return 'draft-ready';
  if (args.placeholderInUse) return 'needs-art-placeholder';
  return 'planned';
}

/** @param {string} type @param {string} name @returns {string} */
export function briefKey(type, name) {
  return `${type}::${name}`;
}

// ===========================================================================
// Ported verbatim from `src/devtools/art-plan-model.ts` (types erased).
// ===========================================================================

const spriteTypes = ['weapon', 'equipment', 'enemy', 'item', 'prop', 'tile', 'vfx', 'character'];

const integrationTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('sprite-registry'),
      id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('item-catalog'),
      id: z.string().trim().min(1),
    })
    .strict(),
]);

const assetPlanEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(spriteTypes),
    label: z.string().trim().min(1),
    brief: z.string().trim().min(1),
    briefId: z.string().trim().min(1).optional(),
    briefOverrides: z.record(z.string(), z.unknown()).optional(),
    placeholderInUse: z.boolean().default(true),
    integration: integrationTargetSchema.optional(),
  })
  .strict();

const assetPlanSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().default(''),
    assets: z.array(assetPlanEntrySchema).min(1),
  })
  .strict();

const minimalBriefSchema = z
  .object({
    type: z.enum(spriteTypes),
    name: z.string().trim().min(1),
  })
  .passthrough();

/** All possible per-asset statuses, ordered from most to least complete. */
export const STATUS_ORDER = [
  'ready',
  'approved',
  'approved-not-integrated',
  'approved-missing-file',
  'brief-ready',
  'brief-ready-placeholder',
  'draft-ready',
  'draft-ready-placeholder',
  'needs-art-placeholder',
  'planned',
];

/**
 * `STATUS_ORDER` plus the canvas-only `approved-unverified` degrade status. Used
 * to seed count buckets so a table always shows every status, including the one
 * the monolith never produces (it always has compile-time registry ids). The
 * monolith-faithful ordering is `STATUS_ORDER`; `approved-unverified` sorts last.
 */
export const ALL_STATUSES = [...STATUS_ORDER, 'approved-unverified'];

/** @param {Record<string, string>} rawPlans @returns {Array<object>} */
export function parseFloorArtPlans(rawPlans) {
  const parsed = [];
  for (const source of Object.values(rawPlans)) {
    const value = parseYaml(source);
    const result = assetPlanSchema.safeParse(value);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

/** @param {Record<string, string>} rawBriefs @returns {Set<string>} */
export function parseCommittedBriefKeys(rawBriefs) {
  return parseBriefKeys(rawBriefs, 'committed');
}

/** @param {Record<string, string>} rawBriefs @returns {Set<string>} */
export function parseDraftBriefKeys(rawBriefs) {
  return parseBriefKeys(rawBriefs, 'draft');
}

/**
 * @param {Record<string, string>} rawBriefs
 * @param {'committed'|'draft'} mode
 * @returns {Set<string>}
 */
function parseBriefKeys(rawBriefs, mode) {
  const keys = new Set();
  for (const [briefPath, source] of Object.entries(rawBriefs)) {
    const isDraft = briefPath.toLowerCase().includes('/draft/');
    if (mode === 'committed' && isDraft) {
      continue;
    }
    if (mode === 'draft' && !isDraft) {
      continue;
    }
    const value = parseYaml(source);
    const result = minimalBriefSchema.safeParse(value);
    if (!result.success) {
      continue;
    }
    keys.add(briefKey(result.data.type, result.data.name));
  }
  return keys;
}

/**
 * @param {unknown} manifest
 * @param {{ existingAssets: ReadonlySet<string> }} options
 * @returns {Map<string, object>}
 */
export function parseApprovedSprites(manifest, options) {
  const out = new Map();
  const parsed = generatedManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return out;
  }
  for (const [mapKey, entry] of Object.entries(parsed.data.entries)) {
    if (entry.sourceRun === 'placeholder') {
      continue;
    }
    const briefId = entry.briefId || mapKey;
    out.set(briefId, {
      briefId,
      assetPath: entry.assetPath,
      sourceRun: entry.sourceRun,
      variantIndex: entry.variantIndex,
      exists: options.existingAssets.has(entry.assetPath),
    });
  }
  return out;
}

/**
 * Every valid, non-placeholder manifest entry, individually — unlike
 * {@link parseApprovedSprites} (keyed by briefId, so a SECOND manifest entry
 * sharing a briefId silently overwrites the first), this keeps every entry.
 * Used by the Workflow canvas's per-variant lifecycle classification, which
 * must be able to match an EXACT `{briefId, sourceRun, variantIndex}` triple
 * even when a briefId has more than one manifest entry (e.g. multiple
 * accepted variants generated from the same brief).
 * @param {unknown} manifest
 * @param {{ existingAssets: ReadonlySet<string> }} options
 * @returns {Array<{ mapKey: string, briefId: string, assetPath: string, sourceRun: string, variantIndex: number, exists: boolean }>}
 */
export function listManifestApprovals(manifest, options) {
  const parsed = generatedManifestSchema.safeParse(manifest);
  if (!parsed.success) return [];
  const out = [];
  for (const [mapKey, entry] of Object.entries(parsed.data.entries)) {
    if (entry.sourceRun === 'placeholder') continue;
    out.push({
      mapKey,
      briefId: entry.briefId || mapKey,
      assetPath: entry.assetPath,
      sourceRun: entry.sourceRun,
      variantIndex: entry.variantIndex,
      exists: options.existingAssets.has(entry.assetPath),
    });
  }
  return out;
}

/**
 * @param {object} plan  a parsed FloorArtPlan
 * @param {{ briefKeys: ReadonlySet<string>, draftBriefKeys: ReadonlySet<string>,
 *   approvedSprites: ReadonlyMap<string, object>, spriteRegistryIds: ReadonlySet<string>,
 *   itemCatalogIds: ReadonlySet<string>, integrationResolved?: boolean }} options
 * @returns {object} a FloorArtPlanReport
 */
export function buildFloorArtPlanReport(plan, options) {
  // `integrationResolved` defaults to true → byte-identical to the monolith,
  // which always has compile-time registry ids. When the canvas cannot load the
  // registry at runtime (esbuild-transform failed) it passes `false`, and we
  // degrade HONESTLY: an asset that targets the registry/catalog is marked
  // `unverified` (never a fabricated `missing`), and an approved asset whose
  // file is present gets the distinct `approved-unverified` status instead of
  // being mislabelled `approved-not-integrated`.
  const integrationResolved = options.integrationResolved !== false;

  const assets = plan.assets.map((asset) => {
    const briefId = asset.briefId ?? asset.id;
    const briefAuthored = options.briefKeys.has(briefKey(asset.type, briefId));
    const draftAuthored = options.draftBriefKeys.has(briefKey(asset.type, briefId));
    const approvedEntry = options.approvedSprites.get(briefId);
    const approved = approvedEntry !== undefined;
    const approvedAssetExists = approvedEntry?.exists ?? false;

    let integrationState;
    let status;
    if (!integrationResolved && asset.integration) {
      integrationState = 'unverified';
      if (approved && !approvedAssetExists) {
        status = 'approved-missing-file';
      } else if (approved) {
        status = 'approved-unverified';
      } else {
        // Non-approved statuses are integration-independent, so computing them
        // with a neutral `not-applicable` is exact even when integration is
        // unverified.
        status = resolveArtPlanStatus({
          briefAuthored,
          draftAuthored,
          approved,
          approvedAssetExists,
          integrationState: 'not-applicable',
          placeholderInUse: asset.placeholderInUse,
        });
      }
    } else {
      integrationState = resolveIntegrationState(
        asset.integration,
        approvedAssetExists,
        options.spriteRegistryIds,
        options.itemCatalogIds,
      );
      status = resolveArtPlanStatus({
        briefAuthored,
        draftAuthored,
        approved,
        approvedAssetExists,
        integrationState,
        placeholderInUse: asset.placeholderInUse,
      });
    }

    return {
      id: asset.id,
      type: asset.type,
      label: asset.label,
      briefId,
      sourceRun: approvedEntry?.sourceRun ?? null,
      variantIndex: approvedEntry?.variantIndex ?? null,
      placeholderInUse: asset.placeholderInUse,
      integration: asset.integration ?? null,
      briefAuthored,
      draftAuthored,
      approved,
      approvedAssetExists,
      integrationState,
      status,
    };
  });

  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]));
  for (const asset of assets) {
    counts[asset.status] = (counts[asset.status] ?? 0) + 1;
  }
  const unresolvedPlaceholders = assets.filter(
    (asset) => asset.placeholderInUse && asset.status !== 'ready',
  ).length;

  return {
    planId: plan.id,
    title: plan.title,
    summary: plan.summary,
    assets,
    counts,
    unresolvedPlaceholders,
  };
}

const manifestEntrySchema = z
  .object({
    briefId: z.string().min(1),
    assetPath: z.string().min(1),
    sourceRun: z.string().min(1),
    variantIndex: z.number().int().min(0),
  })
  .passthrough();

const generatedManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string(), manifestEntrySchema),
  })
  .strict();

// ===========================================================================
// NEW: node orchestrator replacing the monolith's Vite-specific data plumbing.
// ===========================================================================

const SHARDS_REL = path.join('public', 'assets', 'generated', 'entries');
const ASSETS_ROOT_REL = path.join('public', 'assets');

/**
 * Normalise a manifest `assetPath` to the form that is relative to
 * `public/assets/`, so the on-disk existence check is faithful regardless of how
 * the path was recorded. The runtime already defensively handles the variants
 * `generated/x.png`, `/generated/x.png`, `assets/generated/x.png`, and
 * `/assets/generated/x.png`; we mirror that here. Canonical entries are already
 * `generated/x.png`, so this is a no-op for them.
 * @param {string} assetPath
 * @returns {string}
 */
export function normalizeAssetPath(assetPath) {
  let rel = String(assetPath).replace(/\\/g, '/').trim();
  rel = rel.replace(/^\/+/, ''); // strip leading slashes
  rel = rel.replace(/^assets\//, ''); // strip a leading assets/ segment
  return rel;
}

/**
 * True when a manifest `sourceRun` value refers to the exact `{briefId, runId}`
 * run — the same last-two-path-segments normalization `loadBacklog()` uses to
 * build `promotedRunIds`, exposed standalone so per-VARIANT lifecycle can ask
 * "did the manifest select exactly THIS run?" without re-deriving the promotion
 * set. Backslash-normalized so Windows-recorded paths still match.
 * @param {string | null | undefined} sourceRun
 * @param {string} briefId
 * @param {string} runId
 * @returns {boolean}
 */
export function sourceRunMatchesRun(sourceRun, briefId, runId) {
  if (typeof sourceRun !== 'string' || sourceRun.length === 0) return false;
  const parts = sourceRun
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '');
  if (parts.length < 2) return false;
  const runSegment = parts[parts.length - 1];
  const briefSegment = parts[parts.length - 2];
  return briefSegment === briefId && runSegment === runId;
}

/**
 * Compose the generated manifest from the committed per-asset shards under
 * `entries/`. The aggregate `manifest.json` is a gitignored build artifact, so
 * the shards are the source of truth. Returns `null` (never throws) if absent.
 */
function readManifest(repoRoot) {
  const shardsDir = path.join(repoRoot, SHARDS_REL);
  if (!existsSync(shardsDir)) return null;
  const entries = {};
  const walk = (abs, rel) => {
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        walk(path.join(abs, dirent.name), childRel);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.json')) {
        const key = childRel.slice(0, -'.json'.length);
        try {
          entries[key] = JSON.parse(readFileSync(path.join(abs, dirent.name), 'utf8'));
        } catch {
          // skip an unreadable/corrupt shard — degrade rather than crash
        }
      }
    }
  };
  walk(shardsDir, '');
  const sortedKeys = Object.keys(entries).sort();
  const sorted = {};
  for (const key of sortedKeys) sorted[key] = entries[key];
  return { version: 1, entries: sorted };
}

/** Build a `{ relPath: rawYamlString }` map from a yaml-reader listing. */
function readRawByRelPath(entries) {
  const out = {};
  for (const entry of entries) {
    try {
      out[entry.relPath] = readFileSync(entry.path, 'utf8');
    } catch {
      // skip unreadable file — degrade rather than crash
    }
  }
  return out;
}

/**
 * Build the full backlog: one FloorArtPlanReport per art plan, plus rolled-up
 * totals. Mirrors the monolith's `recompute()` in `src/devtools-main.ts`.
 *
 * @param {{ repoRoot: string, spriteIds: ReadonlySet<string> | null,
 *   itemIds: ReadonlySet<string> | null }} args
 * @returns {{ reports: object[], planCount: number, totals: Record<string, number>,
 *   unresolvedPlaceholders: number, integrationResolved: boolean,
 *   promotedRunIds: Set<string>, manifestApprovals: object[] }}
 *   `manifestApprovals` is every valid manifest entry (see
 *   {@link listManifestApprovals}) — used by the Workflow canvas's per-variant
 *   lifecycle classification as a fallback for a manifest-approved variant that
 *   has NO corresponding art-plan asset (so it never appears in `reports`).
 */
export function loadBacklog({ repoRoot, spriteIds, itemIds }) {
  const rawPlans = readRawByRelPath(listArtPlans({ repoRoot }));
  const rawBriefs = readRawByRelPath(listBriefs({ repoRoot }));

  const plans = parseFloorArtPlans(rawPlans);
  const briefKeys = parseCommittedBriefKeys(rawBriefs);
  const draftBriefKeys = parseDraftBriefKeys(rawBriefs);

  const manifest = readManifest(repoRoot);
  const existingAssets = new Set();
  const promotedRunIds = new Set();
  const parsedManifest = generatedManifestSchema.safeParse(manifest);
  if (parsedManifest.success) {
    for (const entry of Object.values(parsedManifest.data.entries)) {
      const abs = path.join(repoRoot, ASSETS_ROOT_REL, normalizeAssetPath(entry.assetPath));
      if (existsSync(abs)) {
        // Key by the RAW assetPath so parseApprovedSprites (which compares the
        // raw manifest value) matches; only the fs join is normalised.
        existingAssets.add(entry.assetPath);
      }
      // Store-oriented "promoted" hint: key by the last TWO path segments of a
      // non-placeholder sourceRun (`<briefId>/<runId>`), backslash-normalized —
      // matching the sidecar's canonical promotion keying (server.ts
      // `listPromotedRuns`) so Windows-style paths and runId collisions resolve.
      if (entry.sourceRun && entry.sourceRun !== 'placeholder') {
        const parts = entry.sourceRun
          .replace(/\\/g, '/')
          .split('/')
          .filter((segment) => segment !== '')
          .slice(-2);
        if (parts.length === 2) promotedRunIds.add(`${parts[0]}/${parts[1]}`);
      }
    }
  }
  const approvedSprites = parseApprovedSprites(manifest, { existingAssets });
  const manifestApprovals = listManifestApprovals(manifest, { existingAssets });

  const integrationResolved = Boolean(spriteIds && itemIds);
  const reports = plans.map((plan) =>
    buildFloorArtPlanReport(plan, {
      briefKeys,
      draftBriefKeys,
      approvedSprites,
      spriteRegistryIds: spriteIds ?? new Set(),
      itemCatalogIds: itemIds ?? new Set(),
      integrationResolved,
    }),
  );

  const totals = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]));
  let unresolvedPlaceholders = 0;
  for (const report of reports) {
    for (const status of ALL_STATUSES) {
      totals[status] += report.counts[status] ?? 0;
    }
    unresolvedPlaceholders += report.unresolvedPlaceholders;
  }

  return {
    reports,
    planCount: plans.length,
    totals,
    unresolvedPlaceholders,
    integrationResolved,
    promotedRunIds,
    manifestApprovals,
  };
}
