import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { selectFloor2Roster } from '../../src/core/faction-relations.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { loadResources } from '../../src/shared/data/resources.js';
import {
  selectDenUnlockObjectives,
  buildDenUnlockQuestPack,
  denUnlockGoalId,
} from '../../src/game/floor2Scenario.js';
import {
  loadDenUnlockArchetypes,
  _resetDenUnlockArchetypeCache,
} from '../../src/shared/data/den-unlock-archetypes.js';

/**
 * Slice 4 · Deliverable 6 — deterministic archetype assignment.
 * Same seed ⇒ identical archetype-per-family assignment.
 */

describe('selectDenUnlockObjectives', () => {
  it('is deterministic for the same seed + roster', () => {
    const families = loadFamilies();
    const resources = loadResources();
    const archetypes = loadDenUnlockArchetypes();
    for (let seed = 1; seed <= 40; seed++) {
      const rosterA = selectFloor2Roster(new SeededRandom(seed), families, resources);
      const rosterB = selectFloor2Roster(new SeededRandom(seed), families, resources);
      expect(rosterA.presentFamilies).toEqual(rosterB.presentFamilies);

      const rngA = new SeededRandom(seed * 31);
      const rngB = new SeededRandom(seed * 31);
      const a = selectDenUnlockObjectives(rngA, rosterA.presentFamilies, archetypes);
      const b = selectDenUnlockObjectives(rngB, rosterB.presentFamilies, archetypes);
      expect([...a.entries()]).toEqual([...b.entries()]);
    }
  });

  it('assigns exactly one archetype per present family', () => {
    const families = loadFamilies();
    const resources = loadResources();
    const archetypes = loadDenUnlockArchetypes();
    const validIds = new Set(archetypes.map((a) => a.id));
    for (let seed = 1; seed <= 30; seed++) {
      const roster = selectFloor2Roster(new SeededRandom(seed), families, resources);
      const rng = new SeededRandom(seed + 7);
      const assignments = selectDenUnlockObjectives(rng, roster.presentFamilies, archetypes);
      expect(assignments.size).toBe(roster.presentFamilies.length);
      for (const familyId of roster.presentFamilies) {
        const archetypeId = assignments.get(familyId);
        expect(archetypeId).toBeDefined();
        expect(validIds.has(archetypeId!)).toBe(true);
      }
    }
  });

  it('throws if archetype pool is empty', () => {
    expect(() =>
      selectDenUnlockObjectives(new SeededRandom(1), ['goblins' as never], []),
    ).toThrow();
  });
});

describe('buildDenUnlockQuestPack', () => {
  beforeAllReset();

  it('uses the approved production family kill target', () => {
    const killArchetype = loadDenUnlockArchetypes().find(
      (archetype) => archetype.kind === 'killTargets',
    );
    expect(killArchetype?.kind).toBe('killTargets');
    if (killArchetype?.kind === 'killTargets') {
      expect(killArchetype.killTarget).toBe(50);
    }
  });

  it('emits one quest per family with family-scoped goal flag', () => {
    const families = loadFamilies();
    const resources = loadResources();
    const archetypes = loadDenUnlockArchetypes();
    const familyDefs = new Map(families.map((f) => [f.id as never, f] as const));
    const roster = selectFloor2Roster(new SeededRandom(101), families, resources);
    const assignments = selectDenUnlockObjectives(
      new SeededRandom(7),
      roster.presentFamilies,
      archetypes,
    );
    const pack = buildDenUnlockQuestPack(assignments, familyDefs, archetypes);
    expect(pack.packId).toBe('floor2-den-unlocks');
    expect(pack.quests.length).toBe(roster.presentFamilies.length);
    for (const quest of pack.quests) {
      // Each quest sets a family-scoped unlock goal flag.
      const familyId = roster.presentFamilies.find(
        (f) => quest.onCompleteGoalFlag === denUnlockGoalId(f),
      );
      expect(familyId).toBeDefined();
      // Every quest resolves either objectives or a template.
      const hasObjectives = (quest.objectives?.length ?? 0) > 0;
      const hasTemplate = quest.template !== undefined;
      expect(hasObjectives || hasTemplate).toBe(true);
    }
  });

  it('uses the selected archetype kill target for each family quest', () => {
    const families = loadFamilies();
    const resources = loadResources();
    const archetypes = loadDenUnlockArchetypes();
    const familyDefs = new Map(families.map((f) => [f.id as never, f] as const));
    const roster = selectFloor2Roster(new SeededRandom(202), families, resources);
    const assignments = selectDenUnlockObjectives(
      new SeededRandom(21),
      roster.presentFamilies,
      archetypes,
    );
    const pack = buildDenUnlockQuestPack(assignments, familyDefs, archetypes);

    for (const quest of pack.quests) {
      const familyId = roster.presentFamilies.find((f) => quest.id === `floor2-den-${f}-unlock`);
      expect(familyId).toBeDefined();
      const archetypeId = assignments.get(familyId!);
      expect(archetypeId).toBeDefined();
      const archetype = archetypes.find(
        (entry): entry is Extract<(typeof archetypes)[number], { kind: 'killTargets' }> =>
          entry.id === archetypeId && entry.kind === 'killTargets',
      );
      expect(archetype).toBeDefined();
      const template = quest.template;
      expect(template?.kind).toBe('killTargets');
      if (!template || template.kind !== 'killTargets') {
        continue;
      }
      expect(template.targets[0]?.target).toBe(archetype?.killTarget);
    }
  });
});

function beforeAllReset() {
  _resetDenUnlockArchetypeCache();
}
