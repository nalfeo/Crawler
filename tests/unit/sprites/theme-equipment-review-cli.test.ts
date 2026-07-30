import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createThemeEquipmentArtifactReader,
  createGhPlanPublisher,
  classifyGhFailureTransient,
  executeThemeEquipmentReviewCommand,
  isRetryableGhFailure,
  PlanPublishError,
  presentState,
  savePlan,
  THEME_SET_PLAN_DIR,
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

describe('createGhPlanPublisher', () => {
  const NOW_MS = 1_000_000;
  const DEADLINE_MS = 90_000;
  const VERIFY_RESERVE_MS = 10_000;
  const nowFn = () => NOW_MS;

  interface GhResult {
    readonly ok: boolean;
    readonly status: number | null;
    readonly stdout: string;
    readonly errorMessage: string;
    readonly transient?: boolean;
  }
  const ghOk = (stdout = '{}'): GhResult => ({ ok: true, status: 200, stdout, errorMessage: '' });
  const ghErr = (
    status: number | null,
    errorMessage = 'gh failed',
    transient?: boolean,
  ): GhResult => ({
    ok: false,
    status,
    stdout: '',
    errorMessage,
    ...(transient === undefined ? {} : { transient }),
  });
  const isBranchProbe = (args: readonly string[]): boolean =>
    args.length === 1 && args[0]!.includes('/branches/');
  const isContentsGet = (args: readonly string[]): boolean =>
    args.length === 1 && args[0]!.includes('/contents/');
  const isPut = (args: readonly string[]): boolean => args.includes('PUT');

  const baseInput = {
    setId: 'scratch',
    planPath: 'data/theme-equipment-sets/scratch.json',
    content: 'hello: world\n',
    displayName: 'Scratch Set',
    overwrite: false,
  } as const;

  it('publishes a fresh plan and reserves a verification window on the PUT', async () => {
    const calls: Array<{ args: readonly string[]; deadline: number }> = [];
    const runGh = async (args: readonly string[], deadline: number): Promise<GhResult> => {
      calls.push({ args, deadline });
      if (isBranchProbe(args)) return ghOk('{"name":"assets/plans"}');
      if (isContentsGet(args)) return ghErr(404, 'not found'); // file absent → fresh write
      if (isPut(args))
        return ghOk(
          JSON.stringify({
            commit: { sha: 'deadbeef', html_url: 'https://example/commit' },
            content: { html_url: 'https://example/blob' },
          }),
        );
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const result = await publish({ ...baseInput });

    expect(result.branch).toBe('assets/plans');
    expect(result.commit).toBe('deadbeef');
    expect(result.url).toBe('https://example/blob');

    // The read calls run against the full budget; the PUT holds back a verify
    // window so a slow-but-successful push can always be confirmed afterwards.
    const readDeadline = calls.find((c) => isBranchProbe(c.args))!.deadline;
    const putCall = calls.find((c) => isPut(c.args))!;
    expect(readDeadline).toBe(NOW_MS + DEADLINE_MS);
    expect(readDeadline - putCall.deadline).toBe(VERIFY_RESERVE_MS);
    // A fresh write carries no compare-and-swap sha.
    expect(putCall.args.some((a) => a.startsWith('sha='))).toBe(false);
  });

  it('refuses to overwrite an existing remote plan unless overwrite is set', async () => {
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghOk();
      if (isContentsGet(args)) return ghOk('{"sha":"abc123"}'); // remote copy exists
      throw new Error(`PUT must not run when overwrite is refused: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    await expect(publish({ ...baseInput, overwrite: false })).rejects.toThrow(/already exists/);
  });

  it('treats a byte-identical remote plan as idempotent success without overwrite (retry-safe)', async () => {
    // A retry of a partially-landed publish finds the shared copy already holds
    // exactly these bytes. Writing again is a no-op, so it must succeed WITHOUT
    // forcing an overwrite that could clobber a different plan under the same id.
    const encoded = Buffer.from(baseInput.content, 'utf8').toString('base64');
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghOk();
      if (isContentsGet(args))
        return ghOk(
          JSON.stringify({
            sha: 'abc123',
            content: encoded,
            encoding: 'base64',
            html_url: 'https://example/blob',
          }),
        );
      throw new Error(
        `PUT must not run when the remote copy is already identical: ${args.join(' ')}`,
      );
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const result = await publish({ ...baseInput, overwrite: false });

    expect(result.branch).toBe('assets/plans');
    expect(result.commit).toBe(''); // no PUT ran → no fresh commit sha
    expect(result.url).toBe('https://example/blob');
  });

  it('sends the remote blob sha as a compare-and-swap when overwriting', async () => {
    let putArgs: readonly string[] | null = null;
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghOk();
      if (isContentsGet(args)) return ghOk('{"sha":"abc123"}');
      if (isPut(args)) {
        putArgs = args;
        return ghOk('{"commit":{"sha":"c0ffee"}}');
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const result = await publish({ ...baseInput, overwrite: true });

    expect(result.commit).toBe('c0ffee');
    expect(putArgs).not.toBeNull();
    expect(putArgs!.includes('sha=abc123')).toBe(true);
  });

  it('confirms a slow-but-successful PUT via the verify GET and returns a pending commit', async () => {
    let putCount = 0;
    const encoded = Buffer.from(baseInput.content, 'utf8').toString('base64');
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghOk();
      if (isPut(args)) {
        putCount += 1;
        return ghErr(null, 'connection reset'); // ambiguous failure — may have landed
      }
      if (isContentsGet(args)) {
        // Pre-PUT probe → absent; post-PUT verify → the written blob.
        return putCount === 0
          ? ghErr(404, 'not found')
          : ghOk(
              JSON.stringify({
                content: encoded,
                encoding: 'base64',
                html_url: 'https://example/blob',
              }),
            );
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const result = await publish({ ...baseInput });

    expect(result.branch).toBe('assets/plans');
    expect(result.commit).toBe(''); // no sha recoverable from a Contents GET → "commit pending"
    expect(result.url).toBe('https://example/blob');
  });

  it('throws when an ambiguous PUT cannot be confirmed by the verify GET', async () => {
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghOk();
      if (isPut(args)) return ghErr(null, 'connection reset');
      if (isContentsGet(args)) return ghErr(404, 'not found'); // never landed
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    await expect(publish({ ...baseInput })).rejects.toThrow(/connection reset/);
  });

  it('seeds assets/plans from the default-branch tip when the branch is missing', async () => {
    const seen: string[] = [];
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      seen.push(args.join(' '));
      if (isBranchProbe(args)) return ghErr(404, 'no branch'); // branch does not exist yet
      if (args[0] === 'repos/{owner}/{repo}') return ghOk('{"default_branch":"main"}');
      if (args[0]!.includes('/git/ref/heads/main')) return ghOk('{"object":{"sha":"mainsha"}}');
      if (args.includes('POST') && args.includes('repos/{owner}/{repo}/git/refs'))
        return ghOk('{}');
      if (isContentsGet(args)) return ghErr(404, 'not found');
      if (isPut(args)) return ghOk('{"commit":{"sha":"seeded"}}');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const result = await publish({ ...baseInput });

    expect(result.commit).toBe('seeded');
    // The branch-create POST carried the resolved default-branch tip sha.
    expect(seen.some((s) => s.includes('sha=mainsha'))).toBe(true);
  });

  it('classifies a transient branch-bootstrap failure as retryable (does not roll the plan back)', async () => {
    // The branch is missing, so bootstrap runs; the repo probe then hits a
    // transient outage. It must surface as a retryable PlanPublishError so the
    // caller keeps the authored plan pending rather than discarding it.
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghErr(404, 'no branch'); // → bootstrap
      if (args[0] === 'repos/{owner}/{repo}') return ghErr(503, 'server error');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const error = await publish({ ...baseInput }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanPublishError);
    expect((error as PlanPublishError).retryable).toBe(true);
  });

  it('classifies a null-status local fault (missing gh) as definitive, not pending', async () => {
    // A branch probe that fails with no HTTP status and no transient flag is a
    // local fault (e.g. `gh` missing / unauthenticated), which must roll the
    // plan back rather than sit pending forever.
    const runGh = async (args: readonly string[]): Promise<GhResult> => {
      if (isBranchProbe(args)) return ghErr(null, 'gh api failed: spawn gh ENOENT', false);
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const publish = createGhPlanPublisher({}, { runGh, deadlineMs: DEADLINE_MS, now: nowFn });
    const error = await publish({ ...baseInput }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanPublishError);
    expect((error as PlanPublishError).retryable).toBe(false);
  });
});

describe('isRetryableGhFailure', () => {
  it('treats a genuine transport transient (null status + transient flag) as retryable', () => {
    expect(
      isRetryableGhFailure({ status: null, errorMessage: 'connection reset', transient: true }),
    ).toBe(true);
    expect(
      isRetryableGhFailure({
        status: null,
        errorMessage: 'Plan publish deadline exceeded',
        transient: true,
      }),
    ).toBe(true);
  });

  it('treats a null-status local fault (missing gh / auth / bad args) as definitive', () => {
    // No HTTP status AND not flagged transient → a local/config fault that a
    // blind retry cannot clear, so it must roll back rather than sit pending.
    expect(
      isRetryableGhFailure({ status: null, errorMessage: 'spawn gh ENOENT', transient: false }),
    ).toBe(false);
    expect(isRetryableGhFailure({ status: null, errorMessage: 'gh: not logged in' })).toBe(false);
  });

  it('treats explicit rate limiting and upstream 5xx as retryable', () => {
    expect(isRetryableGhFailure({ status: 429, errorMessage: 'too many requests' })).toBe(true);
    expect(isRetryableGhFailure({ status: 500, errorMessage: 'server error' })).toBe(true);
    expect(isRetryableGhFailure({ status: 503, errorMessage: 'unavailable' })).toBe(true);
    expect(
      isRetryableGhFailure({ status: 403, errorMessage: 'HTTP 403: API rate limit exceeded' }),
    ).toBe(true);
    expect(
      isRetryableGhFailure({
        status: 403,
        errorMessage: 'You have exceeded a secondary rate limit',
      }),
    ).toBe(true);
  });

  it('treats auth, conflict, validation, and plain 403 as definitive', () => {
    expect(isRetryableGhFailure({ status: 401, errorMessage: 'bad credentials' })).toBe(false);
    expect(isRetryableGhFailure({ status: 409, errorMessage: 'conflict' })).toBe(false);
    expect(isRetryableGhFailure({ status: 422, errorMessage: 'validation failed' })).toBe(false);
    expect(
      isRetryableGhFailure({ status: 403, errorMessage: 'HTTP 403: Resource not accessible' }),
    ).toBe(false);
  });
});

describe('classifyGhFailureTransient', () => {
  it('flags Windows/Go net diagnostics that gh prints on a network blip as transient', () => {
    // Raw stderr observed from a forced-connection-failure `gh api` on Windows:
    // exit code 1, killed:false, no HTTP status. These MUST be kept pending, not
    // rolled back, or graceful degradation never fires on this platform.
    const windowsStderrs = [
      'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:8888: connectex: No connection could be made because the target machine actively refused it.',
      'dial tcp: lookup api.github.com: no such host',
    ];
    for (const stderr of windowsStderrs) {
      expect(classifyGhFailureTransient({ status: null, code: 1, killed: false, stderr })).toBe(
        true,
      );
    }
  });

  it('flags libc/Node errno spellings and our own deadline kill as transient', () => {
    expect(
      classifyGhFailureTransient({ status: null, code: 'ECONNRESET', stderr: 'read ECONNRESET' }),
    ).toBe(true);
    expect(
      classifyGhFailureTransient({ status: null, killed: true, signal: 'SIGTERM', stderr: '' }),
    ).toBe(true);
  });

  it('treats missing gh, auth, and any HTTP-status failure as definitive', () => {
    // ENOENT (no gh binary) and an auth-preflight failure are local faults a
    // blind retry cannot clear.
    expect(
      classifyGhFailureTransient({ status: null, code: 'ENOENT', stderr: 'spawn gh ENOENT' }),
    ).toBe(false);
    expect(classifyGhFailureTransient({ status: null, code: 1, stderr: 'gh: not logged in' })).toBe(
      false,
    );
    // A parsed HTTP status is never a transport transient — 429/5xx retryability
    // is decided by isRetryableGhFailure on the status, not here.
    expect(
      classifyGhFailureTransient({ status: 500, code: 1, stderr: 'HTTP 500: server error' }),
    ).toBe(false);
  });
});

describe('savePlan graceful degradation on publish failure', () => {
  const loadClothPlan = () =>
    loadThemeEquipmentSetPlan('classic-fantasy', {
      projectRoot: process.cwd(),
      planPath: 'data/theme-equipment-sets/classic-fantasy.json',
    });

  const planFilePath = (repoRoot: string) =>
    join(repoRoot, THEME_SET_PLAN_DIR, 'classic-fantasy.json');

  it('keeps the local write and reports a pending state on a retryable publish failure', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'theme-save-retry-'));
    try {
      const store = memoryStore();
      const result = await savePlan(
        { plan: loadClothPlan() },
        {
          store,
          repoRoot,
          publishPlan: async () => {
            throw new PlanPublishError('gh api ... failed: HTTP 403: API rate limit exceeded', {
              retryable: true,
              status: 403,
            });
          },
        },
      );

      expect(result.saved).toBe(true);
      const durable = result.durable as Record<string, unknown> | undefined;
      expect(durable?.pending).toBe(true);
      expect(durable?.retryable).toBe(true);
      expect(String(durable?.reason)).toMatch(/rate limit/i);
      // The authored plan must survive on disk so the maintainer can retry.
      expect(existsSync(planFilePath(repoRoot))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rolls back and throws on a definitive publish failure', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'theme-save-def-'));
    try {
      const store = memoryStore();
      await expect(
        savePlan(
          { plan: loadClothPlan() },
          {
            store,
            repoRoot,
            publishPlan: async () => {
              throw new PlanPublishError('gh api ... failed: HTTP 401: Bad credentials', {
                retryable: false,
                status: 401,
              });
            },
          },
        ),
      ).rejects.toThrow(/rolled back so it does not look shared/);
      // A definitive failure must not leave a misleading local-only plan behind.
      expect(existsSync(planFilePath(repoRoot))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rolls back and throws when a non-classified error is raised (backward compatible)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'theme-save-plain-'));
    try {
      const store = memoryStore();
      await expect(
        savePlan(
          { plan: loadClothPlan() },
          {
            store,
            repoRoot,
            publishPlan: async () => {
              throw new Error('some non-publisher failure');
            },
          },
        ),
      ).rejects.toThrow(/rolled back so it does not look shared/);
      expect(existsSync(planFilePath(repoRoot))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
