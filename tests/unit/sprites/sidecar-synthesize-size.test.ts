/**
 * Isolated sidecar test for the size-variant passthrough.
 *
 * The `/api/workflow/synthesize` route must forward the validated `sizeVariant`
 * to `synthesizeBrief` (and omit it when the request leaves it unset).
 * `synthesizeBrief` is mocked so the assertion is deterministic and never
 * touches a synth provider or the network — kept in its own file so the module
 * mock does not leak into the broader sidecar-server suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { synthesizeBrief } from '../../../scripts/sprites/synthesize-brief.js';
import { buildServer } from '../../../scripts/sprites/sidecar/server.js';

vi.mock('../../../scripts/sprites/synthesize-brief.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../scripts/sprites/synthesize-brief.js')>();
  return { ...actual, synthesizeBrief: vi.fn() };
});

// Minimal Azure env so `createSynthProvider` constructs successfully; the
// provider is never invoked because `synthesizeBrief` is mocked.
const FAKE_AZURE_ENV = {
  SPRITES_SYNTH_PROVIDER: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example.invalid',
  AZURE_OPENAI_API_KEY: 'test-key',
  AZURE_OPENAI_CHAT_DEPLOYMENT: 'test-deploy',
};

describe('sidecar POST /api/workflow/synthesize sizeVariant passthrough', () => {
  let root: string;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-sidecar-size-'));
    vi.mocked(synthesizeBrief).mockReset();
    vi.mocked(synthesizeBrief).mockResolvedValue({
      name: 'iron-sword',
      type: 'weapon',
      sizeVariant: 'wide',
      outDir: path.join(root, 'runs'),
      written: [],
      rejected: [],
      sidecarPath: path.join(root, 'sidecar.json'),
      providerLabel: 'mock',
      promptHash: 'deadbeef',
    });
    app = buildServer({
      repoRoot: root,
      runsDir: path.join(root, 'runs'),
      version: 'test',
      env: FAKE_AZURE_ENV,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('forwards a valid sizeVariant to synthesizeBrief', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', sizeVariant: 'wide' },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(synthesizeBrief)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(synthesizeBrief).mock.calls[0]![0]).toMatchObject({ sizeVariant: 'wide' });
  });

  it('omits sizeVariant entirely when the request does not set it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword' },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(synthesizeBrief).mock.calls[0]![0].sizeVariant).toBeUndefined();
  });

  it('forwards the shared floor, family, role, and request-local injection contract', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'goblin-elite-scout',
        type: 'enemy',
        floor: 2,
        floorId: 'floor2',
        familyId: 'goblins',
        mobRole: 'elite',
        injectionOverrides: { family: 'LOCAL AUTHOR OVERRIDE' },
        priority: 'high',
        requester: 'local-author/session-42',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(synthesizeBrief).mock.calls[0]![0]).toMatchObject({
      floor: 2,
      mobRole: 'elite',
      requestMetadata: {
        priority: 'high',
        requester: 'local-author/session-42',
      },
      assetRequestContext: {
        sourceIds: {
          floorId: 'floor2',
          enemyPackId: 'floor2-families',
          familyId: 'goblins',
        },
        mobRole: 'elite',
        injections: {
          family: 'LOCAL AUTHOR OVERRIDE',
        },
      },
    });
    expect(res.json()).toMatchObject({
      requestMetadata: {
        priority: 'high',
        requester: 'local-author/session-42',
      },
    });
  });

  it.each([
    [
      { priority: 'urgent' },
      "Invalid priority 'urgent' in body.priority. Expected one of normal, high.",
    ],
    [
      { requester: 'not a valid requester' },
      "Invalid requester 'not a valid requester' in body.requester. Use a 1-128 character identity without whitespace.",
    ],
  ])('rejects invalid local author request metadata', async (payload, message) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflow/synthesize',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'iron-sword', ...payload },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'bad-request',
      message,
    });
  });

  it('exposes canonical floor and family injections for local author editing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflow/asset-context' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      capabilities: Array<{
        floorId: string;
        enemyPackId: string;
        canonicalFloorInjection?: string;
        families: Array<{ id: string; canonicalFamilyInjection?: string }>;
      }>;
    };
    expect(body.capabilities).toContainEqual(
      expect.objectContaining({
        floorId: 'floor2',
        enemyPackId: 'floor2-families',
        canonicalFloorInjection: expect.stringContaining('Family Matters'),
        families: expect.arrayContaining([
          expect.objectContaining({
            id: 'goblins',
            canonicalFamilyInjection: expect.stringContaining('Snaggle Cartel'),
          }),
        ]),
      }),
    );
  });
});
