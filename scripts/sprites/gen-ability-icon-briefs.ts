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

interface IconBatchBrief {
  id: string;
  name: string;
  description: string;
  type: string;
  variantCount: number;
  iconBatch: IconBatchEntry[];
}

function buildBriefYaml(brief: IconBatchBrief): string {
  const entries = brief.iconBatch
    .map((e) => {
      const desc = e.description ? `\n      description: >-\n        ${e.description}` : '';
      return `    - id: ${e.id}\n      concept: "${e.concept}"${desc}`;
    })
    .join('\n');
  return [
    `id: ${brief.id}`,
    `name: "${brief.name}"`,
    `description: >-`,
    `  ${brief.description}`,
    `type: icon`,
    `variantCount: ${brief.variantCount}`,
    `iconBatch:`,
    entries,
    '',
  ].join('\n');
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

  // All unbrief-ed abilities fit in a single batch (well under 16).
  const BATCH_SIZE = 16;
  for (let batchIndex = 0; batchIndex < needsBrief.length; batchIndex += BATCH_SIZE) {
    const chunk = needsBrief.slice(batchIndex, batchIndex + BATCH_SIZE);
    const batchNum = String(Math.floor(batchIndex / BATCH_SIZE) + 1).padStart(2, '0');
    const briefId = `ability-icons-batch-${batchNum}`;

    const iconBatch: IconBatchEntry[] = chunk.map((a) => ({
      id: abilityIconId(a.id),
      concept: a.name,
      description: `${a.kind.toUpperCase()} ability — ${a.description}`,
    }));

    const brief: IconBatchBrief = {
      id: briefId,
      name: `Ability Icons — Batch ${batchNum}`,
      description: `Icon batch for ${chunk.length} abilities missing art (batch ${batchNum}).`,
      type: 'icon',
      variantCount: chunk.length,
      iconBatch,
    };

    const yamlPath = path.join(OUT_DIR, `${briefId}.yaml`);
    writeFileSync(yamlPath, buildBriefYaml(brief), 'utf8');
    process.stdout.write(
      `gen-ability-icon-briefs: wrote ${path.relative(REPO_ROOT, yamlPath)} (${chunk.length} icons)\n`,
    );
  }
}

run();
