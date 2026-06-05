/**
 * Sidecar server tests.
 *
 * Strategy: most routes are exercised via `app.inject()` against a server
 * built around a tmp runs directory — no socket open, no port races,
 * fast. The one exception is the "binds to 127.0.0.1 only" check, which
 * needs a real `listen()` to verify the bound address.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAnchorOverlay } from '../../../scripts/sprites/anchor-overlay.js';
import { buildServer, listRuns, safeJoin } from '../../../scripts/sprites/sidecar/server.js';
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
  });

  it('GET /api/runs lists the seeded run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].briefId).toBe('iron-sword');
    expect(body.runs[0].runId).toBe('2026-06-04T12-00-00-deadbeef');
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
    expect((addr.family as string | number) === 'IPv4' || (addr.family as string | number) === 4).toBe(true);
  });
});
