---
name: asset-pr
description: >-
  **Legacy drain only.** Use to fold accumulated `asset-checkin` issues (from
  before the automated reconciler) into one PR. The normal art-landing path is
  now `sprites:approve` → `assets/queue` → hourly reconciler (`sprite-queue-reconciler.yml`).
  Select this skill only when draining leftover `asset-checkin` issues or
  orphaned `assets/checkin-*` branches that predate the reconciler, or when
  someone asks to "process the asset issues", "drain the asset-checkin backlog",
  or "consolidate the legacy check-in queue".
---

# Asset PR (legacy drain)

> ⚠️ **This skill covers a legacy path.** The normal approval → landing flow is:
> `sprites:approve` (which pushes to `assets/queue`) → the hourly
> `.github/workflows/sprite-queue-reconciler.yml` cron opens/merges ONE
> `assets/promote → main` PR automatically. **Do not run `sprites:checkin` or
> `sprites:asset-pr` for new approvals.** This skill exists only to drain legacy
> `asset-checkin` issues and orphaned `assets/checkin-*` branches that
> accumulated before the reconciler was deployed (merged Jul 2026).

Turn leftover `asset-checkin` issues into a single game PR and drive it to a
clean squash-merge.

Each check-in was produced by `npm run sprites:checkin` — the old flow that pushed an
`assets/<slug>` branch and filed an issue whose body carries a machine-readable payload.
This skill folds **all** such legacy issues into one branch and one PR.

> The deterministic heavy lifting — listing issues, unioning every branch's
> `manifest.json`, copying the approved PNGs binary-safely, pushing the batch
> branch, and opening the PR — is done by `npm run sprites:asset-pr`. Detailed
> recipes, edge cases, and the manual fallback live in
> [`references/playbook.md`](references/playbook.md).

## Crawler merge facts (authoritative)

- **Merge command:** `gh pr merge <n> --auto --squash`. Enables GitHub
  auto-merge; completes on its own once required checks pass. Do **not**
  poll/wait after arming it.
- **No required human review.** Never blame a "review block" without explicit
  proof from `gh pr merge` output.
- **Art-only fast lane:** an asset-only PR skips the heavy gameplay gates
  (integration, headless, e2e, build); only typecheck/lint/format/unit run, and
  the merge-gate treats the skipped jobs as PASS. So an asset PR goes green fast.
- The PR body emitted by the backend contains a `Closes #<n>` line per source
  issue, so merging it auto-closes the whole queue.

## Loop

1. **Preflight** (persona: **Producer**; declare a 🍎 apple estimate first):
   `bash scripts/agent/preflight.sh`.
2. **Survey the queue:**
   `gh issue list --label asset-checkin --state open --json number,title`.
   Also check for orphaned branches:
   `git ls-remote --heads origin 'assets/checkin-*'` cross-referenced with
   `gh pr list --state open --json headRefName`.
   If both are empty, report "nothing to consolidate" and stop.
3. **Consolidate + open the PR:** `npm run sprites:asset-pr`.
   - It scans both open `asset-checkin` issues **and** orphaned `assets/checkin-*`
     branches (branches with no open PR). Both are folded into one batch branch.
   - It prints the batch branch and the PR URL.
   - It is a no-op (exit 0, notice) when both the issue queue and orphaned branches
     are empty.
   - It is **local-only** in spirit but does push + open a PR — run it on a dev
     box with `gh` authenticated, never inside CI.
4. **Verify the PR is art-only** so it takes the fast lane:
   `gh pr view <n> --json files` → every path must be under
   `public/assets/generated/**` or `src/shared/data/sprite-catalog.json`. If not,
   something merged non-art changes — investigate before merging.
5. **Arm auto-merge:** `gh pr merge <n> --auto --squash`.
6. **Confirm closure:** once merged, GitHub closes every `Closes #<n>` issue.
   Spot-check with `gh issue list --label asset-checkin --state open` (should be
   empty, or only issues whose branches failed to fold — see playbook §Recovery).
   After the legacy drain is complete, the reconciler owns future art landing.
7. **Wire after merge** — consolidation only ships the files; nothing renders them
   until a consumer references the brief id. Run `npm run sprites:generate-wiring
   -- --since main` to find replaceable placeholders and open a **separate non-art
   PR** for any matches.

## Guardrails

- **Never** approve sprites or run `sprites:checkin` from here — this skill only
  consolidates already-accumulated legacy check-in art.
- For **new approvals**, use the current flow: `sprites:approve` (which pushes to
  `assets/queue`) and let the hourly reconciler handle landing.
- If `npm run sprites:asset-pr` fails on a missing branch (a check-in branch was
  deleted), see playbook §Recovery: re-run after removing the stale issue.
- One batch PR at a time. If a prior batch PR is still open, merge or close it
  before opening another so issues aren't double-counted.
- **Consolidating ≠ wiring.** The batch PR is art-only by design; nothing renders
  the new sprites until a consumer references the brief id. After the PR merges,
  always run `npm run sprites:generate-wiring -- --since main` to find replaceable
  placeholders and open a follow-up wiring PR for any matches — otherwise approved
  art ships and is never seen in-game.
- Do not hand-edit the unioned `manifest.json`; if the union looks wrong, fix
  `mergeManifests` in `scripts/sprites/asset-issues.ts` and add a unit test.
