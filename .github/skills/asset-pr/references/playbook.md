# Asset PR — playbook (legacy drain)

> ⚠️ **This playbook covers the legacy `asset-checkin` drain path.** The normal
> art-landing flow since Jul 2026 is: `sprites:approve` (automatically pushes to
> `assets/queue`) → hourly `sprite-queue-reconciler.yml` cron → single
> `assets/promote → main` PR. Run `sprites:asset-pr` only to drain legacy
> `asset-checkin` issues or orphaned `assets/checkin-*` branches that pre-date
> the reconciler.

Detailed recipes for consolidating `asset-checkin` issues into one game PR.

## The data model

A check-in (`scripts/sprites/checkin.ts`) produces two artifacts:

1. A pushed branch `assets/<slug>` containing the **art-surface delta** off
   `main`:
   - `public/assets/generated/**` (the approved PNG(s) + the updated
     `manifest.json`)
   - `src/shared/data/sprite-catalog.json`
2. An issue labeled `asset-checkin` whose body ends with a machine-readable
   block:

   ```
   <!-- asset-checkin:v1
   {"version":1,"branch":"assets/checkin-…","baseBranch":"main","assets":[…]}
   -->
   ```

`scripts/sprites/asset-issues.ts#parseAssetIssueBody` decodes that block;
`scripts/sprites/asset-pr.ts#parseOpenAssetIssues` maps the `gh issue list`
JSON into `{ number, title, payload }[]`.

## What `npm run sprites:asset-pr` does

`scripts/sprites/asset-pr.ts#runAssetPrConsolidation`:

1. `gh issue list --label asset-checkin --state open --json number,title,body`
   → parse payloads (issues without a valid payload are skipped).
2. `scanOrphanedCheckinBranches` — `git ls-remote --heads origin 'assets/checkin-*'`
   cross-referenced with `gh pr list --state open` to find branches with no open PR.
   Non-fatal: query failures return `[]` (trust guard still validates all paths).
3. If both issues and orphaned branches are empty → print "nothing to consolidate"
   and exit 0.
4. `planConsolidation` → batch branch `assets/batch-<UTC-stamp>`, PR title/body
   (with `Closes #<n>` per issue), the deduped source branches, and the deduped
   asset list.
5. `git fetch origin main` + each source branch + each orphaned branch.
6. Pre-compute AM-only (`--diff-filter=AM`) paths vs `origin/main` for each
   orphaned branch (restricted to `ASSET_SURFACE_PATHS` — same as the queue).
7. `git worktree add <tmp> -b assets/batch-… origin/main` (the session branch is
   never touched).
8. For each issue-backed source branch: materialize each approved PNG and its
   per-asset manifest shard (`entries/<manifestKey>.json`) with
   `git checkout <ref> -- <path>` (binary-safe — no blob passes through stdout).
   Because every shard is keyed by `manifestKey`, disjoint check-ins never touch
   the same path; no JSON union step is needed.
9. For each orphaned branch: overlay only its AM-scoped paths via
   `git checkout <ref> -- <paths>`. Later branches win on collision
   (last-writer semantics, same as the queue union).
10. `git add` the art surface, commit (`feat(sprites): consolidate …`), `push -u`.
11. `gh pr create --base main --head assets/batch-… --title … --body …`. Print
    the PR URL.
12. `finally`: `git worktree remove --force` + delete the temp dir.

The pure pieces (`parseOpenAssetIssues`, `planConsolidation`, `parseAssetIssueBody`)
are unit-tested in `tests/unit/sprites/asset-pr.test.ts` and `asset-issues.test.ts`.
(`mergeManifests`/`mergeCatalogs` remain in `asset-issues.ts` and are tested but are
no longer called by the drain executor — the shard-overlay approach supersedes them.)
`scanOrphanedCheckinBranches` is unit-tested in `reconcile-queue.test.ts` (Layer 2b).

## Why shard-overlay instead of `git merge`

Legacy check-in branches written by `scripts/sprites/checkin.ts` each edited the
same aggregate `manifest.json` off `main`, so a plain N-way merge conflicted on that
file every time. The PNGs never collide (each variant has a globally-unique
`<briefId>-var-<n>.png` filename). The drain executor sidesteps the conflict by
checking out only per-asset shard files (`entries/<manifestKey>.json`) — disjoint
by key — so no JSON merge step is needed. The aggregate manifest and catalog are
derived from the shards at read time.

## Merge facts (authoritative)

- `gh pr merge <n> --auto --squash` — enable auto-merge, then stop. No manual
  polling.
- No required human review. Only invoke a "review block" with explicit proof
  from `gh pr merge` output.
