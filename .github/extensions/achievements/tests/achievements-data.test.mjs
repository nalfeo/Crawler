/**
 * Unit tests for the Layer-2 domain adapter (`lib/achievements-data.mjs`).
 *
 * These lock the `.mjs` port to the behavior of `src/shared/achievements.ts`:
 * the `removeUnlockCriteriaDuplication` transform, the art-backlog derivation
 * (icons first-seen THEN loot boxes in tier order), catalog validation, and a
 * real-file smoke test against the committed JSON so drift shows up as a
 * failing assertion, not a silent parity gap. (A separate Vitest test in
 * `tests/unit/devtools/achievements-canvas-adapter-parity.test.ts` deep-compares
 * the adapter output against the REAL `FLOOR1_ACHIEVEMENTS` for full drift coverage.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOOT_BOX_TIERS,
  ACHIEVEMENT_EDITOR_STORAGE_KEY,
  ACHIEVEMENTS_JSON_RELATIVE_PATH,
  removeUnlockCriteriaDuplication,
  buildArtBacklog,
  parseAchievementCatalog,
  loadAchievementsData,
} from '../lib/achievements-data.mjs';

// Repo root: this file lives at <root>/.github/extensions/achievements/tests/, so
// four `..` hops off its own dir land on the git worktree root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

function makeAchievement(overrides = {}) {
  return {
    id: 'first-bonk',
    floor: 1,
    title: 'First Bonk',
    popupText: 'New achievement: First Bonk!',
    unlockCriteria: 'Defeat your first enemy on Floor 1.',
    details: 'Unlock when you defeat your first enemy on Floor 1.',
    directorFlavor: 'A tale of violence.',
    iconId: 'achv-first-bonk-placeholder',
    difficulty: 'basic',
    reward: { type: 'lootBox', tier: 'trash' },
    unlockRules: [],
    ...overrides,
  };
}

test('LOOT_BOX_TIERS is the exact 7-tier ordered set from achievements.ts', () => {
  assert.deepEqual(LOOT_BOX_TIERS, [
    'trash',
    'common',
    'uncommon',
    'rare',
    'epic',
    'legendary',
    'divine',
  ]);
});

test('storage key + json path match the monolith', () => {
  assert.equal(ACHIEVEMENT_EDITOR_STORAGE_KEY, 'crawler.devtools.achievement-overrides.v1');
  assert.equal(
    ACHIEVEMENTS_JSON_RELATIVE_PATH,
    path.join('src', 'shared', 'data', 'achievements.floor1.json'),
  );
});

test('removeUnlockCriteriaDuplication strips the criteria text from the flavor', () => {
  const result = removeUnlockCriteriaDuplication(
    makeAchievement({
      unlockCriteria: 'Defeat your first slime.',
      directorFlavor: 'Slime containment. Defeat your first slime. Crowd liked it.',
    }),
  );
  assert.ok(!result.directorFlavor.includes('Defeat your first slime.'));
  assert.equal(result.directorFlavor, 'Slime containment. Crowd liked it.');
});

test('removeUnlockCriteriaDuplication rewrites "Trigger condition: <criteria>"', () => {
  const result = removeUnlockCriteriaDuplication(
    makeAchievement({
      unlockCriteria: 'Reach level 5.',
      directorFlavor: 'Trigger condition: Reach level 5. Nicely done.',
    }),
  );
  // The trigger pattern ends with the escaped criteria (incl. its trailing period),
  // so the replacement text carries no period: "Trigger condition met Nicely done."
  assert.equal(result.directorFlavor, 'Trigger condition met Nicely done.');
});

test('removeUnlockCriteriaDuplication is a no-op when the flavor lacks the criteria', () => {
  const input = makeAchievement({
    unlockCriteria: 'Defeat your first slime.',
    directorFlavor: 'Completely unrelated flavor text.',
  });
  const result = removeUnlockCriteriaDuplication(input);
  assert.equal(result, input, 'returns the same object reference (no change)');
});

test('removeUnlockCriteriaDuplication is a no-op for empty unlock criteria', () => {
  const input = makeAchievement({ unlockCriteria: '   ', directorFlavor: 'Flavor.' });
  assert.equal(removeUnlockCriteriaDuplication(input), input);
});

test('removeUnlockCriteriaDuplication keeps the original when stripping empties the flavor', () => {
  const input = makeAchievement({
    unlockCriteria: 'Win.',
    directorFlavor: 'Win.',
  });
  // Stripping "Win." would leave an empty string, so the guard returns the original.
  assert.equal(removeUnlockCriteriaDuplication(input), input);
});

test('buildArtBacklog emits icons (first-seen) then loot boxes (tier order)', () => {
  const achievements = [
    makeAchievement({ id: 'a', iconId: 'icon-x', reward: { type: 'lootBox', tier: 'common' } }),
    makeAchievement({ id: 'b', iconId: 'icon-y', reward: { type: 'lootBox', tier: 'common' } }),
    makeAchievement({ id: 'c', iconId: 'icon-x', reward: { type: 'item', itemId: 'sword' } }),
  ];
  const backlog = buildArtBacklog(achievements);

  const icons = backlog.filter((item) => item.kind === 'icon');
  const lootBoxes = backlog.filter((item) => item.kind === 'lootBox');

  // Icons: first-seen order, deduped by iconId, usedBy aggregated.
  assert.deepEqual(
    icons.map((item) => item.placeholderId),
    ['icon-x', 'icon-y'],
  );
  assert.deepEqual(icons[0], {
    id: 'icon:icon-x',
    kind: 'icon',
    placeholderId: 'icon-x',
    description: 'Replace placeholder icon icon-x with a production icon set variant.',
    usedByAchievementIds: ['a', 'c'],
  });

  // Loot boxes: exactly LOOT_BOX_TIERS, in order; usedBy populated per tier.
  assert.equal(lootBoxes.length, LOOT_BOX_TIERS.length);
  assert.deepEqual(
    lootBoxes.map((item) => item.placeholderId),
    LOOT_BOX_TIERS.map((tier) => `loot-box-${tier}-placeholder`),
  );
  const commonBox = lootBoxes.find((item) => item.id === 'lootBox:common');
  assert.deepEqual(commonBox.usedByAchievementIds, ['a', 'b']);
  const rareBox = lootBoxes.find((item) => item.id === 'lootBox:rare');
  assert.deepEqual(rareBox.usedByAchievementIds, []);

  // Ordering: all icons precede all loot boxes.
  assert.deepEqual(backlog, [...icons, ...lootBoxes]);
});

test('parseAchievementCatalog rejects malformed catalogs', () => {
  assert.throws(() => parseAchievementCatalog([]), /non-empty array/);
  assert.throws(() => parseAchievementCatalog('nope'), /non-empty array/);
  assert.throws(
    () => parseAchievementCatalog([{ ...makeAchievement(), title: '' }]),
    /title must be a non-empty string/,
  );
  assert.throws(
    () => parseAchievementCatalog([{ ...makeAchievement(), reward: undefined }]),
    /reward must be an object/,
  );
});

test('parseAchievementCatalog applies the flavor transform', () => {
  const [entry] = parseAchievementCatalog([
    makeAchievement({
      unlockCriteria: 'Defeat your first slime.',
      directorFlavor: 'Defeat your first slime. Wow.',
    }),
  ]);
  assert.equal(entry.directorFlavor, 'Wow.');
});

test('loadAchievementsData returns the full view model via an injected reader', () => {
  const fixture = JSON.stringify([
    makeAchievement({ id: 'a', iconId: 'icon-a', reward: { type: 'lootBox', tier: 'trash' } }),
  ]);
  const data = loadAchievementsData('/repo', { readFile: () => fixture });
  assert.equal(data.achievements.length, 1);
  assert.equal(data.achievements[0].id, 'a');
  assert.equal(data.lootBoxTiers.length, LOOT_BOX_TIERS.length);
  assert.equal(data.storageKey, ACHIEVEMENT_EDITOR_STORAGE_KEY);
  assert.ok(data.artBacklog.some((item) => item.id === 'icon:icon-a'));
  assert.equal(data.artBacklog.filter((item) => item.kind === 'lootBox').length, 7);
});

test('loadAchievementsData wraps read + parse failures with a specific message', () => {
  assert.throws(
    () =>
      loadAchievementsData('/repo', {
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    /could not read .*achievements\.floor1\.json/,
  );
  assert.throws(
    () => loadAchievementsData('/repo', { readFile: () => 'not json' }),
    /invalid JSON in/,
  );
});

test('smoke: loads the real committed catalog and derives a consistent backlog', () => {
  const data = loadAchievementsData(REPO_ROOT);
  assert.ok(data.achievements.length > 0, 'real catalog is non-empty');
  for (const achievement of data.achievements) {
    for (const field of ['id', 'title', 'popupText', 'unlockCriteria', 'iconId']) {
      assert.equal(typeof achievement[field], 'string');
      assert.ok(achievement[field].length > 0, `${field} present`);
    }
  }
  const lootBoxes = data.artBacklog.filter((item) => item.kind === 'lootBox');
  const icons = data.artBacklog.filter((item) => item.kind === 'icon');
  assert.equal(lootBoxes.length, 7, 'one backlog entry per loot-box tier');
  assert.ok(icons.length > 0, 'at least one icon backlog entry');
  assert.equal(data.artBacklog.length, icons.length + lootBoxes.length);
});
