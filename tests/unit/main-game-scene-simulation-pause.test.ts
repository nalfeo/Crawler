import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression guard for the AI Runner Lab Pause / Advance-frame controls.
 *
 * MainGameScene's fixed-step loop drains `pendingSimulationSteps` one step per
 * loop iteration while the simulation is paused. The decrement previously used
 * `- steps`, but `steps` is still 0 at that point (it increments at the end of
 * the loop body), so the queue never drained. `pendingSimulationSteps` stayed
 * > 0 forever, the `simulationPaused && pendingSimulationSteps <= 0` early-return
 * guard never re-armed, and the scene kept stepping every frame — so the lab's
 * Pause button (and single-frame Advance) appeared to do nothing.
 *
 * MainGameScene is Phaser-coupled and not instantiable headlessly, so we assert
 * against its source the same way the other MainGameScene unit tests do.
 */
describe('MainGameScene simulation pause / step accounting', () => {
  const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

  it('freezes the fixed-step loop while paused with no pending steps', () => {
    expect(source).toMatch(
      /if \(this\.simulationPaused && this\.pendingSimulationSteps <= 0\) \{[\s\S]*return;/,
    );
  });

  it('consumes exactly one pending step per executed sim step', () => {
    expect(source).toContain(
      'this.pendingSimulationSteps = Math.max(0, this.pendingSimulationSteps - 1);',
    );
  });

  it('does not decrement pending steps by the loop counter (the stuck-queue bug)', () => {
    expect(source).not.toContain('this.pendingSimulationSteps - steps');
  });

  it("re-polls the catch-up AI override before this iteration's clock increment (headless poll-before-step parity)", () => {
    // The telegraphed-shot dodge math in bt-ai-provider.ts reads world.elapsedMs
    // live at poll time and assumes it always observes the value from BEFORE
    // the current step's own increment (matching headless-runner.ts's
    // poll(); runSimulationStep() ordering). If the catch-up re-poll below
    // ever moved to run AFTER frameCount/elapsedMs are bumped, the in-browser
    // AI would see one extra step of telegraph time already elapsed relative
    // to headless, shifting the dodge-horizon boundary by a frame between the
    // two AI-driving contexts (copilot-pull-request-reviewer finding).
    const loopStart = source.indexOf(
      'while (this.accumulator >= GAME.DELTA_MS && steps < maxStepsThisFrame)',
    );
    expect(loopStart).toBeGreaterThan(-1);

    const pollIndex = source.indexOf('this.inputCapture.poll(this.inputState);', loopStart);
    const frameCountIndex = source.indexOf('this.world.frameCount += 1;', loopStart);
    const elapsedMsIndex = source.indexOf('this.world.elapsedMs += GAME.DELTA_MS;', loopStart);

    expect(pollIndex).toBeGreaterThan(loopStart);
    expect(frameCountIndex).toBeGreaterThan(pollIndex);
    expect(elapsedMsIndex).toBeGreaterThan(pollIndex);
  });

  it('restores the exact pre-report pause state after closing the issue flow', () => {
    expect(source).toContain('this.issueReportPausedState = this.isSimulationPaused();');
    expect(source).toContain('this.setSimulationPaused(true);');
    expect(source).toContain('this.setSimulationPaused(wasPaused);');
  });

  it('does not reopen the issue flow while a submission remains in flight', () => {
    expect(source).toContain('this.issueReportSubmitting ||');
    expect(source).toContain('!this.issueReportSubmitting &&');
  });

  it('keeps issue reporting independent of active UX while excluding terminal states', () => {
    expect(source).not.toMatch(/canFileIssue[\s\S]{0,300}isBlockingSurfaceOpen/);
    expect(source).toContain("this.world.state !== 'game_over'");
    expect(source).toContain('!this.floorCompletionMessagePending');
  });

  it('reuses the same prepared issue payload across retry attempts', () => {
    expect(source).toContain('this.issueReportRetryPayload ??');
    expect(source).toContain('this.issueReportRetryPayload = payload;');
  });
});
