import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import inventorybagLaneAccessRule from '../../tools/eslint-rules/inventorybag-lane-access.js';

function lint(code: string) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
          },
        },
        plugins: {
          crawler: {
            rules: {
              'no-direct-inventorybag-lane-read': inventorybagLaneAccessRule,
            },
          },
        },
        rules: {
          'crawler/no-direct-inventorybag-lane-read': 'error',
        },
      },
    ],
    '/home/runner/work/Crawler/Crawler/tests/fixtures/inventorybag-lane-access-rule-fixture.ts',
  );
}

describe('inventorybag lane access lint rule', () => {
  it('flags direct reads through aliases and non-null-wrapped inventories.get chains', () => {
    const messages = lint(`
      import type { InventoryBag } from '../../src/shared/inventory.js';

      declare const world: { inventories: Map<number, InventoryBag> };
      declare const eid: number;

      const bag = world.inventories.get(eid)!;
      const alias: InventoryBag = bag;

      bag.slots.push({ itemId: 'iron-ore', quantity: 1 });
      alias.generatedEquipment?.length;
      world.inventories.get(eid)!.slots.push({ itemId: 'pebble', quantity: 1 });
    `);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.message)).toEqual([
      expect.stringContaining('InventoryBag.slots'),
      expect.stringContaining('InventoryBag.generatedEquipment'),
      expect.stringContaining('InventoryBag.slots'),
    ]);
  });

  it('ignores unrelated .slots properties', () => {
    const messages = lint(`
      const hotbarSnapshot = { slots: [{ id: 'a' }] };
      const offer = { utility: { slots: ['head'] } };

      hotbarSnapshot.slots.length + offer.utility.slots.length;
    `);

    expect(messages).toEqual([]);
  });
});
