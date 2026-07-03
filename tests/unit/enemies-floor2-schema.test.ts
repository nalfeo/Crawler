import { describe, expect, it } from 'vitest';
import {
  enemyPackDefSchema,
  floor2EnemyPack,
  getFloor2BossArchetype,
  getFloor2FamilyTrash,
  getFloor2NeutralTrash,
} from '../../src/shared/enemy-packs.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import enemiesFloor2Json from '../../src/shared/data/enemies.floor2.json';

/**
 * Slice 4 · Deliverable 1 — enemy pack schema + content invariants for
 * enemies.floor2.json.
 */

describe('enemies.floor2.json — schema + content', () => {
  it('parses under enemyPackDefSchema', () => {
    expect(() => enemyPackDefSchema.parse(enemiesFloor2Json)).not.toThrow();
  });

  it('registers every family with exactly one boss archetype', () => {
    const families = loadFamilies();
    for (const family of families) {
      const boss = getFloor2BossArchetype(family.id);
      expect(boss).toBeDefined();
      expect(boss!.isBoss).toBe(true);
      expect(boss!.familyId).toBe(family.id);
      // Bosses never roll ambient (they're placed by initializeFloor2Bosses).
      expect(boss!.spawnWeight).toBe(0);
    }
    // Uniqueness — no two bosses share a familyId.
    const bosses = floor2EnemyPack.archetypes.filter((a) => a.isBoss === true);
    const seen = new Set(bosses.map((b) => b.familyId));
    expect(seen.size).toBe(bosses.length);
  });

  it('has at least one trash archetype per family', () => {
    const families = loadFamilies();
    for (const family of families) {
      const trash = getFloor2FamilyTrash(family.id);
      expect(trash.length).toBeGreaterThan(0);
      for (const t of trash) {
        expect(t.isBoss).not.toBe(true);
        expect(t.familyId).toBe(family.id);
      }
    }
  });

  it('has ≥6 neutral trash archetypes (FR18)', () => {
    const neutral = getFloor2NeutralTrash();
    expect(neutral.length).toBeGreaterThanOrEqual(6);
    for (const n of neutral) {
      expect(n.familyId).toBeUndefined();
      expect(n.isBoss).not.toBe(true);
    }
  });

  it('rejects isBoss without familyId (schema superRefine)', () => {
    const badPack = {
      ...enemiesFloor2Json,
      archetypes: [
        {
          id: 'orphan-boss',
          name: 'Orphan Boss',
          hp: 100,
          speed: 0.1,
          detectRange: 40,
          spriteTexture: 1,
          aiType: 'chase',
          spawnWeight: 0,
          isBoss: true,
        },
      ],
    };
    expect(() => enemyPackDefSchema.parse(badPack)).toThrow();
  });
});
