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

import {
  buildCompletionComment,
  runIssuePipeline,
} from '../../../scripts/sprites/issue-pipeline.js';
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

  it(
    'records model metadata and only enables judge when a vision provider is configured',
    async () => {
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

  it(
    'suppresses intermediate progress comments but keeps the terminal summary when postProgressComments is false',
    async () => {
    const comments: string[] = [];
    await runWithComments(comments, { postProgressComments: false });

    // The three live-progress comments are silenced on redeliveries so a
    // recurring transient failure cannot re-post them on every retry...
    expect(comments.some((c) => c.startsWith('🧪 Started'))).toBe(false);
    expect(comments.some((c) => c.startsWith('🧠 Selected'))).toBe(false);
    expect(comments.some((c) => c.startsWith('📌 Promoted'))).toBe(false);
    // ...but a terminal success summary still posts.
    expect(comments.some((c) => c.startsWith('✅ Asset-request pipeline complete.'))).toBe(true);
    },
  );

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

  it.each([
    {
      label: 'legacy omitted-size boss',
      request: { name: 'batfolk-boss', type: 'enemy' as const },
      expected: 'large' as const,
    },
    {
      label: 'explicit wide boss',
      request: { name: 'beetlefolk-boss', type: 'enemy' as const, sizeVariant: 'wide' as const },
      expected: 'wide' as const,
    },
    {
      label: 'ordinary enemy',
      request: { name: 'beetlefolk-enforcer', type: 'enemy' as const },
      expected: 'default' as const,
    },
  ])('passes the effective size to synthesis for $label', async ({ request, expected }) => {
    const winnerPath = path.join(repoRoot, `${request.name}.yaml`);
    writeFileSync(winnerPath, `name: ${request.name}\njudge:\n  enabled: false\n`, 'utf8');
    const store = makeStore();
    mockSynthesizeBrief.mockResolvedValueOnce({
      name: request.name,
      type: 'enemy',
      sizeVariant: expected,
      outDir: repoRoot,
      written: [
        {
          id: `${request.name}-v1`,
          type: 'enemy',
          description: 'enemy boss',
          embellishmentSeeds: [],
          synthesisRationale: 'clear silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: request.name, runId: 'run-size' },
      summaryPath: '/tmp/run-size/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest(request),
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

    expect(mockSynthesizeBrief.mock.calls[0]![0].sizeVariant).toBe(expected);
  });

  it(
    'type-omitted boss request infers enemy type so boss prompt and boss_presence activate',
    async () => {
    // Regression: a type-omitted request like "countess-boss" resolved mobRole:'boss'
    // but inferSpriteTypeFromName defaulted the sprite type to 'character', preventing
    // both the boss prompt and boss_presence judge axis from running.
    const winnerPath = path.join(repoRoot, 'countess-boss.yaml');
    writeFileSync(winnerPath, 'name: countess-boss\njudge:\n  enabled: false\n', 'utf8');
    const store = makeStore();
    mockSynthesizeBrief.mockResolvedValueOnce({
      name: 'countess-boss',
      type: 'enemy',
      sizeVariant: 'large',
      outDir: repoRoot,
      written: [
        {
          id: 'countess-boss-v1',
          type: 'enemy',
          description: 'An aristocratic batfolk crime boss.',
          embellishmentSeeds: [],
          synthesisRationale: 'boss silhouette',
          yamlPath: winnerPath,
        },
      ],
      rejected: [],
      sidecarPath: path.join(repoRoot, 'synthesis.json'),
      providerLabel: 'azure-openai:synth',
      promptHash: 'prompt-hash',
    });
    mockRunFull.mockResolvedValueOnce({
      summary: { brief: 'countess-boss', runId: 'run-boss' },
      summaryPath: '/tmp/run-boss/summary.json',
    } as never);

    await runIssuePipeline({
      request: makeRequest({
        name: 'countess-boss',
        briefSentence: 'An aristocratic batfolk crime boss with folded cloak-like wings.',
        // No explicit type — should infer 'enemy' from mobRole:'boss'
      }),
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

    const callArgs = mockSynthesizeBrief.mock.calls[0]![0];
    expect(callArgs.type).toBe('enemy');
    expect(callArgs.mobRole).toBe('boss');
  });

  it(
    'mirrors the post-enableJudge brief bytes into the store before runFull executes',
    async () => {
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

describe('buildCompletionComment', () => {
  it('includes the spritesheet image embed using sheet-00.png for a single-attempt run', () => {
    const store = makeStore();
    const result = {
      summary: { brief: 'bone-dagger', runId: 'run-1', attempts: 1, chosen: null, candidates: [] },
      summaryPath: 'bone-dagger/run-1/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain('✅ Asset-request pipeline complete.');
    expect(comment).toContain('### Spritesheet');
    expect(comment).toContain('![Spritesheet](bone-dagger/run-1/sheet-00.png)');
    expect(comment).not.toContain('Chosen variant');
  });

  it('uses the last attempt sheet index when multiple attempts were made', () => {
    const store = makeStore();
    const result = {
      summary: {
        brief: 'bone-dagger',
        runId: 'run-2',
        attempts: 3,
        chosen: null,
        candidates: [],
      },
      summaryPath: 'bone-dagger/run-2/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain('![Spritesheet](bone-dagger/run-2/sheet-02.png)');
    expect(comment).not.toContain('sheet-00.png');
  });

  it('prefers resolveForExternalRead for embed URLs when available', () => {
    const store: RunStore = {
      ...makeStore(),
      resolveForExternalRead(key) {
        return `https://signed.example.test/${key}?sig=read-only`;
      },
    };
    const result = {
      summary: {
        brief: 'bone-dagger',
        runId: 'run-2a',
        attempts: 2,
        variantCount: 4,
        chosen: { index: 1, score: 4, outOf: 5, passed: true, combinedPassed: true },
        candidates: [{ index: 1, processedPath: 'bone-dagger/run-2a/processed/01.png' }],
      },
      summaryPath: 'bone-dagger/run-2a/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain(
      '![Spritesheet](https://signed.example.test/bone-dagger/run-2a/sheet-01.png?sig=read-only)',
    );
    expect(comment).toContain(
      '![Chosen variant 2/4 (score 4/5) ✅](https://signed.example.test/bone-dagger/run-2a/processed/01.png?sig=read-only)',
    );
  });

  it(
    'includes the chosen variant image embed with pass status when a chosen candidate exists',
    () => {
    const store = makeStore();
    const result = {
      summary: {
        brief: 'bone-dagger',
        runId: 'run-3',
        attempts: 1,
        variantCount: 4,
        chosen: { index: 2, score: 4, outOf: 5, passed: true, combinedPassed: true },
        candidates: [
          { index: 0, processedPath: 'bone-dagger/run-3/processed/00.png' },
          { index: 2, processedPath: 'bone-dagger/run-3/processed/02.png' },
        ],
      },
      summaryPath: 'bone-dagger/run-3/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain('### Chosen variant (3/4)');
    expect(comment).toContain('bone-dagger/run-3/processed/02.png');
    expect(comment).toContain('✅');
    },
  );

  it('shows ⚠️ pass label when chosen variant did not fully pass the pipeline', () => {
    const store = makeStore();
    const result = {
      summary: {
        brief: 'bone-dagger',
        runId: 'run-4',
        attempts: 1,
        variantCount: 2,
        chosen: { index: 0, score: 3, outOf: 5, passed: true, combinedPassed: false },
        candidates: [{ index: 0, processedPath: 'bone-dagger/run-4/processed/00.png' }],
      },
      summaryPath: 'bone-dagger/run-4/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain('⚠️');
    expect(comment).toContain('bone-dagger/run-4/processed/00.png');
  });

  it('omits the chosen variant section when chosen is null', () => {
    const store = makeStore();
    const result = {
      summary: {
        brief: 'bone-dagger',
        runId: 'run-5',
        attempts: 1,
        variantCount: 0,
        chosen: null,
        candidates: [],
      },
      summaryPath: 'bone-dagger/run-5/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).not.toContain('Chosen variant');
    expect(comment).toContain('![Spritesheet](bone-dagger/run-5/sheet-00.png)');
  });

  it('falls back to sheet-00.png when attempts is missing from summary', () => {
    const store = makeStore();
    // Simulates a legacy summary without the attempts field.
    const result = {
      summary: { brief: 'bone-dagger', runId: 'run-6' },
      summaryPath: 'bone-dagger/run-6/summary.json',
    } as never;
    const comment = buildCompletionComment(result, store);
    expect(comment).toContain('![Spritesheet](bone-dagger/run-6/sheet-00.png)');
  });
});
