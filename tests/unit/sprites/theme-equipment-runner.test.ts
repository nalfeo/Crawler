import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyThemeSetItemReview,
  markThemeEquipmentSetPublished,
  parseThemeEquipmentSetState,
  themeEquipmentSetStateKey,
  emptyThemeEquipmentItemPhases,
  emptyThemeEquipmentSetPhases,
  NON_HAND_EQUIPMENT_SLOT_IDS,
  THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
  THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  type ThemeEquipmentArtifactEvidence,
  type ThemeEquipmentSetState,
} from '../../../scripts/sprites/theme-equipment-set.js';
import {
  __stageThemeEquipmentArtSurface,
  __stageThemeEquipmentRun,
  createThemeEquipmentRunnerDeps,
  selectCollectionTileSources,
  ThemeEquipmentRunner,
} from '../../../scripts/sprites/theme-equipment-runner.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const REPO_ROOT = path.resolve(process.cwd());
const NOW = () => new Date('2026-07-25T04:07:30.322Z');

function tinyPng(size = 2): Buffer {
  const png = new PNG({ width: size, height: size });
  png.data.fill(200);
  return PNG.sync.write(png);
}

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

const COHESION_WEAPON_TYPES = ['sword', 'bow', 'axe', 'staff', 'dagger'] as const;

function approvedVariantArtifact(
  itemId: string,
  variantIndex: number,
): ThemeEquipmentArtifactEvidence {
  return {
    id: `${itemId}-approved-${variantIndex}`,
    kind: THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
    uri: `memory://${itemId}/variant-approval/${variantIndex}`,
    provenance: 'unit-test',
    briefId: `${itemId}-v2`,
    runId: `run-${itemId}`,
    variantIndex,
  };
}

function rawSheetArtifact(itemId: string): ThemeEquipmentArtifactEvidence {
  return {
    id: `${itemId}-raw-sheet`,
    kind: 'raw-sheet',
    uri: `memory://${itemId}/sprite-sheets/sheet`,
    provenance: 'unit-test',
    briefId: `${itemId}-v2`,
    runId: `run-${itemId}`,
    summary: 'sheet-00.png',
  };
}

function itemPhasesWith(
  phase: 'sprite-sheets' | 'variant-approval',
  artifacts: readonly ThemeEquipmentArtifactEvidence[],
): ThemeEquipmentSetState['items'][number]['phases'] {
  const phases = emptyThemeEquipmentItemPhases();
  return {
    ...phases,
    [phase]: { artifacts: [...artifacts], evidence: [], review: { verdict: 'up' as const } },
  };
}

/**
 * Build a coverage-valid state parked at `variant-approval` (5 distinct weapon
 * types + the minimum non-hand slots), each item carrying the given approved
 * variant indices (deliberately out of array order to prove deterministic
 * lowest-index selection). Slot items each carry a single variant.
 */
function makeVariantApprovalState(
  weaponVariantIndices: readonly (readonly number[])[] = [[7, 2, 5], [4], [9, 3], [6, 1, 8], [2]],
): ThemeEquipmentSetState {
  const weaponItems = COHESION_WEAPON_TYPES.map((weaponType, index) => {
    const id = `${weaponType}-of-moonlight`;
    const indices = weaponVariantIndices[index] ?? [1];
    return {
      id,
      displayName: `${weaponType} of Moonlight`,
      kind: 'weapon' as const,
      weaponType,
      revision: 0,
      revisionStatus: 'open' as const,
      frozenPhases: [],
      phases: itemPhasesWith(
        'variant-approval',
        indices.map((variantIndex) => approvedVariantArtifact(id, variantIndex)),
      ),
    };
  });
  const slotItems = NON_HAND_EQUIPMENT_SLOT_IDS.slice(
    0,
    THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  ).map((slot) => {
    const id = `${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-relic`;
    return {
      id,
      displayName: `${slot} Relic`,
      kind: 'equipment' as const,
      slots: [slot],
      revision: 0,
      revisionStatus: 'open' as const,
      frozenPhases: [],
      phases: itemPhasesWith('variant-approval', [approvedVariantArtifact(id, 0)]),
    };
  });
  return parseThemeEquipmentSetState({
    schemaVersion: 1,
    id: 'moon-court-regalia',
    displayName: 'Moon Court Regalia',
    themeDesignLanguage: 'silver filigree and lunar enamel',
    phase: 'variant-approval',
    items: [...weaponItems, ...slotItems],
    phases: emptyThemeEquipmentSetPhases(),
    stateRevision: 0,
    updatedAt: NOW().toISOString(),
  });
}

function representativeKey(item: ThemeEquipmentSetState['items'][number]): string {
  const approved = item.phases['variant-approval'].artifacts.filter(
    (artifact) => artifact.kind === THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
  );
  const representative = approved.reduce((lowest, candidate) =>
    (candidate.variantIndex ?? Infinity) < (lowest.variantIndex ?? Infinity) ? candidate : lowest,
  );
  const filename = `processed/${String(representative.variantIndex).padStart(2, '0')}.png`;
  return `${representative.briefId}/${representative.runId}/${filename}`;
}

