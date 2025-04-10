import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Stat-system overhaul, plan resolution #4: "Assert zero `stores.stats`
 * reads remain under src." The old generic `stores.stats` (the `Stats`
 * component/store) was removed in favor of `stores.effectiveStats` as the
 * SOLE runtime stat snapshot (resolution #1) — TypeScript already makes a
 * reintroduced `world.stores.stats` access a compile error (the property no
 * longer exists on `WorldStores`), but this is the explicit, self-contained
 * deterministic assertion the plan calls for, independent of whether some
 * future refactor of `WorldStores` accidentally reintroduces a same-named
 * field.
 */

const SRC_ROOT = path.resolve(__dirname, '../../src');

/** Matches `stores.stats` as a literal property-access substring (word boundary
 * after "stats" so it does not confuse `stores.statModifiers` or
 * `stores.effectiveStats`/`stores.baseStats`, which are different, valid stores). */
const LEGACY_STATS_STORE_PATTERN = /stores\.stats\b/;

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('legacy stores.stats store is fully removed from src/', () => {
  it('no src/ file reads/writes the removed generic stores.stats store', () => {
    const offenders: string[] = [];
    for (const file of listFilesRecursive(SRC_ROOT)) {
      const content = readFileSync(file, 'utf-8');
      if (LEGACY_STATS_STORE_PATTERN.test(content)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity: the pattern does not false-positive on the real EffectiveStats/BaseStats/StatModifiers stores', () => {
    expect(LEGACY_STATS_STORE_PATTERN.test('world.stores.effectiveStats.armor[eid]')).toBe(false);
    expect(LEGACY_STATS_STORE_PATTERN.test('world.stores.baseStats.strength[eid]')).toBe(false);
    expect(LEGACY_STATS_STORE_PATTERN.test('world.statModifiers.push(mod)')).toBe(false);
    expect(LEGACY_STATS_STORE_PATTERN.test('world.stores.coreStatPoints.luck[eid]')).toBe(false);
    expect(LEGACY_STATS_STORE_PATTERN.test('world.stores.stats.damage[eid]')).toBe(true);
    expect(LEGACY_STATS_STORE_PATTERN.test('world.stores.stats[stat][eid]')).toBe(true);
  });
});
