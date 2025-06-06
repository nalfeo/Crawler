import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueAssetRequest } from '../../../scripts/sprites/queue/types.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import { workflowBriefKey } from '../../../scripts/sprites/sidecar/workflow-state.js';

vi.mock('../../../scripts/sprites/synthesize-brief.js', () => ({
  synthesizeBrief: vi.fn(),
}));
vi.mock('../../../scripts/sprites/run-full.js', () => ({
  runFull: vi.fn(),
}));
vi.mock('../../../scripts/sprites/load-brief.js', () => ({
  loadBrief: vi.fn(),
}));

import { runIssuePipeline } from '../../../scripts/sprites/issue-pipeline.js';
import { runFull } from '../../../scripts/sprites/run-full.js';
import { synthesizeBrief } from '../../../scripts/sprites/synthesize-brief.js';
import { loadBrief } from '../../../scripts/sprites/load-brief.js';

const mockSynthesizeBrief = vi.mocked(synthesizeBrief);
const mockRunFull = vi.mocked(runFull);
const mockLoadBrief = vi.mocked(loadBrief);

function makeStore(): RunStore & { mem: Map<string, Buffer> } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    backend: 'local',
    async put(key, data) {
      mem.set(key, data);
    },
    async get(key) {
      return mem.get(key) ?? Buffer.alloc(0);
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return key;
    },
  };
}

function makeRequest(overrides: Partial<IssueAssetRequest> = {}): IssueAssetRequest {
  return {
    kind: 'issue-request',
    issueNumber: 42,
    name: 'bone-dagger',
    briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
    fingerprint: 'fingerprint-1',
    claimedAt: '2026-06-28T00:00:00.000Z',
    requestedBy: 'test',
    requestedAt: '2026-06-28T00:00:00.000Z',
    priority: 'normal',
    ...overrides,
  };
}

