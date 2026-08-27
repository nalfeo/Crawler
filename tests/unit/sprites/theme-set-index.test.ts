import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeThemeEquipmentReviewCommand } from '../../../scripts/sprites/theme-equipment-review-cli.js';
import {
  buildThemeEquipmentSetStateFromPlan,
  loadThemeEquipmentSetPlan,
  saveThemeEquipmentSetState,
} from '../../../scripts/sprites/theme-equipment-set.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const NOW = () => new Date('2026-07-25T12:00:00.000Z');
const PLAN_DIR = path.join('data', 'theme-equipment-sets');

function memoryStore(overrides: Partial<RunStore> = {}): RunStore & {
  readonly mem: Map<string, Buffer>;
} {
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
    ...overrides,
  };
}

const roots: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'theme-set-index-'));
  roots.push(root);
  mkdirSync(path.join(root, PLAN_DIR), { recursive: true });
  return root;
}

function canonicalPlan() {
  return loadThemeEquipmentSetPlan('classic-fantasy', {
    projectRoot: process.cwd(),
    planPath: 'data/theme-equipment-sets/classic-fantasy.json',
  });
}

function writePlan(root: string, id: string, body: unknown): void {
  writeFileSync(path.join(root, PLAN_DIR, `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('theme set index', () => {
  it('lists authored plans with coverage and a no-state badge', async () => {
    const root = tempRepo();
    writePlan(root, 'classic-fantasy', canonicalPlan());

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'list' },
      { store: memoryStore(), repoRoot: root, now: NOW },
    )) as { sets: readonly Record<string, never>[]; storeStatus: string };

    expect(result.storeStatus).toBe('ok');
    expect(result.sets).toHaveLength(1);
    const [entry] = result.sets as unknown as {
      id: string;
      plan: { status: string };
      planCoverage: { weaponTypeCount: number; coveredSlotCount: number };
      state: { status: string };
    }[];
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('classic-fantasy');
    expect(entry!.plan.status).toBe('ok');
    expect(entry!.planCoverage.weaponTypeCount).toBeGreaterThanOrEqual(5);
    expect(entry!.planCoverage.coveredSlotCount).toBeGreaterThanOrEqual(8);
    expect(entry!.state.status).toBe('none');
  });

  it('reports a ready phase badge for a set that already has durable state', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    writePlan(root, 'classic-fantasy', plan);
    const store = memoryStore();
    await saveThemeEquipmentSetState(
      store,
      buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() }),
      { expectedRevision: null, now: NOW },
    );

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'list' },
      { store, repoRoot: root, now: NOW },
    )) as unknown as { sets: { state: { status: string; phase: string } }[] };

    expect(result.sets[0]?.state).toMatchObject({ status: 'ready', phase: 'roster' });
  });

  it('distinguishes an unavailable store from a set with no state', async () => {
    const root = tempRepo();
    writePlan(root, 'classic-fantasy', canonicalPlan());
    const store = memoryStore({
      async list() {
        throw new Error('AuthorizationPermissionMismatch');
      },
    });

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'list' },
      { store, repoRoot: root, now: NOW },
    )) as unknown as {
      storeStatus: string;
      storeError: string;
      sets: { state: { status: string } }[];
    };

    expect(result.storeStatus).toBe('unavailable');
    expect(result.storeError).toMatch(/AuthorizationPermissionMismatch/);
    expect(result.sets[0]?.state.status).toBe('unknown');
  });

  it('flags an unparsable plan file without failing the whole index', async () => {
    const root = tempRepo();
    writePlan(root, 'classic-fantasy', canonicalPlan());
    writeFileSync(path.join(root, PLAN_DIR, 'broken.json'), '{ not json');

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'list' },
      { store: memoryStore(), repoRoot: root, now: NOW },
    )) as unknown as { sets: { id: string; plan: { status: string } }[] };

    expect(result.sets.map((entry) => entry.id)).toEqual(['broken', 'classic-fantasy']);
    expect(result.sets[0]?.plan.status).toBe('invalid');
  });

  it('lists remote-only durable plans so another workspace can select and initialize them', async () => {
    const root = tempRepo();

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'list' },
      {
        store: memoryStore(),
        repoRoot: root,
        now: NOW,
        listPublishedPlanIds: async () => ['classic-fantasy'],
      },
    )) as unknown as { sets: Array<{ id: string; plan: { status: string } }> };

    expect(result.sets).toEqual([
      {
        id: 'classic-fantasy',
        displayName: 'classic-fantasy',
        plan: { status: 'remote-only' },
        state: { status: 'none' },
      },
    ]);
  });
});

describe('theme set plan saving', () => {
  it('derives the destination path from the validated plan id', async () => {
    const root = tempRepo();
    const plan = { ...canonicalPlan(), id: 'edo-samurai' };

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'save-plan', plan },
      { store: memoryStore(), repoRoot: root, now: NOW },
    )) as unknown as { planPath: string; replaced: boolean };

    expect(result.planPath).toBe('data/theme-equipment-sets/edo-samurai.json');
    expect(result.replaced).toBe(false);
    const written = JSON.parse(
      readFileSync(path.join(root, PLAN_DIR, 'edo-samurai.json'), 'utf8'),
    ) as { id: string };
    expect(written.id).toBe('edo-samurai');
  });

  it('rejects a traversal-shaped set id at the schema boundary', async () => {
    const root = tempRepo();
    const plan = { ...canonicalPlan(), id: '../../../evil' };

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan },
        { store: memoryStore(), repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow();
    expect(() => readFileSync(path.join(root, '..', '..', '..', 'evil.json'))).toThrow();
  });

  it('refuses to overwrite an existing plan unless asked', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    writePlan(root, 'classic-fantasy', plan);

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan },
        { store: memoryStore(), repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow(/already exists/);

    const replaced = (await executeThemeEquipmentReviewCommand(
      { action: 'save-plan', plan, overwrite: true },
      { store: memoryStore(), repoRoot: root, now: NOW },
    )) as unknown as { replaced: boolean };
    expect(replaced.replaced).toBe(true);
  });

  it('treats a plan as immutable once the set has durable state', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    const store = memoryStore();
    await saveThemeEquipmentSetState(
      store,
      buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() }),
      { expectedRevision: null, now: NOW },
    );

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan, overwrite: true },
        { store, repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('rolls the plan file back when state appears mid-save', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    // `init` runs on GitHub, outside this process. Model the lost race by
    // reporting state only once `has()` is consulted after the write.
    let hasCalls = 0;
    const racingStore = memoryStore({
      has: async () => {
        hasCalls += 1;
        return hasCalls > 1;
      },
    });

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan },
        { store: racingStore, repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow(/rolled back/);

    expect(existsSync(path.join(root, PLAN_DIR, `${plan.id}.json`))).toBe(false);
  });

  it('rolls back and restores the previous plan when the post-write check throws', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    const target = path.join(root, PLAN_DIR, `${plan.id}.json`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '{"previous":true}\n', 'utf8');

    let hasCalls = 0;
    const flakyStore = memoryStore({
      has: async () => {
        hasCalls += 1;
        if (hasCalls > 1) throw new Error('transient store outage');
        return false;
      },
    });

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan, overwrite: true },
        { store: flakyStore, repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow(/rolled back/);

    expect(readFileSync(target, 'utf8')).toBe('{"previous":true}\n');
  });

  it('rejects a hand-edited roster that drops below the coverage gate', async () => {
    const root = tempRepo();
    const plan = { ...canonicalPlan(), weapons: canonicalPlan().weapons.slice(0, 1) };

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan },
        { store: memoryStore(), repoRoot: root, now: NOW },
      ),
    ).rejects.toThrow();
  });

  it('publishes the saved plan to the durable branch and reports it', async () => {
    const root = tempRepo();
    const plan = { ...canonicalPlan(), id: 'edo-samurai' };
    const calls: Array<{
      setId: string;
      planPath: string;
      content: string;
      overwrite: boolean;
    }> = [];
    const publishPlan = async (input: {
      setId: string;
      planPath: string;
      content: string;
      displayName: string;
      overwrite: boolean;
    }) => {
      calls.push({
        setId: input.setId,
        planPath: input.planPath,
        content: input.content,
        overwrite: input.overwrite,
      });
      return { branch: 'assets/plans', commit: 'deadbee', url: 'https://example/commit' };
    };

    const result = (await executeThemeEquipmentReviewCommand(
      { action: 'save-plan', plan },
      { store: memoryStore(), repoRoot: root, now: NOW, publishPlan },
    )) as unknown as { durable?: { branch: string; commit: string } };

    expect(calls).toHaveLength(1);
    expect(calls[0]?.setId).toBe('edo-samurai');
    expect(calls[0]?.planPath).toBe('data/theme-equipment-sets/edo-samurai.json');
    expect(calls[0]?.overwrite).toBe(false);
    // The publisher must receive exactly the bytes written to the local file.
    expect(calls[0]?.content).toBe(
      readFileSync(path.join(root, PLAN_DIR, 'edo-samurai.json'), 'utf8'),
    );
    expect(result.durable).toEqual({
      branch: 'assets/plans',
      commit: 'deadbee',
      url: 'https://example/commit',
    });
  });

  it('rolls the local write back when the durable publish fails', async () => {
    const root = tempRepo();
    const plan = { ...canonicalPlan(), id: 'edo-samurai' };
    const target = path.join(root, PLAN_DIR, 'edo-samurai.json');
    const publishPlan = async () => {
      throw new Error('remote rejected the push');
    };

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan },
        { store: memoryStore(), repoRoot: root, now: NOW, publishPlan },
      ),
    ).rejects.toThrow(/could not publish/i);

    // A definitive publish failure must not leave a misleading local plan.
    expect(existsSync(target)).toBe(false);
  });

  it('does not publish when the set already has durable state', async () => {
    const root = tempRepo();
    const plan = canonicalPlan();
    const store = memoryStore();
    await saveThemeEquipmentSetState(
      store,
      buildThemeEquipmentSetStateFromPlan(plan, { updatedAt: NOW().toISOString() }),
      { expectedRevision: null, now: NOW },
    );
    let published = false;
    const publishPlan = async () => {
      published = true;
      return { branch: 'assets/plans', commit: 'x', url: '' };
    };

    await expect(
      executeThemeEquipmentReviewCommand(
        { action: 'save-plan', plan, overwrite: true },
        { store, repoRoot: root, now: NOW, publishPlan },
      ),
    ).rejects.toThrow(/immutable/);
    expect(published).toBe(false);
  });
});
