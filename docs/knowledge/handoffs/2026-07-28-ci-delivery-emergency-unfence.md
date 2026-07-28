# Emergency CI delivery fix — make conflict serialization opt-in

**Date:** 2026-07-28
**Apples:** 5🍎 estimated / 5🍎 actual (scope narrowed mid-session; see "What changed and why not more")
**Branch:** `ci-delivery-emergency-fix`

## Systems touched

ci-policy

## Problem

Delivery was deadlocked repo-wide. **18 open PRs** were serialized in a single
CI conflict-coordination group, some waiting up to **64 hours**, while `main`
itself was red and the fix for `main` was trapped inside the fenced group.

The coordinator was not broken — it was running every ~3 minutes and correctly
enforcing a mutex. The problem was that the mutex's head-of-line PR could never
move, and the group it was serializing was mostly **false positives**.

### Root cause: branch contamination

Agent branches routinely carry other sessions' commits. Squash-merge relands
those commits under new SHAs, so git cannot dedupe them. The result is that
art and docs PRs carry genuine-looking diffs to `.github/scripts/ci-*/`, which
is exactly what the coordinator's filename-overlap test keys on.

Measured, not assumed:

- Sprite PR #2098 and docs PR #2092 each carried **6 CI files**, including
  `ci-recovery/reconcile.mjs`.
- **8 of 11** PRs touching `reconcile.mjs` were contaminated.
- Group leader #1976 was **28 of 30** subject-matched duplicates. `git cherry`
  showed **45 of its 48 commits patch-identical to `main`**.

The CI-only coordination scoping (`isCiCoordinationPath`, `state.mjs:43-46`)
**did** land and works correctly. Contamination defeats it by making the
predicate true for PRs that change nothing in CI.

### Contamination also silently reverts merged work

Art PR #2137 **deleted 15 lines from `.github/scripts/sweep-budget.mjs`**,
reverting production CI code that #2141 had added 11 minutes earlier. This is
not only a false-coordination problem; it is a correctness problem on `main`.

## What shipped

Serialization is now gated behind `CI_CONFLICT_COORDINATION_ENFORCE`,
**default off**. Discovery, grouping, and the `ci-conflict-coordinated`
reporting label keep working, so the group stays observable and reportable —
only the blocking fence is disabled.

- **`ci-conflict-coordinator/state.mjs`** — `coordinationEnforcementEnabled()`.
  Fail-open: returns true only for a trimmed exact `'1'`, so a typo
  (`'true'`, `'yes'`, `'enabled'`) leaves delivery flowing rather than
  re-fencing the repo.
- **`ci-conflict-coordinator/reconcile.mjs`** — when disabled, actively
  **removes** `ci-conflict-order-wait` instead of applying it, which drains
  labels stranded by previous enforcing runs with no manual cleanup pass.
- **`merge-train/reconcile.mjs`** — `verifyMergeSlot` is supplied as the
  coordinator callback **only** when enforcement is on; otherwise
  `promoteExactBatch`'s permissive `async () => null` default applies.
- Both workflows thread the repo variable through; the knob is documented in
  `docs/agent-os/policies/ci-config-knobs.md`.

### Why the diff is small (verified, not assumed)

R07 `SKIP_CI_CONFLICT_ORDER_WAIT`'s guard is purely **label-driven** —
`ctx.hasCiConflictOrderWait` derives from `shouldWaitForCiConflictOrder(pr.labels)`
(`ci-recovery/reconcile.mjs:1407`, `dispatch-table.mjs:226`). Gating label
_application_ therefore disarms R07 automatically, so **no dispatch-table change
was needed**. Every other consumer is likewise label-driven
(`merge-train/reconcile-lib.mjs:460`, `merge-train/state.mjs:94`,
`ci-recovery/reconcile.mjs:1394`). The **only** label-independent enforcement
site is `verifyMergeSlot`, which recomputes coordinator ordering live — that is
the one thing that also had to be gated.

## Observe before done

- **Before:** 18 PRs carrying `ci-conflict-order-wait`, head-of-line blocked,
  `main` red, and a `--admin` merge (PR #2131, `0857cc2c6`) was the only way to
  land anything. That PR was deliberately routed through
  `.github/scripts/sweep-budget.test.mjs` because it sits directly in
  `.github/scripts/` (not `ci-*/`) and is therefore exempt from coordination.
- **Mitigation already applied:** local `git rebase --empty=drop` +
  `--force-with-lease` on 10 PRs took the group **18 → 13**. `#1976`'s CI
  footprint went **20 files → 0**. Prior SHAs are recorded in
  `files/pre-rebase-shas.json` for rollback.
- **After merge, verify in production:** the remaining fenced PRs must shed
  `ci-conflict-order-wait` on the next coordinator pass (~3 min).

## Review

Adversarial plan review (gpt-5.6-sol) **rejected** the original 3-part plan and
forced a `major_fork`. Its blocking claims were independently verified in code
rather than accepted:

- **F1 (confirmed, and the real latent trap):** `promotePrefix` returns
  `{promoted:false}` whenever `mainHealthAllowsPromotion()` fails
  (`merge-train/reconcile.mjs:780`, re-attest `:819`, third re-check
  `reconcile-lib.mjs:651-658`). **While `main` is red, the train cannot land the
  PR that fixes `main`.** The original plan never addressed this.
- **F3 (confirmed):** unfencing via R07 alone is insufficient — hence the
  `verifyMergeSlot` gate.
- **F2 (partly incorrect):** in-place splice _does_ preserve prefix candidates
  built before the ejection index. The invariant-sensitivity argument stands
  regardless.

Multi-model code review (gpt-5.6-terra + claude-opus-4.8) **disagreed** on the
one High finding, adjudicated in code:

- opus-4.8 is right that human-approval protection is **not permanently lost** —
  it is independently enforced at `ci-recovery/reconcile.mjs:1171` with no
  coordinator dependency.
- terra is right that it is **not transactional** — between the coordinator pass
  and the next ci-recovery pass, an already-armed auto-merge can fire.
- Resolution: keep terra's fix. Ownership-gated PRs (ownership error, shepherd
  lease, human-approval-required) still get auto-merge disarmed even with the
  fence off. It is strictly safer and **cannot loop**, because ci-recovery only
  arms when a PR is clean and not human-gated, so it will never re-arm against
  the disarm.

