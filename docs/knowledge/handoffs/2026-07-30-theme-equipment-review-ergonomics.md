# Session Handoff: Theme-equipment review — warm artifact-read latency fix + durable save-plan to assets/plans

## Date

2026-07-30

## Persona

Producer (tooling)

## Systems touched

sprite-workflow

## Apples

Estimated 3🍎, actual 3🍎. (Tooling-only cap per AGENTS.md; both changes are confined to the theme-equipment review canvas + its CLI/pipeline glue — no runtime gameplay behavior or shipped game data.)

## Summary

One combined 3🍎 tooling PR bundling two independent theme-equipment review improvements:

- **Change A — artifact-read latency fix (perf).** The canvas previously spawned a cold `node` child per image, reloading the whole CLI + Azure SDK on every artifact read (~2.9 s/image, felt like ~10 s under load). Replaced with a **warm in-process `RunStore` artifact reader** that serves reads from a single long-lived store, with the child-process path preserved as a fallback. **Live-proven ~2.9 s → ~92 ms per image.**
- **Change B — durable "save plan to repo".** "Save plan" now publishes the plan JSON to a durable, shared **`assets/plans`** branch via the GitHub Contents API (instead of only writing to the ephemeral workspace branch), so the plan is the common source of truth across sessions/machines. Publisher bootstraps `assets/plans` from the default-branch tip when missing, does a compare-and-swap PUT (carries the remote blob sha), and verifies an ambiguous PUT by re-reading the remote blob before believing a failure.

## Files touched

- `scripts/sprites/theme-equipment-review-cli.ts` — warm artifact reader (`createThemeEquipmentArtifactReader`); durable publisher (`createGhPlanPublisher`, `runGhApi`, `ensurePlansBranch`, `decodeContentsPayload`); `savePlan` durable-publish + rollback path.
- `.github/extensions/theme-equipment-review/renderer.mjs` — save-confirmation render, incl. "(commit pending)" for the ambiguous-verified path. (Client script is ONE template literal — `node --check` after every edit.)
- `.github/extensions/theme-equipment-review/lib/bridge.mjs` — dispatch half of Change B (default-branch dispatch pinned to an immutable `plan_ref=<sha>`).
- `tests/unit/sprites/theme-equipment-review-cli.test.ts` — warm-reader tests + new direct `createGhPlanPublisher` unit tests (injected `gh` runner).
- `tests/unit/sprites/theme-set-index.test.ts` — hermetic save-plan + durable-publish tests (mock publisher).
- `docs/knowledge/review-ledgers/2026-07-30-durable-save-plan-assets-branch.review-ledger.json` — 3🍎 ledger (plan_review + code_review, both valid).

## Design notes / decisions

- **Publish budget is anchored at module load** (`PROCESS_START_MS`, ≈ process spawn), not at publisher entry, so upstream `savePlan` store probes count against the same budget the bridge's 120 s command timeout kills on. The publisher always yields ≥30 s before the kill to verify or roll back — never stranded mid-PUT.
- **Verify-budget reserve:** the PUT deadline holds back `PUBLISH_VERIFY_RESERVE_MS` (10 s) so the post-PUT verify GET always has budget. Prevents a PUT that consumes all remaining time from causing a false-failure rollback while the remote copy may actually be published.
- **Ambiguous-verified path returns `commit: ''`** (a Contents GET has no commit sha) → canvas renders "(commit pending)".
- **Immutable dispatch pin:** `assertPlanOnRef` returns the fetched commit SHA and dispatch pins that SHA, not the branch name (closes a plan_ref TOCTOU raised in plan review).
- **Rollback is a best-effort content guard** (`rollbackIfUnchanged`), not a synchronized/atomic op; the TOCTOU window is negligible for a single-maintainer dev tool and the doc comment says so. Full atomicity is explicitly out of scope.

## Known limitation (user-approved, do NOT restate as fixed)

**Concern 2 from plan review — save/init cross-store race — is a bounded, documented limitation, NOT true cross-store atomicity.** The durable plan lives in git; the review state lives in the RunStore. Full atomicity would need a shared CAS reservation protocol the maintainer did not request. Instead: the false immutability claim was dropped, **init is documented as the authoritative consumer**, and the source plan commit is recorded in state for detectability. A concurrent save + init of a brand-new set can **drop a save** but **never corrupts** state. Documented in a `savePlan` code comment.

## Verification run

- `node --check .github/extensions/theme-equipment-review/renderer.mjs` → EXIT 0.
- `npm run typecheck` → EXIT 0.
- `npx vitest run --project sprites theme-equipment-review-cli` → 17 passed (incl. 6 new publisher tests). NOTE: `tests/unit/sprites/**` is excluded from the `unit` vitest project — must use `--project sprites`.

