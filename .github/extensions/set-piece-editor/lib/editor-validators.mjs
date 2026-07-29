function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const DEFAULT_KNOWN_NPC_TYPE_IDS = ['tutorial-goon', 'shopkeeper', 'spell-quest-giver'];

export function countSheetRows(naturalHeight, margin, spacing) {
  if (
    !isFiniteNumber(naturalHeight) ||
    !isFiniteNumber(margin) ||
    !isFiniteNumber(spacing) ||
    naturalHeight <= margin ||
    spacing < 0
  ) {
    return 0;
  }
  const pitch = 16 + spacing;
  if (pitch <= 0) return 0;
  return Math.max(0, Math.floor((naturalHeight - margin + spacing) / pitch));
}

function asFinitePositive(value) {
  return isFiniteNumber(value) && value > 0;
}

function asFiniteNonNegative(value) {
  return isFiniteNumber(value) && value >= 0;
}

function reportUnknownKeys(obj, allowedKeys, issuePrefix, issues) {
  Object.keys(obj || {}).forEach((key) => {
    if (!allowedKeys.has(key)) {
      issues.push(issuePrefix + ' unknown field "' + key + '" is not allowed');
    }
  });
}

function validateSpriteRefLike(sprite, issuePrefix) {
  const issues = [];
  if (!sprite || typeof sprite !== 'object' || typeof sprite.source !== 'string') {
    issues.push(issuePrefix + ' must be an object with source');
    return issues;
  }
  if (sprite.source === 'catalog') {
    reportUnknownKeys(sprite, new Set(['source', 'spriteId']), issuePrefix, issues);
    if (typeof sprite.spriteId !== 'string' || sprite.spriteId.trim() === '') {
      issues.push(issuePrefix + '.spriteId is required');
    }
  } else if (sprite.source === 'sheet') {
    reportUnknownKeys(sprite, new Set(['source', 'sheetKey', 'col', 'row']), issuePrefix, issues);
    if (typeof sprite.sheetKey !== 'string' || sprite.sheetKey.trim() === '') {
      issues.push(issuePrefix + '.sheetKey is required');
    }
    if (!Number.isInteger(sprite.col) || sprite.col < 0) {
      issues.push(issuePrefix + '.col must be a non-negative integer');
    }
    if (!Number.isInteger(sprite.row) || sprite.row < 0) {
      issues.push(issuePrefix + '.row must be a non-negative integer');
    }
  } else if (sprite.source === 'custom') {
    if (typeof sprite.requestId !== 'string' || sprite.requestId.trim() === '') {
      issues.push(issuePrefix + '.requestId is required');
    }
    if (typeof sprite.label !== 'string' || sprite.label.trim() === '') {
      issues.push(issuePrefix + '.label is required');
    }
    if (typeof sprite.prompt !== 'string' || sprite.prompt.trim() === '') {
      issues.push(issuePrefix + '.prompt is required');
    }
    reportUnknownKeys(
      sprite,
      new Set([
        'source',
        'requestId',
        'label',
        'prompt',
        'widthTiles',
        'heightTiles',
        'tags',
        'placeholder',
      ]),
      issuePrefix,
      issues,
    );
    if (
      sprite.widthTiles !== undefined &&
      (!Number.isInteger(sprite.widthTiles) || sprite.widthTiles <= 0)
    ) {
      issues.push(issuePrefix + '.widthTiles must be a positive integer when present');
    }
    if (
      sprite.heightTiles !== undefined &&
      (!Number.isInteger(sprite.heightTiles) || sprite.heightTiles <= 0)
    ) {
      issues.push(issuePrefix + '.heightTiles must be a positive integer when present');
    }
    if (sprite.tags !== undefined) {
      if (!Array.isArray(sprite.tags)) {
        issues.push(issuePrefix + '.tags must be an array of non-empty strings when present');
      } else {
        sprite.tags.forEach((tag, index) => {
          if (typeof tag !== 'string' || tag.trim() === '') {
            issues.push(issuePrefix + '.tags[' + index + '] must be a non-empty string');
          }
        });
      }
    }
    if (sprite.placeholder !== undefined) {
      const placeholderPrefix = issuePrefix + '.placeholder';
      if (!sprite.placeholder || typeof sprite.placeholder !== 'object') {
        issues.push(placeholderPrefix + ' must be an object when present');
      } else if (sprite.placeholder.source !== 'catalog' && sprite.placeholder.source !== 'sheet') {
        issues.push(placeholderPrefix + '.source must be catalog or sheet');
      } else {
        issues.push(...validateSpriteRefLike(sprite.placeholder, placeholderPrefix));
      }
    }
  } else {
    issues.push(issuePrefix + '.source must be catalog, sheet, or custom');
  }
  return issues;
}

