/**
 * Wiring test: ThemeEquipmentRunner.approveVariantArtifacts must forward the
 * speedup knobs (judgeMaxVariants = THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS,
 * concurrency = THEME_EQUIPMENT_JUDGE_CONCURRENCY) into `rejudgeRun` verbatim.
 *
 * Lives in a separate file because vi.mock is file-scoped: mocking rerun.js
 * here does not affect the direct runJudgePass tests in other files.
 *
 * Strategy: mock `rejudgeRun` to capture its args then throw a sentinel.  The
 * mocks for `repostprocessRun`, `loadRunSummary`, `materializeAndLoadBrief`,
 * `loadStyleGuide`, and `loadRecordedReferencePngs` stub out all I/O that
 * precedes the call-site under test so no real files, runs, or Azure calls are
 * needed.  The private `approveVariantArtifacts` method is exercised directly
 * via an `unknown` cast — the public surface under test is the _argument list_
 * at lines 488-492 of theme-equipment-runner.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';
import type { VisionProvider } from '../../../scripts/sprites/provider/vision-types.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the subject import
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  capturedRejudgeArgs: { value: undefined as unknown },
}));

/** Stub rerun.js: capture rejudgeRun args and throw a sentinel. */
vi.mock('../../../scripts/sprites/rerun.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../scripts/sprites/rerun.js')>();
  return {
    ...actual,
    loadRunSummary: async () => ({ candidates: [] as unknown[] }),
    repostprocessRun: async () => {},
    rejudgeRun: (args: unknown) => {
      hoisted.capturedRejudgeArgs.value = args;
      throw new Error('__rejudge_sentinel__');
    },
  };
});

/** Stub materializeAndLoadBrief to skip disk I/O. */
vi.mock('../../../scripts/sprites/theme-equipment-brief.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../scripts/sprites/theme-equipment-brief.js')>();
  return {
    ...actual,
    materializeAndLoadBrief: () => ({
      brief: {
        name: 'iron-sword',
        judge: { enabled: true, maxVariants: 16 },
      } as unknown as Brief,
      palette: {},
      briefPath: '/fake/brief.yaml',
    }),
  };
});

/** Stub loadStyleGuide to skip repo-root disk reads. */
vi.mock('../../../scripts/sprites/build-prompt.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../scripts/sprites/build-prompt.js')>();
  return { ...actual, loadStyleGuide: () => 'guide' };
});

/** Stub loadRecordedReferencePngs to skip store reads. */
vi.mock('../../../scripts/sprites/load-reference-pngs.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../scripts/sprites/load-reference-pngs.js')>();
  return { ...actual, loadRecordedReferencePngs: () => [] as Buffer[] };
});

// Imported AFTER mocks so the runner binds the mocked dependencies.
const { ThemeEquipmentRunner } = await import('../../../scripts/sprites/theme-equipment-runner.js');
const { THEME_EQUIPMENT_JUDGE_CONCURRENCY, THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS } =
  await import('../../../scripts/sprites/theme-equipment-brief.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function memoryStore(): RunStore {
  const mem = new Map<string, Buffer>();
  return {
    backend: 'local',
    async put(key, value) {
      mem.set(key, value);
    },
    async get(key) {
      const v = mem.get(key);
      if (!v) throw new StoreNotFoundError(key);
      return v;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((k) => k.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return `memory://${key}`;
    },
  };
}

const MOCK_VISION: VisionProvider = {
  modelDeployment: 'mock-vision',
  evaluate: async () => {
    throw new Error('vision should not be called in this test');
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThemeEquipmentRunner.approveVariantArtifacts — rejudge speedup wiring', () => {
  it('passes THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS and THEME_EQUIPMENT_JUDGE_CONCURRENCY to rejudgeRun', async () => {
    const store = memoryStore();

    // Minimal state needed to exercise the call site.
    const state = { id: 'wiring-test-set' } as unknown as Parameters<
      InstanceType<typeof ThemeEquipmentRunner>['runPhase']
    >[0];

    // Item: sprite-sheets has a raw-sheet; briefs has a selected-brief.
    // The brief YAML is stored at the key loadSelectedBrief derives from
    // selectedBriefKey(state, item, revision).
    const item = {
      id: 'iron-sword',
      revision: 0,
      phases: {
        'sprite-sheets': {
          artifacts: [
            {
              kind: 'raw-sheet',
              id: 'iron-sword-raw',
              uri: 'memory://iron-sword/sprite-sheets/sheet',
              provenance: 'test',
              briefId: 'iron-sword-v2',
              runId: 'run-iron-sword',
              summary: 'sheet-00.png',
            },
          ],
        },
        briefs: {
          artifacts: [
            {
              kind: 'selected-brief',
              id: 'iron-sword-brief-r0-selected',
              uri: 'memory://iron-sword/briefs/brief',
              provenance: 'test',
            },
          ],
        },
      },
    } as unknown as Parameters<InstanceType<typeof ThemeEquipmentRunner>['runPhase']>[0];

    // Store the brief YAML at the key loadSelectedBrief reads.
    // selectedBriefKey → theme-sets/wiring-test-set/artifacts/iron-sword/r0/brief.yaml
    store.put(
      'theme-sets/wiring-test-set/artifacts/iron-sword/r0/brief.yaml',
      Buffer.from('name: iron-sword\njudge:\n  enabled: true\n  maxVariants: 16\n', 'utf8'),
    );

    const runner = new ThemeEquipmentRunner({
      repoRoot: process.cwd(),
      store,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      env: {},
      synthProvider: {} as never,
      briefSelectorProvider: null,
      imageProvider: {} as never,
      textProvider: null,
      visionProvider: MOCK_VISION,
      queueCommitDeps: {} as never,
    });

    // Access the private method via cast to test the call site directly.
    const priv = runner as unknown as {
      approveVariantArtifacts(state: unknown, item: unknown): Promise<unknown>;
    };

    await expect(priv.approveVariantArtifacts(state, item)).rejects.toThrow('__rejudge_sentinel__');

    const captured = hoisted.capturedRejudgeArgs.value as {
      judgeMaxVariants?: number;
      concurrency?: number;
    };

    // The production call site must pass exactly these two knobs so the
    // rejudge is capped to 6 and fanned out 4-at-a-time.
    expect(captured.judgeMaxVariants).toBe(THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS);
    expect(captured.concurrency).toBe(THEME_EQUIPMENT_JUDGE_CONCURRENCY);
  });
});
