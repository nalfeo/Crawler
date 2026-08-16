import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findAiForceEquipViolations } from '../../scripts/agent/health/ai-equip-parity-lib.js';

/**
 * Regression coverage for the AI/human equipment-parity guard.
 *
 * The bug class this guard exists for: the headless AI runner is the balance
 * oracle (Rule 12 gates the Floor 1 win-rate on it), so an AI-only privilege —
 * historically `equipFromBag(..., { force: true })`, which skips the
 * `isInSafeContext` gate every human equipment-panel action is bound by — makes
 * the oracle measure a game no player can play. "No force in the AI path" was a
 * recurring review finding, so it became this deterministic check.
 */
describe('ai-equip-parity guard', () => {
  const withFixture = (files: Record<string, string>, run: (root: string) => void): void => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-equip-parity-'));
    try {
      for (const [relative, contents] of Object.entries(files)) {
        const full = path.join(dir, relative);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, contents);
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('flags a forced equip in the AI path', () => {
    withFixture(
      { 'auto.ts': 'const r = equipFromBag(world, eid, itemId, { force: true });\n' },
      (root) => {
        const { violations } = findAiForceEquipViolations(root, root);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.file).toBe('auto.ts');
        expect(violations[0]?.line).toBe(1);
      },
    );
  });

  it('flags a forced equip hidden behind a variable rather than a literal', () => {
    // The original code spelled it `forceEquip ? { force: true } : undefined`,
    // so a literal-only matcher would have missed the reintroduction.
    withFixture({ 'loop.ts': 'equip(world, eid, def, { force: shouldForce });\n' }, (root) => {
      const { violations } = findAiForceEquipViolations(root, root);
      expect(violations).toHaveLength(1);
    });
  });

  it('accepts an ungated equip call', () => {
    withFixture({ 'clean.ts': 'const r = equipFromBag(world, eid, itemId);\n' }, (root) => {
      expect(findAiForceEquipViolations(root, root).violations).toEqual([]);
    });
  });

  it('ignores prose about force in comments', () => {
    withFixture(
      {
        'documented.ts': [
          '// equipFromBag deliberately does not pass { force: true } here.',
          ' * The force: true bypass was removed — see the parity contract.',
          'equipFromBag(world, eid, itemId);',
        ].join('\n'),
      },
      (root) => {
        expect(findAiForceEquipViolations(root, root).violations).toEqual([]);
      },
    );
  });

  it('does not flag a force option passed to a non-equipment function', () => {
    withFixture({ 'other.ts': 'refreshWaypoints(world, { force: true });\n' }, (root) => {
      expect(findAiForceEquipViolations(root, root).violations).toEqual([]);
    });
  });

  it('scans nested directories', () => {
    withFixture(
      {
        'nested/deep/planner.ts': 'unequip(world, eid, slot, { force: true });\n',
        'nested/ok.ts': 'unequip(world, eid, slot);\n',
      },
      (root) => {
        const { violations, scannedFiles } = findAiForceEquipViolations(root, root);
        expect(scannedFiles).toBe(2);
        expect(violations.map((v) => v.file)).toEqual(['nested/deep/planner.ts']);
      },
    );
  });

  it('passes against the real src/game/ai tree', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', 'src', 'game', 'ai');
    const { violations } = findAiForceEquipViolations(root);
    expect(violations).toEqual([]);
  });
});
