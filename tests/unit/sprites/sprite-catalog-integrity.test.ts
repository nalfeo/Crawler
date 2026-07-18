/**
 * Regression tests for sprite-catalog.json data integrity.
 *
 * These tests read the actual catalog file and assert structural invariants.
 * They serve as deterministic guards against copy-paste errors that manual or
 * automated code review might flag — such as a `note` field saying "ghost"
 * when the entry is for a goblin sprite.
 *
 * Regression: PR #1505 had `sprite:enemy.goblin` with `note: "Tiny Dungeon
 * ghost (frame 121)"` contradicting `description: "Tiny Dungeon goblin (frame
 * 121)"`. The fix is reflected in the test's pass condition.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CATALOG_PATH = path.join(process.cwd(), 'src', 'shared', 'data', 'sprite-catalog.json');

/** Extracts the entity-name token from a Kenney-style label like:
 *  "Tiny Dungeon goblin (frame 121) — temp CC0 art."
 *  → "goblin"
 *  Returns null if the string doesn't match the expected pattern. */
function extractKenneyEntityName(text: string): string | null {
  const match = String(text ?? '').match(/^Tiny Dungeon ([^(]+)\(frame/);
  return match ? match[1].trim().toLowerCase() : null;
}

type CatalogEntry = {
  id: string;
  kind: string;
  description?: string;
  note?: string;
  sheetKey?: string;
};

describe('sprite-catalog.json integrity', () => {
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  const catalog: CatalogEntry[] = JSON.parse(raw);

  it('contains at least one sprite entry', () => {
    const sprites = catalog.filter((e) => e.kind === 'sprite');
    expect(sprites.length).toBeGreaterThan(0);
  });

  it('has no kenney sprite entry where note entity-name contradicts description entity-name', () => {
    const conflicts: string[] = [];

    for (const entry of catalog) {
      if (entry.kind !== 'sprite') continue;
      if (entry.sheetKey !== 'kenney-tiny-dungeon') continue;
      if (!entry.description || !entry.note) continue;

      const descName = extractKenneyEntityName(entry.description);
      const noteName = extractKenneyEntityName(entry.note);

      if (descName !== null && noteName !== null && descName !== noteName) {
        conflicts.push(`${entry.id}: description says "${descName}" but note says "${noteName}"`);
      }
    }

    expect(conflicts).toEqual([]);
  });
});
