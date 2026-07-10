import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countSheetRows, validateSetPieceCandidate } from '../lib/editor-validators.mjs';

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
