import { describe, expect, it } from 'vitest';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  normalizeFunSessions,
  parseFunScoreArgs,
} from '../../scripts/agent/health/fun-score-lib.js';

function makeRun(overrides: Partial<RunStats> = {}): RunStats {
  const run: RunStats = {
    totalFrames: 20_000,
    wallTimeMs: 3000,
    gameTimeMs: 320_000,
    safeRoomMs: 0,
    finalFloor: 1,
    finalScore: 1500,
    outcome: 'victory',
    levelUps: [
      { level: 2, gameTimeMs: 45_000, frame: 2700 },
      { level: 3, gameTimeMs: 105_000, frame: 6300 },
      { level: 4, gameTimeMs: 180_000, frame: 10_800 },
    ],
    combat: {
      totalKills: 125,
      killsByType: { rat: 80, slime: 45 },
      combatTimeMs: 165_000,
      engagementCount: 6,
      damageDealt: 4200,
      damageTaken: 950,
      damageTakenBySource: {},
    },
    health: {
      minHealthPercent: 0.15,
      closeCallCount: 2,
      lowHealthCount: 4,
      finalHealthPercent: 0.32,
    },
    quests: {
      questsAccepted: 2,
      questsCompleted: 2,
      questsFailed: [],
      mainQuestAcceptedMs: 30_000,
      mainQuestCompletedMs: 270_000,
      firstQuestCompletedMs: 120_000,
      questLogAccepts: { main: 30_000, side: 90_000 },
      questLogCompletions: { main: 270_000, side: 210_000 },
    },
    finalLevel: 7,
    totalXp: 2050,
    totalGold: 190,
    startingWeapon: 'sword',
  };
  return { ...run, ...overrides };
}

describe('parseFunScoreArgs', () => {
  it('parses an optional baseline path for trend comparisons', () => {
    const parsed = parseFunScoreArgs([
      'node',
      'fun-score',
      '--input',
      'runs.json',
      '--baseline',
      'baseline.json',
    ]);

    expect(parsed.baselinePath).toBe('baseline.json');
  });

  it('parses required and optional flags', () => {
    const parsed = parseFunScoreArgs([
      'node',
      'fun-score',
      '--input',
      'runs.json',
      '--out',
      'out.json',
      '--min-overall',
      '72',
      '--min-dimension',
      '58',
    ]);

    expect(parsed).toEqual({
      inputPath: 'runs.json',
      baselinePath: null,
      outputPath: 'out.json',
      minOverall: 72,
      minDimension: 58,
    });
  });

  it('throws when input is missing', () => {
    expect(() => parseFunScoreArgs(['node', 'fun-score'])).toThrow(/Missing --input/);
  });

  it('throws when threshold values are not numeric', () => {
    expect(() =>
      parseFunScoreArgs(['node', 'fun-score', '--input', 'runs.json', '--min-overall', 'nope']),
    ).toThrow(/must be numbers/);
  });
});

describe('normalizeFunSessions', () => {
  it('accepts RunStats[] and assigns default ids', () => {
    const sessions = normalizeFunSessions([makeRun(), makeRun({ startingWeapon: 'bow' })]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe('run-1');
    expect(sessions[1]?.id).toBe('run-2');
  });

  it('accepts { runs } and { sessions } payloads', () => {
    const fromRuns = normalizeFunSessions({ runs: [makeRun()] });
    const fromSessions = normalizeFunSessions({
      sessions: [
        {
          id: 'session-a',
          run: makeRun(),
          survey: {
            enjoyment: 5,
            immersion: 4,
            mastery: Number.NaN,
            control: 4,
            tension: 2,
          },
        },
      ],
    });

    expect(fromRuns[0]?.id).toBe('run-1');
    expect(fromSessions[0]?.id).toBe('session-a');
    expect(fromSessions[0]?.survey).toEqual({
      enjoyment: 5,
      immersion: 4,
      control: 4,
      tension: 2,
    });
  });

  it('accepts single root RunStats object', () => {
    const sessions = normalizeFunSessions(makeRun());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('run-1');
  });

  it('rejects non-object entries and malformed nested numerics', () => {
    expect(() => normalizeFunSessions(['not-an-object'])).toThrow(/Entry 1 is not an object/);
    expect(() =>
      normalizeFunSessions([
        makeRun({
          health: {
            minHealthPercent: Number.NaN,
            closeCallCount: 2,
            lowHealthCount: 4,
            finalHealthPercent: 0.32,
          },
        }),
      ]),
    ).toThrow(/missing a valid RunStats payload/);
  });

  it('rejects invalid outcomes and unsupported shapes', () => {
    expect(() =>
      normalizeFunSessions([makeRun({ outcome: 'bad' as RunStats['outcome'] })]),
    ).toThrow(/missing a valid RunStats payload/);
    expect(() => normalizeFunSessions({ data: [makeRun()] })).toThrow(/Unsupported input shape/);
  });

  it('normalizes a legacy payload missing safeRoomMs to 0 (array + single-root paths)', () => {
    const legacyRun: Record<string, unknown> = { ...makeRun() };
    delete legacyRun.safeRoomMs;
    expect('safeRoomMs' in legacyRun).toBe(false);

    const fromArray = normalizeFunSessions([legacyRun]);
    expect(fromArray[0]?.run.safeRoomMs).toBe(0);

    const fromRoot = normalizeFunSessions(legacyRun);
    expect(fromRoot[0]?.run.safeRoomMs).toBe(0);
  });

  it('rejects a present-but-invalid safeRoomMs (corruption, not a missing legacy field)', () => {
    expect(() => normalizeFunSessions([makeRun({ safeRoomMs: Number.NaN })])).toThrow(
      /missing a valid RunStats payload/,
    );
    expect(() =>
      normalizeFunSessions([makeRun({ safeRoomMs: 'lots' as unknown as number })]),
    ).toThrow(/missing a valid RunStats payload/);
  });
});
