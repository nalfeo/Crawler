/**
 * Sidecar server tests.
 *
 * Strategy: most routes are exercised via `app.inject()` against a server
 * built around a tmp runs directory — no socket open, no port races,
 * fast. The one exception is the "binds to 127.0.0.1 only" check, which
 * needs a real `listen()` to verify the bound address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildAnchorOverlay } from '../../../scripts/sprites/anchor-overlay.js';
import { buildServer, listRuns, safeJoin } from '../../../scripts/sprites/sidecar/server.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { workflowBriefKey } from '../../../scripts/sprites/sidecar/workflow-state.js';
import type { AssetQueue, AssetRequest } from '../../../scripts/sprites/queue/types.js';
import type {
  WorkerController,
  WorkerControllerStatus,
  WorkerStartResult,
} from '../../../scripts/sprites/sidecar/worker-controller.js';
import type { IssueIngesterController } from '../../../scripts/sprites/sidecar/issue-ingester-controller.js';
import type { FastifyInstance } from 'fastify';

function writeMinimalRun(
  runsDir: string,
  briefId: string,
  runId: string,
  options: { withSummary?: boolean; withProcessed?: boolean; chosenIndex?: number } = {},
): string {
  const withSummary = options.withSummary !== false;
  const withProcessed = options.withProcessed !== false;
  const runDir = path.join(runsDir, briefId, runId);
  mkdirSync(path.join(runDir, 'processed'), { recursive: true });
  mkdirSync(path.join(runDir, 'raw'), { recursive: true });
  if (withSummary) {
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: briefId,
        runId,
        promptHash: 'deadbeef',
        chosen: { index: options.chosenIndex ?? 1 },
        candidates: [
          { index: 0, judgeScorecard: null },
          { index: 1, judgeScorecard: { passed: true, minScore: 4 } },
        ],
      }),
    );
  }
  if (withProcessed) {
    writeFileSync(
      path.join(runDir, 'processed', '00.anchor-overlay.png'),
      buildAnchorOverlay({ width: 16, height: 16, anchor: { x: 4, y: 12 } }),
    );
    writeFileSync(
      path.join(runDir, 'processed', '00.scorecard.json'),
      JSON.stringify({ score: 7, outOf: 7, passed: true, breakdown: [], derivedAnchor: null }),
    );
  }
  return runDir;
}

function makeSolidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('safeJoin (path-traversal guard)', () => {
  const base = path.resolve('/tmp/runs');

  it('accepts a normal nested file path', () => {
    expect(safeJoin(base, ['iron-sword', '2026-06-04T12-00-00-abcdef12', 'summary.json'])).toBe(
      path.resolve('/tmp/runs/iron-sword/2026-06-04T12-00-00-abcdef12/summary.json'),
    );
  });

  it('rejects a `..` traversal segment', () => {
    expect(safeJoin(base, ['..', 'etc', 'passwd'])).toBeNull();
    expect(safeJoin(base, ['iron-sword', '..', '..', 'etc'])).toBeNull();
  });

  it('rejects forward and backslash separators inside a single segment', () => {
    expect(safeJoin(base, ['iron-sword', '../etc'])).toBeNull();
    expect(safeJoin(base, ['iron-sword', '..\\etc'])).toBeNull();
    expect(safeJoin(base, ['iron-sword', 'a/b'])).toBeNull();
  });

  it('rejects absolute-path segments', () => {
    expect(safeJoin(base, ['/etc/passwd'])).toBeNull();
    expect(safeJoin(base, ['C:\\Windows\\System32'])).toBeNull();
  });

  it('rejects NUL bytes', () => {
    expect(safeJoin(base, ['iron-sword\0', 'summary.json'])).toBeNull();
  });

  it('rejects empty/dot segments that would resolve to base itself', () => {
    expect(safeJoin(base, [''])).toBeNull();
    expect(safeJoin(base, ['.'])).toBeNull();
  });
});

describe('listRuns', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list when the runs dir does not exist', () => {
    expect(listRuns(path.join(root, 'nope'))).toEqual([]);
  });

  it('enumerates runs across briefs, newest-first by runId', () => {
    const runsDir = path.join(root, 'runs');
    writeMinimalRun(runsDir, 'iron-sword', '2026-06-04T11-00-00-aaaaaaaa');
    writeMinimalRun(runsDir, 'iron-sword', '2026-06-04T12-00-00-bbbbbbbb', { chosenIndex: 2 });
    writeMinimalRun(runsDir, 'cloth-shirt', '2026-06-04T13-00-00-cccccccc');
    const out = listRuns(runsDir);
    expect(out.map((r) => r.runId)).toEqual([
      '2026-06-04T13-00-00-cccccccc',
      '2026-06-04T12-00-00-bbbbbbbb',
      '2026-06-04T11-00-00-aaaaaaaa',
    ]);
    const swordLatest = out.find((r) => r.runId === '2026-06-04T12-00-00-bbbbbbbb')!;
    expect(swordLatest.briefId).toBe('iron-sword');
    expect(swordLatest.chosenIndex).toBe(2);
    expect(swordLatest.candidateCount).toBe(2);
    expect(swordLatest.hasJudge).toBe(true);
    expect(swordLatest.timestamp).toBe('2026-06-04T12:00:00Z');
  });

  it('tolerates a run with no summary.json', () => {
    const runsDir = path.join(root, 'runs');
    writeMinimalRun(runsDir, 'iron-sword', '2026-06-04T11-00-00-aaaaaaaa', { withSummary: false });
    const out = listRuns(runsDir);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateCount).toBeNull();
    expect(out[0]!.hasJudge).toBe(false);
  });

  it('skips entries that disappear between readdir/stat (race-safe)', () => {
    const runsDir = path.join(root, 'runs');
    writeMinimalRun(runsDir, 'iron-sword', '2026-06-04T11-00-00-aaaaaaaa');
    mkdirSync(path.join(runsDir, 'cloth-shirt'), { recursive: true });
    try {
      symlinkSync(
        path.join(root, 'missing-target'),
        path.join(runsDir, 'cloth-shirt', 'broken-run'),
      );
    } catch {
      // Some environments (notably Windows without privileges) disallow symlinks.
      // If so, skip this specific race-shape test.
      return;
    }

    const out = listRuns(runsDir);
    expect(out).toHaveLength(1);
    expect(out[0]!.runId).toBe('2026-06-04T11-00-00-aaaaaaaa');
  });
});

describe('buildServer routes (inject)', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-srv-'));
    const runsDir = path.join(root, 'runs');
    writeMinimalRun(runsDir, 'iron-sword', '2026-06-04T12-00-00-deadbeef');
    app = buildServer({ repoRoot: root, runsDir, version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/health returns ok with deps echoed back', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('test');
    expect(body.runsDir).toContain('runs');
    expect(body.storeBackend).toBe('local');
    expect(body.queueBackend).toBe('noop');
    expect(body.issueIngester).toMatchObject({ running: false });
  });

  it('CORS allows loopback origins only', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:3002' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3002');

    const blocked = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET /api/runs lists the seeded run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].briefId).toBe('iron-sword');
    expect(body.runs[0].runId).toBe('2026-06-04T12-00-00-deadbeef');
  });

  it('GET /api/runs marks promoted runs from Azure-style sourceRun paths', async () => {
    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(
      path.join(generatedDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'iron-sword-var-1': {
            sourceRun: path.join(
              root,
              'tmp',
              'azure-hydration',
              'iron-sword',
              '2026-06-04T12-00-00-deadbeef',
            ),
          },
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/runs?promoted=promoted' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      briefId: 'iron-sword',
      runId: '2026-06-04T12-00-00-deadbeef',
      promotionState: 'promoted',
    });
  });

  it('GET /api/workflow/latest-run returns 400 when requestedAt is invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workflow/latest-run?briefId=iron-sword&requestedAt=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'bad-request',
      message: 'requestedAt must be a valid ISO timestamp',
    });
  });

  it('GET /api/workflow/latest-run includes runs from the same second as requestedAt', async () => {
    writeMinimalRun(path.join(root, 'runs'), 'iron-sword', '2026-06-04T12-00-00-feedface');
    writeMinimalRun(path.join(root, 'runs'), 'cloth-shirt', '2026-06-04T12-00-59-c0ffee00');
    const res = await app.inject({
      method: 'GET',
      url: '/api/workflow/latest-run?briefId=iron-sword&requestedAt=2026-06-04T12:00:00.500Z',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      run: {
        briefId: 'iron-sword',
        runId: '2026-06-04T12-00-00-feedface',
        timestamp: '2026-06-04T12:00:00Z',
      },
    });
  });

  it('GET /api/runs/:brief/:run returns the parsed summary.json', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.promptHash).toBe('deadbeef');
    expect(body.chosen.index).toBe(1);
  });

  it('GET /api/runs/:brief/:run returns 404 for a missing run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/runs/:brief/:run returns 403 when params attempt traversal', async () => {
    // safeJoin rejects `..` outright. Returning 403 mirrors the
    // static-file route so probes are distinguishable from "missing run".
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/..%2F..%2Fetc/run',
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/runs/:brief/:run/sheets lists source sheet PNGs', async () => {
    const runDir = path.join(root, 'runs', 'iron-sword', '2026-06-04T12-00-00-deadbeef');
    writeFileSync(path.join(runDir, 'sheet-00.png'), Buffer.from('PNG-SHEET-00'));
    writeFileSync(path.join(runDir, 'sheet-01.png'), Buffer.from('PNG-SHEET-01'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/sheets',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual(['sheet-00.png', 'sheet-01.png']);
  });

  it('GET /api/runs/:brief/:run/slice-map uses canonical v2 and defaults to latest sheet', async () => {
    const runId = '2026-06-04T12-00-00-deadbeef';
    const runDir = path.join(root, 'runs', 'iron-sword', runId);
    mkdirSync(path.join(root, 'briefs'), { recursive: true });
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      '[[0,0,0],[255,255,255]]',
    );
    writeFileSync(
      path.join(root, 'briefs', 'iron-sword.yaml'),
      [
        'type: weapon',
        'name: iron-sword',
        'description: iron sword',
        'size: { width: 16, height: 16 }',
        'palette: { id: kenney-roguelike }',
        'anchor: { x: 8, y: 14 }',
        'references:',
        '  - { path: public/assets/ref-a.png }',
        '  - { path: public/assets/ref-b.png }',
      ].join('\n'),
    );
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: 'iron-sword',
        runId,
        briefPath: 'briefs/iron-sword.yaml',
        promptHash: 'deadbeef',
        chosen: { index: 0 },
        candidates: [{ index: 0, judgeScorecard: null }],
      }),
    );
    writeFileSync(path.join(runDir, 'sheet-00.png'), makeSolidPng(12, 12, [255, 255, 255]));
    writeFileSync(path.join(runDir, 'sheet-01.png'), makeSolidPng(14, 10, [255, 255, 255]));

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/iron-sword/${runId}/slice-map`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.algorithm).toBe('content-aware');
    expect(body.sheetFile).toBe('sheet-01.png');
    expect(body.sheetW).toBe(14);
    expect(body.sheetH).toBe(10);
  });

  it('GET /api/runs/:brief/:run/slice-map supports explicit ?sheet= selection', async () => {
    const runId = '2026-06-04T12-00-00-deadbeef';
    const runDir = path.join(root, 'runs', 'iron-sword', runId);
    mkdirSync(path.join(root, 'briefs'), { recursive: true });
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      '[[0,0,0],[255,255,255]]',
    );
    writeFileSync(
      path.join(root, 'briefs', 'iron-sword.yaml'),
      [
        'type: weapon',
        'name: iron-sword',
        'description: iron sword',
        'size: { width: 16, height: 16 }',
        'palette: { id: kenney-roguelike }',
        'anchor: { x: 8, y: 14 }',
        'references:',
        '  - { path: public/assets/ref-a.png }',
        '  - { path: public/assets/ref-b.png }',
      ].join('\n'),
    );
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: 'iron-sword',
        runId,
        briefPath: 'briefs/iron-sword.yaml',
        promptHash: 'deadbeef',
        chosen: { index: 0 },
        candidates: [{ index: 0, judgeScorecard: null }],
      }),
    );
    writeFileSync(path.join(runDir, 'sheet-00.png'), makeSolidPng(9, 11, [255, 255, 255]));
    writeFileSync(path.join(runDir, 'sheet-01.png'), makeSolidPng(13, 7, [255, 255, 255]));

    const selected = await app.inject({
      method: 'GET',
      url: `/api/runs/iron-sword/${runId}/slice-map?sheet=sheet-00.png`,
    });
    expect(selected.statusCode).toBe(200);
    const selectedBody = selected.json();
    expect(selectedBody.algorithm).toBe('content-aware');
    expect(selectedBody.sheetFile).toBe('sheet-00.png');
    expect(selectedBody.sheetW).toBe(9);
    expect(selectedBody.sheetH).toBe(11);

    const badSheetName = await app.inject({
      method: 'GET',
      url: `/api/runs/iron-sword/${runId}/slice-map?sheet=not-allowed.png`,
    });
    expect(badSheetName.statusCode).toBe(415);
  });

  it('slice-map degrades to 200 with emptyCellsApplied:false when the brief is gone', async () => {
    // A run whose gitignored draft brief was wiped and never mirrored: the brief
    // is absent from BOTH disk and the store. The debugger must still get a slice
    // map (200) so it can render the pre-baked pipeline — just flagged degraded so
    // the client stops trusting cell indices.
    const runId = '2026-07-03T00-02-09-e362a01d';
    const runDir = path.join(root, 'runs', 'tile-corridor-v1', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: 'tile-corridor-v1',
        runId,
        briefPath: 'briefs/draft/tiles/tile-corridor.yaml',
        promptHash: 'e362a01d',
        chosen: { index: 0 },
        candidates: [{ index: 0, judgeScorecard: null }],
      }),
    );
    writeFileSync(path.join(runDir, 'sheet-00.png'), makeSolidPng(16, 16, [255, 255, 255]));

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/tile-corridor-v1/${runId}/slice-map`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emptyCellsApplied).toBe(false);
    expect(body.algorithm).toBe('content-aware');
    // Degraded mode cannot honour emptyCells, so no cell is flagged empty (-1).
    expect(body.cells.every((c: { index: number }) => c.index !== -1)).toBe(true);
  });

  it('slice-map loads the brief (emptyCellsApplied:true) resolving palette against repoRoot, not cwd', async () => {
    // Regression guard for the latent projectRoot bug: the handler must resolve
    // palette / type-defaults against deps.repoRoot. We use a palette id that
    // exists ONLY under the temp repo root (absent from the real repo cwd), so
    // WITHOUT `{ projectRoot }` the palette loader reads cwd, throws, and degrades
    // (emptyCellsApplied:false); WITH it the brief loads and we get true.
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'iso-projroot-pal.json'),
      '[[0,0,0],[255,255,255]]',
    );
    // Copy the real weapon type-defaults so the minimal brief validates under the
    // temp root (defaults=null would drop required fields the strict schema needs).
    writeFileSync(
      path.join(root, 'data', 'sprite-types', 'weapon.json'),
      readFileSync(path.join(process.cwd(), 'data', 'sprite-types', 'weapon.json'), 'utf8'),
    );
    mkdirSync(path.join(root, 'briefs'), { recursive: true });
    writeFileSync(
      path.join(root, 'briefs', 'iso-weapon.yaml'),
      [
        'type: weapon',
        'name: iso-weapon',
        'description: isolated projectRoot weapon',
        'size: { width: 16, height: 16 }',
        'palette: { id: iso-projroot-pal }',
        'anchor: { x: 8, y: 14 }',
        'references:',
        '  - { path: public/assets/ref-a.png }',
        '  - { path: public/assets/ref-b.png }',
      ].join('\n'),
    );
    const runId = '2026-06-04T12-00-00-abcdef01';
    const runDir = path.join(root, 'runs', 'iso-weapon', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: 'iso-weapon',
        runId,
        briefPath: 'briefs/iso-weapon.yaml',
        promptHash: 'abcdef01',
        chosen: { index: 0 },
        candidates: [{ index: 0, judgeScorecard: null }],
      }),
    );
    writeFileSync(path.join(runDir, 'sheet-00.png'), makeSolidPng(16, 16, [255, 255, 255]));

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/iso-weapon/${runId}/slice-map`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emptyCellsApplied).toBe(true);
  });

  it('GET /api/runs/:brief/:run/sheet/:filename serves sheet PNGs', async () => {
    const runDir = path.join(root, 'runs', 'iron-sword', '2026-06-04T12-00-00-deadbeef');
    const sheet = Buffer.from('PNG-SHEET');
    writeFileSync(path.join(runDir, 'sheet-00.png'), sheet);
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/sheet/sheet-00.png',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.toString()).toBe('PNG-SHEET');
  });

  it('GET /api/runs/:brief/:run/sheet/:filename rejects non-sheet filenames', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/sheet/not-allowed.png',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('unsupported-sheet-filename');
  });

  it('GET processed/:filename streams the PNG with correct mime', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/processed/00.anchor-overlay.png',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('GET processed/:filename returns 415 for an unsupported extension', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/processed/secret.env',
    });
    expect(res.statusCode).toBe(415);
  });

  it('GET processed/:filename returns 403 when filename attempts traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/processed/..%2F..%2Fsummary.json',
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET processed/:filename returns 403 when briefId attempts traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/..%2F..%2Fetc/run/processed/file.png',
    });
    // safeJoin rejects `..` outright -> 403, not 404.
    expect(res.statusCode).toBe(403);
  });

  it('GET processed/:filename returns 404 for an in-bounds but non-existent file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef/processed/99.png',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/workflow/synthesize validates body.name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('POST /api/workflow/synthesize rejects a non-string body.brief', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', brief: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toBe('body.brief must be a string when provided');
  });

  it('POST /api/workflow/synthesize rejects an unknown body.sizeVariant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', sizeVariant: 'huge' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toBe('body.sizeVariant must be one of default, wide, tall, large');
  });

  it('POST /api/workflow/synthesize accepts omitted floor and defaults to 1', async () => {
    // No floor in body — should fall through to name validation (not a floor error)
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    // Missing name → bad-request for name, not floor
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('body.name');
  });

  it('POST /api/workflow/synthesize rejects a non-integer floor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', floor: 1.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toContain('floor');
  });

  it('POST /api/workflow/synthesize rejects an out-of-range floor (> 20)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', floor: 21 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toContain('floor');
  });

  it('POST /api/workflow/synthesize rejects floor 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', floor: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toContain('floor');
  });

  it('POST /api/workflow/promote-brief validates required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/promote-brief',
      headers: { 'content-type': 'application/json' },
      payload: { sourceYamlPath: 'generated/brief-candidates/test/test-v1.yaml' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('POST /api/workflow/generate validates briefPath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('POST /api/workflow/generate enqueues work when a real queue backend is injected', async () => {
    mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
    writeFileSync(
      path.join(root, 'briefs', 'weapons', 'iron-sword.yaml'),
      'name: internal-iron-sword\n',
    );
    const enqueued: Array<{ kind: string; briefId: string; briefPath: string }> = [];
    await app.close();
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'runs'),
      version: 'test',
      queue: {
        backend: 'azure-queue',
        enqueue: async (request) => {
          if (request.kind !== 'brief-path') throw new Error('expected brief-path request');
          enqueued.push({
            kind: request.kind,
            briefId: request.briefId,
            briefPath: request.briefPath,
          });
        },
        dequeue: async () => null,
        peek: async () => [],
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { 'content-type': 'application/json' },
      payload: { briefPath: 'briefs/weapons/iron-sword.yaml' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
    expect(res.json().queueBackend).toBe('azure-queue');
    expect(enqueued).toHaveLength(1);
    expect(res.json().briefId).toBe('internal-iron-sword');
    expect(enqueued[0]?.briefId).toBe('internal-iron-sword');
    expect(enqueued[0]?.briefPath).toBe('briefs/weapons/iron-sword.yaml');
    expect(enqueued[0]?.kind).toBe('brief-path');
  });

  it('POST /api/workflow/metadata validates provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/metadata',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'invalid-provider' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
  });

  it('DELETE /api/runs/:brief/:run removes the run', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/runs/iron-sword/2026-06-04T12-00-00-deadbeef',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe('iron-sword/2026-06-04T12-00-00-deadbeef');
    expect(existsSync(path.join(root, 'runs', 'iron-sword', '2026-06-04T12-00-00-deadbeef'))).toBe(
      false,
    );
  });
});

describe('PUT /api/workflow/brief (manual brief edit)', () => {
  let root: string;
  let app: FastifyInstance;

  // A self-contained valid brief: supplies every field the schema needs so
  // loadBrief only has to resolve the palette from disk (written below).
  const validBriefYaml = [
    'type: weapon',
    'name: iron-sword',
    'size: { width: 16, height: 16 }',
    'palette:',
    '  id: kenney-roguelike',
    'anchor: { x: 8, y: 14 }',
    'tags: [sword, melee]',
    'prompt: |',
    '  An iron sword, pixel-art style, blade up-right.',
    'references:',
    "  - { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' }",
    "  - { path: 'public/assets/kenney/roguelike/spritesheet.png' }",
    '',
  ].join('\n');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-brief-'));
    const runsDir = path.join(root, 'runs');
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      JSON.stringify([
        [0, 0, 0],
        [255, 255, 255],
      ]),
    );
    app = buildServer({ repoRoot: root, runsDir, version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a missing yamlPath', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      payload: { yaml: validBriefYaml },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toBe('body.yamlPath must be a non-empty string');
  });

  it('rejects an empty yaml body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      payload: { yamlPath: 'briefs/draft/weapons/iron-sword.yaml', yaml: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toBe('body.yaml must be a non-empty string');
  });

  it('refuses to write outside briefs/**/*.yaml', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      payload: { yamlPath: 'src/devtools-main.ts', yaml: validBriefYaml },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad-request');
    expect(res.json().message).toBe('yamlPath must be a briefs/**/*.yaml file');
    // The unrelated file was never touched.
    expect(existsSync(path.join(root, 'src', 'devtools-main.ts'))).toBe(false);
  });

  it('rejects an invalid brief and rolls back to the prior content', async () => {
    const rel = 'briefs/draft/weapons/iron-sword.yaml';
    const abs = path.join(root, 'briefs', 'draft', 'weapons', 'iron-sword.yaml');
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, validBriefYaml, 'utf8');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      // BAD_NAME fails the brief name schema (must be kebab-case).
      payload: { yamlPath: rel, yaml: 'type: weapon\nname: BAD_NAME\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid-brief');
    // Rolled back: the prior valid content is still on disk.
    expect(readFileSync(abs, 'utf8')).toBe(validBriefYaml);
  });

  it('removes a freshly-written file when the first save is invalid', async () => {
    const rel = 'briefs/draft/weapons/brand-new.yaml';
    const abs = path.join(root, 'briefs', 'draft', 'weapons', 'brand-new.yaml');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      payload: { yamlPath: rel, yaml: 'type: weapon\nname: BAD_NAME\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid-brief');
    // No prior content existed, so the bad write is fully removed.
    expect(existsSync(abs)).toBe(false);
  });

  it('accepts a valid edit, persists it, and echoes the description', async () => {
    const rel = 'briefs/draft/weapons/iron-sword.yaml';
    const abs = path.join(root, 'briefs', 'draft', 'weapons', 'iron-sword.yaml');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflow/brief',
      headers: { 'content-type': 'application/json' },
      payload: { yamlPath: rel, yaml: validBriefYaml },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.yamlPath).toBe(rel);
    expect(body.description).toContain('An iron sword');
    expect(body.yaml).toBe(validBriefYaml);
    expect(readFileSync(abs, 'utf8')).toBe(validBriefYaml);
  });
});

