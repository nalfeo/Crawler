# Handoff — Sprite queue reconciler (PR2 of durable sprite-edit persistence)

**Date:** 2026-07-24
**Session slug:** sprite-queue-reconciler-pr2
**Persona:** DevOps Engineer
**Apples:** 3🍎 estimated / 3🍎 actual (tooling cap — CI automation + asset-pipeline scripts + ADR; no `src/core|engine|game` runtime or shipped game-data change)
**Systems touched:** sprite-pipeline, sprite-workflow

## Summary

PR2 closes the gap left by PR1 (#1872 + #1891): queued sprite edits were durable
on the long-lived `assets/queue` git branch but never reached `main` / the shipped
game. This PR adds the **automated hourly reconciler** that lands `assets/queue`'s
art surface into `main` on a cadence.

**The design is NOT the literal task spec.** A separate-model plan review (gpt-5.4)
rejected direct `assets/queue → main` auto-merge as a trust-boundary TOCTOU: because
`assets/queue` takes every editor save, its head drifts during any auto-merge window,
so arm-time-only validation on that high-churn ref is unsafe (a later untrusted push
could ride the armed merge). The creating session approved **architecture A**:

> Each cycle, in a throwaway worktree checked out at **current `origin/main`**,
> overlay ONLY the art surface from `assets/queue` tip, commit, and force-update a
> **sole-writer, bot-owned `assets/promote`** branch to that commit. PR `assets/promote
> → main` and arm `--auto --squash`. By construction `git diff main..promote` can only
> touch the art surface; the trust guard runs on that staged diff as defense-in-depth.

This enforces trust on the **actual diff content** the reconciler produces (structural
+ guard), not on any mutable head or author identity. `assets/queue` is **never reset**
(resetting it to main would drop edits that landed after the snapshot — the exact
data-loss failure we are eliminating); harvest-onto-main makes reset unnecessary — the
delta goes to zero and the reconciler no-ops once editing stops.

## Files touched

**New:**
- `scripts/sprites/reconcile-queue.ts` — IO-free dep-injected core (mirrors the
  `queue-commit.ts`/`-runtime.ts`/`-cli.ts` split). Exports `runReconcile`,
  `ReconcileError`, result/opts/deps types, `isArtSurfacePath`, `assertArtSurfaceOnly`,
  `assertArtSurfaceModes`.
- `scripts/sprites/reconcile-queue-runtime.ts` — `createDefaultReconcileDeps(repoRoot)`
  real exec/gh/lock/now wiring (reuses `makeCheckinFileLock`).
- `scripts/sprites/reconcile-queue-cli.ts` — thin CLI; exit codes 0 (ok/noop),
  10 (lock-held), 30 (untrusted-diff → escalate), 1 (other).
- `tests/unit/sprites/reconcile-queue.test.ts` — real-git (temp bare origin + clone) +
  FakeGh hard-gate tests.
- `tests/unit/sprites/reconcile-queue-cli.test.ts` — parseArgs tests.
- `.github/workflows/sprite-queue-reconciler.yml` — hourly `cron '0 * * * *'` +
  `workflow_dispatch`; single `concurrency:` lane; `CRAWLER_CI_PAT` auth via
  `gh auth setup-git`; exit-30 opens an escalation issue.
- `docs/knowledge/adr/2026-07-24-sprite-queue-reconciler.md` — ADR for the reconciler
  as the new acceptance path; documents the promote-branch trust boundary and why
  direct `assets/queue → main` auto-merge was rejected (head-drift TOCTOU).
- `docs/knowledge/review-ledgers/2026-07-24-sprite-queue-reconciler-pr2.review-ledger.json`

**Modified:**
- `docs/knowledge/adr/0066-sidecar-owned-sprite-acceptance.md` — supersession note
  (the reconciler supersedes the approve → `sprites:checkin` → `sprites:asset-pr` union
  acceptance flow; old union flow retirement is PR3, not this PR — cross-linked).
- `package.json` — added `"sprites:reconcile-queue"` script.

## Reconciler cycle (documented ordering)

Under `makeCheckinFileLock(repoRoot)`:
1. `git ls-remote --heads origin assets/queue` cold-start probe → absent ⇒ `noop`.
2. `git fetch --no-tags origin assets/queue main` (+ `assets/promote` if present).
3. **Two-dot** art-surface delta `git diff --name-only origin/main origin/assets/queue --
   <ASSET_SURFACE_PATHS>`. Empty ⇒ `noop` (steady state after a promote PR merges).
   Two-dot is required — three-dot shows already-squash-merged art forever (pre-squash
   merge-base) and would reopen the PR indefinitely.
4. Throwaway detached worktree at `origin/main`; `git checkout <queueRef> --
   <ASSET_SURFACE_PATHS>`; `git add`; re-check `--cached --quiet` (nothing staged ⇒ noop).
5. **Guard (name-only)** `assertArtSurfaceOnly` — every staged path ∈ allowlist.
   **5b. Guard (mode-aware)** `assertArtSurfaceModes` — parses `git diff --cached --raw`;
   rejects any dst mode ∉ {`100644` regular, `000000` deletion} (blocks symlink/gitlink/
   exec type-changes at an allowlisted path). Any violation ⇒ throw `untrusted-diff`
   (exit 30), do NOT push/arm, escalate.
6. Commit `--no-verify` (injected `now` in message); force-update sole-writer
   `assets/promote` (`--force-with-lease`).
7. `findOpenPromotePr` (JSON, filters `isCrossRepository !== true && headRefName ===
   promoteBranch`) → create ONE PR (idempotent re-query on create race) or edit existing.
8. Arm `gh pr merge <n> --auto --squash --match-head-commit <promoteCommit>`.

## Trust boundary (highest-risk area — reviewed hardest)

- **Sole-writer promote branch** built on current `main` is the primary guarantee:
  `main..promote` is art-surface-only *by construction*, and only the reconciler (single
  concurrency lane) ever writes it. An untrusted push to `assets/queue` can never ride an
  armed merge — it is re-guarded next cycle.
- **Defense-in-depth guard** runs on the actual staged diff: path allowlist
  (`public/assets/generated/**` + `src/shared/data/sprite-catalog.json`) AND dst-mode
  allowlist. Refuse + escalate on any violation.
- **Fork-PR hijack** closed: `findOpenPromotePr` ignores cross-repo PRs and any head other
  than `assets/promote`.
- **Arm-time drift** closed: `--match-head-commit` pins the exact promote commit.
- **action_required stall avoided:** `CRAWLER_CI_PAT` is a classic user PAT (human
  identity), not a GitHub App token, so its pushes do not park the promote-PR CI in
  `action_required`. Workflow uses `persist-credentials:false` + `gh auth setup-git`,
  modeled on `ci-recovery.yml` / `merge-train.yml`.

## Scoped CI-bypass (reuse, not blanket)

The promote→main diff is art-surface-only by construction, so `detect-art-only.sh`
(`npm run scope`) classifies it `art_only=true` and the existing `ci.yml` impact-flag
gating auto-skips the heavy gameplay gates. No new/blanket skip was added.

## Verification run

- `npx vitest run --project sprites tests/unit/sprites/reconcile-queue.test.ts
  tests/unit/sprites/reconcile-queue-cli.test.ts` → **30 passed**.
  - Hard gate proven: (a) no-op when queue==main / no art delta; (b) opens exactly ONE
    PR and does not open a second on re-run; (c) guard REJECTS a non-art-surface path
    AND non-regular-file mode changes; (d) promote is force-updated to a commit built on
    main's tip; (e) lock/retry + worktree cleanup on throw.
- `npm run verify:fast` → green.
- `npm run review:ledger -- validate <ledger>` → valid 3-apple ledger.
- Determinism: no `Date.now()`/`Math.random()` in core — `now` injected; gh/network
  mocked via injected exec.

## Observe-before-done

This is CI-automation/tooling with **no `src/core|engine|game` runtime or shipped
game-data change** (tooling cap). There is no in-game visual/runtime behavior to observe;
the deterministic real-git + FakeGh hard-gate tests are the artifact of record and
reproduce the reconciler's real git/gh control flow end-to-end.

## Unresolved / follow-ups

- **PR3** (out of scope here): retire `sprites:asset-pr` union + the `asset-checkin`
  issue flow + consumer updates; optional tidy-reset of `assets/queue` to `main + its own
  art surface` (race-prone vs concurrent editor pushes — deferred).
- Native-resolution sprite assets, Finding-5 manifest RMW locking, un-approved
  run-tuning durability — all separate tasks.
- **Recommended:** add a branch ruleset requiring the art-surface guard as a merge-time
  check on the promote PR (defense-in-depth). Not blocking — the sole-writer promote
  branch is the primary guarantee, and branch-protection config may not be settable here.

## Review harness

- **plan_review** (gpt-5.4, high): REJECTED literal spec, red-teamed → architecture A.
  `plan_divergence: major_fork` recorded honestly.
- **code_review** loop (gpt-5.4): round 1 = 5 concerns (1 Critical fork-PR hijack, 2 High
  arm-drift + dir-prefix guard hole, 1 Medium vacuous test) all resolved; round 2 =
  1 High (symlink/mode type-change guard hole) resolved → clean.
