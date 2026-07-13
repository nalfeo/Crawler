import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SAFE_ROOM_ROUTE_WEAPONS,
  evaluateSafeRoomRouteGate,
  type SafeRoomBaselineManifest,
  type SafeRoomRouteRunMetric,
} from '../../../scripts/agent/perf/safe-room-route-gate.js';

const baseline = JSON.parse(
  readFileSync(
    new URL(
      '../../../scripts/agent/perf/fixtures/safe-room-baseline-a8e26a51.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as SafeRoomBaselineManifest;

const completedQuests = {
  'floor1-find-welcome': 1,
  'floor1-tutorial': 2,
  'floor1-boss-unlock': 3,
  'floor1-meet-npcs': 4,
  'floor1-shopkeeper-errand': 5,
  'floor1-boss-battle': 6,
  'floor1-leave-floor': 7,
};

function passingRows(): SafeRoomRouteRunMetric[] {
  return SAFE_ROOM_ROUTE_WEAPONS.flatMap((weapon) =>
    Array.from({ length: 100 }, (_, index) => ({
      weapon,
      seed: index + 1,
      win: true,
      outcome: 'victory',
      gameTimeMs: 200_000,
      safeRoomMs: 20_000,
      activeTimeMs: 180_000,
      questLogAccepts: completedQuests,
      questLogCompletions: completedQuests,
      questsFailed: [],
      safeRoomRouteActivations: 4,
      safeRoomRouteCompletions: 4,
      safeRoomRouteBlocked: 0,
      safeRoomRouteReseeds: 1,
    })),
  );
}

describe('safe-room route canonical gate', () => {
  it('accepts exact 600-cell coverage with strict wins, legal quests, and route telemetry', () => {
    const result = evaluateSafeRoomRouteGate(passingRows(), baseline);

    expect(result.passed).toBe(true);
    expect(result.totalRuns).toBe(600);
    expect(result.officialWins).toBe(600);
    expect(result.routeLifecycle.activations).toBe(2400);
  });

  it('rejects a new safe-room flag on a baseline official-win cell', () => {
    const rows = passingRows();
    const row = rows.find((candidate) => candidate.weapon === 'sword' && candidate.seed === 1);
    expect(row).toBeDefined();
    row!.safeRoomMs = 60_001;
    row!.gameTimeMs = 240_001;

    const result = evaluateSafeRoomRouteGate(rows, baseline);

    expect(result.passed).toBe(false);
    expect(result.newFlagsAmongBaselineWins).toEqual(['sword:1']);
  });

  it('rejects missing coverage and an anchor that is not an official win', () => {
    const rows = passingRows().filter(
      (candidate) => candidate.weapon !== 'pistol' || candidate.seed !== 76,
    );

    const result = evaluateSafeRoomRouteGate(rows, baseline);

    expect(result.passed).toBe(false);
    expect(result.anchorWins['pistol:76']).toBe(false);
    expect(result.errors).toContain('Missing candidate cell pistol:76.');
  });

  it('rejects a baseline whose identity or canonical cell sets were tampered with', () => {
    const tamperedBaseline: SafeRoomBaselineManifest = {
      ...baseline,
      baselineSha: 'tampered',
      officialLossCells: baseline.officialLossCells.map((cell, index) =>
        index === 0 ? 'sword:1' : cell,
      ),
    };

    const result = evaluateSafeRoomRouteGate(passingRows(), tamperedBaseline);

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      'Baseline manifest does not match the immutable a8e26a51 artifact evidence.',
    );
  });
});
