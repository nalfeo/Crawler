# Multi-frame walk-cycle generation in the sprite pipeline (Slice B)

## Systems touched

sprite-pipeline, generated-assets

## Summary

Extended Crawler's sprite-generation pipeline (`scripts/sprites/**`) to
produce a coherent multi-frame animation sheet — a side-view player
walk-cycle — as the PRODUCER side of a two-slice effort. A parallel session
(Slice A, not touched here) builds the Phaser consumer (`src/engine/**`)
that reads the shared `animation` descriptor this pipeline now emits.

Previously the pipeline only knew how to generate N independent design
_alternatives_ of a single static sprite in a grid sheet and let a human
approve exactly one cell. This adds an opt-in mode where a brief instead
declares it wants an ORDERED N-frame cycle of the SAME character, and the
pipeline slices/packs those frames into one horizontal strip PNG plus a
manifest `animation` descriptor, gated by a new deterministic cross-frame
coherence check.

### What shipped

1. **Brief schema** (`brief-schema.ts`): new opt-in `frameSequence` block
   (`enabled`, `frameCount >= 2`, `frameRate`, `loop`). Strictly backward
   compatible — briefs that don't set it behave exactly as before.
2. **Generation** (`build-prompt.ts`, `generate-one.ts`, `run-artifacts.ts`):
   when `frameSequence.enabled`, the provider prompt is built to request the
   same character across successive walk poses on a fixed grid (not N
   independent design candidates), and `sliceSheetWithGrid`'s `fixedGrid`
   flag is derived directly from `brief.frameSequence?.enabled` at every
   call site (no separately-set flag that could drift).
3. **Slicing/packing** (`pack-frame-strip.ts`): extracts the ordered frames
   and packs them into a single horizontal strip, uniform
   `frameWidth × frameHeight` cells, no margin/spacing — exactly what
   Phaser's `loader.spritesheet()` needs.
