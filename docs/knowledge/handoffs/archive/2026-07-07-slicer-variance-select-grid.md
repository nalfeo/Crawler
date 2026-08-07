# Handoff: Slicer variance-select grid reconciliation + F1 asset burndown

**Date:** 2026-07-07
**Session:** slicer-variance-select-grid (F1 asset burndown + F2 art)
**Apple estimate:** 🍎🍎🍎🍎 (program) / 🍎🍎🍎 (this PR) | **Actual:** 🍎🍎🍎 | **Verdict:** on-estimate

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Graphics/Content slice of the producer-orchestrated **Floor 1 REQUIRED asset burndown**
(generation via the `asset-request.yml` GitHub Action → Azure OpenAI → blob → gallery →
approve → asset-pr → wire). Work is filed **one wave at a time** in priority order behind
a cheap canary.

The Wave 1 canary (`prop-rubble-pile`, issue #848, a 4×4 = 16-cell sheet) surfaced a
content-aware **slicer over-segmentation** bug: the model draws internal negative space,
the slicer detects spurious gutters, and the generation count gate hard-fails. Concrete
before-state: asset-request run **28896347594** logged
`error processing issue-848:prop-rubble-pile: expected 16 cells, slicer produced 20`.

Per an explicit **human product decision**, the fix was redesigned from an alignment-gated
snap to a **minimum-variance cut-selection**: when an axis is over-segmented, pick the
`(commanded−1)`-subset of the **real detected gutters** that minimizes Σ(cell-width²)
(≡ most-even spacing, incl. outer edges) via an O(k²·targetCells) DP; under-segmented axes
fall back to uniform cuts. Reconciliation **always emits the commanded cell count**, so the
generation count gate effectively always passes on the generation path and **human gallery
review is now the grid quality gate** (the user accepted that weird edge sprites are simply
rejected in review). Reconciliation only runs when `expectedGrid` is supplied, so the
DevTools `/api/slice-map` debugger path is byte-for-byte unchanged.

Also: Wave 0 art-plan cleanup (roster aligned to runtime ground truth), and **Round 2
generation kicked off in parallel** — the 5 Wave-2 tile issues are generating on Azure now
(see Unresolved).

## Files touched

- `scripts/sprites/slice-sheet.ts` — `selectEvenCuts` (variance DP) + `reconcileAxisCuts`; removed `detectedMatchesUniformGrid` + `MAX_SPURIOUS_BANDS`; determinism doc-comment. (commits c77f0153, 7853a46d)
- `tests/unit/sprites/slice-sheet.test.ts` — reconciliation suite rewritten for variance-select behavior; 21 tests total.
- `plans/floor-art/rat-themed-dungeon-floor.art.yaml`, `plans/props/floor1-props.art.yaml` — Wave 0 roster cleanup. (5cfa3064, 49e84ec1)
- `docs/knowledge/review-ledgers/2026-07-07-slicer-grid-reconciliation.review-ledger.json` — tier-3 ledger. (b23d768e)

## Verification run

- `npx vitest run --project unit tests/unit/sprites/slice-sheet.test.ts` → 21 passed.
- `npm run typecheck`, `npm run lint`, `npm run lint:dead-code` → clean.
- `npm run review:ledger -- validate …` → **valid 3-apple ledger** (plan_review gpt-5.4 5/5; code_review claude-sonnet-4.6 clean).
- Before/after (observe-before-done): OLD slicer on main → run 28896347594 `expected 16 cells, slicer produced 20` (hard fail). NEW slicer → reconciles any over-segmentation to exactly the commanded grid (unit tests pin 1×N, N×1, mixed, and asymmetry cases). This is the **generation path**; the human gallery is the grid gate for pathological art.
- `npm run verify` — final full gate run before PR (headless Floor-1 gate deferred to CI; change is in `scripts/sprites`, not core/ai/balance).

## Unresolved issues

- **Slicer PR not yet merged.** `asset-request.yml` L95 uses plain `actions/checkout@v4` (no `ref:`), so `issues`-triggered runs execute **main's** code — the slicer fix MUST reach main before #848 can pass.
- **Round 2 (Wave 2 tiles) generating on Azure now, on OLD main code.** Issues filed this session: #854 `tile-stone-floor`, #856 `tile-stone-wall`, #857 `tile-door`, #855 `tile-boss-staircase-floor`, #858 `tile-safe-room-floor` (all `Type: tile`, self-contained briefs). Safe on old code — they are full-bleed **solid** tiles with no internal gaps, so the over-seg bug does not apply. Awaiting ingest/approve/checkin/wire.
- **Held for the fixed pipeline (post-merge):** `prop-rubble-pile` #848 (gappy; re-trigger by **editing the brief to change its fingerprint**, since the ingester dedupes by issueNumber+brief-hash and it is already fingerprinted from the failed runs), the slime-rat mid-boss (WIDE 2:1 — confirm sizeVariant handling via the issue path), and the 3 thin/cluster items (old-sock, glistening-rat-tail, merchants-stained-charm).
- Tile **wiring** needs an engine change: `buildTerrainLayer` only stamps from a Kenney spritesheet; generated single-texture tiles need a single-texture stamp path (mirror the prop path) + a lab + `check:wired-systems`. That is a separate full-gate PR (Wave 2 step 1).

## Recommended next steps

1. `npm run verify` → `create_pull_request` (holistic: slicer variance-select fix + Wave 0 art-plan cleanup) → `gh pr merge --auto --squash`; bounded final-state verify (MERGED + non-null mergeCommit); resolve any Copilot-reviewer threads via GraphQL `resolveReviewThread`.
2. After merge: re-trigger #848 (edit brief) → expect 4×4=16 slice → complete canary (`sprites:ingest-once`/`sprites:gallery` → `sync-catalog` → `approve` → `checkin` → `asset-pr` → merge → `generate-wiring -- --since main`). Add a deterministic F1 prop probe.
3. Ingest + approve the 5 Wave-2 tiles (already generating); do the tile-stamp engine change; wire CORRIDOR/stairs/sewer-grate + the 5 new tiles.
4. Wave 3 (slime-rat WIDE boss, wire `enemy_boss_slimerat`), Wave 4 (bone-shard + 6 items), then Floor 2 (roster reality-check first).
5. Report each transition to the orchestrator (`send_session_message` → `d467a72d-b51e-43a9-b48c-1e38a442c986`). Session SQL `asset_pipeline` tracks per-asset status (issue#, status, run id, briefId).
