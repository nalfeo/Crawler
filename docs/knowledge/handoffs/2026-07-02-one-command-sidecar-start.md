# Session Handoff: One-command sprite sidecar start

## Date

2026-07-02

## Persona(s) adopted

**DevOps Engineer** — the request was pure developer-experience / tooling work:
make `npm run sprites:gallery` a fast, reliable one-command start on a fresh
worktree. It touches launch orchestration, npm scripts, an env-bootstrap helper,
and policy docs — squarely DevOps/tooling, not a gameplay-layer change.

## Routing verdict

✅ right persona — the change is launcher/CLI orchestration + npm scripts + docs,
which is exactly the DevOps lane. No ECS/game-logic involvement.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — a pure/testable predicate + orchestrator, launcher wiring, two
npm scripts, a hardened shared cred check, unit tests, and a policy reword. The
plan review + poison-safe runtime validation added rigor but no extra
implementation surface; landed right at the 2🍎 estimate.

Hello kitties: 2/5 = 0.40 🎀 (canonical `actual_apples / 5`)

## Systems touched

sprite-workflow

## Review Harness

2🍎 tier → **plan review** (>1🍎) + **code-review loop** (all). Multi-model NOT
required.

- **Plan review** (reviewer `gpt-5.4`, rubber-duck): round 1 REJECTED (6
  concerns) → addressed via a tiered predicate grounded in the verified worker
  start path + absent-file-only safe bootstrap; round 2 approved_with_changes (2
  concerns: Foundry provider path, whitespace storage creds) → both folded in.
- **Code review** (reviewer `claude-sonnet-4.6`): round 1 **clean, 0 concerns** —
  verified all six design invariants against the actual code (hot-path free,
  never clobber, never silently fall back, cloud/CI guard, tiered predicate
  mirrors runtime, no stale reload shadow, Windows `pwsh` args).
- Ledger: `docs/knowledge/review-ledgers/2026-07-02-one-command-sidecar-start.review-ledger.json`
  — `npm run review:ledger -- validate` → ✅ valid 2-apple ledger.

## What Was Done

Made `npm run sprites:gallery` a true one-command, sub-minute start on a fresh
worktree, respecting the Azure-required policy (never silently falls back to
local/noop).

### Root causes fixed

1. The Azure policy told operators to run `npm run setup:azure` first — that is
   `setup-azure-env.ps1 -ProvisionResources -IncludeStorage`, which ALWAYS runs
   full resource provisioning/existence checks (~228s) even when everything
   already exists.
2. A fast path existed (`setup-azure-env.ps1 -IncludeStorage`, env-only, ~18s,
   identical `.env.local`) but had **no npm alias**, so nobody used it.
3. The launcher only `loadEnvLocal()`d; it never bootstrapped `.env.local`. On a
   fresh worktree the sidecar failed fast with "Azure credentials missing", so
   the operator had to know to run setup manually — not one command.

### Changes

- **`package.json`** — added `setup:azure:env` (`pwsh scripts/setup-azure-env.ps1
-IncludeStorage`, fast env-only) and `setup:azure:env:force` (`+ -Force`).
  Kept `setup:azure` (full provisioning) for first-time/changed resources.
- **`scripts/sprites/sidecar/env-bootstrap.ts`** (new) — pure, tiered predicate
  `needsAzureEnvBootstrap(env)` mirroring `resolveSidecarBackends` defaulting,
  plus `hasAzureOpenAiCreds` / `imageProviderIsAzureOpenAi` / `isCloudEnv` /
  `missingAzureRequirements`, and the orchestrator `ensureAzureEnvLocal(...)`
  with injected `spawn`/`reload`/`fileExists` for testability. Auto-writes ONLY
  when `.env.local` is ABSENT (no `-Force`), errors (never clobbers) on an
  existing-but-incomplete file, throws a cloud-specific error under CI/Codespaces
  without running the ps1, and never falls back to local/noop.
- **`scripts/sprites/sidecar/backend-config.ts`** — hardened `hasAzureStorageCreds`
  to be trim-aware (whitespace-only values are not treated as present), keeping
  the predicate and runtime backend resolution aligned.
- **`scripts/sprites/sidecar/launcher.ts`** — after `loadEnvLocal(REPO_ROOT)`,
  calls `ensureAzureEnvLocal({ repoRoot: REPO_ROOT })` in a try/catch → prints
  the error and `process.exit(1)` on failure. Runs before spawning the sidecar +
  vite children.
- **`AGENTS.md`** (Azure-required sidecar policy) — reworded: fresh worktree just
  runs `npm run sprites:gallery` (auto-bootstrap); routine refresh uses the fast
  `setup:azure:env`; `setup:azure:env:force` regenerates; `setup:azure` reserved
  for first-time/changed provisioning. Notes the fail-fast + never-clobber
  behavior and the `SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop` opt-in.
- **Tests** — new `tests/unit/sprites/sidecar-env-bootstrap.test.ts` (full
  predicate truth table + orchestrator paths via injected deps); extended
  `tests/unit/sprites/sidecar-backends.test.ts` with whitespace-only
  `hasAzureStorageCreds` cases.

## Validation (observe before done)

