#!/usr/bin/env node
/**
 * check-equipment-art-coverage.ts — CI guard that every wired piece of
 * equipment resolves to real, approved art.
 *
 * Walks the union of the two ID spaces the game actually equips from:
 *
 *   - the legacy inventory catalog's equippables (`getEquippableItemIds()`
 *     ∩ `ITEM_CATALOG`), and
 *   - the Floor 2 generated-equipment reward pool
 *     (`FLOOR2_REWARD_POOL_STABLE_IDS`),
 *
 * resolves each through the SAME `resolveItemSprite` the equipment and
 * inventory panels call, and classifies it real / placeholder / none. Fails on
 * any gap not already recorded in the committed shrink-only baseline.
 *
 * Reads the per-sprite **shards** under `public/assets/generated/entries/`
 * rather than `manifest.json`, because the aggregate is a gitignored build
 * artifact that need not exist on a fresh checkout or in CI.
 *
 * ## Usage
 *
 *   npm run check:equipment-art-coverage
 *   npm run check:equipment-art-coverage -- --json
 *   npm run check:equipment-art-coverage -- --update   # shrink the baseline
 *
 * `--update` refuses to widen the baseline; see `equipment-art-coverage-lib.ts`.
 * `--init` writes the baseline from scratch and exists only to bootstrap the
 * file; it refuses to run once the baseline exists, so it cannot be used to
 * launder new gaps into the allowance.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  loadGeneratedManifest,
  parseGeneratedManifest,
} from '../../../src/shared/generated-assets.js';
import { getEquippableItemIds } from '../../../src/shared/equipmentDefs.js';
import { getItemById } from '../../../src/shared/items.js';
import { isPlaceholderEntry, resolveItemSprite } from '../../../src/shared/item-sprites.js';
import { FLOOR2_REWARD_POOL_STABLE_IDS } from '../../../src/shared/data/floor2-reward-pool.js';
import { composeManifestFromShards } from '../../sprites/generated-shards.js';
import {
  baselineWouldWiden,
  classifyArtStatus,
  evaluateCoverage,
  formatReport,
  nextBaseline,
  type EquipmentArtBaseline,
  type EquipmentArtRow,
} from './equipment-art-coverage-lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
const BASELINE_PATH = path.join(
  REPO_ROOT,
  'docs',
  'knowledge',
  'metrics',
  'equipment-art-coverage-baseline.json',
);

/**
 * Fixed resolution seed. `resolveItemSprite` picks deterministically among
 * equally-ranked variants using this seed; the CHOICE of variant is irrelevant
 * to coverage (every variant of a brief shares its placeholder-ness), but
 * pinning the seed keeps the check's output byte-stable across runs.
 */
const RESOLUTION_SEED = 0;

function readBaseline(): EquipmentArtBaseline {
  try {
    const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    if (
      typeof raw === 'object' &&
      raw !== null &&
      Array.isArray((raw as { gaps?: unknown }).gaps) &&
      (raw as { gaps: unknown[] }).gaps.every((id) => typeof id === 'string')
    ) {
      return { gaps: (raw as { gaps: string[] }).gaps };
    }
    throw new Error('baseline must be an object with a string[] `gaps` field');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { gaps: [] };
    }
    throw new Error(
      `Failed to read ${path.relative(REPO_ROOT, BASELINE_PATH)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

function writeBaseline(baseline: EquipmentArtBaseline): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

function collectRows(): EquipmentArtRow[] {
  const registry = loadGeneratedManifest(
    parseGeneratedManifest(JSON.parse(JSON.stringify(composeManifestFromShards(GENERATED_DIR)))),
  );

  // A stable ID can appear in both spaces; the Floor 2 pool wins the `source`
  // label because that is the space that governs whether it can be granted.
  const ids = new Map<string, EquipmentArtRow['source']>();
  const generatedOnly: string[] = [];
  for (const itemId of getEquippableItemIds()) {
    if (getItemById(itemId) === undefined) {
      // Generated-only id: it has no catalog ItemDef, so it can only be granted
      // through the Floor 2 reward pool. Verified below rather than assumed —
      // an unverified skip would let a piece drop out of the gated ID space
      // entirely, which is the one way a ratchet can be quietly laundered.
      generatedOnly.push(itemId);
      continue;
    }
    ids.set(itemId, 'catalog');
  }
  const poolIds = new Set<string>(FLOOR2_REWARD_POOL_STABLE_IDS);
  const ungated = generatedOnly.filter((id) => !poolIds.has(id));
  if (ungated.length > 0) {
    throw new Error(
      `Equippable id(s) have no catalog ItemDef and are not in FLOOR2_REWARD_POOL_STABLE_IDS, ` +
        `so they would escape this gate entirely: ${ungated.join(', ')}. ` +
        `Add them to a gated ID space rather than letting them go unchecked.`,
    );
  }
  for (const stableId of FLOOR2_REWARD_POOL_STABLE_IDS) {
    ids.set(stableId, 'floor2-pool');
  }

  return [...ids.entries()]
    .map(([id, source]): EquipmentArtRow => {
      const entry = resolveItemSprite(registry, id, RESOLUTION_SEED);
      return {
        id,
        source,
        status: classifyArtStatus(entry, isPlaceholderEntry),
        assetPath: entry?.assetPath ?? null,
        briefId: entry?.briefId ?? null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const update = argv.includes('--update');
  const init = argv.includes('--init');

  const baseline = readBaseline();
  const result = evaluateCoverage(collectRows(), baseline);

  if (init) {
    if (existsSync(BASELINE_PATH)) {
      process.stderr.write(
        `Refusing to --init: ${path.relative(REPO_ROOT, BASELINE_PATH)} already exists. ` +
          'Use --update (shrink-only) instead.\n',
      );
      process.exitCode = 1;
      return;
    }
    writeBaseline(nextBaseline(result));
    process.stdout.write(
      `Wrote ${path.relative(REPO_ROOT, BASELINE_PATH)} — ${result.gaps.length} gap(s) recorded.\n`,
    );
    return;
  }

  if (update) {
    const next = nextBaseline(result);
    if (baselineWouldWiden(baseline, next)) {
      process.stderr.write(
        'Refusing to update: that would ADD ids to the baseline, which is shrink-only.\n' +
          'Land art for the new gaps instead:\n' +
          result.newGaps.map((id) => `   - ${id}\n`).join(''),
      );
      process.exitCode = 1;
      return;
    }
    writeBaseline(next);
    process.stdout.write(
      `Updated ${path.relative(REPO_ROOT, BASELINE_PATH)} — ${next.gaps.length} gap(s) remain.\n`,
    );
    return;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
