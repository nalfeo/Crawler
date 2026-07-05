import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('equipment/inventory safe-room wiring', () => {
  it('keeps inventory unlock gating when equipment opens inventory panel', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('this.equipmentUI?.isOpen() &&');
    expect(source).toContain('unlocks.inventory &&');
    expect(source).toContain('!this.inventoryUI.isOpen()');
    expect(source).toContain('if (this.equipmentUI?.isOpen() && unlocks.inventory) {');
  });
});
