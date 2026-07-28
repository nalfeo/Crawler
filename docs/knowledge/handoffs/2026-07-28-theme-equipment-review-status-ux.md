# Handoff: Theme-equipment review — generate/regenerate labels, thumb gating, run-status strip, non-disruptive review

**Date:** 2026-07-28
**Session slug:** theme-equipment-review-status-ux
**Apples:** 3🍎 (tooling-only cap, AGENTS.md)

## Systems touched

sprite-workflow

## Summary

Second batch of ergonomics fixes to the theme-equipment review canvas
(`.github/extensions/theme-equipment-review/`) and the durable review state
machine (`scripts/sprites/theme-equipment-set.ts`), continuing the batch merged
as PR #2138. The maintainer, driving the live set through the canvas, hit four
UX problems: (7) the Run button said "Regenerate N" even when nothing had been
generated yet; (8) review thumbs were offered on items with no pipeline output
to review; (9) after clicking Run there was no in-canvas signal of whether the
GitHub workflow was moving; (10) accepting/rejecting one item triggered a full
re-render that scroll-jumped the page and wiped an in-progress comment in
another item's textarea. All four are fixed and verified live against fresh
durable reads.

## The changes

7. **Truthful "generate" vs "regenerate" Run labels.** `planRunPhase`
   (`theme-equipment-set.ts`) now splits the unresolved set into `generateCount`
   (items with **zero** phase output — `themeSetItemHasPhaseOutput` false) and
   `regenerateCount` (unresolved but with some prior output), with the invariant
   `generateCount + regenerateCount === unresolved`. The renderer's
   `runPhaseLabel(plan, phase)` reads the server-computed plan and never
   re-implements the predicate — e.g. "Generate 16 briefs" on a fresh set,
   "Regenerate 16 unresolved briefs" once output exists. Same trustworthy-label
   invariant as the prior batch's bulk-approve label.

8. **Gate review thumbs until output exists.** A second, disjoint projection
   `themeSetItemAwaitsGeneration(item, phase)` is true when the phase's
   **required** artifact kind is missing (`PHASE_REQUIRED_ARTIFACT_KIND`:
   briefs→`selected-brief`, sprite-sheets→`raw-sheet`,
   variant-approval→approved-variant kind; roster has no required artifact so it
   never awaits). It is aligned with `validatePhaseArtifactsForUpVote` so the
   gate matches up-vote eligibility exactly. The renderer replaces thumbs +
   feedback on an awaiting item with a "⏳ Awaiting generation" note. Kept
   deliberately separate from Change 7's `themeSetItemHasPhaseOutput` (ANY
   artifact) — the two are never conflated.

9. **Semi-real-time run-status strip.** The workflow got a top-level
   `run-name: Theme Equipment ${{ inputs.action }} · ${{ inputs.set_id }}` for
   correlation. `bridge.mjs` shells `gh run list --workflow=theme-equipment.yml
--branch <ref> --limit 20 --json ...` and selects the newest run whose title
   matches the current set. `server.mjs` exposes GET `/api/run-status` (using the
   **server-side** setId, ignoring any `?setId=`). The renderer polls every 10s
   with a single in-flight guard and patches only `#run-status-strip` by id.
   Three response shapes: available+run, available+no-run, unavailable+errorKind.

10. **Non-disruptive re-render.** `draftFeedback` (a Map) holds each textarea's
    unsent text; `captureInteraction()` restores scroll offset + caret around
    `render()`; `input` listeners on `[data-feedback]` keep the map current. A
    review click clears **only** the submitted item's draft, and only after the
    `mutate` succeeds. Result: accepting one item preserves every other item's
    in-progress comment with zero scroll jump.

## Code-review fixes (gpt-5.5, 2 Medium — both resolved with regression tests)

- **Finding 1 — draft key collision / cross-set leak.** `draftFeedback` was
  keyed by the raw item id plus a bare `'collection'` sentinel, so (a) a
  collection draft survived a set-switch and (b) an item whose id was literally
  `collection` collided with the set-level textarea. Fix: `feedbackKey(scope,id)`
  namespaces items as `item:<id>` and keeps bare `collection` for the set box;
  `draftFeedback`/`draftBriefs` are cleared in `openSet` (set-switch) and
  `loadIndex` (leaving to index) but **not** in `load()` — the refresh path must
  preserve drafts, which is Change 10's whole point.
