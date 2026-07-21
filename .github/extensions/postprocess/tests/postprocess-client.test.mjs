/**
 * Unit tests for the layer-2 postprocess orchestration client. Every network
 * path uses an injected fake `fetchImpl` + a fake sidecar client, so these run
 * with no live sidecar. The relay body shape is asserted against the monolith's
 * `POST /api/postprocess` contract (`{ briefPath, rawPng, options }`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPostprocessClient,
  padVariant,
  clampTolerance,
  normalizePipelineManifest,
  extractAppliedBackgroundTweaks,
  extractAppliedFacing,
  extractAppliedManualAnchor,
  isDestructivePersist,
  collectVariantIndices,
  DEFAULT_BACKGROUND_TWEAKS,
  MAX_BACKGROUND_TOLERANCE_SQ,
} from '../lib/postprocess-client.mjs';

const BASE = 'http://127.0.0.1:17999';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/** Minimal fake sidecar client: only the surface postprocess-client composes. */
function fakeSidecar({ summary, summaryError } = {}) {
  return {
    baseUrl: BASE,
    async fetchRunSummary() {
      if (summaryError) throw summaryError;
      return summary;
    },
    urls: {
      processed: (b, r, f) => `${BASE}/api/runs/${b}/${r}/processed/${f}`,
      runPostprocess: (b, r) => `${BASE}/api/runs/${b}/${r}/postprocess`,
    },
  };
}

test('padVariant zero-pads to two digits (monolith parity)', () => {
  assert.equal(padVariant(0), '00');
  assert.equal(padVariant(7), '07');
  assert.equal(padVariant(12), '12');
});

test('collectVariantIndices dedupes, sorts, and ignores malformed candidates', () => {
  assert.deepEqual(
    collectVariantIndices({
      candidates: [{ index: 3 }, { index: 1 }, { index: 3 }, { index: -1 }, { notIndex: 9 }, null],
    }),
    [1, 3],
  );
  assert.deepEqual(collectVariantIndices({ candidates: [] }), []);
  assert.deepEqual(collectVariantIndices(null), []);
  assert.deepEqual(collectVariantIndices({}), []);
});

test('clampTolerance clamps to [0, MAX] and falls back on non-finite', () => {
  assert.equal(MAX_BACKGROUND_TOLERANCE_SQ, 255 * 255 * 3);
  assert.equal(clampTolerance(5000), 5000);
  assert.equal(clampTolerance(-1), 0);
  assert.equal(clampTolerance(MAX_BACKGROUND_TOLERANCE_SQ + 999), MAX_BACKGROUND_TOLERANCE_SQ);
  assert.equal(clampTolerance(1234.7), 1235); // rounds
  assert.equal(clampTolerance(Number.NaN, 4000), 4000);
  assert.equal(clampTolerance(Infinity, 12000), 12000);
});

test('DEFAULT_BACKGROUND_TWEAKS matches the sidecar/monolith constants', () => {
  assert.deepEqual(
    { ...DEFAULT_BACKGROUND_TWEAKS },
    { colorToleranceSq: 4000, fringeToleranceSq: 12000 },
  );
});

test('normalizePipelineManifest drops fileless steps and resolves labels', () => {
  const out = normalizePipelineManifest({
    profile: 'default',
    sourceRunId: 'run-src',
    steps: [
      { id: 'bg', label: 'Background removal', file: '00.step-bg.png' },
      { id: 'trim', file: '00.step-trim.png' }, // label ← id
      { file: '00.step-x.png' }, // label ← file
      { id: 'nofile' }, // dropped (no file)
      null, // dropped
    ],
  });
  assert.equal(out.profile, 'default');
  assert.equal(out.sourceRunId, 'run-src');
  assert.deepEqual(out.steps, [
    { id: 'bg', label: 'Background removal', file: '00.step-bg.png' },
    { id: 'trim', label: 'trim', file: '00.step-trim.png' },
    { id: null, label: '00.step-x.png', file: '00.step-x.png' },
  ]);
});

test('normalizePipelineManifest tolerates junk input', () => {
  assert.deepEqual(normalizePipelineManifest(null), {
    profile: null,
    sourceRunId: null,
    steps: [],
  });
  assert.deepEqual(normalizePipelineManifest({ steps: 'nope' }), {
    profile: null,
    sourceRunId: null,
    steps: [],
  });
});

