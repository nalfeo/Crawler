import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('MainGameScene mobile interaction guard', () => {
  it('keeps touch movement separate from tappable dialogue controls', async () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('private queuedInteraction = false;');
    expect(source).toContain('private queuedConversationClose = false;');
    expect(source).toContain('private dialogueCloseButton?: Phaser.GameObjects.Text;');
    expect(source).toContain('if (this.isTouchPointer(pointer)) {');
    expect(source).toContain('.setInteractive({ useHandCursor: true })');
    expect(source).toContain("this.interactionHint.on('pointerdown', () => {");
    expect(source).toContain("this.dialogueCloseButton.on('pointerdown', () => {");
    expect(source).toContain('const tapped = this.tappedInteraction || this.queuedInteraction;');
    expect(source).toContain('const closeRequested = this.queuedConversationClose;');
  });

  it('exposes mobile inventory and equip tap buttons', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('private inventoryButton?: Phaser.GameObjects.Text;');
    expect(source).toContain('private equipButton?: Phaser.GameObjects.Text;');
    expect(source).toContain("this.inventoryButton.on('pointerdown', () => {");
    expect(source).toContain("this.equipButton.on('pointerdown', () => {");
    // Buttons shown/hidden based on feature unlock state
    expect(source).toContain('this.inventoryButton?.setVisible(unlocks.inventory)');
    expect(source).toContain('this.equipButton?.setVisible(unlocks.equipment)');
  });

  it('shows a directional quest arrow pointing toward the merchant', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('private questArrow?: Phaser.GameObjects.Text;');
    expect(source).toContain('private updateQuestArrow(): void {');
    expect(source).toContain('COMPASS_ARROWS');
    // Arrow visible only while rat-tail held but charm not yet purchased
    expect(source).toContain('!unlocks.inventory || unlocks.equipment');
    expect(source).toContain('Merchant');
  });
});
