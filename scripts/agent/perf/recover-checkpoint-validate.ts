#!/usr/bin/env node
/**
 * All-or-nothing compatibility gate for VALIDATE-ONLY recovery of a cancelled
 * AI Sweep Eval run's round-2 checkpoints (see `.github/workflows/ai-sweep-recover.yml`).
 *
 * BACKGROUND: run 29786216369 completed all round-2 (`search-checkpoint-r2-*`)
 * checkpoints for every combo, then was cancelled mid-round-3 when an uncapped
 * round-eval matrix starved the account's shared runner pool (fixed on main by
 * capping every matrix at `max-parallel: 8`; see the `ai-sweep.yml` header and
 * `2026-07-20-ai-sweep-round-eval-max-parallel.md`). Round 2's finalists never
 * got a chance to validate before the run was killed. This module re-validates
 * those already-computed round-2 finalists cross-run, WITHOUT re-planning or
 * re-evaluating any round — it is a pure compatibility gate, not a resume/plan
 * engine (a prior generic cross-run resume design, PR #1759, was rejected for
 * exactly that scope creep: new `runInputs` schema, mixed fresh/resume modes,
 * search continuation).
 *
 * WHY `expectedWorkflowSha` is a REQUIRED external parameter (not inferred):
 * `sweep-eval.ts --stage validate` (unchanged, reused as-is) independently
 * calls `assertSearchArtifactProvenance(search.meta, search.combo, {
 * ...currentBuildFingerprint() })`, and `currentBuildFingerprint().workflowSha`
 * reads `process.env.GITHUB_SHA` — the *current* job's env var, not whatever a
 * later `actions/checkout` step happens to check out. The recovery workflow
 * resolves the SOURCE run's exact `head_sha` via the GitHub API in
 * `recover-preflight`, then explicitly overrides `GITHUB_SHA` on every step
 * that invokes `sweep-eval.ts`/`aggregate-shards.ts` so `sweep-eval.ts`'s own
 * unchanged provenance gate passes. This validator's `expectedWorkflowSha`
 * check is a cheap, all-8-combos-at-once PRE-check for the same mismatch,
 * failing the whole recovery before any expensive validate compute runs,
 * rather than failing one matrix leg at a time deep inside `sweep-eval.ts`.
 *
 * This module never mutates or rewrites a checkpoint — it only reads and
 * reports. A checkpoint whose provenance doesn't match is REJECTED, never
 * patched to match.
 *
 * Deterministic and free of Math.random / Date.now.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RoundCheckpoint } from './round-plan.js';
import { SHARD_SCHEMA_VERSION } from './aggregate-shards.js';
import { SECONDARY_KNOBS, LEGACY_COMBO_ID, type TunableKnob } from './gen-configs.js';
import { parseSeeds } from './winrate-sweep-args.js';

/** One recovered checkpoint file, with its filename-derived combo id. */
export interface RecoveredCombo {
  /** Combo id derived from the artifact filename (`search-checkpoint-r2-<combo>.json`). */
  combo: string;
  checkpoint: RoundCheckpoint;
}

export interface RecoveryValidationResult {
  ok: boolean;
  /** Empty iff ok. Every entry names the offending combo/field/values. */
  errors: string[];
  /** Provenance lines to print regardless of outcome (source run id, expected
   *  workflow sha, combo count) — "provenance must be logged" applies on
   *  failure too, not just success. */
  log: string[];
}

const SECONDARY_KNOB_SET: ReadonlySet<TunableKnob> = new Set(SECONDARY_KNOBS);

/** Fields that must mutually agree across every recovered checkpoint. Unlike
 *  `workflowSha` (checked against the externally-resolved `expectedWorkflowSha`
 *  below), these have no independently-resolved "expected" value here — this
 *  script itself runs on the CURRENT commit/lockfile, not the historical one
 *  the checkpoints were produced under — so mutual cross-checkpoint agreement
 *  is the only provable invariant for them at this stage. */
const CONSISTENCY_FIELDS = [
  'budgetMs',
  'maxFrames',
  'stage',
  'runnerOs',
  'nodeVersion',
  'packageLockHash',
] as const;

function seedWeaponKey(seed: number, weapon: string): string {
  return `${seed}\u0000${weapon}`;
}

/**
 * Checks a combo's row panel (already filtered to one specific combo+config)
 * against the requested `trainSeeds x weapons` cartesian product: no missing
 * pair, no extra pair, no duplicate pair.
 */
