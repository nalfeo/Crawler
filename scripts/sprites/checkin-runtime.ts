/**
 * Real (production) wiring for `runAssetCheckin` — the exec runner + fs hooks.
 * Shared by the `sprites:checkin` CLI and the sidecar's POST /api/checkin route
 * so both drive the exact same side-effect implementation.
 *
 * This module is intentionally separate from `checkin.ts` (which stays IO-free
 * for unit testing) and from `checkin-cli.ts` (which has an `invokedAsScript`
 * side effect on import).
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ASSET_CHECKIN_LABEL,
  CheckinError,
  type CheckinAsset,
  type CheckinManifest,
  type CheckinRunnerDeps,
  type Exec,
  type ExecResult,
  type QueuedAssetCheckin,
} from './checkin.js';
import {
  mergeCatalogs,
  mergeManifests,
  parseAssetIssueBody,
  type CatalogEntry,
  type GeneratedManifest,
} from './asset-issues.js';
import { writeCatalogJson } from './catalog-io.js';

const realExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options?.cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });

const MANIFEST_REL = path.join('public', 'assets', 'generated', 'manifest.json');
const CATALOG_REL = path.join('src', 'shared', 'data', 'sprite-catalog.json');

function readJsonSafe<T>(absPath: string, fallback: T): T {
  if (!existsSync(absPath)) return fallback;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Copy ONLY `assets`' PNGs — plus their corresponding manifest/catalog
 * entries — from the live `srcRepoRoot` onto the freshly-checked-out worktree
 * `destRepoRoot`. This is a SELECTIVE projection, not a wholesale directory
 * copy: assets excluded from `assets` (already durably queued by another open
 * `asset-checkin` issue, or simply not part of this batch) must be absent from
 * the resulting branch diff so the branch content and the filed issue payload
 * stay aligned (see ADR 0066 / concern #2).
 *
 * Manifest and catalog entries are UNIONED onto the worktree's own (base
 * branch) copy via the same pure `mergeManifests`/`mergeCatalogs` helpers the
 * asset-pr consolidator uses, so a selective per-branch delta composes
 * correctly regardless of processing order downstream.
 */
async function copyArtSurface(
  srcRepoRoot: string,
  destRepoRoot: string,
  assets: readonly CheckinAsset[],
): Promise<void> {
  for (const asset of assets) {
    const relSegments = asset.assetPath.split('/');
    const src = path.join(srcRepoRoot, 'public', 'assets', ...relSegments);
    if (!existsSync(src)) continue;
    const dest = path.join(destRepoRoot, 'public', 'assets', ...relSegments);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  const manifestKeys = new Set(
    assets
      .map((asset) => asset.manifestKey)
      .filter((key): key is string => typeof key === 'string'),
  );
  if (manifestKeys.size === 0) return;

  const destManifestPath = path.join(destRepoRoot, MANIFEST_REL);
  const srcManifestPath = path.join(srcRepoRoot, MANIFEST_REL);
  const destManifest = readJsonSafe<GeneratedManifest>(destManifestPath, {
    version: 1,
    entries: {},
  });
  const srcManifest = readJsonSafe<GeneratedManifest>(srcManifestPath, { version: 1, entries: {} });
  const overlayEntries: Record<string, Record<string, unknown>> = {};
  for (const key of manifestKeys) {
    const entry = srcManifest.entries?.[key];
    if (entry !== undefined) overlayEntries[key] = entry;
  }
  const mergedManifest = mergeManifests(destManifest, {
    version: srcManifest.version,
    entries: overlayEntries,
  });
  mkdirSync(path.dirname(destManifestPath), { recursive: true });
  await writeCatalogJson(destManifestPath, mergedManifest);

  const destCatalogPath = path.join(destRepoRoot, CATALOG_REL);
  const srcCatalogPath = path.join(srcRepoRoot, CATALOG_REL);
  const destCatalog = readJsonSafe<CatalogEntry[]>(destCatalogPath, []);
  const srcCatalog = readJsonSafe<CatalogEntry[]>(srcCatalogPath, []);
  const catalogIds = new Set([...manifestKeys].map((key) => `generated:${key}`));
  const overlayCatalog = srcCatalog.filter(
    (entry) => typeof entry.id === 'string' && catalogIds.has(entry.id),
  );
  const mergedCatalog = mergeCatalogs(destCatalog, overlayCatalog);
  mkdirSync(path.dirname(destCatalogPath), { recursive: true });
  await writeCatalogJson(destCatalogPath, mergedCatalog);
}

function makeReadManifest(repoRoot: string): () => Promise<CheckinManifest> {
  return () => {
    const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      return Promise.resolve(JSON.parse(raw) as CheckinManifest);
    } catch {
      return Promise.resolve({});
    }
  };
}

