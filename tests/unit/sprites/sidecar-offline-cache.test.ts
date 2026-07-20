/**
 * Route-level hard-gate: a warmed shared cache lets the sidecar serve listings
 * and briefs with Azure forced unavailable and ZERO remote read operations.
 *
 * Warms a run through a CachingRunStore over a LocalRunStore, then builds a
 * second sidecar whose CachingRunStore is `offline: true` over a throwing inner
 * store sharing the SAME physical cache dir, and asserts the routes still return
 * exact data without the inner store being touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { buildServer } from '../../../scripts/sprites/sidecar/server.js';
import { workflowBriefKey } from '../../../scripts/sprites/sidecar/workflow-state.js';
import { CachingRunStore } from '../../../scripts/sprites/store/caching-store.js';
import { SharedResourceCache } from '../../../scripts/sprites/store/shared-cache.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const noop = (): void => {};

/** Inner store whose every READ op throws + is counted (Azure unavailable). */
class ThrowingStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  reads = 0;
  async put(): Promise<void> {
    throw new Error('offline: put');
  }
  async get(key: string): Promise<Buffer> {
    this.reads++;
    throw new StoreNotFoundError(key);
  }
  async has(): Promise<boolean> {
    this.reads++;
    throw new Error('offline: has');
  }
  async list(): Promise<readonly string[]> {
    this.reads++;
    throw new Error('offline: list');
  }
  async remove(): Promise<void> {
    throw new Error('offline: remove');
  }
  resolve(key: string): string {
    return key;
  }
}

const BRIEF_ID = 'iron-sword';
const RUN_ID = '2026-06-04T12-00-00-abcdef12';
const BRIEF_REL = 'briefs/draft/iron-sword.yaml';

let repoRoot: string;
let runsDir: string;
let cacheDir: string;
let offlineInner: ThrowingStore;
let app: FastifyInstance;
let warmedListingResponse: unknown;
let warmedBriefResponse: unknown;
let warmedSliceMapResponse: unknown;

const newCache = (): SharedResourceCache =>
  new SharedResourceCache({ cacheDir, maxBytes: 0, log: noop });

beforeEach(async () => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'crawler-offline-repo-'));
  runsDir = path.join(repoRoot, 'generated', 'runs');
  cacheDir = mkdtempSync(path.join(tmpdir(), 'crawler-offline-cache-'));
  mkdirSync(runsDir, { recursive: true });

  // Worktree A has all source inputs needed to warm route-response snapshots.
  mkdirSync(path.join(repoRoot, 'briefs', 'draft'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'data', 'palettes'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'data', 'sprite-types'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'data', 'palettes', 'offline-pal.json'),
    '[[0,0,0],[255,255,255]]',
  );
  writeFileSync(
    path.join(repoRoot, 'data', 'sprite-types', 'weapon.json'),
    readFileSync(path.join(process.cwd(), 'data', 'sprite-types', 'weapon.json')),
  );
  writeFileSync(
    path.join(repoRoot, BRIEF_REL),
    [
      'type: weapon',
      'name: iron-sword',
      'description: a rusty iron sword',
      'size: { width: 16, height: 16 }',
      'palette: { id: offline-pal }',
      'anchor: { x: 8, y: 14 }',
      'references:',
      '  - { path: public/assets/ref-a.png }',
      '  - { path: public/assets/ref-b.png }',
    ].join('\n'),
  );

  // ── Warm phase (online) — populate the shared cache + a listing snapshot ──
  const warm = new CachingRunStore({
    inner: new LocalRunStore(runsDir),
    cache: newCache(),
  });
  await warm.put(
    `${BRIEF_ID}/${RUN_ID}/summary.json`,
    Buffer.from(
      JSON.stringify({ brief: BRIEF_ID, runId: RUN_ID, briefPath: BRIEF_REL, prompt: 'p' }),
    ),
  );
  const canonicalBrief = readFileSync(path.join(repoRoot, BRIEF_REL));
  await warm.put(workflowBriefKey(BRIEF_REL), canonicalBrief);
  writeFileSync(path.join(repoRoot, BRIEF_REL), 'name: branch-local-copy\n');
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(255);
  await warm.put(`${BRIEF_ID}/${RUN_ID}/sheet-00.png`, PNG.sync.write(png));
  await warm.list(''); // capture the listing snapshot at the current epoch
  const warmApp = buildServer({ repoRoot, runsDir, version: 'test', store: warm });
  await warmApp.ready();
  // Capture the exact run-listing response before deleting the source tree so
  // the offline test can assert byte-identical equality (not just subset presence).
  const listRes = await warmApp.inject({
    method: 'GET',
    url: '/api/storage/runs?scope=active',
  });
  expect(listRes.statusCode, listRes.body).toBe(200);
  warmedListingResponse = listRes.json();
  const briefRes = await warmApp.inject({
    method: 'GET',
    url: `/api/runs/${BRIEF_ID}/${RUN_ID}/brief`,
  });
  expect(briefRes.statusCode, briefRes.body).toBe(200);
  warmedBriefResponse = briefRes.json();
  const branchSliceRes = await warmApp.inject({
    method: 'GET',
    url: `/api/runs/${BRIEF_ID}/${RUN_ID}/slice-map`,
  });
  expect(branchSliceRes.statusCode).toBe(200);
  expect((branchSliceRes.json() as { emptyCellsApplied: boolean }).emptyCellsApplied).toBe(false);
  writeFileSync(path.join(repoRoot, BRIEF_REL), canonicalBrief);
  const sliceRes = await warmApp.inject({
    method: 'GET',
    url: `/api/runs/${BRIEF_ID}/${RUN_ID}/slice-map`,
  });
  expect(sliceRes.statusCode).toBe(200);
  warmedSliceMapResponse = sliceRes.json();
  await warmApp.close();

  // Worktree B has no brief, palette, type defaults, sheets, or summaries.
  rmSync(repoRoot, { recursive: true, force: true });
  mkdirSync(runsDir, { recursive: true });

  // ── Offline sidecar — Azure forced unavailable, SAME shared cache ─────────
  offlineInner = new ThrowingStore();
  const offlineStore = new CachingRunStore({
    inner: offlineInner,
    cache: newCache(),
    offline: true,
  });
  app = buildServer({ repoRoot, runsDir, version: 'test', store: offlineStore });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('sidecar offline hard-gate', () => {
  it('serves the run listing from the warmed snapshot with zero remote reads', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/storage/runs?scope=active' });
    expect(res.statusCode).toBe(200);
    // Assert the complete response matches the snapshot captured from the warm sidecar,
    // not just a partial subset check — per the PR hard gate contract.
    expect(res.json()).toEqual(warmedListingResponse);
    expect(offlineInner.reads).toBe(0);
  });

  it('serves the exact brief response without source-tree inputs or remote reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${BRIEF_ID}/${RUN_ID}/brief`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(warmedBriefResponse);
    expect((res.json() as { briefYaml: string }).briefYaml).toContain('name: iron-sword');
    expect((res.json() as { briefYaml: string }).briefYaml).not.toContain('branch-local-copy');
    expect(offlineInner.reads).toBe(0);
  });

  it('serves the exact slice-map response without source-tree inputs or remote reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${BRIEF_ID}/${RUN_ID}/slice-map`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(warmedSliceMapResponse);
    expect((res.json() as { emptyCellsApplied: boolean }).emptyCellsApplied).toBe(true);
    expect(offlineInner.reads).toBe(0);
  });
});
