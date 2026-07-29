import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  countSheetRows,
  validateSetPieceCandidate,
  LAYER_KEYS,
  PROP_KEYS,
} from '../lib/editor-validators.mjs';

test('countSheetRows includes final spaced row', () => {
  // tiny-dungeon spritesheet: 11 rows of 16px with 1px spacing, 0 margin.
  assert.equal(countSheetRows(186, 0, 1), 11);
});

test('validateSetPieceCandidate rejects empty npcTypeId + duplicate ids', () => {
  const issues = validateSetPieceCandidate({
    width: 4,
    height: 4,
    props: [
      {
        id: 'desk',
        kind: 'furniture',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:prop.desk' } }],
      },
    ],
    npcs: [
      { id: 'npc-a', npcTypeId: '', x: 1, y: 1 },
      { id: 'npc-a', npcTypeId: 'tutorial-goon', x: 2, y: 2 },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('npcTypeId is required')));
  assert.ok(issues.some((issue) => issue.includes('Duplicate NPC id')));
});

test('validateSetPieceCandidate rejects unknown npcTypeId when a registry is provided', () => {
  const issues = validateSetPieceCandidate(
    {
      width: 4,
      height: 4,
      props: [
        {
          id: 'desk',
          kind: 'furniture',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:prop.desk' } }],
        },
      ],
      npcs: [{ id: 'npc-a', npcTypeId: 'typo-goon', x: 1, y: 1 }],
    },
    { knownNpcTypeIds: ['tutorial-goon'] },
  );

  assert.ok(issues.some((issue) => issue.includes('must reference a known NPC type')));
});

test('validateSetPieceCandidate rejects unknown scene-layer references', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    sceneLayers: [{ id: 'default', name: 'Default' }],
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        sceneLayer: 'missing-layer',
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [
      {
        id: 'goon',
        npcTypeId: 'tutorial-goon',
        x: 4,
        y: 2,
        sceneLayer: 'missing-layer',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('Prop "floor" references unknown sceneLayer')));
  assert.ok(issues.some((issue) => issue.includes('NPC "goon" references unknown sceneLayer')));
});

test('validateSetPieceCandidate requires sceneLayer to be a non-empty string', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        sceneLayer: 123,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2, sceneLayer: '' }],
  });

  assert.ok(
    issues.some((issue) => issue.includes('props[0].sceneLayer must be a non-empty string')),
  );
  assert.ok(
    issues.some((issue) => issue.includes('npcs[0].sceneLayer must be a non-empty string')),
  );
});

test('validateSetPieceCandidate accepts a minimally valid payload', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2 }],
  });

  assert.deepEqual(issues, []);
});

test('validateSetPieceCandidate rejects max bounds smaller than current dimensions', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    maxWidth: 6,
    maxHeight: 5,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2 }],
  });

  assert.ok(
    issues.some((issue) => issue.includes('maxWidth must be greater than or equal to width')),
  );
  assert.ok(
    issues.some((issue) => issue.includes('maxHeight must be greater than or equal to height')),
  );
});

test('validateSetPieceCandidate rejects malformed npc spriteOverride payloads', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [
      {
        id: 'goon',
        npcTypeId: 'tutorial-goon',
        x: 4,
        y: 2,
        spriteOverride: { source: 'sheet' },
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('npcs[0].spriteOverride.sheetKey is required')));
  assert.ok(issues.some((issue) => issue.includes('npcs[0].spriteOverride.col must be')));
  assert.ok(issues.some((issue) => issue.includes('npcs[0].spriteOverride.row must be')));
});

test('validateSetPieceCandidate rejects strict custom sprite-ref shape violations', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [
          {
            sprite: {
              source: 'custom',
              requestId: 'req-1',
              label: 'Lamp',
              prompt: 'old desk lamp',
              tags: ['ok', ''],
              placeholder: { source: 'catalog', spriteId: 'sprite:item.gem', rogue: true },
              rogue: true,
            },
          },
        ],
      },
    ],
    npcs: [
      {
        id: 'goon',
        npcTypeId: 'tutorial-goon',
        x: 4,
        y: 2,
        spriteOverride: {
          source: 'custom',
          requestId: 'req-2',
          label: 'Broker',
          prompt: 'spell broker',
          widthTiles: 0,
          tags: 'bad',
        },
      },
    ],
  });

  assert.ok(
    issues.some((issue) => issue.includes('props[0].layers[0].sprite unknown field "rogue"')),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes('props[0].layers[0].sprite.placeholder unknown field "rogue"'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes('props[0].layers[0].sprite.tags[1] must be a non-empty string'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes('npcs[0].spriteOverride.widthTiles must be a positive integer when present'),
    ),
  );
  assert.ok(
    issues.some((issue) =>
      issue.includes(
        'npcs[0].spriteOverride.tags must be an array of non-empty strings when present',
      ),
    ),
  );
});