/**
 * Allowed keys on a prop. MUST stay in sync with `propSourceSchema` in
 * `src/shared/set-piece-types.ts`. `solid` was the second drift found here:
 * it shipped in the real schema but was missing from this list, so the editor
 * would have rejected any room containing solid furniture.
 */
export const PROP_KEYS = new Set([
  'id',
  'kind',
  'x',
  'y',
  'width',
  'height',
  'z',
  'sceneLayer',
  'solid',
  'layers',
]);

/**
 * Allowed keys on a sprite layer. MUST stay in sync with `spriteLayerSchema` in
 * `src/shared/set-piece-types.ts` — this file is standalone .mjs and cannot
 * import the zod schema, so the list is duplicated by necessity.
 *
 * `tests/editor-validators.test.mjs` parses the TS schema and asserts the two
 * agree, because the previous drift here was a total save blocker: `anchorBase`
 * shipped in the real schema and in 14 welcome-room props, but was missing from
 * this list, so the editor rejected every room that used it — including the one
 * it was open on. Same failure shape as the editor's stale private NPC sprite
 * map (see `src/shared/data/npc-sprite-map.json`): a duplicated definition that
 * silently fell behind its source of truth.
 */
export const LAYER_KEYS = new Set([
  'sprite',
  'offsetX',
  'offsetY',
  'offsetXFt',
  'offsetYFt',
  'widthFt',
  'heightFt',
  'anchorBase',
  'scale',
  'flipX',
  'flipY',
  'rotationDeg',
  'tintHex',
]);

function validateLayer(layer, index) {
  const issues = [];
  if (!layer || typeof layer !== 'object') {
    return ['layers[' + index + '] must be an object'];
  }
  reportUnknownKeys(layer, LAYER_KEYS, 'layers[' + index + ']', issues);
  const sprite = layer.sprite;
  if (!sprite || typeof sprite !== 'object' || typeof sprite.source !== 'string') {
    issues.push('layers[' + index + '].sprite is required');
    return issues;
  }
  issues.push(...validateSpriteRefLike(sprite, 'layers[' + index + '].sprite'));
  if (
    (layer.widthFt === undefined) !== (layer.heightFt === undefined) ||
    (layer.widthFt !== undefined && !asFinitePositive(layer.widthFt)) ||
    (layer.heightFt !== undefined && !asFinitePositive(layer.heightFt))
  ) {
    issues.push('layers[' + index + '] widthFt/heightFt must be paired positive numbers');
  }
  if (layer.scale !== undefined && !asFinitePositive(layer.scale)) {
    issues.push('layers[' + index + '].scale must be a positive number');
  }
  if (layer.offsetX !== undefined && !isFiniteNumber(layer.offsetX)) {
    issues.push('layers[' + index + '].offsetX must be finite when present');
  }
  if (layer.offsetY !== undefined && !isFiniteNumber(layer.offsetY)) {
    issues.push('layers[' + index + '].offsetY must be finite when present');
  }
  if (layer.offsetXFt !== undefined && !isFiniteNumber(layer.offsetXFt)) {
    issues.push('layers[' + index + '].offsetXFt must be finite when present');
  }
  if (layer.offsetYFt !== undefined && !isFiniteNumber(layer.offsetYFt)) {
    issues.push('layers[' + index + '].offsetYFt must be finite when present');
  }
  if (layer.flipX !== undefined && typeof layer.flipX !== 'boolean') {
    issues.push('layers[' + index + '].flipX must be boolean when present');
  }
  if (layer.flipY !== undefined && typeof layer.flipY !== 'boolean') {
    issues.push('layers[' + index + '].flipY must be boolean when present');
  }
  if (layer.rotationDeg !== undefined && !isFiniteNumber(layer.rotationDeg)) {
    issues.push('layers[' + index + '].rotationDeg must be finite');
  }
  if (
    layer.tintHex !== undefined &&
    (typeof layer.tintHex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(layer.tintHex))
  ) {
    issues.push('layers[' + index + '].tintHex must match #rrggbb when present');
  }
  return issues;
}

