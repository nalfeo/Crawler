import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyThemeSetItemReview,
  markThemeEquipmentSetPublished,
  parseThemeEquipmentSetState,
  themeEquipmentSetStateKey,
} from '../../../scripts/sprites/theme-equipment-set.js';
import {
  __stageThemeEquipmentArtSurface,
  __stageThemeEquipmentRun,
  createThemeEquipmentRunnerDeps,
  ThemeEquipmentRunner,
} from '../../../scripts/sprites/theme-equipment-runner.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const REPO_ROOT = path.resolve(process.cwd());
const NOW = () => new Date('2026-07-25T04:07:30.322Z');

function memoryStore(): RunStore & { readonly mem: Map<string, Buffer>; puts: number } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    puts: 0,
    backend: 'local',
    async put(key, value) {
      this.puts += 1;
      mem.set(key, value);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new StoreNotFoundError(key);
      return value;
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
      return `memory://${key}`;
    },
  };
}

function runner(
  store: ReturnType<typeof memoryStore>,
  evaluate = vi.fn(async (_request: unknown) => ({
    json: { score: 4, rationale: 'all items share the authored language' },
    usage: null,
    modelDeployment: 'vision-test',
  })),
  overrides: Record<string, unknown> = {},
) {
  return {
    runner: new ThemeEquipmentRunner({
      repoRoot: REPO_ROOT,
      store,
      now: NOW,
      env: {},
      synthProvider: {} as never,
      briefSelectorProvider: null,
      imageProvider: {} as never,
      textProvider: null,
      visionProvider: { modelDeployment: 'vision-test', evaluate },
      queueCommitDeps: {} as never,
      ...overrides,
    }),
    evaluate,
  };
}

