/**
 * Tests for the theme-equipment-set pipeline orchestration
 * (`theme-equipment-pipeline.ts`): the phase runner, the deterministic
 * contact-sheet builder, the vision/text collection judges, and the atomic
 * publish path.
 */

import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import type { CheckinAsset, Exec, ExecResult } from '../../../scripts/sprites/checkin.js';
import type { QueueCommitDeps } from '../../../scripts/sprites/queue-commit.js';
import type {
  EvaluateRequest,
  VisionProvider,
} from '../../../scripts/sprites/provider/vision-types.js';
import {
  CONTACT_SHEET_MAX_TILES,
  ThemeEquipmentPipelineError,
  ThemeEquipmentPublishError,
  buildThemeEquipmentContactSheet,
  judgeThemeEquipmentCollectionWithText,
  judgeThemeEquipmentCollectionWithVision,
  publishThemeEquipmentSet,
  runThemeEquipmentSetPhase,
  type ContactSheetTile,
  type ThemeEquipmentItemExecutionResult,
  type ThemeEquipmentTextJudgeProvider,
} from '../../../scripts/sprites/theme-equipment-pipeline.js';
import {
  NON_HAND_EQUIPMENT_SLOT_IDS,
  THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
  THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  THEME_EQUIPMENT_SET_REVIEW_PHASES,
  applyThemeSetItemReview,
  emptyThemeEquipmentItemPhases,
  emptyThemeEquipmentSetPhases,
  emptyThemeEquipmentSetPublication,
  parseThemeEquipmentSetState,
  type ThemeEquipmentSetItem,
  type ThemeEquipmentSetState,
} from '../../../scripts/sprites/theme-equipment-set.js';

const NOW = '2026-07-25T04:07:30.322Z';
const WEAPON_TYPES = ['sword', 'bow', 'axe', 'staff', 'dagger'] as const;

function makeState(overrides: Partial<ThemeEquipmentSetState> = {}): ThemeEquipmentSetState {
  const slotItems = NON_HAND_EQUIPMENT_SLOT_IDS.slice(
    0,
    THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  ).map((slot) => ({
    id: `${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-relic`,
    displayName: `${slot} Relic`,
    kind: 'equipment' as const,
    slots: [slot],
    revision: 0,
    revisionStatus: 'open' as const,
    frozenPhases: [],
    phases: emptyThemeEquipmentItemPhases(),
  }));

  return parseThemeEquipmentSetState({
    schemaVersion: 1,
    id: 'moon-court-regalia',
    displayName: 'Moon Court Regalia',
    themeDesignLanguage: 'silver filigree, moth-wing silhouettes, and lunar enamel',
    phase: 'roster',
    items: [
      ...WEAPON_TYPES.map((weaponType) => ({
        id: `${weaponType}-of-moonlight`,
        displayName: `${weaponType} of Moonlight`,
        kind: 'weapon' as const,
        weaponType,
        revision: 0,
        revisionStatus: 'open' as const,
        frozenPhases: [],
        phases: emptyThemeEquipmentItemPhases(),
      })),
      ...slotItems,
    ],
    phases: emptyThemeEquipmentSetPhases(),
    stateRevision: 0,
    updatedAt: NOW,
    ...overrides,
  });
}

/**
 * Build a `complete`-phase state where every item already carries
 * `count` (default 1) `approved-variant` artifacts in its
 * `variant-approval` phase record — the shape `publishThemeEquipmentSet`
 * requires. `countOverrides` lets individual tests break one item's count
 * to exercise the variant-count gate.
 */