## Tests

- 3 kill-switch unit tests (default-off incl. `null`/`undefined`; exact `'1'`
  incl. `' 1 '`; fail-open rejection of `'true'/'yes'/'on'/'0'/'2'/'01'`).
- 2 coordinator integration tests: default-off behaviour, and the ownership
  carve-out. The carve-out test is **mutation-verified** — deleting
  `if (ownershipGated) await disableAutoMerge(pull);` makes it fail.
- 3 merge-train source-topology assertions covering the gate wiring **and its
  polarity** (an inverted gate is caught). `merge-train/reconcile.mjs` performs
  live GitHub I/O on import, so it cannot be unit-tested directly; the repo
  already uses this pattern.
- The pre-existing drift/fencing characterization test is pinned to
  `CI_CONFLICT_COORDINATION_ENFORCE: '1'` so it still covers enforcing mode.

Results: coordinator + merge-train `node --test` **280 pass / 0 fail**;
`npm run test:guards` **1893 pass / 0 fail**; `verify:fast` pass.

## What changed and why not more

The user's target architecture was three parts (proactive rebase → green PRs
reach the train → train ejects conflicting payloads one-by-one). Live state at
implementation time was decisive and re-scoped the work to part 3 only:

- `main` was **green** (6 consecutive successes) → the red-main trap was not
  currently firing.
- The merge train was **empty (0 queued)** → an ejection loop had nothing to
  eject.
- **12 PRs were still fenced** → the fence was the only live blocker.

Deferred deliberately, each with a reason:

- **Ejection loop** — the most invariant-sensitive change, and irrelevant while
  the train is empty. Patch parked at `files/ejection-loop.parked.patch`.
  Known trap for whoever picks it up: `promotePrefix`
  (`merge-train/reconcile.mjs:781`) and `buildEntry` (`:699`) both
  `train.slice(...)` directly, so **in-place splice is required** to keep one
  source of truth.
- **Proactive rebase / rebase-in-fixer** — folding a rebase into the fixer
  dispatch uses **stale head evidence**; the existing two-phase trusted-rebase
  dispatch is the correct shape.
- **#2108 absorption** — explicitly rejected. Mixing unrelated repair-window
  rotation into a control-plane change worsens attribution and rollback. Stack
  it after this merges.

## Follow-ups

1. **Red-main repair lane (F1)** — the highest-value follow-up. Today a red
   `main` blocks the train from landing the fix for `main`, which is what forced
   the `--admin` escape hatch.
2. **Leader selection ignores mergeability** (`state.mjs:254`, leader is
   `ordered[0]` with no mergeability filter) — a `CONFLICTING` PR can hold
   head-of-line forever. This is a large part of why the group never drained.
3. **Open-PR aging panel** in `scripts/agent/velocity/bottleneck-scan.ts`. It
   measures only _merged_ PRs, so survivorship bias hid this entire 64-hour
   stall. This is the instrumentation gap that let the deadlock run unnoticed.
4. `CI_COORD_DECISION` structured logging, mirroring #2129's
   `CI_RECOVERY_DECISION`.
5. Retry #2114's push (blocked by a pre-push Prettier hook) and resolve the 7
   genuinely-conflicting PRs.
6. Re-evaluate whether the coordinator's original justification survives once
   contamination is gone. Note the semantic-contradiction gap it can _never_
   catch: #2123 and #2146 were opposite answers to the same question on
   **disjoint files**. A correctly rebuilt maximal train candidate _would_ catch
   that, since validation runs the full unit suite in 3 shards
   (`merge-train-validate.yml:78-109`) — which is an argument for investing in
   the train rather than in filename fencing.

## Gotchas for the next agent

- **`gh pr update-branch --rebase` is unusable for contaminated branches** — it
  replays duplicate commits instead of dropping them. Use local
  `git rebase --empty=drop` + `--force-with-lease`.
- **"Auto-merge armed" is not durable.** At least three systems disarm it.
  Always read back `autoMergeRequest` rather than trusting the command's exit.
- **PowerShell eats backticks** (its escape character) even inside single-quoted
  strings joined via `Add-Content`, silently corrupting JS template literals into
  `SyntaxError`. Always `node --check` after writing code from PowerShell.
- **`node --test <directory>` fails** with MODULE_NOT_FOUND; use a glob, e.g.
  `node --test ".github/scripts/ci-conflict-coordinator/*.test.mjs"`.
- **`verify:fast` only runs _changed_ unit tests**, so repo-wide structural
  guards are invisible to it. Run `npx vitest run tests/unit/ci-knobs-guard.test.ts`
  explicitly when adding a file or constant to a guarded directory.
- The coordinator integration tests spin up real servers and **flake on Windows
  under the parallel `test:guards` run** with `fetch failed` / `ECONNRESET`.
  Re-run before believing a failure: 3/3 pass in isolation, 0 fail on re-run.
