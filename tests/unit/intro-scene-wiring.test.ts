/**
 * Intro scene wiring tests.
 *
 * Guards that:
 *  1. IntroScene is included in the shipped game config (floor-game-config).
 *  2. The game world ships with `playerName` and `playerGender` defaults.
 *  3. The director intro text contains the {playerName} template.
 *  4. INTRO_DATA_REGISTRY_KEY is stable and used by both IntroScene and MainGameScene.
 *  5. IntroScene auto-skips in lab/headless contexts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import {
  INTRO_DATA_REGISTRY_KEY,
  DEFAULT_PLAYER_NAME,
  DEFAULT_PLAYER_GENDER,
} from '../../src/shared/intro-config.js';

describe('IntroScene wiring', () => {
  it('IntroScene is included in the floor game config scene list', () => {
    const source = readFileSync('src/bootstrap/floor-game-config.ts', 'utf-8');
    expect(source).toContain('IntroScene');
    expect(source).toContain('new IntroScene()');
  });

  it('IntroScene is exported from the engine index', () => {
    const source = readFileSync('src/engine/index.ts', 'utf-8');
    expect(source).toContain('export { IntroScene }');
  });

  it('INTRO_DATA_REGISTRY_KEY is a stable non-empty string', () => {
    expect(typeof INTRO_DATA_REGISTRY_KEY).toBe('string');
    expect(INTRO_DATA_REGISTRY_KEY.length).toBeGreaterThan(0);
  });

  it('IntroScene uses INTRO_DATA_REGISTRY_KEY from shared', () => {
    const introSource = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    // Must import from shared intro-config, not from MainGameScene.
    expect(introSource).toContain("from '../../shared/intro-config.js'");
    expect(introSource).toContain('INTRO_DATA_REGISTRY_KEY');
  });

  it('MainGameScene uses INTRO_DATA_REGISTRY_KEY from shared', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toContain("from '../../shared/intro-config.js'");
    expect(source).toContain('INTRO_DATA_REGISTRY_KEY');
  });

  it('IntroScene auto-skips when URL contains ?lab= (isLabContext)', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    // The skip check must look for the 'lab' search param.
    expect(source).toContain("params.has('lab')");
    // And should start BootScene directly without showing UI.
    expect(source).toContain('advanceToGame');
    expect(source).toContain('isLabContext');
  });

  it('IntroScene auto-skips on non-browser (headless) environments', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    expect(source).toContain("typeof window === 'undefined'");
  });

  it('IntroScene cleans up DOM controls from the Phaser shutdown lifecycle', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    expect(source).toContain(
      'this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.handleShutdown())',
    );
    expect(source).toContain('this.removeDomControls();');
  });

  it('IntroScene gives the native name input an accessible label', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    expect(source).toContain("input.setAttribute('aria-label', NAME_INPUT_ARIA_LABEL);");
  });

  it('IntroScene uses native radio inputs for keyboard-accessible gender selection', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    expect(source).toContain("input.type = 'radio';");
    expect(source).toContain("fieldset.setAttribute('aria-label', GENDER_GROUP_ARIA_LABEL);");
  });

  it('IntroScene applies the live render scale before building its UI', () => {
    const source = readFileSync('src/engine/scenes/IntroScene.ts', 'utf-8');
    expect(source).toContain("import { getRenderScale } from '../render-scale.js';");
    expect(source).toContain('this.cameras.main.setOrigin(0, 0);');
    expect(source).toContain('this.cameras.main.setZoom(renderScale);');
  });
});

describe('GameWorld player identity defaults', () => {
  it('world.playerName defaults to Rhea Vale', () => {
    const world = createTestWorld();
    expect(world.playerName).toBe(DEFAULT_PLAYER_NAME);
  });

  it('world.playerGender defaults to female', () => {
    const world = createTestWorld();
    expect(world.playerGender).toBe(DEFAULT_PLAYER_GENDER);
  });
});

describe('Director intro template', () => {
  it('floor1 director intro contains {playerName} template', () => {
    const scenario = getScenarioDefinition('floor1');
    expect(scenario.director.intro).toContain('{playerName}');
  });

  it('MainGameScene queueDirectorCommentary substitutes {playerName}', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    expect(source).toMatch(/replace\(\/\{playerName\}\/g,\s*\(\)\s*=>\s*this\.world\.playerName\)/);
  });

  it('callback substitution preserves dollar tokens in player names', () => {
    const template = 'Director: Welcome, {playerName}.';
    const playerName = 'A$&B';
    expect(template.replace(/{playerName}/g, () => playerName)).toBe('Director: Welcome, A$&B.');
  });

  it('floor1 floorScenario protagonistName derives from world.playerName', () => {
    const source = readFileSync('src/game/floorScenario.ts', 'utf-8');
    expect(source).toContain('protagonistName: world.playerName');
  });

  it('MainGameScene applies intro data before configureWorld (so scenario init sees chosen name)', () => {
    const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
    const introIdx = source.indexOf('this.game.registry.get(INTRO_DATA_REGISTRY_KEY)');
    const configureIdx = source.indexOf('configureWorld?.(');
    expect(introIdx).toBeGreaterThan(0);
    expect(configureIdx).toBeGreaterThan(0);
    expect(introIdx).toBeLessThan(configureIdx);
  });
});
