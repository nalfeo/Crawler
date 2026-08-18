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
      sweep: { seeds: '1-50', kind: 'winrate', revision: 2 },
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
          sweep: { seeds: '1-50', kind: 'winrate', revision: 2 },
        },
      ),
    ).toThrow(/already contains meta/);
  });

  it('rejects runs missing required RunStats fields, before and after serialization', async () => {
    const run = await capturedRun();

    for (const field of [
      'totalFrames',
      'wallTimeMs',
      'finalFloor',
      'finalScore',
      'totalGold',
      'safeRoomMs',
    ] as const) {
      const incomplete = { ...run };
      delete (incomplete as Record<string, unknown>)[field];
      expect(() => attachReleaseBaselineRuns({ totalRuns: 1 }, [incomplete as RunStats])).toThrow(
        new RegExp(`runs\\[0\\]\\.${field} must be a finite number`),
      );
    }

    // NaN survives the in-memory check of a lenient parser and serializes to
    // null, so both the pre- and post-serialization checks must reject it.
    const nanRun = { ...run, wallTimeMs: Number.NaN };
    expect(() => attachReleaseBaselineRuns({ totalRuns: 1 }, [nanRun])).toThrow(
      /runs\[0\]\.wallTimeMs must be a finite number/,
    );
    expect(() =>
      serializeReleaseBaseline({ totalRuns: 1, runs: [{ ...run, wallTimeMs: null }] }),
    ).toThrow(/runs\[0\]\.wallTimeMs must be a finite number/);

    const brokenQuests = {
      ...run,
      quests: { ...run.quests, firstQuestCompletedMs: Number.NaN },
    };
    expect(() => attachReleaseBaselineRuns({ totalRuns: 1 }, [brokenQuests])).toThrow(
      /runs\[0\]\.quests\.firstQuestCompletedMs must be a finite number or null/,
    );

    const brokenCombat = { ...run, combat: { ...run.combat, killsByType: null } };
    expect(() =>
      attachReleaseBaselineRuns({ totalRuns: 1 }, [brokenCombat as unknown as RunStats]),
    ).toThrow(/runs\[0\]\.combat\.killsByType must be an object/);
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
    const funScore = steps.find((step) => step.name === 'Score fun evaluation');
    const publish = steps.find((step) => step.name === 'Publish to baselines branch');
    const upload = steps.find((step) => step.name === 'Upload baseline as artifact');

    expect(enrich?.run).toContain('scripts/agent/perf/release-baseline.ts');
    expect(publish?.run).toContain('SRC="$GITHUB_WORKSPACE/.cache/baseline/baseline.json"');
    expect(publish?.run).toContain('cp "$SRC" "$WORKTREE/by-sha/$SHA.json"');
    expect(upload?.with?.path).toBe(
      '.cache/baseline/baseline.json\n.cache/baseline/fun-report.json\n',
    );

    // Fun evaluation runs after the runs+meta cohort is complete, and it must
    // never fail the release: a scoring failure is downgraded to a warning.
    const enrichIndex = steps.indexOf(enrich!);
    const funScoreIndex = steps.indexOf(funScore!);
    const publishIndex = steps.indexOf(publish!);
    expect(enrichIndex).toBeGreaterThanOrEqual(0);
    expect(funScoreIndex).toBeGreaterThan(enrichIndex);
    expect(publishIndex).toBeGreaterThan(funScoreIndex);
    expect(funScore?.run).toContain('scripts/agent/perf/release-fun-report.ts');
    expect(funScore?.run).toContain('||');

    // The fun-eval report is diagnostic-only: publish/index/upload all
    // tolerate its absence so a legacy or failed-scoring commit still
    // publishes its baseline.
    expect(publish?.run).toContain(
      'FUN_REPORT_SRC="$GITHUB_WORKSPACE/.cache/baseline/fun-report.json"',
    );
    expect(publish?.run).toContain('if [ -f "$FUN_REPORT_SRC" ]');
    expect(publish?.run).toContain('cp "$FUN_REPORT_SRC" "$WORKTREE/by-sha/$SHA.fun-report.json"');
    expect(publish?.run).toContain('scripts/agent/perf/baseline-index.ts');
  });
});