- **Finding 2 — run-status correlation spoofable.** `displayTitle.endsWith(' · '
  - setId)`could be satisfied by a crafted`set_id`(e.g.`"other ·
    classic-fantasy"`). Fix: anchored regex `^Theme Equipment [^·]+ ·
    <escaped-setId>$` — the action segment `[^·]+` can't contain the separator, so
  an injected extra `·` fails; `$`retains prefix-collision safety;`setId` is
    regex-escaped.

## Files touched

- `scripts/sprites/theme-equipment-set.ts` — `themeSetItemHasPhaseOutput`,
  `themeSetItemAwaitsGeneration`, `PHASE_REQUIRED_ARTIFACT_KIND`, generate/
  regenerate split in `planRunPhase`.
- `scripts/sprites/theme-equipment-review-cli.ts` — `buildReviewStatus` /
  `presentState` expose `reviewStatus` + `runPhase`.
- `.github/extensions/theme-equipment-review/renderer.mjs` — Changes 7–10 UI +
  Finding-1 namespacing/clearing.
- `.github/extensions/theme-equipment-review/lib/bridge.mjs` —
  `selectThemeEquipmentRun` (Finding-2 anchored match) + `themeEquipmentRunStatus`.
- `.github/extensions/theme-equipment-review/lib/server.mjs` — GET `/api/run-status`.
- `.github/extensions/theme-equipment-review/extension.mjs` — wires `runStatus`.
- `.github/workflows/theme-equipment.yml` — top-level `run-name`.
- Tests: `tests/unit/sprites/theme-equipment-set.test.ts`,
  `.github/extensions/theme-equipment-review/tests/{bridge,server,renderer}.test.mjs`.
- `docs/knowledge/review-ledgers/2026-07-28-theme-equipment-review-status-ux.review-ledger.json`.

## Verification (rule #9)

- `npm run verify:fast` green (156 unit tests). Extension suite: 58/58
  (`node --test .github/extensions/theme-equipment-review/tests/*.test.mjs`).
  Sprites unit: `npx vitest run --project sprites theme-equipment`.
  `node --check renderer.mjs` green after every edit.
- **Live, DOM-asserted against fresh azure-blob reads** (two seeded scratch sets,
  `scratch-ux-fresh` with no output + `scratch-ux-review` with `selected-brief`
  output):
  - Change 7: fresh → "Generate 16 briefs"; review → "Regenerate 16 unresolved
    briefs". ✅
  - Change 8: fresh → 16 "⏳ Awaiting generation" notes, no thumbs; review → 0
    awaiting, thumbs + feedback shown. ✅
  - Change 9: strip renders the no-recent-run state; poll confirmed via repeated
    `/api/run-status` GETs. ✅
  - Change 10: programmatic-click accept on two items → neighbour draft text
    preserved, **scrollDelta = 0**, label truthfully dropped 16→15→14. ✅
  - Screenshots in session `files/visual-review/`.

## Environment hazards (record — the next agent will hit these)

- **Shared cacache stale-read.** A canvas or CLI bound to durable coordination
  state (`theme-sets/<id>/state.json`) must **not** be driven from a branch
  lacking the cache-policy fix (commits `6fdba7d73` / `94000a869`, now in
  `main`). Symptom: a plausible but frozen snapshot that survives
  `extensions_reload` and rebases. Diagnosis: enumerate the shared cacache index
  at `~/.copilot/crawler/azure-resource-cache` for `state.json` / `list:` keys
  and delete the offending entries. The cache dir is shared across every
  worktree, so this is not fixed by anything local to your branch. This branch is
  off `main` and therefore safe.
- **Branch-deletion-on-squash-merge 422.** GitHub auto-deletes the head branch on
  squash-merge; a later `gh workflow run --ref <that-branch>` then returns
  `HTTP 422: No ref found`. Cut new work from `main`, not the merged branch.
- **Renderer backtick trap.** The entire `renderer.mjs` client script is ONE
  template literal — a backtick anywhere (even a comment) is a syntax error.
  `node --check` after every edit; all new code is string-concat style.
- `tests/unit/sprites/**` is excluded from the `unit` vitest project — use
  `--project sprites`. `saveThemeEquipmentSetState` does NOT bump `stateRevision`
  (mutation helpers do). Canvas port changes on every `extensions_reload`.

## Standing constraints (still in force)

- NEVER dispatch `run-phase` or click "Approve remaining" on
  `classic-fantasy-basic-leather` — the maintainer's pending up-votes are theirs.
- NEVER touch branch `nalfeo-theme-set-index`.

## Unresolved / next steps

- Scratch sets `scratch-ux-fresh` / `scratch-ux-review` remain in azure-blob
  (harmless; can be deleted).
- No outstanding code-review concerns; ledger valid (`plan_review` + `code_review`).
