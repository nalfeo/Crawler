import { afterEach, describe, expect, it } from 'vitest';
import {
  PROP_KIND_Z,
  SET_PIECE_TILE_SIZE,
  collectCustomArtRequests,
  flattenSetPieceLayers,
  getAllSetPieceDefs,
  getSetPieceDef,
  getSetPieceFootprint,
  getSetPiecePacks,
  getSetPiecesByTheme,
  installDefaultSetPiecePacks,
  installSetPiecePacks,
  isCustomSpriteRef,
  setPiecePackSchema,
} from '../../src/shared/set-piece-types.js';

describe('set piece content packs', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('loads the bundled Earth set-piece pack with 10+ set pieces', () => {
    expect(getSetPiecePacks()).toHaveLength(1);
    expect(getAllSetPieceDefs().length).toBeGreaterThanOrEqual(10);
  });

  it('exposes both exact and themed sizing kinds', () => {
    const kinds = new Set(getAllSetPieceDefs().map((def) => def.sizing));
    expect(kinds.has('exact')).toBe(true);
    expect(kinds.has('themed')).toBe(true);
  });

  it("keeps a named exact set piece (Jimmy's Pizza) with a fixed footprint", () => {
    const jimmys = getSetPieceDef('jimmys-pizza');
    expect(jimmys?.sizing).toBe('exact');
    expect(getSetPieceFootprint(jimmys!)).toEqual({ width: 8, height: 6 });
  });

  it('reports the max footprint for themed kits', () => {
    const office = getSetPieceDef('doctors-office');
    expect(office?.sizing).toBe('themed');
    // width/height is the minimum; footprint reflects the max extent.
    expect(office?.width).toBe(6);
    expect(getSetPieceFootprint(office!)).toEqual({ width: 9, height: 7 });
  });

  it('groups set pieces by theme', () => {
    const food = getSetPiecesByTheme('food').map((def) => def.id);
    expect(food).toContain('jimmys-pizza');
    expect(food).toContain('corner-diner');
  });

  it('defaults prop render z from its kind', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const actor = def.props.find((p) => p.kind === 'actor');
    const fixture = def.props.find((p) => p.kind === 'fixture');
    expect(actor?.z).toBe(PROP_KIND_Z.actor);
    expect(fixture?.z).toBe(PROP_KIND_Z.fixture);
  });

  it('defaults prop footprint to a single tile', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const oven = def.props.find((p) => p.id === 'pizza-oven');
    expect(oven?.width).toBe(1);
    expect(oven?.height).toBe(1);
  });

  it('exercises all three sprite sources across the bundled pack', () => {
    const sources = new Set<string>();
    for (const def of getAllSetPieceDefs()) {
      for (const prop of def.props) {
        for (const layer of prop.layers) {
          sources.add(layer.sprite.source);
        }
      }
    }
    expect(sources).toEqual(new Set(['catalog', 'sheet', 'custom']));
  });

  it('supports layered/stacked composites (flower-pot-on-table pattern)', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const composite = def.props.find((p) => p.id === 'booth-table');
    expect(composite!.layers.length).toBeGreaterThan(1);
    // The stacked layer carries an offset so it sits on top of the base sprite.
    expect(composite!.layers[1]?.offsetX).toBeDefined();
  });
});

describe('flattenSetPieceLayers', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('orders draw layers by prop z then authored order', () => {
    const def = getSetPieceDef('corporate-cubicles')!;
    const draws = flattenSetPieceLayers(def);
    for (let i = 1; i < draws.length; i++) {
      expect(draws[i]!.z).toBeGreaterThanOrEqual(draws[i - 1]!.z);
    }
  });

  it('emits one draw entry per layer', () => {
    const def = getSetPieceDef('jimmys-pizza')!;
    const layerCount = def.props.reduce((sum, prop) => sum + prop.layers.length, 0);
    expect(flattenSetPieceLayers(def)).toHaveLength(layerCount);
  });
});

describe('collectCustomArtRequests', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('collects de-duplicated custom art requests for the whole pack', () => {
    const requests = collectCustomArtRequests(getAllSetPieceDefs());
    const ids = requests.map((req) => req.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('jimmys-neon-sign');
  });

  it('accepts a single set piece', () => {
    const requests = collectCustomArtRequests(getSetPieceDef('jimmys-pizza')!);
    expect(requests.every((req) => isCustomSpriteRef(req))).toBe(true);
    expect(requests.map((req) => req.requestId)).toContain('brick-pizza-oven');
  });
});

describe('setPiecePackSchema', () => {
  afterEach(() => {
    installDefaultSetPiecePacks();
  });

  it('exposes a tile size constant', () => {
    expect(SET_PIECE_TILE_SIZE).toBe(16);
  });

  it('installs and resets runtime packs (LLM-pack injection path)', () => {
    installSetPiecePacks([
      setPiecePackSchema.parse({
        version: 1,
        packId: 'runtime-test',
        setPieces: [
          {
            id: 'runtime-kiosk',
            name: 'Runtime Kiosk',
            theme: 'retail',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'A tiny runtime-injected kiosk.',
            props: [
              {
                id: 'stand',
                kind: 'fixture',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:npc.guide' } }],
              },
            ],
          },
        ],
      }),
    ]);
    expect(getSetPieceDef('runtime-kiosk')).toBeDefined();
    expect(getSetPieceDef('jimmys-pizza')).toBeUndefined();

    installDefaultSetPiecePacks();
    expect(getSetPieceDef('jimmys-pizza')).toBeDefined();
    expect(getSetPieceDef('runtime-kiosk')).toBeUndefined();
  });

  it('rejects props that extend outside the footprint', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'overflow',
            name: 'Overflow',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'Prop falls off the edge.',
            props: [
              {
                id: 'wall',
                kind: 'wall',
                x: 3,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/outside/);
  });

  it('rejects maxWidth/maxHeight on exact set pieces', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'bad-exact',
            name: 'Bad Exact',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            maxWidth: 4,
            description: 'Exact pieces cannot declare a max.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/only valid for themed/);
  });

  it('rejects duplicate prop ids', () => {
    expect(() =>
      setPiecePackSchema.parse({
        version: 1,
        packId: 'bad',
        setPieces: [
          {
            id: 'dupes',
            name: 'Dupes',
            theme: 'test',
            sizing: 'exact',
            width: 2,
            height: 2,
            description: 'Two props share an id.',
            props: [
              {
                id: 'p',
                kind: 'floor',
                x: 0,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
              {
                id: 'p',
                kind: 'wall',
                x: 1,
                y: 0,
                layers: [{ sprite: { source: 'sheet', sheetKey: 'k', col: 0, row: 0 } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate prop id/);
  });
});
