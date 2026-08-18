import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NON_HAND_EQUIPMENT_SLOT_IDS,
  THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS,
  THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES,
  advanceThemeSetPhase,
  applyEditedThemeSetBrief,
  applyThemeSetItemReview,
  applyThemeSetPhaseCollectionJudge,
  applyThemeSetPhaseHumanReview,
  approveRemainingThemeSetPhase,
  buildThemeEquipmentSetStateFromPlan,
  canAdvanceThemeSet,
  emptyThemeEquipmentItemPhases,
  emptyThemeEquipmentSetPhases,
  emptyThemeEquipmentSetPublication,
  isThemeSetItemResolvedForPhase,
  loadThemeEquipmentSetPlan,
  loadThemeEquipmentSetState,
  markThemeEquipmentSetPublished,
  parseThemeEquipmentSetState,
  planApproveRemaining,
  planRunPhase,
  recordThemeSetItemPhaseArtifacts,
  recordThemeSetItemPhaseFailure,
  reviseRejectedThemeSetItem,
  saveThemeEquipmentSetState,
  themeEquipmentSetStateKey,
  themeSetItemAwaitsGeneration,
  themeSetItemHasPhaseOutput,
  validateThemeSetPlanMirrorSlots,
  type ThemeEquipmentSetReviewPhase,
  type ThemeEquipmentSetState,
} from '../../../scripts/sprites/theme-equipment-set.js';
import {
  StoreConditionalWriteError,
  StoreNotFoundError,
  type ConditionalWriteConditions,
  type RunStore,
} from '../../../scripts/sprites/store/types.js';
import { _getMirrorSlotForTests } from '../../../src/shared/equipment-slots.js';
import { CachingRunStore } from '../../../scripts/sprites/store/caching-store.js';
import { SharedResourceCache } from '../../../scripts/sprites/store/shared-cache.js';

const NOW = '2026-07-25T04:07:30.322Z';
const WEAPON_TYPES = ['sword', 'bow', 'axe', 'staff', 'dagger'] as const;

/**
 * A shared backend with genuine server-side compare-and-swap, matching how
 * Azure evaluates If-Match / If-None-Match. This is the ONLY store shape that
 * reaches the conditional-write branch of `saveThemeEquipmentSetState` — the
 * plain `makeStore()` double has no CAS methods and takes the fallback — so
 * without it the atomic path ships untested.
 */
function makeAtomicStore(): RunStore & {
  readonly mem: Map<string, { data: Buffer; etag: string }>;
} {
  const mem = new Map<string, { data: Buffer; etag: string }>();
  let nextEtag = 1;
  const commit = (key: string, data: Buffer): void => {
    mem.set(key, { data: Buffer.from(data), etag: `etag-${nextEtag++}` });
  };
  return {
    mem,
    backend: 'azure-blob',
    conditionalWrites: 'atomic',
    async put(key, data) {
      commit(key, data);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new StoreNotFoundError(key);
      return Buffer.from(value.data);
    },
    async getWithETag(key) {
      const value = mem.get(key);
      if (!value) throw new StoreNotFoundError(key);
      return { data: Buffer.from(value.data), etag: value.etag };
    },
    async putConditional(key, data, conditions: ConditionalWriteConditions) {
      const value = mem.get(key);
      if (conditions.ifNoneMatch === '*' && value !== undefined) {
        throw new StoreConditionalWriteError(`${key} already exists`);
      }
      if (conditions.ifMatch !== undefined && value?.etag !== conditions.ifMatch) {
        throw new StoreConditionalWriteError(`${key} etag mismatch`);
      }
      commit(key, data);
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

function makeStore(): RunStore & { readonly mem: Map<string, Buffer> } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    backend: 'local',
    async put(key, data) {
      mem.set(key, data);
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
      return key;
    },
  };
}

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

function cloneState(state: ThemeEquipmentSetState): ThemeEquipmentSetState {
  return parseThemeEquipmentSetState(JSON.parse(JSON.stringify(state)) as unknown);
}

/**
 * Directly sets an item's review verdict for the CURRENT phase, bypassing
 * `applyThemeSetItemReview`'s invalidation logic. Test-only setup so we can
 * arrange a specific starting verdict without wiping set-level approvals.
 */
function withItemVerdict(
  state: ThemeEquipmentSetState,
  itemIndex: number,
  verdict: 'up' | 'down' | null,
): ThemeEquipmentSetState {
  const phase = state.phase as ThemeEquipmentSetReviewPhase;
  const raw = JSON.parse(JSON.stringify(state)) as {
    items: { phases: Record<string, { review: { verdict: 'up' | 'down' | null } }> }[];
  };
  raw.items[itemIndex]!.phases[phase]!.review.verdict = verdict;
  return parseThemeEquipmentSetState(raw);
}

function readyForPhase(
  state: ThemeEquipmentSetState,
  phase: ThemeEquipmentSetReviewPhase = state.phase as ThemeEquipmentSetReviewPhase,
): ThemeEquipmentSetState {
  return parseThemeEquipmentSetState({
    ...state,
    phase,
    items: state.items.map((item) => ({
      ...item,
      phases: {
        ...item.phases,
        [phase]: {
          artifacts: [
            {
              id: `${item.id}-${phase}-artifact`,
              kind: phase,
              uri: `run://${item.id}/${phase}`,
              summary: 'review evidence',
              provenance: 'unit-test',
            },
          ],
          evidence: [
            {
              id: `${item.id}-${phase}-evidence`,
              kind: `${phase}-evidence`,
              uri: `evidence://${item.id}/${phase}`,
              provenance: 'unit-test',
            },
          ],
          review: { verdict: 'up' },
        },
      },
    })),
    phases: {
      ...state.phases,
      [phase]: {
        humanReview: { verdict: 'up' },
        collectionJudge: {
          score: 3,
          rationale: 'cohesive collection',
          provenance: 'unit-test',
        },
      },
    },
  });
}

describe('theme equipment set coverage validation', () => {
  it('derives the non-hand slot coverage threshold from SLOT_REGISTRY', () => {
    expect(NON_HAND_EQUIPMENT_SLOT_IDS).toHaveLength(8);
    expect(NON_HAND_EQUIPMENT_SLOT_IDS).not.toContain('mainHand');
    expect(NON_HAND_EQUIPMENT_SLOT_IDS).not.toContain('offHand');
    expect(THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS).toBe(6);
  });

  it('rejects insufficient weapon and non-hand slot coverage', () => {
    const valid = makeState();

    expect(() =>
      parseThemeEquipmentSetState({
        ...valid,
        items: valid.items.filter((item) => item.kind === 'weapon').slice(0, 4),
      }),
    ).toThrow(/weapon types/);
  });

  it('rejects unknown or hand slots, duplicate item ids, and invalid kebab ids', () => {
    const valid = makeState();
    expect(() =>
      parseThemeEquipmentSetState({
        ...valid,
        items: [
          ...valid.items,
          {
            ...valid.items[0],
            id: 'UPPERCASE',
          },
        ],
      }),
    ).toThrow(/stable lowercase kebab id/);

    expect(() =>
      parseThemeEquipmentSetState({
        ...valid,
        items: [...valid.items, { ...valid.items[0] }],
      }),
    ).toThrow(/duplicate item id/);

    const equipment = valid.items.find((item) => item.kind === 'equipment');
    expect(equipment).toBeDefined();
    expect(() =>
      parseThemeEquipmentSetState({
        ...valid,
        items: valid.items.map((item) =>
          item.id === equipment?.id && item.kind === 'equipment'
            ? { ...item, slots: ['mainHand'] }
            : item,
        ),
      }),
    ).toThrow(/unknown or hand equipment slot/);
  });
});

describe('theme equipment phase gates', () => {
  it('reports every blocker instead of returning only a boolean', () => {
    const check = canAdvanceThemeSet(makeState());

    expect(check.canAdvance).toBe(false);
    expect(check.fromPhase).toBe('roster');
    expect(check.toPhase).toBe('briefs');
    expect(check.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'item-review-not-up',
        'set-review-not-up',
        'collection-judge-missing',
      ]),
    );
  });

  it('blocks low collection judge scores', () => {
    const state = readyForPhase(makeState());
    const lowScore = parseThemeEquipmentSetState({
      ...state,
      phases: {
        ...state.phases,
        roster: {
          ...state.phases.roster,
          collectionJudge: {
            score: 2,
            rationale: 'not cohesive enough',
            provenance: 'unit-test',
          },
        },
      },
    });

    const check = canAdvanceThemeSet(lowScore);

    expect(check.canAdvance).toBe(false);
    expect(check.reasons.map((reason) => reason.code)).toContain('collection-judge-low-score');
  });

  it('advances one phase, freezes current items, and clears new phase review state', () => {
    const state = readyForPhase(makeState());
    const advanced = advanceThemeSetPhase(state);

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;

    expect(advanced.state.phase).toBe('briefs');
    expect(advanced.state.stateRevision).toBe(state.stateRevision + 1);
    for (const item of advanced.state.items) {
      expect(item.frozenPhases).toContain('roster');
      expect(item.revisionStatus).toBe('open');
      expect(item.phases.roster.review.verdict).toBe('up');
      expect(item.phases.roster.artifacts).toHaveLength(1);
      expect(item.phases.roster.evidence).toHaveLength(1);
      expect(item.phases.briefs.review.verdict).toBeNull();
      expect(item.phases.briefs.artifacts).toEqual([]);
      expect(item.phases.briefs.evidence).toEqual([]);
    }
    expect(advanced.state.phases.briefs.humanReview.verdict).toBeNull();
    expect(advanced.state.phases.briefs.collectionJudge).toBeNull();
  });

  it('completes only after variant approval passes', () => {
    const state = readyForPhase(makeState({ phase: 'variant-approval' }), 'variant-approval');
    const advanced = advanceThemeSetPhase(state);

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.state.phase).toBe('complete');
    expect(advanced.state.items.every((item) => item.revisionStatus === 'frozen')).toBe(true);
    expect(canAdvanceThemeSet(advanced.state).reasons.map((reason) => reason.code)).toContain(
      'phase-complete',
    );
  });
});