function makeCompleteState(countOverrides: Record<string, number> = {}): ThemeEquipmentSetState {
  const base = makeState();
  const items: ThemeEquipmentSetItem[] = base.items.map((item) => {
    const count = countOverrides[item.id] ?? 1;
    const approvedArtifacts = Array.from({ length: count }, (_unused, index) => ({
      id: `${item.id}-approved-${index}`,
      kind: THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
      uri: `run://${item.id}/variant-approval/${index}`,
      provenance: 'unit-test',
      briefId: `${item.id}-v2`,
      variantIndex: index * 3 + 2,
    }));
    return {
      ...item,
      revisionStatus: 'frozen',
      frozenPhases: [...THEME_EQUIPMENT_SET_REVIEW_PHASES],
      phases: {
        roster: {
          artifacts: [],
          evidence: [],
          review: { verdict: 'up' as const },
        },
        briefs: {
          artifacts: [
            {
              id: `${item.id}-brief-selected`,
              kind: 'selected-brief',
              uri: `run://${item.id}/briefs/brief.yaml`,
              provenance: 'unit-test',
            },
          ],
          evidence: [],
          review: { verdict: 'up' as const },
        },
        'sprite-sheets': {
          artifacts: [
            {
              id: `${item.id}-raw-sheet`,
              kind: 'raw-sheet',
              uri: `run://${item.id}/sprite-sheets/sheet-00.png`,
              provenance: 'unit-test',
              briefId: `${item.id}-v2`,
              runId: `run-${item.id}`,
              summary: 'sheet-00.png',
            },
          ],
          evidence: [],
          review: { verdict: 'up' as const },
        },
        'variant-approval': {
          artifacts: approvedArtifacts,
          evidence: [],
          review: { verdict: 'up' as const },
        },
      },
    };
  });

  const passedPhaseReview = {
    humanReview: { verdict: 'up' as const },
    collectionJudge: { score: 4 as const, rationale: 'cohesive', provenance: 'unit-test' },
  };

  return parseThemeEquipmentSetState({
    ...base,
    phase: 'complete',
    items,
    phases: {
      roster: passedPhaseReview,
      briefs: passedPhaseReview,
      'sprite-sheets': passedPhaseReview,
      'variant-approval': passedPhaseReview,
    },
    publication: emptyThemeEquipmentSetPublication(),
  });
}

/** Build the exact asset list `publishThemeEquipmentSet` expects for `state`. */
function assetsForState(state: ThemeEquipmentSetState): CheckinAsset[] {
  const assets: CheckinAsset[] = [];
  for (const item of state.items) {
    const approved = item.phases['variant-approval'].artifacts.filter(
      (artifact) => artifact.kind === THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
    );
    approved.forEach((artifact) => {
      assets.push({
        assetPath: `generated/${item.id}-var-${artifact.variantIndex}.png`,
        manifestKey: `${item.id}-var-${artifact.variantIndex}`,
        briefId: artifact.briefId!,
        variantIndex: artifact.variantIndex!,
      });
    });
  }
  return assets;
}

function tinyPng(r: number, g: number, b: number, alpha = 255, size = 2): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = alpha;
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// runThemeEquipmentSetPhase
// ---------------------------------------------------------------------------