## Follow-up: graceful degradation on transient publish failure (same branch, later commits)

Dogfooding the durable "Save plan" flow hit the exact clunk the design left open: a
**transient GitHub rate-limit** rolled back the local write and threw a
data-loss-looking error. Fixed on this branch (UX hardening, still 3🍎):

- On a **retryable** publish failure (rate-limit / 5xx / recognized transport fault
  / our own deadline) the authored plan is **kept locally** and the canvas shows an
  honest **"pending — retry"** affordance; only **definitive** faults (auth, bad
  args, missing `gh`, validation) roll back.
- Retry re-saves with the maintainer's own overwrite choice (never a silent
  force-overwrite); a byte-identical remote copy is idempotent success, so retrying
  a partially-landed publish can't clobber a different maintainer's plan.
- `runGhApi` failures carry a `transient` flag; the null-status decision is an
  exported pure helper `classifyGhFailureTransient`, unit-tested with raw Windows
  `gh` stderr (`proxyconnect tcp` / `connectex` / `actively refused` / `no such
host` / `dial tcp`) so a real network blip on **Windows** is kept pending, not
  rolled back.

Code-review loop converged clean over rounds 2→4 (see the review ledger). 30 CLI
sprites tests + `verify:fast` green.

**E2E cloth publish (deferred, not a code blocker):** authoring a **Classic Fantasy
[Basic Cloth]** set E2E through the canvas is blocked only on a user-wide GitHub
rate limit for user 14006787 (both tokens map to it; `gh api rate_limit` shows
misleadingly-high `core.remaining` but every real call 403s). The validated 21-item
roster is preserved in `files/cloth-plan.json`; no authored work is lost. Resume by
retrying **Save plan** in the canvas once the limit resets, then `init` → roster
review (`approve_remaining` + `review_collection` + `advance_phase`) → dispatch
`run-phase` for briefs.

- `npm run verify:fast` → passed (rerun clean after `sync:main --reason pre-publish` rebased onto origin/main).
- `npm run review:ledger -- validate <path>` → valid 3-apple ledger.
- `npm run verify:pr-prereqs` → ledger ✅; handoff + guard-telemetry now added.

### Observe-before-done (honest note)

- **Change A** live-proven in the running canvas: cold-child ~2.9 s/image → warm-reader ~92 ms/image.
- **Change B** — the publisher's **read + failure paths were live-validated** against `nalfeo/Crawler`'s `assets/plans` branch (branch probe OK; ambiguous-verify → GET semantics correct; write-failure → clean throw, no corruption, no leaked blob). The **successful-write happy path could NOT be live-observed this session** because the only working credential in-env (`nalfeo_microsoft`) is pull-only on `nalfeo/Crawler` (Contents PUT with no write access returns 404, which GitHub uses to mask no-write). That path is covered by the new direct publisher unit tests. This is a session-credential limitation, not a code gap.

## Review harness (3🍎)

- **Plan review** (separate model, gpt-5.6-sol / rubber-duck): `plan_divergence: major_fork`, 3 blocking concerns, all dispositioned (1 + 3 fixed in code; 2 scoped as the documented limitation above).
- **Code review** (gpt-5.6-sol, round 1): no blockers, 3 Medium findings, all resolved (deadline anchoring, verify-budget reserve + commit-pending render, rollback TOCTOU honesty) + added the direct publisher unit test to close the reviewer's coverage gap.
- Multi-model review not required at 3🍎.

## Environment quirks reconfirmed (save the next session hours)

- `renderer.mjs`'s client script is ONE template literal — a backtick **anywhere** (even a comment) is a syntax error. Run `node --check` after every edit.
- `tests/unit/sprites/**` is EXCLUDED from the `unit` vitest project — run `npx vitest run --project sprites <filter>`. `--project unit` says "No test files found".
- `.env.local` is NOT auto-loaded by a bare `npx tsx scripts/sprites/*-cli.ts`; `SPRITES_RUN_STORE` defaults to `local`, so a real set reads as "not found". Parse `.env.local` into `process.env` before `createRunStore` in ad-hoc scripts.
- PowerShell has no heredoc: commit messages via `git commit -F <file>`; ledger JSON via `node scripts/agent/review/cli.mjs stage <path> <stage> --json $var` (NOT `npm run review:ledger -- --json '{...}'`, which mangles JSON through npm).
- `saveThemeEquipmentSetState` does NOT bump `stateRevision` — the mutation helpers do.
- Do NOT touch branch `nalfeo-theme-set-index` (had PR #2119 armed for auto-merge at session start).

## Unresolved / next steps

- None blocking. PR is ready-for-review (not draft). Successful-write publisher path remains unit-covered only until a push-capable credential can live-exercise it — a future maintainer with write on `nalfeo/Crawler` can confirm in one save.
