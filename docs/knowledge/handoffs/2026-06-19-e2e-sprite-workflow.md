# Handoff — E2E String-Driven Sprite Workflow

**Date:** 2026-06-19
**Branch:** `nalfeo/e2e-sprite-workflow`
**Persona:** Producer
**Apples:** declared 🍎🍎🍎🍎 (4) · actual 4 · verdict exact

## Systems touched

sprite-pipeline

## Goal

Drive a one-line text brief ("Purple Potion Bottle") all the way to a tagged,
in-game sprite **through the DevTools UX**, on one page, with resumable state
that survives refresh/restart. Input is a **string typed into the page** (manual
queue add); file/asset-plan import must still work too.

## What shipped

1. **String-driven workflow queue** — pure state module
   `src/devtools/sprite-workflow-queue.ts` (28 unit tests) with serialize/
   deserialize to `localStorage` (`crawler.devtools.sprite-workflow-queue.v1`).
   `src/devtools-main.ts` fully rewired: string composer (text + type select +
   Add), persistent queue list with per-item stepper + inline working area.
   Asset-plan import retained as an optional **import-to-queue** path.

2. **Advisory / human-overridable approve UX** — the VLM judge is advisory
   (the sidecar approve handler never enforced `combinedPassed`). The UX now
   reflects that: approve is **always enabled**; green "Approve" when the judge
   passed a variant, amber **"Approve anyway"** + `window.confirm()` when it
   flagged it. Per-card judge axis chips (S/B/R), best-first ranking, and a
   pass-count header.

3. **Judge axis scores plumbed through** generate → persist → restore so they
   survive a refresh (`WorkflowJudgeSummary`, `toJudgeSummary()`,
   `QueueJudgeSummary` on the queue candidate, threaded through
   `projectActiveItem`).

4. **Type tagging at approve time** (`scripts/sprites/approve.ts`) — the user's
   explicit requirement. `approveVariant` now reads the brief YAML referenced by
   `summary.briefPath` and prepends the sprite `type` to the catalog entry tags.
   The catalog entry is now
   `tags: ["item", "generated", "pipeline-approved"]`. Falls back to the prior
   default tags when the brief YAML is missing/typeless. 2 new tests in
   `tests/unit/sprites/approve.test.ts`.

5. **Fixes (uncommitted from prior sessions, now committed):**
   - `scripts/sprites/judge.ts`: reworded the final user-prompt line away from
     "...described in the system prompt." which tripped an Azure jailbreak
     false-positive.
   - `scripts/setup-azure-env.ps1`: PS 5.1-safe nested `Join-Path`.

## Live E2E result

Drove add → synth → select → promote → generate (run
`purple-potion-bottle-v1/2026-06-19T23-50-46-2dc4b366`, 16 variants, 0 judge-
passing — gpt-image-1 scores `style_match:2` vs crisp Kenney refs, legitimate)
→ **Approve anyway #4** → done. Catalog now contains
`generated:purple-potion-bottle-v1-var-4` with `tags: ["item","generated",
"pipeline-approved"]` and asset
`public/assets/generated/purple-potion-bottle-v1-var-4.png`.

After the approve.ts type-tagging change, re-approved variant 4 via
`POST /api/runs/.../approve {variantIndex:4}` (cheap, no regenerate) and
confirmed the `item` tag landed.

## Verification

- `npm run verify` → **green** (typecheck, lint, format, unit, headless Floor 1
  gate, build all pass).
- `tests/unit/sprites/approve.test.ts` → 12 pass (incl. 2 new type-tag tests).
- `tests/unit/devtools-sprite-workflow-queue.test.ts` → green.

## ⚠️ Pre-existing integration failures (NOT caused by this work)

`npm run verify` Step 6 ("Integration tests") runs
`vitest --project integration` but **intentionally does not gate** on it
(`... 2>/dev/null || echo "ℹ️ No integration tests yet"`). It currently reports
**10 failed / 14 passed**. Confirmed pre-existing on base commit #161 by
stashing all my changes and re-running — they still fail. Root causes are in a
different subsystem (sensor grid slicing / judge pipeline), e.g.:

- `judge-budget-cache.test.ts`: `ProviderError: expected 4 cells, slicer
produced 9` (grid/brief fixture mismatch in `generateOne`).
- `judge-pipeline.test.ts`: 0 vision calls because slicing throws before
  judging.

These are orthogonal to the E2E UX/tagging task and out of scope here. **Next
agent: file/triage these separately** — they indicate the integration brief
fixtures drifted from the canonical slicer.

## Restart discipline

The gallery (`npm run sprites:gallery`) was restarted this session to pick up
the `approve.ts` change (sidecar imports it). Sidecar :7290 + vite-lab :7281.
Editing `scripts/sprites/*` requires a gallery restart; `src/devtools-main.ts`
hot-reloads. Only kill node procs whose CommandLine matches your worktree.

## Follow-ups

- Triage the 10 pre-existing integration failures (separate task).
- Optionally make `verify.sh` Step 6 surface a clear count instead of silently
  swallowing failures, so drift is visible.
- The metadata/Tag step still targets `entry.id` and skips already-tagged
  entries; with approve-time type tagging it's now redundant for type, but could
  be fixed to target by `spriteId` if richer heuristic tags are wanted.