function validateProps(setPiece, boundW, boundH) {
  const allowedPropKinds = new Set([
    'floor',
    'wall',
    'door',
    'fixture',
    'furniture',
    'decoration',
    'actor',
  ]);
  const issues = [];
  if (!Array.isArray(setPiece.props) || setPiece.props.length === 0) {
    return ['props must be a non-empty array'];
  }
  const seen = new Set();
  for (let i = 0; i < setPiece.props.length; i += 1) {
    const prop = setPiece.props[i];
    if (!prop || typeof prop !== 'object') {
      issues.push('props[' + i + '] must be an object');
      continue;
    }
    reportUnknownKeys(prop, PROP_KEYS, 'props[' + i + ']', issues);
    if (typeof prop.id !== 'string' || prop.id.trim() === '') {
      issues.push('props[' + i + '].id is required');
    } else if (seen.has(prop.id)) {
      issues.push('Duplicate prop id "' + prop.id + '"');
    } else {
      seen.add(prop.id);
    }
    if (!asFiniteNonNegative(prop.x) || !asFiniteNonNegative(prop.y)) {
      issues.push('props[' + i + '] x/y must be non-negative numbers');
    }
    if (typeof prop.kind !== 'string' || !allowedPropKinds.has(prop.kind)) {
      issues.push('props[' + i + '].kind must be a known prop kind');
    }
    if (prop.z !== undefined && !Number.isInteger(prop.z)) {
      issues.push('props[' + i + '].z must be an integer when present');
    }
    if (
      prop.sceneLayer !== undefined &&
      (typeof prop.sceneLayer !== 'string' || prop.sceneLayer.trim() === '')
    ) {
      issues.push('props[' + i + '].sceneLayer must be a non-empty string when present');
    }
    const width = prop.width === undefined ? 1 : prop.width;
    const height = prop.height === undefined ? 1 : prop.height;
    if (!asFinitePositive(width) || !asFinitePositive(height)) {
      issues.push('props[' + i + '] width/height must be positive numbers');
    } else if (asFiniteNonNegative(prop.x) && asFiniteNonNegative(prop.y)) {
      if (prop.x + width > boundW || prop.y + height > boundH) {
        issues.push('Prop "' + (prop.id || i) + '" extends outside the set-piece footprint');
      }
    }
    if (!Array.isArray(prop.layers) || prop.layers.length === 0) {
      issues.push('props[' + i + '].layers must be non-empty');
    } else {
      for (let li = 0; li < prop.layers.length; li += 1) {
        const layerIssues = validateLayer(prop.layers[li], li);
        for (const issue of layerIssues) {
          issues.push('props[' + i + '].' + issue);
        }
      }
    }
  }
  return issues;
}