4. **Postprocess safety** (`postprocess.ts` `frameSequenceDisabledModules`,
   threaded through `run-full.ts` and `rerun.ts`'s `default` mode): disables
   `transparent-trim`/`trim-and-fit` for frame-sequence runs. Per-frame
   independent trim-before-resize was giving each pose its own scale factor
   and silently breaking the uniform scale/floor-line the whole strip
   depends on (multi-model review finding, see below).
5. **Coherence gate** (`sensors/frame-coherence.ts`) — the hard success
   gate: a deterministic, threshold-based cross-frame check wired into the
   existing sensor/validation path, run automatically before a frame
   sequence can be approved. Three signals, ALL must pass every adjacent
   frame pair:
   - **Palette** — `DEFAULT_MAX_PALETTE_DISTANCE = 0.35`
   - **Silhouette mass** — `DEFAULT_MAX_MASS_DELTA_RATIO = 0.4`
   - **Baseline/floor-line stability** — `DEFAULT_MAX_BASELINE_DELTA_PX = 6px`
     (added during adversarial plan review — palette+mass alone couldn't
     prove the character's feet stay on the same floor line across poses,
     which the prompt asks for but nothing enforced deterministically)

   Deterministic only, no LLM-as-judge. The existing opt-in VLM judge
   remains available as an advisory signal but is never the gate. Unit
   tested with both a coherent fixture and multiple deliberately-incoherent
   ones (wrong-color-subject drift, floor-line jump), plus a zero-mass
   edge case (two fully-transparent frames must score 0% different, not
   100% — a real division-by-near-zero bug found in multi-model review).

6. **Check-in / manifest** (`approve.ts` `approveFrameSequence`,
   `checkin.ts`): writes the shared
   `animation: {frameWidth, frameHeight, frameCount, frameRate, loop}`
   descriptor onto the manifest entry. Conforms exactly to the type Slice A
   is adding to `src/shared/generated-assets.ts` — declared as a local
   structurally-identical type inside `scripts/sprites/` per the file-
   ownership split (did not touch `src/shared/generated-assets.ts` or
   `src/engine/**`).
7. **Real asset**: generated, coherence-gate-passed, and checked in a real
   player walk cycle — `briefs/characters/player-walk-cycle.yaml`,
   **frameCount = 4** (not the target 3) because the Azure `images/edits`
   endpoint only accepts a square canvas, and a 3-frame strip at readable
   per-frame width didn't divide the 1024×1024 native canvas evenly under
   the existing gutter/grid validator; 4 frames does. This is a deliberate,
   documented tradeoff (see plan-review notes in the ledger), not a silent
   scope cut — accepted in the adversarial plan review as reasonable
   given readability-at-game-scale is the top tiebreaker. All 4 frames pass
   the coherence gate with 0px baseline delta between every pair.

### Manifest-sharding merge reconciliation

While this branch was in review, `origin/main` landed a large structural
refactor (PR #2286, "shard the generated manifest + derive the catalog to
end art-PR merge conflicts") 6 commits ahead. `public/assets/generated/manifest.json`
is now a gitignored, derived build artifact; the real source of truth is
one JSON shard per asset under `public/assets/generated/entries/<key>.json`
(`scripts/sprites/generated-shards.ts`), and `src/shared/data/sprite-catalog.json`
no longer carries any committed `generated:*` rows (derived at read time via
the new `src/shared/generated-catalog.ts`).

A plain rebase would have conflicted on nearly every one of this branch's
~10 commits (the refactor touches almost every file this Slice B PR also
touches). Instead did a single `git merge origin/main --no-commit --no-ff`,
which produced exactly 3 conflicts (`approve.ts`, `sprite-catalog.json`,
`manifest.json` modify/delete) resolved as:

- `approve.ts`: merged both sides' distinct new optional fields
  (`animation` from this branch, `placeholder`/`catalog` from upstream)
  onto the same `ManifestEntry` interface.
- `sprite-catalog.json`: took `origin/main`'s version wholesale (zero
  `generated:*` rows now, fully derived).
- `manifest.json`: extracted this branch's one new entry
  (`player-walk-cycle`) into its own shard file, then removed the aggregate
  file to match upstream's gitignored/derived state.

The merge auto-resolved cleanly on the file level but left one real defect
git couldn't detect (deleted function + surviving call site are
non-adjacent hunks): `approveFrameSequence()` still called the now-deleted
`upsertCatalog(...)`, and its `catalogPath` option hadn't been updated to
match `approveVariant`'s new deprecated/optional pattern. Fixed both.
`tests/unit/sprites/approve-frame-sequence.test.ts` was similarly updated
to read the manifest via `composeManifestFromShards` (matching
`approve.test.ts`'s established pattern) instead of the now-nonexistent
aggregate file.

`npm run sync:main` (which does a rebase, not a merge) still reports a
conflict-and-abort when run after this manual merge — it doesn't recognize
that a merge commit already reconciled the divergence. This is a known
limitation of the sync script against a branch containing a merge commit,
not unresolved drift: `git rev-list --left-right --count origin/main...HEAD`
confirms 0 commits from `origin/main` are missing from `HEAD`.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run tests/unit/sprites/` — 121 files / 1933 tests passed
  (post-merge, including the fixed `approve-frame-sequence.test.ts`).
- `npm run verify:fast` — full pass (2348 unit/ecs tests + 607 integration
  tests + physics-defs/size/weight coverage checks), no regressions,
  both before and after the merge.
- Real generated asset re-verified against the coherence gate after the
  merge: still passes (0px baseline delta, well under all three
  thresholds).

## Review harness

4🍎 (declared at session start; `estimated_apples: 4` in the ledger).
Ledger: `docs/knowledge/review-ledgers/2026-07-29-multi-frame-walk-cycle.review-ledger.json`
(valid, all 3 required 4-apple stages complete):

- **Plan review** (adversarial, gpt-5.4, 3 alternatives enumerated and
  argued against): 8 concerns raised, all resolved — most notably adding
  the baseline/floor-line coherence signal.
- **Code review** (claude-sonnet-4.6, round 1): 1 finding (missing
  queue-commit retry path for `--sequence` approvals), fixed.
- **Multi-model review** (gpt-5.3-codex, gemini-3.1-pro-preview,
  security-review): 3 findings total (1 stale `processedPath` fallback
  from gpt; 2 from gemini — the per-frame transparent-trim scale mismatch
  and the zero-mass `massDeltaRatio` math bug), all fixed and re-verified.
  Security review: clean.

## Unresolved issues / follow-ons

- Coherence gate runs at approval time, not during generation-time scoring
  (acknowledged in plan review as legitimate future hardening — cheaper
  failure sooner — but out of this task's scope).
- `frameCount=4` vs the target `frameCount=3`, driven by the Azure
  `images/edits` square-canvas constraint. A future rectangular-canvas
  provider extension could hit the exact target 3 but was judged
  out-of-scope/higher-risk than justified here.
- `npm run sync:main` doesn't gracefully recognize a branch with an
  existing merge commit already reconciling upstream drift — reports a
  rebase-conflict-and-abort even though `origin/main` is fully contained
  in `HEAD`. Not a blocker for this PR, but worth a future look at the sync
  script's drift detection if this recurs on other branches.
