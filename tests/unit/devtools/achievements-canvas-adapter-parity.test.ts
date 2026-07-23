/**
 * Adapter parity guard for the achievements canvas extension.
 *
 * The canvas extension is a plain-Node `.mjs` and cannot `import` the monolith's
 * `src/shared/achievements.ts`, so `lib/achievements-data.mjs` re-reads the SAME
 * catalog JSON and replicates the SAME transforms. That duplication is the drift
 * risk the plan review flagged (concern #2). This test imports BOTH the real TS
 * module and the extension's `.mjs` adapter, runs the adapter against the real
 * on-disk catalog, and deep-compares the outputs — so any divergence in the
 * transforms (flavor dedup, art-backlog derivation, tier list) fails CI loudly.
 *
 * Deep equality (`toEqual`) is order-independent, which is intentional: zod's
 * `.parse()` rebuilds objects in SCHEMA key order while the adapter preserves the
 * JSON's authored key order. That ordering is an internal artifact, not a
 * functional-parity requirement — the editor renders named fields, not key order.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FLOOR1_ACHIEVEMENTS,
  ACHIEVEMENT_ART_BACKLOG,
  buildAchievementArtBacklog,
  LOOT_BOX_TIERS,
} from '../../../src/shared/achievements';

import {
  loadAchievementsData,
  LOOT_BOX_TIERS as ADAPTER_LOOT_BOX_TIERS,
  ACHIEVEMENT_EDITOR_STORAGE_KEY,
} from '../../../.github/extensions/achievements/lib/achievements-data.mjs';

// This test file lives at <root>/tests/unit/devtools/, so three `..` hops land
// on the git worktree root — the same root the extension derives at runtime.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// structuredClone strips readonly/frozen wrappers so `toEqual` compares plain data.
const clone = (value: unknown) => structuredClone(value);

describe('achievements canvas adapter parity with src/shared/achievements', () => {
  const data = loadAchievementsData(REPO_ROOT);

  it('exposes the identical loot-box tier list (same values, same order)', () => {
    expect(ADAPTER_LOOT_BOX_TIERS).toEqual(clone(LOOT_BOX_TIERS));
    expect(data.lootBoxTiers).toEqual(clone(LOOT_BOX_TIERS));
  });

  it('produces achievements identical to FLOOR1_ACHIEVEMENTS after transforms', () => {
    expect(data.achievements).toEqual(clone(FLOOR1_ACHIEVEMENTS));
    expect(data.achievements).toHaveLength(FLOOR1_ACHIEVEMENTS.length);
  });

  it('derives an art backlog identical to the floor-1 slice of ACHIEVEMENT_ART_BACKLOG', () => {
    // The adapter is floor-1-scoped (see `data.achievements` parity above), so it
    // mirrors the backlog derived from FLOOR1_ACHIEVEMENTS. The full monolith
    // backlog additionally covers floor-2 catalog entries the canvas does not read.
    expect(data.artBacklog).toEqual(clone(buildAchievementArtBacklog(FLOOR1_ACHIEVEMENTS)));
    expect(ACHIEVEMENT_ART_BACKLOG.length).toBeGreaterThanOrEqual(data.artBacklog.length);
  });

  it('persists overrides under the same localStorage key as the monolith', () => {
    // The monolith uses this exact key (src/devtools-main.ts) — keeping it
    // identical is what makes the override model behaviourally equivalent.
    expect(ACHIEVEMENT_EDITOR_STORAGE_KEY).toBe('crawler.devtools.achievement-overrides.v1');
    expect(data.storageKey).toBe(ACHIEVEMENT_EDITOR_STORAGE_KEY);
  });
});
