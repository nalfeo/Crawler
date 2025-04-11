# Handoff: CI Recovery — Outdated Thread Annotation

**Date:** 2026-07-18  
**PR:** closes #1587  
**Session apple estimate:** 2🍎  
**Branch:** fix/ci-recovery-outdated-thread-annotation

## Systems touched

ci-recovery

## What was done

Fixed a deterministic defect in the CI recovery automation that caused infinite stall loops whenever a PR contained outdated review threads (`isOutdated: true`). Incident triggered on PR #1516 which had 4 unresolved review threads, 2 of which were outdated.

### Root cause

The recovery task body dispatched to the Copilot agent did **not** annotate outdated threads. The `ci-review-validator` agent received no signal distinguishing outdated threads from live ones, so it invoked a full code-review sub-agent on the outdated threads. With no current file context to anchor those threads, the validator could not produce a deterministic `✅ Addressed` reply, leaving the threads perpetually unresolved. The automation retried twice with an identical blocker fingerprint (the outdated flag is excluded from fingerprint computation by design), detected no progress, and filed the loop incident.

### Fix (smallest correct change)

1. **`reconcile.mjs`** — Before collecting blockers, build a `threadOutdated: Map<threadId, boolean>` from `thread.isOutdated`. In the task body `flatMap`, look up this map and append ` (outdated)` to the thread header line when it is `true`. Updated the review-thread protocol text to:
   - Explicitly explain that the `(outdated)` marker is only a stale-anchor hint, not proof the finding is inapplicable.
   - Require a separate-model validator on **every** listed review thread, including outdated ones.
   - Clarify that the recovery infrastructure handles thread resolution via the `✅ Addressed` marker — the agent must not attempt to call `resolveReviewThread` directly.

2. **`ci-review-validator.agent.md`** — Updated the validator protocol so every listed review thread gets a separate-model validation pass, and any deterministic non-applicability reply that recovery should auto-resolve must include `✅ Addressed in <sha>: <note>` plus evidence.

3. **`reconcile.test.mjs`** — Added regression test `live reconcile annotates outdated review threads in task body` that creates a mock GraphQL response with one `isOutdated: true` thread and one `isOutdated: false` thread, dispatches a live reconcile, and asserts:
   - The task comment body includes `(outdated)` only for the outdated thread.
   - The updated protocol text explaining `(outdated)` threads is present.

### Why `normalizeBlockers` / fingerprint was NOT changed

The `isOutdated` flag is intentionally excluded from `normalizeBlockers` (and therefore from `blockerFingerprint`) because the fingerprint's purpose is to detect if blockers changed across reconcile attempts. Adding `isOutdated` to the fingerprint would cause a false "progress detected" signal if a thread transitions from non-outdated to outdated between attempts, which could reset the retry counter and delay loop-incident filing. The annotation lives only in the task body, not in the normalised blocker representation.

## Testing

- Ran new regression test alone: **pass** (1/1).
- Ran full CI recovery suite (`state.test.mjs` + `reconcile.test.mjs`): **116/116 pass**.
- Initial `npm run verify:fast` in this session failed because the local clone lacked the historical commit object required by `tests/unit/agent/epic-status.test.ts`.
- After fetching the missing git history (`git fetch origin main:refs/remotes/origin/main`), reran `npm run verify:fast`: **4255/4255 pass**.

## Files changed

- `.github/scripts/ci-recovery/reconcile.mjs` — thread outdated map + task body annotation + updated protocol text
- `.github/agents/ci-review-validator.agent.md` — explicit `(outdated)` handling
- `.github/scripts/ci-recovery/reconcile.test.mjs` — regression test