describe('workflow-state endpoints (GET/PUT /api/workflow/state)', () => {
  let root: string;
  let runsDir: string;
  let app: FastifyInstance;

  const sampleState = {
    items: [
      {
        id: 'item-1',
        seq: 1,
        brief: 'Purple Potion Bottle',
        stage: 'candidates',
        chosenCandidatePath: 'briefs/draft/items/purple-potion/purple-potion-v1.yaml',
      },
    ],
    selectedId: 'item-1',
    nextSeq: 2,
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-wfstate-'));
    runsDir = path.join(root, 'runs');
    mkdirSync(runsDir, { recursive: true });
    app = buildServer({ repoRoot: root, runsDir, version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET returns {state:null, etag:null} when nothing is stored yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflow/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: null, etag: null });
  });

  it('PUT then GET round-trips the state and is stable across reads', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.etag).toMatch(/^[0-9a-f]{64}$/);

    const get = await app.inject({ method: 'GET', url: '/api/workflow/state' });
    expect(get.statusCode).toBe(200);
    expect(get.json().state).toEqual(sampleState);
    // Same bytes -> same content-hash ETag on every read.
    expect(get.json().etag).toBe(putBody.etag);
  });

  it('persisted blob lives under workflow-state/ and never pollutes /api/runs', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    // The blob exists on disk under the workflow-state/ prefix...
    expect(existsSync(path.join(runsDir, 'workflow-state', 'queue.json'))).toBe(true);
    // ...but the run listing (which only matches <brief>/<run>/summary.json) ignores it.
    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.json().runs).toEqual([]);
  });

  it('accepts a write whose If-Match equals the current ETag and rotates the ETag', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    const firstEtag = first.json().etag as string;

    const second = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json', 'if-match': firstEtag },
      payload: { state: { ...sampleState, nextSeq: 3 } },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().etag).not.toBe(firstEtag);
  });

  it('rejects a stale If-Match with 409 and reports the current ETag', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    const currentEtag = first.json().etag as string;

    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json', 'if-match': 'stale-etag' },
      payload: { state: { ...sampleState, nextSeq: 99 } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('etag-conflict');
    expect(conflict.json().etag).toBe(currentEtag);

    // The conflicting write must NOT have mutated the stored state.
    const get = await app.inject({ method: 'GET', url: '/api/workflow/state' });
    expect(get.json().state).toEqual(sampleState);
  });

  it('treats If-Match:* as "must already exist"', async () => {
    const onEmpty = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      payload: { state: sampleState },
    });
    expect(onEmpty.statusCode).toBe(409);

    await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    const onExisting = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      payload: { state: { ...sampleState, nextSeq: 4 } },
    });
    expect(onExisting.statusCode).toBe(200);
  });

  it('does an unconditional last-writer-wins overwrite when If-Match is omitted', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: sampleState },
    });
    const overwrite = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: { items: [], selectedId: null, nextSeq: 9 } },
    });
    expect(overwrite.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/workflow/state' });
    expect(get.json().state).toEqual({ items: [], selectedId: null, nextSeq: 9 });
  });

  it('rejects a missing or non-object body.state with 400', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('bad-request');

    const nullState = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: null },
    });
    expect(nullState.statusCode).toBe(400);

    const primitive = await app.inject({
      method: 'PUT',
      url: '/api/workflow/state',
      headers: { 'content-type': 'application/json' },
      payload: { state: 'not-an-object' },
    });
    expect(primitive.statusCode).toBe(400);
  });
});