describe('theme equipment item revisions', () => {
  it('revises only down-reviewed items and clears current item evidence', () => {
    const base = readyForPhase(makeState());
    const rejectedId = base.items[0]!.id;
    const rejected = parseThemeEquipmentSetState({
      ...base,
      items: base.items.map((item) =>
        item.id === rejectedId
          ? {
              ...item,
              phases: {
                ...item.phases,
                roster: {
                  artifacts: [
                    {
                      id: 'rejected-artifact',
                      kind: 'roster',
                      uri: 'run://rejected',
                      provenance: 'unit-test',
                    },
                  ],
                  evidence: [
                    {
                      id: 'rejected-evidence',
                      kind: 'roster-evidence',
                      uri: 'evidence://rejected',
                      provenance: 'unit-test',
                    },
                  ],
                  review: { verdict: 'down', feedback: 'silhouette drifted' },
                },
              },
            }
          : item,
      ),
    });

    const revised = reviseRejectedThemeSetItem(rejected, rejectedId);

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const revisedItem = revised.state.items.find((item) => item.id === rejectedId);
    expect(revisedItem?.revision).toBe(1);
    expect(revisedItem?.phases.roster.review.verdict).toBeNull();
    expect(revisedItem?.phases.roster.artifacts).toEqual([]);
    expect(revisedItem?.phases.roster.evidence).toEqual([]);
  });

  it('refuses to revise up-reviewed or frozen items', () => {
    const state = readyForPhase(makeState());

    expect(reviseRejectedThemeSetItem(state, state.items[0]!.id)).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'item-not-rejected' })]),
    });

    const advanced = advanceThemeSetPhase(state);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(reviseRejectedThemeSetItem(advanced.state, state.items[0]!.id)).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'item-not-rejected' })]),
    });
  });

  it('invalidates set review and collection judge after a rejected item revision', () => {
    const base = readyForPhase(makeState());
    const rejectedId = base.items[0]!.id;
    const rejected = parseThemeEquipmentSetState({
      ...base,
      items: base.items.map((item) =>
        item.id === rejectedId
          ? {
              ...item,
              phases: {
                ...item.phases,
                roster: {
                  ...item.phases.roster,
                  review: { verdict: 'down' },
                },
              },
            }
          : item,
      ),
    });

    const revised = reviseRejectedThemeSetItem(rejected, rejectedId);

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.state.stateRevision).toBe(rejected.stateRevision + 1);
    expect(revised.state.phases.roster.humanReview.verdict).toBeNull();
    expect(revised.state.phases.roster.collectionJudge).toBeNull();
  });

  it('does not mutate inputs during advancement or revision', () => {
    const state = readyForPhase(makeState());
    const beforeAdvance = JSON.stringify(state);
    advanceThemeSetPhase(state);
    expect(JSON.stringify(state)).toBe(beforeAdvance);

    const rejectedId = state.items[0]!.id;
    const rejected = cloneState({
      ...state,
      items: state.items.map((item) =>
        item.id === rejectedId
          ? {
              ...item,
              phases: {
                ...item.phases,
                roster: {
                  ...item.phases.roster,
                  review: { verdict: 'down' },
                },
              },
            }
          : item,
      ),
    });
    const beforeRevision = JSON.stringify(rejected);
    reviseRejectedThemeSetItem(rejected, rejectedId);
    expect(JSON.stringify(rejected)).toBe(beforeRevision);
  });
});

