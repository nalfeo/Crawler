import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner paused enemy hover wiring', () => {
  it('shows a paused hover tooltip with enemy name, eid, and health', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain('let pausedEnemyHoverText: Phaser.GameObjects.Text | null = null;');
    expect(source).toContain(
      'const ensurePausedEnemyHoverText = (): Phaser.GameObjects.Text | null => {',
    );
    expect(source).toContain('const syncPausedEnemyHoverTooltip = (): void => {');
    expect(source).toContain('const simulationPaused = scene?.isSimulationPaused?.() ?? isPaused;');
    expect(source).toContain('resolveEnemyDisplayName(world, eid)');
    expect(source).toContain('.setDepth(UI_DEPTH_CUTOFF)');
    expect(source).not.toMatch(
      /const ensurePausedEnemyHoverText = \(\): Phaser\.GameObjects\.Text \| null => \{[\s\S]*?getCamera\('ui'\)[\s\S]*?pausedEnemyHoverText[\s\S]*?return pausedEnemyHoverText;/,
    );
    expect(source).toContain('`eid: ${hoveredEnemy.eid}\\n`');
    expect(source).toContain('`health: ${hoveredEnemy.currentHp}/${hoveredEnemy.maxHp}`');
    expect(source).toContain('syncPausedEnemyHoverTooltip();');
    expect(source).toContain('pausedEnemyHoverText?.destroy();');
  });
});
