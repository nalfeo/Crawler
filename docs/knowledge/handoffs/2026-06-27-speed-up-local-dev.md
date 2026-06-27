# Session Handoff: Speed up local dev (build/test/lint + worktree setup)

## Date

2026-06-27

## Persona(s) adopted

**DevOps Engineer** — all changes live in `scripts/agent/*`, `package.json`, and
agent docs (the routing matrix maps `scripts/agent/*` + CI/tooling to DevOps
Engineer). The task is pure inner-loop/CI throughput work, no game-layer code.

## Routing verdict

✅ Right persona — the work was entirely build/test/tooling throughput, squarely
DevOps Engineer territory; no other layer was touched.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — evidence-gathering + 6 surgical, individually-validated
config/script/doc edits; no architectural change, no new deps.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Goal: cut wall-clock time on the inner dev loop and worktree setup by removing
**duplicated / wasteful work**, without lowering the authoritative quality bar
(CI still enforces everything).

**Measured baselines first (this Windows box):**

| Operation                             | Wall time                              |
| ------------------------------------- | -------------------------------------- |
| `npm test` (all 4 projects incl. e2e) | ~355s                                  |
| unit project, no coverage             | 27.0s                                  |
| unit project, **with v8 coverage**    | 141.9s (**+115s**)                     |
| integration project                   | 69.7s                                  |
| headless project                      | 92.0s                                  |
| typecheck src (warm)                  | 3.4s                                   |
| ESLint warm, all 465 files            | 25.4s                                  |
| ESLint warm, 1–5 files                | ~3–5s                                  |
| vite build                            | 3.5s (already fast — not a bottleneck) |

**Changes shipped (6 files, all validated):**

1. **`scripts/agent/verify-fast.sh` — lint only changed `.ts` files locally.**
   The most frequent command ("after every change"). ESLint hashes all ~465
   files for its cache even when nothing changed (~22s pure overhead). Now: in CI
   (`CI=1`) it lints the whole tree (authoritative); locally it lints only files
   changed vs branch base + working tree (union of `git diff <merge-base>`,
   unstaged, staged, untracked, filtered to `^(src|tests|scripts)/.*\.ts$`), and
   skips lint entirely when nothing changed. **End-to-end run on a config-only
   change set: 8.4s** (was ~30s+). Safe because the ESLint config uses
   typescript-eslint `recommended` (NOT `recommendedTypeChecked`) — no
   type-aware/cross-file rules; `no-restricted-imports` layer rules are per-file;
   CI re-lints the full tree on the PR.

2. **`scripts/agent/verify.sh` — unit coverage is now opt-in (−115s).** v8
   coverage ~5x's the unit-suite wall time and **nothing in `verify.sh` consumes
   the coverage output**. Coverage thresholds are authoritatively enforced in CI
   (`test-unit` job) and `health:check`. Default `verify` runs the unit suite
   without coverage; `VERIFY_COVERAGE=1 npm run verify` (or `npm run
verify:coverage`) restores the local coverage gate. This is the exact "tests
   run multiple times on the same component" waste the task targeted.

3. **`package.json` — added two scripts:** `test:unit` (`vitest run --project
unit`) for the common "just the unit project" case (vs `npm test` which runs
   all 4 projects incl. e2e), and `verify:coverage` (`vitest run --project unit
--coverage`) for a focused local coverage check.

4. **`scripts/agent/preflight.sh` — skip the destructive `npm ci` when
   node_modules already matches the lockfile.** Records `git hash-object
package-lock.json` in a sentinel (`node_modules/.preflight-lock-hash`) after a
   successful install; skips `npm ci` when the sentinel is present and matches.
   `npm ci` wipes node_modules + sentinel on every real run, so a matching
   sentinel proves a completed install for this exact lockfile. Mirrors the
   repo's own CI node_modules cache keyed on `hashFiles('package-lock.json')`.
   Falls back to `sha256sum` if git is unavailable; RUN/SKIP/RUN branch logic
   verified for no-sentinel / matching / stale cases.

5. **`AGENTS.md`** — fixed the command table: `npm test` relabeled "All tests (4
   projects)"; added "Unit tests" → `npm run test:unit`, "Coverage (unit)" →
   `npm run verify:coverage`, "Full verify + coverage" → `VERIFY_COVERAGE=1 npm
run verify`.

6. **`.github/copilot-instructions.md`** — Validation section clarified:
   `verify:fast` lints+tests changed files, `verify` doesn't run coverage by
   default (CI enforces), pointed at `VERIFY_COVERAGE` / `verify:coverage`.

