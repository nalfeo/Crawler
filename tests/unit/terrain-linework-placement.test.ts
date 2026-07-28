/**
 * Placement guard for `planLinework` — the deterministic half of the Floor 2
 * industrial-linework done-state.
 *
 * The agreed gate is:
 *
 *   >= 6 distinct runs of >= 40 contiguous tiles each, with >= 60% of total run
 *   length within `hubRadiusTiles` of a boss den or the resource-heart room.
 *
 * That gate is *observed* on a booted Floor 2 through the probe seam, but a
 * browser observation cannot run in CI, so this suite pins the same metric on a
 * synthetic cavern using the SHIPPED manifest parameters. If someone retunes
 * `spursPerHub` / `trunkRoutes` / `hubRadiusTiles` down far enough to collapse
 * the network, this fails before the art ever gets rendered.
 *
 * It also pins determinism, which is the property the whole pack depends on:
 * two players on the same floor seed must see the same rails in the same place.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  planLinework,
  LINEWORK_EMPTY,
  LINEWORK_WALL_ENTRY,
  type LineworkHub,
  type LineworkLayerParams,
  type LineworkPlanRequest,
} from '../../src/shared/terrain-linework.js';
import type { TerrainPackDef } from '../../src/shared/terrain-pack-types.js';

const MIN_LONG_RUNS = 6;
const MIN_RUN_TILES = 40;
const MIN_CONCENTRATION = 0.6;

const manifest = JSON.parse(
  readFileSync(
    path.join(
      path.resolve(import.meta.dirname, '..', '..'),
      'src',
      'shared',
      'data',
      'terrain-packs',
      'industrial-cave.manifest.json',
    ),
    'utf8',
  ),
) as TerrainPackDef;

const MAP_SIZE = 200;

/**
 * A cavern with the same footprint as Floor 2: open rock with a wall border and
 * a lattice of rock outcrops, so routing has to actually navigate rather than
 * draw a straight line between two points. The outcrops are blocks rather than
 * single tiles so route termini regularly land against rock — that is what
 * exercises the pipe layer's wall-entry path.
 */
function buildSyntheticMap(): { routable: Uint8Array; wall: Uint8Array } {
  const routable = new Uint8Array(MAP_SIZE * MAP_SIZE);
  const wall = new Uint8Array(MAP_SIZE * MAP_SIZE);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const index = y * MAP_SIZE + x;
      const border = x < 3 || y < 3 || x >= MAP_SIZE - 3 || y >= MAP_SIZE - 3;
      const outcrop = x % 11 < 3 && y % 9 < 3;
      if (border || outcrop) wall[index] = 1;
      else routable[index] = 1;
    }
  }
  return { routable, wall };
}

/** Same spread of hubs the real Floor 2 produces (boss dens + resource heart). */
const HUBS: readonly LineworkHub[] = [
  { tx: 100, ty: 100 },
  { tx: 126, ty: 48 },
  { tx: 149, ty: 120 },
  { tx: 67, ty: 150 },
  { tx: 48, ty: 64 },
];

function paramsFor(layerId: string): LineworkLayerParams {
  const layer = (manifest.linework ?? []).find((l) => l.id === layerId);
  if (!layer) throw new Error(`manifest has no linework layer '${layerId}'`);
  return {
    spursPerHub: layer.spursPerHub,
    trunkRoutes: layer.trunkRoutes,
    hubRadiusTiles: layer.hubRadiusTiles,
    awayFromHubCost: layer.awayFromHubCost,
    turnPenalty: layer.turnPenalty,
    entersWalls: layer.kind === 'pipe',
    seedSalt: layer.seedSalt,
  };
}

function request(layerId: string, floorSeed: number): LineworkPlanRequest {
  const { routable, wall } = buildSyntheticMap();
  return {
    width: MAP_SIZE,
    height: MAP_SIZE,
    routable,
    wall,
    hubs: HUBS,
    floorSeed,
    params: paramsFor(layerId),
  };
}

const LAYER_IDS = (manifest.linework ?? []).map((l) => l.id);