describe('theme equipment set persistence', () => {
  it('round-trips state through RunStore using an injected clock', async () => {
    const store = makeStore();
    const saved = await saveThemeEquipmentSetState(store, makeState(), {
      expectedRevision: null,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    });

    expect(saved.updatedAt).toBe('2026-07-26T00:00:00.000Z');
    expect(store.mem.has(themeEquipmentSetStateKey(saved.id))).toBe(true);
    await expect(loadThemeEquipmentSetState(store, saved.id)).resolves.toEqual(saved);
  });

  it('fails closed on revision conflicts', async () => {
    const store = makeStore();
    const state = makeState();
    await saveThemeEquipmentSetState(store, state, {
      expectedRevision: null,
      now: () => new Date(NOW),
    });

    await expect(
      saveThemeEquipmentSetState(
        store,
        { ...state, stateRevision: 1 },
        {
          expectedRevision: 99,
          now: () => new Date(NOW),
        },
      ),
    ).rejects.toThrow(/revision conflict/);
  });

  it('refuses to write a shared backend that lacks ATOMIC conditional writes', async () => {
    // A wrapper can expose getWithETag/putConditional while the underlying
    // guarantee is weaker than server-side compare-and-swap (CachingRunStore
    // mirrors its inner store's capability). Feature detection alone would
    // happily take the CAS path and silently overwrite a concurrent writer, so
    // the capability flag — not method presence — must decide.
    const store = makeStore();
    const nonAtomic: RunStore = {
      ...store,
      backend: 'azure-blob',
      conditionalWrites: 'best-effort',
      async getWithETag(key) {
        return { data: await store.get(key), etag: 'etag-1' };
      },
      async putConditional(key, data) {
        await store.put(key, data);
      },
    };

    await expect(
      saveThemeEquipmentSetState(nonAtomic, makeState(), {
        expectedRevision: null,
        now: () => new Date(NOW),
      }),
    ).rejects.toThrow(/does not provide atomic conditional writes/);
    // Refused BEFORE any write — the authoritative document is untouched.
    expect(store.mem.size).toBe(0);
  });

  it('refuses a shared backend with no conditional-write methods at all', async () => {
    const store = makeStore();
    const plain: RunStore = { ...store, backend: 'azure-blob' };

    await expect(
      saveThemeEquipmentSetState(plain, makeState(), {
        expectedRevision: null,
        now: () => new Date(NOW),
      }),
    ).rejects.toThrow(/does not provide atomic conditional writes/);
    expect(store.mem.size).toBe(0);
  });

  it('creates and updates through server-side compare-and-swap on an atomic backend', async () => {
    const store = makeAtomicStore();
    const key = themeEquipmentSetStateKey(makeState().id);

    // First save is a create: guarded by ifNoneMatch:'*' so a racing creator
    // cannot be clobbered.
    const created = await saveThemeEquipmentSetState(store, makeState(), {
      expectedRevision: null,
      now: () => new Date(NOW),
    });
    expect(store.mem.has(key)).toBe(true);

    // Second save is an update: guarded by ifMatch against the ETag observed
    // during the read, so it commits only if nothing changed in between.
    const updated = await saveThemeEquipmentSetState(
      store,
      { ...created, stateRevision: created.stateRevision + 1 },
      { expectedRevision: created.stateRevision, now: () => new Date(NOW) },
    );
    expect(updated.stateRevision).toBe(created.stateRevision + 1);
    await expect(loadThemeEquipmentSetState(store, updated.id)).resolves.toEqual(updated);
  });

  it('rejects a stale writer on an atomic backend instead of overwriting the winner', async () => {
    const store = makeAtomicStore();
    const created = await saveThemeEquipmentSetState(store, makeState(), {
      expectedRevision: null,
      now: () => new Date(NOW),
    });

    // Another machine commits first.
    const winner = await saveThemeEquipmentSetState(
      store,
      { ...created, stateRevision: created.stateRevision + 1, displayName: 'Winner' },
      { expectedRevision: created.stateRevision, now: () => new Date(NOW) },
    );

    // This writer still believes the pre-winner revision is current. Losing the
    // race must surface as a conflict, never a silent overwrite — the whole
    // point of routing saves through conditional writes.
    await expect(
      saveThemeEquipmentSetState(
        store,
        { ...created, stateRevision: created.stateRevision + 1, displayName: 'Stale Overwrite' },
        { expectedRevision: created.stateRevision, now: () => new Date(NOW) },
      ),
    ).rejects.toThrow(/revision conflict/);

    await expect(loadThemeEquipmentSetState(store, winner.id)).resolves.toEqual(winner);
  });

  it('passes the atomicity gate through a CachingRunStore over an atomic backend', async () => {
    // The production shape: the wrapper must forward CAS and report the inner
    // store's capability, otherwise the hoisted gate refuses every real save.
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'crawler-theme-cas-'));
    try {
      const inner = makeAtomicStore();
      const store = new CachingRunStore({
        inner,
        cache: new SharedResourceCache({ cacheDir, maxBytes: 0, log: () => {} }),
      });
      expect(store.conditionalWrites).toBe('atomic');

      const saved = await saveThemeEquipmentSetState(store, makeState(), {
        expectedRevision: null,
        now: () => new Date(NOW),
      });
      await expect(loadThemeEquipmentSetState(store, saved.id)).resolves.toEqual(saved);
      // Written through to the authoritative backend, not just the cache.
      expect(inner.mem.has(themeEquipmentSetStateKey(saved.id))).toBe(true);
    } finally {
      await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('theme equipment set publication defaults', () => {
  it('defaults publication to a fresh held record when omitted from stored/legacy input', () => {
    const raw = JSON.parse(JSON.stringify(makeState())) as Record<string, unknown>;
    delete raw.publication;

    const parsed = parseThemeEquipmentSetState(raw);

    expect(parsed.publication).toEqual(emptyThemeEquipmentSetPublication());
  });

  it('gives each parse its own publication object rather than a shared reference', () => {
    const raw = JSON.parse(JSON.stringify(makeState())) as Record<string, unknown>;
    delete raw.publication;

    const a = parseThemeEquipmentSetState(raw);
    const b = parseThemeEquipmentSetState(raw);

    expect(a.publication).not.toBe(b.publication);
  });
});

describe('theme equipment item phase artifact recording', () => {
  it('records artifacts/evidence, clears the item review, and invalidates set-level review + judge', () => {
    const state = readyForPhase(makeState());
    const itemId = state.items[0]!.id;
    // Re-open the target item so recording is permitted (readyForPhase
    // stamps every item as up-reviewed).
    const opened = parseThemeEquipmentSetState({
      ...state,
      items: state.items.map((item) =>
        item.id === itemId
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

    const result = recordThemeSetItemPhaseArtifacts(
      opened,
      itemId,
      [{ id: 'new-artifact', kind: 'roster', uri: 'run://new', provenance: 'unit-test' }],
      [
        {
          id: 'new-evidence',
          kind: 'roster-evidence',
          uri: 'evidence://new',
          provenance: 'unit-test',
        },
      ],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.stateRevision).toBe(opened.stateRevision + 1);
    const item = result.state.items.find((candidate) => candidate.id === itemId);
    expect(item?.phases.roster.artifacts).toEqual([
      { id: 'new-artifact', kind: 'roster', uri: 'run://new', provenance: 'unit-test' },
    ]);
    expect(item?.phases.roster.evidence).toEqual([
      {
        id: 'new-evidence',
        kind: 'roster-evidence',
        uri: 'evidence://new',
        provenance: 'unit-test',
      },
    ]);
    expect(item?.phases.roster.review.verdict).toBeNull();
    // Other items are untouched.
    const other = result.state.items.find((candidate) => candidate.id !== itemId)!;
    expect(other.phases.roster.review.verdict).toBe('up');
    // Set-level human review + collection judge are both invalidated.
    expect(result.state.phases.roster.humanReview.verdict).toBeNull();
    expect(result.state.phases.roster.collectionJudge).toBeNull();
  });

  it('refuses to record artifacts for an up-reviewed (resolved) item', () => {
    const state = readyForPhase(makeState());
    const itemId = state.items[0]!.id;
    expect(isThemeSetItemResolvedForPhase(state.items[0]!, 'roster')).toBe(true);

    const result = recordThemeSetItemPhaseArtifacts(state, itemId, [], []);

    expect(result).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'item-already-resolved' })]),
    });
  });

  it('refuses to record artifacts for a frozen item (frozenPhases contains the current phase)', () => {
    const advanced = advanceThemeSetPhase(readyForPhase(makeState()));
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    // Items are now in "briefs" but still carry "roster" in frozenPhases.
    const item = advanced.state.items[0]!;
    expect(item.frozenPhases).toContain('roster');
    expect(isThemeSetItemResolvedForPhase(item, 'roster')).toBe(true);
  });

  it('rejects malformed artifact/evidence payloads without mutating input', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    const itemId = state.items[0]!.id;

    const result = recordThemeSetItemPhaseArtifacts(state, itemId, [{ bogus: true }], []);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    const itemId = state.items[0]!.id;

    recordThemeSetItemPhaseArtifacts(
      state,
      itemId,
      [{ id: 'a', kind: 'roster', uri: 'run://a' }],
      [{ id: 'b', kind: 'roster-evidence', uri: 'evidence://b' }],
    );

    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('theme equipment item human review application', () => {
  it('applies an up verdict, which resolves/freezes the item for the current phase', () => {
    const state = makeState();
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.stateRevision).toBe(state.stateRevision + 1);
    const item = result.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.phases.roster.review.verdict).toBe('up');
    expect(isThemeSetItemResolvedForPhase(item, 'roster')).toBe(true);
  });

  it('applies a down verdict with feedback, leaving the item open (not resolved)', () => {
    const state = makeState();
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, {
      verdict: 'down',
      feedback: 'silhouette drifted from the design language',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.phases.roster.review.verdict).toBe('down');
    expect(item.phases.roster.review.feedback).toBe('silhouette drifted from the design language');
    expect(isThemeSetItemResolvedForPhase(item, 'roster')).toBe(false);
  });

  it('applying a null verdict clears a prior verdict and leaves the item open', () => {
    const upped = applyThemeSetItemReview(makeState(), makeState().items[0]!.id, { verdict: 'up' });
    expect(upped.ok).toBe(true);
    if (!upped.ok) return;
    const itemId = upped.state.items[0]!.id;

    const cleared = applyThemeSetItemReview(upped.state, itemId, { verdict: null });

    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const item = cleared.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.phases.roster.review.verdict).toBeNull();
    expect(isThemeSetItemResolvedForPhase(item, 'roster')).toBe(false);
  });

  it('invalidates both set-level approvals when an up-vote is withdrawn (up→down)', () => {
    const state = readyForPhase(makeState());
    const itemId = state.items[0]!.id;
    expect(state.phases.roster.humanReview.verdict).toBe('up');
    expect(state.phases.roster.collectionJudge).not.toBeNull();

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'down' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.collectionJudge).toBeNull();
    expect(result.state.phases.roster.humanReview.verdict).toBeNull();
  });

  it('invalidates both set-level approvals when an up-vote is withdrawn (up→null)', () => {
    const state = readyForPhase(makeState());
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.collectionJudge).toBeNull();
    expect(result.state.phases.roster.humanReview.verdict).toBeNull();
  });

  it('preserves set-level approvals on a non-withdrawing verdict change (null→up)', () => {
    const state = withItemVerdict(readyForPhase(makeState()), 0, null);
    const itemId = state.items[0]!.id;
    expect(state.phases.roster.humanReview.verdict).toBe('up');

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('preserves set-level approvals on a non-withdrawing verdict change (null→down)', () => {
    const state = withItemVerdict(readyForPhase(makeState()), 0, null);
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'down' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('preserves set-level approvals on a non-withdrawing verdict change (down→null)', () => {
    const state = withItemVerdict(readyForPhase(makeState()), 0, 'down');
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('preserves set-level approvals on a non-withdrawing verdict change (down→up)', () => {
    const state = withItemVerdict(readyForPhase(makeState()), 0, 'down');
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('leaves the set-level collection judge untouched when the verdict does not change', () => {
    const state = readyForPhase(makeState());
    const itemId = state.items[0]!.id;

    const result = applyThemeSetItemReview(state, itemId, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('rejects an unknown item id and does not mutate the input', () => {
    const state = makeState();
    const before = JSON.stringify(state);

    const result = applyThemeSetItemReview(state, 'not-a-real-item', { verdict: 'up' });

    expect(result).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'item-not-found' })]),
    });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('theme equipment set-level human review and collection judge application', () => {
  it('applies the set-level human review and bumps the revision', () => {
    const state = makeState();

    const result = applyThemeSetPhaseHumanReview(state, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.stateRevision).toBe(state.stateRevision + 1);
  });

  it('applies the collection judge result and bumps the revision', () => {
    const state = makeState();

    const result = applyThemeSetPhaseCollectionJudge(state, {
      score: 4,
      rationale: 'cohesive silhouettes, one confident outlier',
      provenance: 'vision:gpt-4o-mini',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phases.roster.collectionJudge).toEqual({
      score: 4,
      rationale: 'cohesive silhouettes, one confident outlier',
      provenance: 'vision:gpt-4o-mini',
    });
    expect(result.state.stateRevision).toBe(state.stateRevision + 1);
  });

  it('rejects a malformed collection judge payload without mutating input', () => {
    const state = makeState();
    const before = JSON.stringify(state);

    const result = applyThemeSetPhaseCollectionJudge(state, { score: 7, rationale: '' });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuses to apply set-level review/judge outside a review phase', () => {
    const complete = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });

    expect(applyThemeSetPhaseHumanReview(complete, { verdict: 'up' })).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'phase-not-reviewable' })]),
    });
    expect(
      applyThemeSetPhaseCollectionJudge(complete, { score: 5, rationale: 'x', provenance: 'y' }),
    ).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'phase-not-reviewable' })]),
    });
  });
});

