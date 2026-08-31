import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { buildServer } from '../../scripts/sprites/sidecar/server.js';
import { writeShard } from '../../scripts/sprites/generated-shards.js';
import { LocalRunStore } from '../../scripts/sprites/store/local-store.js';
import type { RunStore } from '../../scripts/sprites/store/types.js';
import type { AssetQueue } from '../../scripts/sprites/queue/types.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import { ProviderError } from '../../scripts/sprites/provider/types.js';
import { buildGoodSwordFixture } from '../fixtures/sprites/builders.js';

const STYLE_GUIDE = [
  '# Style guide',
  '',
  '> --- STYLE PREAMBLE (do not deviate) ---',
  '>',
  '> Rule 1: no text.',
  '>',
  '> --- END STYLE PREAMBLE ---',
].join('\n');

const BRIEF = `
type: weapon
name: iron-sword
size: { width: 32, height: 32 }
palette: { id: test-palette }
anchor: { x: 16, y: 16 }
tags: [sword]
prompt: An iron sword.
seedFrames:
  - path: briefs/weapons/seeds/identity.png
    note: Preserve this identity.
generation:
  sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 1024 }
sensors:
  edge:
    allowMainTouch: true
    allowDetachedEdgeComponents: true
    maxDetachedEdgePixels: 16
  weapon:
    orientation: diagonal
minVariations: 0
postprocessing:
  trimAndFit: false
  minDimension: 64
  paletteMode: strict
`.trim();

function solidPng(rgb: readonly [number, number, number]): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgb[0];
    png.data[index + 1] = rgb[1];
    png.data[index + 2] = rgb[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function tileSheet(): Buffer {
  const variants = Array.from({ length: 4 }, () => PNG.sync.read(buildGoodSwordFixture()));
  const cellSize = variants[0]!.width;
  const sheet = new PNG({ width: cellSize * 2, height: cellSize * 2 });
  variants.forEach((cell, index) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    for (let y = 0; y < cellSize; y += 1) {
      const sourceStart = y * cellSize * 4;
      const targetStart = ((row * cellSize + y) * sheet.width + col * cellSize) * 4;
      cell.data.copy(sheet.data, targetStart, sourceStart, sourceStart + cellSize * 4);
    }
  });
  return PNG.sync.write(sheet);
}