describe('planLinework placement gate', () => {
  it('ships the layers this suite guards', () => {
    expect(LAYER_IDS.length).toBeGreaterThan(0);
  });

  it('meets the run-count and concentration gate across the shipped layers', () => {
    const seeds = [1, 7, 99, 4242];
    for (const floorSeed of seeds) {
      let longRuns = 0;
      let total = 0;
      let nearHub = 0;
      for (const id of LAYER_IDS) {
        const plan = planLinework(request(id, floorSeed));
        longRuns += plan.runs.filter((r) => r.tileCount >= MIN_RUN_TILES).length;
        total += plan.tileCount;
        nearHub += plan.hubTileCount;
      }
      expect(total).toBeGreaterThan(0);
      expect(
        longRuns,
        `seed ${floorSeed}: only ${longRuns} runs of >= ${MIN_RUN_TILES} tiles`,
      ).toBeGreaterThanOrEqual(MIN_LONG_RUNS);
      expect(
        nearHub / total,
        `seed ${floorSeed}: concentration ${(nearHub / total).toFixed(3)}`,
      ).toBeGreaterThanOrEqual(MIN_CONCENTRATION);
    }
  });

  it('is deterministic in the floor seed', () => {
    for (const id of LAYER_IDS) {
      const a = planLinework(request(id, 31337));
      const b = planLinework(request(id, 31337));
      expect(Array.from(b.occupancy)).toEqual(Array.from(a.occupancy));
      expect(Array.from(b.masks)).toEqual(Array.from(a.masks));
    }
  });

  it('produces different networks for different seeds', () => {
    const a = planLinework(request(LAYER_IDS[0]!, 1));
    const b = planLinework(request(LAYER_IDS[0]!, 2));
    expect(Array.from(b.occupancy)).not.toEqual(Array.from(a.occupancy));
  });

  it('produces different networks for different layers on the same seed', () => {
    // Guards the seedSalt: if planLinework ever derived its RNG from floorSeed
    // alone, every layer would lay identical, perfectly overlapping runs and
    // the seed-sensitivity test above would still pass.
    expect(LAYER_IDS.length).toBeGreaterThan(1);
    const a = planLinework(request(LAYER_IDS[0]!, 31));
    const b = planLinework(request(LAYER_IDS[1]!, 31));
    expect(Array.from(b.occupancy)).not.toEqual(Array.from(a.occupancy));
  });

  it('never routes ground linework through a wall', () => {
    for (const id of LAYER_IDS) {
      const req = request(id, 55);
      const plan = planLinework(req);
      for (let i = 0; i < plan.occupancy.length; i++) {
        const cell = plan.occupancy[i] ?? LINEWORK_EMPTY;
        if (cell === LINEWORK_EMPTY) continue;
        // Only the dedicated wall-entry terminus may sit inside rock.
        if (req.wall[i]) expect(cell).toBe(LINEWORK_WALL_ENTRY);
      }
    }
  });

  it('only lets pipe layers enter walls', () => {
    for (const layer of manifest.linework ?? []) {
      const plan = planLinework(request(layer.id, 77));
      const entries = plan.occupancy.reduce(
        (n, cell) => n + (cell === LINEWORK_WALL_ENTRY ? 1 : 0),
        0,
      );
      if (layer.kind === 'track') expect(entries).toBe(0);
      else expect(entries).toBeGreaterThan(0);
    }
  });

  it('gives every occupied tile a mask consistent with its neighbours', () => {
    const plan = planLinework(request(LAYER_IDS[0]!, 13));
    const dirs = [
      { dx: 0, dy: -1, bit: 1 },
      { dx: 1, dy: 0, bit: 2 },
      { dx: 0, dy: 1, bit: 4 },
      { dx: -1, dy: 0, bit: 8 },
    ];
    for (let i = 0; i < plan.occupancy.length; i++) {
      if (!plan.occupancy[i]) continue;
      // A wall terminus is pinned to its parent edge on purpose — see below.
      if (plan.occupancy[i] === LINEWORK_WALL_ENTRY) continue;
      const tx = i % MAP_SIZE;
      const ty = (i / MAP_SIZE) | 0;
      let expected = 0;
      for (const d of dirs) {
        const nx = tx + d.dx;
        const ny = ty + d.dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        if (plan.occupancy[ny * MAP_SIZE + nx]) expected |= d.bit;
      }
      expect(plan.masks[i]).toBe(expected);
    }
  });

  it('pins every wall terminus to exactly one connected edge', () => {
    // A wall-entry cell is the END of a run. If its mask were derived from its
    // neighbours like an ordinary tile, an unrelated run passing next to the
    // same rock cell would promote the terminus to a straight or a T drawn
    // over solid stone.
    const dirs = [
      { dx: 0, dy: -1, bit: 1 },
      { dx: 1, dy: 0, bit: 2 },
      { dx: 0, dy: 1, bit: 4 },
      { dx: -1, dy: 0, bit: 8 },
    ];
    let checked = 0;
    for (const layer of manifest.linework ?? []) {
      if (layer.kind !== 'pipe') continue;
      const plan = planLinework(request(layer.id, 77));
      for (let i = 0; i < plan.occupancy.length; i++) {
        if (plan.occupancy[i] !== LINEWORK_WALL_ENTRY) continue;
        const mask = plan.masks[i] ?? 0;
        // Exactly one bit set.
        expect(mask).toBeGreaterThan(0);
        expect(mask & (mask - 1)).toBe(0);
        // And that bit points at an occupied neighbour, not at nothing.
        const dir = dirs.find((d) => d.bit === mask)!;
        const nx = (i % MAP_SIZE) + dir.dx;
        const ny = ((i / MAP_SIZE) | 0) + dir.dy;
        expect(plan.occupancy[ny * MAP_SIZE + nx]).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never paints a one-sided join against a wall entry', () => {
    // Reciprocity: if tile A's mask says "connected east", the tile to its east
    // must say "connected west". A wall entry is pinned to a single edge, so a
    // later route running alongside the same rock must NOT connect to it.
    const dirs = [
      { dx: 0, dy: -1, bit: 1, back: 4 },
      { dx: 1, dy: 0, bit: 2, back: 8 },
      { dx: 0, dy: 1, bit: 4, back: 1 },
      { dx: -1, dy: 0, bit: 8, back: 2 },
    ];
    let checked = 0;
    for (const layer of manifest.linework ?? []) {
      for (const seed of [1, 77, 4242]) {
        const plan = planLinework(request(layer.id, seed));
        for (let i = 0; i < plan.occupancy.length; i++) {
          if (!plan.occupancy[i]) continue;
          const mask = plan.masks[i] ?? 0;
          const tx = i % MAP_SIZE;
          const ty = (i / MAP_SIZE) | 0;
          for (const dir of dirs) {
            if (!(mask & dir.bit)) continue;
            const nx = tx + dir.dx;
            const ny = ty + dir.dy;
            expect(nx).toBeGreaterThanOrEqual(0);
            expect(ny).toBeGreaterThanOrEqual(0);
            expect(nx).toBeLessThan(MAP_SIZE);
            expect(ny).toBeLessThan(MAP_SIZE);
            const back = plan.masks[ny * MAP_SIZE + nx] ?? 0;
            expect(back & dir.back).toBe(dir.back);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
