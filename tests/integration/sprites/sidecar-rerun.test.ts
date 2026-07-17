/**
 * Sidecar tests for the re-run endpoints:
 *   - POST /api/runs/:briefId/:runId/postprocess  (deterministic, CI-safe)
 *   - POST /api/runs/:briefId/:runId/judge        (LLM-as-judge, CI-refused)
 *
 * Strategy mirrors `sidecar-server.test.ts`: seed a real run via `generateOne`
 * into a tmp runs dir, then drive the routes with `app.inject()`. The judge
 * happy path (a real vision call) is covered at the `rerun.ts` layer with a
 * mock provider — here we pin the gates the sidecar owns (CI refusal, missing
 * vision config, request validation, run resolution).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../scripts/sprites/sidecar/server.js';
import { seedRun, type SeededRun } from '../../fixtures/sprites/seed-run.js';

let root: string;
let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv = {}): Promise<SeededRun> {
  root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-rerun-'));
  const seed = await seedRun({ repoRoot: root, runsDir: path.join(root, 'runs') });
  app = buildServer({ repoRoot: root, runsDir: path.join(root, 'runs'), version: 'test', env });
  return seed;
}

describe('POST /api/runs/:briefId/:runId/postprocess', () => {
  it('re-post-processes a stored run and resets judge verdicts', async () => {
    const seed = await setup();
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.sheetFile).toBe('sheet-00.png');
    expect(body.summary.runId).toBe(seed.runId);
    expect(body.summary.candidates).toHaveLength(4);
    for (const c of body.summary.candidates) {
      expect(c.judgeScorecard).toBeNull();
      expect(c.judgeSkipReason).toBeNull();
    }
  });

  it('rejects a non-string body.sheet with 400', async () => {
    const seed = await setup();
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: { sheet: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('maps an unsupported sheet filename to 415', async () => {
    const seed = await setup();
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: { sheet: 'foo.png' },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported-sheet-filename');
  });

  it('returns 404 for an unknown run', async () => {
    const seed = await setup();
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/no-such-run/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('run-not-found');
  });

  it('rejects out-of-range body.variantIndexes with 400', async () => {
    const seed = await setup();
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndexes: [999] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('variant-index-out-of-range');
  });

  it('persists manual-anchor + override profile metadata for replay', async () => {
    const seed = await setup();
    const baseline = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const chosenIndex = baseline.json().summary?.chosen?.index ?? 0;
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: { background: { colorToleranceSq: 4200, fringeToleranceSq: 12345 } },
        manualAnchor: { variantIndex: chosenIndex, x: 9, y: 14 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.postprocessOverrides?.appliedMode).toBe('replace');
    expect(body.summary.postprocessOverrides?.options?.background?.colorToleranceSq).toBe(4200);
    expect(body.summary.postprocessOverrides?.manualAnchor).toMatchObject({
      variantIndex: chosenIndex,
      x: 9,
      y: 14,
      source: 'manual',
    });
    expect(body.summary.chosen?.anchor?.source).toBe('manual');
  });

  it('accepts explicit false applyToAllVariants flags for manual anchor and facing payloads', async () => {
    const seed = await setup();
    const baseline = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const chosenIndex = baseline.json().summary?.chosen?.index ?? 0;
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: { background: { colorToleranceSq: 4200, fringeToleranceSq: 12345 } },
        manualAnchor: { variantIndex: chosenIndex, x: 9, y: 14, applyToAllVariants: false },
        facing: { variantIndex: chosenIndex, direction: 'left', applyToAllVariants: false },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.postprocessOverrides?.manualAnchor).toMatchObject({
      variantIndex: chosenIndex,
      x: 9,
      y: 14,
      source: 'manual',
    });
    expect(body.summary.postprocessOverrides?.manualAnchor?.applyToAllVariants).toBeUndefined();
    expect(body.summary.postprocessOverrides?.facing).toMatchObject({
      variantIndex: chosenIndex,
      direction: 'left',
    });
    expect(body.summary.postprocessOverrides?.facing?.applyToAllVariants).toBeUndefined();
  });

  it('clears persisted facing override when payload sets facing to null', async () => {
    const seed = await setup();
    const baseline = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const chosenIndex = baseline.json().summary?.chosen?.index ?? 0;
    const setFacing = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: { background: { colorToleranceSq: 4200, fringeToleranceSq: 12345 } },
        facing: { variantIndex: chosenIndex, direction: 'left' },
      },
    });
    expect(setFacing.statusCode).toBe(200);
    expect(setFacing.json().summary.postprocessOverrides?.facing?.direction).toBe('left');

    const clearFacing = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: { background: { colorToleranceSq: 4200, fringeToleranceSq: 12345 } },
        facing: null,
      },
    });
    expect(clearFacing.statusCode).toBe(200);
    expect(clearFacing.json().summary.postprocessOverrides?.facing).toBeNull();
  });

  it('persists weaponAnchor in summary.postprocessOverrides for editor rehydration', async () => {
    const seed = await setup();
    const baseline = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const chosenIndex = baseline.json().summary?.chosen?.index ?? 0;
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: { background: { colorToleranceSq: 4200, fringeToleranceSq: 12345 } },
        weaponAnchor: { variantIndex: chosenIndex, x: 42, y: 18 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.postprocessOverrides?.manualWeaponAnchor).toMatchObject({
      variantIndex: chosenIndex,
      x: 42,
      y: 18,
      source: 'manual',
    });
  });

  it('clears persisted weapon anchor when weaponAnchor is null in payload', async () => {
    const seed = await setup();
    const baseline = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const chosenIndex = baseline.json().summary?.chosen?.index ?? 0;
    // First set a weapon anchor.
    await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: {},
        weaponAnchor: { variantIndex: chosenIndex, x: 42, y: 18 },
      },
    });
    // Then clear it.
    const clearRes = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/postprocess`,
      headers: { 'content-type': 'application/json' },
      payload: {
        mode: 'replace',
        options: {},
        weaponAnchor: null,
      },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().summary.postprocessOverrides?.manualWeaponAnchor).toBeNull();
  });
});

describe('POST /api/runs/:briefId/:runId/judge', () => {
  it('refuses to run in CI (403)', async () => {
    const seed = await setup({ CI: 'true' });
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/judge`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ci-refused');
  });

  it('returns 400 vision-not-configured when no provider is available', async () => {
    const seed = await setup({}); // CI undefined, no Azure vision env
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/judge`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('vision-not-configured');
  });

  it('validates body.variantIndexes (400 before touching the provider)', async () => {
    const seed = await setup({});
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/${seed.runId}/judge`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndexes: [-1] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('returns 404 for an unknown run', async () => {
    const seed = await setup({});
    const res = await app!.inject({
      method: 'POST',
      url: `/api/runs/${seed.briefId}/no-such-run/judge`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('run-not-found');
  });
});
