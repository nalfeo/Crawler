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

/**
 * Default number of judged variants when a hand-edited brief omits
 * `judge.maxVariants`. This is the **initial generation** judge cap and is left
 * at 16 deliberately: generation should still explore the full candidate set.
 * The variant-approval *rejudge* uses the lower
 * {@link THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS} instead — see
 * `theme-equipment-runner.ts` `approveVariantArtifacts`.
 */
export const THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS = 16;

/**
 * Number of variants the variant-approval **rejudge** judges (scoped to that
 * path only, so initial generation is unaffected). Lowered to 6 (2026-07-28):
 * the judge only keeps the best 3 variants, so rejudging 16 spent ~2.6× the
 * Azure vision calls for no selection benefit. 6 keeps a comfortable margin
 * above the keep-3 target while cutting the dominant cost of the rejudge — the
 * maintainer-facing wait. Never raises a brief that already asks for fewer.
 */
export const THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS = 6;

/**
 * Number of variants the theme-equipment variant-approval rejudge judges in
 * parallel. The rejudge path carries no judge budget and no judge cache, so
 * bounded parallelism is race-free there (see `runJudgePass`), and Azure 429/5xx
 * backoff already lives in the provider transport layer. 4 turns the ~6-call
 * rejudge from 6 serial waves into ⌈6/4⌉ = 2, without a new rate-limit path.
 */
export const THEME_EQUIPMENT_JUDGE_CONCURRENCY = 4;

/** Durable run-store key for an item's selected brief at a given revision. */
export function selectedBriefKey(
  state: ThemeEquipmentSetState,
  item: ThemeEquipmentSetItem,
  revision = item.revision,
  nonce?: string,
): string {
  const suffix = nonce ? `-${nonce}` : '';
  return `theme-sets/${state.id}/artifacts/${item.id}/r${revision}/brief${suffix}.yaml`;
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
