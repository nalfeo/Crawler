import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Floor 6 scenario presentation wiring', () => {
  it('keeps Floor 6 HUD state routed through the generic scenario presentation contract', () => {
    const contract = readFileSync('src/shared/scenario-presentation.ts', 'utf-8');
    const definitions = readFileSync('src/game/scenarioDefinitions.ts', 'utf-8');
    const scene = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

    expect(contract).toContain(
      'readonly getHudSnapshot?: (world: TWorld) => ScenarioHudSnapshot | null;',
    );
    expect(definitions).toContain('getHudSnapshot: getFloor6HudSnapshot');
    expect(definitions).toContain('getFloor6HudPresentation(world)');
    expect(scene).toContain('this.options.scenarioPresentation?.getHudSnapshot?.(this.world)');
    expect(scene).toContain('private updateScenarioHudSnapshot(panelOpen: boolean): void');
    expect(scene).toContain('this.rewardAudioEngine?.play({');
    expect(scene).toContain('private flashScenarioHudVfx(): void {');
  });
});
