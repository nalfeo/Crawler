#!/usr/bin/env node
/**
 * gen-ability-icon-briefs.ts
 *
 * Scans ABILITY_PRESENTATION_BY_ID for entries that lack an `iconBriefId` and
 * emits icon-batch YAML briefs to `briefs/icons/abilities/`.
 *
 * Abilities that already have an `iconBriefId` are skipped — their brief is
 * already authored (or in progress) and should not be regenerated.
 *
 * Usage:
 *   npm run sprites:gen-ability-icon-briefs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABILITY_PRESENTATION_BY_ID,
  type AbilityPresentation,
} from '../../src/shared/ability-presentation.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'briefs', 'icons', 'abilities');

/** Canonical icon id for an ability. */
function abilityIconId(abilityId: string): string {
  return `ability-icon-${abilityId}`;
}

interface IconBatchEntry {
  id: string;
  concept: string;
  description?: string;
}

/** Returns `[[row,col],...]` empty-cell list to pad a 4×4 grid for a partial batch. */
function trailingEmptyCells(batchSize: number): readonly (readonly [number, number])[] {
  if (batchSize >= 16) return [];
  const empty: [number, number][] = [];
  for (let i = batchSize; i < 16; i++) {
    empty.push([Math.floor(i / 4), i % 4]);
  }
  return empty;
}

function buildBriefYaml(
  briefName: string,
  batchNum: string,
  chunkSize: number,
  iconBatch: IconBatchEntry[],
): string {
  const emptyCells = trailingEmptyCells(chunkSize);
  const lines: string[] = [
    `name: "${briefName}"`,
    `description: >-`,
    `  Icon batch for ${chunkSize} abilities missing art (batch ${batchNum}).`,
    `  Pixel-art symbols on transparent background; frames are composited separately.`,
    `type: icon`,
  ];

  // For partial batches, emit generation.sheet so iconBatch.length == rows*cols - emptyCells.length.
  if (emptyCells.length > 0) {
    lines.push(`generation:`);
    lines.push(`  sheet:`);
    lines.push(`    rows: 4`);
    lines.push(`    cols: 4`);
    lines.push(`    emptyCells:`);
    for (const [r, c] of emptyCells) {
      lines.push(`      - [${r}, ${c}]`);
    }
    lines.push(`    nativeCanvas: 1024`);
  }

  lines.push(`iconBatch:`);
  for (const e of iconBatch) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    concept: "${e.concept}"`);
    if (e.description) {
      lines.push(`    description: "${e.description.replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function run(): void {
  const needsBrief = (Object.values(ABILITY_PRESENTATION_BY_ID) as AbilityPresentation[]).filter(
    (a) => a.iconBriefId === undefined,
  );

  if (needsBrief.length === 0) {
    process.stdout.write(
      'gen-ability-icon-briefs: all abilities already have iconBriefId — nothing to do\n',
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const BATCH_SIZE = 16;
  for (let batchIndex = 0; batchIndex < needsBrief.length; batchIndex += BATCH_SIZE) {
    const chunk = needsBrief.slice(batchIndex, batchIndex + BATCH_SIZE);
    const batchNum = String(Math.floor(batchIndex / BATCH_SIZE) + 1).padStart(2, '0');
    const briefName = `ability-icons-batch-${batchNum}`;

    const iconBatch: IconBatchEntry[] = chunk.map((a) => ({
      id: abilityIconId(a.id),
      concept: a.name,
      description: `${a.kind.toUpperCase()} ability — ${a.description}`,
    }));

    const yamlContent = buildBriefYaml(briefName, batchNum, chunk.length, iconBatch);
    const yamlPath = path.join(OUT_DIR, `${briefName}.yaml`);
    writeFileSync(yamlPath, yamlContent, 'utf8');
    process.stdout.write(
      `gen-ability-icon-briefs: wrote ${path.relative(REPO_ROOT, yamlPath)} (${chunk.length} icons)\n`,
    );
  }
}

run();
