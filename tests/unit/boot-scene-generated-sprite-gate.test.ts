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

  it('removes preload progress listeners before starting generated-sprite load cycle', () => {
    expect(source).toMatch(/this\.load\.off\('progress'\);/);
    expect(source).toMatch(/this\.load\.off\('fileprogress'\);/);
  });

  it('advances the reserved 80→100% segment on both success and error file events', () => {
    expect(source).toMatch(/this\.load\.on\(Phaser\.Loader\.Events\.FILE_COMPLETE, onFileResolved\);/);
    expect(source).toMatch(/this\.load\.on\(Phaser\.Loader\.Events\.FILE_LOAD_ERROR, onFileResolved\);/);
    expect(source).toMatch(/this\.load\.off\(Phaser\.Loader\.Events\.FILE_COMPLETE, onFileResolved\);/);
    expect(source).toMatch(/this\.load\.off\(Phaser\.Loader\.Events\.FILE_LOAD_ERROR, onFileResolved\);/);
    expect(source).toMatch(/this\.setLoadingProgress\(0\.8 \+ 0\.2 \* \(loaded \/ queued\.length\)\);/);
  });

  // Render-fix linchpin: terrain-pack textures must be queued in preload() so
  // they are resident before MainGameScene bakes terrain. Without this call a
  // pack-using floor (Floor 2 → industrial-cave) silently falls through the
  // renderer's textures.exists() guard to the legacy tileset and renders ZERO
  // pack tiles. `preloadTerrainPacks` itself is covered by
  // terrain-pack-visuals.test.ts; this guards that BootScene actually invokes it.
  it('queues terrain-pack textures inside preload() — not create() (Floor 2 pack render fix)', () => {
    expect(source).toMatch(
      /import \{[\s\S]*?preloadTerrainPacks[\s\S]*?\} from '\.\.\/sprites\/terrain-pack-visuals\.js';/,
    );
    // Pin the call to the preload() method body: it must appear textually AFTER
    // the preload() declaration and BEFORE the create() declaration. A bare
    // "appears somewhere after preload()" match would still pass if the call
    // drifted into create() — but Phaser only completes preload-queued loads
    // before create() runs, so a call in create() leaves pack textures unloaded
    // when MainGameScene bakes terrain (the exact 0-pack-tile regression).
    const preloadDeclIdx = source.search(/preload\s*\(\s*\)\s*:/);
    const createDeclIdx = source.search(/create\s*\(\s*\)\s*:/);
    const callIdx = source.indexOf('preloadTerrainPacks(this.load)');
    expect(preloadDeclIdx).toBeGreaterThanOrEqual(0);
    expect(createDeclIdx).toBeGreaterThan(preloadDeclIdx);
    expect(callIdx).toBeGreaterThan(preloadDeclIdx);
    expect(callIdx).toBeLessThan(createDeclIdx);
  });
});
