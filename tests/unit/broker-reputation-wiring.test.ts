/**
 * Guards the MainGameScene broker callback wiring that activates the Floor 2
 * reputation system only when the player reads the Broker's LAST dialogue line.
 *
 * Two critical invariants are asserted at the source level:
 *
 * 1. **Final-line path**: `broker?.met` is called inside the
 *    `nextIndex >= activeDialogue.length` branch — i.e., only after advancing
 *    past the last dialogue line.
 *
 * 2. **Early-close path**: the early-close branch (`closeRequested || ESC`)
 *    executes its `return` BEFORE the `nextIndex` block is ever entered, so
 *    `broker?.met` cannot be reached via the close path.
 *
 * This prevents the reputation system from remaining permanently locked (broker
 * never called) or prematurely unlocked (broker called on ESC).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MainGameScene — Broker reputation callback wiring', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('calls broker.met only inside the final-dialogue-line branch', () => {
    // The callback must be nested inside `if (nextIndex >= activeDialogue.length)`.
    // Use a bounded pattern: the broker call must appear within ~200 chars of the
    // branch opening to avoid matching across unrelated code.
    const branchIdx = source.indexOf('if (nextIndex >= activeDialogue.length)');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    const brokerCallIdx = source.indexOf('this.options.broker?.met(this.world)');
    expect(brokerCallIdx).toBeGreaterThanOrEqual(0);
    // Broker call is after the branch opening and within a short block.
    expect(brokerCallIdx).toBeGreaterThan(branchIdx);
    expect(brokerCallIdx - branchIdx).toBeLessThan(300);
  });

  it('early-close (closeRequested / ESC) returns before entering the nextIndex block', () => {
    // The close-request guard must have a `return` before `nextIndex` is computed.
    const closeGuardIdx = source.indexOf(
      'if (closeRequested || (this.keyEsc && Phaser.Input.Keyboard.JustDown(this.keyEsc)))',
    );
    const nextIndexIdx = source.indexOf('const nextIndex = instance.dialogueIndex + 1');
    expect(closeGuardIdx).toBeGreaterThanOrEqual(0);
    expect(nextIndexIdx).toBeGreaterThanOrEqual(0);

    // The close guard appears before the nextIndex block.
    expect(closeGuardIdx).toBeLessThan(nextIndexIdx);

    // There is a `return;` between the close guard and the nextIndex computation.
    const between = source.slice(closeGuardIdx, nextIndexIdx);
    expect(between).toContain('return;');
  });

  it('broker.met is NOT called in the early-close branch', () => {
    // The region between the close guard and the nextIndex computation must not
    // contain a broker callback — broker fires only on the final-line path.
    const closeGuardIdx = source.indexOf(
      'if (closeRequested || (this.keyEsc && Phaser.Input.Keyboard.JustDown(this.keyEsc)))',
    );
    const nextIndexIdx = source.indexOf('const nextIndex = instance.dialogueIndex + 1');
    expect(closeGuardIdx).toBeGreaterThanOrEqual(0);
    expect(nextIndexIdx).toBeGreaterThanOrEqual(0);

    const closeBlock = source.slice(closeGuardIdx, nextIndexIdx);
    expect(closeBlock).not.toContain('broker');
  });

  it('reuses a stable dialogue snapshot while a conversation is active', () => {
    expect(source).toContain('this.activeConversationLines ??');
    expect(source).toContain('this.activeConversationLines = [...activeDialogue];');
    expect(source).toContain('this.activeConversationLines = null;');
  });
});
