import { afterEach, describe, expect, it } from 'vitest';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  FLOOR2_FIND_SETTLEMENT_QUEST_ID,
  FLOOR2_LEAVE_FLOOR_QUEST_ID,
  getQuestDef,
  getAllQuestDefs,
  getQuestPacks,
  installDefaultQuestPacks,
  installQuestPacks,
  objectiveTarget,
  questPackSchema,
} from '../../src/shared/quest-types.js';

describe('quest content packs', () => {
  afterEach(() => {
    installDefaultQuestPacks();
  });

  it('loads bundled floor1 quests from a validated data pack', () => {
    expect(getQuestPacks()).toHaveLength(2);

    expect(getQuestDef(FLOOR1_TUTORIAL_QUEST_ID)?.objectives).toEqual([
      {
        id: 'reach-level-2',
        label: 'Reach level 2',
        kind: 'goal',
        goalId: 'floor1-reach-level-2',
      },
    ]);

    expect(getQuestDef(FLOOR1_BOSS_UNLOCK_QUEST_ID)?.objectives).toEqual([
      {
        id: 'kill-rats',
        label: 'Exterminate rats',
        kind: 'counter',
        target: 6,
      },
      {
        id: 'kill-slimes',
        label: 'Squish slimes',
        kind: 'counter',
        target: 4,
      },
    ]);

    expect(getQuestDef(FLOOR1_SHOP_QUEST_ID)?.objectives.map((o) => o.kind)).toEqual([
      'talk',
      'collect',
      'goal',
      'haveEquippable',
      'equip',
    ]);
    expect(getQuestDef(FLOOR2_FIND_SETTLEMENT_QUEST_ID)?.objectives).toEqual([
      {
        id: 'find-settlement',
        label: 'Find the settlement',
        kind: 'goal',
        goalId: 'floor2-settlement-found',
      },
    ]);
    expect(getQuestDef(FLOOR2_LEAVE_FLOOR_QUEST_ID)?.objectives).toEqual([
      {
        id: 'take-stairs',
        label: 'Take the stairs out of Floor 2',
        kind: 'goal',
        goalId: 'floor2.objective.staircaseDiscovered',
      },
    ]);
  });

  it('compiles template-driven packs at runtime', () => {
    installQuestPacks([
      questPackSchema.parse({
        version: 1,
        packId: 'tests',
        quests: [
          {
            id: 'kill-x-template',
            title: 'Target Practice',
            summary: 'Eliminate test mobs.',
            template: {
              kind: 'killTargets',
              targets: [
                { objectiveId: 'kill-bats', label: 'Kill bats', target: 3 },
                { objectiveId: 'kill-goblins', label: 'Kill goblins', target: 2 },
              ],
            },
          },
        ],
      }),
    ]);

    expect(getQuestDef('kill-x-template')?.objectives).toEqual([
      { id: 'kill-bats', label: 'Kill bats', kind: 'counter', target: 3 },
      { id: 'kill-goblins', label: 'Kill goblins', kind: 'counter', target: 2 },
    ]);
  });

  it('defaults missing objective targets to 1', () => {
    expect(
      objectiveTarget({
        id: 'x',
        label: 'X',
        kind: 'counter',
      }),
    ).toBe(1);
  });

  it('rejects malformed quest packs via schema validation', () => {
    expect(() =>
      questPackSchema.parse({
        version: 1,
        packId: 'invalid',
        quests: [
          {
            id: 'bad',
            title: 'Bad',
            summary: 'Bad',
            template: {
              kind: 'killTargets',
              targets: [{ objectiveId: 'oops', label: 'Oops', target: 0 }],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('getAllQuestDefs returns every compiled default quest', () => {
    const ids = getAllQuestDefs().map((d) => d.id);
    expect(ids).toContain(FLOOR1_TUTORIAL_QUEST_ID);
    expect(ids).toContain(FLOOR1_SHOP_QUEST_ID);
    expect(ids).toContain(FLOOR1_BOSS_UNLOCK_QUEST_ID);
    expect(ids).toContain(FLOOR2_FIND_SETTLEMENT_QUEST_ID);
    expect(ids).toContain(FLOOR2_LEAVE_FLOOR_QUEST_ID);
  });

  it('rejects a quest source that provides both objectives and a template', () => {
    expect(() =>
      questPackSchema.parse({
        version: 1,
        packId: 'both',
        quests: [
          {
            id: 'both-quest',
            title: 'Both',
            summary: 'Both',
            objectives: [{ id: 'o', label: 'O', kind: 'goal', goalId: 'g' }],
            template: { kind: 'goalFlag', objectiveId: 'o2', label: 'O2', goalId: 'g2' },
          },
        ],
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects a quest source that provides neither objectives nor a template', () => {
    expect(() =>
      questPackSchema.parse({
        version: 1,
        packId: 'neither',
        quests: [{ id: 'empty-quest', title: 'Empty', summary: 'Empty' }],
      }),
    ).toThrow(/exactly one/);
  });
});