describe('runIssuePipeline', () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'crawler-issue-pipeline-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it.each([
    ['enemy', 'enemies'],
    ['vfx', 'vfx'],
  ] as const)('promotes %s briefs into the canonical %s directory', async (type, family) => {
    const winnerPath = path.join(repoRoot, `${type}-winner.yaml`);
    writeFileSync(winnerPath, 'name: sprite\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();

    mockSynthesizeBrief.mockResolvedValueOnce({
      name: `${type}-sprite`,
      type,
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: `${type}-sprite-v1`,
          type,
          description: `${type} sprite`,
          embellishmentSeeds: [],
          synthesisRationale: 'best silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: `${type}-sprite`, runId: 'run-1' },
      summaryPath: '/tmp/run-1/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest({ name: `${type}-sprite` }),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      visionProvider: null,
      issueApi: { comment: async () => {} },
      env: {},
    });

    const promotedPath = path.join(repoRoot, 'briefs', 'draft', family, `${type}-sprite.yaml`);
    expect(readFileSync(promotedPath, 'utf8')).toContain('enabled: false');
    expect(mockRunFull).toHaveBeenCalledWith(
      expect.objectContaining({
        briefPath: promotedPath,
      }),
    );
  });

  it('records model metadata and only enables judge when a vision provider is configured', async () => {
    const winnerPath = path.join(repoRoot, 'bone-dagger.yaml');
    writeFileSync(winnerPath, 'name: bone-dagger\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();
    const comments: string[] = [];

    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'bone-dagger',
      type: 'weapon',
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: 'bone-dagger-v1',
          type: 'weapon',
          description: 'bone dagger',
          embellishmentSeeds: [],
          synthesisRationale: 'best silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockImplementationOnce(async (options) => {
      const store = options.store!;
      await store.put(
        'bone-dagger/run-7/summary.json',
        Buffer.from('{"modelDeployments":{"judge":"vision"}}\n'),
      );
      return {
        summary: { brief: 'bone-dagger', runId: 'run-7' },
        summaryPath: '/tmp/run-7/summary.json',
      } as never;
    });

    await runIssuePipeline({
      request: makeRequest(),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      visionProvider: {} as never,
      issueApi: {
        async comment(_issueNumber, body) {
          comments.push(body);
        },
      },
      env: {},
    });

    const promotedPath = path.join(repoRoot, 'briefs', 'draft', 'weapons', 'bone-dagger.yaml');
    expect(readFileSync(promotedPath, 'utf8')).toContain('enabled: true');
    expect(
      JSON.parse(store.mem.get('bone-dagger/run-7/summary.json')!.toString('utf8'))
        .modelDeployments,
    ).toEqual({
      judge: 'vision',
      synth: 'azure-openai:synth',
      briefSelector: 'selector-deploy',
    });
    expect(
      JSON.parse(store.mem.get('bone-dagger/run-7/issue-metadata.json')!.toString('utf8')),
    ).toMatchObject({
      issueNumber: 42,
      issueFingerprint: 'fingerprint-1',
      synthModel: 'azure-openai:synth',
      briefSelectorModel: 'selector-deploy',
    });
    expect(comments.find((comment) => comment.includes('Promoted brief to'))).toContain(
      'generate → postprocess → judge',
    );
    expect(mockLoadBrief).toHaveBeenCalledWith(promotedPath, { projectRoot: repoRoot });
  });

  async function runWithComments(
    comments: string[],
    extra: { postProgressComments?: boolean } = {},
  ): Promise<void> {
    const winnerPath = path.join(repoRoot, 'progress-probe.yaml');
    writeFileSync(winnerPath, 'name: progress-probe\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();
    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'progress-probe',
      type: 'weapon',
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: 'progress-probe-v1',
          type: 'weapon',
          description: 'probe',
          embellishmentSeeds: [],
          synthesisRationale: 'best silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: 'progress-probe', runId: 'run-1' },
      summaryPath: '/tmp/run-1/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest({ name: 'progress-probe' }),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      visionProvider: null,
      issueApi: {
        async comment(_issueNumber, body) {
          comments.push(body);
        },
      },
      env: {},
      ...extra,
    });
  }

  it('posts all progress comments plus the terminal summary by default', async () => {
    const comments: string[] = [];
    await runWithComments(comments);

    expect(comments.some((c) => c.startsWith('🧪 Started'))).toBe(true);
    expect(comments.some((c) => c.startsWith('🧠 Selected'))).toBe(true);
    expect(comments.some((c) => c.startsWith('📌 Promoted'))).toBe(true);
    expect(comments.some((c) => c.startsWith('✅ Asset-request pipeline complete.'))).toBe(true);
  });

  it('suppresses intermediate progress comments but keeps the terminal summary when postProgressComments is false', async () => {
    const comments: string[] = [];
    await runWithComments(comments, { postProgressComments: false });

    // The three live-progress comments are silenced on redeliveries so a
    // recurring transient failure cannot re-post them on every retry...
    expect(comments.some((c) => c.startsWith('🧪 Started'))).toBe(false);
    expect(comments.some((c) => c.startsWith('🧠 Selected'))).toBe(false);
    expect(comments.some((c) => c.startsWith('📌 Promoted'))).toBe(false);
    // ...but a terminal success summary still posts.
    expect(comments.some((c) => c.startsWith('✅ Asset-request pipeline complete.'))).toBe(true);
  });

  it('infers weapon type from weapon-* prefix', async () => {
    const winnerPath = path.join(repoRoot, 'weapon-sword.yaml');
    writeFileSync(winnerPath, 'name: weapon-sword\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();

    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'weapon-sword',
      type: 'weapon',
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: 'weapon-sword-v1',
          type: 'weapon',
          description: 'sword',
          embellishmentSeeds: [],
          synthesisRationale: 'inferred type',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: 'weapon-sword', runId: 'run-1' },
      summaryPath: '/tmp/run-1/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest({ name: 'weapon-sword', type: undefined }),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      visionProvider: null,
      issueApi: { comment: async () => {} },
      env: {},
    });

    // Verify synthesizeBrief was called with inferred weapon type
    expect(mockSynthesizeBrief).toHaveBeenCalled();
    const callArgs = mockSynthesizeBrief.mock.calls[0]![0];
    expect(callArgs.name).toBe('weapon-sword');
    expect(callArgs.type).toBe('weapon');
  });

  it('uses explicit type field when provided', async () => {
    const winnerPath = path.join(repoRoot, 'dagger.yaml');
    writeFileSync(winnerPath, 'name: dagger\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();

    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'dagger',
      type: 'weapon',
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: 'dagger-v1',
          type: 'weapon',
          description: 'dagger',
          embellishmentSeeds: [],
          synthesisRationale: 'explicit type',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: 'dagger', runId: 'run-1' },
      summaryPath: '/tmp/run-1/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest({ name: 'dagger', type: 'weapon' }),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      visionProvider: null,
      issueApi: { comment: async () => {} },
      env: {},
    });

    // Verify synthesizeBrief was called with explicit type
    expect(mockSynthesizeBrief).toHaveBeenCalled();
    const callArgs = mockSynthesizeBrief.mock.calls[0]![0];
    expect(callArgs.name).toBe('dagger');
    expect(callArgs.type).toBe('weapon');
  });

  it('mirrors the post-enableJudge brief bytes into the store before runFull executes', async () => {
    // Regression test: issue-pipeline must mirror the promoted brief to the store
    // (via mirrorBriefToStore) AFTER enableJudge mutates it and BEFORE runFull starts,
    // so the sidecar can load it via materializeBriefFromStore after the CI runner shuts down.
    const winnerPath = path.join(repoRoot, 'bone-dagger.yaml');
    writeFileSync(winnerPath, 'name: bone-dagger\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();
    const promotedRel = 'briefs/draft/weapons/bone-dagger.yaml';
    const briefKey = workflowBriefKey(promotedRel);

    // Capture the store state from *inside* the runFull mock to verify ordering.
    let mirroredBeforeRunFull = false;
    let mirroredBytesAtRunFull: string | undefined;

    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'bone-dagger',
      type: 'weapon',
      sizeVariant: 'default',
      outDir: repoRoot,
      written: [
        {
          id: 'bone-dagger-v1',
          type: 'weapon',
          description: 'bone dagger',
          embellishmentSeeds: [],
          synthesisRationale: 'best silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockImplementationOnce(async () => {
      // At this point mirrorBriefToStore must already have run.
      mirroredBeforeRunFull = store.mem.has(briefKey);
      mirroredBytesAtRunFull = store.mem.get(briefKey)?.toString('utf8');
      return {
        summary: { brief: 'bone-dagger', runId: 'run-1' },
        summaryPath: '/tmp/run-1/summary.json',
      } as never;
    });

    await runIssuePipeline({
      request: makeRequest(),
      repoRoot,
      store,
      imageProvider: {} as never,
      textProvider: null,
      synthProvider: {} as never,
      briefSelectorProvider: {
        modelDeployment: 'selector-deploy',
        async selectBrief() {
          return { index: 0, rationale: 'best match', modelDeployment: 'selector-deploy' };
        },
      },
      // Use a non-null visionProvider so enableJudge sets enabled: true — proves
      // the mirrored bytes are the post-mutation version, not the pre-mutation copy.
      visionProvider: {} as never,
      issueApi: { comment: async () => {} },
      env: {},
    });

    // Ordering: brief must be in the store when runFull starts.
    expect(mirroredBeforeRunFull).toBe(true);
    // Post-enableJudge bytes: enabled must be true (vision provider was configured).
    expect(mirroredBytesAtRunFull).toContain('enabled: true');
    // Final state: key and correct bytes still present after the pipeline completes.
    expect(store.mem.has(briefKey)).toBe(true);
    expect(store.mem.get(briefKey)!.toString('utf8')).toContain('enabled: true');
  });
});