describe('theme equipment set publication mutation', () => {
  it('blocks publication before phase is complete', () => {
    const state = readyForPhase(makeState());

    const result = markThemeEquipmentSetPublished(state, {
      publishedAt: '2026-08-01T00:00:00.000Z',
      queueCommit: 'abc123',
    });

    expect(result).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'not-complete' })]),
    });
  });

  it('marks a complete, held theme set as published and bumps the revision', () => {
    const advanced = advanceThemeSetPhase(
      readyForPhase(makeState({ phase: 'variant-approval' }), 'variant-approval'),
    );
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.state.phase).toBe('complete');
    expect(advanced.state.publication).toEqual(emptyThemeEquipmentSetPublication());

    const result = markThemeEquipmentSetPublished(advanced.state, {
      publishedAt: '2026-08-01T00:00:00.000Z',
      queueCommit: 'abc123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.publication).toEqual({
      status: 'published',
      publishedAt: '2026-08-01T00:00:00.000Z',
      queueCommit: 'abc123',
    });
    expect(result.state.stateRevision).toBe(advanced.state.stateRevision + 1);
  });

  it('refuses to publish a second time once already published', () => {
    const advanced = advanceThemeSetPhase(
      readyForPhase(makeState({ phase: 'variant-approval' }), 'variant-approval'),
    );
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const published = markThemeEquipmentSetPublished(advanced.state, {
      publishedAt: '2026-08-01T00:00:00.000Z',
      queueCommit: 'abc123',
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const result = markThemeEquipmentSetPublished(published.state, {
      publishedAt: '2026-08-02T00:00:00.000Z',
      queueCommit: 'def456',
    });

    expect(result).toEqual({
      ok: false,
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'already-published' })]),
    });
  });

  it('does not mutate the input state', () => {
    const advanced = advanceThemeSetPhase(
      readyForPhase(makeState({ phase: 'variant-approval' }), 'variant-approval'),
    );
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const before = JSON.stringify(advanced.state);

    markThemeEquipmentSetPublished(advanced.state, {
      publishedAt: '2026-08-01T00:00:00.000Z',
      queueCommit: null,
    });

    expect(JSON.stringify(advanced.state)).toBe(before);
  });
});