function checkPanelComplete(
  rows: Array<{ seed: number; weapon: string }>,
  trainSeeds: readonly number[],
  weapons: readonly string[],
  label: string,
  errors: string[],
): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = seedWeaponKey(row.seed, row.weapon);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    errors.push(
      `${label}: duplicate (seed, weapon) row(s): ${duplicates
        .map(([key, count]) => `${key.replace('\u0000', '/')}x${count}`)
        .join(', ')}`,
    );
  }
  const missing: string[] = [];
  for (const seed of trainSeeds) {
    for (const weapon of weapons) {
      if (!seen.has(seedWeaponKey(seed, weapon))) {
        missing.push(`${seed}/${weapon}`);
      }
    }
  }
  if (missing.length > 0) {
    errors.push(`${label}: missing (seed, weapon) row(s): ${missing.join(', ')}`);
  }
  const expectedCount = trainSeeds.length * weapons.length;
  const extra = [...seen.keys()].filter(
    (key) => !trainSeeds.some((s) => weapons.some((w) => seedWeaponKey(s, w) === key)),
  );
  if (extra.length > 0) {
    errors.push(
      `${label}: unexpected (seed, weapon) row(s) outside the requested panel (expected ${expectedCount} rows): ${extra
        .map((key) => key.replace('\u0000', '/'))
        .join(', ')}`,
    );
  }
}

/**
 * Pure all-or-nothing validator: every SSOT combo (+ LEGACY) must have exactly
 * one recovered round-2 checkpoint, every checkpoint's stamped `workflowSha`
 * must equal the externally-resolved `expectedWorkflowSha`, every checkpoint
 * must mutually agree on the remaining provenance fields, no secondary-knob
 * tuning may be present, and both the finalist's and the incumbent's row
 * panels must be complete/duplicate-free rectangles over `trainSeeds x weapons`.
 * Collects every error rather than short-circuiting, so one run reports the
 * full picture instead of one problem at a time.
 */
export function validateRecoveredCheckpoints(
  recovered: RecoveredCombo[],
  ssotCombos: string[],
  trainSeeds: number[],
  weapons: string[],
  expectedWorkflowSha: string,
): RecoveryValidationResult {
  const errors: string[] = [];
  const log: string[] = [
    `expectedWorkflowSha=${expectedWorkflowSha || '(empty)'}`,
    `ssotCombos=${ssotCombos.length} (${ssotCombos.join(', ')})`,
    `recovered=${recovered.length}`,
    `trainSeeds=${trainSeeds.length} (${trainSeeds[0]}..${trainSeeds[trainSeeds.length - 1]})`,
    `weapons=${weapons.join(', ')}`,
  ];

  if (!expectedWorkflowSha) {
    errors.push(
      'expectedWorkflowSha is empty — refusing to validate without an externally-resolved source-run head_sha (fail closed).',
    );
    return { ok: false, errors, log };
  }

  if (!ssotCombos.includes(LEGACY_COMBO_ID)) {
    errors.push(
      `LEGACY_COMBO_ID (${LEGACY_COMBO_ID}) missing from ssotCombos — enumerateCombos() invariant violated.`,
    );
  }

  // 1. Set-equality + duplicate detection (counts, not just Set size, so two
  //    files claiming the same combo are caught even if a combo is missing).
  const counts = new Map<string, number>();
  for (const r of recovered) {
    counts.set(r.combo, (counts.get(r.combo) ?? 0) + 1);
  }
  const recoveredSet = new Set(counts.keys());
  const ssotSet = new Set(ssotCombos);
  const missing = ssotCombos.filter((c) => !recoveredSet.has(c));
  const unexpected = [...recoveredSet].filter((c) => !ssotSet.has(c));
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
  if (missing.length > 0) {
    errors.push(`Missing round-2 checkpoint(s) for combo(s): ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    errors.push(`Unexpected/unknown combo id(s) recovered: ${unexpected.join(', ')}`);
  }
  if (duplicated.length > 0) {
    errors.push(
      `Duplicate round-2 checkpoint(s) for combo(s): ${duplicated
        .map(([combo, count]) => `${combo}x${count}`)
        .join(', ')}`,
    );
  }

  // Per-checkpoint checks, only over combos that are exactly-one-present
  // (skip combos already flagged missing/duplicate above to avoid noise).
  const singletons = recovered.filter((r) => counts.get(r.combo) === 1 && ssotSet.has(r.combo));

  let referenceMeta: RoundCheckpoint['meta'] | null = null;
  for (const { combo, checkpoint } of singletons) {
    if (checkpoint.combo !== combo) {
      errors.push(
        `${combo}: filename-derived combo does not match embedded checkpoint.combo '${checkpoint.combo}'`,
      );
    }
    if (checkpoint.round !== 2) {
      errors.push(`${combo}: checkpoint.round=${checkpoint.round}, expected exactly 2`);
    }
    if (checkpoint.meta.schemaVersion !== SHARD_SCHEMA_VERSION) {
      errors.push(
        `${combo}: meta.schemaVersion=${checkpoint.meta.schemaVersion}, expected ${SHARD_SCHEMA_VERSION}`,
      );
    }
    if (checkpoint.meta.floorId !== 'floor1') {
      errors.push(`${combo}: meta.floorId='${checkpoint.meta.floorId}', expected 'floor1'`);
    }
    if (checkpoint.meta.workflowSha !== expectedWorkflowSha) {
      errors.push(
        `${combo}: meta.workflowSha='${checkpoint.meta.workflowSha}' != expectedWorkflowSha='${expectedWorkflowSha}'`,
      );
    }

    if (!referenceMeta) {
      referenceMeta = checkpoint.meta;
    } else {
      for (const field of CONSISTENCY_FIELDS) {
        if (checkpoint.meta[field] !== referenceMeta[field]) {
          errors.push(
            `${combo}: meta.${field}='${String(checkpoint.meta[field])}' disagrees with another recovered checkpoint's '${String(referenceMeta[field])}'`,
          );
        }
      }
    }

    // secondary === false must be provable from the checkpoint's own steps —
    // no SECONDARY_KNOBS key may be present. `seamWeight` is primary-adjacent
    // (NAVMESH_FUSED-only) and deliberately excluded from this check.
    const secondaryKeysPresent = Object.keys(checkpoint.steps).filter((k) =>
      SECONDARY_KNOB_SET.has(k as TunableKnob),
    );
    if (secondaryKeysPresent.length > 0) {
      errors.push(
        `${combo}: secondary-knob step(s) present (${secondaryKeysPresent.join(', ')}) — secondary tuning was requested/performed, this recovery only reuses primary-only round-2 finalists`,
      );
    }

    // Finalist panel: rows for (checkpoint.combo, checkpoint.bestConfigId).
    const finalistRows = checkpoint.rows.filter(
      (row) => row.combo === checkpoint.combo && row.configId === checkpoint.bestConfigId,
    );
    checkPanelComplete(
      finalistRows,
      trainSeeds,
      weapons,
      `${combo}: finalist (${checkpoint.bestConfigId}) TRAIN panel`,
      errors,
    );

    // Incumbent panel: rows for (checkpoint.incumbentCombo, checkpoint.incumbentConfigId).
    const incumbentRows = checkpoint.rows.filter(
      (row) =>
        row.combo === checkpoint.incumbentCombo && row.configId === checkpoint.incumbentConfigId,
    );
    checkPanelComplete(
      incumbentRows,
      trainSeeds,
      weapons,
      `${combo}: incumbent (${checkpoint.incumbentCombo}/${checkpoint.incumbentConfigId}) TRAIN panel`,
      errors,
    );
  }

  return { ok: errors.length === 0, errors, log };
}