- Required check is the aggregate `ci` job. For an **art-only** PR the heavy
  jobs (integration, headless, e2e, build) are skipped by the `changes` job and
  the merge-gate treats them as PASS — so the PR usually goes green within a few
  minutes of unit + lint + format + typecheck.
- Squash-merge auto-deletes the batch branch; that's fine, it's disposable.

## §Wiring — hook the merged art into the game

The batch PR is art-only by design (fast lane), so it ships PNGs + manifest +
catalog but **wires nothing**: a sprite renders only once a consumer references
its brief id. Skipping this leaves approved art checked in but never shown — e.g.
`rat` / `rat-slime` landed via earlier asset PRs yet rats and the staircase
boss still drew Kenney placeholders until wired by hand.

After the batch merges:

1. `npm run sprites:placeholder-audit -- --since main` (the **placeholder-audit**
   skill). Read the **Replaceable now** rows; cross-check **related name**
   suggestions (heuristic) before trusting them.
2. Wire each match in the right layer:
   - item icons: resolve by `itemId === briefId`, usually zero code;
   - mobs: `spriteId` in `src/shared/mobDefs.ts`;
   - engine entities (rat/slime/boss): `ENTITY_GENERATED_SPRITE` + render scale in
     `src/engine/PhaserBridge.ts`.
3. Distinguish near-identical concepts (`rat-slime` boss ≠ `slime-rat` tutorial
   boss) and add a before/after unit test for the resolution.
4. Open it as a **separate non-art PR** (runs the full gates) — never fold wiring
   into the art-only batch.

## §Recovery — when something goes wrong

**Orphaned `assets/checkin-*` branches (no issue, no open PR):**
These are automatically picked up by both `sprites:asset-pr` and the hourly
`sprite-queue-reconciler`. If you want to fold them immediately without waiting
for the cron, run `npm run sprites:asset-pr` — it now scans and overlays
all orphaned branches in addition to issue-backed ones. The PR body lists them
under **Orphaned branches (no issue)**. If a specific orphaned branch's art
conflicts with newer work, delete the branch on the remote first:
`git push origin --delete assets/checkin-<slug>`.

**A source branch was deleted** (e.g. someone pruned `assets/<slug>`):
`git fetch origin <branch>` fails and the run aborts. Options:

- If that asset is no longer wanted: close the stale issue
  (`gh issue close <n> --comment "branch pruned; superseded"`) and re-run.
- If it's still wanted: re-approve via the current flow (`npm run sprites:approve
-- <runDir> --variant <N>`, which pushes to `assets/queue`) — the reconciler
  will pick it up. Then remove the stale issue before re-running `sprites:asset-pr`
  if the legacy drain is still needed for other issues.

**The PR opened but a check-in branch's asset is missing from the diff:**
confirm the payload's `assets[].assetPath` matches a real file on the branch
(`git show origin/<branch>:public/assets/<assetPath> | wc -c`). A mismatch means
the issue payload drifted from the branch — re-check-in is the clean fix.

**A shard file looks wrong** (a `entries/<key>.json` has unexpected content):
do **not** hand-edit the JSON in the PR. Confirm the shard's content on the
source branch (`git show origin/<branch>:public/assets/generated/entries/<key>.json`).
If it is wrong on the source branch, the check-in itself is stale — re-approve via
`npm run sprites:approve -- <runDir> --variant <N>` (which pushes to `assets/queue`)
and close the bad PR before re-running `sprites:asset-pr`.

**A non-art file showed up in the PR:** the `changes` CI job will route it
through the full suite (correct, fail-safe). Investigate where it came from —
the consolidation only ever stages `public/assets/generated` + the catalog, so a
stray file means a dirty base or a hand edit. Reset and re-run.

## Manual fallback (no script)

If you must consolidate by hand (script unavailable), per source branch:

```bash
git worktree add /tmp/batch -b assets/batch-manual origin/main
cd /tmp/batch
# For each asset listed in each issue payload, check out the PNG and its shard:
git checkout origin/<branch> -- public/assets/generated/<file>.png
git checkout origin/<branch> -- public/assets/generated/entries/<manifestKey>.json
# Repeat for each asset/branch. Because shards are keyed by manifestKey,
# disjoint check-ins never collide — no JSON union step is needed.
git add public/assets/generated
git commit -m "feat(sprites): consolidate approved assets"
git push -u origin assets/batch-manual
gh pr create --base main --head assets/batch-manual \
  --title "Add approved assets" \
  --body "$(printf 'Consolidated asset check-ins.\n\nCloses #3\nCloses #7\n')"
```

Prefer the script — the manual path is error-prone and skips the orphaned-branch scan.
