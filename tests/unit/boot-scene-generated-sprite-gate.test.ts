import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression guard for the BootScene generated-sprite preload gate.
 *
 * BootScene defers starting MainGameScene until the generated sprite manifest
 * fetch and Phaser loader cycle complete (or a timeout fires). Three invariants
 * must hold so generated enemy art is available before main scene boot and
 * boot can never silently hang:
 *
 *   1. `startMainGame()` is idempotent via the `startedMainGame` guard, so the
 *      success, failure, and timeout paths cannot start the main scene twice.
 *   2. Both the loader-COMPLETE path and the timeout fallback resolve through
 *      the shared `finalize()` continuation and eventually call
 *      `startMainGame()`, so boot proceeds even if the loader stalls.
 *   3. The timeout uses the `GENERATED_SPRITE_LOAD_TIMEOUT_MS` constant rather
 *      than an inline literal, so the bound is reviewable and tunable.
 *
 * BootScene is Phaser-coupled and not instantiable headlessly, so we assert
 * against its source the same way the other scene unit tests do
 * (see e.g. tests/unit/main-game-scene-simulation-pause.test.ts).
 */
describe('BootScene generated sprite preload gate', () => {
  const source = readFileSync('src/engine/scenes/BootScene.ts', 'utf-8');

  it('declares a named timeout constant for the generated sprite load wait', () => {
    expect(source).toMatch(/const GENERATED_SPRITE_LOAD_TIMEOUT_MS\s*=\s*\d+/);
  });

  it('guards startMainGame() with an idempotent startedMainGame flag', () => {
    expect(source).toMatch(
      /private startMainGame\(\)[\s\S]*?if \(this\.startedMainGame\)[\s\S]*?return;[\s\S]*?this\.startedMainGame = true;[\s\S]*?this\.scene\.start\(MainGameScene\.KEY\)/,
    );
  });

  it('uses the named timeout constant for the load fallback (no inline literal)', () => {
    expect(source).toContain('GENERATED_SPRITE_LOAD_TIMEOUT_MS);');
  });

  it('starts the main game from the loader COMPLETE path', () => {
    // The loader-complete handler resolves through finalize(); after the
    // await resolves, startMainGame() is invoked.
    expect(source).toMatch(
      /this\.load\.on\(Phaser\.Loader\.Events\.COMPLETE, onComplete\)[\s\S]*?this\.startMainGame\(\);/,
    );
  });

  it('starts the main game from the timeout fallback path', () => {
    expect(source).toMatch(
      /setTimeout\(\(\) => \{[\s\S]*?finalize\(\);[\s\S]*?\}, GENERATED_SPRITE_LOAD_TIMEOUT_MS\)/,
    );
    // finalize() resolves the awaited promise, after which startMainGame() runs.
    expect(source).toMatch(
      /finalize\(\);[\s\S]*?\}, GENERATED_SPRITE_LOAD_TIMEOUT_MS\);[\s\S]*?this\.startMainGame\(\);/,
    );
  });

  it('starts the main game from the manifest-fetch failure path', () => {
    expect(source).toMatch(/catch \(err\) \{[\s\S]*?this\.startMainGame\(\);[\s\S]*?\}/);
  });

  it('calls preloadTerrainPacks in preload() so pack door textures are available at boot', () => {
    expect(source).toContain('preloadTerrainPacks(this.load)');
  });
});
