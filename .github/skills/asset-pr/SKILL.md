---
name: asset-pr
description: >-
  Consolidate every open `asset-checkin` issue in the Crawler repo into ONE
  squash-merged game PR. Use when asked to "process the asset issues", "batch
  the approved art", "open the asset PR", "ship the checked-in sprites", or to
  clear the asset-checkin queue. Covers discovering open asset-checkin issues,
  unioning their pushed art branches into a single batch branch (via
  `npm run sprites:asset-pr`), opening the PR that closes the source issues,
  arming auto-merge per the repo merge policy, and — after merge — automatically
  generating wiring patches to hook up the new art to replace placeholders (via
  `npm run sprites:generate-wiring`).
---

# Asset PR

Turn the queue of locally-approved art (one `asset-checkin` issue + `assets/<slug>`
branch per check-in) into a single game PR and drive it to a clean squash-merge.

Each check-in was produced by `npm run sprites:checkin` (or the sidecar
`POST /api/checkin`): it pushed an `assets/<slug>` branch holding the art-surface
delta off `main` and filed an issue whose body carries a machine-readable
payload. This skill folds **all** of them into one branch and one PR.

> The deterministic heavy lifting — listing issues, unioning every branch's
> `manifest.json` + `sprite-catalog.json`, copying the approved PNGs
> binary-safely, pushing the batch branch, and opening the PR — is done by
> `npm run sprites:asset-pr`. Detailed recipes, edge cases, and the manual
> fallback live in [`references/playbook.md`](references/playbook.md).

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
7. **Generate wiring for checked-in art (automated after merge):**
   consolidation only ships the files; nothing renders them until a consumer
   points at the new brief id. After the merge, automatically find and wire up
   replaceable placeholders:
   - `npm run sprites:generate-wiring -- --since main` — scans for new assets that
     can replace existing placeholders (exact concept matches).
   - Review the output summary to see what needs wiring.
   - For each replaceable placeholder, generate the wiring patches:
     - **Item icons** resolve by `itemId === briefId` (manifest) — usually no code.
     - **Mobs** point via `spriteId` in `src/shared/mobDefs.ts`.
     - **Engine entities** (rat / slime / boss) map type → brief id in
       `ENTITY_GENERATED_SPRITE` in `src/engine/PhaserBridge.ts`.
   - Use `npm run sprites:generate-wiring -- --since main --output patches` to see
     detailed patches.
   - Apply patches and open a **separate non-art PR** that runs the full gates —
     never fold wiring into the art-only batch. Verify near-identical concepts
     aren't conflated (e.g. `rat-slime` boss ≠ `slime-rat` tutorial boss) and tune
     render scale for the new PNG size.

## Guardrails

- **Never** approve sprites or run check-in from here — this skill only
  consolidates already-checked-in art.
- If `npm run sprites:asset-pr` fails on a missing branch (a check-in branch was
  deleted), see playbook §Recovery: re-run after removing the stale issue, or
  re-check-in the lost asset.
- One batch PR at a time. If a prior batch PR is still open, merge or close it
  before opening another so issues aren't double-counted.
- **Consolidating ≠ wiring.** The batch PR is art-only by design; nothing renders
  the new sprites until a consumer references the brief id. After the PR merges,
  always run `npm run sprites:generate-wiring -- --since main` to find replaceable
  placeholders and open a follow-up wiring PR for any matches — otherwise approved
  art ships and is never seen in-game.
- Do not hand-edit the unioned `manifest.json` / `sprite-catalog.json`; if the
  union looks wrong, fix `mergeManifests` / `mergeCatalogs` in
  `scripts/sprites/asset-issues.ts` and add a unit test.