describe('ThemeEquipmentRunner roster production adapter', () => {
  it('constructs state-only dependencies without OpenAI credentials', () => {
    const deps = createThemeEquipmentRunnerDeps(REPO_ROOT, {}, NOW, 'state-only');

    expect(deps.store.backend).toBe('local');
    expect(deps.synthProvider).toBeNull();
    expect(deps.imageProvider).toBeNull();
    expect(deps.textProvider).toBeNull();
    expect(deps.visionProvider).toBeNull();
  });

  it('stages the current art surface and every stored run sidecar under generated/runs', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'theme-equipment-stage-fixture-'));
    const stageRoot = mkdtempSync(path.join(tmpdir(), 'theme-equipment-stage-output-'));
    const store = memoryStore();
    try {
      const generatedRoot = path.join(fixtureRoot, 'public', 'assets', 'generated');
      const catalogPath = path.join(fixtureRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
      mkdirSync(generatedRoot, { recursive: true });
      mkdirSync(path.dirname(catalogPath), { recursive: true });
      writeFileSync(path.join(generatedRoot, 'manifest.json'), '{"existing":true}\n');
      writeFileSync(catalogPath, '{"sprites":[]}\n');
      await store.put('iron-sword/run-1/summary.json', Buffer.from('{"candidates":[]}'));
      await store.put('iron-sword/run-1/processed/04.png', Buffer.from('png'));
      await store.put('iron-sword/run-1/processed/04.judge.json', Buffer.from('{"accepted":true}'));

      __stageThemeEquipmentArtSurface(fixtureRoot, stageRoot);
      await __stageThemeEquipmentRun(store, stageRoot, 'iron-sword', 'run-1');

      expect(
        readFileSync(
          path.join(stageRoot, 'public', 'assets', 'generated', 'manifest.json'),
          'utf8',
        ),
      ).toContain('existing');
      expect(
        readFileSync(path.join(stageRoot, 'src', 'shared', 'data', 'sprite-catalog.json'), 'utf8'),
      ).toContain('sprites');
      const stagedRun = path.join(stageRoot, 'generated', 'runs', 'iron-sword', 'run-1');
      expect(existsSync(path.join(stagedRun, 'summary.json'))).toBe(true);
      expect(existsSync(path.join(stagedRun, 'processed', '04.png'))).toBe(true);
      expect(existsSync(path.join(stagedRun, 'processed', '04.judge.json'))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(stageRoot, { recursive: true, force: true });
    }
  });

  it('initializes every roster concept, runs one zero-image collection judge, and saves once', async () => {
    const store = memoryStore();
    const { runner: subject, evaluate } = runner(store);

    const state = await subject.init('data/theme-equipment-sets/classic-fantasy.json');

    expect(store.puts).toBe(1);
    expect(state.phase).toBe('roster');
    expect(state.phases.roster.humanReview.verdict).toBeNull();
    expect(state.items.every((item) => item.phases.roster.review.verdict === null)).toBe(true);
    expect(state.items.every((item) => item.phases.roster.artifacts.length === 1)).toBe(true);
    expect(state.items.every((item) => item.phases.roster.evidence.length === 1)).toBe(true);
    expect(state.phases.roster.collectionJudge?.score).toBe(4);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const request = evaluate.mock.calls[0]?.[0] as
      | { readonly images: readonly unknown[]; readonly userPrompt: string }
      | undefined;
    expect(request?.images).toEqual([]);
    expect(request?.userPrompt).toContain('Burnished steel plate');
  });

  it('preserves an up-reviewed roster item, re-runs only unresolved items, and saves once', async () => {
    const store = memoryStore();
    const { runner: subject } = runner(store);
    const initialized = await subject.init('data/theme-equipment-sets/classic-fantasy.json');
    const preservedId = initialized.items[0]!.id;
    const reviewed = applyThemeSetItemReview(initialized, preservedId, { verdict: 'up' });
    if (!reviewed.ok) throw new Error('setup review rejected');
    store.mem.set(
      themeEquipmentSetStateKey(initialized.id),
      Buffer.from(`${JSON.stringify(reviewed.state)}\n`),
    );
    store.puts = 0;

    const rerun = await subject.runPhase(initialized.id);

    expect(store.puts).toBe(1);
    const preserved = rerun.items.find((item) => item.id === preservedId)!;
    expect(preserved.phases.roster.review.verdict).toBe('up');
    expect(preserved.phases.roster.artifacts).toEqual(
      reviewed.state.items.find((item) => item.id === preservedId)!.phases.roster.artifacts,
    );
  });

  it('advances rejected item revisions before rerunning without touching approved items', async () => {
    const store = memoryStore();
    const { runner: subject } = runner(store);
    const initialized = await subject.init('data/theme-equipment-sets/classic-fantasy.json');
    const approvedId = initialized.items[0]!.id;
    const rejectedId = initialized.items[1]!.id;
    const approved = applyThemeSetItemReview(initialized, approvedId, { verdict: 'up' });
    if (!approved.ok) throw new Error('setup approval rejected');
    const rejected = applyThemeSetItemReview(approved.state, rejectedId, {
      verdict: 'down',
      feedback: 'Needs a simpler silhouette.',
    });
    if (!rejected.ok) throw new Error('setup rejection rejected');
    store.mem.set(
      themeEquipmentSetStateKey(initialized.id),
      Buffer.from(`${JSON.stringify(rejected.state)}\n`),
    );
    store.puts = 0;

    const rerun = await subject.runPhase(initialized.id);

    const approvedItem = rerun.items.find((item) => item.id === approvedId)!;
    const revisedItem = rerun.items.find((item) => item.id === rejectedId)!;
    expect(store.puts).toBe(1);
    expect(approvedItem.revision).toBe(0);
    expect(approvedItem.phases.roster.review.verdict).toBe('up');
    expect(revisedItem.revision).toBe(1);
    expect(revisedItem.phases.roster.review.verdict).toBeNull();
    expect(revisedItem.phases.roster.artifacts[0]?.id).toContain(`${rejectedId}-roster-r1`);
  });

  it('does not save a partial state when its collection judge fails', async () => {
    const store = memoryStore();
    const { runner: subject } = runner(
      store,
      vi.fn(async () => {
        throw new Error('vision unavailable');
      }),
    );

    await expect(subject.init('data/theme-equipment-sets/classic-fantasy.json')).rejects.toThrow(
      'vision unavailable',
    );
    expect(store.puts).toBe(0);
    expect(store.mem.size).toBe(0);
  });

  it('publishes one combined staged asset list, saves only after success, and cleans the stage root', async () => {
    const store = memoryStore();
    const { runner: initializer } = runner(store);
    const initialized = await initializer.init('data/theme-equipment-sets/classic-fantasy.json');
    const complete = parseThemeEquipmentSetState({
      ...initialized,
      phase: 'complete',
      items: initialized.items.map((item) => ({
        ...item,
        revisionStatus: 'frozen',
        frozenPhases: ['roster', 'briefs', 'sprite-sheets', 'variant-approval'],
      })),
    });
    store.mem.set(themeEquipmentSetStateKey(complete.id), Buffer.from(JSON.stringify(complete)));
    store.puts = 0;
    const prepareApprovedAssets = vi.fn(async () => [
      { assetPath: 'generated/a.png', manifestKey: 'a', briefId: 'brief-a', variantIndex: 4 },
      { assetPath: 'generated/b.png', manifestKey: 'b', briefId: 'brief-b', variantIndex: 9 },
    ]);
    const publishSet = vi.fn(async (state: typeof complete, _options: { assets: unknown[] }) => {
      const mutation = markThemeEquipmentSetPublished(state, {
        publishedAt: NOW().toISOString(),
        queueCommit: 'combined-queue-commit',
      });
      if (!mutation.ok) throw new Error('publish setup rejected');
      return {
        state: mutation.state,
        queueResult: { status: 'committed' as const, branch: 'assets/queue', attempts: 1 },
      };
    });
    const removeStageRoot = vi.fn();
    const { runner: subject } = runner(store, undefined, {
      makeStageRoot: () => 'C:\\stage-root',
      removeStageRoot,
      prepareApprovedAssets,
      publishSet,
    });

    const published = await subject.publish(complete.id);

    expect(prepareApprovedAssets).toHaveBeenCalledTimes(1);
    expect(publishSet).toHaveBeenCalledTimes(1);
    expect(publishSet.mock.calls[0]![1].assets).toHaveLength(2);
    expect(removeStageRoot).toHaveBeenCalledWith('C:\\stage-root');
    expect(store.puts).toBe(1);
    expect(published.publication).toMatchObject({
      status: 'published',
      queueCommit: 'combined-queue-commit',
    });
  });
});
