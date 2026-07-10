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
    expect(source).toMatch(
      /if\s*\(\s*nextIndex\s*>=\s*activeDialogue\.length\s*\)[\s\S]*?broker\?\.met\s*\(\s*this\.world\s*\)/,
    );
  });

  it('early-close (closeRequested / ESC) returns before entering the nextIndex block', () => {
    // The close-request guard must contain a `return` statement so it exits
    // before the nextIndex advancement and broker callback are reached.
    expect(source).toMatch(
      /if\s*\(\s*closeRequested\s*\|[\s\S]*?keyEsc[\s\S]*?\)\s*\{[\s\S]*?return;[\s\S]*?\}/,
    );

    // Verify that closeRequested/ESC block comes BEFORE the `broker?.met` call
    // in the source — early-close exits before the callback is ever reached.
    const closeIdx = source.indexOf('closeRequested');
    const brokerIdx = source.indexOf('broker?.met');
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(brokerIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(brokerIdx);
  });

  it('broker.met is NOT called in the early-close branch', () => {
    // The close-guard block must not contain `broker?.met`.
    const closeBlockMatch = source.match(
      /if\s*\(\s*closeRequested[\s\S]*?\{[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(closeBlockMatch).not.toBeNull();
    expect(closeBlockMatch![0]).not.toContain('broker');
  });
});
