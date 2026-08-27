import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Guards the cross-layer wiring that lets an AI-driven playthrough (AI Runner
 * Lab, headless-adjacent recordings) actually get PAST the reward-opening
 * overlay (achievement box / boss chest reveal) instead of hanging on the
 * `summary` screen forever.
 *
 * `RewardOpeningUI.tick()` auto-advances `anticipation` -> `revealing` ->
 * `summary` on its own (see `reward-opening-sequence.ts`), but `summary` only
 * ever exits via an explicit click/Enter/Space/Escape input — there is no
 * human to press one during an AI-driven run, so without a driver the sim
 * stays frozen at `summary` indefinitely (issue: boss chest rewards display
 * indefinitely and the AI never accepts them). Mirrors the existing
 * `driveAutoBossIntro`/`driveAutoLevelUp` contracts covered by
 * `ai-level-up-ux-wiring.test.ts`.
 */
describe('AI playthrough reward-opening UX wiring', () => {
  it('MainGameScene drives the reward-opening summary via driveAutoRewardOpening', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('REWARD_OPENING_AUTO_HOLD_FRAMES');
    expect(source).toContain('private driveAutoRewardOpening(): void');
    expect(source).toContain('this.rewardOpeningUI.acknowledge();');
    // Must be invoked from the rewardOpeningUI-open early-return branch that
    // freezes the simulation, right alongside the deterministic tick() call —
    // a driver that exists but is never called would leave the original bug
    // in place.
    expect(source).toMatch(
      /this\.rewardOpeningUI\.tick\(delta\);\s*\n\s*this\.driveAutoRewardOpening\(\);/,
    );
  });

  it('driveAutoRewardOpening only fires once autoDriven and the summary phase is reached', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toMatch(
      /const autoDriven =\s*\n\s*this\.options\.isAutoDriven\?\.\(\) \?\? this\.options\.autoLevelUpAllocator !== undefined;\s*\n\s*if \(\s*!autoDriven \|\|\s*!this\.rewardOpeningUI\?\.isOpen\(\) \|\|\s*this\.rewardOpeningUI\.getPhase\(\) !== 'summary'/,
    );
    // The hold counter must reset whenever the condition above is not met, so
    // manual-control play (isAutoDriven() false) never auto-acknowledges.
    expect(source).toMatch(
      /this\.rewardOpeningUI\.getPhase\(\) !== 'summary'\s*\)\s*\{\s*\n\s*this\.rewardOpeningAutoHoldFrames = 0;/,
    );
  });

  it('AI Runner Lab wires isAutoDriven so the reward driver is active outside manual control', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('isAutoDriven: () => !manualControl,');
  });
});