describe('buildThemeEquipmentSetStateFromPlan', () => {
  const minimalPlan = {
    id: 'plan-fixture',
    displayName: 'Plan Fixture',
    themeDesignLanguage: 'weathered leather and dull brass, no gemstones',
    weapons: WEAPON_TYPES.map((weaponType) => ({
      id: `${weaponType}-of-plan`,
      displayName: `${weaponType} of Plan`,
      weaponType,
    })),
    equipment: (() => {
      // One item per slot, EXCEPT mirror pairs which become a single unified item
      // covering both sides (required by the plan schema's mirror rule).
      const covered = new Set<string>();
      const items: Array<{ id: string; displayName: string; slots: string[] }> = [];
      for (const slot of NON_HAND_EQUIPMENT_SLOT_IDS) {
        if (covered.has(slot)) continue;
        const partner = _getMirrorSlotForTests(slot);
        const slots = partner ? [slot, partner] : [slot];
        for (const s of slots) covered.add(s);
        items.push({
          id: `${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-plan-item`,
          displayName: `${slot} Plan Item`,
          slots,
        });
      }
      return items;
    })(),
  };

  it('expands a plan into a valid, empty roster-phase state', () => {
    const state = buildThemeEquipmentSetStateFromPlan(minimalPlan, { updatedAt: NOW });

    expect(state.phase).toBe('roster');
    expect(state.stateRevision).toBe(0);
    expect(state.publication).toEqual(emptyThemeEquipmentSetPublication());
    expect(state.items).toHaveLength(minimalPlan.weapons.length + minimalPlan.equipment.length);
    for (const item of state.items) {
      expect(item.revision).toBe(0);
      expect(item.revisionStatus).toBe('open');
      expect(item.frozenPhases).toEqual([]);
      expect(item.phases.roster.artifacts).toEqual([]);
      expect(item.phases.roster.review.verdict).toBeNull();
    }
  });

  it('rejects a plan with too few distinct weapon types or slots via parseThemeEquipmentSetState', () => {
    const tinyPlan = {
      ...minimalPlan,
      weapons: minimalPlan.weapons.slice(0, 1),
      equipment: minimalPlan.equipment.slice(0, 1),
    };
    expect(() => buildThemeEquipmentSetStateFromPlan(tinyPlan, { updatedAt: NOW })).toThrow();
  });

  it('rejects a malformed plan shape', () => {
    expect(() => buildThemeEquipmentSetStateFromPlan({ id: 'bad' }, { updatedAt: NOW })).toThrow();
  });
});

describe('mirror-pair unified-slot authoring rule', () => {
  // Self-contained plan factory (minimalPlan is scoped to another describe).
  function unifiedPlan() {
    const covered = new Set<string>();
    const equipment: Array<{ id: string; displayName: string; slots: string[] }> = [];
    for (const slot of NON_HAND_EQUIPMENT_SLOT_IDS) {
      if (covered.has(slot)) continue;
      const partner = _getMirrorSlotForTests(slot);
      const slots = partner ? [slot, partner] : [slot];
      for (const s of slots) covered.add(s);
      equipment.push({
        id: `${slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-item`,
        displayName: `${slot} Item`,
        slots,
      });
    }
    return {
      id: 'mirror-fixture',
      displayName: 'Mirror Fixture',
      themeDesignLanguage: 'plain weathered leather and dull brass',
      weapons: WEAPON_TYPES.map((weaponType) => ({
        id: `${weaponType}-fixture`,
        displayName: `${weaponType} Fixture`,
        weaponType,
      })),
      equipment,
    };
  }

  it('validateThemeSetPlanMirrorSlots accepts the active slot contract', () => {
    expect(
      validateThemeSetPlanMirrorSlots([
        { id: 'gloves', slots: ['gloves'] },
        { id: 'rings', slots: ['ring1', 'ring2'] },
        { id: 'helm', slots: ['head'] },
      ]),
    ).toEqual([]);
  });

  it('does not report retired mirror slots', () => {
    expect(validateThemeSetPlanMirrorSlots([{ id: 'ring', slots: ['ring1'] }])).toEqual([]);
  });

  it('build accepts a plan using the active slots', () => {
    const base = unifiedPlan();
    const activePlan = {
      ...base,
      equipment: [
        ...base.equipment,
        { id: 'extra-ring', displayName: 'Extra Ring', slots: ['ring2'] },
      ],
    };
    expect(() => buildThemeEquipmentSetStateFromPlan(activePlan, { updatedAt: NOW })).not.toThrow();
  });

  it('build accepts the coalesced unified-mirror fixture', () => {
    expect(() =>
      buildThemeEquipmentSetStateFromPlan(unifiedPlan(), { updatedAt: NOW }),
    ).not.toThrow();
  });

  it('state-load path accepts the active slot contract', () => {
    expect(() => cloneState(makeState())).not.toThrow();
  });
});