Ran the real one-command start on a simulated fresh worktree (`.env.local`
removed), polling `GET http://127.0.0.1:22170/api/health` (this session's
deterministic port; parent's sidecar is on 11610 — no conflict):

- **Before:** operators had to run `npm run setup:azure` first ≈ **228s** of
  provisioning before the sidecar could even start.
- **After:** `npm run sprites:gallery` alone → env bootstrap message at **3.0s**,
  **healthy at 43.2s** with `storeBackend=azure-blob`, `queueBackend=azure-queue`,
  `worker.running=true`, `issueIngester.running=true`.

### Poison-queue safety

The parent flagged that the live `asset-requests` queue holds 26 known-poison
messages (Bug B, being fixed by a sibling session) and the worker never acks on
failure. Verified from source that a graceful `/stop` is UNSAFE (the worker's
`while(!signal?.aborted)` only checks abort at the loop top, so a dequeued
message runs to completion — ~3 min through image gen — before re-checking, and
the "⚠️ failed" GitHub comment is posted only after that). The worker auto-starts
AFTER `app.listen()`, so `running=true` is health-detectable within <1s of the
worker starting. **Decision: hard-kill within ~1s** — strictly safer than a
graceful stop; it lands before image gen. Result: `workerProcessed=0`,
`workerFailed=0`, `issueIngesterEnqueued=0` — **zero poison processed, zero
failed comments, zero API burn.** Un-acked messages return to the queue via the
existing visibility timeout (at-least-once; no new harm). Port freed on kill.

## What's Next

- Nothing required for this change. The one-command start is proven end-to-end.
- Optional future polish: a `--force-refresh` flag on `sprites:gallery` that maps
  to `setup:azure:env:force` for the rare stale-`.env.local` case (today the
  operator runs the script directly, which the error message points to).

## Blockers

None.

## Branch State

- Branch: `nalfeo-one-command-sidecar-start`.
- All tests passing: yes — full substantive chain green (typecheck, lint,
  format, guards 212, unit 2859, integration 49, headless 17, build) and
  `npm run verify` (incl. `verify:pr-prereqs` + `docs:check`).
- PR: opened for this change (title/description synthesize the whole branch).

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist for this session — no telemetry
section to paste.

## Test Results

- `npm run verify:fast` → ✅ during development.
- Full substantive chain → ✅ typecheck, lint, format:check, guards (212/212),
  unit (2859/2859), integration (49 pass / 1 skip), headless (17/17), build.
- `npm run verify` → ✅ (includes `verify:pr-prereqs` + `docs:check`).
- `scripts/agent/lab-gate-check.sh` → ✅.
- Runtime one-command validation → ✅ healthy at 43.2s on Azure backends, zero
  poison processed.

## Key Decisions Made

- **Bootstrap only when `.env.local` is ABSENT; never `-Force` from the
  launcher.** Auto-overwriting a user's existing (possibly hand-edited) file is
  destructive; an existing-but-incomplete file yields an actionable error
  pointing at `setup:azure:env:force`. This also eliminates any stale-reload
  shadow (the pre-bootstrap `loadEnvLocal` found nothing to shadow).
- **Tiered predicate grounded in the verified worker start path**, not a blanket
  "all keys or bust". Storage creds gated on any Azure store/queue; OpenAI creds
  gated on `azure-queue` + the azure-openai image provider (the only hard-required
  provider at worker start; synth is try/caught). `SPRITES_PROVIDER=foundry` skips
  the OpenAI requirement (it uses `FOUNDRY_*`, which the bootstrap ps1 can't
  write). Fully-local opt-in (`local`+`noop`) short-circuits to skip.
- **Hard-kill over graceful stop for validation** — see poison-safety above.
- **Hardened the shared `hasAzureStorageCreds` rather than only the new
  predicate**, so the launch-time bootstrap decision and `resolveSidecarBackends`
  runtime can never disagree on whitespace-only creds.

## Retrospective

### Lessons Learned

- **A "one command" claim has to include the cold-start cred bootstrap.** The
  gallery was one command only on a warm worktree; the real fresh-worktree cost
  was the hidden manual `setup:azure`. The fix is to make the launcher own the
  fast bootstrap, not to document a second manual step.
- **The graceful-stop endpoint is not poison-safe.** Reading `worker.ts` showed
  the abort is only observed at the loop top, so `/stop` lets an in-flight poison
  job finish (burning API + posting a failed comment). For a bounded health
  snapshot, hard-killing within ~1s of `running=true` is the safe path.
- **`noUncheckedIndexedAccess` bites vi mock destructuring.** `mock.calls[0]` is
  `T | undefined`; the new test needed a narrowing guard (not a non-null
  assertion) and explicit param types on the `spawn` mock.
- **`path.join` yields backslashes on Windows** — test expectations must be built
  with `path.join`, not forward-slash string literals.

### Mistakes Made

- Initial test file tripped typecheck twice (untyped `spawn` mock params, then an
  unguarded `mock.calls[0]` destructure) and once on Prettier formatting. Signal:
  run `verify:fast` (typecheck + lint + changed tests) on a new test file before
  assuming it is green; formatting-sensitive multi-line arrow mocks especially.

### Opportunities for Future Improvement

- **Promote the one-command start into a headless smoke check.** The validation
  orchestrator (launch → poll `/api/health` → assert Azure backends + running →
  hard-kill) could become a deterministic, opt-in tooling test so this never
  silently regresses — mirroring the "promote a recurring class into a
  deterministic check" rule.
- **Consider a `setup:azure:env` fast path that also refreshes an existing file**
  in place when explicitly requested, so the force case doesn't require the raw
  ps1.
