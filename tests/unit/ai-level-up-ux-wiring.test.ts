import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Guards the cross-layer wiring that makes the in-browser AI playthrough use the
 * REAL level-up stat-allocation UX instead of bypassing it. The pure allocation
 * decision is tested in `auto-stat-allocation.test.ts`; this protects the
 * integration points so the bypass (auto-spending points before the modal can
 * open) cannot silently return.
 */
describe('AI playthrough level-up UX wiring', () => {
  it('LevelUpUI exposes autoResolve that drives the real allocation state machine', () => {
    const source = readFileSync('src/engine/LevelUpUI.ts', 'utf-8');
    expect(source).toContain(
      'autoResolve(allocations: Partial<Record<PrimaryStatId, number>>): void',
    );
    // Drives the same reducers a clicking player would, then confirms.
    expect(source).toMatch(/autoResolve[\s\S]*incrementStat\(state, stat\)/);
    expect(source).toMatch(/autoResolve[\s\S]*dispatch\(confirm\(state\)\)/);
  });

  it('LevelUpUI uses larger stat +/- button touch targets', () => {
    const source = readFileSync('src/engine/LevelUpUI.ts', 'utf-8');
    expect(source).toContain('const STAT_BUTTON_SIZE = 34;');
    expect(source).toContain('const size = STAT_BUTTON_SIZE;');
    expect(source).toContain('const plusX = rowRight - STAT_BUTTON_SIZE - 6;');
    expect(source).toContain(
      'const btnY = rowY + Math.round((ROW_HEIGHT - STAT_BUTTON_SIZE) / 2);',
    );
  });

  it('LevelUpUI consumes shared allocatable-stat policy', () => {
    const source = readFileSync('src/engine/LevelUpUI.ts', 'utf-8');
    expect(source).toContain('isAllocatablePrimaryStat');
    expect(source).toContain('const canAllocateStat = (stat: PrimaryStatId): boolean =>');
    expect(source).toContain('remaining > 0 && canAllocateStat(stat)');
    expect(source).toContain('if (canAllocateStat(selectedStat(state)))');
  });

  it('MainGameScene drives the modal via an optional autoLevelUpAllocator', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('autoLevelUpAllocator?:');
    expect(source).toContain('LEVEL_UP_AUTO_HOLD_FRAMES');
    expect(source).toContain('private driveAutoLevelUp(): void');
    expect(source).toContain('this.levelUpUI.autoResolve(allocations)');
    // driveAutoLevelUp() must appear in BOTH the open-modal early-return branch
    // (freezes simulation while modal is up) AND the level_up state-transition
    // branch (first frame after level-up fires). A single call-site would mean
    // one of the two paths is unguarded and the stall regression can return.
    const driveCalls = (source.match(/this\.driveAutoLevelUp\(\)/g) ?? []).length;
    expect(driveCalls).toBeGreaterThanOrEqual(2);
  });

  it('AI Runner Lab wires the allocator and no longer auto-spends stat points', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('autoLevelUpAllocator: (world: GameWorld');
    expect(source).toContain(
      'computeAiStatAllocation(world, playerEid, available, aiConfig.weaponPersonas)',
    );
    expect(source).toContain('autoFloor2ProgressionSystem(world, playerEid);');
    expect(source).toContain(
      'const config = createFloorGameConfig(canvas, sceneOptions, currentFloor);',
    );
    // The pre-modal bypass must be gone so the modal can actually open.
    expect(source).not.toContain('autoAllocateStatPoints');
  });

  it('AI Runner Lab allocator returns null during manual control so the human can allocate', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    // The allocator must gate on manualControl and return null when it is active,
    // so driveAutoLevelUp() leaves the modal open for the human player.
    expect(source).toMatch(/autoLevelUpAllocator[\s\S]{0,200}manualControl\s*\?\s*null/);
  });

  it('MainGameScene driveAutoLevelUp resets hold counter and bails when allocator returns null', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    // When the allocator returns null, the hold timer must be reset so manual
    // control leaves the modal fully open without auto-confirming.
    expect(source).toContain('if (allocations === null)');
    expect(source).toMatch(/allocations === null[\s\S]{0,200}levelUpAutoHoldFrames = 0/);
  });
});