describe('workflow brief durability (Phase 2 re-materialise / mirror)', () => {
  let root: string;
  let runsDir: string;
  let store: LocalRunStore;
  let app: FastifyInstance;

  // A queue stub that records enqueues and reports the azure backend so the
  // generate handler enqueues (202) instead of running a real generation.
  let enqueued: AssetRequest[];
  function makeQueueStub(): AssetQueue {
    return {
      backend: 'azure-queue',
      enqueue: async (request) => {
        enqueued.push(request);
      },
      dequeue: async () => null,
      peek: async () => [],
    };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-briefdur-'));
    runsDir = path.join(root, 'runs');
    mkdirSync(runsDir, { recursive: true });
    store = new LocalRunStore(runsDir);
    enqueued = [];
    app = buildServer({
      repoRoot: root,
      runsDir,
      version: 'test',
      env: {},
      store,
      queue: makeQueueStub(),
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('promote-brief re-materialises a wiped source candidate from the store', async () => {
    // Seed the store with a candidate whose local draft copy was "wiped"
    // (never written to disk), mimicking a worktree checkpoint.
    const sourceRel = 'briefs/draft/items/purple-potion/purple-potion-v1.yaml';
    const yaml = 'name: purple-potion\ntype: item\n';
    await store.put(workflowBriefKey(sourceRel), Buffer.from(yaml, 'utf8'));
    expect(existsSync(path.join(root, sourceRel))).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/promote-brief',
      headers: { 'content-type': 'application/json' },
      payload: { sourceYamlPath: sourceRel, type: 'item', name: 'purple-potion' },
    });
    expect(res.statusCode).toBe(200);
    const destRel = res.json().briefPath as string;
    expect(destRel).toBe('briefs/draft/items/purple-potion.yaml');
    // The dest brief now exists on disk with the recovered content...
    expect(readFileSync(path.join(root, destRel), 'utf8')).toBe(yaml);
    // ...and the promoted brief was itself mirrored into the store so a later
    // generate survives a subsequent wipe.
    expect(await store.has(workflowBriefKey(destRel))).toBe(true);
  });

  it('promote-brief 404s when neither the disk nor the store has the source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/promote-brief',
      headers: { 'content-type': 'application/json' },
      payload: {
        sourceYamlPath: 'briefs/draft/items/ghost/ghost-v1.yaml',
        type: 'item',
        name: 'ghost',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('source-not-found');
  });

  it('promote-brief mirrors the promoted brief even when the source is on disk', async () => {
    const sourceRel = 'briefs/draft/items/blue-gem/blue-gem-v1.yaml';
    const sourceAbs = path.join(root, sourceRel);
    mkdirSync(path.dirname(sourceAbs), { recursive: true });
    const yaml = 'name: blue-gem\ntype: item\n';
    writeFileSync(sourceAbs, yaml);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/promote-brief',
      headers: { 'content-type': 'application/json' },
      payload: { sourceYamlPath: sourceRel, type: 'item', name: 'blue-gem' },
    });
    expect(res.statusCode).toBe(200);
    const destRel = res.json().briefPath as string;
    expect(await store.has(workflowBriefKey(destRel))).toBe(true);
    expect((await store.get(workflowBriefKey(destRel))).toString('utf8')).toBe(yaml);
  });

  it('generate re-materialises a wiped brief from the store before enqueuing', async () => {
    const briefRel = 'briefs/draft/items/red-sword/red-sword.yaml';
    const yaml = 'name: red-sword\ntype: item\n';
    await store.put(workflowBriefKey(briefRel), Buffer.from(yaml, 'utf8'));
    expect(existsSync(path.join(root, briefRel))).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { 'content-type': 'application/json' },
      payload: { briefPath: briefRel },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.briefId).toBe('red-sword');
    // The brief was restored to disk so the worker can read it...
    expect(existsSync(path.join(root, briefRel))).toBe(true);
    // ...and exactly one enqueue happened, pointing at the restored brief.
    expect(enqueued).toHaveLength(1);
    const queued = enqueued[0];
    expect(queued?.kind).toBe('brief-path');
    if (!queued || queued.kind !== 'brief-path') {
      throw new Error('expected brief-path request');
    }
    expect(queued.briefPath).toBe(briefRel);
  });

  it('generate 404s when the brief is missing from both disk and store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { 'content-type': 'application/json' },
      payload: { briefPath: 'briefs/draft/items/nope/nope.yaml' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('brief-not-found');
    expect(enqueued).toHaveLength(0);
  });

  it('generate mirrors an on-disk brief into the store (prevention)', async () => {
    // The brief is present on disk but NOT yet in the store. Generating must
    // mirror it so a later checkpoint wipe stays recoverable.
    const briefRel = 'briefs/draft/items/green-axe/green-axe.yaml';
    const briefAbs = path.join(root, briefRel);
    mkdirSync(path.dirname(briefAbs), { recursive: true });
    const yaml = 'name: green-axe\ntype: item\n';
    writeFileSync(briefAbs, yaml);
    expect(await store.has(workflowBriefKey(briefRel))).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { 'content-type': 'application/json' },
      payload: { briefPath: briefRel },
    });
    expect(res.statusCode).toBe(202);
    expect(await store.has(workflowBriefKey(briefRel))).toBe(true);
    expect((await store.get(workflowBriefKey(briefRel))).toString('utf8')).toBe(yaml);
  });

  it('postprocess 404s when the brief is missing from both disk and store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/postprocess',
      headers: { 'content-type': 'application/json' },
      payload: {
        briefPath: 'briefs/draft/tiles/nope.yaml',
        rawPng: makeSolidPng(16, 16, [255, 255, 255]).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('brief-not-found');
  });

  it('postprocess re-materialises a wiped brief from the store and runs the pipeline', async () => {
    const briefRel = 'briefs/draft/weapons/rusty-dagger.yaml';
    const briefAbs = path.join(root, briefRel);
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      '[[0,0,0],[255,255,255]]',
    );
    writeFileSync(
      path.join(root, 'data', 'sprite-types', 'weapon.json'),
      readFileSync(path.join(process.cwd(), 'data', 'sprite-types', 'weapon.json'), 'utf8'),
    );
    const yaml = [
      'type: weapon',
      'name: rusty-dagger',
      'description: a rusty dagger',
      'size: { width: 16, height: 16 }',
      'palette: { id: kenney-roguelike }',
      'anchor: { x: 8, y: 14 }',
      'references:',
      '  - { path: public/assets/ref-a.png }',
      '  - { path: public/assets/ref-b.png }',
      '',
    ].join('\n');
    // Only in the store — the local (gitignored) draft copy was "wiped".
    await store.put(workflowBriefKey(briefRel), Buffer.from(yaml, 'utf8'));
    expect(existsSync(briefAbs)).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/postprocess',
      headers: { 'content-type': 'application/json' },
      payload: {
        briefPath: briefRel,
        rawPng: makeSolidPng(16, 16, [255, 255, 255]).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.finalPng).toBe('string');
    expect(Array.isArray(body.steps)).toBe(true);
    // The brief was restored to disk as a side effect of recovery.
    expect(existsSync(briefAbs)).toBe(true);
  });
});