describe('runThemeEquipmentSetPhase', () => {
  it('skips frozen/up items, executes every unresolved item, and judges the whole collection exactly once', async () => {
    const fresh = makeState();
    const frozenId = fresh.items[0]!.id;
    const upReview = applyThemeSetItemReview(fresh, frozenId, { verdict: 'up' });
    if (!upReview.ok) throw new Error('setup failed');
    const state = upReview.state;

    const executed: string[] = [];
    const executeItem = vi.fn(async (item) => {
      executed.push(item.id);
      const result: ThemeEquipmentItemExecutionResult = {
        artifacts: [
          {
            id: `${item.id}-roster-artifact`,
            kind: 'roster',
            uri: `run://${item.id}/roster`,
            provenance: 'unit-test',
          },
        ],
        evidence: [],
      };
      return result;
    });
    const judgeCollection = vi.fn(async (collectionState: ThemeEquipmentSetState) => {
      // The judge must see the FULL collection, including the untouched
      // frozen item, not just the freshly-executed ones.
      expect(collectionState.items.find((item) => item.id === frozenId)).toBeDefined();
      return { score: 4, rationale: 'cohesive', provenance: 'unit-test-judge' };
    });

    const result = await runThemeEquipmentSetPhase(state, executeItem, judgeCollection);

    expect(executed).not.toContain(frozenId);
    expect(executed).toHaveLength(state.items.length - 1);
    expect(judgeCollection).toHaveBeenCalledTimes(1);

    const frozenItem = result.items.find((item) => item.id === frozenId)!;
    expect(frozenItem.phases.roster.artifacts).toHaveLength(0); // never re-recorded

    const executedItem = result.items.find((item) => item.id === executed[0])!;
    expect(executedItem.phases.roster.artifacts).toHaveLength(1);
    expect(executedItem.phases.roster.artifacts[0]!.id).toBe(`${executed[0]}-roster-artifact`);

    expect(result.phases.roster.collectionJudge).toEqual({
      score: 4,
      rationale: 'cohesive',
      provenance: 'unit-test-judge',
    });
  });

  it('never mutates the input state', async () => {
    const state = makeState();
    const before = JSON.parse(JSON.stringify(state)) as unknown;
    await runThemeEquipmentSetPhase(
      state,
      async () => ({ artifacts: [], evidence: [] }),
      async () => ({ score: 3, rationale: 'fine', provenance: 'p' }),
    );
    expect(JSON.parse(JSON.stringify(state))).toEqual(before);
  });

  it('propagates the executor error unchanged and never calls the judge', async () => {
    const state = makeState();
    const boom = new Error('executor blew up');
    const judgeCollection = vi.fn();
    await expect(
      runThemeEquipmentSetPhase(
        state,
        async () => {
          throw boom;
        },
        judgeCollection,
      ),
    ).rejects.toBe(boom);
    expect(judgeCollection).not.toHaveBeenCalled();
  });

  it('propagates the judge error unchanged', async () => {
    const state = makeState();
    const boom = new Error('judge blew up');
    await expect(
      runThemeEquipmentSetPhase(
        state,
        async () => ({ artifacts: [], evidence: [] }),
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
  });

  it('throws a mutation-rejected ThemeEquipmentPipelineError when the executor output fails the artifact schema', async () => {
    const state = makeState();
    await expect(
      runThemeEquipmentSetPhase(
        state,
        // Missing required `uri`/`kind` fields — recordThemeSetItemPhaseArtifacts
        // must reject this, and the runner must surface it as a thrown error
        // rather than silently returning a half-updated state.
        async () => ({ artifacts: [{ id: 'bad' } as never], evidence: [] }),
        async () => ({ score: 3, rationale: 'fine', provenance: 'p' }),
      ),
    ).rejects.toMatchObject({ kind: 'mutation-rejected' });
  });

  it('refuses to run outside a review phase', async () => {
    const state = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });
    await expect(
      runThemeEquipmentSetPhase(
        state,
        async () => ({ artifacts: [], evidence: [] }),
        async () => ({ score: 3, rationale: 'fine', provenance: 'p' }),
      ),
    ).rejects.toMatchObject({ kind: 'not-a-review-phase' });
  });
});

// ---------------------------------------------------------------------------
// buildThemeEquipmentContactSheet
// ---------------------------------------------------------------------------

