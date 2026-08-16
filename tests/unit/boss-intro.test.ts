import { describe, expect, it } from 'vitest';
import {
  fallbackBossIntro,
  familyBossIntroFor,
  floor1BossIntro,
  _resetBossIntroCache,
} from '../../src/shared/boss-intro.js';
import { loadFamilies } from '../../src/shared/data/families.js';

describe('boss intro content', () => {
  it('provides bespoke Director copy for both Floor 1 bosses', () => {
    for (const [key, expectedName] of [
      ['slime-rat', 'Slime Rat'],
      ['staircase', 'Rat Slime'],
    ] as const) {
      const content = floor1BossIntro(key);
      expect(content, key).not.toBeNull();
      expect(content?.name).toBe(expectedName);
      expect(content?.introId).toBe(`floor1:${key}`);
      expect(content?.flavorLines.length).toBeGreaterThan(0);
      expect(content?.flavorLines.every((line) => line.trim().length > 0)).toBe(true);
    }
  });

  it('returns null for an unknown Floor 1 boss key', () => {
    expect(floor1BossIntro('not-a-boss')).toBeNull();
  });

  it('pins each Floor 1 boss to its own render kind', () => {
    expect(floor1BossIntro('slime-rat')?.renderKind).toBe('enemy_boss_slimerat');
    expect(floor1BossIntro('staircase')?.renderKind).toBe('enemy_boss_ratslime');
  });

  it('derives an intro for every family in the roster', () => {
    _resetBossIntroCache();
    const families = loadFamilies();
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      const content = familyBossIntroFor(family.id);
      expect(content, family.id).not.toBeNull();
      expect(content?.introId).toBe(`floor2:${family.id}`);
      expect(content?.name).toBe(family.boss.name);
      expect(content?.title).toContain(family.boss.title);
      expect(content?.title).toContain(family.name);
      expect(content?.renderKind).toBe('enemy_family_boss');
      expect(content?.flavorLines.some((line) => line.includes(family.signature))).toBe(true);
    }
  });

  it('produces unique intro ids across every authored boss', () => {
    const ids = [
      floor1BossIntro('slime-rat')!.introId,
      floor1BossIntro('staircase')!.introId,
      ...loadFamilies().map((family) => familyBossIntroFor(family.id)!.introId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the family HUD colour as the sheet accent', () => {
    const family = loadFamilies()[0]!;
    expect(familyBossIntroFor(family.id)?.accentColor).toBe(
      Number.parseInt(family.hudColor.replace('#', ''), 16),
    );
  });

  it('returns null for a family that is not in the roster', () => {
    expect(familyBossIntroFor('not-a-family')).toBeNull();
  });

  it('falls back to a generic sheet that still names the boss', () => {
    const content = fallbackBossIntro('boss:mystery', 'Something Wet');
    expect(content.introId).toBe('boss:mystery');
    expect(content.name).toBe('Something Wet');
    expect(content.renderKind).toBe('enemy_boss');
    expect(content.flavorLines.some((line) => line.includes('Something Wet'))).toBe(true);
  });
});
