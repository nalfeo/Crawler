import { describe, expect, it } from 'vitest';
import { resolveAchievementToastY } from '../../src/shared/achievement-toast-layout.js';

describe('MainGameScene achievement toast layout', () => {
  it('places the toast below visible multiline commentary', () => {
    expect(resolveAchievementToastY(true, 96, 84)).toBe(192);
  });

  it('restores the default toast slot after commentary hides', () => {
    expect(resolveAchievementToastY(false, 96, 84)).toBe(150);
  });
});