test('extractAppliedBackgroundTweaks reads persisted overrides or null', () => {
  assert.deepEqual(
    extractAppliedBackgroundTweaks({
      postprocessOverrides: {
        options: { background: { colorToleranceSq: 8000, fringeToleranceSq: 9000 } },
      },
    }),
    { colorToleranceSq: 8000, fringeToleranceSq: 9000 },
  );
  assert.equal(extractAppliedBackgroundTweaks({}), null);
  assert.equal(extractAppliedBackgroundTweaks({ postprocessOverrides: { options: {} } }), null);
  assert.equal(
    extractAppliedBackgroundTweaks({
      postprocessOverrides: { options: { background: { colorToleranceSq: 1 } } }, // fringe missing
    }),
    null,
  );
});

test('createPostprocessClient requires a sidecar client with a baseUrl', () => {
  assert.throws(() => createPostprocessClient({}), /requires a sidecarClient/);
  assert.throws(() => createPostprocessClient({ sidecarClient: {} }), /requires a sidecarClient/);
});

test('relayLivePostprocess: rejects an empty raw PNG without a network call', async () => {
  let called = false;
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { briefPath: 'briefs/x.yaml' } }),
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: '' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-input');
  assert.equal(called, false);
});

test('relayLivePostprocess: reports a summary failure', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summaryError: new Error('boom') }),
    fetchImpl: async () => jsonResponse({}),
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: 'AAA' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'summary-failed');
  assert.match(out.message, /boom/);
});

test('relayLivePostprocess: no briefPath → degradable no-brief-path', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { candidates: [] } }),
    fetchImpl: async () => jsonResponse({}),
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: 'AAA' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-brief-path');
});

test('relayLivePostprocess: happy path relays the monolith body + normalizes steps', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { briefPath: 'briefs/goblin.yaml' } }),
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        finalPng: 'FINAL',
        steps: [
          { id: 'bg', label: 'Background', png: 'STEP1' },
          { id: 'noimg', label: 'skipped', png: '' }, // filtered (empty png)
          { png: 'STEP3' }, // id/label default
        ],
      });
    },
  });
  const out = await client.relayLivePostprocess({
    briefId: 'b',
    runId: 'r',
    rawPngBase64: 'RAWPNG',
    options: { background: { colorToleranceSq: 4000, fringeToleranceSq: 12000 } },
  });
  assert.equal(capturedUrl, `${BASE}/api/postprocess`);
  assert.deepEqual(capturedBody, {
    briefPath: 'briefs/goblin.yaml',
    rawPng: 'RAWPNG',
    options: { background: { colorToleranceSq: 4000, fringeToleranceSq: 12000 } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.finalPng, 'FINAL');
  assert.deepEqual(out.steps, [
    { id: 'bg', label: 'Background', png: 'STEP1' },
    { id: null, label: '', png: 'STEP3' },
  ]);
});

test('relayLivePostprocess: sidecar non-200 → postprocess-failed with status', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { briefPath: 'b.yaml' } }),
    fetchImpl: async () => jsonResponse({ message: 'bad brief' }, { ok: false, status: 422 }),
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: 'AAA' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'postprocess-failed');
  assert.equal(out.status, 422);
  assert.equal(out.message, 'bad brief');
});

test('relayLivePostprocess: network throw → reason network', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { briefPath: 'b.yaml' } }),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: 'AAA' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network');
});

test('relayLivePostprocess: missing finalPng → bad-response', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: { briefPath: 'b.yaml' } }),
    fetchImpl: async () => jsonResponse({ steps: [] }),
  });
  const out = await client.relayLivePostprocess({ briefId: 'b', runId: 'r', rawPngBase64: 'AAA' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad-response');
});

test('fetchPipelineManifest: normalizes a 200 manifest, null on failure', async () => {
  const okClient = createPostprocessClient({
    sidecarClient: fakeSidecar(),
    fetchImpl: async (url) => {
      assert.match(url, /\/processed\/00\.pipeline\.json$/);
      return jsonResponse({ profile: 'p', steps: [{ id: 'a', file: 'a.png' }] });
    },
  });
  const manifest = await okClient.fetchPipelineManifest('b', 'r', '00');
  assert.equal(manifest.profile, 'p');
  assert.deepEqual(manifest.steps, [{ id: 'a', label: 'a', file: 'a.png' }]);

  const missClient = createPostprocessClient({
    sidecarClient: fakeSidecar(),
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 404 }),
  });
  assert.equal(await missClient.fetchPipelineManifest('b', 'r', '00'), null);

  const throwClient = createPostprocessClient({
    sidecarClient: fakeSidecar(),
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(await throwClient.fetchPipelineManifest('b', 'r', '00'), null);
});

// ---------------------------------------------------------------------------
// C2 persist / mutation surface
// ---------------------------------------------------------------------------

