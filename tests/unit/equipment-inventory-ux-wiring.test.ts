import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('equipment/inventory safe-room wiring', () => {
  it('keeps equipment toggle independent from standalone inventory panel', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('this.closeCharacterPanels({ keepEquipment: true });');
    expect(source).toContain('this.equipmentUI?.toggle(this.world);');
    expect(source).toContain(
      'auto-open the standalone InventoryUI — [I] still opens the full pack.',
    );
    expect(source).not.toContain('!this.inventoryUI.isOpen()');
  });
});
