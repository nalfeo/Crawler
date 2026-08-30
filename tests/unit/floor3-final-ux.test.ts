import { describe, expect, it } from 'vitest';
import {
  buildFloor3FinalFourVersusModel,
  buildFloor3KeepCompanionPickerModel,
  buildFloor3LeagueViewModel,
  buildFloor3StudioVersusModel,
} from '../../src/shared/floor3-ux.js';

const studios = [
  {
    id: 'emberforge',
    name: 'Emberforge Studio',
    affinity: 'ember',
    unlockLevel: 8,
    unlocked: true,
    defeated: false,
  },
];
const rounds = [
  { handlerId: 'h1', handlerName: 'Vega', defeated: false },
  { handlerId: 'h2', handlerName: 'Morrow', defeated: false },
  { handlerId: 'h3', handlerName: 'Lux', defeated: false },
  { handlerId: 'h4', handlerName: 'Coda', defeated: false },
];

describe('Floor 3 final UX view models', () => {
  it('projects Studio progress, the ordered Final Four round, and Best in Show', () => {
    const studio = buildFloor3LeagueViewModel({
      floorId: 'floor3',
      worldState: 'playing',
      victory: false,
      studiosDefeated: 0,
      studios,
      finalFourUnlocked: false,
      finalFourRoundIndex: 0,
      rounds,
    });
    expect(studio.phase).toBe('studios');
    expect(studio.headline).toBe('STUDIOS · 0/1');

    const finalFour = buildFloor3LeagueViewModel({
      floorId: 'floor3',
      worldState: 'playing',
      victory: false,
      studiosDefeated: 1,
      studios,
      finalFourUnlocked: true,
      finalFourRoundIndex: 2,
      rounds: rounds.map((round, index) => ({ ...round, defeated: index < 2 })),
    });
    expect(finalFour.headline).toBe('FINAL FOUR · ROUND 3/4');
    expect(finalFour.detail).toBe('Your party vs Lux');

    const victory = buildFloor3LeagueViewModel({
      floorId: 'floor3',
      worldState: 'playing',
      victory: true,
      studiosDefeated: 1,
      studios,
      finalFourUnlocked: true,
      finalFourRoundIndex: 4,
      rounds: rounds.map((round) => ({ ...round, defeated: true })),
    });
    expect(victory.phase).toBe('best-in-show');
    expect(victory.activeRoundIndex).toBeNull();
  });

  it('builds non-cancellable Studio, round, and required keep-one pickers', () => {
    expect(buildFloor3StudioVersusModel(studios[0]!).subtitle).toContain('Your party vs');
    expect(buildFloor3FinalFourVersusModel(rounds[1]!, 1, 4).title).toContain('2 of 4');
    const keep = buildFloor3KeepCompanionPickerModel([
      {
        eid: 42,
        speciesId: 'ember-charger',
        currentName: 'Cinder Pup',
        ultimateName: 'Cinder Crown',
        level: 18,
        affinity: 'ember',
        fightingStyle: 'charger',
      },
    ]);
    expect(keep.allowCancel).toBe(false);
    expect(keep.options).toHaveLength(1);
    expect(keep.options[0]?.id).toBe('42');
    expect(keep.options[0]?.description).toContain('Ultimate: Cinder Crown');
  });
});