test('validateSetPieceCandidate rejects malformed layer transform/tint fields', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [
          {
            sprite: { source: 'catalog', spriteId: 'sprite:item.gem' },
            flipX: 'false',
            tintHex: '#abcd',
            offsetX: Number.NaN,
          },
        ],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2 }],
  });

  assert.ok(issues.some((issue) => issue.includes('layers[0].flipX must be boolean')));
  assert.ok(issues.some((issue) => issue.includes('layers[0].tintHex must match #rrggbb')));
  assert.ok(issues.some((issue) => issue.includes('layers[0].offsetX must be finite')));
});

test('validateSetPieceCandidate rejects non-integer prop z and invalid NPC anchorRole', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'desk',
        kind: 'furniture',
        x: 1,
        y: 1,
        width: 1,
        height: 1,
        z: 1.5,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [
      {
        id: 'goon',
        npcTypeId: 'tutorial-goon',
        x: 4,
        y: 2,
        anchorRole: 'not-valid',
      },
    ],
  });

  assert.ok(issues.some((issue) => issue.includes('props[0].z must be an integer')));
  assert.ok(issues.some((issue) => issue.includes('anchorRole must be welcome, shop, or spell')));
});

test('validateSetPieceCandidate rejects unknown fields on strict objects', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    sceneLayers: [{ id: 'default', name: 'Default', rogue: true }],
    props: [
      {
        id: 'desk',
        kind: 'furniture',
        x: 1,
        y: 1,
        width: 1,
        height: 1,
        rogue: true,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' }, rogue: true }],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2, rogue: true }],
  });

  assert.ok(issues.some((issue) => issue.includes('sceneLayers[0] unknown field \"rogue\"')));
  assert.ok(issues.some((issue) => issue.includes('props[0] unknown field \"rogue\"')));
  assert.ok(issues.some((issue) => issue.includes('props[0].layers[0] unknown field \"rogue\"')));
  assert.ok(issues.some((issue) => issue.includes('npcs[0] unknown field \"rogue\"')));
});

test('validateSetPieceCandidate rejects invalid npc sceneLayer type', () => {
  const issues = validateSetPieceCandidate({
    width: 8,
    height: 7,
    props: [
      {
        id: 'floor',
        kind: 'floor',
        x: 0,
        y: 0,
        width: 8,
        height: 7,
        layers: [{ sprite: { source: 'catalog', spriteId: 'sprite:item.gem' } }],
      },
    ],
    npcs: [{ id: 'goon', npcTypeId: 'tutorial-goon', x: 4, y: 2, sceneLayer: 123 }],
  });

  assert.ok(
    issues.some((issue) => issue.includes('npcs[0].sceneLayer must be a non-empty string')),
  );
});

// --- schema drift guard -----------------------------------------------------
// This extension is standalone .mjs and cannot import the zod schema, so its
// allow-lists are hand-copied from `src/shared/set-piece-types.ts`. That copy
// has now silently fallen behind TWICE, and both were total save blockers:
//   * `anchorBase` — used by 14 shipped welcome-room props; the editor rejected
//     every room that used it, including the one it was open on.
//   * `solid`      — shipped with real collision; would have blocked any room
//     containing solid furniture the moment someone edited one.
// Parsing the TS schema here means the next field to land cannot repeat this.
test('editor allow-lists do not drift from the canonical zod schema', () => {
  const ts = readFileSync(
    new URL('../../../../src/shared/set-piece-types.ts', import.meta.url),
    'utf8',
  );

  const keysOf = (schemaName) => {
    const start = ts.indexOf(`const ${schemaName} = z`);
    assert.ok(start >= 0, `could not locate ${schemaName} in set-piece-types.ts`);
    const open = ts.indexOf('.object({', start);
    assert.ok(open >= 0, `could not locate .object({ for ${schemaName}`);
    // Walk braces so nested object literals (e.g. inline sub-schemas) do not
    // truncate the slice early.
    let depth = 0;
    let end = -1;
    for (let i = ts.indexOf('{', open); i < ts.length; i += 1) {
      if (ts[i] === '{') depth += 1;
      else if (ts[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > 0, `unbalanced braces reading ${schemaName}`);
    const body = ts.slice(open, end);
    // Top-level keys only: `    key: z.` at exactly one indent level inside the
    // object literal.
    return new Set([...body.matchAll(/^ {4}(\w+):\s*z\./gm)].map((m) => m[1]));
  };

  const schemaLayer = keysOf('spriteLayerSchema');
  const schemaProp = keysOf('propSourceSchema');

  // Sanity: the parse actually found something, so a regex that silently
  // matches nothing cannot make this test vacuously green.
  assert.ok(schemaLayer.size >= 10, `parsed too few layer keys: ${[...schemaLayer]}`);
  assert.ok(schemaProp.size >= 8, `parsed too few prop keys: ${[...schemaProp]}`);
  assert.ok(schemaLayer.has('anchorBase'), 'parser missed anchorBase');
  assert.ok(schemaProp.has('solid'), 'parser missed solid');

  const missing = (schema, allowed) => [...schema].filter((k) => !allowed.has(k));
  assert.deepEqual(
    missing(schemaLayer, LAYER_KEYS),
    [],
    'layer fields in the zod schema that the editor would reject as unknown',
  );
  assert.deepEqual(
    missing(schemaProp, PROP_KEYS),
    [],
    'prop fields in the zod schema that the editor would reject as unknown',
  );
});
