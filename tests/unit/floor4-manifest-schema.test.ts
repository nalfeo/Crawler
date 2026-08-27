import { describe, expect, it } from 'vitest';
import { floor4Manifest, floorManifestDefSchema } from '../../src/shared/floor-manifest.js';

type ManifestWithFloor4 = typeof floor4Manifest & {
  floor4: NonNullable<typeof floor4Manifest.floor4>;
};

function cloneFloor4Manifest(): ManifestWithFloor4 {
  return structuredClone(floor4Manifest) as ManifestWithFloor4;
}

describe('floor4 manifest schema cross-field geometry rules', () => {
  it('accepts the authored floor4 manifest geometry', () => {
    expect(floorManifestDefSchema.safeParse(cloneFloor4Manifest()).success).toBe(true);
  });

  it('rejects a tunnel wider than the Green Room height', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.tunnel.widthTiles = bad.floor4.greenRoom.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects pillars that would meet in the middle of the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.pillarInsetTiles = 19;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a Green Room taller than the arena', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.greenRoom.heightTiles = bad.floor4.arena.heightTiles + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects tunnel geometry whose mouth collides with the east feed gate', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.arena.heightTiles = 40;
    bad.floor4.tunnel.widthTiles = 20;
    bad.floor4.greenRoom.heightTiles = 20;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects phase timing whose windows do not add up to the act duration', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.phase.headlineWindowMs += 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('floor4 manifest schema wave rules', () => {
  it('rejects a wave pack that is not registered', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.enemyPackId = 'not-a-real-pack';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a budget curve that does not cover every act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.budget.actMultipliers = bad.floor4.waves.budget.actMultipliers.slice(0, -1);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a cadence whose last wave releases after the wave window closes', () => {
    const bad = cloneFloor4Manifest();
    // Eight waves 20s apart need 140s of window; the authored window is shorter,
    // so the final waves could never release before the cut.
    bad.floor4.waves.cadence.intervalMs = 20_000;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a live cap above what the wave pack allows on screen', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.concurrency.liveCap = 500;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a roster that skips an act', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.rosters = bad.floor4.waves.rosters.filter((roster) => roster.act !== 3);
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a roster archetype that is not in the wave pack', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves.rosters[0]!.entries[0]!.archetypeId = 'goblin-that-never-was';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
