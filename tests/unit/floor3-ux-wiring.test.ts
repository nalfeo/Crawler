import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const mainGameSceneSource = read('../../src/engine/scenes/MainGameScene.ts');
const headlessRunnerSource = read('../../src/game/ai/headless-runner.ts');
const labMainSource = read('../../src/lab-main.ts');
const labSource = read('../../src/labs/floor3-ux-lab/index.ts');
const scenarioDefinitionsSource = read('../../src/game/scenarioDefinitions.ts');

const FLOOR3_PARTY_LAB_IDS = [
  ['floor3-party-hud-lab', 'party-hud'],
  ['floor3-roster-lab', 'roster'],
  ['floor3-level-up-notice-lab', 'level-up-notice'],
  ['floor3-ability-command-lab', 'ability-command'],
  ['floor3-matchup-lab', 'matchup'],
] as const;

describe('Floor 3 UX surface wiring', () => {
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

  it('never strands the loadout pause when a picked option is not in the offer', () => {
    // `selectLoadoutOption` is the only exit from `'loadout'`, so the confirm
    // handler must dispatch even for an unmatched option id.
    expect(mainGameSceneSource).toContain(
      'this.options.selectLoadoutOption?.(this.world, Math.max(0, choiceIndex));',
    );
  });

  it('registers the floor3-ux-lab so `?lab=floor3-ux-lab` loads it', () => {
    expect(labMainSource).toContain("'floor3-ux-lab': '/src/labs/floor3-ux-lab/index.ts'");
    expect(labSource).toContain('registerLab(LAB_ID, {');
    expect(labSource).toContain("const LAB_ID = 'floor3-ux-lab';");
    // The lab must exercise the shipped builders, not lab-local copy.
    expect(labSource).toContain("from '../../shared/floor3-ux.js'");
  });

  it('creates, syncs, and destroys the Floor 3 party HUD inside HudUI', () => {
    const hudUi = read('../../src/engine/HudUI.ts');
    expect(hudUi).toContain('import { createHudFloor3Party');
    expect(hudUi).toContain('const floor3Party = createHudFloor3Party(scene);');
    expect(hudUi).toContain('floor3Party.sync(world, playerEid);');
    expect(hudUi).toContain('floor3Party.destroy();');
  });

  it('exposes the party HUD read-back and command verb from HudUI', () => {
    const hudUi = read('../../src/engine/HudUI.ts');
    expect(hudUi).toContain('getFloor3PartyState: floor3Party.getState,');
    expect(hudUi).toContain('issueFloor3Command: floor3Party.issueCommand,');
  });

  it('hides the party HUD while the map overlay is open', () => {
    const hudUi = read('../../src/engine/HudUI.ts');
    expect(hudUi).toContain('floor3Party.setVisible(!hidden && !overlayOpen);');
  });

  it('mounts the roster overlay and binds the [R] and [C] verbs in MainGameScene', () => {
    expect(mainGameSceneSource).toContain('this.floor3RosterUI = createFloor3RosterUI(this);');
    expect(mainGameSceneSource).toContain('Phaser.Input.Keyboard.KeyCodes.R');
    expect(mainGameSceneSource).toContain('Phaser.Input.Keyboard.KeyCodes.C');
    expect(mainGameSceneSource).toContain('this.floor3RosterUI?.open(this.world);');
    expect(mainGameSceneSource).toContain('this.issueCompanionCommandFromInput();');
  });

  it('treats the roster overlay as a blocking surface and destroys it on shutdown', () => {
    expect(mainGameSceneSource).toMatch(
      /isBlockingSurfaceOpen\(\)[\s\S]*floor3RosterUI\?\.isOpen\(\)/,
    );
    expect(mainGameSceneSource).toMatch(/if \(this\.floor3RosterUI\?\.isOpen\(\)\)[\s\S]*return;/);
    expect(mainGameSceneSource).toContain('this.floor3RosterUI?.destroy();');
  });

  it('gates both verbs on the Floor 3 party being present', () => {
    expect(mainGameSceneSource).toContain(
      "import { shouldShowFloor3Party } from '../floor3-party-state.js';",
    );
    expect(mainGameSceneSource).toContain(
      'const floor3PartyAvailable = shouldShowFloor3Party(this.world);',
    );
    expect(mainGameSceneSource).toMatch(/rosterToggleRequested && floor3PartyAvailable/);
    expect(mainGameSceneSource).toMatch(/commandRequested &&[\s\S]{0,120}floor3PartyAvailable/);
  });

  it('wires Floor 3 roster and command touch buttons', () => {
    expect(mainGameSceneSource).toContain('this.floor3RosterButton = makeCornerButton');
    expect(mainGameSceneSource).toContain('this.requestFloor3RosterToggle();');
    expect(mainGameSceneSource).toContain('this.floor3CommandButton = makeCornerButton');
    expect(mainGameSceneSource).toContain('this.requestCompanionCommand();');
  });

  it.each(FLOOR3_PARTY_LAB_IDS)('registers the %s lab module path', (labId, dir) => {
    expect(labMainSource).toContain(`'${labId}': '/src/labs/floor3-ux-lab/${dir}/index.ts'`);
    const source = read(`../../src/labs/floor3-ux-lab/${dir}/index.ts`);
    expect(source).toContain(`registerLab('${labId}'`);
    expect(source).toContain('createFloor3UxLab(');
  });

  it('mounts the real HudUI (not a stand-in) in the shared lab harness', () => {
    const harness = read('../../src/labs/floor3-ux-lab/harness.ts');
    expect(harness).toContain("import { createHudUI } from '../../engine/HudUI.js';");
    expect(harness).toContain('hud.sync(fixture.world, fixture.playerEid);');
  });
});