describe('POST /api/runs/:briefId/:runId/approve', () => {
  let root: string;
  let runsDir: string;
  let publicAssetsDir: string;
  let manifestPath: string;
  let app: FastifyInstance;
  const briefId = 'iron-sword';
  const runId = '2026-06-08T12-00-00-deadbeef';

  function writeFullRun(): void {
    const runDir = path.join(runsDir, briefId, runId);
    mkdirSync(path.join(runDir, 'processed'), { recursive: true });
    writeFileSync(path.join(runDir, 'processed', '01.png'), Buffer.from('PNG-01'));
    writeFileSync(
      path.join(runDir, 'processed', '01.scorecard.json'),
      JSON.stringify({ score: 7, outOf: 7, passed: true, breakdown: [], derivedAnchor: null }),
    );
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        brief: briefId,
        runId,
        promptHash: 'deadbeef',
        candidates: [
          {
            index: 0,
            score: 6,
            outOf: 7,
            passed: false,
            combinedPassed: false,
            derivedAnchor: null,
            judgeScorecard: null,
          },
          {
            index: 1,
            score: 7,
            outOf: 7,
            passed: true,
            combinedPassed: true,
            derivedAnchor: null,
            judgeScorecard: { passed: true, minScore: 4 },
          },
        ],
        chosen: {
          index: 1,
          score: 7,
          outOf: 7,
          passed: true,
          combinedPassed: true,
          anchor: { x: 8, y: 13, source: 'brief' },
          judgeScorecard: { passed: true, minScore: 4 },
        },
      }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-approve-srv-'));
    runsDir = path.join(root, 'runs');
    publicAssetsDir = path.join(root, 'public', 'assets');
    manifestPath = path.join(publicAssetsDir, 'generated', 'manifest.json');
    writeFullRun();
    app = buildServer({
      repoRoot: root,
      runsDir,
      version: 'test',
      publicAssetsDir,
      manifestPath,
      // Inject an env without CI so the test doesn't accidentally hit the
      // CI refusal when run on a CI host.
      env: {},
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('approves a valid variant: writes the PNG and returns the manifest entry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.briefId).toBe(briefId);
    expect(body.variantIndex).toBe(1);
    expect(body.assetPath).toBe(`generated/${briefId}-var-1.png`);
    expect(body.sensorScore).toBe('7/7');
    expect(body.judgeScore).toBe('4');

    // The asset was actually copied to the public dir.
    const assetAbs = path.join(publicAssetsDir, 'generated', `${briefId}-var-1.png`);
    expect(readFileSync(assetAbs).toString()).toBe('PNG-01');
    // Manifest was created on disk too.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.entries[`${briefId}-var-1`].variantIndex).toBe(1);
  });

  it('approves using the injected store even when runsDir has no local run', async () => {
    await app.close();
    const remoteStore = new LocalRunStore(runsDir);
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'missing-runs'),
      version: 'test',
      publicAssetsDir,
      manifestPath,
      env: {},
      store: {
        backend: 'azure-blob',
        put: async (key, data) => remoteStore.put(key, data),
        get: async (key) => remoteStore.get(key),
        has: async (key) => remoteStore.has(key),
        list: async (prefix) => remoteStore.list(prefix),
        remove: async (key) => remoteStore.remove(key),
        resolve: (key) => remoteStore.resolve(key),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(
      readFileSync(path.join(publicAssetsDir, 'generated', `${briefId}-var-1.png`), 'utf8'),
    ).toBe('PNG-01');
    expect(existsSync(path.join(root, 'missing-runs', briefId, runId))).toBe(false);
  });

  it('refuses with 403 when process.env.CI is set', async () => {
    // Build a fresh app with CI in the env snapshot.
    await app.close();
    app = buildServer({
      repoRoot: root,
      runsDir,
      version: 'test',
      publicAssetsDir,
      manifestPath,
      env: { CI: 'true' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ci-refused');
    // No asset should have been written.
    expect(existsSync(path.join(publicAssetsDir, 'generated', `${briefId}.png`))).toBe(false);
  });

  it('returns 403 when briefId attempts traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/..%2F..%2Fetc/run/approve',
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 0 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when the variant index does not exist in summary.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 99 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('variant-not-found');
  });

  it('returns 404 when the run directory has no summary.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/does-not-exist/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 0 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('run-not-found');
  });

  it('returns 400 when variantIndex is missing or not a non-negative integer', async () => {
    const noBody = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(noBody.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: -1 },
    });
    expect(negative.statusCode).toBe(400);

    const stringy = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: '1' },
    });
    expect(stringy.statusCode).toBe(400);
  });

  it('deletes using the injected remote store backend', async () => {
    await app.close();
    // Use a LocalRunStore as a test double for the remote Azure store
    const injectedStore = new LocalRunStore(runsDir);
    const removeCalls: string[] = [];
    // Write the run to the injected store
    writeFullRun();
    app = buildServer({
      repoRoot: root,
      // Use a non-existent local runsDir to verify deletion operates through
      // the injected remote store, not the local filesystem.
      runsDir: path.join(root, 'unused-runs-dir'),
      version: 'test',
      publicAssetsDir,
      manifestPath,
      env: {},
      store: {
        backend: 'azure-blob',
        put: async (key, data) => injectedStore.put(key, data),
        get: async (key) => injectedStore.get(key),
        has: async (key) => injectedStore.has(key),
        list: async (prefix) => injectedStore.list(prefix),
        remove: async (key) => {
          removeCalls.push(key);
          await injectedStore.remove(key);
        },
        resolve: (key) => injectedStore.resolve(key),
      },
    });

    // Confirm the run exists in the injected store
    const beforeKeys = await injectedStore.list(`${briefId}/${runId}/`);
    expect(beforeKeys.length).toBeGreaterThan(0);

    // DELETE the run
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/runs/${briefId}/${runId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(`${briefId}/${runId}`);

    // Confirm the run was removed from the injected store
    const afterKeys = await injectedStore.list(`${briefId}/${runId}/`);
    expect(afterKeys.length).toBe(0);
    expect(removeCalls).toEqual(expect.arrayContaining([...beforeKeys]));
    expect(removeCalls).not.toContain(`${briefId}/${runId}`);
  });

  it('cleans hydrated temp dir when remote get fails mid-hydration', async () => {
    await app.close();
    const throwingStore = new LocalRunStore(runsDir);
    const failingKey = `${briefId}/${runId}/processed/01.png`;
    const beforeTemp = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith('crawler-sidecar-run-')),
    );
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'missing-runs'),
      version: 'test',
      publicAssetsDir,
      manifestPath,
      env: {},
      store: {
        backend: 'azure-blob',
        put: async (key, data) => throwingStore.put(key, data),
        get: async (key) => {
          if (key === failingKey) {
            throw new Error('simulated-store-read-failure');
          }
          return throwingStore.get(key);
        },
        has: async (key) => throwingStore.has(key),
        list: async (prefix) => throwingStore.list(prefix),
        remove: async (key) => throwingStore.remove(key),
        resolve: (key) => throwingStore.resolve(key),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 1 },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('approve-failed');

    const afterTemp = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith('crawler-sidecar-run-')),
    );
    const leaked = [...afterTemp].filter((entry) => !beforeTemp.has(entry));
    expect(leaked).toEqual([]);
  });

  it('rejects drive-rooted remote key fragments while hydrating', async () => {
    await app.close();
    const summaryJson = JSON.stringify({
      brief: briefId,
      runId,
      promptHash: 'deadbeef',
      chosen: { index: 1 },
      candidates: [{ index: 1, score: 7, outOf: 7 }],
    });
    const keys = [
      `${briefId}/${runId}/summary.json`,
      `${briefId}/${runId}/C:/sneaky/processed/01.png`,
      `${briefId}/${runId}/processed/01.scorecard.json`,
    ] as const;
    const requestedKeys: string[] = [];
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'missing-runs'),
      version: 'test',
      publicAssetsDir,
      manifestPath,
      env: {},
      store: {
        backend: 'azure-blob',
        put: async () => undefined,
        get: async (key) => {
          requestedKeys.push(key);
          if (key === `${briefId}/${runId}/summary.json`) return Buffer.from(summaryJson);
          if (key === `${briefId}/${runId}/processed/01.scorecard.json`) {
            return Buffer.from(
              JSON.stringify({
                score: 7,
                outOf: 7,
                passed: true,
                breakdown: [],
                derivedAnchor: null,
              }),
            );
          }
          throw new Error(`unexpected-get:${key}`);
        },
        has: async (key) => key === `${briefId}/${runId}/summary.json`,
        list: async (prefix) => (prefix === `${briefId}/${runId}/` ? keys : []),
        remove: async () => undefined,
        resolve: (key) => path.join(root, 'virtual-store', key),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${briefId}/${runId}/approve`,
      headers: { 'content-type': 'application/json' },
      payload: { variantIndex: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('processed-missing');
    expect(requestedKeys).not.toContain(`${briefId}/${runId}/C:/sneaky/processed/01.png`);
  });
});

describe('buildServer listen (binding)', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-bind-'));
    mkdirSync(path.join(root, 'runs'), { recursive: true });
    app = buildServer({ repoRoot: root, runsDir: path.join(root, 'runs'), version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds to 127.0.0.1 (not 0.0.0.0)', async () => {
    // Port 0 lets the OS pick a free port so the test never collides with
    // a real sidecar running on 3010. The binding host is the security
    // assertion; the port is incidental.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (typeof addr === 'string' || addr === null) {
      throw new Error(`unexpected address type: ${String(addr)}`);
    }
    expect(addr.address).toBe('127.0.0.1');
    // Node's AddressInfo.family is typed as a string ('IPv4'|'IPv6') in our
    // version but historically has been 4/6 — accept both shapes.
    expect(
      (addr.family as string | number) === 'IPv4' || (addr.family as string | number) === 4,
    ).toBe(true);
  });
});

describe('worker control endpoints (/api/workflow/worker/*)', () => {
  let root: string;
  let app: FastifyInstance;
  let worker: WorkerController;
  let issueIngester: IssueIngesterController;

  function makeFakeWorker(backend: 'noop' | 'azure-queue' = 'azure-queue'): WorkerController {
    let running = false;
    const snapshot = (): WorkerControllerStatus => ({
      running,
      backend,
      startedAt: running ? '2026-06-25T00:00:00.000Z' : null,
      stoppedAt: null,
      processed: 0,
      failed: 0,
      lastBriefId: null,
      lastEvent: null,
      lastEventAt: null,
      lastError: null,
    });
    return {
      start: vi.fn((): WorkerStartResult => {
        if (running) return { started: false, reason: 'already-running', status: snapshot() };
        running = true;
        return { started: true, reason: 'started', status: snapshot() };
      }),
      stop: vi.fn(async () => {
        running = false;
        return snapshot();
      }),
      status: () => snapshot(),
    };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-worker-'));
    worker = makeFakeWorker('azure-queue');
    issueIngester = {
      start: () => ({
        started: true,
        status: {
          running: true,
          startedAt: null,
          stoppedAt: null,
          lastPollAt: null,
          lastError: null,
          enqueued: 0,
          skippedDuplicate: 0,
          reclaimedStale: 0,
          enqueueCommentsPosted: 0,
          enqueueCommentErrors: 0,
          lastEnqueueCommentError: null,
        },
      }),
      stop: async () => ({
        running: false,
        startedAt: null,
        stoppedAt: null,
        lastPollAt: null,
        lastError: null,
        enqueued: 0,
        skippedDuplicate: 0,
        reclaimedStale: 0,
        enqueueCommentsPosted: 0,
        enqueueCommentErrors: 0,
        lastEnqueueCommentError: null,
      }),
      status: () => ({
        running: false,
        startedAt: null,
        stoppedAt: null,
        lastPollAt: null,
        lastError: null,
        enqueued: 0,
        skippedDuplicate: 0,
        reclaimedStale: 0,
        enqueueCommentsPosted: 0,
        enqueueCommentErrors: 0,
        lastEnqueueCommentError: null,
      }),
      pollOnce: async () => ({
        running: false,
        startedAt: null,
        stoppedAt: null,
        lastPollAt: null,
        lastError: null,
        enqueued: 0,
        skippedDuplicate: 0,
        reclaimedStale: 0,
        enqueueCommentsPosted: 0,
        enqueueCommentErrors: 0,
        lastEnqueueCommentError: null,
      }),
      listRequests: async () => [],
      rejectRequest: async () => null,
    };
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'runs'),
      version: 'test',
      queue: {
        backend: 'azure-queue',
        enqueue: async () => {},
        dequeue: async () => null,
        peek: async () => [],
      },
      worker,
      issueIngester,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/health includes the worker snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.worker).toMatchObject({ running: false, backend: 'azure-queue' });
  });

  it('POST /api/workflow/worker/start starts the worker', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/workflow/worker/start' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: true, reason: 'started' });
    expect(worker.start).toHaveBeenCalledTimes(1);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json().worker.running).toBe(true);
  });

  it('POST /api/workflow/worker/start is idempotent (already-running)', async () => {
    await app.inject({ method: 'POST', url: '/api/workflow/worker/start' });
    const again = await app.inject({ method: 'POST', url: '/api/workflow/worker/start' });
    expect(again.json()).toMatchObject({ started: false, reason: 'already-running' });
  });

  it('POST /api/workflow/worker/stop stops the worker', async () => {
    await app.inject({ method: 'POST', url: '/api/workflow/worker/start' });
    const res = await app.inject({ method: 'POST', url: '/api/workflow/worker/stop' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true, status: { running: false } });
    expect(worker.stop).toHaveBeenCalled();
  });

  it('GET /api/workflow/worker/status returns the current snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflow/worker/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: false, backend: 'azure-queue' });
  });

  it('GET /api/workflow/issues/status returns issue-ingester snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflow/issues/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: false });
  });

  it('GET /api/workflow/asset-requests returns issue-request manifest entries', async () => {
    const entry = {
      key: '42:abc',
      issueNumber: 42,
      fingerprint: 'abc',
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine handle.',
      state: 'pending' as const,
      claimedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      isOpen: true,
    };
    issueIngester.listRequests = vi.fn(async () => [entry]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/workflow/asset-requests?state=pending',
    });
    expect(res.statusCode).toBe(200);
    expect(issueIngester.listRequests).toHaveBeenCalledWith('pending');
    expect(res.json()).toEqual({ entries: [entry] });
  });

  it('POST /api/workflow/asset-requests/reject persists a permanent rejection marker', async () => {
    issueIngester.rejectRequest = vi.fn(async () => ({
      key: '42:abc',
      issueNumber: 42,
      fingerprint: 'abc',
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine handle.',
      state: 'rejected' as const,
      claimedAt: null,
      rejectedAt: '2026-06-29T00:00:00.000Z',
      rejectionReason: 'not needed this season',
      isOpen: true,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/asset-requests/reject',
      headers: { 'content-type': 'application/json' },
      payload: {
        issueNumber: 42,
        fingerprint: 'abc',
        reason: 'not needed this season',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(issueIngester.rejectRequest).toHaveBeenCalledWith({
      issueNumber: 42,
      fingerprint: 'abc',
      reason: 'not needed this season',
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().entry.state).toBe('rejected');
  });
});

describe('sidecar POST /api/checkin', () => {
  let root: string;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sidecar-checkin-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses with 403 when CI is set (local-only, like approve)', async () => {
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'runs'),
      version: 'test',
      env: { CI: 'true' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/checkin', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ci-refused' });
  });

  it('prepare checkin also refuses with 403 when CI is set', async () => {
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'runs'),
      version: 'test',
      env: { CI: 'true' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/checkin/prepare', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ci-refused' });
  });
});

describe('storage lifecycle + manual anchor endpoints', () => {
  let root: string;
  let runsDir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sidecar-storage-'));
    runsDir = path.join(root, 'runs');
    writeMinimalRun(runsDir, 'iron-sword', '2026-07-04T00-00-00-abc');
    app = buildServer({ repoRoot: root, runsDir, version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('archives and then lists runs under archive scope', async () => {
    const archiveRes = await app.inject({
      method: 'POST',
      url: '/api/storage/runs/archive',
      payload: { keys: ['iron-sword/2026-07-04T00-00-00-abc'] },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json()).toMatchObject({ archived: ['iron-sword/2026-07-04T00-00-00-abc'] });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/storage/runs?scope=archive',
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as { runs: Array<{ briefId: string; runId: string }> };
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      briefId: 'iron-sword',
      runId: '2026-07-04T00-00-00-abc',
    });
  });

  it('sets and clears run-level manual anchor artifacts', async () => {
    const setRes = await app.inject({
      method: 'POST',
      url: '/api/runs/iron-sword/2026-07-04T00-00-00-abc/manual-anchor',
      payload: { variantIndex: 0, x: 7, y: 11 },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json()).toMatchObject({
      status: 'set',
      manualAnchor: { variantIndex: 0, x: 7, y: 11, source: 'manual' },
    });

    const clearRes = await app.inject({
      method: 'POST',
      url: '/api/runs/iron-sword/2026-07-04T00-00-00-abc/manual-anchor',
      payload: { clear: true },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json()).toEqual({ status: 'cleared' });
  });
});

describe('storage run enrichment endpoint', () => {
  const RUN = '2026-07-04T00-00-00-abc';
  const RUN2 = '2026-07-05T00-00-00-def';
  let root: string;
  let runsDir: string;
  let app: FastifyInstance;

  const writeSummary = (
    dir: string,
    candidateCount: number,
    briefPath: string | undefined,
  ): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        candidates: Array.from({ length: candidateCount }, (_unused, index) => ({ index })),
        ...(briefPath ? { briefPath } : {}),
      }),
    );
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sidecar-enrich-'));
    runsDir = path.join(root, 'runs');

    // Active run with an on-disk brief and two sprite sheets (enrichment should
    // report the lowest-sorted one).
    const ironDir = path.join(runsDir, 'iron-sword', RUN);
    writeSummary(ironDir, 3, 'design/briefs/iron-sword.yaml');
    writeFileSync(path.join(ironDir, 'sheet-01.png'), makeSolidPng(16, 16, [10, 20, 30]));
    writeFileSync(path.join(ironDir, 'sheet-00.png'), makeSolidPng(16, 16, [30, 20, 10]));
    mkdirSync(path.join(root, 'design', 'briefs'), { recursive: true });
    writeFileSync(path.join(root, 'design', 'briefs', 'iron-sword.yaml'), 'id: iron-sword\n');

    // Second active run: no manifest entry, brief file missing on disk.
    writeSummary(path.join(runsDir, 'mithril-axe', RUN2), 1, 'design/briefs/mithril-axe.yaml');

    // Archived copy of the iron-sword run (summary only — no sheets served).
    writeSummary(
      path.join(runsDir, 'archive', 'iron-sword', RUN),
      3,
      'design/briefs/iron-sword.yaml',
    );

    // Manifest: two approved variants for iron-sword (indexes 0 and 2), both
    // sourced from RUN. firstApproved should be the lowest index (0).
    mkdirSync(path.join(root, 'public', 'assets', 'generated'), { recursive: true });
    writeFileSync(
      path.join(root, 'public', 'assets', 'generated', 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'iron-sword-var-2': {
            briefId: 'iron-sword',
            variantIndex: 2,
            sourceRun: `runs/iron-sword/${RUN}`,
          },
          'iron-sword-var-0': {
            briefId: 'iron-sword',
            variantIndex: 0,
            sourceRun: `runs/iron-sword/${RUN}`,
          },
        },
      }),
    );

    app = buildServer({ repoRoot: root, runsDir, version: 'test' });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('enriches active runs with sheet thumbnail, approved counts, and brief presence', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/runs/enrich',
      payload: {
        scope: 'active',
        runs: [
          { briefId: 'iron-sword', runId: RUN },
          { briefId: 'mithril-axe', runId: RUN2 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scope: string;
      enriched: Array<Record<string, unknown>>;
    };
    expect(body.scope).toBe('active');
    expect(body.enriched).toHaveLength(2);

    const iron = body.enriched.find((entry) => entry.briefId === 'iron-sword');
    expect(iron).toMatchObject({
      briefId: 'iron-sword',
      runId: RUN,
      variantCount: 3,
      sheetFile: 'sheet-00.png',
      approvedCount: 2,
      firstApproved: { runId: RUN, variantIndex: 0 },
      briefStored: true,
    });

    const mithril = body.enriched.find((entry) => entry.briefId === 'mithril-axe');
    expect(mithril).toMatchObject({
      briefId: 'mithril-axe',
      runId: RUN2,
      variantCount: 1,
      sheetFile: null,
      approvedCount: 0,
      firstApproved: null,
      briefStored: false,
    });
  });

  it('omits sheet thumbnails for archived runs but keeps approved + brief badges', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/runs/enrich',
      payload: { scope: 'archive', runs: [{ briefId: 'iron-sword', runId: RUN }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scope: string; enriched: Array<Record<string, unknown>> };
    expect(body.scope).toBe('archive');
    expect(body.enriched[0]).toMatchObject({
      briefId: 'iron-sword',
      runId: RUN,
      variantCount: 3,
      sheetFile: null,
      approvedCount: 2,
      firstApproved: { runId: RUN, variantIndex: 0 },
      briefStored: true,
    });
  });

  it('rejects an invalid scope with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/runs/enrich',
      payload: { scope: 'nonsense', runs: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad-request' });
  });

  it('rejects a non-array runs payload with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage/runs/enrich',
      payload: { scope: 'active', runs: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad-request' });
  });
});
