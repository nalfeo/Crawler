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
});
