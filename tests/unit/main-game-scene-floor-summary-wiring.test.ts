/**
 * Source-contract guard for the between-floor summary wiring in the real
 * `MainGameScene` (issue #3678). The scene is Phaser-coupled, so the behavior
 * itself is observed by `tests/e2e/floor-summary-screen.test.ts`; this guard
 * pins the wiring facts that make that behavior possible so they cannot be
 * silently dropped:
 *
 * - the summary is built from the shared pure model,
 * - kills are counted per simulation step from the pre-step event cursor
 *   (`combatEvents` is drained once per rendered frame, not per step),
 * - an AI-driven run keeps its timed auto-advance so nothing automated hangs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../src/engine/scenes/MainGameScene.ts', import.meta.url),
  'utf8',
);

describe('MainGameScene between-floor summary wiring', () => {
  it('builds the summary from the shared pure model', () => {
    expect(source).toContain("from '../../shared/floor-summary.js'");
    expect(source).toContain('buildFloorSummaryRows(');
    expect(source).toContain('formatFloorSummaryText(');
  });

  it('counts kills per simulation step from the pre-step event cursor', () => {
    expect(source).toContain('const combatEventsBeforeStep = this.world.combatEvents.length;');
    expect(source).toMatch(/countPlayerAttributedKills\(\s*this\.world\.combatEvents,/);
  });

  it('keeps the timed auto-advance for AI-driven runs', () => {
    expect(source).toMatch(
      /if \(this\.isRunAutoDriven\(\)\) \{[\s\S]*?startFloorTransitionProgress/,
    );
  });

  it('accepts pointer/touch acknowledgement before the touch filter', () => {
    const pointerHandler = source.slice(source.indexOf('private handlePointerDown('));
    const ackIndex = pointerHandler.indexOf('this.floorSummaryAckRequested = true;');
    const touchFilterIndex = pointerHandler.indexOf('this.isTouchPointer(pointer)');
    expect(ackIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeLessThan(touchFilterIndex);
  });

  it('freezes the fixed step while the summary waits for the player', () => {
    expect(source).toMatch(/if \(this\.pendingFloorTransition\) \{[\s\S]*?return;/);
  });
});
