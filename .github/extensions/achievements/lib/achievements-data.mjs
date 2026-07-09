/**
 * achievements-data.mjs — Layer-2 DOMAIN ADAPTER for the achievements canvas.
 *
 * The monolith `?page=achievements` DevTool sources its data from
 * `src/shared/achievements.ts`, which `import`s
 * `src/shared/data/achievements.floor1.json` at build time (Vite), validates it
 * with zod, and applies `removeUnlockCriteriaDuplication` to every entry. It then
 * exports `FLOOR1_ACHIEVEMENTS`, `ACHIEVEMENT_ART_BACKLOG`, and `LOOT_BOX_TIERS`.
 *
 * A canvas extension runs as a plain-Node `.mjs` process and CANNOT `import` that
 * `.ts` module. The harness README's sanctioned pattern for exactly this is a
 * Layer-2 fs reader (cf. sprite-review's `yaml-reader.mjs`, which replaces the
 * monolith's build-time `import.meta.glob`). So this module reads the SAME JSON
 * file the monolith reads and replicates the SAME two pure transforms VERBATIM —
 * `removeUnlockCriteriaDuplication` and the art-backlog derivation. The output is
 * therefore identical to `FLOOR1_ACHIEVEMENTS` / `ACHIEVEMENT_ART_BACKLOG` by
 * construction (same bytes in, same deterministic transforms).
 *
 * Kept dependency-free (no zod) and pure except for `loadAchievementsData`, which
 * is the only fs-touching function. Everything else is unit-testable in isolation.
 *
 * @module achievements/achievements-data
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loot-box tiers, verbatim from `src/shared/achievements.ts` (`LOOT_BOX_TIERS`).
 * Order is load-bearing: the loot-box art backlog is emitted in this order.
 * @type {readonly string[]}
 */
export const LOOT_BOX_TIERS = [
  'trash',
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'divine',
];

/** Repo-relative path to the catalog JSON the monolith imports at build time. */
export const ACHIEVEMENTS_JSON_RELATIVE_PATH = path.join(
  'src',
  'shared',
  'data',
  'achievements.floor1.json',
);

/** Fields we rely on being present + string-typed for display and transforms. */
const REQUIRED_STRING_FIELDS = [
  'id',
  'title',
  'popupText',
  'unlockCriteria',
  'details',
  'directorFlavor',
  'iconId',
  'difficulty',
];

// --- Pure transforms (verbatim ports of achievements.ts) --------------------

/** Escape a string for literal use inside a RegExp. (achievements.ts:escapeRegExp) */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse runs of whitespace to single spaces and trim. (achievements.ts:normalizeSpaces) */
function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Strip the unlock-criteria text out of the director flavor so the flavor does
 * not simply restate the trigger. Verbatim port of
 * `achievements.ts:removeUnlockCriteriaDuplication` — must stay behaviorally
 * identical so the editor shows (and exports) the same flavor as the monolith.
 *
 * @template {{ unlockCriteria: string, directorFlavor: string }} T
 * @param {T} achievement
 * @returns {T}
 */
export function removeUnlockCriteriaDuplication(achievement) {
  const unlockCriteria = achievement.unlockCriteria.trim();
  if (unlockCriteria.length === 0) return achievement;

  const escapedCriteria = escapeRegExp(unlockCriteria);
  const triggerPattern = new RegExp(`Trigger condition:\\s*${escapedCriteria}`, 'gi');
  const criteriaPattern = new RegExp(escapedCriteria, 'gi');

  const sanitizedFlavor = normalizeSpaces(
    achievement.directorFlavor
      .replace(triggerPattern, 'Trigger condition met')
      .replace(criteriaPattern, ''),
  );

  if (sanitizedFlavor.length === 0 || sanitizedFlavor === achievement.directorFlavor) {
    return achievement;
  }

  return {
    ...achievement,
    directorFlavor: sanitizedFlavor,
  };
}

/**
 * Icon backlog items grouped by `iconId` in FIRST-SEEN order. Verbatim port of
 * `achievements.ts:collectIconBacklogItems`.
 * @param {readonly any[]} achievements
 */
function collectIconBacklogItems(achievements) {
  const iconToAchievements = new Map();
  for (const achievement of achievements) {
    const list = iconToAchievements.get(achievement.iconId);
    if (list) {
      list.push(achievement.id);
    } else {
      iconToAchievements.set(achievement.iconId, [achievement.id]);
    }
  }

  return [...iconToAchievements.entries()].map(([placeholderId, usedByAchievementIds]) => ({
    id: `icon:${placeholderId}`,
    kind: 'icon',
    placeholderId,
    description: `Replace placeholder icon ${placeholderId} with a production icon set variant.`,
    usedByAchievementIds,
  }));
}

