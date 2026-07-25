import { describe, expect, it } from 'vitest';
import {
  executeThemeEquipmentReviewCommand,
  presentState,
} from '../../../scripts/sprites/theme-equipment-review-cli.js';
import {
  buildThemeEquipmentSetStateFromPlan,
  loadThemeEquipmentSetPlan,
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
      { store, now: NOW },
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
      { store, now: NOW },
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
        { store, now: NOW },
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
      { store, now: NOW },
    );

    expect(Buffer.from(String(result.base64), 'base64').toString()).toBe('png-bytes');
    expect(result.contentType).toBe('image/png');
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
