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

function validateLayer(layer, index) {
  const issues = [];
  if (!layer || typeof layer !== 'object') {
    return ['layers[' + index + '] must be an object'];
  }
  const sprite = layer.sprite;
  if (!sprite || typeof sprite !== 'object' || typeof sprite.source !== 'string') {
    issues.push('layers[' + index + '].sprite is required');
    return issues;
  }
  if (sprite.source === 'catalog') {
    if (typeof sprite.spriteId !== 'string' || sprite.spriteId.trim() === '') {
      issues.push('layers[' + index + '].sprite.spriteId is required');
    }
  } else if (sprite.source === 'sheet') {
    if (typeof sprite.sheetKey !== 'string' || sprite.sheetKey.trim() === '') {
      issues.push('layers[' + index + '].sprite.sheetKey is required');
    }
    if (!Number.isInteger(sprite.col) || sprite.col < 0) {
      issues.push('layers[' + index + '].sprite.col must be a non-negative integer');
    }
    if (!Number.isInteger(sprite.row) || sprite.row < 0) {
      issues.push('layers[' + index + '].sprite.row must be a non-negative integer');
    }
  } else if (sprite.source === 'custom') {
    if (typeof sprite.requestId !== 'string' || sprite.requestId.trim() === '') {
      issues.push('layers[' + index + '].sprite.requestId is required');
    }
    if (typeof sprite.label !== 'string' || sprite.label.trim() === '') {
      issues.push('layers[' + index + '].sprite.label is required');
    }
    if (typeof sprite.prompt !== 'string' || sprite.prompt.trim() === '') {
      issues.push('layers[' + index + '].sprite.prompt is required');
    }
  } else {
    issues.push('layers[' + index + '].sprite.source must be catalog, sheet, or custom');
  }
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
  if (layer.rotationDeg !== undefined && !isFiniteNumber(layer.rotationDeg)) {
    issues.push('layers[' + index + '].rotationDeg must be finite');
  }
  return issues;
}

function validateProps(setPiece, boundW, boundH) {
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

function validateNpcs(setPiece, boundW, boundH, knownNpcTypeIds) {
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
    if (npc.z !== undefined && !Number.isInteger(npc.z)) {
      issues.push('npcs[' + i + '].z must be an integer');
    }
    if (npc.anchorRole !== undefined) {
      if (typeof npc.anchorRole !== 'string' || npc.anchorRole.trim() === '') {
        issues.push('npcs[' + i + '].anchorRole must be non-empty when present');
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
  const boundW = setPiece.maxWidth ?? setPiece.width;
  const boundH = setPiece.maxHeight ?? setPiece.height;
  const knownNpcTypeIds = Array.isArray(options.knownNpcTypeIds)
    ? options.knownNpcTypeIds
    : DEFAULT_KNOWN_NPC_TYPE_IDS;
  issues.push(...validateProps(setPiece, boundW, boundH));
  issues.push(...validateNpcs(setPiece, boundW, boundH, knownNpcTypeIds));
  return issues;
}
