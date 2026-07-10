/**
 * Type declarations for `achievements-data.mjs`, provided ONLY so the Vitest
 * parity test (`tests/unit/devtools/achievements-canvas-adapter-parity.test.ts`)
 * — a `.ts` file under the project's `tsc --noEmit` include — can import this
 * plain-Node `.mjs` adapter without a TS2307 "cannot find declaration" error.
 *
 * These are structural signatures only; the runtime source of truth is the
 * `.mjs`. The parity test exercises the real behaviour, so any signature drift
 * surfaces there — this file just keeps the type-checker happy at the boundary.
 */

export interface AchievementArtBacklogItem {
  readonly id: string;
  readonly kind: 'icon' | 'lootBox';
  readonly placeholderId: string;
  readonly description: string;
  readonly usedByAchievementIds: readonly string[];
}

export interface AchievementsData {
  achievements: unknown[];
  artBacklog: AchievementArtBacklogItem[];
  lootBoxTiers: string[];
  storageKey: string;
}

export const LOOT_BOX_TIERS: readonly string[];
export const ACHIEVEMENTS_JSON_RELATIVE_PATH: string;
export const ACHIEVEMENT_EDITOR_STORAGE_KEY: string;

export function removeUnlockCriteriaDuplication<
  T extends { unlockCriteria: string; directorFlavor: string },
>(achievement: T): T;

export function buildArtBacklog(achievements: readonly unknown[]): AchievementArtBacklogItem[];

export function parseAchievementCatalog(rawCatalog: unknown): unknown[];

export function loadAchievementsData(
  repoRoot: string,
  deps?: { readFile?: (p: string) => string },
): AchievementsData;
