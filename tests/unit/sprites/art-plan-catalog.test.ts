import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { assetPlanSchema, type AssetPlan } from '../../../scripts/sprites/asset-plan.js';
import { ITEM_CATALOG } from '../../../src/shared/items.js';

/**
 * Guards the item-icon art backlog: every catalog item must be tracked in
 * exactly one committed art-plan with the correct sprite type, and every
 * committed plan file must be schema-valid. This keeps the committed
 * art-plan files under plans/ from silently drifting away from
 * ITEM_CATALOG as items are added or retyped.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const plansRoot = path.join(repoRoot, 'plans');

function walkArtPlans(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkArtPlans(abs));
    } else if (entry.isFile() && entry.name.endsWith('.art.yaml')) {
      out.push(abs);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function loadPlans(): ReadonlyArray<{ file: string; plan: AssetPlan }> {
  return walkArtPlans(plansRoot).map((file) => ({
    file: path.relative(repoRoot, file),
    plan: assetPlanSchema.parse(parseYaml(readFileSync(file, 'utf8'))) as AssetPlan,
  }));
}

describe('art-plan catalog coverage', () => {
  it('every committed art-plan file is schema-valid', () => {
    // loadPlans throws (failing the test) if any plan violates the schema.
    const plans = loadPlans();
    expect(plans.length).toBeGreaterThan(0);
  });

  it('every catalog item is tracked in exactly one art-plan', () => {
    const plans = loadPlans();
    const catalogIds = new Set(ITEM_CATALOG.map((item) => item.id));

    const planFilesById = new Map<string, string[]>();
    for (const { file, plan } of plans) {
      for (const asset of plan.assets) {
        if (!catalogIds.has(asset.id)) continue;
        const files = planFilesById.get(asset.id) ?? [];
        files.push(file);
        planFilesById.set(asset.id, files);
      }
    }

    const uncatalogued = [...catalogIds].filter((id) => !planFilesById.has(id)).sort();
    expect(
      uncatalogued,
      `catalog items missing an art-plan entry: ${uncatalogued.join(', ')}`,
    ).toEqual([]);

    const duplicated = [...planFilesById.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => `${id} -> [${files.join(', ')}]`)
      .sort();
    expect(
      duplicated,
      `catalog items tracked in more than one art-plan: ${duplicated.join('; ')}`,
    ).toEqual([]);
  });

  it('catalog items use the sprite type implied by their tags', () => {
    const plans = loadPlans();
    const itemById = new Map(ITEM_CATALOG.map((item) => [item.id, item]));

    const mistyped: string[] = [];
    for (const { file, plan } of plans) {
      for (const asset of plan.assets) {
        const item = itemById.get(asset.id);
        if (!item) continue;
        const expected = item.tags.includes('Weapons')
          ? 'weapon'
          : item.tags.some((tag) => String(tag) === 'Gear')
            ? 'equipment'
            : 'item';
        if (asset.type !== expected) {
          mistyped.push(`${asset.id} in ${file}: type=${asset.type}, expected ${expected}`);
        }
      }
    }

    expect(mistyped, `art-plan entries with the wrong sprite type: ${mistyped.join('; ')}`).toEqual(
      [],
    );
  });
});
