import { describe, expect, it } from 'vitest';

import { generatedEquipmentTooltipDescription } from '../../src/engine/InventoryUI.js';
import { getItemById } from '../../src/shared/items.js';

describe('generatedEquipmentTooltipDescription', () => {
  it('uses authored item catalog flavor when the generated base maps to a known item', () => {
    expect(generatedEquipmentTooltipDescription({ baseId: 'iron-sword' })).toBe(
      getItemById('iron-sword')?.description,
    );
  });

  it('uses a neutral fallback for generated-only bases instead of metadata tags', () => {
    const description = generatedEquipmentTooltipDescription({
      baseId: 'equipment/weapon/bone-saw',
    });

    expect(description).toBe('A dungeon-forged reward with terms the producers refuse to print.');
    expect(description).not.toContain('equipment');
    expect(description).not.toContain('weapon');
    expect(description).not.toContain('bone-saw');
  });
});