/** One open `asset-checkin` issue's fields needed to build the queued-asset map. */
export interface QueuedIssueSource {
  readonly body: string;
  readonly issueUrl: string;
}

/**
 * Build the durable queued-asset map from open `asset-checkin` issues' raw
 * (body, url) pairs. Pure — no IO — so it is unit-testable without shelling
 * out to `gh`.
 *
 * A path already recorded by an earlier-processed issue is left untouched by
 * a later one: duplicate queued paths (e.g. historical data filed before the
 * process-wide mutation lock existed, or a malformed/duplicated payload)
 * must never silently overwrite each other via `Map.set()`, since that would
 * pick whichever issue happens to be processed last with no signal that a
 * conflicting duplicate was discarded. First-seen-wins instead; the
 * durable-queue conflict, if genuine, still surfaces the next time someone
 * tries to check in that same path (see `reconcileQueuedContent`).
 */
export function buildQueuedAssetMap(
  issues: readonly QueuedIssueSource[],
): ReadonlyMap<string, QueuedAssetCheckin> {
  const queued = new Map<string, QueuedAssetCheckin>();
  for (const issue of issues) {
    const payload = parseAssetIssueBody(issue.body);
    if (!payload) continue;
    for (const asset of payload.assets) {
      if (queued.has(asset.assetPath)) continue;
      queued.set(asset.assetPath, {
        issueUrl: issue.issueUrl,
        branch: payload.branch,
        ...(asset.contentHash !== undefined ? { contentHash: asset.contentHash } : {}),
      });
    }
  }
  return queued;
}

function makeListQueuedAssets(
  repoRoot: string,
): () => Promise<ReadonlyMap<string, QueuedAssetCheckin>> {
  return async () => {
    const result = await realExec(
      'gh',
      [
        'issue',
        'list',
        '--label',
        ASSET_CHECKIN_LABEL,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'body,url',
      ],
      { cwd: repoRoot },
    );
    if (result.code !== 0) {
      throw new CheckinError(
        'gh-failed',
        `Failed to list open ${ASSET_CHECKIN_LABEL} issues: ${result.stderr || result.stdout}`,
      );
    }

    let issues: unknown;
    try {
      issues = JSON.parse(result.stdout);
    } catch (error) {
      throw new CheckinError(
        'gh-failed',
        `Failed to parse open ${ASSET_CHECKIN_LABEL} issues: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!Array.isArray(issues)) {
      throw new CheckinError(
        'gh-failed',
        `Expected an array of open ${ASSET_CHECKIN_LABEL} issues.`,
      );
    }

    const sources: QueuedIssueSource[] = [];
    for (const issue of issues) {
      if (typeof issue !== 'object' || issue === null) continue;
      const body = (issue as { body?: unknown }).body;
      const issueUrl = (issue as { url?: unknown }).url;
      if (typeof body !== 'string' || typeof issueUrl !== 'string') continue;
      sources.push({ body, issueUrl });
    }
    return buildQueuedAssetMap(sources);
  };
}

/** Build the production `CheckinRunnerDeps` for a given repo root. */
export function createDefaultCheckinDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckinRunnerDeps {
  return {
    exec: realExec,
    copyArtSurface,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-checkin-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    readManifest: makeReadManifest(repoRoot),
    listQueuedAssets: makeListQueuedAssets(repoRoot),
    env,
  };
}
