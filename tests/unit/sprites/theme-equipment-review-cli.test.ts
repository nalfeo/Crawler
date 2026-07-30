import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createThemeEquipmentArtifactReader,
  executeThemeEquipmentReviewCommand,
  presentState,
} from '../../../scripts/sprites/theme-equipment-review-cli.js';
import { createRunStore } from '../../../scripts/sprites/store/index.js';
import {
  buildThemeEquipmentSetStateFromPlan,
  loadThemeEquipmentSetPlan,
  parseThemeEquipmentSetState,
  recordThemeSetItemPhaseArtifacts,
  saveThemeEquipmentSetState,
  themeEquipmentSetStateKey,
} from '../../../scripts/sprites/theme-equipment-set.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const NOW = () => new Date('2026-07-25T12:00:00.000Z');

function memoryStore(): RunStore & { readonly mem: Map<string, Buffer> } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    backend: 'local',
    async put(key, value) {
      mem.set(key, Buffer.from(value));
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

async function seededStore() {
  const store = memoryStore();
  const plan = loadThemeEquipmentSetPlan('classic-fantasy', {
    projectRoot: process.cwd(),
    planPath: 'data/theme-equipment-sets/classic-fantasy.json',
  });
  const state = buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() });
  await saveThemeEquipmentSetState(store, state, { expectedRevision: null, now: NOW });
  return { store, state };
}

