/**
 * overrides-model.mjs — PURE, browser + node-safe override logic for the
 * achievements canvas. This is the SINGLE source of truth for the override
 * behavior, and it is deliberately dependency-free (NO `node:` builtins) so the
 * exact same bytes run in two places:
 *
 *   1. imported by `node --test` unit tests (deterministic assertions), and
 *   2. served verbatim over the loopback server and imported by the iframe
 *      client (`import ... from './lib/overrides-model.mjs'`).
 *
 * Because both sides import the same file, the tested logic and the shipped
 * logic cannot drift. Every function here is a faithful port of the monolith's
 * `renderAchievementsEditorPage` helpers in `src/devtools-main.ts`.
 *
 * @module achievements/overrides-model
 */

/** Override patch fields the monolith persists (all trimmed on save). */
export const OVERRIDE_STRING_FIELDS = Object.freeze([
  'title',
  'popupText',
  'unlockCriteria',
  'details',
  'directorFlavor',
  'iconId',
]);

/**
 * Merge a base achievement with its override patch. Verbatim port of
 * `devtools-main.ts:mergeAchievementWithOverride`: spread base, spread patch,
 * and fall back to the base reward when the patch has none.
 */
export function mergeAchievementWithOverride(achievement, overrides) {
  const patch = overrides ? overrides[achievement.id] : undefined;
  if (!patch) return achievement;
  return {
    ...achievement,
    ...patch,
    reward: patch.reward ?? achievement.reward,
  };
}

/** Map a base list to its merged (base + override) view. */
export function getMergedAchievements(baseList, overrides) {
  return baseList.map((achievement) => mergeAchievementWithOverride(achievement, overrides));
}

/**
 * Build an `AchievementReward` from the editor's reward inputs. Verbatim port of
 * `devtools-main.ts:readRewardOverride` — including the invalid-tier → 'common'
 * normalization path and the trim-on-item/message behavior. `lootBoxTiers` is
 * injected (the monolith closes over the `LOOT_BOX_TIERS` constant).
 */
export function readRewardOverride(
  rewardTypeValue,
  tierValue,
  itemValue,
  messageValue,
  lootBoxTiers,
) {
  const tiers = Array.isArray(lootBoxTiers) ? lootBoxTiers : [];
  if (rewardTypeValue === 'lootBox') {
    const tier = String(tierValue ?? '')
      .trim()
      .toLowerCase();
    const safeTier = tiers.includes(tier) ? tier : 'common';
    return { type: 'lootBox', tier: safeTier };
  }
  if (rewardTypeValue === 'item') {
    return { type: 'item', itemId: String(itemValue ?? '').trim() };
  }
  if (rewardTypeValue === 'directorMessage') {
    return { type: 'directorMessage', message: String(messageValue ?? '').trim() };
  }
  return { type: 'none' };
}

/**
 * Build the override patch from the editor form. Verbatim port of the monolith
 * save handler: all six string fields trimmed, reward via `readRewardOverride`.
 * The monolith's patch type has exactly these seven keys.
 * @param {Record<string, unknown>} form
 * @param {readonly string[]} lootBoxTiers
 */
export function buildOverridePatch(form, lootBoxTiers) {
  return {
    title: String(form.title ?? '').trim(),
    popupText: String(form.popupText ?? '').trim(),
    unlockCriteria: String(form.unlockCriteria ?? '').trim(),
    details: String(form.details ?? '').trim(),
    directorFlavor: String(form.directorFlavor ?? '').trim(),
    iconId: String(form.iconId ?? '').trim(),
    reward: readRewardOverride(
      form.rewardType,
      form.rewardTier,
      form.rewardItem,
      form.rewardMessage,
      lootBoxTiers,
    ),
  };
}

/** `raw.trim().toLowerCase()` — the monolith's search-input normalization. */
export function normalizeQuery(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Filter merged achievements by the monolith's haystack:
 * `${id} ${title} ${unlockCriteria}` lowercased, `includes(query)`. The query is
 * normalized here too so callers cannot accidentally pass a raw (cased) query.
 * An empty query matches everything (`includes('')` is always true).
 */
export function filterMergedAchievements(mergedList, query) {
  const normalized = normalizeQuery(query);
  return mergedList.filter((achievement) => {
    const haystack =
      `${achievement.id} ${achievement.title} ${achievement.unlockCriteria}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

/** The monolith summary line. */
export function computeSummary(total, overriddenCount, shownCount) {
  return `Floor 1 achievements: ${total} total · ${overriddenCount} overridden locally · ${shownCount} shown`;
}

/** Editor header reward label: tier for loot boxes, otherwise the reward type. */
export function rewardLabel(reward) {
  return reward.type === 'lootBox' ? reward.tier : reward.type;
}

/**
 * Coerce an arbitrary parsed value into a safe override map:
 * `Record<string, object>`. Verbatim intent of the monolith's
 * `loadAchievementOverrides` guard (bad payload → `{}`), extended to also drop
 * non-object entries so a corrupt map can never crash the renderer.
 */
export function sanitizeOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value;
    }
  }
  return out;
}
