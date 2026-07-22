# Recover cancelled AI Sweep run 29786216369 (round-2 checkpoints, validate-only)

## Date

2026-07-21

## Persona

DevOps Engineer, executing a plan pre-approved by a parent session
(`5392703e-46a9-4d27-a466-3d0af0a09c72`) after a prior generic cross-run
resume attempt (PR #1759) was rejected for scope.

## Systems touched

ai-combat-balance, ci-policy

## Apples

2 apples estimated, 2 apples actual. 3 new files (1 workflow YAML, 1 pure
validator script, 1 test file), zero modified files, no new schema, no
`src/**` touched. No review-harness stages required per the tier matrix
(floor is 3🍎); a minimal 2-apple ledger recording the tier was still
required and added (`docs/knowledge/review-ledgers/2026-07-21-ai-sweep-recover-checkpoint-r2.review-ledger.json`).

## Background

GitHub Actions "AI Sweep Eval" run `29786216369` completed all round-2
checkpoints for all 8 SSOT combos, then was cancelled mid-round-3 because
more than 8 parallel round-eval jobs starved the account's shared runner
capacity (root-caused and fixed separately in
`docs/knowledge/handoffs/2026-07-20-ai-sweep-round-eval-max-parallel.md`,
which added `max-parallel: 8` to `ai-sweep.yml`'s round-eval matrices — that
fix is NOT re-touched here). The completed round-2 search checkpoints for
that run are still valid, expensive-to-recompute artifacts; only round 3
(planning/finalist selection/validation) was lost.

A prior attempt (PR #1759) to build generic cross-run resume support was
rejected: 1,560 additions across 8 files, a new `runInputs`/checkpoint
schema, mixed fresh/resume execution modes, and search-continuation
behavior — all out of scope for recovering one specific, already-complete
set of checkpoints.

## What changed

- **`scripts/agent/perf/recover-checkpoint-validate.ts`** (new, ~370 lines)
  — pure, unit-tested `validateRecoveredCheckpoints()` plus a thin CLI
  wrapper. All-or-nothing fail-closed gate: requires exactly one
  `search-checkpoint-r2-*` per SSOT combo (via `enumerateCombos()`, no
  hardcoded list) including LEGACY; checks filename/embedded-combo
  agreement, `round === 2`, `schemaVersion`, `floorId`; requires every
  checkpoint's `meta.workflowSha` to equal an externally-supplied
  `expectedWorkflowSha` (the source run's resolved `head_sha` — see below);
  checks cross-checkpoint mutual consistency on `budgetMs`/`maxFrames`/
  `stage`/`runnerOs`/`nodeVersion`/`packageLockHash`; checks no
  `SECONDARY_KNOBS` key is present in `steps` (provable `secondary=false`);
  and checks the finalist and incumbent TRAIN row panels are each a
  complete, duplicate-free `trainSeeds × weapons` rectangle. Reuses
  `RoundCheckpoint`/`ShardMeta`/`RunRow`/`SHARD_SCHEMA_VERSION`/
  `SECONDARY_KNOBS`/`enumerateCombos` unmodified from `round-plan.ts`/
  `aggregate-shards.ts`/`gen-configs.ts` — no new schema introduced.
- **`.github/workflows/ai-sweep-recover.yml`** (new, ~270 lines) —
  standalone `workflow_dispatch`-only workflow, 3 jobs:
  `recover-preflight` (current ref; resolves the source run's exact
  `head_sha` via `gh api repos/.../actions/runs/<id>`, fails closed if
  unresolvable; downloads every `search-checkpoint-r2-*` artifact
  cross-run via `actions/download-artifact@v4` with `run-id:
${{ inputs.source_run_id }}`; runs the new validator against them) →
  `recover-validate` (matrix over SSOT combos, `max-parallel: 8`,
  `fail-fast: false`, checks out the **historical** `ref:
${{ needs.recover-preflight.outputs.head_sha }}`, overrides `env:
GITHUB_SHA` to that same SHA, invokes the unchanged
  `sweep-eval.ts --stage validate`) → `recover-aggregate` (same historical
  checkout + `GITHUB_SHA` override, invokes the unchanged
  `aggregate-shards.ts`). `ai-sweep.yml` itself is untouched.
- **`tests/unit/recover-checkpoint-validate.test.ts`** (new, ~610 lines,
  33 test cases) — pure-function coverage of every fail-closed check
  (missing/duplicate/unexpected combo, filename/round/schemaVersion/
  floorId mismatch, workflowSha-vs-expected mismatch in both the
  single-outlier and all-mutually-consistent-but-wrong-shared-value forms,
  empty `expectedWorkflowSha`, per-field consistency disagreement,
  secondary-knob presence, finalist/incumbent panel completeness, LEGACY
  presence) plus YAML-structure tests parsing the real workflow file
  (mirroring `tests/unit/ai-sweep-workflow.test.ts`'s established pattern)
  asserting `max-parallel: 8`, the `head_sha` resolution step and its use
  as `ref:`/`GITHUB_SHA` in the two downstream jobs, `recover-preflight`
  deliberately NOT pinning its own checkout, `--stage validate` only (no
  round-3/`round-plan.ts --mode plan|select` reference anywhere), and the
  job needs-graph.

## Why SHA-pinning is required (not just re-running validate)

`sweep-eval.ts --stage validate`'s existing, unchanged
`assertSearchArtifactProvenance()` call already fails closed if a loaded
checkpoint's stamped `meta` doesn't match `currentBuildFingerprint()`.
`currentBuildFingerprint().workflowSha` reads `process.env.GITHUB_SHA`
directly — which the Actions runtime sets from the _dispatching_ ref, not
from whatever a later `actions/checkout` step with a custom `ref:` checks
out. So checking out the historical commit alone is necessary but not
sufficient: the workflow also explicitly overrides `env: GITHUB_SHA` on
every step invoking `sweep-eval.ts`/`aggregate-shards.ts` so the _existing_
provenance gate sees the correct historical SHA. The new validator's
`expectedWorkflowSha` check is a cheap, all-8-combos-at-once pre-check in
`recover-preflight` that fails the whole recovery before any expensive
`recover-validate` compute runs, rather than duplicating
`sweep-eval.ts`'s logic.

## Deterministic coverage

- `npx vitest run tests/unit/recover-checkpoint-validate.test.ts` — 33/33
  passing, split across a `validateRecoveredCheckpoints` pure-function
  suite and an `ai-sweep-recover.yml structure` YAML-parsing suite.
- `npm run typecheck` — clean.
- `npm run verify:fast` — clean (typecheck+lint, changed tests, physics/
  size/weight coverage checks).

## Boundaries / explicitly not done

- No modification to `ai-sweep.yml`, `sweep-eval.ts`, `round-plan.ts`,
  `aggregate-shards.ts`, or `gen-configs.ts` — all reused unmodified.
- No new `runInputs`/generic-resume schema, no fresh-combo init, no
  round-3 planning/evaluation/selection, no mixed fresh/resume mode.
- No metadata spoofing — the validator only reads and reports.
- The recovery workflow was **not dispatched** in this session; only
  authored, tested, and merged. Exact dispatch command:

```bash
gh workflow run ai-sweep-recover.yml --ref main \
  -f source_run_id=29786216369 \
  -f train_seeds=1-80 -f validate_seeds=1-100 \
  -f weapons=sword,bow,baseball-bat -f workers=4
```