describe('theme equipment review command bridge', () => {
  it('presents full durable state with dynamic coverage and gate details', async () => {
    const { store, state } = await seededStore();

    const result = await executeThemeEquipmentReviewCommand(
      { action: 'state', setId: state.id },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    expect(result).toMatchObject({
      id: 'classic-fantasy',
      stateRevision: 0,
      coverage: { weaponTypeCount: 6, coveredSlotCount: 16 },
      gate: { canAdvance: false },
    });
    expect(result.items).toHaveLength(22);
  });

  it('persists item review through the canonical mutation and rejects stale revisions', async () => {
    const { store, state } = await seededStore();
    const itemId = state.items[0]!.id;

    const reviewed = await executeThemeEquipmentReviewCommand(
      {
        action: 'item-review',
        setId: state.id,
        itemId,
        review: { verdict: 'down', feedback: 'Silhouette is too ornate.' },
        expectedRevision: 0,
      },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    expect(reviewed.stateRevision).toBe(1);
    expect(
      (reviewed.items as Array<{ id: string; phases: { roster: { review: unknown } } }>).find(
        (item) => item.id === itemId,
      )?.phases.roster.review,
    ).toEqual({ verdict: 'down', feedback: 'Silhouette is too ornate.' });
    await expect(
      executeThemeEquipmentReviewCommand(
        {
          action: 'set-review',
          setId: state.id,
          review: { verdict: 'up' },
          expectedRevision: 0,
        },
        { store, now: NOW, repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/revision-conflict/);
  });

  it('resolves preview bytes from exact artifact metadata rather than accepting a path', async () => {
    const { store, state } = await seededStore();
    const item = state.items[0]!;
    const recorded = recordThemeSetItemPhaseArtifacts(
      state,
      item.id,
      [
        {
          id: `${item.id}-sheet-r0-raw`,
          kind: 'raw-sheet',
          uri: 'memory://iron-sword/run-1/sheet-00.png',
          summary: 'sheet-00.png',
          briefId: 'iron-sword',
          runId: 'run-1',
        },
      ],
      [],
    );
    if (!recorded.ok) throw new Error('fixture artifact mutation failed');
    store.mem.set(themeEquipmentSetStateKey(state.id), Buffer.from(JSON.stringify(recorded.state)));
    await store.put('iron-sword/run-1/sheet-00.png', Buffer.from('png-bytes'));

    const result = await executeThemeEquipmentReviewCommand(
      {
        action: 'artifact',
        setId: state.id,
        itemId: item.id,
        artifactId: `${item.id}-sheet-r0-raw`,
      },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    expect(Buffer.from(String(result.base64), 'base64').toString()).toBe('png-bytes');
    expect(result.contentType).toBe('image/png');
  });

  it('resolves a selected-brief preview even when the uri is a Windows path', async () => {
    const { store, state } = await seededStore();
    const item = state.items[0]!;
    // The local store on Windows mints selected-brief uris as absolute paths
    // with backslashes; the preview reader must still recover the store key.
    const winUri = `C:\\repo\\generated\\runs\\theme-sets\\${state.id}\\artifacts\\${item.id}\\r0\\brief.yaml`;
    const recorded = recordThemeSetItemPhaseArtifacts(
      state,
      item.id,
      [
        {
          id: `${item.id}-brief-r0-selected`,
          kind: 'selected-brief',
          uri: winUri,
          summary: 'selected brief',
          briefId: 'iron-sword',
        },
      ],
      [],
    );
    if (!recorded.ok) throw new Error('fixture artifact mutation failed');
    store.mem.set(themeEquipmentSetStateKey(state.id), Buffer.from(JSON.stringify(recorded.state)));
    await store.put(
      `theme-sets/${state.id}/artifacts/${item.id}/r0/brief.yaml`,
      Buffer.from('type: weapon\nname: iron-sword\n'),
    );

    const result = await executeThemeEquipmentReviewCommand(
      {
        action: 'artifact',
        setId: state.id,
        itemId: item.id,
        artifactId: `${item.id}-brief-r0-selected`,
      },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    expect(Buffer.from(String(result.base64), 'base64').toString()).toContain('iron-sword');
  });

  it('keeps presentation pure', () => {
    const plan = loadThemeEquipmentSetPlan('classic-fantasy', {
      projectRoot: process.cwd(),
      planPath: 'data/theme-equipment-sets/classic-fantasy.json',
    });
    const state = buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() });
    expect(presentState(state).stateRevision).toBe(0);
    expect(state.stateRevision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by approve-remaining and save-and-approve-brief tests
// ---------------------------------------------------------------------------

/**
 * A minimal valid brief YAML that passes schema + palette validation against
 * the project's real `data/palettes/kenney-roguelike.json`.
 */
const VALID_BRIEF_YAML = [
  'type: weapon',
  'name: iron-sword',
  'size: { width: 16, height: 16 }',
  'palette:',
  '  id: kenney-roguelike',
  'anchor: { x: 8, y: 14 }',
  'description: A simple iron sword in side-profile.',
].join('\n');

/**
 * Build a store + state already in the `briefs` phase where:
 *  - item[0] has a `selected-brief` artifact with `null` verdict (approvable)
 *  - item[1] has a `down` verdict (skipped-rejected)
 *  - remaining items have no brief artifact (skipped-missing artifact)
 */
async function briefsPhaseStore() {
  const store = memoryStore();
  const plan = loadThemeEquipmentSetPlan('classic-fantasy', {
    projectRoot: process.cwd(),
    planPath: 'data/theme-equipment-sets/classic-fantasy.json',
  });
  const base = buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() });
  const item0 = base.items[0]!;
  const briefKey = `theme-sets/${base.id}/artifacts/${item0.id}/r0/brief.yaml`;
  await store.put(briefKey, Buffer.from(VALID_BRIEF_YAML));

  // Directly construct the briefs-phase state so item[0]'s selected-brief
  // artifact lands in the `briefs` phase record (not `roster`).
  type RawState = {
    phase: string;
    stateRevision: number;
    items: Array<{
      phases: {
        briefs: {
          artifacts: unknown[];
          review: { verdict: string | null };
        };
      };
    }>;
  };
  const raw = JSON.parse(JSON.stringify(base)) as RawState;
  raw.phase = 'briefs';
  raw.items[0]!.phases.briefs.artifacts = [
    {
      id: `${item0.id}-brief-r0-selected`,
      kind: 'selected-brief',
      uri: store.resolve(briefKey),
      summary: 'selected brief',
      briefId: 'iron-sword',
    },
  ];
  raw.items[1]!.phases.briefs.review.verdict = 'down';

  const state = parseThemeEquipmentSetState(raw);
  await saveThemeEquipmentSetState(store, state, { expectedRevision: null, now: NOW });
  return { store, state };
}

describe('approve-remaining command', () => {
  it('bulk-approves eligible items and reports skips in one revision bump', async () => {
    const { store, state } = await briefsPhaseStore();

    const result = await executeThemeEquipmentReviewCommand(
      { action: 'approve-remaining', setId: state.id, expectedRevision: state.stateRevision },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    // Revision must be bumped exactly once.
    expect(result.stateRevision).toBe(state.stateRevision + 1);

    const bulkResult = result.bulkResult as {
      approved: string[];
      alreadyUp: string[];
      skipped: Array<{ id: string; code: string }>;
    };
    // item[0] has a selected-brief → approved.
    expect(bulkResult.approved).toContain(state.items[0]!.id);
    // item[1] has down verdict → skipped as rejected.
    expect(
      bulkResult.skipped.some((s) => s.id === state.items[1]!.id && s.code === 'item-rejected'),
    ).toBe(true);
    // Remaining items have no brief artifact → skipped as missing.
    expect(bulkResult.skipped.some((s) => s.code === 'item-missing-phase-artifact')).toBe(true);
  });

  it('writes nothing and preserves revision when nothing is approvable', async () => {
    const { store, state } = await briefsPhaseStore();
    // First call approves item[0]; now nothing is left to approve.
    await executeThemeEquipmentReviewCommand(
      { action: 'approve-remaining', setId: state.id, expectedRevision: state.stateRevision },
      { store, now: NOW, repoRoot: process.cwd() },
    );
    // Reload the now-persisted state so stateRevision is accurate.
    const reloaded = await executeThemeEquipmentReviewCommand(
      { action: 'state', setId: state.id },
      { store, now: NOW, repoRoot: process.cwd() },
    );
    const revisionBefore = reloaded.stateRevision as number;

    // Second call: item[0] is already up, item[1] is down, rest are missing briefs.
    const result = await executeThemeEquipmentReviewCommand(
      { action: 'approve-remaining', setId: state.id, expectedRevision: revisionBefore },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    // State revision must not advance — nothing was written.
    expect(result.stateRevision).toBe(revisionBefore);
    const bulkResult = result.bulkResult as { approved: string[] };
    expect(bulkResult.approved).toHaveLength(0);
  });
});

describe('save-and-approve-brief command', () => {
  it('persists the hand-edited brief to a new nonce-keyed path, bumps item revision, and up-votes', async () => {
    const { store, state } = await briefsPhaseStore();
    const item = state.items[0]!;
    const keysBefore = store.mem.size;

    const result = await executeThemeEquipmentReviewCommand(
      {
        action: 'save-and-approve-brief',
        setId: state.id,
        itemId: item.id,
        briefText: VALID_BRIEF_YAML,
        expectedRevision: state.stateRevision,
      },
      { store, now: NOW, repoRoot: process.cwd() },
    );

    // State revision bumped.
    expect(result.stateRevision).toBe(state.stateRevision + 1);

    // A new nonce-keyed brief was written to the store.
    expect(store.mem.size).toBeGreaterThan(keysBefore);
    const newKeys = [...store.mem.keys()].filter(
      (k) => k.startsWith(`theme-sets/${state.id}/artifacts/${item.id}/r`) && k.endsWith('.yaml'),
    );
    // Old r0 key + new r1 nonce-keyed key = at least 2 brief keys.
    expect(newKeys.length).toBeGreaterThanOrEqual(2);

    // The item's revision advances and it is marked up.
    const savedItem = (
      result.items as Array<{
        id: string;
        revision: number;
        phases: { briefs: { review: { verdict: string } } };
      }>
    ).find((i) => i.id === item.id);
    expect(savedItem?.revision).toBe(item.revision + 1);
    expect(savedItem?.phases.briefs.review.verdict).toBe('up');
  });

  it('throws before any write when the YAML fails schema validation', async () => {
    const { store, state } = await briefsPhaseStore();
    const item = state.items[0]!;
    const keysBefore = store.mem.size;

    await expect(
      executeThemeEquipmentReviewCommand(
        {
          action: 'save-and-approve-brief',
          setId: state.id,
          itemId: item.id,
          briefText: 'type: not-a-valid-type\nname: x\n',
          expectedRevision: state.stateRevision,
        },
        { store, now: NOW, repoRoot: process.cwd() },
      ),
    ).rejects.toThrow();

    // No new keys written and revision unchanged.
    expect(store.mem.size).toBe(keysBefore);
    const currentState = JSON.parse(
      store.mem.get(themeEquipmentSetStateKey(state.id))!.toString(),
    ) as { stateRevision: number };
    expect(currentState.stateRevision).toBe(state.stateRevision);
  });

  it('throws revision-conflict on a stale expectedRevision', async () => {
    const { store, state } = await briefsPhaseStore();
    const item = state.items[0]!;

    await expect(
      executeThemeEquipmentReviewCommand(
        {
          action: 'save-and-approve-brief',
          setId: state.id,
          itemId: item.id,
          briefText: VALID_BRIEF_YAML,
          expectedRevision: state.stateRevision + 99,
        },
        { store, now: NOW, repoRoot: process.cwd() },
      ),
    ).rejects.toThrow(/revision-conflict/);
  });
});

describe('createThemeEquipmentArtifactReader', () => {
  it('serves artifact bytes in-process from a single warm store', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'theme-artifact-reader-'));
    const env = { SPRITES_RUN_STORE: 'local' } as const;
    try {
      // Seed a real local store: state doc with a raw-sheet artifact + bytes.
      const seedStore = createRunStore({ repoRoot, env });
      const plan = loadThemeEquipmentSetPlan('classic-fantasy', {
        projectRoot: process.cwd(),
        planPath: 'data/theme-equipment-sets/classic-fantasy.json',
      });
      const state = buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() });
      const item = state.items[0]!;
      const recorded = recordThemeSetItemPhaseArtifacts(
        state,
        item.id,
        [
          {
            id: `${item.id}-sheet-r0-raw`,
            kind: 'raw-sheet',
            uri: `memory://${item.id}/run-1/sheet-00.png`,
            summary: 'sheet-00.png',
            briefId: item.id,
            runId: 'run-1',
          },
        ],
        [],
      );
      if (!recorded.ok) throw new Error('fixture artifact mutation failed');
      await saveThemeEquipmentSetState(seedStore, recorded.state, {
        expectedRevision: null,
        now: NOW,
      });
      await seedStore.put(`${item.id}/run-1/sheet-00.png`, Buffer.from('png-bytes'));

      const reader = createThemeEquipmentArtifactReader({ repoRoot, env });
      // Two reads exercise the reused warm store; both must return the bytes.
      for (const _ of [0, 1]) {
        const payload = await reader.read(state.id, item.id, `${item.id}-sheet-r0-raw`);
        expect(payload.contentType).toBe('image/png');
        expect(Buffer.from(payload.base64, 'base64').toString()).toBe('png-bytes');
      }

      await expect(reader.read(state.id, item.id, 'does-not-exist')).rejects.toThrow(
        /was not found/,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