function validateSceneLayers(setPiece) {
  const issues = [];
  const ids = new Set();
  if (setPiece.sceneLayers === undefined) {
    return { issues, layerIds: ids, hasDeclaredLayers: false };
  }
  if (!Array.isArray(setPiece.sceneLayers)) {
    return { issues: ['sceneLayers must be an array'], layerIds: ids, hasDeclaredLayers: false };
  }
  for (let i = 0; i < setPiece.sceneLayers.length; i += 1) {
    const layer = setPiece.sceneLayers[i];
    if (!layer || typeof layer !== 'object') {
      issues.push('sceneLayers[' + i + '] must be an object');
      continue;
    }
    reportUnknownKeys(
      layer,
      new Set(['id', 'name', 'visible', 'locked']),
      'sceneLayers[' + i + ']',
      issues,
    );
    if (typeof layer.id !== 'string' || layer.id.trim() === '') {
      issues.push('sceneLayers[' + i + '].id is required');
      continue;
    }
    if (ids.has(layer.id)) {
      issues.push('Duplicate scene layer id "' + layer.id + '"');
    } else {
      ids.add(layer.id);
    }
    if (typeof layer.name !== 'string' || layer.name.trim() === '') {
      issues.push('sceneLayers[' + i + '].name is required');
    }
    if (layer.visible !== undefined && typeof layer.visible !== 'boolean') {
      issues.push('sceneLayers[' + i + '].visible must be boolean when present');
    }
    if (layer.locked !== undefined && typeof layer.locked !== 'boolean') {
      issues.push('sceneLayers[' + i + '].locked must be boolean when present');
    }
  }
  return { issues, layerIds: ids, hasDeclaredLayers: true };
}

function validateNpcs(
  setPiece,
  boundW,
  boundH,
  knownNpcTypeIds,
  layerIds = new Set(),
  hasDeclaredLayers = false,
) {
  const issues = [];
  if (setPiece.npcs === undefined) return issues;
  if (!Array.isArray(setPiece.npcs)) return ['npcs must be an array'];
  const seenIds = new Set();
  const seenAnchors = new Set();
  for (let i = 0; i < setPiece.npcs.length; i += 1) {
    const npc = setPiece.npcs[i];
    if (!npc || typeof npc !== 'object') {
      issues.push('npcs[' + i + '] must be an object');
      continue;
    }
    reportUnknownKeys(
      npc,
      new Set([
        'id',
        'npcTypeId',
        'x',
        'y',
        'widthFt',
        'heightFt',
        'flipX',
        'flipY',
        'rotationDeg',
        'z',
        'sceneLayer',
        'spriteOverride',
        'anchorRole',
      ]),
      'npcs[' + i + ']',
      issues,
    );
    if (typeof npc.id !== 'string' || npc.id.trim() === '') {
      issues.push('npcs[' + i + '].id is required');
    } else if (seenIds.has(npc.id)) {
      issues.push('Duplicate NPC id "' + npc.id + '"');
    } else {
      seenIds.add(npc.id);
    }
    if (typeof npc.npcTypeId !== 'string' || npc.npcTypeId.trim() === '') {
      issues.push('npcs[' + i + '].npcTypeId is required');
    } else if (
      Array.isArray(knownNpcTypeIds) &&
      knownNpcTypeIds.length > 0 &&
      !knownNpcTypeIds.includes(npc.npcTypeId)
    ) {
      issues.push('npcs[' + i + '].npcTypeId must reference a known NPC type');
    }
    if (!asFiniteNonNegative(npc.x) || !asFiniteNonNegative(npc.y)) {
      issues.push('npcs[' + i + '] x/y must be non-negative numbers');
    } else if (npc.x >= boundW || npc.y >= boundH) {
      issues.push('NPC "' + (npc.id || i) + '" sits outside the set-piece footprint');
    }
    if ((npc.widthFt === undefined) !== (npc.heightFt === undefined)) {
      issues.push('npcs[' + i + '] widthFt and heightFt must be supplied together');
    } else if (
      npc.widthFt !== undefined &&
      (!asFinitePositive(npc.widthFt) || !asFinitePositive(npc.heightFt))
    ) {
      issues.push('npcs[' + i + '] widthFt/heightFt must be positive numbers');
    }
    if (npc.rotationDeg !== undefined && !isFiniteNumber(npc.rotationDeg)) {
      issues.push('npcs[' + i + '].rotationDeg must be finite');
    }
    if (npc.flipX !== undefined && typeof npc.flipX !== 'boolean') {
      issues.push('npcs[' + i + '].flipX must be boolean when present');
    }
    if (npc.flipY !== undefined && typeof npc.flipY !== 'boolean') {
      issues.push('npcs[' + i + '].flipY must be boolean when present');
    }
    if (npc.z !== undefined && !Number.isInteger(npc.z)) {
      issues.push('npcs[' + i + '].z must be an integer');
    }
    if (
      npc.sceneLayer !== undefined &&
      (typeof npc.sceneLayer !== 'string' || npc.sceneLayer.trim() === '')
    ) {
      issues.push('npcs[' + i + '].sceneLayer must be a non-empty string when present');
    }
    if (
      hasDeclaredLayers &&
      typeof npc.sceneLayer === 'string' &&
      npc.sceneLayer.trim() !== '' &&
      !layerIds.has(npc.sceneLayer)
    ) {
      issues.push('NPC "' + (npc.id || i) + '" references unknown sceneLayer');
    }
    if (npc.spriteOverride !== undefined) {
      issues.push(...validateSpriteRefLike(npc.spriteOverride, 'npcs[' + i + '].spriteOverride'));
    }
    if (npc.anchorRole !== undefined) {
      if (
        typeof npc.anchorRole !== 'string' ||
        (npc.anchorRole !== 'welcome' && npc.anchorRole !== 'shop' && npc.anchorRole !== 'spell')
      ) {
        issues.push('npcs[' + i + '].anchorRole must be welcome, shop, or spell when present');
      } else if (seenAnchors.has(npc.anchorRole)) {
        issues.push('Duplicate anchorRole "' + npc.anchorRole + '"');
      } else {
        seenAnchors.add(npc.anchorRole);
      }
    }
  }
  return issues;
}

