/**
 * Generate icon-batch brief YAML files for every achievement.
 *
 * Reads both achievement data files (floor1 + floor2), groups entries into
 * batches of up to 16, and writes one YAML brief per batch to
 * `briefs/icons/achievements/`.
 *
 * Usage:
 *   npm run sprites:gen-achievement-icon-briefs
 *
 * Re-running is safe: existing brief files are overwritten with identical
 * content. The generated `iconBatch[N].id` is derived from the achievement's
 * `iconId` placeholder by stripping the `-placeholder` suffix — this is the
 * manifest key used once approved.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface AchievementEntry {
  id: string;
  floor: number;
  title: string;
  unlockCriteria?: string;
  iconId: string;
  difficulty: string;
}

interface IconBatchEntry {
  id: string;
  concept: string;
  description: string;
}

const BATCH_SIZE = 16;
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'briefs', 'icons', 'achievements');

function iconIdFromPlaceholder(placeholderId: string): string {
  return placeholderId.replace(/-placeholder$/, '');
}

function yamlString(s: string): string {
  // Use double-quoted YAML string, escaping special chars.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Returns the `[[row,col],...]` empty-cell list to fill a 4×4 grid when the batch is smaller than 16. */
function trailingEmptyCells(batchSize: number): readonly (readonly [number, number])[] {
  if (batchSize >= 16) return [];
  const empty: [number, number][] = [];
  for (let i = batchSize; i < 16; i++) {
    empty.push([Math.floor(i / 4), i % 4]);
  }
  return empty;
}

function renderBrief(batchIndex: number, entries: IconBatchEntry[], floor: number): string {
  const num = String(batchIndex + 1).padStart(2, '0');
  const name = `achv-icons-batch-${num}`;
  const emptyCells = trailingEmptyCells(entries.length);
  const lines: string[] = [
    `name: ${name}`,
    `type: icon`,
    `description: "Achievement icon batch ${batchIndex + 1}: pixel-art symbols for dungeon achievements on Floor ${floor}."`,
    `floor: ${floor}`,
  ];

  // Emit generation.sheet for partial batches so iconBatch.length == rows*cols - emptyCells.length.
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
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    concept: ${yamlString(e.concept)}`);
    lines.push(`    description: ${yamlString(e.description)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function toIconEntries(achievements: AchievementEntry[]): IconBatchEntry[] {
  return achievements.map((a) => ({
    id: iconIdFromPlaceholder(a.iconId),
    concept: a.title,
    description: [
      `Icon for the "${a.title}" achievement`,
      a.unlockCriteria ? `(${a.unlockCriteria})` : '',
      `— difficulty: ${a.difficulty}, floor ${a.floor}.`,
      `Symbol should be bold, immediately readable, pixel-art style, transparent background.`,
    ]
      .filter(Boolean)
      .join(' '),
  }));
}

function main(): void {
  const floor1Path = path.join(REPO_ROOT, 'src', 'shared', 'data', 'achievements.floor1.json');
  const floor2Path = path.join(REPO_ROOT, 'src', 'shared', 'data', 'achievements.floor2.json');

  const floor1: AchievementEntry[] = JSON.parse(readFileSync(floor1Path, 'utf8'));
  const floor2: AchievementEntry[] = JSON.parse(readFileSync(floor2Path, 'utf8'));

  // Process each floor's achievements separately so no batch ever spans two
  // floors. This guarantees batchFloor is correct for every batch (the
  // context prompt references the floor number, so a mixed-floor batch would
  // describe the wrong dungeon tier to the model).
  const groups: { floor: number; achievements: AchievementEntry[] }[] = [
    { floor: 1, achievements: floor1 },
    { floor: 2, achievements: floor2 },
  ];

  mkdirSync(OUTPUT_DIR, { recursive: true });

  let batchIndex = 0;
  let totalIcons = 0;

  for (const group of groups) {
    const entries = toIconEntries(group.achievements);
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const yaml = renderBrief(batchIndex, batch, group.floor);
      const num = String(batchIndex + 1).padStart(2, '0');
      const outPath = path.join(OUTPUT_DIR, `achv-icons-batch-${num}.yaml`);
      writeFileSync(outPath, yaml);
      process.stdout.write(`Wrote ${outPath} (${batch.length} icons, floor ${group.floor})\n`);
      batchIndex++;
      totalIcons += batch.length;
    }
  }

  process.stdout.write(
    `Done. Generated ${batchIndex} brief file(s) for ${totalIcons} achievement icons.\n`,
  );
}

main();
