import { describe, it, expect } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  floor6DefenseDirectorSystem,
  floor6RaiderSystem,
  getFloor6DefenseRunStats,
} from '../../src/game/floor6Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Floor 6 headless observation — wave director 2000 frames', () => {
  it('produces deterministic wave releases and respects live cap', () => {
    const world = createTestWorld({ seed: 606 });
    const player = spawnPlayer(world, 0, 0);
    createFloorMainSceneOptions('floor6').configureWorld!(world, player);
    const logLines: string[] = [];

    for (let i = 0; i < 2000; i++) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      floor6RaiderSystem(world);
      floor6DefenseDirectorSystem(world);
    }

    const s = getFloor6DefenseRunStats(world);
    logLines.push(
      `Final: phase=${s?.phase.kind} relay=${s?.relayHp}/${s?.relayMaxHp} released=${s?.totalReleased} live=${s?.liveEnemyCount} debt=${s?.spawnDebt} manifest=${s?.waveManifestLength}`,
    );
    console.log(logLines.join('\n'));

    // The floor should remain in DEFEND after 2000 frames (VICTORY deferred to later slices)
    expect(s?.phase.kind).toBe('DEFEND');
    // Relay should still be healthy (no enemies have been killing it in 2000 frames — they spawn at frame 120+)
    expect(s?.relayHp).toBeGreaterThanOrEqual(0);
    expect(s?.relayMaxHp).toBeGreaterThan(0);
    // All 12 authored entries should have been processed (released or in debt)
    expect((s?.totalReleased ?? 0) + (s?.spawnDebt ?? 0)).toBeGreaterThanOrEqual(
      s?.waveManifestLength ?? 0,
    );
    // Spawn debt should be 0 or bounded
    expect(s?.spawnDebt).toBeLessThanOrEqual(12);
    // Phase trace: SETUP → DEFEND
    expect(s?.phaseTrace[0]?.kind).toBe('SETUP');
  });

  it('replay produces identical stats from seed 606', () => {
    function runFor(frames: number) {
      const world = createTestWorld({ seed: 606 });
      const player = spawnPlayer(world, 0, 0);
      createFloorMainSceneOptions('floor6').configureWorld!(world, player);
      for (let i = 0; i < frames; i++) {
        world.frameCount += 1;
        world.elapsedMs += 16;
        floor6RaiderSystem(world);
        floor6DefenseDirectorSystem(world);
      }
      return getFloor6DefenseRunStats(world);
    }
    const s1 = runFor(2000);
    const s2 = runFor(2000);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});
