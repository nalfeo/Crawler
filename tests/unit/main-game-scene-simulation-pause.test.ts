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
});
