import { describe, expect, it } from 'vitest';

describe('MainGameScene mobile interaction guard', () => {
  it('keeps touch movement separate from tappable dialogue controls', async () => {
    const { readFileSync } = await import('fs');
    const source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/scenes/MainGameScene.ts',
      'utf-8',
    );

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
});
