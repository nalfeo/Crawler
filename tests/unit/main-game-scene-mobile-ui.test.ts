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

  it('freezes movement/action input while any blocking HUD surface is open, not just Achievements', async () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    // Regression guard for #3252: touching the Equipment/Abilities/Inventory/
    // Quartermaster panels must not let the player drift into an NPC and
    // accidentally start a conversation. The zeroing check must key off the
    // shared isBlockingSurfaceOpen() predicate, not an Achievements-only
    // special case.
    expect(source).toContain('this.inputCapture.poll(this.inputState);');
    expect(source).toContain('if (this.isBlockingSurfaceOpen()) {');
    expect(source).toContain('this.inputState.moveX = 0;');
    expect(source).toContain('this.inputState.moveY = 0;');
    expect(source).toContain('this.inputState.action = false;');

    // The zeroing block must key off isBlockingSurfaceOpen() *after* polling,
    // not a lingering Achievements-only special case somewhere else.
    const pollThenZero =
      /this\.inputCapture\.poll\(this\.inputState\);\s*(?:\/\/[^\n]*\n\s*)*if \(this\.isBlockingSurfaceOpen\(\)\) \{\s*this\.inputState\.moveX = 0;\s*this\.inputState\.moveY = 0;\s*this\.inputState\.action = false;\s*\}/;
    expect(source).toMatch(pollThenZero);
  });

  it('caps mobile button/hint scaling to avoid HUD overlap', async () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(source).toContain('const MOBILE_CORNER_BUTTON_MAX_SCALE = 1.4;');
    expect(source).toContain('const INTERACTION_HINT_MAX_SCALE = 1.25;');
    expect(source).toContain('const INTERACTION_HINT_BOTTOM_MARGIN = 12;');
    expect(source).toContain('const hintScale = Math.min(scale, INTERACTION_HINT_MAX_SCALE);');
    // The hint sits above the bottom safe-area inset, not the raw canvas edge,
    // so it stays clear of the iOS home indicator in landscape.
    expect(source).toContain(
      'return GAME.HEIGHT - INTERACTION_HINT_BOTTOM_MARGIN - getSafeAreaInsets(this).bottom;',
    );
    expect(source).toContain('.setY(this.interactionHintY());');
    expect(source).toContain(
      'const buttonScale = Math.min(scale, MOBILE_CORNER_BUTTON_MAX_SCALE);',
    );
    expect(source).toContain('(this.inventoryButton?.height ?? 44) * buttonScale + 8');
  });
});

describe('HUD panel UX consistency', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('all saferoom panels require safeCtx to open', () => {
    // Inventory
    expect(source).toContain(
      'unlocks.inventory && safeCtx && !isUiLockOpen() && inventoryToggleRequested',
    );
    // Equipment
    expect(source).toContain(
      'unlocks.equipmentPanel && safeCtx && !isUiLockOpen() && equipRequested',
    );
    // Abilities — must now also require safeCtx
    expect(source).toContain(
      'unlocks.spells && safeCtx && !isUiLockOpen() && abilitiesToggleRequested',
    );
    // Achievements — gated via achievementsAvailable which includes safeCtx
    expect(source).toContain(
      'const achievementsAvailable = safeCtx && this.world.achievements.unlockedIds.size > 0',
    );
  });

  it('[B] toggle-closes the abilities surface when it is open', () => {
    expect(source).toContain('if (this.abilityLoadoutUI?.isOpen()) {');
    expect(source).toContain('if (abilitiesToggleRequested && abilitiesOpen) {');
    expect(source).toContain('this.closeAbilitiesModal();');
    expect(source).toContain('private closeAbilitiesModal(): void {');
  });

  it('abilities modal auto-closes when the player leaves the safe room', () => {
    expect(source).toContain('} else if (abilitiesOpen && !safeCtx) {');
    // Both the condition and the close call must be present (separate assertions
    // avoid a fragile regex with a variable-length gap between them)
    expect(source).toContain('abilitiesOpen && !safeCtx');
    expect(source).toContain('this.closeAbilitiesModal();');
  });

  it('tracks whether the abilities config surface is open', () => {
    expect(source).toContain('private abilitiesModalOpen = false;');
    expect(source).toContain('this.abilitiesModalOpen = true;');
    expect(source).toContain('this.abilitiesModalOpen = false;');
  });

  it('touch dismiss: each panel button remains visible while its own panel is open', () => {
    expect(source).toContain('inventoryOpen || canOpenNew');
    expect(source).toContain('equipOpen || canOpenNew');
    expect(source).toContain('achievementsOpen || canOpenNew');
    expect(source).toContain('abilitiesOpen || canOpenNew');
    expect(source).toContain('MODAL_DISMISS_BUTTON_DEPTH');
  });

  it('abilities touch button is wired and included in corner-button hit-test', () => {
    expect(source).toContain('this.abilitiesButton = makeCornerButton(');
    expect(source).toContain("'🔮 Skills'");
    expect(source).toContain('isCornerButtonHit(this.abilitiesButton)');
  });

  it('abilities touch button is scaled and destroyed with the other corner buttons', () => {
    expect(source).toContain('this.abilitiesButton?.setScale(buttonScale);');
    expect(source).toContain('this.abilitiesButton?.destroy();');
    expect(source).toContain('this.abilitiesButton = undefined;');
  });

  it('scene shutdown destroys the remaining HUD panels and reward audio engine', () => {
    expect(source).toContain('this.dialogueBox?.destroy();');
    expect(source).toContain('this.hudUi?.destroy();');
    expect(source).toContain('this.inventoryUI?.destroy();');
    expect(source).toContain('this.equipmentUI?.destroy();');
    expect(source).toContain('this.achievementsUI?.destroy();');
    expect(source).toContain('this.rewardOpeningUI?.destroy();');
    expect(source).toContain('this.shopPanelUI?.destroy();');
    expect(source).toContain('this.rewardAudioEngine?.dispose();');
  });

  it('reward-opening visibility changes clear queued keyboard latches', () => {
    expect(source).toContain('onVisibilityChange: (open) => {');
    expect(source).toContain('this.clearPendingInteractionInput();');
  });
});
