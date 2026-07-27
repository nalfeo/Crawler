/**
 * Shared brief helpers for the theme-equipment pipeline.
 *
 * Extracted from `theme-equipment-runner.ts` so the lightweight review CLI
 * (`theme-equipment-review-cli.ts`) can materialise / key / judge-enable a
 * brief without importing the heavy runner (which pulls in the generate-one
 * pipeline and Azure providers). `loadBrief` (`./load-brief.js`) is itself
 * lightweight — just YAML + schema + deep-merge + palette resolution.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadBrief, type LoadedBrief } from './load-brief.js';
import type { ThemeEquipmentSetItem, ThemeEquipmentSetState } from './theme-equipment-set.js';

/** Default number of judged variants when a hand-edited brief omits `judge.maxVariants`. */
export const THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS = 16;

/** Durable run-store key for an item's selected brief at a given revision. */
export function selectedBriefKey(
  state: ThemeEquipmentSetState,
  item: ThemeEquipmentSetItem,
  revision = item.revision,
): string {
  return `theme-sets/${state.id}/artifacts/${item.id}/r${revision}/brief.yaml`;
}

/** Extract the revision embedded in a `…-brief-r<N>-selected` artifact id. */
export function selectedBriefRevision(artifactId: string, fallback: number): number {
  const match = /-brief-r(\d+)-selected$/.exec(artifactId);
  return match ? Number(match[1]) : fallback;
}

/**
 * Force the sprite-generation judge on for a brief. Mirrors the treatment the
 * generator applies to every theme-equipment brief so hand edits stay
 * consistent: `judge.enabled = true`, and `judge.maxVariants` defaults to
 * {@link THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS} when not already a number.
 */
export function enableJudge(yaml: string): string {
  const doc = parseYaml(yaml) as Record<string, unknown>;
  const judge =
    doc['judge'] && typeof doc['judge'] === 'object' && !Array.isArray(doc['judge'])
      ? { ...(doc['judge'] as Record<string, unknown>) }
      : {};
  judge['enabled'] = true;
  if (typeof judge['maxVariants'] !== 'number') {
    judge['maxVariants'] = THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS;
  }
  doc['judge'] = judge;
  return stringifyYaml(doc);
}

/**
 * Stage a brief YAML to `generated/theme-equipment-drafts/…` and load it (schema
 * + palette validation). Has a filesystem side effect — the review CLI uses the
 * pure `validateBriefYaml` from `./load-brief.js` instead when it only needs to
 * validate before persisting.
 */
export function materializeAndLoadBrief(
  repoRoot: string,
  state: ThemeEquipmentSetState,
  item: ThemeEquipmentSetItem,
  yaml: string,
  revision = item.revision,
): LoadedBrief {
  const dir = path.join(
    repoRoot,
    'generated',
    'theme-equipment-drafts',
    state.id,
    item.id,
    `r${revision}`,
  );
  mkdirSync(dir, { recursive: true });
  const briefPath = path.join(dir, 'brief.yaml');
  writeFileSync(briefPath, yaml, 'utf8');
  return loadBrief(briefPath, { projectRoot: repoRoot });
}