test('extractAppliedFacing reads a persisted facing override or null', () => {
  assert.deepEqual(
    extractAppliedFacing({
      postprocessOverrides: { facing: { direction: 'left', applyToAllVariants: true } },
    }),
    { direction: 'left', applyToAllVariants: true },
  );
  assert.deepEqual(
    extractAppliedFacing({ postprocessOverrides: { facing: { direction: 'right' } } }),
    { direction: 'right', applyToAllVariants: false },
  );
  assert.equal(extractAppliedFacing({}), null);
  assert.equal(extractAppliedFacing({ postprocessOverrides: {} }), null);
  assert.equal(
    extractAppliedFacing({ postprocessOverrides: { facing: { direction: 'up' } } }), // bad direction
    null,
  );
});

test('extractAppliedManualAnchor reads a persisted anchor override or null', () => {
  assert.deepEqual(
    extractAppliedManualAnchor({
      postprocessOverrides: {
        manualAnchor: { variantIndex: 2, x: 5, y: 9, applyToAllVariants: true },
      },
    }),
    { variantIndex: 2, x: 5, y: 9, applyToAllVariants: true },
  );
  assert.deepEqual(
    extractAppliedManualAnchor({
      postprocessOverrides: { manualAnchor: { variantIndex: 0, x: 1, y: 2 } },
    }),
    { variantIndex: 0, x: 1, y: 2, applyToAllVariants: false },
  );
  assert.equal(extractAppliedManualAnchor({}), null);
  assert.equal(
    extractAppliedManualAnchor({
      postprocessOverrides: { manualAnchor: { variantIndex: 0, x: 1 } }, // y missing
    }),
    null,
  );
});

test('isDestructivePersist flags resets and apply-to-all writes only', () => {
  assert.equal(isDestructivePersist({ mode: 'reset' }), true);
  assert.equal(isDestructivePersist({ mode: 'replace', applyToAll: true }), true);
  assert.equal(isDestructivePersist({ mode: 'replace', applyToAll: false }), false);
  assert.equal(isDestructivePersist({ mode: 'replace' }), false);
  assert.equal(isDestructivePersist(null), false);
});

test('relayPersistPostprocess: rejects a bad request without a network call', async () => {
  let called = false;
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: {} }),
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  const noIds = await client.relayPersistPostprocess({ runId: 'r', payload: { mode: 'reset' } });
  assert.equal(noIds.ok, false);
  assert.equal(noIds.reason, 'bad-request');
  const noPayload = await client.relayPersistPostprocess({ briefId: 'b', runId: 'r' });
  assert.equal(noPayload.ok, false);
  assert.equal(noPayload.reason, 'bad-request');
  assert.equal(called, false);
});

test('relayPersistPostprocess: posts the payload to the run route and reads back the summary', async () => {
  let capturedUrl = null;
  let capturedInit = null;
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({
      summary: { postprocessOverrides: { facing: { direction: 'left' } } },
    }),
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ ok: true });
    },
  });
  const payload = { mode: 'replace', facing: { variantIndex: 0, direction: 'left' } };
  const out = await client.relayPersistPostprocess({ briefId: 'b', runId: 'r', payload });
  assert.equal(capturedUrl, `${BASE}/api/runs/b/r/postprocess`);
  assert.equal(capturedInit.method, 'POST');
  assert.deepEqual(JSON.parse(capturedInit.body), payload);
  assert.equal(out.ok, true);
  assert.deepEqual(out.summary, { postprocessOverrides: { facing: { direction: 'left' } } });
});

test('relayPersistPostprocess: write ok but read-back throws → ok with summary:null', async () => {
  let calls = 0;
  const client = createPostprocessClient({
    sidecarClient: {
      baseUrl: BASE,
      async fetchRunSummary() {
        throw new Error('summary offline');
      },
      urls: { runPostprocess: (b, r) => `${BASE}/api/runs/${b}/${r}/postprocess` },
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
  });
  const out = await client.relayPersistPostprocess({
    briefId: 'b',
    runId: 'r',
    payload: { mode: 'reset' },
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.summary, null);
});

test('relayPersistPostprocess: sidecar non-200 → persist-failed with status + message', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: {} }),
    fetchImpl: async () => jsonResponse({ message: 'run not found' }, { ok: false, status: 404 }),
  });
  const out = await client.relayPersistPostprocess({
    briefId: 'b',
    runId: 'r',
    payload: { mode: 'reset' },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'persist-failed');
  assert.equal(out.status, 404);
  assert.equal(out.message, 'run not found');
});

test('relayPersistPostprocess: network throw → reason network', async () => {
  const client = createPostprocessClient({
    sidecarClient: fakeSidecar({ summary: {} }),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const out = await client.relayPersistPostprocess({
    briefId: 'b',
    runId: 'r',
    payload: { mode: 'reset' },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network');
});
