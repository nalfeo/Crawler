#!/usr/bin/env node
/**
 * health/check-physics-defs-sync.ts — Diff the markdown tables in
 * `docs/knowledge/game-design/entity-sizing.md` against the runtime
 * registry in `src/core/physics-defs.ts`. Exits 1 on drift.
 *
 * Match by row → registry id (see ROW_TO_ID below). The check only covers
 * rows that map to a static registry entry — per-def "guideline" rows (mob
 * bands, dynamic beam length) are exempted.
 *
 * Wired into `verify:fast` per ADR 0044 and the Slice-1 spec.
 */

import { readFileSync } from 'node:fs';
import { Report, fromRepo } from '../shared/report.js';
import {
  PHYSICS_BODIES,
  SHAPE_BOX,
  SHAPE_CIRCLE,
  type PhysicsBodyId,
} from '../../../src/core/physics-defs.js';

const report = new Report('check-physics-defs-sync');

/** Map an entity-row label from the doc to a registry id. */
const ROW_TO_ID: Readonly<Record<string, PhysicsBodyId>> = {
  Player: 'player',
  'Mob — baseline guideline': 'mob-baseline',
  'Mob — light guideline': 'mob-light',
  'Mob — heavy guideline': 'mob-heavy',
  'Mob — boss guideline': 'mob-boss',
  'NPC (quest giver, etc.)': 'npc',
  'Spawner (structure)': 'spawner-structure',
  'Bullet / arrow': 'projectile-bullet',
  'Beam segment': 'beam-segment',
  'XP gem': 'xp-gem',
  'Dropped item': 'dropped-item',
  'Gold pile': 'gold',
  'Wall segment': 'wall',
  Door: 'door',
  Trap: 'trap',
  'Harvestable node': 'harvestable-node',
  'Boss chest': 'boss-chest',
  'Rally Point': 'rally-point',
};

interface DocRow {
  readonly label: string;
  readonly shape: 'circle' | 'box';
  readonly size: string;
  readonly weight: number;
}

function parseTables(md: string): DocRow[] {
  const rows: DocRow[] = [];
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    // Skip header + separator rows.
    if (line.startsWith('| Entity ') || line.startsWith('|---') || line.startsWith('| ---')) {
      continue;
    }
    // A data row has at least 4 columns and doesn't start with '| ---'.
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    // Filter separator rows that still show up (all cells are dashes).
    if (cells.every((c) => /^-+:?$/.test(c) || c === '' || /^:?-+:?$/.test(c))) continue;
    const [label, , shapeCell, sizeCell, weightCell] = cells;
    if (!label || !shapeCell || !sizeCell) continue;
    const shape = shapeCell.toLowerCase();
    if (shape !== 'circle' && shape !== 'box') continue;
    // weight cell may be `—` or blank for per-def rows.
    const weightMatch = weightCell?.replace(/[\s,_]/g, '').match(/^\d+/);
    const weight = weightMatch ? Number.parseInt(weightMatch[0], 10) : NaN;
    rows.push({ label, shape, size: sizeCell, weight });
  }
  return rows;
}

/**
 * Parse a size cell from the doc table. The doc table lists **sprite**
 * dimensions (w × h in ft); this function halves both sides so the return
 * value can be compared field-by-field to the TypeScript registry.
 *
 *  - "r = 1.5"          → { radius: 1.5, halfWidth: 0, halfHeight: 0 }
 *  - "1 × 1"            → { radius: 0, halfWidth: 0.5, halfHeight: 0.5 }
 *  - "3 × 3" (mob-boss) → { radius: 0, halfWidth: 1.5, halfHeight: 1.5 }
 *  - "≈ 3 × 3"          → same
 *  - "length × 0.5"     → { radius: 0, halfWidth: 0, halfHeight: 0.25 }
 *    (beam: length is dynamic per-cast so parses as NaN → 0; only the
 *     halved h anchors)
 */
function parseSize(cell: string): { radius: number; halfWidth: number; halfHeight: number } {
  const rMatch = cell.match(/r\s*[=≈]\s*([\d.]+)/i);
  if (rMatch && rMatch[1] !== undefined) {
    return { radius: Number.parseFloat(rMatch[1]), halfWidth: 0, halfHeight: 0 };
  }
  // Box form. Left side may be "length" (dynamic) or a number, possibly with ≈.
  const dims = cell.split('×').map((s) => s.replace(/[≈~≃]/g, '').trim());
  if (dims.length !== 2 || dims[0] === undefined || dims[1] === undefined) {
    return { radius: 0, halfWidth: 0, halfHeight: 0 };
  }
  const leftNum = Number.parseFloat(dims[0]);
  const rightNum = Number.parseFloat(dims[1]);
  // Doc lists sprite width × height in ft; halves for the registry.
  return {
    radius: 0,
    halfWidth: Number.isFinite(leftNum) ? leftNum / 2 : 0,
    halfHeight: Number.isFinite(rightNum) ? rightNum / 2 : 0,
  };
}

const md = readFileSync(fromRepo('docs', 'knowledge', 'game-design', 'entity-sizing.md'), 'utf8');
const docRows = parseTables(md);

const seenIds = new Set<PhysicsBodyId>();

for (const row of docRows) {
  const id = ROW_TO_ID[row.label];
  if (!id) continue; // dynamic / guideline row — no registry counterpart to check
  seenIds.add(id);
  const def = PHYSICS_BODIES[id];
  const parsed = parseSize(row.size);
  const shapeCode = row.shape === 'circle' ? SHAPE_CIRCLE : SHAPE_BOX;
  const eps = 1e-9;

  if (def.shape !== shapeCode) {
    report.error(
      `physics-defs shape drift for "${row.label}" (${id}): registry=${def.shape} doc=${row.shape}`,
      { file: 'docs/knowledge/game-design/entity-sizing.md' },
    );
  }
  if (row.shape === 'circle') {
    if (Math.abs(def.radius - parsed.radius) > eps) {
      report.error(
        `physics-defs radius drift for "${row.label}" (${id}): registry=${def.radius} doc=${parsed.radius}`,
        { file: 'src/core/physics-defs.ts' },
      );
    }
  } else {
    // For boxes, allow doc's left-dim to be 0 (beam-segment "length × …").
    if (parsed.halfWidth > 0 && Math.abs(def.halfWidth - parsed.halfWidth) > eps) {
      report.error(
        `physics-defs halfWidth drift for "${row.label}" (${id}): registry=${def.halfWidth} doc=${parsed.halfWidth}`,
        { file: 'src/core/physics-defs.ts' },
      );
    }
    if (Math.abs(def.halfHeight - parsed.halfHeight) > eps) {
      report.error(
        `physics-defs halfHeight drift for "${row.label}" (${id}): registry=${def.halfHeight} doc=${parsed.halfHeight}`,
        { file: 'src/core/physics-defs.ts' },
      );
    }
  }
  if (Number.isFinite(row.weight) && def.weight !== row.weight) {
    report.error(
      `physics-defs weight drift for "${row.label}" (${id}): registry=${def.weight} doc=${row.weight}`,
      { file: 'src/core/physics-defs.ts' },
    );
  }
}

for (const id of Object.keys(PHYSICS_BODIES) as PhysicsBodyId[]) {
  if (!seenIds.has(id)) {
    report.error(
      `registry id "${id}" has no matching row in entity-sizing.md (add a row or delete the def)`,
      { file: 'docs/knowledge/game-design/entity-sizing.md' },
    );
  }
}

if (report.blockingCount() === 0) {
  report.info(`OK: ${seenIds.size} registry entries in sync with entity-sizing.md`);
}
report.finish();