describe('every committed theme-equipment plan', () => {
  const planIds = ['classic-fantasy', 'classic-fantasy-basic-leather', 'edo-samurai'] as const;
  it.each(planIds)('%s loads and builds without a mirror-slot violation', (planId) => {
    const plan = loadThemeEquipmentSetPlan(planId);
    expect(validateThemeSetPlanMirrorSlots(plan.equipment)).toEqual([]);
    expect(() => buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW })).not.toThrow();
  });
});

describe('Classic Fantasy authored theme-equipment plan fixture', () => {
  it('loads and expands into a valid state meeting the 5-weapon/11-slot coverage gates', () => {
    const plan = loadThemeEquipmentSetPlan('classic-fantasy');

    expect(plan.id).toBe('classic-fantasy');
    expect(plan.themeDesignLanguage.length).toBeGreaterThan(0);

    const distinctWeaponTypes = new Set(plan.weapons.map((weapon) => weapon.weaponType));
    expect(distinctWeaponTypes.size).toBeGreaterThanOrEqual(THEME_EQUIPMENT_SET_MIN_WEAPON_TYPES);

    const distinctSlots = new Set(plan.equipment.flatMap((equipment) => equipment.slots));
    expect(distinctSlots.size).toBeGreaterThanOrEqual(THEME_EQUIPMENT_SET_MIN_NON_HAND_SLOTS);

    expect(plan.weapons.length + plan.equipment.length).toBeLessThanOrEqual(32);

    const state = buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW });
    expect(state.id).toBe('classic-fantasy');
    expect(state.phase).toBe('roster');
    expect(state.publication.status).toBe('held');
  });
});

describe('approve remaining (bulk up-vote)', () => {
  it('plans every not-yet-reviewed, eligible item in the current phase', () => {
    const state = makeState(); // roster phase, all verdicts null, no required artifact

    const plan = planApproveRemaining(state);

    expect(plan.phase).toBe('roster');
    expect(plan.count).toBe(state.items.length);
    expect(plan.approvableIds).toHaveLength(state.items.length);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.alreadyUpIds).toHaveLength(0);
  });

  it('skips rejected items and counts already-up items separately', () => {
    const withDown = withItemVerdict(makeState(), 0, 'down');
    const state = withItemVerdict(withDown, 1, 'up');

    const plan = planApproveRemaining(state);

    expect(plan.alreadyUpIds).toEqual([state.items[1]!.id]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ id: state.items[0]!.id, code: 'item-rejected' }),
    ]);
    expect(plan.count).toBe(state.items.length - 2);
    expect(plan.approvableIds).not.toContain(state.items[0]!.id);
    expect(plan.approvableIds).not.toContain(state.items[1]!.id);
  });

  it('skips items missing the required phase artifact with a reason', () => {
    // briefs phase but readyForPhase adds a `briefs`-kind artifact, NOT `selected-brief`.
    const ready = readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
    const state = withItemVerdict(ready, 0, null);

    const plan = planApproveRemaining(state);

    expect(plan.phase).toBe('briefs');
    expect(plan.count).toBe(0);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ id: state.items[0]!.id, code: 'item-missing-phase-artifact' }),
    ]);
  });

  it('returns an empty plan for a non-review phase', () => {
    const complete = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });

    const plan = planApproveRemaining(complete);

    expect(plan.phase).toBeNull();
    expect(plan.count).toBe(0);
  });

  it('approves every eligible item in one revision bump and preserves set-level review', () => {
    const state = withItemVerdict(readyForPhase(makeState()), 0, null);
    expect(state.phases.roster.humanReview.verdict).toBe('up');

    const result = approveRemainingThemeSetPhase(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.approvedIds).toEqual([state.items[0]!.id]);
    expect(result.state.items[0]!.phases.roster.review.verdict).toBe('up');
    expect(result.state.stateRevision).toBe(state.stateRevision + 1);
    // null→up is never a withdrawal → set-level review stays intact.
    expect(result.state.phases.roster.humanReview.verdict).toBe('up');
    expect(result.state.phases.roster.collectionJudge).toEqual(state.phases.roster.collectionJudge);
  });

  it('is a no-op (no revision bump) when there is nothing to approve', () => {
    const state = readyForPhase(makeState()); // every item already up

    const result = approveRemainingThemeSetPhase(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.approvedIds).toHaveLength(0);
    expect(result.state.stateRevision).toBe(state.stateRevision);
    expect(result.state).toEqual(state);
  });

  it('refuses to bulk-approve outside a review phase', () => {
    const complete = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });

    const result = approveRemainingThemeSetPhase(complete);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'phase-not-reviewable' })]),
    );
  });
});

describe('recordThemeSetItemPhaseFailure (graceful per-item degradation marker)', () => {
  it('marks the current-phase generationError, bumps the revision, and preserves artifacts/review', () => {
    // Give item 0 stale artifacts + a null verdict (an unresolved item), then
    // fail it. The marker must attach without touching those artifacts.
    const withArtifacts = parseThemeEquipmentSetState({
      ...makeState(),
      items: makeState().items.map((item, index) =>
        index === 0
          ? {
              ...item,
              phases: {
                ...item.phases,
                roster: {
                  artifacts: [
                    { id: 'stale', kind: 'roster', uri: 'run://stale', provenance: 'unit-test' },
                  ],
                  evidence: [],
                  review: { verdict: null },
                },
              },
            }
          : item,
      ),
    });
    const itemId = withArtifacts.items[0]!.id;

    const result = recordThemeSetItemPhaseFailure(withArtifacts, itemId, '0 acceptable variants');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.stateRevision).toBe(withArtifacts.stateRevision + 1);
    const item = result.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.phases.roster.generationError).toEqual({ message: '0 acceptable variants' });
    // Artifacts, evidence, and verdict are all untouched by the marker.
    expect(item.phases.roster.artifacts).toEqual([
      { id: 'stale', kind: 'roster', uri: 'run://stale', provenance: 'unit-test' },
    ]);
    expect(item.phases.roster.review.verdict).toBeNull();
    // Set-level review is not touched either.
    expect(result.state.phases.roster.humanReview.verdict).toBeNull();
  });

  it('falls back to a generic message when the failure message is blank', () => {
    const state = makeState();
    const itemId = state.items[0]!.id;

    const result = recordThemeSetItemPhaseFailure(state, itemId, '   ');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.phases.roster.generationError).toEqual({ message: 'Generation failed' });
  });

  it('refuses an unknown item id without mutating input', () => {
    const state = makeState();
    const before = JSON.stringify(state);

    const result = recordThemeSetItemPhaseFailure(state, 'not-a-real-item', 'boom');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'item-not-found' })]),
    );
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuses to mark a resolved (up-reviewed) item', () => {
    const state = readyForPhase(makeState()); // every item up-reviewed/frozen
    const itemId = state.items[0]!.id;

    const result = recordThemeSetItemPhaseFailure(state, itemId, 'boom');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'item-already-resolved' })]),
    );
  });

  it('refuses to mark during a non-review phase', () => {
    const complete = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });

    const result = recordThemeSetItemPhaseFailure(complete, complete.items[0]!.id, 'boom');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'phase-not-recordable' })]),
    );
  });
});

