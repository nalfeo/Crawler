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
    expect(source).toContain('autoResolve(allocations: Partial<Record<StatKey, number>>): void');
    // Drives the same reducers a clicking player would, then confirms.
    expect(source).toMatch(/autoResolve[\s\S]*incrementStat\(state, stat\)/);
    expect(source).toMatch(/autoResolve[\s\S]*dispatch\(confirm\(state\)\)/);
  });

  it('MainGameScene drives the modal via an optional autoLevelUpAllocator', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain('autoLevelUpAllocator?:');
    expect(source).toContain('LEVEL_UP_AUTO_HOLD_FRAMES');
    expect(source).toContain('private driveAutoLevelUp(): void');
    expect(source).toContain('this.levelUpUI.autoResolve(allocations)');
    // The driver must keep running while the level-up modal remains open.
    expect(source).toMatch(/levelUpUI\?\.isOpen\(\)[\s\S]*this\.driveAutoLevelUp\(\)/);
  });

  it('AI Runner Lab wires the allocator and no longer auto-spends stat points', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('autoLevelUpAllocator: computeAutoStatAllocation');
    // The pre-modal bypass must be gone so the modal can actually open.
    expect(source).not.toContain('autoAllocateStatPoints');
  });
});
