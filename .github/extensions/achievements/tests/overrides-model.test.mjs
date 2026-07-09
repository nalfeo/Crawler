/**
 * Unit tests for the pure override logic (`lib/overrides-model.mjs`). These pin
 * the exact monolith behavior the plan review asked to lock: merge reward
 * fallback, trim-on-save, invalid-tier → 'common', filter over MERGED data with
 * an empty-query match-all, malformed persisted payload → {}, and the summary /
 * label / query helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERRIDE_STRING_FIELDS,
  mergeAchievementWithOverride,
  getMergedAchievements,
  readRewardOverride,
  buildOverridePatch,
  normalizeQuery,
  filterMergedAchievements,
  computeSummary,
  rewardLabel,
  sanitizeOverrides,
} from '../lib/overrides-model.mjs';

const TIERS = ['trash', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'divine'];

function base(id, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    unlockCriteria: `Criteria ${id}`,
    reward: { type: 'lootBox', tier: 'trash' },
    ...extra,
  };
}

test('OVERRIDE_STRING_FIELDS is the frozen six-field set', () => {
  assert.deepEqual(OVERRIDE_STRING_FIELDS, [
    'title',
    'popupText',
    'unlockCriteria',
    'details',
    'directorFlavor',
    'iconId',
  ]);
  assert.ok(Object.isFrozen(OVERRIDE_STRING_FIELDS));
});

test('mergeAchievementWithOverride returns the base when no patch exists', () => {
  const achievement = base('a');
  assert.equal(mergeAchievementWithOverride(achievement, {}), achievement);
  assert.equal(mergeAchievementWithOverride(achievement, undefined), achievement);
});

test('mergeAchievementWithOverride overlays fields and falls back to base reward', () => {
  const achievement = base('a', { reward: { type: 'item', itemId: 'sword' } });
  const merged = mergeAchievementWithOverride(achievement, {
    a: { title: 'New Title' },
  });
  assert.equal(merged.title, 'New Title');
  // No reward in the patch ⇒ base reward is preserved.
  assert.deepEqual(merged.reward, { type: 'item', itemId: 'sword' });

  const mergedWithReward = mergeAchievementWithOverride(achievement, {
    a: { title: 'X', reward: { type: 'none' } },
  });
  assert.deepEqual(mergedWithReward.reward, { type: 'none' });
});

test('getMergedAchievements maps the base list through the override overlay', () => {
  const list = [base('a'), base('b')];
  const merged = getMergedAchievements(list, { b: { title: 'B override' } });
  assert.equal(merged[0].title, 'Title a');
  assert.equal(merged[1].title, 'B override');
});

test('readRewardOverride validates loot-box tiers, defaulting invalid → common', () => {
  assert.deepEqual(readRewardOverride('lootBox', 'RARE', '', '', TIERS), {
    type: 'lootBox',
    tier: 'rare',
  });
  assert.deepEqual(readRewardOverride('lootBox', 'not-a-tier', '', '', TIERS), {
    type: 'lootBox',
    tier: 'common',
  });
});

test('readRewardOverride trims item + message and handles none', () => {
  assert.deepEqual(readRewardOverride('item', '', '  sword  ', '', TIERS), {
    type: 'item',
    itemId: 'sword',
  });
  assert.deepEqual(readRewardOverride('directorMessage', '', '', '  hi  ', TIERS), {
    type: 'directorMessage',
    message: 'hi',
  });
  assert.deepEqual(readRewardOverride('none', '', '', '', TIERS), { type: 'none' });
});

test('buildOverridePatch trims all six string fields and builds the reward', () => {
  const patch = buildOverridePatch(
    {
      title: '  T  ',
      popupText: '  P  ',
      unlockCriteria: '  U  ',
      details: '  D  ',
      directorFlavor: '  F  ',
      iconId: '  icon  ',
      rewardType: 'lootBox',
      rewardTier: 'epic',
      rewardItem: '',
      rewardMessage: '',
    },
    TIERS,
  );
  assert.deepEqual(patch, {
    title: 'T',
    popupText: 'P',
    unlockCriteria: 'U',
    details: 'D',
    directorFlavor: 'F',
    iconId: 'icon',
    reward: { type: 'lootBox', tier: 'epic' },
  });
});

test('normalizeQuery trims + lowercases', () => {
  assert.equal(normalizeQuery('  Bonk  '), 'bonk');
  assert.equal(normalizeQuery(undefined), '');
});

test('filterMergedAchievements matches id/title/criteria and matches-all on empty', () => {
  const merged = [
    base('first-bonk', { title: 'First Bonk', unlockCriteria: 'Defeat an enemy' }),
    base('speedrun', { title: 'Speedrun', unlockCriteria: 'Finish fast' }),
  ];
  assert.deepEqual(
    filterMergedAchievements(merged, 'bonk').map((a) => a.id),
    ['first-bonk'],
  );
  // Matches on unlock criteria too.
  assert.deepEqual(
    filterMergedAchievements(merged, 'finish').map((a) => a.id),
    ['speedrun'],
  );
  // Empty / whitespace query matches everything.
  assert.equal(filterMergedAchievements(merged, '   ').length, 2);
});

test('computeSummary renders the monolith summary line', () => {
  assert.equal(
    computeSummary(10, 2, 3),
    'Floor 1 achievements: 10 total · 2 overridden locally · 3 shown',
  );
});

test('rewardLabel shows tier for loot boxes and the type otherwise', () => {
  assert.equal(rewardLabel({ type: 'lootBox', tier: 'divine' }), 'divine');
  assert.equal(rewardLabel({ type: 'item', itemId: 'x' }), 'item');
  assert.equal(rewardLabel({ type: 'none' }), 'none');
});

test('sanitizeOverrides drops non-object entries and rejects bad payloads', () => {
  assert.deepEqual(sanitizeOverrides(null), {});
  assert.deepEqual(sanitizeOverrides('nope'), {});
  assert.deepEqual(sanitizeOverrides([1, 2]), {});
  assert.deepEqual(
    sanitizeOverrides({
      good: { title: 'ok' },
      bad: 'string',
      alsoBad: [1],
      nested: { reward: { type: 'none' } },
    }),
    { good: { title: 'ok' }, nested: { reward: { type: 'none' } } },
  );
});
