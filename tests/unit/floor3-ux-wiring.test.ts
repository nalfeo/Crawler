import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const mainGameSceneSource = read('../../src/engine/scenes/MainGameScene.ts');
const headlessRunnerSource = read('../../src/game/ai/headless-runner.ts');
const labMainSource = read('../../src/lab-main.ts');
const labSource = read('../../src/labs/floor3-ux-lab/index.ts');
const scenarioDefinitionsSource = read('../../src/game/scenarioDefinitions.ts');

describe('Floor 3 UX surface wiring (slice 12)', () => {
  it('routes every Floor 3 loadout pause through the single priority resolver', () => {
    expect(mainGameSceneSource).toContain('this.openFloor3LoadoutSurface();');
    expect(mainGameSceneSource).toContain('private openFloor3LoadoutSurface(): void {');
    // Intro before pickers, poach before starter.
    const introIndex = mainGameSceneSource.indexOf('buildFloor3IntroModel()');
    const poachIndex = mainGameSceneSource.indexOf('buildFloor3PoachPickerModel(');
    const starterIndex = mainGameSceneSource.indexOf('buildFloor3StarterPickerModel(');
    expect(introIndex).toBeGreaterThan(-1);
    expect(introIndex).toBeLessThan(poachIndex);
    expect(poachIndex).toBeLessThan(starterIndex);
  });

  it('renders the surfaces from the shared builders rather than inline copy', () => {
    expect(mainGameSceneSource).toContain("from '../../shared/floor3-ux.js'");
    expect(mainGameSceneSource).not.toContain('Choose your starter Companion');
  });

  it('gates the briefing on an acknowledgement flag so it shows once per floor entry', () => {
    expect(mainGameSceneSource).toContain('private floor3IntroAcknowledged = false;');
    expect(mainGameSceneSource).toContain('if (!this.floor3IntroAcknowledged) {');
    expect(mainGameSceneSource).toContain('this.floor3IntroAcknowledged = true;');
  });

  it('routes Floor 3 scenario loadout picks through the starter/poach dispatcher', () => {
    expect(scenarioDefinitionsSource).toContain('selectLoadoutOption: selectFloor3LoadoutOption,');
  });

  it('resolves mid-run loadout pauses in the headless runner so a poach cannot stall a run', () => {
    expect(headlessRunnerSource).toMatch(
      /if \(readRunState\(world\) === 'loadout' && scenario\.selectLoadoutOption\) \{\s*scenario\.selectLoadoutOption\(world, 0\);/,
    );
  });

  it('registers the floor3-ux-lab so `?lab=floor3-ux-lab` loads it', () => {
    expect(labMainSource).toContain("'floor3-ux-lab': '/src/labs/floor3-ux-lab/index.ts'");
    expect(labSource).toContain('registerLab(LAB_ID, {');
    expect(labSource).toContain("const LAB_ID = 'floor3-ux-lab';");
    // The lab must exercise the shipped builders, not lab-local copy.
    expect(labSource).toContain("from '../../shared/floor3-ux.js'");
  });
});
