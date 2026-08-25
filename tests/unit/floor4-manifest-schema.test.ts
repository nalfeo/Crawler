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

describe('floor4 manifest wave block', () => {
  it('rejects a wave cadence that does not fit inside the act wave window', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.waveIntervalMs = bad.floor4.phase.waveWindowMs;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a gate telegraph longer than the gap between waves', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.gateTelegraphMs = bad.floor4.waves!.waveIntervalMs + 1;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unregistered enemy pack', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.enemyPackId = 'floor4-does-not-exist';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a roster archetype that is not in the referenced pack', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.acts[0]!.roster[0]!.archetypeId = 'ghost-of-slice-4';
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicated archetype inside one act roster', () => {
    const bad = cloneFloor4Manifest();
    const roster = bad.floor4.waves!.acts[1]!.roster;
    roster[1]!.archetypeId = roster[0]!.archetypeId;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects act rosters authored out of act order', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.acts[0]!.act = 2;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-integer threat cost, which would break the budget spend loop', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.acts[0]!.roster[0]!.threatCost = 1.5;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an act whose first wave cannot afford its cheapest archetype', () => {
    const bad = cloneFloor4Manifest();
    bad.floor4.waves!.acts[0]!.roster[0]!.threatCost = 10_000;
    expect(floorManifestDefSchema.safeParse(bad).success).toBe(false);
  });
});