export function validateSetPieceCandidate(setPiece, options = {}) {
  if (!setPiece || typeof setPiece !== 'object') return ['set piece payload must be an object'];
  const issues = [];
  if (!Number.isInteger(setPiece.width) || setPiece.width <= 0) {
    issues.push('width must be a positive integer');
  }
  if (!Number.isInteger(setPiece.height) || setPiece.height <= 0) {
    issues.push('height must be a positive integer');
  }
  if (issues.length > 0) return issues;
  if (setPiece.maxWidth !== undefined) {
    if (!Number.isInteger(setPiece.maxWidth) || setPiece.maxWidth <= 0) {
      issues.push('maxWidth must be a positive integer when present');
    } else if (setPiece.maxWidth < setPiece.width) {
      issues.push('maxWidth must be greater than or equal to width');
    }
  }
  if (setPiece.maxHeight !== undefined) {
    if (!Number.isInteger(setPiece.maxHeight) || setPiece.maxHeight <= 0) {
      issues.push('maxHeight must be a positive integer when present');
    } else if (setPiece.maxHeight < setPiece.height) {
      issues.push('maxHeight must be greater than or equal to height');
    }
  }
  const boundW = setPiece.maxWidth ?? setPiece.width;
  const boundH = setPiece.maxHeight ?? setPiece.height;
  const { issues: sceneLayerIssues, layerIds, hasDeclaredLayers } = validateSceneLayers(setPiece);
  const knownNpcTypeIds = Array.isArray(options.knownNpcTypeIds)
    ? options.knownNpcTypeIds
    : DEFAULT_KNOWN_NPC_TYPE_IDS;
  issues.push(...sceneLayerIssues);
  issues.push(...validateProps(setPiece, boundW, boundH));
  if (hasDeclaredLayers && Array.isArray(setPiece.props)) {
    for (let i = 0; i < setPiece.props.length; i += 1) {
      const prop = setPiece.props[i];
      if (
        typeof prop?.sceneLayer === 'string' &&
        prop.sceneLayer.trim() !== '' &&
        !layerIds.has(prop.sceneLayer)
      ) {
        issues.push('Prop "' + (prop.id || i) + '" references unknown sceneLayer');
      }
    }
  }
  issues.push(
    ...validateNpcs(setPiece, boundW, boundH, knownNpcTypeIds, layerIds, hasDeclaredLayers),
  );
  return issues;
}
