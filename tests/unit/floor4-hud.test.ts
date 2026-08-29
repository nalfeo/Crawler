import { describe, expect, it } from 'vitest';
import { buildFloor4HudState, type Floor4HudPhaseConfig } from '../../src/shared/floor4-hud.js';
import type {
  Floor4ArenaState,
  Floor4HeadlinerEncounterState,
} from '../../src/shared/floor-types.js';

const phaseConfig: Floor4HudPhaseConfig = {
  actCount: 5,
  actDurationMs: 120_000,
  waveWindowMs: 90_000,
  overtimeCapMs: 60_000,
};

function headliner(
  overrides: Partial<Floor4HeadlinerEncounterState> = {},
): Floor4HeadlinerEncounterState {
  return {
    act: 2,
    slotId: 'floor4-headliner-act-2',
    archetypeId: 'floor4-camera-kraken',
    grade: 'main-event',
    displayName: 'Camera Kraken',
    entranceAnnouncement: 'CAMERA KRAKEN — all angles are bad angles!',
    appearanceFeeGold: 28,
    fixedFinale: false,
    bossEid: 123,
    defeated: false,
    feeGranted: false,
    chestSpawned: false,
    chestForceResolved: false,
    baseSpeed: 1,
    baseDamage: 18,
    appliedOvertimeSteps: 0,
    ...overrides,
  };
}

function arena(overrides: Partial<Floor4ArenaState> = {}): Floor4ArenaState {
  return {
    phase: { kind: 'WAVES', act: 2 },
    arenaElapsedMs: 120_000 + 24_000,
    phaseElapsedMs: 24_000,
    overtimeFinisherAnnounced: false,
    lastWorldElapsedMs: 0,
    timeline: [],
    headlinerCard: [],
    waveTelemetry: {
      wavesReleased: 10,
      enemiesSpawned: 30,
      enemiesCut: 3,
      debtDiscarded: 0,
      gateTelegraphsArmed: 12,
    },
    headlinerTelemetry: {
      spawned: 1,
      defeated: 1,
      appearanceFeeGoldGranted: 28,
      chestsSpawned: 1,
      chestsForceResolved: 1,
      overtimeStarted: 0,
      overtimeStepsApplied: 0,
    },
    waves: {
      act: 2,
      manifests: Array.from({ length: 8 }, (_, waveIndex) => ({
        act: 2,
        waveIndex,
        releaseAtActMs: waveIndex * 12_000,
        budget: 6,
        entries: [],
      })),
      releaseCursor: 3,
      debt: [],
      armedTelegraphs: [{ gateIndex: 1, waveIndex: 3, firesAtArenaMs: 156_000 }],
      ownedEnemies: new Map(),
    },
    ...overrides,
  };
}

describe('buildFloor4HudState', () => {
  it('formats act clock and wave pips from arena state', () => {
    const hud = buildFloor4HudState({
      arena: arena(),
      phaseConfig,
      playerGold: 44,
      playerKills: 9,
    });

    expect(hud.visible).toBe(true);
    expect(hud.title).toBe('ACT 2 / 5');
    expect(hud.clock).toBe('1:36');
    expect(hud.subline).toBe('SHOW 7:36 · WAVES 1:06');
    expect(hud.pips.map((pip) => pip.state)).toEqual([
      'released',
      'released',
      'released',
      'armed',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('shows cut notice and Headliner health during the headline window', () => {
    const hud = buildFloor4HudState({
      arena: arena({
        phase: { kind: 'HEADLINE', act: 2, cleared: false },
        phaseElapsedMs: 1_500,
        arenaElapsedMs: 210_000,
        activeHeadliner: headliner(),
        waves: undefined,
      }),
      phaseConfig,
      playerGold: 44,
      playerKills: 9,
      headlinerHealth: { current: 123, max: 200 },
    });

    expect(hud.notice).toBe('CLEAR THE FLOOR');
    expect(hud.headliner).toEqual({
      title: 'Camera Kraken',
      subtitle: 'ACT 2 HEADLINER',
      hpLabel: '123 / 200',
      hpPercent: 0.615,
    });
  });

  it('turns the clock over to overtime and summarizes Winner Circle state', () => {
    const overtime = buildFloor4HudState({
      arena: arena({
        phase: { kind: 'OVERTIME', act: 2 },
        phaseElapsedMs: 12_000,
        arenaElapsedMs: 240_000,
        activeHeadliner: headliner(),
        waves: undefined,
      }),
      phaseConfig,
      playerGold: 44,
      playerKills: 9,
      headlinerHealth: { current: 80, max: 200 },
    });
    expect(overtime.title).toBe('OVERTIME');
    expect(overtime.clock).toBe('+0:48');
    expect(overtime.overtime).toBe(true);
    expect(overtime.headliner?.subtitle).toBe('ACT 2 HEADLINER · OVERTIME');

    const winner = buildFloor4HudState({
      arena: arena({
        phase: { kind: 'INTERMISSION', act: 5 },
        phaseElapsedMs: 0,
        arenaElapsedMs: 600_000,
        waves: undefined,
      }),
      greenRoom: {
        retiredVisitCount: 4,
        lastOpenedVisitIndex: 4,
        currentVisit: {
          visitIndex: 4,
          tables: [
            { tableId: 'arsenal', archetypeId: 'the-fence', streamKey: 's', offers: [] },
            { tableId: 'supply', archetypeId: 'the-resource-broker', streamKey: 't', offers: [] },
          ],
        },
      },
      phaseConfig,
      playerGold: 144,
      playerKills: 39,
    });
    expect(winner.title).toBe("WINNER'S CIRCLE");
    expect(winner.winner).toBe(true);
    expect(winner.summary).toEqual([
      'Final tally',
      'Gold held: 144',
      'Kills: 39',
      'Sponsors open: 2',
      'Take the stairs to claim the belt',
    ]);
  });
});
