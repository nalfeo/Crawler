import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('AI playthrough shopkeeper UX wiring', () => {
  it('MainGameScene exposes inventory/equip hooks and processes them while paused', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('public requestInventoryToggle(): void');
    expect(source).toContain('public requestEquipAction(): void');
    expect(source).toContain('public isInventoryOpen(): boolean');
    expect(source).toMatch(
      /if \(this\.simulationPaused && this\.pendingSimulationSteps <= 0\) \{[\s\S]*this\.updateFeatureUnlocks\(\);[\s\S]*return;/,
    );
  });

  it('AI Runner Lab previews the inventory before equipping shop gear', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('const INVENTORY_PREVIEW_TICKS = 4;');
    expect(source).toContain('scene.requestInventoryToggle();');
    expect(source).toContain('scene.requestEquipAction();');
    expect(source).not.toContain('sceneOptions.shopkeeper?.equip(world, playerEid);');
  });

  it('AI Runner Lab confirms the Spell Broker modal only for an active broker intent', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('isSpellBrokerPurchaseActive(getSpellBrokerIntent(world))');
    expect(source).toMatch(
      /spellBroker\.purchaseSpell\(world, playerEid, offer\.spellId\)[\s\S]{0,120}markSpellBrokerPurchased\(world\)/,
    );
    expect(source).toMatch(
      /if \(manualControl\) \{[\s\S]{0,180}return;[\s\S]{0,120}const scene = getScene\(\);/,
    );
  });
});