describe('exact generation request preview', () => {
  let root: string;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-generation-preview-'));
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sends the reviewed prompt and ordered seed/reference bytes locally without queueing', async () => {
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'weapons', 'seeds'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'draft', 'weapons'), { recursive: true });
    const candidateDir = path.join(root, 'generated', 'brief-candidates', 'iron-sword');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'palettes', 'test-palette.json'),
      JSON.stringify([
        [0, 0, 0],
        [255, 255, 255],
      ]),
    );
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    writeFileSync(
      path.join(root, 'briefs', 'weapons', 'seeds', 'identity.png'),
      solidPng([9, 9, 9]),
    );
    writeFileSync(path.join(candidateDir, 'iron-sword-v1.yaml'), BRIEF);
    writeFileSync(path.join(root, 'briefs', 'draft', 'weapons', 'iron-sword.yaml'), BRIEF);

    const generatedDir = path.join(root, 'public', 'assets', 'generated');
    const referenceBuffers = [
      solidPng([200, 20, 20]),
      solidPng([20, 200, 20]),
      solidPng([20, 20, 200]),
    ];
    referenceBuffers.forEach((bytes, index) => {
      const spriteName = `reference-${index}-var-0`;
      const assetPath = `generated/${spriteName}.png`;
      mkdirSync(generatedDir, { recursive: true });
      writeFileSync(path.join(root, 'public', 'assets', assetPath), bytes);
      writeShard(generatedDir, spriteName, {
        spriteName,
        assetPath,
        briefId: `reference-${index}`,
        approvedAt: '2026-08-27T00:00:00.000Z',
        sourceRun: 'run-1',
        variantIndex: 0,
        anchor: null,
        sensorScore: '8/8',
        judgeScore: '5',
        type: 'weapon',
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      });
    });

    let providerRequest: GenerateSheetRequest | null = null;
    let failNextProviderCall = false;
    let blockNextProviderCall = false;
    let releaseProvider: () => void = () => {
      throw new Error('provider release requested before the provider was blocked');
    };
    let notifyProviderStarted: (() => void) | null = null;
    const provider: ImageProvider = {
      async generateSheet(request) {
        providerRequest = request;
        if (failNextProviderCall) {
          failNextProviderCall = false;
          throw new ProviderError('network', 'temporary provider outage');
        }
        if (blockNextProviderCall) {
          blockNextProviderCall = false;
          notifyProviderStarted?.();
          await new Promise<void>((resolve) => {
            releaseProvider = resolve;
          });
        }
        return tileSheet();
      },
    };
    const enqueue = vi.fn();
    const queue = {
      backend: 'azure-queue',
      enqueue,
      dequeue: async () => null,
      peek: async () => [],
    } as unknown as AssetQueue;
    const localStore = new LocalRunStore(path.join(root, 'durable-runs'));
    const store: RunStore = {
      backend: 'azure-blob',
      conditionalWrites: localStore.conditionalWrites,
      put: (key, data) => localStore.put(key, data),
      get: (key) => localStore.get(key),
      has: (key) => localStore.has(key),
      list: (prefix) => localStore.list(prefix),
      remove: (key) => localStore.remove(key),
      resolve: (key) => localStore.resolve(key),
    };
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'durable-runs'),
      version: 'test',
      queue,
      store,
      imageProvider: provider,
      textProvider: null,
      trustedMutationOrigins: ['http://localhost:4102'],
    });

    const hostilePreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      headers: { origin: 'https://evil.example' },
      payload: {
        sourceBriefPath: 'generated/brief-candidates/iron-sword/iron-sword-v1.yaml',
      },
    });
    expect(hostilePreview.statusCode).toBe(403);
    expect(hostilePreview.json().error).toBe('forbidden-origin');

    const firstPreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      payload: {
        sourceBriefPath: 'generated/brief-candidates/iron-sword/iron-sword-v1.yaml',
      },
    });
    expect(firstPreview.statusCode).toBe(200);
    const initial = firstPreview.json();
    const reversed = [...initial.selectedAssetPaths].reverse();
    const prompt = `${initial.prompt}\nOperator-approved emphasis.`;

    const reviewedPreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      payload: {
        previewToken: initial.previewToken,
        prompt,
        referenceAssetPaths: reversed,
      },
    });
    expect(reviewedPreview.statusCode).toBe(200);
    const reviewed = reviewedPreview.json();
    expect(reviewed.references[0].kind).toBe('seed');
    expect(
      reviewed.references.slice(1).map((entry: { assetPath: string }) => entry.assetPath),
    ).toEqual(reversed);
    expect(reviewed.promptHash).toBe(createHash('sha256').update(prompt).digest('hex'));
    const superseded = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: initial.previewToken,
      },
    });
    expect(superseded.statusCode).toBe(409);
    expect(superseded.json().error).toBe('generation-preview-expired');

    const hostileGenerate = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      headers: { origin: 'https://evil.example' },
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: reviewed.previewToken,
      },
    });
    expect(hostileGenerate.statusCode).toBe(403);
    expect(hostileGenerate.json().error).toBe('forbidden-origin');

    const generated = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: reviewed.previewToken,
      },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().status).toBe('completed');
    expect(enqueue).not.toHaveBeenCalled();
    expect(providerRequest).not.toBeNull();
    expect(providerRequest!.prompt).toBe(reviewed.prompt);
    expect(
      providerRequest!.referencePngs.map((bytes) =>
        createHash('sha256').update(bytes).digest('hex'),
      ),
    ).toEqual(reviewed.references.map((entry: { contentHash: string }) => entry.contentHash));
    const keys = await store.list('iron-sword/');
    expect(keys.some((key) => key.endsWith('/sheet-00.png'))).toBe(true);
    expect(keys.some((key) => key.endsWith('/summary.json'))).toBe(true);
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: reviewed.previewToken,
      },
    });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().error).toBe('generation-preview-expired');

    const retryPreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      payload: {
        sourceBriefPath: 'generated/brief-candidates/iron-sword/iron-sword-v1.yaml',
      },
    });
    expect(retryPreview.statusCode).toBe(200);
    failNextProviderCall = true;
    const providerFailure = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: retryPreview.json().previewToken,
      },
    });
    expect(providerFailure.statusCode).toBe(500);
    expect(providerFailure.json().error).toBe('generate-failed');
    const retried = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: retryPreview.json().previewToken,
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('completed');

    const concurrentPreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      payload: {
        sourceBriefPath: 'generated/brief-candidates/iron-sword/iron-sword-v1.yaml',
      },
    });
    expect(concurrentPreview.statusCode).toBe(200);
    const providerStarted = new Promise<void>((resolve) => {
      notifyProviderStarted = resolve;
    });
    blockNextProviderCall = true;
    const firstConcurrentGeneration = app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: concurrentPreview.json().previewToken,
      },
    });
    await providerStarted;
    const duplicateConcurrentGeneration = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: concurrentPreview.json().previewToken,
      },
    });
    expect(duplicateConcurrentGeneration.statusCode).toBe(409);
    expect(duplicateConcurrentGeneration.json().error).toBe('generation-preview-in-use');
    releaseProvider();
    expect((await firstConcurrentGeneration).statusCode).toBe(200);

    const driftPreview = await app.inject({
      method: 'POST',
      url: '/api/workflow/generation-preview',
      payload: {
        sourceBriefPath: 'generated/brief-candidates/iron-sword/iron-sword-v1.yaml',
      },
    });
    expect(driftPreview.statusCode).toBe(200);
    const drifted = driftPreview.json();
    writeFileSync(
      path.join(root, 'public', 'assets', drifted.selectedAssetPaths[0]!),
      solidPng([1, 2, 3]),
    );
    const refused = await app.inject({
      method: 'POST',
      url: '/api/workflow/generate',
      payload: {
        briefPath: 'briefs/draft/weapons/iron-sword.yaml',
        previewToken: drifted.previewToken,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('generation-request-drifted');
  });
});