describe('selectCollectionTileSources', () => {
  it('returns one tile per item at variant-approval, choosing the lowest variantIndex', () => {
    const state = makeVariantApprovalState([[7, 2, 5], [4], [9, 3], [6, 1, 8], [2]]);
    const sources = selectCollectionTileSources(state);

    expect(sources).toHaveLength(state.items.length);
    expect(sources[0]).toEqual({
      key: 'sword-of-moonlight-v2/run-sword-of-moonlight/processed/02.png',
      label: 'sword of Moonlight',
    });
    expect(sources[2]).toEqual({
      key: 'axe-of-moonlight-v2/run-axe-of-moonlight/processed/03.png',
      label: 'axe of Moonlight',
    });
    expect(sources.map((source) => source.label)).toEqual(
      state.items.map((item) => item.displayName),
    );
    expect(sources.map((source) => source.key)).toEqual(state.items.map(representativeKey));
  });

  it('throws when an item has no approved-variant artifacts', () => {
    const state = makeVariantApprovalState();
    const broken = parseThemeEquipmentSetState({
      ...state,
      items: state.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              phases: {
                ...item.phases,
                'variant-approval': {
                  ...item.phases['variant-approval'],
                  artifacts: [],
                },
              },
            }
          : item,
      ),
    });

    expect(() => selectCollectionTileSources(broken)).toThrow('has no approved-variant artifacts');
  });

  it('validates every approved artifact, not just the selected one', () => {
    const state = makeVariantApprovalState([[2, 9], [4], [3], [1], [5]]);
    // The lowest index (2) is well-formed; the unselected variant (9) drops runId.
    const broken = parseThemeEquipmentSetState({
      ...state,
      items: state.items.map((item, index) => {
        if (index !== 0) return item;
        const approved = item.phases['variant-approval'].artifacts;
        return {
          ...item,
          phases: {
            ...item.phases,
            'variant-approval': {
              ...item.phases['variant-approval'],
              artifacts: approved.map((artifact) =>
                artifact.variantIndex === 9 ? { ...artifact, runId: undefined } : artifact,
              ),
            },
          },
        };
      }),
    });

    expect(() => selectCollectionTileSources(broken)).toThrow('metadata is incomplete');
  });

  it('returns one raw-sheet tile per item at sprite-sheets', () => {
    const base = makeVariantApprovalState();
    const state = parseThemeEquipmentSetState({
      ...base,
      phase: 'sprite-sheets',
      items: base.items.map((item) => ({
        ...item,
        phases: itemPhasesWith('sprite-sheets', [rawSheetArtifact(item.id)]),
      })),
    });

    const sources = selectCollectionTileSources(state);

    expect(sources).toHaveLength(state.items.length);
    expect(sources[0]).toEqual({
      key: 'sword-of-moonlight-v2/run-sword-of-moonlight/sheet-00.png',
      label: 'sword of Moonlight',
    });
  });

  it('throws for a phase without a contact sheet', () => {
    const state = makeVariantApprovalState();
    expect(() => selectCollectionTileSources({ ...state, phase: 'roster' })).toThrow(
      'does not support phase',
    );
    expect(() => selectCollectionTileSources({ ...state, phase: 'complete' })).toThrow(
      'does not support phase',
    );
  });
});

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

  it('at variant-approval judges one representative tile per item without regenerating', async () => {
    const store = memoryStore();
    const state = makeVariantApprovalState([[7, 2, 5], [4], [9, 3], [6, 1, 8], [2]]);
    for (const item of state.items) {
      for (const artifact of item.phases['variant-approval'].artifacts) {
        const filename = `processed/${String(artifact.variantIndex).padStart(2, '0')}.png`;
        await store.put(`${artifact.briefId}/${artifact.runId}/${filename}`, tinyPng());
      }
    }
    store.mem.set(themeEquipmentSetStateKey(state.id), Buffer.from(`${JSON.stringify(state)}\n`));
    store.puts = 0;
    const getSpy = vi.spyOn(store, 'get');
    const { runner: subject, evaluate } = runner(store);

    const result = await subject.runPhase(state.id);

    expect(evaluate).toHaveBeenCalledTimes(1);
    const fetchedProcessed = getSpy.mock.calls
      .map((call) => call[0])
      .filter((key) => key.includes('/processed/'));
    // One tile per ITEM, never per variant: with 3 approved variants each, the
    // old behavior fetched 3× the tiles and overflowed the 32-tile sheet cap.
    expect(fetchedProcessed).toHaveLength(state.items.length);
    expect(fetchedProcessed).toEqual(state.items.map(representativeKey));
    // The non-representative variants (e.g. index 7 and 5 for the sword) were
    // never fetched — only the lowest-index representative per item.
    expect(fetchedProcessed).not.toContain(
      'sword-of-moonlight-v2/run-sword-of-moonlight/processed/07.png',
    );
    expect(store.puts).toBe(1);
    expect(result.phases['variant-approval'].collectionJudge?.score).toBe(4);
  });
});
