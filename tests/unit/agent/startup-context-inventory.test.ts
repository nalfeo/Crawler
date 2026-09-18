import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_CONTEXT_ITEMS,
  MAX_OUTPUT_CHARS,
  STARTUP_CONTEXT_SOURCES,
  collectStartupContextInventory,
  formatStartupContextInventory,
} from '../../../scripts/agent/docs/startup-context-inventory.js';

const roots: string[] = [];
function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'crawler-context-'));
  roots.push(root);
  for (const [index, source] of STARTUP_CONTEXT_SOURCES.entries()) {
    const target = path.join(root, source.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'x'.repeat(index + 1), 'utf8');
  }
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('startup context inventory', () => {
  it('uses normalized lexical ordering and conservative per-item token estimates', () => {
    const inventory = collectStartupContextInventory(fixtureRoot());
    expect(inventory.items.map((item) => item.path)).toEqual(
      [...inventory.items.map((item) => item.path)].sort(),
    );
    expect(
      inventory.items.every((item) => item.estimatedTokens === Math.ceil(item.characters / 3)),
    ).toBe(true);
  });

  it('keeps an absent optional pointer visible without adding to totals', () => {
    const root = fixtureRoot();
    rmSync(path.join(root, '.github/copilot-instructions.md'));
    const inventory = collectStartupContextInventory(root);
    const pointer = inventory.items.find((item) => item.path === '.github/copilot-instructions.md');
    expect(pointer).toMatchObject({ included: false, bytes: 0, characters: 0, estimatedTokens: 0 });
    expect(pointer?.reason).toContain('absent');
  });

  it('adds bytes, characters, and token estimates across included inputs', () => {
    const inventory = collectStartupContextInventory(fixtureRoot());
    expect(inventory.totals).toEqual(
      inventory.items.reduce(
        (totals, item) => ({
          bytes: totals.bytes + item.bytes,
          characters: totals.characters + item.characters,
          estimatedTokens: totals.estimatedTokens + item.estimatedTokens,
        }),
        { bytes: 0, characters: 0, estimatedTokens: 0 },
      ),
    );
  });

  it('has a fixed item count and bounded report even when an input is large', () => {
    const root = fixtureRoot();
    writeFileSync(path.join(root, 'AGENTS.md'), 'z'.repeat(100_000), 'utf8');
    const inventory = collectStartupContextInventory(root);
    expect(inventory.items).toHaveLength(MAX_CONTEXT_ITEMS);
    expect(formatStartupContextInventory(inventory).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });
});
