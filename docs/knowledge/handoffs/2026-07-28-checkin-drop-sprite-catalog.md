# Stop art check-ins writing the sprite catalog

**Date:** 2026-07-28
**Apples:** estimated 3🍎 / actual 3🍎
**PR:** (see branch `sprites-derive-generated-catalog`)

## Systems touched

sprite-pipeline

## Problem

Every art check-in appended to **two** committed mega-files:

| File                                    | Lines  | Entries | Nature                                                                                                                                      |
| --------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/assets/generated/manifest.json` | 21,115 | 463     | True source of truth — non-derivable provenance (`approvedAt`, `anchor`/`anchors`, `judgeScore`, `sensorScore`, `contentHash`, `sourceRun`) |
| `src/shared/data/sprite-catalog.json`   | 4,813  | 367     | 91% derived duplicate — 334 `generated:` rows restating manifest data                                                                       |

Because both files were appended to on every check-in, **every pair of parallel art
PRs conflicted by construction**. This was not a hypothesis: four sprite PRs
(#2057, #1975, #2112, #2124) were all simultaneously `DIRTY`, and `git merge-tree`
showed every pair conflicting on exactly those two paths. All four were ultimately
closed as already-landed, but the structural cause remained.

## What changed

Art check-ins now write **one** shared committed JSON file instead of two.

- `scripts/sprites/checkin.ts` — `ASSET_SURFACE_PATHS` drops the catalog. A new
  `ART_SURFACE_ALLOWLIST` keeps it, and the two constants are now explicitly
  different things (see below).
- `scripts/sprites/checkin-runtime.ts` — deleted the catalog projection from
  `copyArtSurface`.
- `scripts/sprites/queue-commit.ts` — inherits the narrower staging list.
- `scripts/sprites/reconcile-queue.ts` — guard/inspection sites now use the
  tolerant allowlist.
- `scripts/sprites/asset-request-publisher.ts` — removed a hard
  `throw new Error('Source catalog entry generated:<key> is missing')` and dropped
  the catalog from the collision guard's exact-match comparison.

### The one subtle decision: write-set vs tolerate-set

`isArtSurfacePath` must match CI's `detect-art-only.sh` **exactly** — its own doc
comment says so, because a diff the guard accepts must be precisely one that
`ci.yml` classifies `art_only=true`. Narrowing that guard would have made every
in-flight queue/check-in branch created before this change fail reconciliation with
_"Refusing to arm auto-merge"_.

So the constant was split rather than narrowed:

- `ASSET_SURFACE_PATHS` — what a check-in **writes/stages** (`public/assets/generated`).
- `ART_SURFACE_ALLOWLIST` — what guards **tolerate** on an existing diff (adds the catalog).

`ART_SURFACE_ALLOWLIST` is asserted to be a superset of `ASSET_SURFACE_PATHS` in
`tests/unit/sprites/checkin.test.ts`.

## Observe before done

Real artifact: **`npm run test:sprites` — 1,893 passed, 1 skipped, 120 files.**

The meaningful proof is the real-git test
`reconcile-queue.test.ts > runReconcile (real git) > (c) the promote→main diff is
art-surface-only by construction`, which drives actual `git` against real worktrees
and still passes with the narrowed write-set — i.e. a queue promotion continues to
produce an art-only diff while no longer touching the catalog.

`tests/unit/sprites/checkin-runtime.test.ts` previously asserted that
`copyArtSurface` _merged_ catalog entries into the destination worktree; it now
asserts the destination catalog is **byte-identical** before and after. That
inversion is the before/after observation for this change.

## Deliberately NOT done (accepted debt)

- `scripts/sprites/approve.ts` still writes the catalog locally, so local tooling
  and the publisher's source-side lookups keep working.
- The committed `sprite-catalog.json` is untouched and becomes **frozen legacy
  data** — main stops gaining `generated:` rows for newly checked-in art. Nothing
  visibly regresses, because the sprite-catalog lab already re-derives generated
  rows from the manifest at runtime
  (`src/labs/sprite-catalog-lab/index.ts:988-1017`), and **the game never reads
  the catalog at all** — its only `src/` consumer is that lab; the runtime loads
  the manifest via `src/engine/generatedAssets/preload.ts`.
- `ci-harvest-approve` + `.github/workflows/g2b-harvest-approve.yml` still stage
  the catalog on their own path. Lower volume; superseded by the follow-up.

## Follow-up (in flight, parallel session)

The full fix shards `public/assets/generated/manifest.json` into per-asset files
with a build-generated aggregate (so the runtime keeps a single fetch), and derives
the `generated:` catalog rows. That session supersedes this one and inherits the
hard-won constraints below.

## Traps for the next agent

These each cost real time and were each proven wrong on the first attempt:

1. **Tag order is semantic-type FIRST, not alphabetical.** `approve.ts:639-641` is
   authoritative: `type ? [type,'generated','pipeline-approved'] : [...]`. 146 of
   334 rows are non-alphabetical. Sorting them rewrites the file.
2. **Descriptions are not derivable.** `approve.ts:643-650` deliberately preserves
   hand-authored copy; 7 rows carry real editorial content (e.g.
   `geese-boss-var-0`, `cactusfolk-boss-var-1`).
3. **Tags are not always derivable either.** 33 rows are genuinely stale, but 7 are
   real overrides — `merchant-sandals-var-0` (`manual-authored`),
   `twin-katar-var-0` (`hand-authored`), and 5 carrying a _different_ semantic type
   than the manifest.
4. **The placeholder rule is not "key ends in `-placeholder`".** 122 placeholders
   key `<name>-placeholder` while carrying a bare `<name>` as `spriteName`, but
   `equipment/weapon/crescent-glaive` and `equipment/weapon/meteor-hammer` have
   _normal_ keys and `-placeholder.png` asset paths. Centralize one predicate based
   on the asset path.
5. **`id`/`spriteId` must come from the manifest map key, never `spriteName`.** An
   older `approve.ts` wrote a brief-wide `spriteName`, collapsing every variant of
   a brief onto one row.
6. **`sprites:sync-catalog --check` does not enforce the invariant** — `syncCatalog`
   preserves unknown entries unless `--prune`, so a re-introduced `generated:` row
   passes. A dedicated CI invariant is needed.
7. **`merge=union` is not viable** on pretty-printed JSON (it produces syntactically
   invalid output) and stays ambiguous even as JSONL for same-key updates.

8. **A catalog-ONLY writer exists, and narrowing the staged surface silently broke
   it.** Found by adversarial code review, not by the test suite. The sidecar
   `POST /api/workflow/metadata` (Tag) route mutates _only_
   `src/shared/data/sprite-catalog.json` — `runMetadataPipeline` never writes the
   manifest or a PNG. Once `ASSET_SURFACE_PATHS` narrowed to
   `public/assets/generated`, `git add` staged nothing, `runQueueCommit`'s no-op
   guard fired, and the metadata edit never reached `assets/queue` — exactly the
   cross-worktree durability guarantee that route was built to provide.

   The suite stayed green because the existing regression test
   (`sidecar-server.test.ts:3163`) runs against a **non-git** temp root, so it only
   asserts `queueCommit.status === 'failed'`. It pinned _"the route called
   queue-commit"_, not _"the edit is durable"_.

   Fixed by separating the flows rather than widening the art surface back out
   (which would have reintroduced the by-construction conflict this PR exists to
   remove): opt-in `QueueCommitOptions.catalogEntryIds` + a narrow
   `overlayCatalogEntries` dep that replaces/inserts exactly the named ids and
   preserves every other destination row. `runQueueCommit` hard-throws if
   `catalogEntryIds` is supplied without the dep, so the silent-drop mode cannot
   recur. Two real-git regression tests were added; the durability one was proven
   non-tautological by reverting the fix in place and observing it fail with the
   exact reported symptom (`expected 'noop' to be 'committed'`).

   **Lesson worth generalizing:** when narrowing a shared write surface, enumerate
   every caller by what it _mutates_, not by what it is named. `runQueueCommit`
   looked like an art primitive; one caller used it for catalog-only edits.