describe('generation-failure marker lifecycle', () => {
  /** Attaches a generationError marker to item `index` for the current phase. */
  function withFailure(state: ThemeEquipmentSetState, index: number): ThemeEquipmentSetState {
    const itemId = state.items[index]!.id;
    const result = recordThemeSetItemPhaseFailure(state, itemId, 'no acceptable variants');
    if (!result.ok) throw new Error('withFailure setup failed');
    return result.state;
  }

  it('excludes a failed item (even with stale artifacts) from the bulk-approve plan', () => {
    // briefs phase with a real `selected-brief` artifact so the item WOULD be
    // approvable — except the failure marker must exclude it.
    const ready = parseThemeEquipmentSetState({
      ...makeState({ phase: 'briefs' }),
      items: makeState({ phase: 'briefs' }).items.map((item, index) =>
        index === 0
          ? {
              ...item,
              phases: {
                ...item.phases,
                briefs: {
                  artifacts: [
                    {
                      id: `${item.id}-brief`,
                      kind: 'selected-brief',
                      uri: `run://${item.id}/brief`,
                      provenance: 'unit-test',
                    },
                  ],
                  evidence: [],
                  review: { verdict: null },
                },
              },
            }
          : item,
      ),
    });
    const failed = withFailure(ready, 0);
    const itemId = failed.items[0]!.id;

    const plan = planApproveRemaining(failed);

    expect(plan.approvableIds).not.toContain(itemId);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: itemId, code: 'item-generation-failed' }),
      ]),
    );
  });

  it('clears the marker on an explicit up-vote', () => {
    // Arrange a failed item that also has the required artifact so an up-vote
    // is permitted.
    const ready = parseThemeEquipmentSetState({
      ...makeState({ phase: 'briefs' }),
      items: makeState({ phase: 'briefs' }).items.map((item, index) =>
        index === 0
          ? {
              ...item,
              phases: {
                ...item.phases,
                briefs: {
                  artifacts: [
                    {
                      id: `${item.id}-brief`,
                      kind: 'selected-brief',
                      uri: `run://${item.id}/brief`,
                      provenance: 'unit-test',
                    },
                  ],
                  evidence: [],
                  review: { verdict: null },
                },
              },
            }
          : item,
      ),
    });
    const failed = withFailure(ready, 0);
    const itemId = failed.items[0]!.id;
    expect(failed.items[0]!.phases.briefs.generationError).not.toBeNull();

    const result = applyThemeSetItemReview(failed, itemId, { verdict: 'up' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.items[0]!.phases.briefs.generationError).toBeNull();
  });

  it('preserves the marker on a null or down verdict', () => {
    const failed = withFailure(makeState(), 0);
    const itemId = failed.items[0]!.id;

    const down = applyThemeSetItemReview(failed, itemId, { verdict: 'down' });
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    expect(down.state.items[0]!.phases.roster.generationError).toEqual({
      message: 'no acceptable variants',
    });

    const cleared = applyThemeSetItemReview(failed, itemId, { verdict: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state.items[0]!.phases.roster.generationError).toEqual({
      message: 'no acceptable variants',
    });
  });

  it('clears the marker when the item is successfully regenerated', () => {
    const failed = withFailure(makeState(), 0);
    const itemId = failed.items[0]!.id;

    const regen = recordThemeSetItemPhaseArtifacts(
      failed,
      itemId,
      [{ id: 'fresh', kind: 'roster', uri: 'run://fresh', provenance: 'unit-test' }],
      [],
    );

    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    expect(regen.state.items[0]!.phases.roster.generationError).toBeNull();
  });
});

describe('planRunPhase (truthful Run-button plan)', () => {
  it('reports judge-only when every item is resolved but the collection judge is missing', () => {
    const ready = readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
    const state = parseThemeEquipmentSetState({
      ...ready,
      phases: {
        ...ready.phases,
        briefs: { ...ready.phases.briefs, collectionJudge: null },
      },
    });

    const plan = planRunPhase(state);

    expect(plan.phase).toBe('briefs');
    expect(plan.regenerateCount).toBe(0);
    expect(plan.judgeOnly).toBe(true);
    expect(plan.collectionJudgeMissing).toBe(true);
  });

  it('counts every unresolved never-generated item as a generation (roster has no artifacts)', () => {
    // roster phase, every verdict null and no artifacts → every item is
    // unresolved AND never generated, so it is a generation, not a regeneration.
    const state = makeState();

    const plan = planRunPhase(state);

    expect(plan.phase).toBe('roster');
    expect(plan.generateCount).toBe(state.items.length);
    expect(plan.regenerateCount).toBe(0);
    expect(plan.judgeOnly).toBe(false);
    expect(plan.collectionJudgeMissing).toBe(true);
  });

  it('counts an unresolved item that already has output as a regeneration', () => {
    // briefs phase: give every item a briefs artifact (output exists) but leave
    // verdicts null → unresolved WITH output → regeneration, not generation.
    const withOutput = parseThemeEquipmentSetState({
      ...readyForPhase(makeState({ phase: 'briefs' }), 'briefs'),
      items: readyForPhase(makeState({ phase: 'briefs' }), 'briefs').items.map((item) => ({
        ...item,
        phases: { ...item.phases, briefs: { ...item.phases.briefs, review: { verdict: null } } },
      })),
    });

    const plan = planRunPhase(withOutput);

    expect(plan.phase).toBe('briefs');
    expect(plan.generateCount).toBe(0);
    expect(plan.regenerateCount).toBe(withOutput.items.length);
    expect(plan.judgeOnly).toBe(false);
  });

  it('keeps generateCount + regenerateCount === the unresolved count in a mixed state', () => {
    // Start from a fully-ready briefs set (all up, all have output), then knock
    // two items back to unresolved: one keeps its output (regenerate), one has
    // its output stripped (generate).
    const ready = readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
    const raw = JSON.parse(JSON.stringify(ready)) as {
      items: {
        phases: Record<string, { artifacts: unknown[]; review: { verdict: 'up' | 'down' | null } }>;
      }[];
    };
    raw.items[0]!.phases.briefs!.review.verdict = null; // unresolved, keeps output
    raw.items[1]!.phases.briefs!.review.verdict = null; // unresolved, output stripped
    raw.items[1]!.phases.briefs!.artifacts = [];
    const mixed = parseThemeEquipmentSetState(raw);

    const plan = planRunPhase(mixed);

    const unresolved = mixed.items.filter(
      (item) => !isThemeSetItemResolvedForPhase(item, 'briefs'),
    ).length;
    expect(unresolved).toBe(2);
    expect(plan.generateCount).toBe(1);
    expect(plan.regenerateCount).toBe(1);
    expect(plan.generateCount + plan.regenerateCount).toBe(unresolved);
  });

  it('treats rejected (down) items as unresolved regenerations', () => {
    const ready = readyForPhase(makeState()); // all up, judged, all have artifacts
    const state = withItemVerdict(ready, 0, 'down');

    const plan = planRunPhase(state);

    expect(plan.regenerateCount).toBe(1);
    expect(plan.generateCount).toBe(0);
    expect(plan.judgeOnly).toBe(false);
  });

  it('is not judge-missing once the collection judge exists', () => {
    const state = readyForPhase(makeState()); // all up + collectionJudge score 3

    const plan = planRunPhase(state);

    expect(plan.regenerateCount).toBe(0);
    expect(plan.judgeOnly).toBe(true);
    expect(plan.collectionJudgeMissing).toBe(false);
  });

  it('returns an empty plan for a non-review phase', () => {
    const complete = parseThemeEquipmentSetState({ ...makeState(), phase: 'complete' });

    const plan = planRunPhase(complete);

    expect(plan.phase).toBeNull();
    expect(plan.regenerateCount).toBe(0);
    expect(plan.judgeOnly).toBe(false);
    expect(plan.collectionJudgeMissing).toBe(false);
  });
});

