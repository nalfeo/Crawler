import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('MainGameScene mobile interaction guard', () => {
  it('keeps touch movement separate from tappable dialogue controls', async () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('private queuedInteraction = false;');
    expect(source).toContain('private queuedConversationClose = false;');
    expect(source).toContain('private dialogueBox?: DialogueBox;');
    expect(source).toContain('if (this.isTouchPointer(pointer)) {');
    expect(source).toContain('.setInteractive({ useHandCursor: true })');
    expect(source).toContain("this.interactionHint.on('pointerdown', () => {");
    expect(source).toContain('this.dialogueBox = createDialogueBox(this, {');
    expect(source).toContain('this.queuedConversationClose = true;');
    expect(source).toContain('const tapped = this.tappedInteraction || this.queuedInteraction;');
    expect(source).toContain('const closeRequested = this.queuedConversationClose;');
  });

  it('caps mobile button/hint scaling to avoid HUD overlap', async () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('const MOBILE_CORNER_BUTTON_MAX_SCALE = 1.4;');
    expect(source).toContain('const INTERACTION_HINT_MAX_SCALE = 1.25;');
    expect(source).toContain('const INTERACTION_HINT_BOTTOM_MARGIN = 12;');
    expect(source).toContain('const hintScale = Math.min(scale, INTERACTION_HINT_MAX_SCALE);');
    expect(source).toContain('.setY(GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN);');
    expect(source).toContain(
      'const buttonScale = Math.min(scale, MOBILE_CORNER_BUTTON_MAX_SCALE);',
    );
    expect(source).toContain('(this.inventoryButton?.height ?? 44) * buttonScale + 8');
  });
});