### Net effect on the common loops

- **`verify:fast`** (most frequent): ~30s+ → **~8–15s** (lint scoped to the
  handful of changed files instead of all 465).
- **`verify`** (pre-commit): **−115s** from dropping default coverage.
- **`preflight`** (worktree/session setup): re-runs now skip the multi-minute
  `npm ci` when deps are already current.

## What's Next

CPU-aware follow-ups (the user flagged CPU was very hot mid-session, so heavy
parallel validation runs were intentionally deferred):

1. **Parallelize `verify.sh`'s 3 sequential test projects** (unit 27s +
   integration 70s + headless 92s = 189s → ~92s, bounded by the slowest).
   Designed but **not shipped**: it spawns 3 concurrent vitest worker pools,
   which worsens CPU pressure, and it can't be honestly validated without the
   exact heavy run we were avoiding. Recommended shape: launch the 3 as
   background jobs with separate log files, aggregate exit statuses, and gate
   behind default-on with a `VERIFY_SEQUENTIAL=1` gentle-mode escape hatch.
   Verify there's no shared-cache/coverage-temp-dir collision between concurrent
   `vitest run --project X` processes before enabling by default.
2. **Worktree setup — shared dependency store (pnpm or a shared npm cache).**
   Each worktree currently has its own node_modules. A pnpm content-addressable
   store (or hard-linked shared store) would make new-worktree setup near-instant.
   Strategic, larger-risk — needs its own spike + ADR.
3. **vitest `--changed` base.** `verify-fast` runs `vitest run --changed` which
   only picks up _uncommitted_ changes; committed-but-unpushed branch changes
   don't trigger their related tests locally (caught by full `verify` + CI).
   Intentional (keeps the inner loop fast); revisit only if it bites.
4. **Unify ESLint cache locations.** `verify-fast.sh` uses
   `.cache/eslint/.eslintcache`, `verify.sh` uses `.eslintcache` — two caches
   that don't share warmth. Minor; unify only if measured to help.
5. **Phaser import overhead** (~97s of the full-suite time) — deep/risky; out of
   scope for this pass.

## Blockers

- **CPU contention** from other concurrent sessions (user-reported). Pivoted to
  CPU-light work: read-only investigation + single sequential experiments, no
  parallel subagent swarms, no full heavy test runs. The full `npm run verify`
  end-to-end with the new coverage-opt-out was **not** run start-to-finish (each
  change is individually validated; the combined run is cheap and safe to do once
  CPU frees up).

## Branch State

- Branch: `nalfeo-speed-up-local-dev`
- All tests passing: yes (`verify:fast` green in 8.4s; detection + preflight
  branch-logic tests green; docs gate 0 blocking). Full `verify` not run
  end-to-end (CPU).
- PR created: no — changes are committed-ready in the working tree; user has not
  yet asked to commit/PR.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` absent this session — N/A.

## Test Results

- `bash -n` on all three edited scripts: OK.
- `verify-fast.sh` end-to-end (config-only change set): **8.4s**, ✅ passed
  (skip-lint path + tsc src + `vitest --changed` no-op).
- Changed-`.ts` detection: correctly detected a temp edit to
  `src/shared/random.ts` and reverted clean.
- preflight skip-guard: RUN (no sentinel) / SKIP (matching) / RUN (stale) — all
  correct; test sentinel cleaned up.
- `package.json` parses; `test:unit` + `verify:coverage` present.
- `check-readme-commands.ts`: 28 INFO (pre-existing undocumented scripts), **0
  blocking**; my new scripts are documented.

## Key Decisions Made

- **Coverage opt-out from local `verify` is safe**, not a quality regression:
  nothing local consumes coverage output; CI + `health:check` are the
  authoritative coverage gates.
- **`isolate: false` REJECTED** as too risky: module-level mutable `let`
  singletons in `src/shared/quest-types.ts`, `src/shared/set-piece-types.ts`,
  `src/engine/controls-config.ts` are mutated by tests → cross-file leakage risk.
  Not worth it for the inner-loop gain.
- **Lint-scoping to changed files is safe** given the non-type-aware ESLint
  config + full-tree CI re-lint.
- **preflight `npm ci` skip is safe**: sentinel written only after a successful
  install (`set -e`); `npm ci` wipes it each real run; mirrors CI's lockfile-hash
  cache key.
- **Did not ship test parallelization** because it can't be validated without the
  CPU-heavy run we were asked to avoid, and it worsens CPU pressure — documented
  as a tested follow-up instead.