describe('buildThemeEquipmentContactSheet', () => {
  function tiles(n: number): ContactSheetTile[] {
    return Array.from({ length: n }, (_unused, index) => ({
      label: `tile-${index}`,
      png: tinyPng(index * 10, 0, 0),
    }));
  }

  it('is fully deterministic: identical input produces byte-identical output', () => {
    const input = tiles(5);
    const a = buildThemeEquipmentContactSheet(input);
    const b = buildThemeEquipmentContactSheet(input.map((tile) => ({ ...tile })));
    expect(a.png.equals(b.png)).toBe(true);
    expect(a.order).toEqual(b.order);
  });

  it('preserves the exact input order, never re-sorting by label', () => {
    const input: ContactSheetTile[] = [
      { label: 'zebra', png: tinyPng(1, 0, 0) },
      { label: 'apple', png: tinyPng(0, 1, 0) },
      { label: 'mango', png: tinyPng(0, 0, 1) },
    ];
    const result = buildThemeEquipmentContactSheet(input);
    expect(result.order).toEqual(['zebra', 'apple', 'mango']);
  });

  it('lays out a near-square grid sized off the largest tile', () => {
    const result = buildThemeEquipmentContactSheet(tiles(4));
    expect(result.columns).toBe(2);
    expect(result.rows).toBe(2);
  });

  it('rejects an empty tile list', () => {
    expect(() => buildThemeEquipmentContactSheet([])).toThrowError(ThemeEquipmentPipelineError);
    try {
      buildThemeEquipmentContactSheet([]);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as ThemeEquipmentPipelineError).kind).toBe('empty-contact-sheet');
    }
  });

  it('rejects more than the 32-tile maximum', () => {
    expect(() => buildThemeEquipmentContactSheet(tiles(CONTACT_SHEET_MAX_TILES + 1))).toThrowError(
      ThemeEquipmentPipelineError,
    );
    try {
      buildThemeEquipmentContactSheet(tiles(CONTACT_SHEET_MAX_TILES + 1));
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as ThemeEquipmentPipelineError).kind).toBe('contact-sheet-too-large');
    }
  });

  it('accepts exactly the 32-tile maximum', () => {
    const result = buildThemeEquipmentContactSheet(tiles(CONTACT_SHEET_MAX_TILES));
    expect(result.order).toHaveLength(CONTACT_SHEET_MAX_TILES);
  });

  it('produces a decodable PNG', () => {
    const result = buildThemeEquipmentContactSheet(tiles(3));
    const decoded = PNG.sync.read(result.png);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// judgeThemeEquipmentCollectionWithVision
// ---------------------------------------------------------------------------

describe('judgeThemeEquipmentCollectionWithVision', () => {
  function fakeProvider(json: unknown, modelDeployment = 'vision-test-deployment'): VisionProvider {
    return {
      modelDeployment,
      evaluate: vi.fn(async () => ({ json, usage: null, modelDeployment })),
    };
  }

  const tiles: ContactSheetTile[] = [
    { label: 'sword-of-moonlight', png: tinyPng(200, 200, 200) },
    { label: 'bow-of-moonlight', png: tinyPng(150, 150, 150) },
  ];

  it('sends exactly one contact-sheet image at temperature 0 and returns a stamped provenance', async () => {
    const provider = fakeProvider({ score: 4, rationale: 'cohesive and on-theme' });
    const result = await judgeThemeEquipmentCollectionWithVision({
      state: makeState(),
      tiles,
      provider,
      env: {},
    });

    expect(result).toEqual({
      score: 4,
      rationale: 'cohesive and on-theme',
      provenance: 'vision:vision-test-deployment',
    });
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    const request = (provider.evaluate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as EvaluateRequest;
    expect(request.temperature).toBe(0);
    expect(request.images).toHaveLength(1);
    expect(request.userPrompt).toMatch(/cohesion/i);
    expect(request.userPrompt).toMatch(/outlier/i);
    expect(request.userPrompt).toContain(
      'silver filigree, moth-wing silhouettes, and lunar enamel',
    );
  });

  it('grounds the collection-judge prompt against hallucinated false-negatives', async () => {
    const provider = fakeProvider({ score: 4, rationale: 'ok' });
    await judgeThemeEquipmentCollectionWithVision({
      state: makeState(),
      tiles,
      provider,
      env: {},
    });
    const request = (provider.evaluate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as EvaluateRequest;
    const prompt = request.userPrompt;
    // Still demands the two-part cohesion + outlier answer.
    expect(prompt).toMatch(/cohesion/i);
    expect(prompt).toMatch(/outlier/i);
    // Must not infer unseen surface properties (the "polished iron" failure).
    expect(prompt).toMatch(/do not infer/i);
    expect(prompt).toMatch(/polish/i);
    expect(prompt).toMatch(/reflectivity/i);
    // Must not penalize inherent form (the "bow is curved" failure).
    expect(prompt).toMatch(/inherent, correct form/i);
    expect(prompt).toMatch(/bow is curved/i);
    // Must tie any outlier to a named design-language clause.
    expect(prompt).toMatch(/name the clause/i);
    // The brittle hard cap that turned one claimed outlier into a veto is gone.
    expect(prompt).not.toMatch(/must not score above 2/i);
    expect(prompt).toMatch(/should not drop the score below 3/i);
  });

  it('throws malformed for a response missing the required shape', async () => {
    const provider = fakeProvider({ score: 4 }); // missing rationale
    await expect(
      judgeThemeEquipmentCollectionWithVision({ state: makeState(), tiles, provider, env: {} }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('throws malformed for an out-of-range score', async () => {
    const provider = fakeProvider({ score: 9, rationale: 'nope' });
    await expect(
      judgeThemeEquipmentCollectionWithVision({ state: makeState(), tiles, provider, env: {} }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('refuses to run under CI without the pipeline bypass', async () => {
    const provider = fakeProvider({ score: 4, rationale: 'fine' });
    await expect(
      judgeThemeEquipmentCollectionWithVision({
        state: makeState(),
        tiles,
        provider,
        env: { CI: 'true' },
      }),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    expect(provider.evaluate).not.toHaveBeenCalled();
  });

  it('rejects generic CI bypass alone and permits only the trusted theme workflow capability', async () => {
    const provider = fakeProvider({ score: 4, rationale: 'fine' });
    await expect(
      judgeThemeEquipmentCollectionWithVision({
        state: makeState(),
        tiles,
        provider,
        env: { CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'true' },
      }),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    const result = await judgeThemeEquipmentCollectionWithVision({
      state: makeState(),
      tiles,
      provider,
      env: {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        SPRITES_ALLOW_CI_THEME_PIPELINE: 'true',
        GITHUB_WORKFLOW_REF: 'nalfeo/Crawler/.github/workflows/theme-equipment.yml@refs/heads/main',
      },
    });
    expect(result.score).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// judgeThemeEquipmentCollectionWithText
// ---------------------------------------------------------------------------

describe('judgeThemeEquipmentCollectionWithText', () => {
  function fakeProvider(
    json: unknown,
    modelDeployment = 'text-test-deployment',
  ): ThemeEquipmentTextJudgeProvider {
    return {
      modelDeployment,
      complete: vi.fn(async () => ({ json, modelDeployment })),
    };
  }

  const summaries = [
    { label: 'sword-of-moonlight', text: 'A slender blade etched with lunar filigree.' },
    { label: 'bow-of-moonlight', text: 'A recurve bow carved from pale ashwood.' },
  ];

  it('sends one completion call and returns a stamped provenance', async () => {
    const provider = fakeProvider({ score: 5, rationale: 'every concept reads as one family' });
    const result = await judgeThemeEquipmentCollectionWithText({
      state: makeState(),
      summaries,
      provider,
      env: {},
    });
    expect(result).toEqual({
      score: 5,
      rationale: 'every concept reads as one family',
      provenance: 'text:text-test-deployment',
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const request = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(request.temperature).toBe(0);
    expect(request.userPrompt).toMatch(/cohesion/i);
    expect(request.userPrompt).toMatch(/outlier/i);
  });

  it('throws malformed for a non-object response', async () => {
    const provider = fakeProvider('not an object');
    await expect(
      judgeThemeEquipmentCollectionWithText({ state: makeState(), summaries, provider, env: {} }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('refuses to run under CI without the pipeline bypass', async () => {
    const provider = fakeProvider({ score: 4, rationale: 'fine' });
    await expect(
      judgeThemeEquipmentCollectionWithText({
        state: makeState(),
        summaries,
        provider,
        env: { CI: 'true' },
      }),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    expect(provider.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// publishThemeEquipmentSet
// ---------------------------------------------------------------------------

function makeFakeExec(
  responder: (command: string, args: readonly string[]) => Partial<ExecResult>,
): { exec: Exec; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = (command, args) => {
    calls.push({ command, args: [...args] });
    return Promise.resolve({ stdout: '', stderr: '', code: 0, ...responder(command, args) });
  };
  return { exec, calls };
}

function controlDeps(exec: Exec, overrides: Partial<QueueCommitDeps> = {}): QueueCommitDeps {
  return {
    exec,
    copyArtSurface: () => Promise.resolve(),
    makeTempDir: () => Promise.resolve('/tmp/qc-xyz'),
    removeDir: () => Promise.resolve(),
    withCrossProcessLock: (fn) => fn(),
    sleep: () => Promise.resolve(),
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

function happyResponder(_command: string, args: readonly string[]): Partial<ExecResult> {
  if (args[0] === 'ls-remote') return { stdout: '' };
  if (args[0] === 'diff') return { code: 1 };
  if (args[0] === 'rev-parse') return { stdout: 'commitsha123\n' };
  return {};
}

const FIXED_NOW = () => new Date('2026-08-01T00:00:00.000Z');

describe('publishThemeEquipmentSet', () => {
  it('is blocked before phase is complete', async () => {
    const state = makeState(); // phase: 'roster'
    const { exec, calls } = makeFakeExec(happyResponder);
    const publishAttempt = publishThemeEquipmentSet(state, {
      repoRoot: '/repo',
      sourceRoot: '/stage',
      assets: [],
      deps: controlDeps(exec),
      message: 'publish',
      now: FIXED_NOW,
    });
    await expect(publishAttempt).rejects.toMatchObject({ kind: 'not-complete' });
    await expect(publishAttempt).rejects.toBeInstanceOf(ThemeEquipmentPublishError);
    expect(calls).toHaveLength(0);
  });

  it('is blocked when publication is already published', async () => {
    const complete = makeCompleteState();
    const state = parseThemeEquipmentSetState({
      ...complete,
      publication: { status: 'published', publishedAt: NOW, queueCommit: 'abc' },
    });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'already-published' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when an item has zero approved-variant artifacts', async () => {
    const firstId = makeState().items[0]!.id;
    const state = makeCompleteState({ [firstId]: 0 });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'variant-count-invalid' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when an item has more than 3 approved-variant artifacts', async () => {
    const firstId = makeState().items[0]!.id;
    const state = makeCompleteState({ [firstId]: 4 });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'variant-count-invalid' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when a set-level collection judge score is below 3 in a prior phase', async () => {
    const complete = makeCompleteState();
    const state = parseThemeEquipmentSetState({
      ...complete,
      phases: {
        ...complete.phases,
        briefs: {
          ...complete.phases.briefs,
          collectionJudge: { score: 2, rationale: 'too generic', provenance: 'unit-test' },
        },
      },
    });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'phase-gates-not-satisfied' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when an item was not up-reviewed in a prior phase', async () => {
    const complete = makeCompleteState();
    const firstItem = complete.items[0]!;
    const state = parseThemeEquipmentSetState({
      ...complete,
      items: complete.items.map((item) =>
        item.id === firstItem.id
          ? {
              ...item,
              phases: {
                ...item.phases,
                roster: { ...item.phases.roster, review: { verdict: null } },
              },
            }
          : item,
      ),
    });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'phase-gates-not-satisfied' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when a set-level human review is absent in a prior phase', async () => {
    const complete = makeCompleteState();
    const state = parseThemeEquipmentSetState({
      ...complete,
      phases: {
        ...complete.phases,
        'sprite-sheets': {
          ...complete.phases['sprite-sheets'],
          humanReview: { verdict: null },
        },
      },
    });
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: assetsForState(state),
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'phase-gates-not-satisfied' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when an asset is missing for an approved variant', async () => {
    const state = makeCompleteState();
    const assets = assetsForState(state).slice(1); // drop the first asset
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets,
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'asset-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when an extra/unexpected asset is supplied', async () => {
    const state = makeCompleteState();
    const assets = [
      ...assetsForState(state),
      {
        assetPath: 'generated/unexpected-var-0.png',
        manifestKey: 'unexpected-var-0',
        briefId: 'unexpected-item',
        variantIndex: 0,
      },
    ];
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets,
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'asset-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('is blocked when a duplicate asset entry is supplied', async () => {
    const state = makeCompleteState();
    const assets = assetsForState(state);
    const duplicated = [...assets, assets[0]!];
    const { exec, calls } = makeFakeExec(happyResponder);
    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets: duplicated,
        deps: controlDeps(exec),
        message: 'publish',
        now: FIXED_NOW,
      }),
    ).rejects.toMatchObject({ kind: 'asset-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('invokes runQueueCommit exactly once with the full combined asset array and marks published only on success', async () => {
    const state = makeCompleteState();
    const assets = assetsForState(state);
    const { exec, calls } = makeFakeExec(happyResponder);

    const result = await publishThemeEquipmentSet(state, {
      repoRoot: '/repo',
      sourceRoot: '/stage',
      assets,
      deps: controlDeps(exec),
      message: 'publish classic-fantasy',
      now: FIXED_NOW,
    });

    expect(calls.filter((call) => call.args[0] === 'push')).toHaveLength(1);
    expect(result.queueResult.status).toBe('committed');
    expect(result.queueResult.attempts).toBe(1);
    expect(result.state.publication.status).toBe('published');
    expect(result.state.publication.publishedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(result.state.publication.queueCommit).toBe('commitsha123');

    // The original input state must be untouched — publish returns a new state.
    expect(state.publication.status).toBe('held');
  });

  it('preserves held publication state and propagates the error when runQueueCommit fails', async () => {
    const state = makeCompleteState();
    const assets = assetsForState(state);
    const { exec, calls } = makeFakeExec(() => ({ code: 1, stderr: 'network unreachable' }));

    await expect(
      publishThemeEquipmentSet(state, {
        repoRoot: '/repo',
        sourceRoot: '/stage',
        assets,
        deps: controlDeps(exec),
        message: 'publish classic-fantasy',
        now: FIXED_NOW,
      }),
    ).rejects.toThrow();

    expect(state.publication.status).toBe('held');
    expect(calls.some((call) => call.args[0] === 'push')).toBe(false);
  });
});
