import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner lighting controls', () => {
  it('wires a persisted lil-gui lighting folder to the shared floor debug API', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toContain("const LAB_ID = 'ai-runner-lab';");
    expect(source).toContain('const gui = (controls as ControlsWithGui).__labGui;');
    expect(source).toContain('const persisted = loadLabState<AiRunnerLabState>(LAB_ID);');
    expect(source).toContain("const panelRoot = document.createElement('div');");
    expect(source).toContain("const lightingFolder = gui.addFolder('Lighting');");
    expect(source).toContain(
      'const tryGetLightingDebugApi = () => window.__floor1Debug?.lighting ?? null;',
    );
    expect(source).toContain('lighting.setConfig({ ...lightingSettings });');
    expect(source).toContain('lighting.usePreset(preset);');
    expect(source).toContain('saveLabState(LAB_ID, {');
    expect(source).toContain('panelRoot.innerHTML = `');
  });

  it('reapplies lighting settings after the AI runner scene reseeds', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');
    expect(source).toMatch(
      /phaserScene\.events\.once\(Phaser\.Scenes\.Events\.CREATE, \(\) => \{[\s\S]*applyLightingSettings\(\);[\s\S]*\}\);/,
    );
  });
});
