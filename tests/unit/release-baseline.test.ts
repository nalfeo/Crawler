import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { normalizeFunSessions } from '../../scripts/agent/health/fun-score-lib.js';
import {
  attachReleaseBaselineRuns,
  enrichReleaseBaseline,
  serializeReleaseBaseline,
} from '../../scripts/agent/perf/release-baseline.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function capturedRun(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 42 }), {
    seed: 42,
    maxFrames: 1,
    forceWeaponId: 'sword',
  });
}

describe('release baseline persistence', () => {
  it('preserves 600 complete RunStats through producer, publisher, and JSON storage', async () => {
    const actualRun = await capturedRun();
    expect(actualRun.spawnerArenas).toBeDefined();
    expect(actualRun.lootEfficiency).toBeDefined();

    const runs = Array.from({ length: 600 }, (_, index) => ({
      ...actualRun,
      totalFrames: index + 1,
      startingWeapon: index % 2 === 0 ? 'sword' : 'bow',
    }));
    const produced = attachReleaseBaselineRuns(
      {
        floorId: 'floor1',
        totalRuns: 600,
        totalWins: 0,
        winRate: 0,
        aggregate: { all: { n: 600 } },
      },
      runs,
    );
    const published = enrichReleaseBaseline(produced, {
      commit: 'a'.repeat(40),
      commitDate: '2026-08-13T00:00:00Z',
      commitSubject: 'test baseline',
      capturedAt: '2026-08-13T00:01:00Z',
      runId: '123456',
      runNumber: 7,
      runUrl: 'https://example.test/actions/runs/123456',
      sweep: { seeds: '1-100', kind: 'winrate' },
    });
    const stored = JSON.parse(serializeReleaseBaseline(published)) as unknown;
    const sessions = normalizeFunSessions(stored);

    expect(sessions).toHaveLength(600);
    expect(sessions[0]?.run.totalFrames).toBe(1);
    expect(sessions[599]?.run.totalFrames).toBe(600);
    expect(sessions[0]?.run.spawnerArenas).toEqual(actualRun.spawnerArenas);
    expect(sessions[0]?.run.lootEfficiency).toEqual(actualRun.lootEfficiency);
    expect(stored).toMatchObject({
      meta: { commit: 'a'.repeat(40), runId: '123456' },
      totalRuns: 600,
      totalWins: 0,
      aggregate: { all: { n: 600 } },
    });
  });

  it('rejects truncated runs and provenance overwrite', async () => {
    const run = await capturedRun();
    expect(() => attachReleaseBaselineRuns({ totalRuns: 2 }, [run])).toThrow(/run count mismatch/);
    expect(() =>
      enrichReleaseBaseline(
        { meta: { stale: true }, totalRuns: 1, runs: [run] },
        {
          commit: 'b'.repeat(40),
          commitDate: '2026-08-13T00:00:00Z',
          commitSubject: 'test',
          capturedAt: '2026-08-13T00:00:01Z',
          runId: '2',
          runNumber: 2,
          runUrl: 'https://example.test/2',
          sweep: { seeds: '1-100', kind: 'winrate' },
        },
      ),
    ).toThrow(/already contains meta/);
  });

  it('publishes and uploads the same validated baseline file', () => {
    const workflow = parse(
      readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'),
    ) as {
      jobs: Record<
        string,
        {
          steps?: Array<{
            name?: string;
            run?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const steps = workflow.jobs['baseline-sweep']?.steps ?? [];
    const enrich = steps.find((step) => step.name === 'Enrich baseline with commit metadata');
    const publish = steps.find((step) => step.name === 'Publish to baselines branch');
    const upload = steps.find((step) => step.name === 'Upload baseline as artifact');

    expect(enrich?.run).toContain('scripts/agent/perf/release-baseline.ts');
    expect(publish?.run).toContain('SRC="$GITHUB_WORKSPACE/.cache/baseline/baseline.json"');
    expect(publish?.run).toContain('cp "$SRC" "$WORKTREE/by-sha/$SHA.json"');
    expect(upload?.with?.path).toBe('.cache/baseline/baseline.json');
  });
});
