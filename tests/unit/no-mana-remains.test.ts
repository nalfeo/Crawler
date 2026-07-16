import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Stat-system overhaul, resolution #7: "REMOVE MANA ENTIRELY — world MP
 * state, shared mana constants/helper, mana system/pipeline/export, mpCost
 * schema/data/presentation/gating/spending, HUD/layout/config, mana lab,
 * mana item/data, exports/tests." This is the deterministic backstop: a
 * recursive source scan across the ENTIRE `src/` tree (not just the files we
 * remember touching) so a stray mana reference reintroduced later — in a new
 * file, a copy-pasted comment, an item/achievement id — fails loudly instead
 * of silently reappearing.
 *
 * `\bmana\b` uses word boundaries so it does NOT flag "manage"/"management"/
 * "manager"/"manatee" — only the standalone word "mana" (case-insensitive),
 * matching how the removed resource was actually named throughout the
 * codebase (mpCost, playerMp, ManaBar, mana-flask, mana-lab, etc. — the other
 * patterns below catch the non-word-boundary-safe short forms).
 */

const SRC_ROOT = path.resolve(__dirname, '../../src');

const BANNED_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'the word "mana"', pattern: /\bmana\b/i },
  { label: 'mpCost', pattern: /mpCost/i },
  { label: 'playerMp / playerMaxMp world fields', pattern: /playerMp|playerMaxMp/ },
  { label: 'ManaBar', pattern: /ManaBar/i },
  {
    label: 'a mana-* slug (item/lab/skill id)',
    pattern: /mana-(flask|lab|efficiency|miser|bender)/i,
  },
];

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx|json)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('mana is completely removed from src/', () => {
  const files = listFilesRecursive(SRC_ROOT);

  it('scans a non-trivial number of source files (guards against a silently-empty sweep)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  for (const { label, pattern } of BANNED_PATTERNS) {
    it(`no src/ file contains ${label}`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        if (pattern.test(content)) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
