import { describe, expect, it } from 'vitest';
import { buildFloor4HeadlinerCard } from '../../src/shared/floor4-headliners.js';

const config = {
  pool: [
    {
      archetypeId: 'finale-alternate',
      grade: 'finale',
      displayName: 'Alternate',
      entranceAnnouncement: 'Alternate enters.',
    },
    {
      archetypeId: 'fixed-finale',
      grade: 'finale',
      displayName: 'Finale',
      entranceAnnouncement: 'Finale enters.',
    },
  ],
  slots: [
    { act: 1, eligibleGrades: ['finale'], appearanceFeeGold: 1 },
    {
      act: 5,
      eligibleGrades: ['finale'],
      fixedArchetypeId: 'fixed-finale',
      appearanceFeeGold: 1,
    },
  ],
} satisfies Parameters<typeof buildFloor4HeadlinerCard>[0];

describe('buildFloor4HeadlinerCard', () => {
  it('reserves fixed Headliners from earlier random slots', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      expect(buildFloor4HeadlinerCard(config, seed).map((entry) => entry.archetypeId)).toEqual([
        'finale-alternate',
        'fixed-finale',
      ]);
    }
  });
});
