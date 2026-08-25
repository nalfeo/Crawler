import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LAB_IDS = [
  ['floor3-party-hud-lab', 'party-hud'],
  ['floor3-roster-lab', 'roster'],
  ['floor3-level-up-notice-lab', 'level-up-notice'],
  ['floor3-ability-command-lab', 'ability-command'],
  ['floor3-matchup-lab', 'matchup'],
] as const;

describe('Floor 3 UX surface wiring', () => {
  const hudUi = readFileSync('src/engine/HudUI.ts', 'utf-8');
  const scene = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
  const labMain = readFileSync('src/lab-main.ts', 'utf-8');

  it('creates, syncs, and destroys the Floor 3 party HUD inside HudUI', () => {
    expect(hudUi).toContain('import { createHudFloor3Party');
    expect(hudUi).toContain('const floor3Party = createHudFloor3Party(scene);');
    expect(hudUi).toContain('floor3Party.sync(world, playerEid);');
    expect(hudUi).toContain('floor3Party.destroy();');
  });

  it('exposes the party HUD read-back and command verb from HudUI', () => {
    expect(hudUi).toContain('getFloor3PartyState: floor3Party.getState,');
    expect(hudUi).toContain('issueFloor3Command: floor3Party.issueCommand,');
  });

  it('hides the party HUD while the map overlay is open', () => {
    expect(hudUi).toContain('floor3Party.setVisible(!hidden && !overlayOpen);');
  });

  it('mounts the roster overlay and binds the [R] and [C] verbs in MainGameScene', () => {
    expect(scene).toContain('this.floor3RosterUI = createFloor3RosterUI(this);');
    expect(scene).toContain('Phaser.Input.Keyboard.KeyCodes.R');
    expect(scene).toContain('Phaser.Input.Keyboard.KeyCodes.C');
    expect(scene).toContain('this.floor3RosterUI?.open(this.world);');
    expect(scene).toContain('this.issueCompanionCommandFromInput();');
  });

  it('treats the roster overlay as a blocking surface and destroys it on shutdown', () => {
    expect(scene).toMatch(/isBlockingSurfaceOpen\(\)[\s\S]*floor3RosterUI\?\.isOpen\(\)/);
    expect(scene).toMatch(/if \(this\.floor3RosterUI\?\.isOpen\(\)\)[\s\S]*return;/);
    expect(scene).toContain('this.floor3RosterUI?.destroy();');
  });

  it('gates both verbs on the Floor 3 party being present', () => {
    expect(scene).toContain("import { shouldShowFloor3Party } from '../floor3-party-state.js';");
    expect(scene).toContain('const floor3PartyAvailable = shouldShowFloor3Party(this.world);');
    expect(scene).toMatch(/rosterToggleRequested && floor3PartyAvailable/);
    expect(scene).toMatch(/commandRequested &&[\s\S]{0,120}floor3PartyAvailable/);
  });

  it('wires Floor 3 roster and command touch buttons', () => {
    expect(scene).toContain('this.floor3RosterButton = makeCornerButton');
    expect(scene).toContain('this.requestFloor3RosterToggle();');
    expect(scene).toContain('this.floor3CommandButton = makeCornerButton');
    expect(scene).toContain('this.requestCompanionCommand();');
  });

  it.each(LAB_IDS)('registers the %s lab module path', (labId, dir) => {
    expect(labMain).toContain(`'${labId}': '/src/labs/floor3-ux-lab/${dir}/index.ts'`);
    const source = readFileSync(`src/labs/floor3-ux-lab/${dir}/index.ts`, 'utf-8');
    expect(source).toContain(`registerLab('${labId}'`);
    expect(source).toContain('createFloor3UxLab(');
  });

  it('mounts the real HudUI (not a stand-in) in the shared lab harness', () => {
    const harness = readFileSync('src/labs/floor3-ux-lab/harness.ts', 'utf-8');
    expect(harness).toContain("import { createHudUI } from '../../engine/HudUI.js';");
    expect(harness).toContain('hud.sync(fixture.world, fixture.playerEid);');
  });
});