// ---------------------------------------------------------------------------
// CLI (guarded so importing this module for its pure helpers never runs it).
// Reads every `search-checkpoint-r2-*.json` file in --dir, resolves the SSOT
// combo list via enumerateCombos() (not re-shelled), validates, and prints
// `log` + any `errors` before exiting 1 on failure — fail closed.
// ---------------------------------------------------------------------------
interface CliArgs {
  dir: string | null;
  trainSeeds: string | null;
  weapons: string | null;
  expectedWorkflowSha: string | null;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    dir: null,
    trainSeeds: null,
    weapons: null,
    expectedWorkflowSha: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dir' && next) {
      args.dir = next;
      i++;
    } else if (arg === '--train-seeds' && next) {
      args.trainSeeds = next;
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next;
      i++;
    } else if (arg === '--expected-workflow-sha' && next) {
      args.expectedWorkflowSha = next;
      i++;
    }
  }
  return args;
}

const CHECKPOINT_FILE_RE = /^search-checkpoint-r2-(.+)\.json$/;

function loadRecoveredCombos(dir: string): RecoveredCombo[] {
  const files = readdirSync(dir).filter((f) => CHECKPOINT_FILE_RE.test(f));
  return files.map((file) => {
    const match = CHECKPOINT_FILE_RE.exec(file);
    const combo = match?.[1] ?? file;
    const checkpoint = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as RoundCheckpoint;
    return { combo, checkpoint };
  });
}

async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseCliArgs(argv);
  if (!args.dir || !args.trainSeeds || !args.weapons || !args.expectedWorkflowSha) {
    console.error(
      'Usage: recover-checkpoint-validate.ts --dir <checkpoints-dir> --train-seeds <spec> --weapons <csv> --expected-workflow-sha <sha>',
    );
    process.exit(1);
    return;
  }
  const { enumerateCombos, comboId } = await import('./gen-configs.js');
  const ssotCombos = enumerateCombos().map(comboId);
  const recovered = loadRecoveredCombos(args.dir);
  const result = validateRecoveredCheckpoints(
    recovered,
    ssotCombos,
    parseSeeds(args.trainSeeds),
    args.weapons.split(',').map((w) => w.trim()),
    args.expectedWorkflowSha,
  );
  for (const line of result.log) {
    console.log(line);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
    return;
  }
  console.log(`All ${recovered.length} round-2 checkpoint(s) validated OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
