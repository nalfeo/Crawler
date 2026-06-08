/**
 * Integration test for the engine-side manifest loader.
 *
 * Exercises the full chain:
 *   1. on-disk `manifest.json` (and its referenced PNGs)
 *   2. `fetchGeneratedSpriteRegistry` via a file-backed fetcher
 *   3. `preloadGeneratedSprites` against a recording loader
 *   4. assert the queued URLs resolve to the actual files we wrote
 *
 * Grounds the loader in real filesystem behaviour without booting Phaser.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchGeneratedSpriteRegistry,
  preloadGeneratedSprites,
} from '../../src/engine/generatedAssets/index.js';
import { GENERATED_MANIFEST_VERSION } from '../../src/shared/generated-assets.js';

const REPO_MANIFEST = path.resolve(__dirname, '../../public/assets/generated/manifest.json');

/**
 * File-backed fetcher: maps `/assets/...` URLs to files under
 * `<workspace>/assets/...`. Returns 404 for missing files so we can
 * exercise the soft-fail path with real disk semantics.
 */
function createFileFetcher(workspaceRoot: string): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // We only model `/assets/...` URLs.
    const rel = url.startsWith('/assets/') ? url.slice('/assets/'.length) : url;
    const abs = path.join(workspaceRoot, 'assets', rel);
    if (!existsSync(abs)) {
      return new Response('not found', { status: 404 });
    }
    const body = readFileSync(abs);
    const isJson = abs.endsWith('.json');
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': isJson ? 'application/json' : 'application/octet-stream' },
    });
  }) as unknown as typeof fetch;
}

describe('generated manifest -> engine chain (fixture)', () => {
  let workspace: string;
  let assetsDir: string;
  let generatedDir: string;
  let manifestPath: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'crawler-engine-manifest-'));
    assetsDir = path.join(workspace, 'assets');
    generatedDir = path.join(assetsDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    manifestPath = path.join(generatedDir, 'manifest.json');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('loads an approved entry end-to-end: fetch -> registry -> preload -> texture key', async () => {
    // Write a one-entry manifest + the referenced PNG.
    writeFileSync(path.join(generatedDir, 'iron-sword.png'), Buffer.from('FAKE-PNG-IRON-SWORD'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'iron-sword': {
            briefId: 'iron-sword',
            spriteName: 'iron-sword',
            assetPath: 'generated/iron-sword.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/iron-sword/2026-06-08T12-00-00-deadbeef',
            variantIndex: 1,
            anchor: { x: 8, y: 13, source: 'brief' },
            sensorScore: '7/7',
            judgeScore: '4',
          },
        },
      }),
    );

    const fetcher = createFileFetcher(workspace);
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });

    expect(registry.size).toBe(1);
    expect(registry.lookup('iron-sword')?.textureKey).toBe('iron-sword');

    const queued: Array<{ textureKey: string; url: string }> = [];
    preloadGeneratedSprites({ image: (k, u) => queued.push({ textureKey: k, url: u }) }, registry);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      textureKey: 'iron-sword',
      url: '/assets/generated/iron-sword.png',
    });

    // The URL the loader would request must resolve back to a real file.
    const loadResp = await fetcher(queued[0]!.url);
    expect(loadResp.status).toBe(200);
    const bytes = Buffer.from(await loadResp.arrayBuffer());
    expect(bytes.toString()).toBe('FAKE-PNG-IRON-SWORD');
  });

  it('handles a missing manifest as an empty registry (no entries to preload)', async () => {
    // Note: no manifest written.
    const fetcher = createFileFetcher(workspace);
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });
    expect(registry.size).toBe(0);

    const queued: Array<{ textureKey: string; url: string }> = [];
    preloadGeneratedSprites({ image: (k, u) => queued.push({ textureKey: k, url: u }) }, registry);
    expect(queued).toEqual([]);
  });

  it('handles multiple entries and preserves anchors', async () => {
    writeFileSync(path.join(generatedDir, 'iron-sword.png'), Buffer.from('PNG-1'));
    writeFileSync(path.join(generatedDir, 'throwing-star.png'), Buffer.from('PNG-2'));
    writeFileSync(path.join(generatedDir, 'baseball-bat.png'), Buffer.from('PNG-3'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'iron-sword': {
            briefId: 'iron-sword',
            spriteName: 'iron-sword',
            assetPath: 'generated/iron-sword.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/iron-sword/x',
            variantIndex: 0,
            anchor: { x: 8, y: 13, source: 'brief' },
            sensorScore: '7/7',
            judgeScore: null,
          },
          'throwing-star': {
            briefId: 'throwing-star',
            spriteName: 'throwing-star',
            assetPath: 'generated/throwing-star.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/throwing-star/x',
            variantIndex: 0,
            // Anchor failed to derive — engine must fall back to center.
            anchor: null,
            sensorScore: '6/7',
            judgeScore: '3',
          },
          'baseball-bat': {
            briefId: 'baseball-bat',
            spriteName: 'baseball-bat',
            assetPath: 'generated/baseball-bat.png',
            approvedAt: '2026-06-08T15:30:00.000Z',
            sourceRun: 'generated/runs/baseball-bat/x',
            variantIndex: 0,
            anchor: { x: 6, y: 14, source: 'derived' },
            sensorScore: '7/7',
            judgeScore: '5',
          },
        },
      }),
    );

    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher: createFileFetcher(workspace),
    });

    expect(registry.size).toBe(3);
    expect(registry.lookup('iron-sword')?.anchor).toEqual({ x: 8, y: 13 });
    expect(registry.lookup('throwing-star')?.anchor).toEqual({ x: 8, y: 8 });
    expect(registry.lookup('throwing-star')?.anchorIsDefault).toBe(true);
    expect(registry.lookup('baseball-bat')?.anchor).toEqual({ x: 6, y: 14 });

    const queued: Array<{ textureKey: string }> = [];
    preloadGeneratedSprites({ image: (k) => queued.push({ textureKey: k }) }, registry);
    expect(queued.map((q) => q.textureKey).sort()).toEqual([
      'baseball-bat',
      'iron-sword',
      'throwing-star',
    ]);
  });
});

describe('generated manifest -> engine chain (real repo manifest)', () => {
  it('parses the checked-in manifest without throwing', async () => {
    if (!existsSync(REPO_MANIFEST)) {
      // First boot in a fresh checkout. The loader must still soft-fail.
      return;
    }
    const raw = readFileSync(REPO_MANIFEST, 'utf8');
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const registry = await fetchGeneratedSpriteRegistry({
      url: '/assets/generated/manifest.json',
      fetcher,
    });
    // Whatever count it has, it must be a valid registry.
    expect(registry.version).toBe(GENERATED_MANIFEST_VERSION);
    expect(typeof registry.size).toBe('number');
  });
});