/**
 * Loot-box backlog items in fixed `LOOT_BOX_TIERS` order. Verbatim port of
 * `achievements.ts:collectLootBoxBacklogItems`.
 * @param {readonly any[]} achievements
 */
function collectLootBoxBacklogItems(achievements) {
  const tierToAchievements = new Map();
  for (const achievement of achievements) {
    if (!achievement.reward || achievement.reward.type !== 'lootBox') continue;
    const existing = tierToAchievements.get(achievement.reward.tier);
    if (existing) {
      existing.push(achievement.id);
    } else {
      tierToAchievements.set(achievement.reward.tier, [achievement.id]);
    }
  }

  return LOOT_BOX_TIERS.map((tier) => ({
    id: `lootBox:${tier}`,
    kind: 'lootBox',
    placeholderId: `loot-box-${tier}-placeholder`,
    description: `Create the ${tier} loot-box icon and open/closed reward reveal variants.`,
    usedByAchievementIds: tierToAchievements.get(tier) ?? [],
  }));
}

/**
 * Build the full art backlog: icons (first-seen order) THEN loot boxes (tier
 * order). Verbatim composition of `achievements.ts:ACHIEVEMENT_ART_BACKLOG`.
 * @param {readonly any[]} achievements
 */
export function buildArtBacklog(achievements) {
  return [...collectIconBacklogItems(achievements), ...collectLootBoxBacklogItems(achievements)];
}

/**
 * Lightweight structural validation. The committed JSON is already zod-validated
 * at build time by `achievements.ts`; this guards only against a corrupt/edited
 * file at runtime. Throws with a specific message so `buildState` can surface a
 * clean error panel instead of a cryptic crash.
 * @param {unknown} rawCatalog
 * @returns {any[]} the same array (full objects), transformed for flavor dedup.
 */
export function parseAchievementCatalog(rawCatalog) {
  if (!Array.isArray(rawCatalog) || rawCatalog.length === 0) {
    throw new Error('achievements catalog must be a non-empty array');
  }
  for (const [index, entry] of rawCatalog.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`achievements[${index}] is not an object`);
    }
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`achievements[${index}].${field} must be a non-empty string`);
      }
    }
    if (
      !entry.reward ||
      typeof entry.reward !== 'object' ||
      typeof entry.reward.type !== 'string'
    ) {
      throw new Error(`achievements[${index}].reward must be an object with a string type`);
    }
  }
  return rawCatalog.map(removeUnlockCriteriaDuplication);
}

/**
 * Read + parse + transform the Floor 1 achievement catalog from disk, returning
 * the view model the renderer consumes. Throws on a missing/unparseable/invalid
 * file (the caller's `buildState` catches it and returns a structured error).
 *
 * @param {string} repoRoot absolute path to the git worktree root.
 * @param {{ readFile?: (p: string) => string }} [deps] injectable reader (tests).
 * @returns {{ achievements: any[], artBacklog: any[], lootBoxTiers: string[], storageKey: string }}
 */
export function loadAchievementsData(repoRoot, deps = {}) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const jsonPath = path.join(repoRoot, ACHIEVEMENTS_JSON_RELATIVE_PATH);

  let raw;
  try {
    raw = readFile(jsonPath);
  } catch (err) {
    throw new Error(`could not read ${ACHIEVEMENTS_JSON_RELATIVE_PATH}: ${err?.message ?? err}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${ACHIEVEMENTS_JSON_RELATIVE_PATH}: ${err?.message ?? err}`);
  }

  const achievements = parseAchievementCatalog(parsed);
  return {
    achievements,
    artBacklog: buildArtBacklog(achievements),
    lootBoxTiers: [...LOOT_BOX_TIERS],
    storageKey: ACHIEVEMENT_EDITOR_STORAGE_KEY,
  };
}

/**
 * localStorage key the monolith persists overrides under. Kept IDENTICAL for
 * parity (same key + same patch shape) so the override model matches exactly.
 * (`src/devtools-main.ts:ACHIEVEMENT_EDITOR_STORAGE_KEY`.)
 */
export const ACHIEVEMENT_EDITOR_STORAGE_KEY = 'crawler.devtools.achievement-overrides.v1';