describe('themeSetItemHasPhaseOutput / themeSetItemAwaitsGeneration (review gating)', () => {
  it('reports no output and awaiting-generation for a fresh briefs item', () => {
    const state = makeState({ phase: 'briefs' });
    const item = state.items[0]!;

    expect(themeSetItemHasPhaseOutput(item, 'briefs')).toBe(false);
    expect(themeSetItemAwaitsGeneration(item, 'briefs')).toBe(true);
  });

  it('reports output present and not awaiting once the required kind exists', () => {
    // readyForPhase adds a `selected-brief`-required?—it adds a `briefs`-kind
    // artifact, which counts as OUTPUT but is NOT the required `selected-brief`
    // kind, so the item still awaits generation. Give it the required kind too.
    const ready = readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
    const raw = JSON.parse(JSON.stringify(ready)) as {
      items: {
        phases: Record<
          string,
          { artifacts: { id: string; kind: string; uri: string; provenance: string }[] }
        >;
      }[];
    };
    raw.items[0]!.phases.briefs!.artifacts.push({
      id: 'req-selected-brief',
      kind: 'selected-brief',
      uri: 'run://selected',
      provenance: 'unit-test',
    });
    const withRequired = parseThemeEquipmentSetState(raw);
    const item = withRequired.items[0]!;

    expect(themeSetItemHasPhaseOutput(item, 'briefs')).toBe(true);
    expect(themeSetItemAwaitsGeneration(item, 'briefs')).toBe(false);
  });

  it('never awaits generation in the roster phase (no required artifact)', () => {
    const state = makeState();
    const item = state.items[0]!;

    expect(themeSetItemAwaitsGeneration(item, 'roster')).toBe(false);
  });

  it('awaits generation when a briefs artifact exists but not the required selected-brief kind', () => {
    // A non-required artifact (e.g. a `briefs`-kind evidence artifact) is OUTPUT
    // but does not satisfy the up-vote requirement, so the thumbs stay gated.
    const ready = readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
    const item = ready.items[0]!;

    expect(themeSetItemHasPhaseOutput(item, 'briefs')).toBe(true);
    expect(themeSetItemAwaitsGeneration(item, 'briefs')).toBe(true);
  });
});

describe('applyEditedThemeSetBrief', () => {
  const artifact = {
    id: 'x-brief-r1-selected',
    kind: 'selected-brief',
    uri: 'run://edited-brief',
    summary: 'Hand-edited brief (revision 1).',
    provenance: 'hand-edit',
    briefId: 'edited-brief',
  };
  const evidence = {
    id: 'x-brief-r1-edit',
    kind: 'brief-edit',
    uri: 'run://edited-brief',
    provenance: 'hand-edit',
  };

  function briefsState(): ThemeEquipmentSetState {
    return readyForPhase(makeState({ phase: 'briefs' }), 'briefs');
  }

  it('bumps the item revision, replaces the brief artifact, and clears the set-level review', () => {
    const state = briefsState();
    const itemId = state.items[0]!.id;
    const artifactFor = { ...artifact, id: `${itemId}-brief-r1-selected` };
    const evidenceFor = { ...evidence, id: `${itemId}-brief-r1-edit` };
    expect(state.phases.briefs.humanReview.verdict).toBe('up');

    const result = applyEditedThemeSetBrief(state, itemId, {
      artifact: artifactFor,
      evidence: evidenceFor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.state.items.find((candidate) => candidate.id === itemId)!;
    expect(item.revision).toBe(state.items[0]!.revision + 1);
    expect(item.phases.briefs.artifacts).toEqual([artifactFor]);
    expect(item.phases.briefs.review.verdict).toBe('up');
    expect(result.state.stateRevision).toBe(state.stateRevision + 1);
    // Reviewed content changed → set-level briefs review is invalidated.
    expect(result.state.phases.briefs.humanReview.verdict).toBeNull();
    expect(result.state.phases.briefs.collectionJudge).toBeNull();
  });

  it('rejects an edit outside the briefs phase', () => {
    const state = makeState(); // roster
    const itemId = state.items[0]!.id;

    const result = applyEditedThemeSetBrief(state, itemId, {
      artifact: { ...artifact, id: `${itemId}-brief-r1-selected` },
      evidence: { ...evidence, id: `${itemId}-brief-r1-edit` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'phase-not-briefs' })]),
    );
  });

  it('rejects an unknown item id', () => {
    const state = briefsState();

    const result = applyEditedThemeSetBrief(state, 'not-a-real-item', { artifact, evidence });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'item-not-found' })]),
    );
  });

  it('rejects an artifact whose kind is not selected-brief', () => {
    const state = briefsState();
    const itemId = state.items[0]!.id;

    const result = applyEditedThemeSetBrief(state, itemId, {
      artifact: { ...artifact, id: `${itemId}-brief-r1-selected`, kind: 'raw-sheet' },
      evidence: { ...evidence, id: `${itemId}-brief-r1-edit` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'artifact-not-selected-brief' })]),
    );
  });

  it('does not mutate the input state', () => {
    const state = briefsState();
    const itemId = state.items[0]!.id;
    const before = JSON.stringify(state);

    applyEditedThemeSetBrief(state, itemId, {
      artifact: { ...artifact, id: `${itemId}-brief-r1-selected` },
      evidence: { ...evidence, id: `${itemId}-brief-r1-edit` },
    });

    expect(JSON.stringify(state)).toBe(before);
  });
});
