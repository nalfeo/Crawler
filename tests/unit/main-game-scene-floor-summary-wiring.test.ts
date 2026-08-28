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
    // One assertion so the cursor cannot be declared, the counter cannot be
    // called, and the cursor cannot be dropped as the third argument
    // independently — dropping only the argument would silently recount
    // prior-step deaths on any frame that runs more than one simulation step.
    expect(source).toMatch(
      /const combatEventsBeforeStep = this\.world\.combatEvents\.length;[\s\S]*?countPlayerAttributedKills\(\s*this\.world\.combatEvents,\s*this\.playerEid,\s*combatEventsBeforeStep,?\s*\)/,
    );
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
    // Pinned to the update-loop freeze specifically (bridge sync + camera +
    // overlay, then `return`). Matching a bare `if (this.pendingFloorTransition)`
    // would be satisfied by the earlier pointer-handler branch and stay green
    // even if this freeze were deleted.
    expect(source).toMatch(
      /if \(this\.pendingFloorTransition\) \{\s*this\.bridge\.sync\(this\.world\);\s*this\.updateCamera\(\);\s*this\.updateOverlayText\(\);\s*return;\s*\}/,
    );
  });

  it('omits the accuracy row when weapon telemetry could not measure it', () => {
    // `accuracy` is 0 both for "missed everything" and for "no swings at all",
    // and BEAM/TRAP casts count as swings while their damage stays untagged —
    // either case would render a false 0% to the player.
    expect(source).toMatch(
      /weaponTelemetry\.swings > 0 && weaponTelemetry\.unattributedSwings === 0/,
    );
  });
});
